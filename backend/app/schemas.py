from pydantic import BaseModel, EmailStr
from typing import Optional, List, Any
from datetime import datetime, date

# =====================================================================
# Auth & User Schemas
# =====================================================================
class UserBase(BaseModel):
    email: EmailStr
    full_name: str

class UserCreate(UserBase):
    password: str

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[EmailStr] = None
    password: Optional[str] = None

class User(UserBase):
    id: int
    is_active: bool
    is_admin: bool = False
    profile_image: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True

class Token(BaseModel):
    access_token: str
    token_type: str
    user: User
    refresh_token: Optional[str] = None

class TokenData(BaseModel):
    email: Optional[str] = None

class TokenRefreshRequest(BaseModel):
    refresh_token: str

class UserInvite(BaseModel):
    email: EmailStr
    full_name: str
    password: Optional[str] = None
    project_id: Optional[int] = None
    role: Optional[str] = "Frontend"

class AdminAssignRequest(BaseModel):
    user_id: Optional[int] = None
    email: Optional[EmailStr] = None
    is_admin: bool = True


# =====================================================================
# Project Schemas
# =====================================================================
class ProjectBase(BaseModel):
    name: str
    description: Optional[str] = None

class ProjectCreate(ProjectBase):
    pass

class ProjectUpdate(ProjectBase):
    name: Optional[str] = None

class Project(ProjectBase):
    id: int
    owner_id: int
    created_at: datetime
    user_role: Optional[str] = None

    class Config:
        from_attributes = True


# =====================================================================
# Project Member Schemas
# =====================================================================
class ProjectMemberCreate(BaseModel):
    user_email: str  # Email of the user to add
    role: str  # "Frontend", "Backend", "AI"

class ProjectMember(BaseModel):
    id: int
    project_id: int
    user_id: int
    role: str
    user_name: Optional[str] = None
    user_email: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# =====================================================================
# Milestone Schemas
# =====================================================================
class MilestoneBase(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Optional[datetime] = None
    status: Optional[str] = "pending"

class MilestoneCreate(MilestoneBase):
    project_id: int

class MilestoneUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[datetime] = None
    status: Optional[str] = None

class Milestone(MilestoneBase):
    id: int
    project_id: int
    created_at: datetime

    class Config:
        from_attributes = True


# =====================================================================
# Document Schemas
# =====================================================================
class DocumentBase(BaseModel):
    name: str
    file_type: str
    file_size: int
    project_id: int
    milestone_id: Optional[int] = None
    category: Optional[str] = "team"

class Document(DocumentBase):
    id: int
    file_path: str
    uploaded_by: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


# =====================================================================
# Activity Log Schemas
# =====================================================================
class ActivityLog(BaseModel):
    id: int
    user_id: Optional[int] = None
    action: str
    details: str
    created_at: datetime
    user_name: Optional[str] = None  # Helper to display user's name

    class Config:
        from_attributes = True


# =====================================================================
# RAG Chat Schemas
# =====================================================================
class ChatHistoryItem(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    project_id: int
    message: str
    milestone_id: Optional[int] = None
    category: Optional[str] = None
    history: Optional[List[ChatHistoryItem]] = None

class ChatSource(BaseModel):
    document: str
    chunk_index: int
    page: Optional[Any] = None
    snippet: str
    score: float


# =====================================================================
# Chat Message History Schemas
# =====================================================================
class ChatMessageBase(BaseModel):
    role: str
    content: str

class ChatMessage(ChatMessageBase):
    id: int
    project_id: int
    user_id: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


# =====================================================================
# Jira-style User Stories & Tasks
# =====================================================================
class TaskBase(BaseModel):
    title: str
    task_type: str
    status: str = "To Do"
    assigned_to: Optional[int] = None
    due_date: Optional[date] = None

class TaskUpdate(BaseModel):
    title: Optional[str] = None
    task_type: Optional[str] = None
    status: Optional[str] = None
    assigned_to: Optional[int] = None
    due_date: Optional[date] = None

class Task(TaskBase):
    id: int
    story_id: int
    assignee_name: Optional[str] = None
    created_at: datetime
    due_date: Optional[date] = None

    class Config:
        from_attributes = True

class UserStoryBase(BaseModel):
    title: str
    description: Optional[str] = None
    acceptance_criteria: List[str]
    priority: str = "Medium"
    story_points: int = 1
    status: str = "To Do"
    is_on_hold: bool = False
    comments: Optional[List[dict]] = None
    due_date: Optional[date] = None

class UserStoryUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    acceptance_criteria: Optional[List[str]] = None
    priority: Optional[str] = None
    story_points: Optional[int] = None
    status: Optional[str] = None
    is_on_hold: Optional[bool] = None
    comments: Optional[List[dict]] = None
    due_date: Optional[date] = None

class UserStory(UserStoryBase):
    id: int
    project_id: int
    created_at: datetime
    due_date: Optional[date] = None
    tasks: List[Task] = []

    class Config:
        from_attributes = True

class GenerateStoriesRequest(BaseModel):
    document_ids: Optional[List[int]] = None

class GenerateStoriesFromDocumentRequest(BaseModel):
    document_id: int


# =====================================================================
# My Tasks (Developer View)
# =====================================================================
class MyTask(BaseModel):
    id: int
    title: str
    task_type: str
    status: str
    assigned_to: Optional[int] = None
    story_id: int
    story_title: str
    project_id: int
    project_name: str
    created_at: datetime

    class Config:
        from_attributes = True


# =====================================================================
# Password Reset Schemas
# =====================================================================
class PasswordResetRequest(BaseModel):
    email: EmailStr

class PasswordResetConfirm(BaseModel):
    access_token: str
    refresh_token: Optional[str] = None
    new_password: str


# =====================================================================
# Notification Schemas
# =====================================================================
class Notification(BaseModel):
    id: int
    user_id: int
    title: str
    message: str
    is_read: bool
    created_at: datetime

    class Config:
        from_attributes = True
