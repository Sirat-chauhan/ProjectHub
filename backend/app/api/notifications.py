from fastapi import APIRouter, Depends, HTTPException, status
from typing import List
from sqlalchemy.orm import Session

from backend.app.core.database import get_db
from backend.app.core.security import get_current_user
from backend.app.models import Notification, User
from backend.app import schemas

router = APIRouter(prefix="/api/notifications", tags=["notifications"])

@router.get("", response_model=List[schemas.Notification])
def get_notifications(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Retrieves all notifications for the current authenticated user."""
    return db.query(Notification).filter(
        Notification.user_id == current_user.id
    ).order_by(
        Notification.created_at.desc()
    ).limit(50).all()

@router.post("/read-all", status_code=status.HTTP_200_OK)
def mark_all_as_read(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Marks all notifications for the current authenticated user as read."""
    db.query(Notification).filter(
        Notification.user_id == current_user.id,
        Notification.is_read == False
    ).update({Notification.is_read: True}, synchronize_session="fetch")
    db.commit()
    return {"detail": "All notifications marked as read."}

@router.put("/{notification_id}/read", status_code=status.HTTP_200_OK)
def mark_as_read(
    notification_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Marks a single notification for the current authenticated user as read."""
    notification = db.query(Notification).filter(
        Notification.id == notification_id,
        Notification.user_id == current_user.id
    ).first()
    
    if not notification:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Notification not found."
        )
        
    notification.is_read = True
    db.commit()
    return {"detail": "Notification marked as read."}
