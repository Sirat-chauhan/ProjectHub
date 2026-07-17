from fastapi import APIRouter, Depends, status
from typing import List
from sqlalchemy.orm import Session

from backend.app.core.database import get_db
from backend.app.core.security import get_current_user
from backend.app.models import ActivityLog, User
from backend.app import schemas

router = APIRouter(prefix="/api/logs", tags=["logs"])

@router.get("", response_model=List[schemas.ActivityLog])
def get_logs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Retrieves the latest 100 activity logs on the server.
    Performs an outer join with the User table to retrieve full names.
    """
    query = db.query(
        ActivityLog,
        User.full_name
    ).outerjoin(
        User, ActivityLog.user_id == User.id
    )

    if not current_user.is_admin:
        query = query.filter(ActivityLog.user_id == current_user.id)

    results = query.order_by(
        ActivityLog.created_at.desc()
    ).limit(100).all()

    logs = []
    for log, full_name in results:
        logs.append(schemas.ActivityLog(
            id=log.id,
            user_id=log.user_id,
            action=log.action,
            details=log.details,
            created_at=log.created_at,
            user_name=full_name or "System/Anonymous"
        ))
        
    return logs
