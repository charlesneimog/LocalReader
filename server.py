#!/usr/bin/env python3
import json
import re
import os
import asyncio
import inspect
import base64
import hashlib
import hmac
import secrets
import smtplib
import logging
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone
from email.parser import BytesParser
from email.policy import default
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
import app

HOST = "0.0.0.0"
PORT = 8000


AUTH_SECRET = os.environ.get("AUTH_SECRET") or secrets.token_urlsafe(32)
AUTH_TOKEN_TTL_SECONDS = int(os.environ.get("AUTH_TOKEN_TTL_SECONDS", "604800"))  # 7 days


LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").strip().upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("localreader.server")


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(raw: str) -> bytes:
    padding = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode((raw + padding).encode("ascii"))


def issue_auth_token(email: str, ttl_seconds: int = AUTH_TOKEN_TTL_SECONDS) -> str:
    exp = int((datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)).timestamp())
    payload = json.dumps({"email": email, "exp": exp}, separators=(",", ":")).encode("utf-8")
    payload_b64 = _b64url_encode(payload)
    sig = hmac.new(AUTH_SECRET.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    sig_b64 = _b64url_encode(sig)
    return f"{payload_b64}.{sig_b64}"


def verify_auth_token(token: str) -> str | None:
    if not token or "." not in token:
        return None
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        expected_sig = hmac.new(
            AUTH_SECRET.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
        ).digest()
        provided_sig = _b64url_decode(sig_b64)
        if not hmac.compare_digest(expected_sig, provided_sig):
            return None
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        exp = int(payload.get("exp", 0))
        if exp <= int(datetime.now(timezone.utc).timestamp()):
            return None
        email = payload.get("email")
        return email if isinstance(email, str) and email.strip() else None
    except Exception:
        return None


def _parse_multipart_form_data(content_type: str, body: bytes) -> tuple[dict, dict]:
    """Parse multipart/form-data without using deprecated cgi.

    Returns (fields, files) where:
      - fields: {name: str}
      - files: {name: {filename, content_type, content(bytes)}}
    """
    if not content_type or not content_type.startswith("multipart/form-data"):
        return {}, {}

    # The email parser expects a full message; synthesize minimal headers.
    msg = BytesParser(policy=default).parsebytes(
        b"Content-Type: " + content_type.encode("utf-8") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    if not msg.is_multipart():
        return {}, {}

    fields: dict[str, str] = {}
    files: dict[str, dict] = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        filename = part.get_param("filename", header="content-disposition")
        payload = part.get_payload(decode=True) or b""
        if filename is not None:
            files[name] = {
                "filename": filename,
                "content_type": part.get_content_type(),
                "content": payload,
            }
        else:
            charset = part.get_content_charset() or "utf-8"
            try:
                fields[name] = payload.decode(charset, errors="replace")
            except LookupError:
                fields[name] = payload.decode("utf-8", errors="replace")

    return fields, files


def _send_email_smtp(to_email: str, subject: str, body: str) -> None:
    host = os.environ.get("SMTP_HOST", "")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASS", "")
    sender = os.environ.get("SMTP_FROM", user)
    use_tls = (os.environ.get("SMTP_USE_TLS", "true").strip().lower() in {"1", "true", "yes"})

    if not host or not sender or not user or not password:
        raise RuntimeError("SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM)")

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)

    with smtplib.SMTP(host, port, timeout=15) as smtp:
        smtp.ehlo()
        if use_tls:
            smtp.starttls()
            smtp.ehlo()
        smtp.login(user, password)
        smtp.send_message(msg)


class APIHandler(BaseHTTPRequestHandler):
    # Read allowed origins from environment variable, fallback to defaults
    ALLOWED_ORIGINS = os.environ.get(
        "ALLOWED_ORIGINS",
        "http://127.0.0.1:8080,https://charlesneimog.github.io,http://localhost:8080"
    ).split(",")
    
    # def _set_cors_headers(self):
    #     """Set CORS headers to allow browser requests."""
    #     origin = self.headers.get("Origin", "")
    #     
    #     # Check if origin is allowed
    #     allowed = False
    #     for allowed_origin in self.ALLOWED_ORIGINS:
    #         if origin.startswith(allowed_origin):
    #             allowed = True
    #             break
    #     
    #     if allowed:
    #         self.send_header("Access-Control-Allow-Origin", origin)
    #     else:
    #         self.send_header("Access-Control-Allow-Origin", self.ALLOWED_ORIGINS[0])
    #     
    #     self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    #     self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    #     self.send_header("Access-Control-Allow-Credentials", "true")

    def _set_cors_headers(self):
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
        else:
            self.send_header("Access-Control-Allow-Origin", "*")

        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization"
        )
        self.send_header("Access-Control-Allow-Credentials", "true")


    def _get_auth_email(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return None
        token = auth[len("Bearer ") :].strip()
        return verify_auth_token(token)

    def _require_auth(self):
        email = self._get_auth_email()
        if not email:
            logger.info("Unauthorized request: method=%s path=%s ip=%s", self.command, self.path, self.client_address[0])
            self._send_json(401, {"error": "Unauthorized"})
            return None
        return email
    
    def _send_json(self, status_code, data):
        """Send JSON response."""
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self._set_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def _send_error(self, status_code, message):
        """Send error response."""
        self._send_json(status_code, {"error": message})
    
    def do_OPTIONS(self):
        """Handle preflight requests."""
        logger.debug("CORS preflight: path=%s origin=%s", self.path, self.headers.get("Origin", ""))
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()
    
    def do_GET(self):
        """Handle GET requests."""
        parsed = urlparse(self.path)
        path = parsed.path

        logger.debug("GET %s ip=%s", path, self.client_address[0])
        
        # GET /api/ping - Simple health check
        if path == "/api/ping":
            logger.debug("Ping")
            self._send_json(200, {"status": "ok", "message": "Server is running"})
            return

        # GET /api/auth/me
        if path == "/api/auth/me":
            email = self._get_auth_email()
            if not email:
                self._send_json(200, {"authenticated": False})
                return
            self._send_json(200, {"authenticated": True, "email": email})
            return

        # All other API routes require auth
        user_email = self._require_auth()
        if not user_email:
            return
        
        # GET /api/files - List all files
        if path == "/api/files":
            files = app.get_files(owner_email=user_email)
            deleted = app.get_deleted_files(owner_email=user_email)

            # Emit tombstones as lightweight entries so other instances can purge local copies.
            for d in deleted:
                actual = (d.get("actual_filename") or "").strip()
                deleted_at = d.get("deleted_at")
                if not actual:
                    continue
                fmt = "epub" if actual.lower().endswith(".epub") else "pdf"
                files.append(
                    {
                        "filename": actual,
                        "title": actual,
                        "format": fmt,
                        "reading_position": None,
                        "voice": None,
                        "created_at": deleted_at,
                        "updated_at": deleted_at,
                        "position_updated_at": deleted_at,
                        "highlights_updated_at": deleted_at,
                        "voice_updated_at": deleted_at,
                        "deleted": True,
                        "deleted_at": deleted_at,
                    }
                )

            logger.info(
                "List files: owner=%s count=%d tombstones=%d",
                user_email,
                len(files),
                len(deleted),
            )
            self._send_json(200, {"files": files})
            return
        
        # GET /api/files/{file_id}/download
        match = re.match(r'^/api/files/(.+)/download$', path)
        if match:
            file_id = unquote(match.group(1))
            logger.info("Download request: owner=%s file_id=%s", user_email, file_id)

            if app.is_file_deleted(file_id, owner_email=user_email):
                self._send_json(410, {"error": "File deleted", "deleted": True})
                return
            
            file_data = app.get_file_blob(file_id, owner_email=user_email)
            if file_data:
                # Extract filename from file_id (format: "file::filename::size::timestamp")
                filename = file_id
                if file_id.startswith("file::"):
                    parts = file_id.split("::")
                    if len(parts) >= 2:
                        filename = parts[1]  # Get the actual filename
                
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition", f"attachment; filename=\"{filename}\"")
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(file_data)
                logger.info("Download served: owner=%s bytes=%d filename=%s", user_email, len(file_data), filename)
            else:
                self._send_error(404, "File not found")
            return
        
        # GET /api/files/{file_id}/highlights
        match = re.match(r'^/api/files/(.+)/highlights$', path)
        if match:
            file_id = unquote(match.group(1))
            logger.info("Get highlights: owner=%s file_id=%s", user_email, file_id)
            
            highlights = app.get_highlights(file_id, owner_email=user_email)
            if highlights is not None:
                self._send_json(200, {"highlights": highlights})
            else:
                self._send_json(200, {"highlights": []})
            return
        
        # GET /api/files/{file_id}
        match = re.match(r'^/api/files/(.+)$', path)
        if match:
            file_id = unquote(match.group(1))
            logger.debug("Check file exists: owner=%s file_id=%s", user_email, file_id)
            
            # Get file metadata
            file_data = app.get_file_data(file_id, owner_email=user_email)
            if file_data:
                logger.debug("File exists: owner=%s file_id=%s", user_email, file_id)
                self._send_json(200, {
                    "exists": True,
                    "file_id": file_data.get("filename"),
                    "title": file_data.get("title"),
                    "format": file_data.get("format"),
                    "reading_position": file_data.get("reading_position"),
                    "voice": file_data.get("voice"),
                    "created_at": file_data.get("created_at"),
                    "updated_at": file_data.get("updated_at"),
                    "position_updated_at": file_data.get("position_updated_at"),
                    "highlights_updated_at": file_data.get("highlights_updated_at"),
                    "voice_updated_at": file_data.get("voice_updated_at"),
                })
            else:
                logger.debug("File not found: owner=%s file_id=%s", user_email, file_id)
                if app.is_file_deleted(file_id, owner_email=user_email):
                    self._send_json(410, {"exists": False, "deleted": True, "file_id": file_id})
                else:
                    self._send_json(404, {"exists": False, "file_id": file_id})
            return
        
        self._send_error(404, "Not found")
    
    def do_POST(self):
        """Handle POST requests."""
        parsed = urlparse(self.path)
        path = parsed.path

        # POST /api/auth/signup
        if path == "/api/auth/signup":
            logger.info("Signup attempt")
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                data = json.loads(body.decode()) if body else {}
            except Exception as e:
                self._send_error(400, f"Invalid JSON: {str(e)}")
                return

            email = (data.get("email") or "").strip()
            password = data.get("password") or ""

            if not email or not password:
                self._send_error(400, "Missing 'email' or 'password'")
                return

            ok = app.create_user(email, password)
            if not ok:
                logger.info("Signup failed: email=%s", (email or "").strip().lower())
                self._send_error(400, "Signup failed (email may already exist or password too short)")
                return

            logger.info("Signup success: email=%s", email.strip().lower())

            # Best-effort welcome email (uses SMTP settings; ignored if not configured)
            try:
                app_name = os.environ.get("APP_NAME", "LocalReader")
                _send_email_smtp(
                    email.strip().lower(),
                    f"Welcome to {app_name}",
                    f"Your {app_name} account was created successfully.\n",
                )
            except Exception as e:
                logger.warning("Signup email not sent: email=%s err=%s", email.strip().lower(), e)

            token = issue_auth_token(email.strip().lower())
            self._send_json(201, {"success": True, "token": token})
            return

        # POST /api/auth/login
        if path == "/api/auth/login":
            logger.info("Login attempt")
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                data = json.loads(body.decode()) if body else {}
            except Exception as e:
                self._send_error(400, f"Invalid JSON: {str(e)}")
                return

            email = (data.get("email") or "").strip()
            password = data.get("password") or ""
            if not email or not password:
                self._send_error(400, "Missing 'email' or 'password'")
                return

            if not app.verify_user(email, password):
                logger.info("Login failed: email=%s", email.strip().lower())
                self._send_error(401, "Invalid credentials")
                return

            logger.info("Login success: email=%s", email.strip().lower())

            token = issue_auth_token(email.strip().lower())
            self._send_json(200, {"success": True, "token": token})
            return

        # POST /api/auth/request-password-reset
        if path == "/api/auth/request-password-reset":
            logger.info("Password reset request")
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                data = json.loads(body.decode()) if body else {}
            except Exception as e:
                self._send_error(400, f"Invalid JSON: {str(e)}")
                return

            email = (data.get("email") or "").strip().lower()
            # Always return OK to avoid account enumeration.
            self._send_json(200, {"success": True})

            if not email or not app.user_exists(email):
                return

            reset_token = secrets.token_urlsafe(32)
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            if not app.create_password_reset(email, reset_token, expires_at):
                return

            logger.info("Password reset token created: email=%s", email)

            try:
                app_name = os.environ.get("APP_NAME", "LocalReader")
                subject = f"{app_name} password reset"
                body = (
                    f"You requested a password reset for {app_name}.\n\n"
                    f"Reset code: {reset_token}\n\n"
                    f"This code expires in 1 hour. If you did not request this, you can ignore this email.\n"
                )
                _send_email_smtp(email, subject, body)
            except Exception as e:
                # Log but do not leak details to the client.
                logger.warning("Failed to send reset email: email=%s err=%s", email, e)
            return

        # POST /api/auth/reset-password
        if path == "/api/auth/reset-password":
            logger.info("Password reset attempt")
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                data = json.loads(body.decode()) if body else {}
            except Exception as e:
                self._send_error(400, f"Invalid JSON: {str(e)}")
                return

            email = (data.get("email") or "").strip().lower()
            token = (data.get("token") or "").strip()
            new_password = data.get("newPassword") or ""

            if not email or not token or not new_password:
                self._send_error(400, "Missing 'email', 'token', or 'newPassword'")
                return
            if len(new_password) < 8:
                self._send_error(400, "Password must be at least 8 characters")
                return

            if not app.consume_password_reset(email, token):
                logger.info("Password reset failed: email=%s reason=invalid_or_expired", email)
                self._send_error(400, "Invalid or expired reset token")
                return

            if not app.set_user_password(email, new_password):
                logger.warning("Password reset failed: email=%s reason=db_update_failed", email)
                self._send_error(400, "Failed to set password")
                return

            logger.info("Password reset success: email=%s", email)

            token_auth = issue_auth_token(email)
            self._send_json(200, {"success": True, "token": token_auth})
            return

        # All non-auth routes below require auth
        user_email = self._require_auth()
        if not user_email:
            return

        # POST /api/translate
        if path == "/api/translate":
            logger.info("Translate request: owner=%s", user_email)
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                data = json.loads(body.decode()) if body else {}
            except Exception as e:
                self._send_error(400, f"Invalid JSON: {str(e)}")
                return

            text = (data.get("text") or "").strip()
            target = (data.get("target") or os.environ.get("TRANSLATE_TARGET_LANG") or "pt").strip()

            if not text:
                self._send_error(400, "Missing 'text' field")
                return

            # Basic safety/size cap (Google Translate web endpoints are not designed for huge payloads)
            if len(text) > 5000:
                self._send_error(413, "Text too long (max 5000 chars)")
                return

            try:
                from googletrans import Translator

                async def _do_translate():
                    translator = Translator()
                    maybe_result = translator.translate(text, dest=target)
                    if inspect.isawaitable(maybe_result):
                        return await maybe_result
                    return maybe_result

                result = asyncio.run(_do_translate())

                translated = getattr(result, "text", "")
                detected = getattr(result, "src", None)
                self._send_json(
                    200,
                    {
                        "translatedText": translated,
                        "detectedSource": detected,
                        "target": target,
                    },
                )
                return
            except ImportError:
                self._send_error(
                    501,
                    "Translation support not installed on server. Install googletrans (googletrans==4.0.0-rc1).",
                )
                return
            except Exception as e:
                logger.exception("Translation failed: owner=%s", user_email)
                self._send_error(500, f"Translation failed: {str(e)}")
                return
        
        # POST /api/files
        if path == "/api/files":
            logger.info("Upload attempt: owner=%s", user_email)
            try:
                content_type = self.headers.get("Content-Type", "")

                if not content_type.startswith("multipart/form-data"):
                    self._send_error(400, "Expected multipart/form-data")
                    return

                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b""
                fields, files = _parse_multipart_form_data(content_type, body)

                file_id = (fields.get("file_id") or "").strip()
                title = (fields.get("title") or "").strip()
                format_type = (fields.get("format") or "").strip()
                voice = (fields.get("voice") or "").strip() or None

                file_data = None
                file_part = files.get("file")
                if file_part:
                    file_data = file_part.get("content")

                logger.info(
                    "Upload received: owner=%s file_id=%s format=%s bytes=%d",
                    user_email,
                    file_id,
                    format_type,
                    (len(file_data) if file_data else 0),
                )
                
                if not all([file_id, title, format_type, file_data]):
                    self._send_error(400, "Missing required fields: file_id, title, format, file")
                    return
                
                try:
                    result_id = app.add_file_with_id(
                        file_id,
                        title,
                        file_data,
                        format_type,
                        voice,
                        owner_email=user_email,
                    )
                except app.FileDeletedError:
                    logger.info("Upload rejected (tombstoned): owner=%s file_id=%s", user_email, file_id)
                    self._send_json(410, {"error": "File is marked deleted on server", "deleted": True})
                    return

                logger.info("Upload stored: owner=%s file_id=%s", user_email, result_id)
                
                self._send_json(201, {
                    "success": True,
                    "file_id": result_id,
                    "message": "File uploaded successfully"
                })
                return
                
            except Exception as e:
                logger.exception("Upload failed: owner=%s", user_email)
                self._send_error(500, f"Upload failed: {str(e)}")
                return
        
        self._send_error(404, "Not found")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        user_email = self._require_auth()
        if not user_email:
            return

        # DELETE /api/files/{file_id}
        match = re.match(r'^/api/files/(.+)$', path)
        if match:
            file_id = unquote(match.group(1))
            logger.info("Delete request: owner=%s file_id=%s", user_email, file_id)

            ok = app.mark_file_deleted(file_id, owner_email=user_email)
            if ok:
                self._send_json(200, {"success": True, "deleted": True})
            else:
                self._send_error(400, "Invalid file id")
            return

        self._send_error(404, "Not found")
    
    def do_PUT(self):
        """Handle PUT requests."""
        parsed = urlparse(self.path)
        path = parsed.path

        user_email = self._require_auth()
        if not user_email:
            return
        
        # Read request body
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode()) if body else {}
        except Exception as e:
            self._send_error(400, f"Invalid JSON: {str(e)}")
            return
        
        # PUT /api/files/{file_id}/position
        match = re.match(r'^/api/files/(.+)/position$', path)
        if match:
            file_id = unquote(match.group(1))
            position = data.get("position")

            logger.info(
                "Update position: owner=%s file_id=%s has_position=%s",
                user_email,
                file_id,
                position is not None,
            )
            
            if position is None:
                self._send_error(400, "Missing 'position' field")
                return
            
            success = app.update_position_by_file_id(file_id, str(position), owner_email=user_email)
            
            if success:
                self._send_json(200, {"success": True, "message": "Position updated"})
            else:
                self._send_error(404, "File not found")
            return
        
        # PUT /api/files/{file_id}/voice
        match = re.match(r'^/api/files/(.+)/voice$', path)
        if match:
            file_id = unquote(match.group(1))
            voice = data.get("voice")

            logger.info(
                "Update voice: owner=%s file_id=%s has_voice=%s",
                user_email,
                file_id,
                bool(voice),
            )
            
            if not voice:
                self._send_error(400, "Missing 'voice' field")
                return
            
            success = app.update_voice_by_file_id(file_id, voice, owner_email=user_email)
            
            if success:
                self._send_json(200, {"success": True, "message": "Voice updated"})
            else:
                self._send_error(404, "File not found")
            return
        
        # PUT /api/files/{file_id}/highlights
        match = re.match(r'^/api/files/(.+)/highlights$', path)
        if match:
            file_id = unquote(match.group(1))
            highlights = data.get("highlights")

            logger.info(
                "Update highlights: owner=%s file_id=%s count=%d",
                user_email,
                file_id,
                (len(highlights) if isinstance(highlights, list) else 0),
            )
            
            if not isinstance(highlights, list):
                self._send_error(400, "Missing or invalid 'highlights' field")
                return
            
            count = app.update_highlights(file_id, highlights, owner_email=user_email)
            logger.info("Highlights updated: owner=%s file_id=%s written=%d", user_email, file_id, count)
            
            self._send_json(200, {
                "success": True,
                "message": f"Updated {count} highlights"
            })
            return
        
        self._send_error(404, "Not found")
    
    # NOTE: multipart parsing is handled by email.parser (stdlib) for correctness with binary files.
    
    def log_message(self, format, *args):
        """Log requests to stdout."""
        logger.info("HTTP: %s", format % args)


def main():
    # Initialize database
    app.init_db()
    logger.info("Database initialized at %s", app.DB_PATH)
    
    # Start server
    server = HTTPServer((HOST, PORT), APIHandler)
    logger.info("Server running on http://%s:%s", HOST, PORT)
    logger.info("CORS allowed origins: %s", ",".join([o.strip() for o in APIHandler.ALLOWED_ORIGINS if o.strip()]))
    logger.debug("API endpoints: GET /api/files, GET /api/files/{file_id}, GET /api/files/{file_id}/download, GET /api/files/{file_id}/highlights")
    logger.debug("API endpoints: POST /api/files, DELETE /api/files/{file_id}, PUT /api/files/{file_id}/position|voice|highlights")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down server...")
        server.shutdown()


if __name__ == "__main__":
    main()
