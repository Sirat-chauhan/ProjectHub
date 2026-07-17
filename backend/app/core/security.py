from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session
from backend.app.core.config import settings
from backend.app.core.database import get_db

import bcrypt

# OAuth2 Scheme definition
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/login")

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verifies that a plain password matches its hashed form."""
    try:
        return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))
    except Exception:
        # fallback in case hashed_password in DB isn't encoded properly
        try:
            return bcrypt.checkpw(plain_password.encode('utf-8'), bytes(hashed_password, 'utf-8'))
        except Exception:
            return False

def get_password_hash(password: str) -> str:
    """Generates a secure bcrypt hash of a password."""
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode('utf-8'), salt).decode('utf-8')

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Creates a JWT access token with user details and expiration time."""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    
    to_encode.update({"exp": expire, "type": "access"})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return encoded_jwt

def create_refresh_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Creates a long-lived JWT refresh token valid for 30 days."""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(days=30)
    
    to_encode.update({"exp": expire, "type": "refresh"})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return encoded_jwt

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    """
    FastAPI dependency to extract JWT token, validate it, and return the User model.
    Throws HTTP 401 if unauthorized.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
        
    from backend.app.models import User
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise credentials_exception
    return user

def get_current_admin_user(current_user = Depends(get_current_user), db: Session = Depends(get_db)):
    """
    FastAPI dependency to verify if current user is an administrator or a manager of ANY project.
    """
    if getattr(current_user, "is_admin", False):
        return current_user
        
    from backend.app.models import Project, ProjectMember
    is_owner = db.query(Project).filter(Project.owner_id == current_user.id).first() is not None
    is_manager = db.query(ProjectMember).filter(ProjectMember.user_id == current_user.id, ProjectMember.role == "Manager").first() is not None
    
    if not (is_owner or is_manager):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Super-Admin or Manager privileges required to perform this action."
        )
    return current_user

def check_is_project_manager_or_admin(db: Session, user, project_id: int):
    """
    Helper to check if user is a Super-Admin OR a Project Manager/Owner.
    Raises HTTPException 403 if they do not have access.
    """
    if getattr(user, "is_admin", False):
        return True
        
    from backend.app.models import Project, ProjectMember
    # Check if project owner
    project = db.query(Project).filter(Project.id == project_id).first()
    if project and project.owner_id == user.id:
        return True
        
    # Check if member with 'Manager' role
    member = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user.id,
        ProjectMember.role == "Manager"
    ).first()
    if member:
        return True
        
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Access denied. You must be an Admin or a Project Manager to perform this action."
    )
