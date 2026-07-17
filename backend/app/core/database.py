from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker
from backend.app.core.config import settings

db_url = settings.DATABASE_URL
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

# Setup the SQLAlchemy Database Engine (Synchronous for simplicity and robustness)
engine = create_engine(
    db_url,
    pool_pre_ping=True
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    """
    FastAPI dependency to yield a database session and close it afterwards.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    """
    Initializes the database:
    1. Creates pgvector extension if not exists.
    2. Creates all tables declared in models.
    """
    # Create extension first since models may use the VECTOR column type
    with engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
        conn.commit()
    
    # Import models here to register them with Base metadata
    from backend.app import models
    Base.metadata.create_all(bind=engine)

    # Safe migration for is_on_hold column
    try:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE user_stories ADD COLUMN IF NOT EXISTS is_on_hold BOOLEAN DEFAULT FALSE;"))
            conn.commit()
    except Exception:
        pass

    # Safe migration for tasks due_date column
    try:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date TIMESTAMP;"))
            conn.commit()
    except Exception:
        pass

    # Create HNSW index for high speed pgvector similarity searches
    with engine.connect() as conn:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS document_chunks_hnsw_idx "
            "ON document_chunks USING hnsw (embedding vector_cosine_ops);"
        ))
        conn.commit()
