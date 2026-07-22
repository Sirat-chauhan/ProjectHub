import os
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    DATABASE_URL: str
    # OpenAI Configuration
    OPENAI_API_KEY: str
    OPENAI_MODEL: str = "gpt-4o-mini"
    
    # Supabase Cloud Storage (Optional)
    SUPABASE_URL: Optional[str] = None
    SUPABASE_KEY: Optional[str] = None
    NEON_AUTH_URL: Optional[str] = None
    
    # JWT Auth Configuration
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24 hours
    
    # Storage Directory (Local Fallback)
    UPLOAD_DIR: str = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 
        "uploads"
    )

    # LangSmith Observability & Tracing Configuration
    LANGSMITH_TRACING: str = "true"
    LANGSMITH_ENDPOINT: str = "https://api.smith.langchain.com"
    LANGSMITH_API_KEY: Optional[str] = None
    LANGSMITH_PROJECT: str = "Projecthub"

    model_config = SettingsConfigDict(
        env_file=".env", 
        env_file_encoding="utf-8", 
        extra="ignore"
    )

settings = Settings()

# Automatically sync LangSmith configuration into process environment variables
if settings.LANGSMITH_API_KEY:
    os.environ["LANGSMITH_TRACING"] = settings.LANGSMITH_TRACING
    os.environ["LANGSMITH_ENDPOINT"] = settings.LANGSMITH_ENDPOINT
    os.environ["LANGSMITH_API_KEY"] = settings.LANGSMITH_API_KEY
    os.environ["LANGSMITH_PROJECT"] = settings.LANGSMITH_PROJECT

    # Set LANGCHAIN_* aliases for backward compatibility with older LangSmith / LangChain SDKs
    os.environ["LANGCHAIN_TRACING_V2"] = settings.LANGSMITH_TRACING
    os.environ["LANGCHAIN_ENDPOINT"] = settings.LANGSMITH_ENDPOINT
    os.environ["LANGCHAIN_API_KEY"] = settings.LANGSMITH_API_KEY
    os.environ["LANGCHAIN_PROJECT"] = settings.LANGSMITH_PROJECT

_masked_db = settings.DATABASE_URL.split('@')[-1] if '@' in settings.DATABASE_URL else '(local)'
print(f"[ProjectHub] Loaded DATABASE_URL from environment/.env: ...@{_masked_db}")
if settings.LANGSMITH_API_KEY:
    print(f"[ProjectHub] LangSmith Observability enabled for project '{settings.LANGSMITH_PROJECT}'")

