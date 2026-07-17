from fastapi import APIRouter, Depends, HTTPException, status
from typing import List
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.core.security import get_current_user, get_current_admin_user, check_is_project_manager_or_admin
from backend.app.models import Project, User, Document, ProjectMember
from backend.app import schemas
from backend.app.services.storage import storage_service
from backend.app.api.auth import log_activity

router = APIRouter(prefix="/api/projects", tags=["projects"])

def populate_user_role(db: Session, user: User, project: Project):
    # Set user_role attribute dynamically on the ORM model
    if user.is_admin:
        project.user_role = "Admin"
        return project
        
    member = db.query(ProjectMember).filter(
        ProjectMember.project_id == project.id,
        ProjectMember.user_id == user.id
    ).first()
    
    if member:
        project.user_role = member.role
    elif project.owner_id == user.id:
        project.user_role = "Manager"
    else:
        project.user_role = None
    return project

@router.post("", response_model=schemas.Project, status_code=status.HTTP_201_CREATED)
def create_project(
    project_in: schemas.ProjectCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Creates a new project and logs the event."""
    new_project = Project(
        name=project_in.name,
        description=project_in.description,
        owner_id=current_user.id
    )
    db.add(new_project)
    db.commit()
    db.refresh(new_project)

    # Automatically add creator as default team member
    creator_member = ProjectMember(
        project_id=new_project.id,
        user_id=current_user.id,
        role="Manager"
    )
    db.add(creator_member)
    db.commit()

    log_activity(
        db, 
        current_user.id, 
        "create_project", 
        f"Created project: '{new_project.name}' (ID: {new_project.id})"
    )
    populate_user_role(db, current_user, new_project)
    return new_project

@router.get("", response_model=List[schemas.Project])
def list_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Lists projects visible to the current user.
    - Admins see all projects.
    - Normal users see only projects they own or are a member of.
    """
    if current_user.is_admin:
        projects = db.query(Project).order_by(Project.created_at.desc()).all()
    else:
        # Get project IDs where the user is a member
        member_project_ids = db.query(ProjectMember.project_id).filter(
            ProjectMember.user_id == current_user.id
        ).subquery()

        projects = db.query(Project).filter(
            (Project.owner_id == current_user.id) | (Project.id.in_(member_project_ids))
        ).order_by(Project.created_at.desc()).all()

    for p in projects:
        populate_user_role(db, current_user, p)
    return projects

@router.get("/{project_id}", response_model=schemas.Project)
def get_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Retrieves a single project's details."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    populate_user_role(db, current_user, project)
    return project

@router.put("/{project_id}", response_model=schemas.Project)
def update_project(
    project_id: int,
    project_in: schemas.ProjectUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Updates a project's details and logs the modification."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    check_is_project_manager_or_admin(db, current_user, project_id)

    old_name = project.name
    if project_in.name is not None:
        project.name = project_in.name
    if project_in.description is not None:
        project.description = project_in.description

    db.commit()
    db.refresh(project)

    log_activity(
        db,
        current_user.id,
        "update_project",
        f"Updated project ID {project.id} from name '{old_name}' to '{project.name}'"
    )
    populate_user_role(db, current_user, project)
    return project

@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Deletes a project, triggers physical file deletion for all associated documents,
    and cascade deletes database tables (milestones, docs, chunks).
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    check_is_project_manager_or_admin(db, current_user, project_id)

    # Step 1: Clean up physical file uploads from disk before cascading database deletion
    docs = db.query(Document).filter(Document.project_id == project_id).all()
    for doc in docs:
        storage_service.delete_file(doc.file_path)

    # Step 2: Purge the entire project storage folder (proj_X/) to leave zero orphan folders
    storage_service.delete_project_folder(project_id)

    # Step 3: Delete project from DB (cascading deletes milestones, documents, and chunks)
    project_name = project.name
    db.delete(project)
    db.commit()

    log_activity(
        db,
        current_user.id,
        "delete_project",
        f"Deleted project: '{project_name}' and clean-deleted all its uploaded files (ID: {project_id})"
    )
    return None


@router.post("/admin/purge-orphans", status_code=status.HTTP_200_OK)
def trigger_purge_orphans(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user)
):
    """
    On-demand admin endpoint to scan and purge any orphaned documents, stories, tasks,
    and Supabase storage folders (proj_X/) where project X no longer exists.
    """
    from backend.app.main import _purge_orphans
    _purge_orphans()
    return {"message": "Orphaned documents, stories, and storage folders have been scanned and purged."}
