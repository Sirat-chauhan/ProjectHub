import json
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import case
from typing import List

from backend.app.core.database import get_db
from backend.app.core.security import get_current_user, get_current_admin_user, check_is_project_manager_or_admin
from backend.app.core.config import settings
from backend.app.models import User, Project, Document, DocumentChunk, UserStory, Task, ProjectMember, Notification
from backend.app import schemas
from backend.app.core.prompts import get_global_stories_prompt, get_single_document_stories_prompt

try:
    from langsmith.wrappers import wrap_openai
    from langsmith import traceable
    _openai_client = wrap_openai(OpenAI(api_key=settings.OPENAI_API_KEY))
except ImportError:
    _openai_client = OpenAI(api_key=settings.OPENAI_API_KEY)
    def traceable(*args, **kwargs):
        def decorator(func):
            return func
        return decorator

router = APIRouter(prefix="/api/projects/{project_id}/stories", tags=["stories"])


def _auto_assign_tasks(db: Session, project_id: int, stories: list):
    """
    Automatically assigns tasks to project team members based on task_type matching member role.
    Frontend tasks → Frontend member, Backend tasks → Backend member, AI tasks → AI member, Manager tasks → Manager member.
    """
    # Build a role→user_id map from project members
    members = db.query(ProjectMember).filter(ProjectMember.project_id == project_id).all()
    role_map = {}  # e.g. {"Frontend": 5, "Backend": 3, "AI": 7}
    for m in members:
        # If multiple members share a role, the last one wins (simple strategy)
        role_map[m.role] = m.user_id

    if not role_map:
        return  # No team members configured, skip assignment

    # Fetch project name ONCE to avoid N+1 queries inside the loop
    project = db.query(Project).filter(Project.id == project_id).first()
    proj_name = project.name if project else "Project"

    for story in stories:
        for task in story.tasks:
            if task.task_type in role_map:
                task.assigned_to = role_map[task.task_type]
                
                notification = Notification(
                    user_id=task.assigned_to,
                    title="Task Assigned",
                    message=f"Task '{task.title}' has been auto-assigned to you in project '{proj_name}'."
                )
                db.add(notification)

    db.commit()


def _clean_stories_inputs(inputs: dict) -> dict:
    cleaned = dict(inputs)
    cleaned.pop("db", None)
    cleaned.pop("current_user", None)
    return cleaned

