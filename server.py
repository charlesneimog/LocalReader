#!/usr/bin/env python3
import json
import re
import os
import asyncio
import inspect
import cgi
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
import app

HOST = "0.0.0.0"
PORT = 8000


class APIHandler(BaseHTTPRequestHandler):
    # Read allowed origins from environment variable, fallback to defaults
    ALLOWED_ORIGINS = os.environ.get(
        "ALLOWED_ORIGINS",
        "http://127.0.0.1:8080,https://charlesneimog.github.io,http://localhost:8080"
    ).split(",")
    
    def _set_cors_headers(self):
        """Set CORS headers to allow browser requests."""
        origin = self.headers.get("Origin", "")
        
        # Check if origin is allowed
        allowed = False
        for allowed_origin in self.ALLOWED_ORIGINS:
            if origin.startswith(allowed_origin):
                allowed = True
                break
        
        if allowed:
            self.send_header("Access-Control-Allow-Origin", origin)
        else:
            self.send_header("Access-Control-Allow-Origin", self.ALLOWED_ORIGINS[0])
        
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Credentials", "true")
    
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
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()
    
    def do_GET(self):
        """Handle GET requests."""
        parsed = urlparse(self.path)
        path = parsed.path
        
        print(f"[GET] Received path: {path}")
        
        # GET /api/ping - Simple health check
        if path == "/api/ping":
            self._send_json(200, {"status": "ok", "message": "Server is running"})
            return
        
        # GET /api/files - List all files
        if path == "/api/files":
            files = app.get_files()
            print(f"[GET] Listing {len(files)} files")
            self._send_json(200, {"files": files})
            return
        
        # GET /api/files/{file_id}/download
        match = re.match(r'^/api/files/(.+)/download$', path)
        if match:
            file_id = unquote(match.group(1))
            print(f"[GET] Downloading file_id: {file_id}")
            
            file_data = app.get_file_blob(file_id)
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
                print(f"[GET] Downloaded {len(file_data)} bytes as {filename}")
            else:
                self._send_error(404, "File not found")
            return
        
        # GET /api/files/{file_id}/highlights
        match = re.match(r'^/api/files/(.+)/highlights$', path)
        if match:
            file_id = unquote(match.group(1))
            print(f"[GET] Getting highlights for file_id: {file_id}")
            
            highlights = app.get_highlights(file_id)
            if highlights is not None:
                self._send_json(200, {"highlights": highlights})
            else:
                self._send_json(200, {"highlights": []})
            return
        
        # GET /api/files/{file_id}
        match = re.match(r'^/api/files/(.+)$', path)
        if match:
            file_id = unquote(match.group(1))
            print(f"[GET] Checking file_id: {file_id}")
            
            # Get file metadata
            file_data = app.get_file_data(file_id)
            if file_data:
                print(f"[GET] File exists: {file_id}")
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
                print(f"[GET] File NOT found: {file_id}")
                self._send_json(404, {"exists": False, "file_id": file_id})
            return
        
        self._send_error(404, "Not found")
    
    def do_POST(self):
        """Handle POST requests."""
        parsed = urlparse(self.path)
        path = parsed.path

        # POST /api/translate
        if path == "/api/translate":
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
                self._send_error(500, f"Translation failed: {str(e)}")
                return
        
        # POST /api/files
        if path == "/api/files":
            try:
                content_type = self.headers.get("Content-Type", "")

                if not content_type.startswith("multipart/form-data"):
                    self._send_error(400, "Expected multipart/form-data")
                    return

                # Robust multipart parsing (safe for binary files like EPUB/PDF)
                form = cgi.FieldStorage(
                    fp=self.rfile,
                    headers=self.headers,
                    environ={
                        "REQUEST_METHOD": "POST",
                        "CONTENT_TYPE": content_type,
                        "CONTENT_LENGTH": self.headers.get("Content-Length", "0"),
                    },
                )

                file_id = form.getfirst("file_id")
                title = form.getfirst("title")
                format_type = form.getfirst("format")
                voice = form.getfirst("voice")

                file_item = form["file"] if "file" in form else None
                file_data = None
                if file_item is not None and getattr(file_item, "file", None) is not None:
                    file_data = file_item.file.read()
                
                print(f"[POST] Uploading file_id: {file_id}")
                print(f"[POST] Title: {title}")
                print(f"[POST] Format: {format_type}")
                print(f"[POST] File size: {len(file_data) if file_data else 0} bytes")
                
                if not all([file_id, title, format_type, file_data]):
                    self._send_error(400, "Missing required fields: file_id, title, format, file")
                    return
                
                result_id = app.add_file_with_id(file_id, title, file_data, format_type, voice)
                
                print(f"[POST] File saved with id: {result_id}")
                print(f"[POST] Verifying file exists: {app.file_exists(result_id)}")
                
                self._send_json(201, {
                    "success": True,
                    "file_id": result_id,
                    "message": "File uploaded successfully"
                })
                return
                
            except Exception as e:
                self._send_error(500, f"Upload failed: {str(e)}")
                return
        
        self._send_error(404, "Not found")
    
    def do_PUT(self):
        """Handle PUT requests."""
        parsed = urlparse(self.path)
        path = parsed.path
        
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
            
            print(f"[PUT] Updating position for file_id: {file_id}")
            print(f"[PUT] Position: {position}")
            print(f"[PUT] File exists: {app.file_exists(file_id)}")
            
            if position is None:
                self._send_error(400, "Missing 'position' field")
                return
            
            success = app.update_position_by_file_id(file_id, str(position))
            
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
            
            print(f"[PUT] Updating voice for file_id: {file_id}")
            print(f"[PUT] Voice: {voice}")
            print(f"[PUT] File exists: {app.file_exists(file_id)}")
            
            if not voice:
                self._send_error(400, "Missing 'voice' field")
                return
            
            success = app.update_voice_by_file_id(file_id, voice)
            
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
            
            print(f"[PUT] Updating highlights for file_id: {file_id}")
            print(f"[PUT] Highlights count: {len(highlights) if isinstance(highlights, list) else 0}")
            print(f"[PUT] File exists: {app.file_exists(file_id)}")
            
            if not isinstance(highlights, list):
                self._send_error(400, "Missing or invalid 'highlights' field")
                return
            
            count = app.update_highlights(file_id, highlights)
            print(f"[PUT] Updated highlights written: {count}")
            
            self._send_json(200, {
                "success": True,
                "message": f"Updated {count} highlights"
            })
            return
        
        self._send_error(404, "Not found")
    
    # NOTE: multipart parsing is handled by cgi.FieldStorage for correctness with binary files.
    
    def log_message(self, format, *args):
        """Log requests to stdout."""
        print(f"[{self.log_date_time_string()}] {format % args}")


def main():
    # Initialize database
    app.init_db()
    print(f"Database initialized at {app.DB_PATH}")
    
    # Start server
    server = HTTPServer((HOST, PORT), APIHandler)
    print(f"Server running on http://{HOST}:{PORT}")
    print(f"API endpoints:")
    print(f"  GET  /api/files")
    print(f"  GET  /api/files/{{file_id}}")
    print(f"  GET  /api/files/{{file_id}}/download")
    print(f"  GET  /api/files/{{file_id}}/highlights")
    print(f"  POST /api/files")
    print(f"  PUT  /api/files/{{file_id}}/position")
    print(f"  PUT  /api/files/{{file_id}}/voice")
    print(f"  PUT  /api/files/{{file_id}}/highlights")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.shutdown()


if __name__ == "__main__":
    main()
