from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import os

from backend.app.core.database import init_db
from backend.app.api import auth, projects, milestones, documents, logs, chat, stories, team, notifications

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    # FastAPI Application Entrypoint - LangGraph State Machine Active
    FastAPI Lifespan handler:
    Runs when the server starts up. Ensures PostgreSQL connects,
    enables pgvector, and creates all tables.
    """
    try:
        print("[ProjectHub] Initializing PostgreSQL Database and pgvector extension...")
        init_db()
        print("[ProjectHub] Database initialization successful!")
    except Exception as e:
        print(f"[ProjectHub] Database initialization FAILED: {str(e)}")
        print("[ProjectHub] Make sure PostgreSQL is running and credentials in .env are correct.")
    
    # Create the local uploads storage folder if it doesn't exist
    from backend.app.core.config import settings
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)

    # Auto-purge orphaned documents and storage folders on every boot
    try:
        _purge_orphans()
    except Exception as e:
        print(f"[ProjectHub] Orphan purge skipped (non-fatal): {e}")
    
    yield


def _purge_orphans():
    """
    Startup cleanup: removes documents (and their cascaded vector chunks),
    user stories, and tasks that reference projects which no longer exist,
    and deletes stale storage folders.
    """
    from backend.app.core.database import SessionLocal
    from backend.app.models import Document, Project, UserStory, DocumentChunk
    from backend.app.services.storage import storage_service

    db = SessionLocal()
    try:
        # 1. Find all project IDs that still exist
        existing_project_ids = {pid for (pid,) in db.query(Project.id).all()}

        # 2. Find orphaned documents (project was deleted but documents remain)
        orphaned_docs = db.query(Document).filter(
            ~Document.project_id.in_(existing_project_ids) if existing_project_ids
            else Document.project_id.isnot(None)
        ).all()

        if orphaned_docs:
            orphan_project_ids = set()
            for doc in orphaned_docs:
                orphan_project_ids.add(doc.project_id)
                storage_service.delete_file(doc.file_path)
                db.delete(doc)  # CASCADE deletes associated document_chunks and user_stories
            db.commit()
            print(f"[ProjectHub] Auto-purged {len(orphaned_docs)} orphan document(s) from {len(orphan_project_ids)} deleted project(s).")

        # 3. Always clean up orphan storage folders (proj_X/) in Supabase or Local Storage
        purged_folders = storage_service.cleanup_orphan_folders(existing_project_ids)
        if purged_folders > 0:
            print(f"[ProjectHub] Auto-purged {purged_folders} orphan storage folder(s).")

        # 4. Additionally, purge any documents that have zero chunks (incomplete / failed uploads)
        from sqlalchemy import func
        incomplete_docs = db.query(Document).outerjoin(DocumentChunk).group_by(Document.id).having(func.count(DocumentChunk.id) == 0).all()
        if incomplete_docs:
            for doc in incomplete_docs:
                # Delete physical file if still present
                storage_service.delete_file(doc.file_path)
                db.delete(doc)
            db.commit()
            print(f"[ProjectHub] Auto-purged {len(incomplete_docs)} incomplete document(s) with no chunks.")


        # 5. Find orphaned stories (project was deleted but user stories remain)
        orphaned_stories = db.query(UserStory).filter(
            ~UserStory.project_id.in_(existing_project_ids) if existing_project_ids
            else UserStory.project_id.isnot(None)
        ).all()
        if orphaned_stories:
            for story in orphaned_stories:
                db.delete(story)  # CASCADE deletes associated tasks
            db.commit()
            print(f"[ProjectHub] Auto-purged {len(orphaned_stories)} orphan user story/stories from deleted project(s).")

    except Exception as e:
        db.rollback()
        print(f"[ProjectHub] Orphan purge error: {e}")
    finally:
        db.close()

app = FastAPI(
    title="Project Document & Milestone Hub",
    description="SaaS-style project intelligence platform with pgvector RAG chatbot and Activity Logging.",
    version="1.0.0",
    lifespan=lifespan
)

# Set up CORS middleware for local testing/cross-origin calls
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    """
    Prevent aggressive browser caching for frontend static files (HTML, JS, CSS)
    during local development so UI/JS updates reflect immediately upon page refresh.
    """
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith(".html") or path.endswith(".js") or path.endswith(".css"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Include API Routers
app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(milestones.router)
app.include_router(documents.router)
app.include_router(logs.router)
app.include_router(chat.router)
app.include_router(stories.router)
app.include_router(team.router)
app.include_router(team.my_tasks_router)
app.include_router(notifications.router)

from sqlalchemy import text
from fastapi import Depends
from sqlalchemy.orm import Session
from backend.app.core.database import get_db

@app.get("/api/health", tags=["system"])
def health_check(db: Session = Depends(get_db)):
    """Lightweight endpoint for uptime pings and status checks."""
    try:
        db.execute(text("SELECT 1"))
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        return {"status": "error", "detail": str(e)}

# Mount Frontend static files to serve the UI
frontend_dir = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "frontend"
)
os.makedirs(frontend_dir, exist_ok=True)

# Mount uploads folder so avatar images are served at /uploads/...
uploads_dir = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "uploads"
)
os.makedirs(uploads_dir, exist_ok=True)
os.makedirs(os.path.join(uploads_dir, "avatars"), exist_ok=True)
app.mount("/uploads", StaticFiles(directory=uploads_dir), name="uploads")

# Mount frontend directory to root "/"
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
