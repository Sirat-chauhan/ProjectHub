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

    model_config = SettingsConfigDict(
        env_file=".env", 
        env_file_encoding="utf-8", 
        extra="ignore"
    )

settings = Settings()
_masked_db = settings.DATABASE_URL.split('@')[-1] if '@' in settings.DATABASE_URL else '(local)'
print(f"[ProjectHub] Loaded DATABASE_URL from environment/.env: ...@{_masked_db}")