@router.post("/generate")
@traceable(name="Project User Stories Generation", run_type="chain", process_inputs=_clean_stories_inputs)
def generate_stories_from_documents(
    project_id: int,
    request: schemas.GenerateStoriesRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Generates Jira-style user stories and tasks from project documents using OpenAI JSON mode.
    """
    check_is_project_manager_or_admin(db, current_user, project_id)
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
        
    # Get document chunks for context
    query = db.query(DocumentChunk).join(Document, DocumentChunk.document_id == Document.id).filter(Document.project_id == project_id)
    
    if request.document_ids:
        query = query.filter(Document.id.in_(request.document_ids))
        
    chunks = query.order_by(DocumentChunk.document_id, DocumentChunk.chunk_index).limit(50).all()
    
    if not chunks:
        raise HTTPException(status_code=400, detail="No document content found to analyze.")
        
    existing_db_stories = db.query(UserStory).filter(UserStory.project_id == project_id).all()
    existing_titles = [s.title.strip() for s in existing_db_stories if s.title]
    existing_titles_prompt = "\n".join([f"- {t}" for t in existing_titles[:30]]) if existing_titles else "None"
    seen_titles_lower = {t.lower() for t in existing_titles}

    context_text = "\n\n".join([chunk.content for chunk in chunks])
    prompt = get_global_stories_prompt(context_text, existing_titles_prompt)
    
    try:
        client = _openai_client
        response = client.chat.completions.create(
            model=settings.OPENAI_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=2500,
            response_format={"type": "json_object"}
        )
        
        result_json = json.loads(response.choices[0].message.content)
        stories_data = result_json.get("stories", [])
        
        # Save to DB
        created_stories = []
        for s_data in stories_data:
            title_str = s_data.get("title", "Untitled Story").strip()
            title_lower = title_str.lower()
            if title_lower in seen_titles_lower or any(title_lower in st or st in title_lower for st in seen_titles_lower if len(st) > 15):
                continue
            seen_titles_lower.add(title_lower)

            sp = s_data.get("story_points", 1)
            try:
                sp = int(sp)
            except (ValueError, TypeError):
                sp = 1

            new_story = UserStory(
                project_id=project_id,
                title=s_data.get("title", "Untitled Story"),
                description=s_data.get("description", ""),
                acceptance_criteria=s_data.get("acceptance_criteria", []),
                priority=s_data.get("priority", "Medium"),
                story_points=sp,
                status="To Do"
            )
            db.add(new_story)
            db.flush()
            
            subtasks = s_data.get("subtasks", [])
            for t_data in subtasks:
                task_type = t_data.get("type", "Backend")
                if task_type not in ["Frontend", "Backend", "AI", "Manager"]:
                    task_type = "Manager"
                    
                new_task = Task(
                    story_id=new_story.id,
                    title=t_data.get("title", "Untitled Task"),
                    task_type=task_type,
                    status="To Do"
                )
                db.add(new_task)
            
            created_stories.append(new_story)
            
        db.commit()

        # Auto-assign tasks to team members based on role
        # Refresh stories to get full relationships
        for s in created_stories:
            db.refresh(s)
        _auto_assign_tasks(db, project_id, created_stories)

        return {"message": "Successfully generated stories", "count": len(created_stories)}
        
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to generate stories: {str(e)}")


@router.post("/generate-from-document")
@traceable(name="Document User Stories Generation", run_type="chain", process_inputs=_clean_stories_inputs)
def generate_stories_from_single_document(
    project_id: int,
    request: schemas.GenerateStoriesFromDocumentRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Generates user stories and tasks from a SINGLE document's chunks using OpenAI.
    The admin/manager clicks a button next to a document to trigger this.
    """
    check_is_project_manager_or_admin(db, current_user, project_id)
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Verify document belongs to this project
    doc = db.query(Document).filter(Document.id == request.document_id, Document.project_id == project_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found in this project")

    # Get chunks for this specific document only
    chunks = db.query(DocumentChunk).filter(
        DocumentChunk.document_id == request.document_id
    ).order_by(DocumentChunk.chunk_index).limit(50).all()

    if not chunks:
        raise HTTPException(status_code=400, detail="No indexed content found for this document. It may still be processing.")

    existing_db_stories = db.query(UserStory).filter(UserStory.project_id == project_id).all()
    existing_titles = [s.title.strip() for s in existing_db_stories if s.title]
    existing_titles_prompt = "\n".join([f"- {t}" for t in existing_titles[:30]]) if existing_titles else "None"
    seen_titles_lower = {t.lower() for t in existing_titles}

    context_text = "\n\n".join([chunk.content for chunk in chunks])

    prompt = get_single_document_stories_prompt(doc.name, context_text, existing_titles_prompt)

    try:
        client = _openai_client
        response = client.chat.completions.create(
            model=settings.OPENAI_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=2500,
            response_format={"type": "json_object"}
        )

        result_json = json.loads(response.choices[0].message.content)
        stories_data = result_json.get("stories", [])

        created_stories = []
        for s_data in stories_data:
            title_str = s_data.get("title", "Untitled Story").strip()
            title_lower = title_str.lower()
            if title_lower in seen_titles_lower or any(title_lower in st or st in title_lower for st in seen_titles_lower if len(st) > 15):
                continue
            seen_titles_lower.add(title_lower)

            sp = s_data.get("story_points", 1)
            try:
                sp = int(sp)
            except (ValueError, TypeError):
                sp = 1

            new_story = UserStory(
                project_id=project_id,
                document_id=request.document_id,
                title=s_data.get("title", "Untitled Story"),
                description=s_data.get("description", ""),
                acceptance_criteria=s_data.get("acceptance_criteria", []),
                priority=s_data.get("priority", "Medium"),
                story_points=sp,
                status="To Do"
            )
            db.add(new_story)
            db.flush()

            subtasks = s_data.get("subtasks", [])
            for t_data in subtasks:
                task_type = t_data.get("type", "Backend")
                if task_type not in ["Frontend", "Backend", "AI", "Manager"]:
                    task_type = "Manager"

                new_task = Task(
                    story_id=new_story.id,
                    title=t_data.get("title", "Untitled Task"),
                    task_type=task_type,
                    status="To Do"
                )
                db.add(new_task)

            created_stories.append(new_story)

        db.commit()

        # Auto-assign tasks to team members based on role
        for s in created_stories:
            db.refresh(s)
        _auto_assign_tasks(db, project_id, created_stories)

        return {
            "message": f"Generated {len(created_stories)} stories from '{doc.name}'",
            "count": len(created_stories),
            "document_name": doc.name
        }

    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to generate stories: {str(e)}")


@router.post("", response_model=schemas.UserStory)
def create_story(
    project_id: int,
    request: schemas.UserStoryBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Manually creates a new user story.
    """
    check_is_project_manager_or_admin(db, current_user, project_id)
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    new_story = UserStory(
        project_id=project_id,
        title=request.title,
        description=request.description,
        acceptance_criteria=request.acceptance_criteria,
        priority=request.priority,
        story_points=request.story_points,
        status=request.status,
        comments=request.comments
    )
    db.add(new_story)
    db.commit()
    db.refresh(new_story)
    return new_story


@router.post("/{story_id}/tasks", response_model=schemas.Task)
def create_task(
    project_id: int,
    story_id: int,
    request: schemas.TaskBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Manually creates a new task under a user story.
    """
    check_is_project_manager_or_admin(db, current_user, project_id)
    story = db.query(UserStory).filter(UserStory.id == story_id, UserStory.project_id == project_id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

    new_task = Task(
        story_id=story_id,
        title=request.title,
        task_type=request.task_type,
        status=request.status,
        assigned_to=request.assigned_to
    )
    db.add(new_task)
    
    if new_task.assigned_to:
        project = db.query(Project).filter(Project.id == project_id).first()
        proj_name = project.name if project else "Project"
        notification = Notification(
            user_id=new_task.assigned_to,
            title="Task Assigned",
            message=f"Task '{new_task.title}' has been assigned to you in project '{proj_name}'."
        )
        db.add(notification)
        
    db.commit()
    db.refresh(new_task)

    # Enrich assignee name
    if new_task.assigned_to:
        assignee = db.query(User).filter(User.id == new_task.assigned_to).first()
        new_task.assignee_name = assignee.full_name if assignee else None
    else:
        new_task.assignee_name = None

    return new_task


@router.get("", response_model=List[schemas.UserStory])
def get_project_stories(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Retrieves all user stories and their tasks for a project.
    Includes assignee name for display.
    """
    priority_order = case(
        (UserStory.priority == 'Critical', 1),
        (UserStory.priority == 'High', 2),
        (UserStory.priority == 'Medium', 3),
        (UserStory.priority == 'Low', 4),
        else_=5
    )
    stories = db.query(UserStory).options(
        joinedload(UserStory.tasks)
    ).filter(
        UserStory.project_id == project_id
    ).order_by(
        priority_order, UserStory.id.desc()
    ).all()

    # Fetch all users once to map assignee IDs to names
    users_map = {u.id: u.full_name for u in db.query(User.id, User.full_name).all()}

    # Enrich tasks with assignee_name
    for story in stories:
        for task in story.tasks:
            if task.assigned_to:
                task.assignee_name = users_map.get(task.assigned_to)
            else:
                task.assignee_name = None

    return stories

@router.put("/{story_id}", response_model=schemas.UserStory)
def update_story(
    project_id: int,
    story_id: int,
    request: schemas.UserStoryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Updates a user story's details.
    """
    story = db.query(UserStory).filter(UserStory.id == story_id, UserStory.project_id == project_id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
        
    # Check project membership or ownership
    project = db.query(Project).filter(Project.id == project_id).first()
    is_owner = project and project.owner_id == current_user.id
    is_member = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == current_user.id).first() is not None
    is_manager = is_owner or db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == current_user.id,
        ProjectMember.role == "Manager"
    ).first() is not None

    if not current_user.is_admin and not is_manager:
        if not is_member:
            raise HTTPException(status_code=403, detail="Only team members of this project can update story status.")
        if ("title" in request.model_fields_set or 
            "acceptance_criteria" in request.model_fields_set or 
            "description" in request.model_fields_set or 
            "priority" in request.model_fields_set or 
            "story_points" in request.model_fields_set):
            raise HTTPException(status_code=403, detail="Only administrators or project managers can edit user story details.")

    if "title" in request.model_fields_set:
        story.title = request.title
    if "status" in request.model_fields_set:
        story.status = request.status
    if "is_on_hold" in request.model_fields_set:
        story.is_on_hold = request.is_on_hold
    if "acceptance_criteria" in request.model_fields_set:
        story.acceptance_criteria = request.acceptance_criteria
    if "description" in request.model_fields_set:
        story.description = request.description
    if "priority" in request.model_fields_set:
        story.priority = request.priority
    if "story_points" in request.model_fields_set:
        story.story_points = request.story_points
    if "comments" in request.model_fields_set:
        story.comments = request.comments
    if "due_date" in request.model_fields_set:
        story.due_date = request.due_date
        
    db.commit()
    db.refresh(story)
    return story

@router.put("/{story_id}/tasks/{task_id}", response_model=schemas.Task)
def update_task(
    project_id: int,
    story_id: int,
    task_id: int,
    request: schemas.TaskUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Updates a specific task within a story.
    """
    # Verify story belongs to project
    story = db.query(UserStory).filter(UserStory.id == story_id, UserStory.project_id == project_id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
        
    task = db.query(Task).filter(Task.id == task_id, Task.story_id == story_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
        
    old_assignee = task.assigned_to
        
    project = db.query(Project).filter(Project.id == project_id).first()
    is_owner = project and project.owner_id == current_user.id
    is_member = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == current_user.id).first() is not None
    is_manager = is_owner or db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == current_user.id,
        ProjectMember.role == "Manager"
    ).first() is not None

    if not current_user.is_admin and not is_manager:
        if not is_member:
            raise HTTPException(status_code=403, detail="Only team members of this project can update task statuses.")
        if "title" in request.model_fields_set or "task_type" in request.model_fields_set or "assigned_to" in request.model_fields_set or "due_date" in request.model_fields_set:
            raise HTTPException(status_code=403, detail="Only administrators or project managers can edit task details (title, type, assignee, or due date).")

    if "title" in request.model_fields_set:
        task.title = request.title
    if "status" in request.model_fields_set:
        task.status = request.status
    if "task_type" in request.model_fields_set:
        task.task_type = request.task_type
    if "assigned_to" in request.model_fields_set:
        task.assigned_to = request.assigned_to
        if task.assigned_to != old_assignee and task.assigned_to:
            project = db.query(Project).filter(Project.id == project_id).first()
            proj_name = project.name if project else "Project"
            notification = Notification(
                user_id=task.assigned_to,
                title="Task Assigned",
                message=f"Task '{task.title}' has been assigned to you in project '{proj_name}'."
            )
            db.add(notification)
    if "due_date" in request.model_fields_set:
        task.due_date = request.due_date
        
    db.commit()
    db.refresh(task)

    # Add assignee_name for response
    if task.assigned_to:
        assignee = db.query(User).filter(User.id == task.assigned_to).first()
        task.assignee_name = assignee.full_name if assignee else None
    else:
        task.assignee_name = None

    return task

@router.delete("/{story_id}")
def delete_story(
    project_id: int,
    story_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Deletes a user story.
    """
    story = db.query(UserStory).filter(UserStory.id == story_id, UserStory.project_id == project_id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

    check_is_project_manager_or_admin(db, current_user, project_id)
        
    db.delete(story)
    db.commit()
    return {"message": "Story deleted successfully"}

@router.delete("/{story_id}/tasks/{task_id}")
def delete_task(
    project_id: int,
    story_id: int,
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Deletes a task.
    """
    story = db.query(UserStory).filter(UserStory.id == story_id, UserStory.project_id == project_id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

    check_is_project_manager_or_admin(db, current_user, project_id)
        
    task = db.query(Task).filter(Task.id == task_id, Task.story_id == story_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
        
    db.delete(task)
    db.commit()
    return {"message": "Task deleted successfully"}
