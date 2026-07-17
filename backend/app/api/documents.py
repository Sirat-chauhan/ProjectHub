from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status, Request
from fastapi.responses import FileResponse, StreamingResponse
from typing import List, Optional
from sqlalchemy.orm import Session
import os
import io

from backend.app.core.database import get_db
from backend.app.core.security import get_current_user, get_current_admin_user, check_is_project_manager_or_admin
from backend.app.models import Document, Project, Milestone, User, UserStory, ProjectMember
from backend.app import schemas
from backend.app.services.storage import storage_service
from backend.app.services.rag import rag_service
from backend.app.api.auth import log_activity

router = APIRouter(prefix="/api/documents", tags=["documents"])

@router.post("", response_model=schemas.Document, status_code=status.HTTP_201_CREATED)
async def upload_document(
    request: Request,
    project_id: int = Form(...),
    milestone_id: Optional[int] = Form(None),
    category: str = Form("team"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Ingestion Pipeline:
    1. Validates Project and Milestone constraints.
    2. Saves file to local disk (Immutable file storage naming).
    3. Saves Document metadata to the database.
    4. Executes text extraction, sentence-aware chunking, local vector embedding,
       and stores them in pgvector chunks table.
    5. Logs activity and returns metadata.
    """
    check_is_project_manager_or_admin(db, current_user, project_id)
    # Verify project exists
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Verify milestone exists if provided
    if milestone_id:
        milestone = db.query(Milestone).filter(Milestone.id == milestone_id, Milestone.project_id == project_id).first()
        if not milestone:
            raise HTTPException(status_code=404, detail="Milestone not found or does not belong to this project")

    # Prevent duplicate document names within the same project
    existing_doc = db.query(Document).filter(
        Document.name == file.filename,
        Document.project_id == project_id
    ).first()

    # Pre-calculate the new file path to compare
    file_bytes = file.file.read()
    file.file.seek(0)
    new_file_path = storage_service.get_file_path(file.filename, file_bytes, project_id)

    if existing_doc:
        if existing_doc.file_path == new_file_path:
            # Document content is identical! Save cost and time:
            # Just update milestone_id if it changed, and return the existing document.
            existing_doc.milestone_id = milestone_id
            db.commit()
            db.refresh(existing_doc)
            return existing_doc
        else:
            # Content has changed: delete old physical file and its database record (cascading vector chunks)
            try:
                storage_service.delete_file(existing_doc.file_path)
            except Exception as e:
                print(f"Warning: Failed to delete duplicate file '{existing_doc.file_path}': {str(e)}")
            db.delete(existing_doc)
            db.commit()

    # Validate file type extension BEFORE saving to disk
    _, ext = os.path.splitext(file.filename)
    file_type = ext.replace(".", "").lower() or "txt"

    allowed_exts = ["pdf", "docx", "doc", "xlsx", "xls", "csv", "html", "htm", "txt"]
    if file_type not in allowed_exts:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file format. Only PDF, DOCX, XLSX, CSV, HTML, and TXT files are allowed. Image files (JPEG, PNG, etc.) are not supported."
        )

    # Step 1: Save physical file to disk (Generates unique hash-based prefix)
    try:
        file_path = storage_service.save_file(file, project_id=project_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file on disk: {str(e)}")

    # Get file size
    file.file.seek(0, os.SEEK_END)
    file_size = file.file.tell()
    file.file.seek(0) # Reset pointer

    if await request.is_disconnected():
        storage_service.delete_file(file_path)
        raise HTTPException(status_code=499, detail="Upload cancelled by client")

    # Step 2: Create document record using flush() (NOT commit) so we get the ID
    #         but keep the transaction open. If anything fails later, rollback
    #         automatically removes the record — zero orphan documents.
    new_doc = Document(
        name=file.filename,
        file_path=file_path,
        file_type=file_type,
        file_size=file_size,
        category=category,
        project_id=project_id,
        milestone_id=milestone_id,
        uploaded_by=current_user.id
    )
    db.add(new_doc)
    db.flush()      # Assigns new_doc.id without committing the transaction
    db.refresh(new_doc)

    # Step 3 & 4: Chunk text and embed using pgvector
    try:
        ingestion_success = rag_service.ingest_document(db, new_doc.id)
        if not ingestion_success or await request.is_disconnected():
            db.rollback()
            storage_service.delete_file(file_path)
            raise HTTPException(status_code=400, detail="Document upload cancelled or could not be parsed.")
    except HTTPException:
        raise
    except Exception as e:
        # Rollback the entire transaction (document + any partial chunks)
        db.rollback()
        storage_service.delete_file(file_path)
        raise HTTPException(status_code=500, detail=f"RAG ingestion failure: {str(e)}")

    if await request.is_disconnected():
        db.rollback()
        storage_service.delete_file(file_path)
        raise HTTPException(status_code=499, detail="Upload cancelled by client")

    # Step 5: Everything succeeded — commit the document AND its chunks in one transaction
    db.commit()

    # Step 5b: Post-commit cancel catch — for small/fast files the server commits
    #          before the browser's abort signal arrives. Detect that here and reverse.
    if await request.is_disconnected():
        committed_doc = db.query(Document).filter(Document.id == new_doc.id).first()
        if committed_doc:
            storage_service.delete_file(committed_doc.file_path)
            db.delete(committed_doc)  # CASCADE removes chunks + linked stories
            db.commit()
        print(f"[ProjectHub] Reversed committed upload for '{new_doc.name}' — client cancelled after server finished.")
        raise HTTPException(status_code=499, detail="Upload cancelled by client after processing; cleaned up.")

    # Step 6: Log Activity
    log_activity(
        db,
        current_user.id,
        "upload_document",
        f"Uploaded and indexed document: '{new_doc.name}' (Size: {new_doc.file_size} bytes) under project '{project.name}'"
    )

    return new_doc

@router.get("/project/{project_id}", response_model=List[schemas.Document])
def list_project_documents(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Lists all documents associated with a project. Requires project membership."""
    # Verify user has access to this project
    if not current_user.is_admin:
        project = db.query(Project).filter(Project.id == project_id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        is_owner = project.owner_id == current_user.id
        is_member = db.query(ProjectMember).filter(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == current_user.id
        ).first() is not None
        if not is_owner and not is_member:
            raise HTTPException(status_code=403, detail="You do not have access to this project's documents.")
    return db.query(Document).filter(Document.project_id == project_id).order_by(Document.created_at.desc()).all()

@router.get("/milestone/{milestone_id}", response_model=List[schemas.Document])
def list_milestone_documents(
    milestone_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Lists all documents associated with a milestone."""
    return db.query(Document).filter(Document.milestone_id == milestone_id).order_by(Document.created_at.desc()).all()

@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Deletion Cleanup Logic:
    1. Deletes physical file from local disk.
    2. Deletes DB document entry (triggers database CASCADE delete on pgvector chunks).
    3. Logs deletion activity.
    """
    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    check_is_project_manager_or_admin(db, current_user, doc.project_id)

    # Step 1: Clean physical disk file
    storage_service.delete_file(doc.file_path)

    # Step 2: Delete any user stories (and their subtasks) generated from this document
    linked_stories = db.query(UserStory).filter(UserStory.document_id == document_id).all()
    for s in linked_stories:
        db.delete(s)

    # Step 3: Delete DB record (cascade cleans vector chunks)
    doc_name = doc.name
    db.delete(doc)
    db.commit()

    # Step 3: Log Activity
    log_activity(
        db,
        current_user.id,
        "delete_document",
        f"Deleted document: '{doc_name}' from project ID {doc.project_id}"
    )

    return None


@router.get("/download/{document_id}")
def download_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Downloads and streams a document securely:
    - In Local Storage mode: serves the file directly from local disk.
    - In Supabase Storage mode: downloads the file stream from the PRIVATE
      Supabase bucket and streams it back to the authorized client.
    """
    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Verify user has access to the document's project
    if not current_user.is_admin:
        project = db.query(Project).filter(Project.id == doc.project_id).first()
        is_owner = project and project.owner_id == current_user.id
        is_member = db.query(ProjectMember).filter(
            ProjectMember.project_id == doc.project_id,
            ProjectMember.user_id == current_user.id
        ).first() is not None
        if not is_owner and not is_member:
            raise HTTPException(status_code=403, detail="You do not have access to download this document.")

    if storage_service.use_supabase:
        try:
            # Download file bytes securely using private server credentials
            file_bytes = storage_service.supabase.storage.from_(storage_service.bucket_name).download(doc.file_path)
            
            # Determine content-type
            media_type = "application/octet-stream"
            if doc.file_type == "pdf":
                media_type = "application/pdf"
            elif doc.file_type == "html":
                media_type = "text/html"
            elif doc.file_type == "txt":
                media_type = "text/plain"

            return StreamingResponse(
                io.BytesIO(file_bytes),
                media_type=media_type,
                headers={"Content-Disposition": f"attachment; filename={doc.name}"}
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to fetch file from private cloud storage: {str(e)}")
    else:
        if not os.path.exists(doc.file_path):
            raise HTTPException(status_code=404, detail="Physical file not found on disk")
        
        media_type = "application/octet-stream"
        if doc.file_type == "pdf":
            media_type = "application/pdf"
        elif doc.file_type == "html":
            media_type = "text/html"
        elif doc.file_type == "txt":
            media_type = "text/plain"

        return FileResponse(
            path=doc.file_path,
            filename=doc.name,
            media_type=media_type
        )
