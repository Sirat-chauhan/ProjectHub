import os
import shutil
from typing import Optional
from fastapi import UploadFile
from backend.app.core.config import settings

class FileStorageService:
    def __init__(self):
        # Determine if we should use Supabase Storage based on environmental availability
        self.use_supabase = bool(settings.SUPABASE_URL and settings.SUPABASE_KEY)
        
        if self.use_supabase:
            print("[ProjectHub] Supabase credentials detected. Enabling Cloud Storage mode.")
            from supabase import create_client, Client
            self.supabase: Client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
            self.bucket_name = "documents"
        else:
            print("[ProjectHub] Supabase credentials missing. Falling back to Local Storage mode.")
            # Ensure local uploads directory exists
            os.makedirs(settings.UPLOAD_DIR, exist_ok=True)

    def get_file_path(self, filename: str, file_bytes: bytes, project_id: Optional[int] = None) -> str:
        import hashlib
        file_hash = hashlib.sha256(file_bytes).hexdigest()
        unique_prefix = file_hash[:16]  # Use first 16 chars of the hash
        
        # Use a slash to create a folder structure in Supabase/Local
        prefix = f"proj_{project_id}/" if project_id is not None else ""
        clean_filename = f"{prefix}{unique_prefix}_{filename}"
        
        if self.use_supabase:
            return clean_filename
        else:
            return os.path.join(settings.UPLOAD_DIR, clean_filename)

    def save_file(self, upload_file: UploadFile, project_id: Optional[int] = None) -> str:
        """
        Saves an uploaded file using a content hash to prevent duplicate storage.
        - In Supabase Mode: Uploads to Supabase 'documents' bucket. Returns the unique filename.
        - In Local Mode: Saves to disk. Returns the absolute disk path.
        """
        # Read stream content as bytes to generate a hash
        file_bytes = upload_file.file.read()
        upload_file.file.seek(0)  # Reset pointer for subsequent reads
        
        file_path = self.get_file_path(upload_file.filename, file_bytes, project_id)

        if self.use_supabase:
            content_type = upload_file.content_type or "application/octet-stream"
            
            try:
                # Upload to Supabase bucket (upsert=True overwrites duplicates without taking extra space)
                self.supabase.storage.from_(self.bucket_name).upload(
                    path=file_path,
                    file=file_bytes,
                    file_options={"content-type": content_type, "upsert": "true"}
                )
            except Exception as e:
                print(f"Supabase upload notice (likely duplicate handled): {str(e)}")
            return file_path
        else:
            # Ensure the directory exists (since file_path might now contain subfolders)
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            with open(file_path, "wb") as buffer:
                buffer.write(file_bytes)
            return file_path

    def delete_file(self, file_path: str) -> bool:
        """
        Purges a document from Supabase bucket or local disk.
        """
        try:
            if self.use_supabase:
                # In Supabase mode, the database file_path contains the unique filename
                self.supabase.storage.from_(self.bucket_name).remove([file_path])
                return True
            else:
                if os.path.exists(file_path):
                    os.remove(file_path)
                    return True
        except Exception as e:
            print(f"Error purging file at {file_path}: {str(e)}")
            return False
        return False

    def delete_project_folder(self, project_id: int) -> bool:
        """
        Purges an entire project folder (proj_X/) from Supabase bucket or local disk.
        Called when a project is deleted to ensure zero orphan storage folders remain.
        """
        folder_prefix = f"proj_{project_id}"
        try:
            if self.use_supabase:
                # List all files in the project folder and delete them in batch
                files = self.supabase.storage.from_(self.bucket_name).list(folder_prefix)
                if files:
                    paths = [f"{folder_prefix}/{f['name']}" for f in files if f.get('name')]
                    if paths:
                        self.supabase.storage.from_(self.bucket_name).remove(paths)
                print(f"[ProjectHub] Purged Supabase Storage folder: {folder_prefix}/")
                return True
            else:
                folder_path = os.path.join(settings.UPLOAD_DIR, folder_prefix)
                if os.path.isdir(folder_path):
                    shutil.rmtree(folder_path)
                    print(f"[ProjectHub] Purged local storage folder: {folder_path}")
                return True
        except Exception as e:
            print(f"[ProjectHub] Error purging project folder {folder_prefix}: {str(e)}")
            return False

    def cleanup_orphan_folders(self, existing_project_ids: set) -> int:
        """
        Directly inspects storage folders (proj_X) and purges any folder whose ID X
        is not in existing_project_ids.
        """
        purged_count = 0
        try:
            if self.use_supabase:
                items = self.supabase.storage.from_(self.bucket_name).list("")
                for item in items:
                    name = item.get("name", "")
                    if name.startswith("proj_"):
                        try:
                            pid = int(name.split("proj_")[1])
                            if pid not in existing_project_ids:
                                self.delete_project_folder(pid)
                                purged_count += 1
                        except ValueError:
                            pass
            else:
                if os.path.exists(settings.UPLOAD_DIR):
                    for entry in os.listdir(settings.UPLOAD_DIR):
                        if entry.startswith("proj_") and os.path.isdir(os.path.join(settings.UPLOAD_DIR, entry)):
                            try:
                                pid = int(entry.split("proj_")[1])
                                if pid not in existing_project_ids:
                                    shutil.rmtree(os.path.join(settings.UPLOAD_DIR, entry))
                                    purged_count += 1
                            except ValueError:
                                pass
        except Exception as e:
            print(f"[ProjectHub] Error scanning orphan storage folders: {str(e)}")
        return purged_count

    def get_local_path(self, file_path: str) -> str:
        """
        Retrieves a physical local path to parse document contents.
        - In Local Mode: returns the file_path itself.
        - In Supabase Mode: downloads the file to a temporary file on disk and returns the temp path.
          (The caller is responsible for deleting the temp file after parsing it).
        """
        if not self.use_supabase:
            return file_path

        # Generate a temporary path in our uploads directory
        # file_path might contain folder separators now (e.g., 'proj_1/abc.txt'), so we replace them to make a safe temp filename
        safe_file_path = file_path.replace("/", "_").replace("\\", "_")
        temp_filename = f"temp_{safe_file_path}"
        temp_path = os.path.join(settings.UPLOAD_DIR, temp_filename)
        
        # Ensure upload folder is created
        os.makedirs(settings.UPLOAD_DIR, exist_ok=True)

        try:
            # Download file bytes
            response = self.supabase.storage.from_(self.bucket_name).download(file_path)
            with open(temp_path, "wb") as f:
                f.write(response)
            return temp_path
        except Exception as e:
            print(f"Error downloading file {file_path} from Supabase: {str(e)}")
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
            raise e

storage_service = FileStorageService()
