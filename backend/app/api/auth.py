from datetime import datetime, timedelta
import os
import uuid
import time
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, status, Request, UploadFile, File
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.core.security import (
    get_password_hash,
    verify_password,
    create_access_token,
    create_refresh_token,
    get_current_user,
    get_current_admin_user
)
from backend.app.models import User, ActivityLog, ProjectMember, Project
from backend.app import schemas
from backend.app.core.config import settings

router = APIRouter(prefix="/api/auth", tags=["auth"])

# In-memory rate limiting tracker: { "user@softprodigy.com": { "count": 3, "lock_until": timestamp, "last_attempt": timestamp } }
FAILED_LOGIN_ATTEMPTS = {}

def get_client_ip(request: Request) -> str:
    """Extracts client IP address, checking X-Forwarded-For header for reverse proxies."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"

def check_rate_limit(identifier: str):
    """Enforces progressive rate limiting and account locking to prevent brute-force password guessing."""
    now = time.time()
    record = FAILED_LOGIN_ATTEMPTS.get(identifier)
    if not record:
        return
    
    # Clean up old records after 30 minutes of inactivity
    if now - record["last_attempt"] > 1800:
        del FAILED_LOGIN_ATTEMPTS[identifier]
        return

    # Check if account is locked (attempt 20+)
    if record["lock_until"] and now < record["lock_until"]:
        remaining_secs = int(record["lock_until"] - now)
        remaining_mins = (remaining_secs // 60) + 1
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Security Alert: Account temporarily locked due to excessive failed login attempts. Please try again in {remaining_mins} minutes."
        )

def record_failed_login(identifier: str):
    """Records a failed login attempt and calculates progressive penalty/lockout."""
    now = time.time()
    record = FAILED_LOGIN_ATTEMPTS.get(identifier, {"count": 0, "lock_until": None, "last_attempt": now})
    record["count"] += 1
    record["last_attempt"] = now
    
    if record["count"] >= 20:
        # Lock account for 15 minutes (900 seconds)
        record["lock_until"] = now + 900
    
    FAILED_LOGIN_ATTEMPTS[identifier] = record

def record_successful_login(identifier: str):
    """Resets failed login attempt counter upon successful login."""
    if identifier in FAILED_LOGIN_ATTEMPTS:
        del FAILED_LOGIN_ATTEMPTS[identifier]

import requests

def get_neon_auth_url():
    url = getattr(settings, "NEON_AUTH_URL", None) or os.getenv("NEON_AUTH_URL")
    return url.rstrip('/') if url else None


def validate_corporate_domain(email: str):
    """Allows any valid email address to access or register in ProjectHub."""
    if not email or "@" not in email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Please provide a valid email address."
        )


def log_activity(db: Session, user_id: Optional[int], action: str, details: str):
    """Utility helper to record team events in the ActivityLog table."""
    log = ActivityLog(user_id=user_id, action=action, details=details)
    db.add(log)
    db.commit()

@router.post("/register", response_model=schemas.User, status_code=status.HTTP_201_CREATED)
def register(user_in: schemas.UserCreate, request: Request, db: Session = Depends(get_db)):
    """Registers a new user via Supabase Auth and sends a verification email without creating unverified local accounts."""
    validate_corporate_domain(user_in.email)
    existing_user = db.query(User).filter(User.email == user_in.email).first()
    if existing_user:
        raise HTTPException(
            status_code=400,
            detail="A user with this email already exists."
        )
    
    neon_url = get_neon_auth_url()
    if neon_url:
        try:
            origin = request.headers.get("origin") or "http://localhost:8000"
            res = requests.post(
                f"{neon_url}/sign-up/email",
                json={
                    "email": user_in.email,
                    "password": user_in.password,
                    "name": user_in.full_name or user_in.email.split("@")[0]
                },
                headers={"Origin": origin},
                timeout=10
            )
            print(f"[ProjectHub] Neon Auth sign_up response: {res.status_code}")
            if res.status_code >= 400:
                err_msg = res.json().get("message", res.text) if "application/json" in res.headers.get("Content-Type", "") else res.text
                if "already exists" in err_msg.lower() or "duplicate" in err_msg.lower():
                    raise HTTPException(
                        status_code=409,
                        detail="This email is already registered in Neon Auth. Please log in or delete it from the Neon dashboard."
                    )
            
            local_user = User(
                email=user_in.email,
                hashed_password=get_password_hash(user_in.password),
                full_name=user_in.full_name or user_in.email.split("@")[0],
                is_active=True,
                is_admin=False
            )
            db.add(local_user)
            db.commit()
            db.refresh(local_user)

            ip = get_client_ip(request)
            log_activity(db, local_user.id, "register_user", f"User registered (Neon Sync): {user_in.email} [IP: {ip}] [Time: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}]")
            return local_user
        except HTTPException:
            raise
        except Exception as e:
            print(f"[ProjectHub] Neon Auth sign_up error/notice: {str(e)}")

    # Fallback or local registration
    local_user = User(
        email=user_in.email,
        hashed_password=get_password_hash(user_in.password),
        full_name=user_in.full_name or user_in.email.split("@")[0],
        is_active=True,
        is_admin=False
    )
    db.add(local_user)
    db.commit()
    db.refresh(local_user)

    ip = get_client_ip(request)
    log_activity(db, local_user.id, "register_user", f"User registered locally: {user_in.email} [IP: {ip}] [Time: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}]")
    return local_user

@router.post("/invite", status_code=status.HTTP_201_CREATED)
def invite_user(
    invite_in: schemas.UserInvite,
    request: Request,
    db: Session = Depends(get_db),
    current_admin: User = Depends(get_current_admin_user)
):
    """Admin-only endpoint to invite/register a user and optionally assign them to a project team."""
    validate_corporate_domain(invite_in.email)
    user = db.query(User).filter(User.email == invite_in.email).first()
    created_new = False
    
    if not user:
        import secrets
        pwd = invite_in.password or secrets.token_urlsafe(16)
        hashed_pwd = get_password_hash(pwd)
        user = User(
            email=invite_in.email,
            hashed_password=hashed_pwd,
            full_name=invite_in.full_name
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        created_new = True
        log_activity(db, current_admin.id, "register_user", f"Admin invited & registered user: {user.full_name} ({user.email})")

    assigned_project = None
    if invite_in.project_id:
        project = db.query(Project).filter(Project.id == invite_in.project_id).first()
        if project:
            existing_mem = db.query(ProjectMember).filter(
                ProjectMember.project_id == project.id,
                ProjectMember.user_id == user.id
            ).first()
            if not existing_mem:
                member = ProjectMember(
                    project_id=project.id,
                    user_id=user.id,
                    role=invite_in.role or "Frontend"
                )
                db.add(member)
                
                from backend.app.models import Notification
                notification = Notification(
                    user_id=user.id,
                    title="Added to Project",
                    message=f"You have been added to the project '{project.name}' as '{invite_in.role or 'Frontend'}'."
                )
                db.add(notification)
                db.commit()
                assigned_project = project.name
            else:
                existing_mem.role = invite_in.role or "Frontend"
                
                from backend.app.models import Notification
                notification = Notification(
                    user_id=user.id,
                    title="Project Role Updated",
                    message=f"Your role in project '{project.name}' has been updated to '{invite_in.role or 'Frontend'}'."
                )
                db.add(notification)
                db.commit()
                assigned_project = project.name

    # Try Neon Auth Registration (No native invite email, so we just sign them up)
    neon_url = get_neon_auth_url()
    neon_invited = False
    if neon_url and created_new:
        try:
            res = requests.post(
                f"{neon_url}/sign-up/email",
                json={
                    "email": invite_in.email,
                    "password": pwd,
                    "name": invite_in.full_name
                },
                headers={"Origin": request.headers.get("origin") or "http://localhost:8000"},
                timeout=10
            )
            neon_invited = True
            print(f"[ProjectHub] Neon Auth registration triggered for {invite_in.email}: {res.status_code}")
        except Exception as e:
            print(f"[ProjectHub] Neon Auth invite notice/error: {e}")

    # Send invite email via direct SMTP with temporary credentials
    smtp_invited = False
    if created_new:
        try:
            from backend.app.services.email_service import send_invite_email, is_smtp_configured
            if is_smtp_configured():
                origin = request.headers.get("origin") or "http://localhost:8000"
                send_invite_email(invite_in.email, invite_in.full_name, pwd, origin)
                smtp_invited = True
                print(f"[ProjectHub] Invite email sent via SMTP to {invite_in.email}")
        except Exception as e:
            print(f"[ProjectHub] SMTP invite email error (non-fatal): {e}")

    msg = f"User '{user.full_name}' ({user.email}) has been successfully invited and registered!" if created_new else f"User '{user.full_name}' ({user.email}) already exists."
    if neon_invited:
        msg += " The user has been registered in Neon Auth as well."
    if assigned_project:
        msg += f" Added to project '{assigned_project}' as '{invite_in.role or 'Frontend'}'."

    return {
        "detail": msg,
        "user": {
            "id": user.id,
            "email": user.email,
            "full_name": user.full_name,
            "created_new": created_new
        }
    }

@router.get("/users", response_model=List[schemas.User])
def list_all_users(
    db: Session = Depends(get_db),
    current_admin: User = Depends(get_current_admin_user)
):
    """Admin-only endpoint to retrieve all registered workspace users."""
    users = db.query(User).order_by(User.full_name.asc()).all()
    return users


@router.post("/assign-admin", status_code=status.HTTP_200_OK)
def assign_admin_role(
    req: schemas.AdminAssignRequest,
    db: Session = Depends(get_db),
    current_admin: User = Depends(get_current_admin_user)
):
    """Admin-only endpoint to promote or demote a registered workspace user as Admin."""
    user = None
    if req.user_id:
        user = db.query(User).filter(User.id == req.user_id).first()
    elif req.email:
        user = db.query(User).filter(User.email == req.email).first()

    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    if user.id == current_admin.id and not req.is_admin:
        raise HTTPException(status_code=400, detail="You cannot revoke your own administrator privileges.")

    user.is_admin = req.is_admin
    db.commit()
    db.refresh(user)

    action_text = "promoted to Administrator" if req.is_admin else "demoted from Administrator"
    log_activity(db, current_admin.id, "assign_admin", f"Admin '{current_admin.full_name}' {action_text} user '{user.full_name}' ({user.email})")

    return {
        "detail": f"User '{user.full_name}' has been {action_text} successfully.",
        "user": user
    }


@router.post("/login", response_model=schemas.Token)
def login(login_in: schemas.UserLogin, request: Request, db: Session = Depends(get_db)):
    """Logs in a user via JSON payload (email and password), checking Supabase Auth first then local fallback."""
    validate_corporate_domain(login_in.email)
    check_rate_limit(login_in.email)
    
    user = db.query(User).filter(User.email == login_in.email).first()
    neon_auth_ok = False
    neon_url = get_neon_auth_url()
    if neon_url:
        try:
            auth_res = requests.post(
                f"{neon_url}/sign-in/email",
                json={
                    "email": login_in.email,
                    "password": login_in.password
                },
                timeout=10
            )
            if auth_res.status_code == 200:
                neon_auth_ok = True
                print(f"[ProjectHub] Neon Auth login successful for {login_in.email}")
            else:
                err_msg = auth_res.text.lower()
                if "email not verified" in err_msg or "email_not_verified" in err_msg:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Please verify your email address first."
                    )
                print(f"[ProjectHub] Neon sign_in notice/error: {err_msg}")
        except HTTPException:
            raise
        except Exception as e:
            print(f"[ProjectHub] Neon sign_in exception: {e}")
    
    if not neon_auth_ok:
        if not user or not verify_password(login_in.password, user.hashed_password):
            record_failed_login(login_in.email)
            ip = get_client_ip(request)
            log_activity(db, None, "failed_login", f"Failed login attempt for {login_in.email} [IP: {ip}] [Time: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}]")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect email or password",
                headers={"WWW-Authenticate": "Bearer"},
            )
    else:
        if not user:
            user = User(
                email=login_in.email,
                hashed_password=get_password_hash(login_in.password),
                full_name=login_in.email.split("@")[0]
            )
            db.add(user)
            db.commit()
            db.refresh(user)
        else:
            user.hashed_password = get_password_hash(login_in.password)
            db.commit()

    record_successful_login(login_in.email)
    access_token = create_access_token(data={"sub": user.email})
    refresh_token = create_refresh_token(data={"sub": user.email})
    ip = get_client_ip(request)
    log_activity(db, user.id, "login_user", f"User logged in: {user.full_name} [IP: {ip}] [Time: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}]")
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user,
        "refresh_token": refresh_token
    }

@router.post("/login/form", response_model=schemas.Token)
def login_form(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    """Logs in a user via standard OAuth2 Password Request Form, checking Supabase Auth first then local fallback."""
    validate_corporate_domain(form_data.username)
    check_rate_limit(form_data.username)
    
    user = db.query(User).filter(User.email == form_data.username).first()
    neon_auth_ok = False
    neon_url = get_neon_auth_url()
    if neon_url:
        try:
            auth_res = requests.post(
                f"{neon_url}/sign-in/email",
                json={
                    "email": form_data.username,
                    "password": form_data.password
                },
                timeout=10
            )
            if auth_res.status_code == 200:
                neon_auth_ok = True
                print(f"[ProjectHub] Neon Auth login successful for {form_data.username}")
        except Exception as e:
            print(f"[ProjectHub] Neon sign_in notice/error: {e}")
    
    if not neon_auth_ok:
        if not user or not verify_password(form_data.password, user.hashed_password):
            record_failed_login(form_data.username)
            ip = get_client_ip(request)
            log_activity(db, None, "failed_login", f"Failed login attempt for {form_data.username} [IP: {ip}] [Time: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}]")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect email or password",
                headers={"WWW-Authenticate": "Bearer"},
            )
    else:
        if not user:
            user = User(
                email=form_data.username,
                hashed_password=get_password_hash(form_data.password),
                full_name=form_data.username.split("@")[0]
            )
            db.add(user)
            db.commit()
            db.refresh(user)
        else:
            user.hashed_password = get_password_hash(form_data.password)
            db.commit()

    record_successful_login(form_data.username)
    access_token = create_access_token(data={"sub": user.email})
    refresh_token = create_refresh_token(data={"sub": user.email})
    ip = get_client_ip(request)
    log_activity(db, user.id, "login_user", f"User logged in (form): {user.full_name} [IP: {ip}] [Time: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}]")
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user,
        "refresh_token": refresh_token
    }

@router.get("/me", response_model=schemas.User)
def read_users_me(current_user: User = Depends(get_current_user)):
    """Retrieves the profile of the currently logged-in user."""
    return current_user

@router.put("/me", response_model=schemas.User)
def update_user_me(
    user_in: schemas.UserUpdate, 
    db: Session = Depends(get_db), 
    current_user: User = Depends(get_current_user)
):
    """Updates the profile of the currently logged-in user."""
    if user_in.full_name is not None:
        current_user.full_name = user_in.full_name
    if user_in.email is not None:
        # Check if email is already taken by another user
        existing = db.query(User).filter(User.email == user_in.email).first()
        if existing and existing.id != current_user.id:
            raise HTTPException(status_code=400, detail="Email already registered")
        current_user.email = user_in.email
    if user_in.password is not None and user_in.password.strip():
        current_user.hashed_password = get_password_hash(user_in.password)
        
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/refresh", response_model=schemas.Token)
def refresh_token_endpoint(req: schemas.TokenRefreshRequest, db: Session = Depends(get_db)):
    """Validates a long-lived refresh token and issues a brand new access and refresh token pair without logging the user out."""
    from jose import jwt, JWTError
    try:
        payload = jwt.decode(req.refresh_token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        email: str = payload.get("sub")
        token_type: str = payload.get("type", "refresh")
        if email is None or token_type != "refresh":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")
        
    user = db.query(User).filter(User.email == email).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User account not found or deactivated")
        
    new_access_token = create_access_token(data={"sub": user.email})
    new_refresh_token = create_refresh_token(data={"sub": user.email})
    
    return {
        "access_token": new_access_token,
        "token_type": "bearer",
        "user": user,
        "refresh_token": new_refresh_token
    }


@router.post("/forgot-password", status_code=status.HTTP_200_OK)
def forgot_password(req: schemas.PasswordResetRequest, request: Request, db: Session = Depends(get_db)):
    """Triggers a password reset link sent via Neon Auth email sender."""
    validate_corporate_domain(req.email)
    neon_url = get_neon_auth_url()
    if not neon_url:
        raise HTTPException(
            status_code=500,
            detail="Neon Auth is not configured. Cannot send password reset email."
        )

    origin = request.headers.get("origin") or "http://localhost:8000"
    ip = get_client_ip(request)

    # Check if user exists in local DB
    user = db.query(User).filter(User.email == req.email).first()

    # Auto-ensure user is synced in Neon Auth before triggering reset
    if user:
        try:
            requests.post(
                f"{neon_url}/sign-up/email",
                json={
                    "email": user.email,
                    "password": "TempSyncPassword123!",
                    "name": user.full_name or user.email.split("@")[0]
                },
                headers={"Origin": origin},
                timeout=5
            )
        except Exception:
            pass

    try:
        res = requests.post(
            f"{neon_url}/request-password-reset",
            json={"email": req.email, "redirectTo": f"{origin}/?recovery=true"},
            headers={"Origin": origin},
            timeout=10
        )
        print(f"[ProjectHub] Password reset email triggered via Neon Auth for {req.email}: {res.status_code}")
        
        if res.status_code >= 400:
            err_msg = res.json().get("message", res.text) if "application/json" in res.headers.get("Content-Type", "") else res.text
            print(f"[ProjectHub] Neon Auth error: {err_msg}")
            # Do not expose internal Neon errors directly to user if it's just "user not found"
            # But for debugging, we will log it.
            if "user not found" not in err_msg.lower():
                raise Exception(f"Neon API Error: {err_msg}")
                
        log_activity(db, user.id if user else None, "password_reset_request", f"Password reset requested (Neon Auth) for {req.email} [IP: {ip}]")
        return {"detail": "If an account exists with this email, a password reset link has been sent to your inbox."}
    except Exception as e:
        err_msg = str(e)
        print(f"[ProjectHub] Forgot password error via Neon Auth: {err_msg}")
        raise HTTPException(
            status_code=400,
            detail=f"Could not send password reset link: {err_msg}"
        )


@router.post("/reset-password", status_code=status.HTTP_200_OK)
def reset_password(req: schemas.PasswordResetConfirm, request: Request, db: Session = Depends(get_db)):
    """Confirms a password reset using the token via Neon Auth and updates local password hash."""
    if len(req.new_password) < 6:
        raise HTTPException(
            status_code=400,
            detail="Password must be at least 6 characters long."
        )
    neon_url = get_neon_auth_url()
    if not neon_url:
        raise HTTPException(
            status_code=500,
            detail="Neon Auth is not configured."
        )
    
    ip = get_client_ip(request)
    try:
        # Confirm password reset with Neon Auth
        res = requests.post(
            f"{neon_url}/reset-password",
            json={
                "newPassword": req.new_password,
                "token": req.access_token
            },
            timeout=10
        )
        if res.status_code >= 400:
            err_detail = "Invalid or expired password reset token."
            try:
                err_detail = res.json().get("message", err_detail)
            except Exception:
                pass
            raise HTTPException(status_code=400, detail=err_detail)

        # Update local password hash in PostgreSQL so local database remains in sync
        neon_data = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
        neon_email = neon_data.get("user", {}).get("email")
        if neon_email:
            user = db.query(User).filter(User.email == neon_email).first()
            if user:
                user.hashed_password = get_password_hash(req.new_password)
                db.commit()
                print(f"[ProjectHub] Local password hash updated for {neon_email}")

        log_activity(db, None, "password_reset_complete", f"Password reset completed via Neon Auth [IP: {ip}]")
        print(f"[ProjectHub] Password reset successfully completed via Neon Auth")
        return {"detail": "Password has been reset successfully. You can now log in with your new password."}
    except HTTPException:
        raise
    except Exception as e:
        err_msg = str(e)
        print(f"[ProjectHub] Reset password error: {err_msg}")
        raise HTTPException(
            status_code=400,
            detail=f"Could not reset password: {err_msg}"
        )


# ──────────────────────────────────────────────
#  Avatar upload endpoint
# ──────────────────────────────────────────────
AVATAR_UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..", "uploads", "avatars")

@router.post("/me/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Upload a profile picture for the currently logged-in user."""
    # Validate MIME type
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files (JPEG, PNG, WebP) are accepted.")

    # Read and validate size (max 2 MiB)
    contents = await file.read()
    if len(contents) > 2 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image too large. Maximum size is 2 MB.")

    from backend.app.services.storage import storage_service
    import uuid

    ext = os.path.splitext(file.filename or "avatar.jpg")[1].lower() or ".jpg"
    filename = f"{uuid.uuid4().hex}{ext}"
    relative_url = ""

    if storage_service.use_supabase:
        supabase_path = f"{filename}"
        try:
            # Try to delete the old avatar from Supabase if it exists
            if current_user.profile_image and "/storage/v1/object/public/" in current_user.profile_image:
                old_filename = current_user.profile_image.split("/")[-1]
                try:
                    if "documents/avatars" in current_user.profile_image:
                        storage_service.supabase.storage.from_("documents").remove([f"avatars/{old_filename}"])
                    else:
                        storage_service.supabase.storage.from_("avatars").remove([f"{old_filename}"])
                except Exception:
                    pass

            # Upload the new avatar to the dedicated public 'avatars' bucket
            storage_service.supabase.storage.from_("avatars").upload(
                supabase_path,
                contents,
                {"content-type": file.content_type}
            )
            # Use the public URL directly
            relative_url = storage_service.supabase.storage.from_("avatars").get_public_url(supabase_path)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to upload avatar to Supabase: {str(e)}")
    else:
        # Create folder if needed
        os.makedirs(AVATAR_UPLOAD_DIR, exist_ok=True)
        save_path = os.path.join(AVATAR_UPLOAD_DIR, filename)

        # Delete previous avatar if exists locally
        if current_user.profile_image and current_user.profile_image.startswith("/uploads/avatars/"):
            old_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", current_user.profile_image.lstrip("/"))
            old_path = os.path.normpath(old_path)
            if os.path.isfile(old_path):
                try:
                    os.remove(old_path)
                except OSError:
                    pass

        # Save new file locally
        with open(save_path, "wb") as out:
            out.write(contents)

        # Relative URL served as static
        relative_url = f"/uploads/avatars/{filename}"

    # Persist to DB
    current_user.profile_image = relative_url
    db.add(current_user)
    db.commit()
    db.refresh(current_user)

    return {"profile_image_url": relative_url}
