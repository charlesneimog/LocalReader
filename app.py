import sqlite3
from datetime import datetime
import os
import time
import hashlib
import hmac
import secrets
import logging

DB_PATH = "data/database.db"

logger = logging.getLogger("localreader.app")


class FileDeletedError(RuntimeError):
    pass


def _extract_actual_filename(file_id: str) -> str:
    if not isinstance(file_id, str):
        return ""
    if not file_id.startswith("file::"):
        return file_id
    parts = file_id.split("::")
    return parts[1] if len(parts) >= 2 else file_id


def init_db():
    """Initialize database and create tables if they don't exist."""
    # Ensure the data directory exists
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    logger.info("init_db: path=%s", DB_PATH)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    cursor = conn.cursor()
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            filename TEXT NOT NULL,
            format TEXT NOT NULL,
            file_data BLOB NOT NULL,
            reading_position TEXT,
            voice TEXT,
            created_at TEXT NOT NULL
        )
    """)
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS highlights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id TEXT NOT NULL,
            sentence_index INTEGER NOT NULL,
            color TEXT NOT NULL,
            text TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(file_id, sentence_index)
        )
    """)

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(email, token_hash)
        )
        """
    )
    
    conn.commit()

    # Lightweight schema migrations for older DBs
    def _ensure_column(table_name: str, column_name: str, column_def: str):
        cursor.execute(f"PRAGMA table_info({table_name})")
        cols = {row[1] for row in cursor.fetchall()}  # row[1] is column name
        if column_name not in cols:
            logger.info("Schema migration: add column %s.%s", table_name, column_name)
            cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_def}")

    _ensure_column("files", "updated_at", "TEXT")
    _ensure_column("files", "position_updated_at", "TEXT")
    _ensure_column("files", "highlights_updated_at", "TEXT")
    _ensure_column("files", "voice_updated_at", "TEXT")
    _ensure_column("files", "owner_email", "TEXT")
    _ensure_column("files", "actual_filename", "TEXT")

    _ensure_column("highlights", "owner_email", "TEXT")

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS deleted_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_email TEXT NOT NULL,
            actual_filename TEXT NOT NULL,
            deleted_at TEXT NOT NULL,
            UNIQUE(owner_email, actual_filename)
        )
        """
    )

    # Backfill any NULL timestamps for existing rows
    cursor.execute(
        """
        UPDATE files
        SET
            updated_at = COALESCE(updated_at, created_at),
            position_updated_at = COALESCE(position_updated_at, created_at),
            highlights_updated_at = COALESCE(highlights_updated_at, created_at),
            voice_updated_at = COALESCE(voice_updated_at, created_at)
        WHERE updated_at IS NULL
           OR position_updated_at IS NULL
           OR highlights_updated_at IS NULL
           OR voice_updated_at IS NULL
        """
    )
    # Backfill ownership for older DBs (single-user legacy): keep NULL if unknown.

    # Backfill actual_filename for older rows.
    cursor.execute(
        """
        SELECT id, filename
        FROM files
        WHERE actual_filename IS NULL
        """
    )
    rows = cursor.fetchall()
    for file_row_id, filename in rows:
        actual = _extract_actual_filename(filename)
        cursor.execute(
            "UPDATE files SET actual_filename = ? WHERE id = ?",
            (actual, file_row_id),
        )

    conn.commit()
    conn.close()
    logger.info("init_db: done")


def _is_actual_filename_deleted(actual_filename: str, owner_email: str | None) -> bool:
    owner_n = _normalize_email(owner_email) if owner_email else None
    if not owner_n:
        return False
    actual = (actual_filename or "").strip()
    if not actual:
        return False
    with sqlite3.connect(DB_PATH, timeout=30) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT 1 FROM deleted_files WHERE owner_email = ? AND actual_filename = ?",
            (owner_n, actual),
        )
        return cursor.fetchone() is not None


def get_deleted_files(owner_email: str | None = None):
    owner_n = _normalize_email(owner_email) if owner_email else None
    if not owner_n:
        return []
    with sqlite3.connect(DB_PATH, timeout=30) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT actual_filename, deleted_at
            FROM deleted_files
            WHERE owner_email = ?
            ORDER BY deleted_at DESC
            """,
            (owner_n,),
        )
        rows = cursor.fetchall()
    return [dict(r) for r in rows]


def is_file_deleted(file_id: str, owner_email: str | None = None) -> bool:
    owner_n = _normalize_email(owner_email) if owner_email else None
    if not owner_n:
        return False
    actual = _extract_actual_filename((file_id or "").strip())
    return _is_actual_filename_deleted(actual, owner_n)


def mark_file_deleted(file_id: str, owner_email: str | None = None) -> bool:
    owner_n = _normalize_email(owner_email) if owner_email else None
    if not owner_n:
        return False

    target = (file_id or "").strip()
    if not target:
        return False

    actual = _extract_actual_filename(target)
    if not actual:
        return False

    now = datetime.utcnow().isoformat()

    logger.info("mark_file_deleted: owner=%s file_id=%s", owner_n, target)

    for attempt in range(4):
        try:
            with sqlite3.connect(DB_PATH, timeout=30) as conn:
                cursor = conn.cursor()

                # Resolve all stored variants for this document.
                cursor.execute(
                    "SELECT filename FROM files WHERE owner_email = ? AND actual_filename = ?",
                    (owner_n, actual),
                )
                filenames = [r[0] for r in cursor.fetchall()]

                # Delete highlights for each filename variant.
                for fn in filenames:
                    scoped_file_id = f"{owner_n}::{fn}"
                    cursor.execute(
                        "DELETE FROM highlights WHERE owner_email = ? AND file_id = ?",
                        (owner_n, scoped_file_id),
                    )

                # Delete file variants.
                cursor.execute(
                    "DELETE FROM files WHERE owner_email = ? AND actual_filename = ?",
                    (owner_n, actual),
                )

                # Insert/update tombstone.
                cursor.execute(
                    """
                    INSERT INTO deleted_files (owner_email, actual_filename, deleted_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(owner_email, actual_filename)
                    DO UPDATE SET deleted_at = excluded.deleted_at
                    """,
                    (owner_n, actual, now),
                )

            return True
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < 3:
                logger.warning("DB locked on delete (attempt %d): owner=%s actual=%s", attempt + 1, owner_n, actual)
                _sleep_on_lock(attempt)
                continue
            raise


def _normalize_email(email: str) -> str:
    if not isinstance(email, str):
        return ""
    return email.strip().lower()


def _hash_password(password: str, salt_hex: str) -> str:
    """PBKDF2-HMAC-SHA256 password hash.

    Returns hex string.
    """
    salt = bytes.fromhex(salt_hex)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return dk.hex()


def create_user(email: str, password: str) -> bool:
    email_n = _normalize_email(email)
    if not email_n or "@" not in email_n:
        return False
    if not isinstance(password, str) or len(password) < 8:
        return False

    now = datetime.utcnow().isoformat()
    salt_hex = secrets.token_bytes(16).hex()
    pw_hash = _hash_password(password, salt_hex)

    try:
        with sqlite3.connect(DB_PATH, timeout=30) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO users (email, password_hash, password_salt, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (email_n, pw_hash, salt_hex, now, now),
            )
        logger.info("create_user: success email=%s", email_n)
        return True
    except sqlite3.IntegrityError:
        logger.info("create_user: email exists email=%s", email_n)
        return False


def verify_user(email: str, password: str) -> bool:
    email_n = _normalize_email(email)
    if not email_n or not isinstance(password, str):
        return False

    with sqlite3.connect(DB_PATH, timeout=30) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT password_hash, password_salt FROM users WHERE email = ?", (email_n,))
        row = cursor.fetchone()
        if not row:
            logger.info("verify_user: no such user email=%s", email_n)
            return False
        expected_hash, salt_hex = row

    computed = _hash_password(password, salt_hex)
    ok = hmac.compare_digest(computed, expected_hash)
    if ok:
        logger.info("verify_user: success email=%s", email_n)
    else:
        logger.info("verify_user: invalid password email=%s", email_n)
    return ok


def set_user_password(email: str, new_password: str) -> bool:
    email_n = _normalize_email(email)
    if not email_n or not isinstance(new_password, str) or len(new_password) < 8:
        return False

    now = datetime.utcnow().isoformat()
    salt_hex = secrets.token_bytes(16).hex()
    pw_hash = _hash_password(new_password, salt_hex)

    with sqlite3.connect(DB_PATH, timeout=30) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE users
            SET password_hash = ?, password_salt = ?, updated_at = ?
            WHERE email = ?
            """,
            (pw_hash, salt_hex, now, email_n),
        )
        ok = cursor.rowcount > 0
        logger.info("set_user_password: %s email=%s", "success" if ok else "not_found", email_n)
        return ok


def user_exists(email: str) -> bool:
    email_n = _normalize_email(email)
    if not email_n:
        return False
    with sqlite3.connect(DB_PATH, timeout=30) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM users WHERE email = ?", (email_n,))
        return cursor.fetchone() is not None


def create_password_reset(email: str, token_plain: str, expires_at_iso: str) -> bool:
    email_n = _normalize_email(email)
    if not email_n or not token_plain:
        return False
    token_hash = hashlib.sha256(token_plain.encode("utf-8")).hexdigest()
    now = datetime.utcnow().isoformat()

    try:
        with sqlite3.connect(DB_PATH, timeout=30) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO password_resets (email, token_hash, expires_at, used_at, created_at)
                VALUES (?, ?, ?, NULL, ?)
                """,
                (email_n, token_hash, expires_at_iso, now),
            )
        logger.info("create_password_reset: created email=%s", email_n)
        return True
    except sqlite3.IntegrityError:
        logger.info("create_password_reset: duplicate token email=%s", email_n)
        return False


def consume_password_reset(email: str, token_plain: str) -> bool:
    """Mark a reset token as used if valid and unexpired."""
    email_n = _normalize_email(email)
    if not email_n or not token_plain:
        return False

    token_hash = hashlib.sha256(token_plain.encode("utf-8")).hexdigest()
    now = datetime.utcnow().isoformat()

    with sqlite3.connect(DB_PATH, timeout=30) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, expires_at, used_at
            FROM password_resets
            WHERE email = ? AND token_hash = ?
            """,
            (email_n, token_hash),
        )
        row = cursor.fetchone()
        if not row:
            logger.info("consume_password_reset: not_found email=%s", email_n)
            return False

        reset_id, expires_at, used_at = row
        if used_at:
            logger.info("consume_password_reset: already_used email=%s", email_n)
            return False

        # ISO string comparison is safe if both are ISO 8601 UTC from this app.
        if isinstance(expires_at, str) and expires_at < now:
            logger.info("consume_password_reset: expired email=%s", email_n)
            return False

        cursor.execute(
            "UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL",
            (now, reset_id),
        )
        ok = cursor.rowcount > 0
        logger.info("consume_password_reset: %s email=%s", "success" if ok else "failed", email_n)
        return ok


def _sleep_on_lock(attempt: int) -> None:
    # Small exponential backoff to reduce lock contention during rapid sync bursts.
    time.sleep(0.05 * (2**attempt))


def add_file(title, filename, format, voice=None):
    """Add a new file to the database.
    
    Args:
        title: The title of the file
        filename: The name of the file
        format: Either 'pdf' or 'epub'
        voice: Optional voice setting
        
    Returns:
        The ID of the newly created file record
        
    Note:
        This function expects the file to exist at the given filename path.
        The file data will be read and stored as a BLOB in the database.
    """
    with open(filename, 'rb') as f:
        file_data = f.read()
    
    created_at = datetime.utcnow().isoformat()
    updated_at = created_at
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute(
        """
        INSERT INTO files (
            title, filename, format, file_data, reading_position, voice,
            created_at, updated_at, position_updated_at, highlights_updated_at, voice_updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (title, filename, format, file_data, None, voice, created_at, updated_at, updated_at, updated_at, updated_at),
    )
    
    file_id = cursor.lastrowid
    conn.commit()
    conn.close()
    
    return file_id


def update_position(file_id, position):
    """Update the reading position for a file.
    
    Args:
        file_id: The ID of the file to update
        position: The new reading position (string)
        
    Returns:
        True if update was successful, False if file not found
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        UPDATE files
        SET reading_position = ?
        WHERE id = ?
    """, (position, file_id))
    
    rows_affected = cursor.rowcount
    conn.commit()
    conn.close()
    
    return rows_affected > 0


def get_files(owner_email=None):
    """Get all files from the database (without file data).
    
    Returns:
        List of dictionaries containing file information (excluding file_data)
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    owner_n = _normalize_email(owner_email) if owner_email else None
    if owner_n:
        cursor.execute(
            """
            SELECT
                filename, title, format, reading_position, voice,
                created_at,
                COALESCE(updated_at, created_at) AS updated_at,
                COALESCE(position_updated_at, created_at) AS position_updated_at,
                COALESCE(highlights_updated_at, created_at) AS highlights_updated_at,
                COALESCE(voice_updated_at, created_at) AS voice_updated_at
            FROM files
            WHERE owner_email = ?
            ORDER BY created_at DESC
            """,
            (owner_n,),
        )
    else:
        cursor.execute(
            """
            SELECT
                filename, title, format, reading_position, voice,
                created_at,
                COALESCE(updated_at, created_at) AS updated_at,
                COALESCE(position_updated_at, created_at) AS position_updated_at,
                COALESCE(highlights_updated_at, created_at) AS highlights_updated_at,
                COALESCE(voice_updated_at, created_at) AS voice_updated_at
            FROM files
            ORDER BY created_at DESC
            """
        )
    
    rows = cursor.fetchall()
    conn.close()
    
    files = [dict(row) for row in rows]
    logger.info("get_files: owner=%s count=%d", owner_n or "*", len(files))
    return files


def get_file_blob(file_id, owner_email=None):
    """Get the file blob data for a specific file by file_id.
    
    Args:
        file_id: The file identifier (filename)
        
    Returns:
        Binary file data or None if not found
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    owner_n = _normalize_email(owner_email) if owner_email else None
    if owner_n:
        cursor.execute(
            """
            SELECT file_data
            FROM files
            WHERE filename = ? AND owner_email = ?
            """,
            (file_id, owner_n),
        )
    else:
        cursor.execute(
            """
            SELECT file_data
            FROM files
            WHERE filename = ?
            """,
            (file_id,),
        )
    
    row = cursor.fetchone()
    conn.close()
    logger.info("get_file_blob: owner=%s file_id=%s hit=%s", owner_n or "*", file_id, bool(row))
    return row[0] if row else None


def get_file_data(file_id, owner_email=None):
    """Get file metadata by filename (file_id).

    Args:
        file_id: The file identifier (filename)

    Returns:
        Dict-like row with metadata, or None.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    owner_n = _normalize_email(owner_email) if owner_email else None
    if owner_n:
        cursor.execute(
            """
            SELECT
                filename, title, format, reading_position, voice,
                created_at,
                COALESCE(updated_at, created_at) AS updated_at,
                COALESCE(position_updated_at, created_at) AS position_updated_at,
                COALESCE(highlights_updated_at, created_at) AS highlights_updated_at,
                COALESCE(voice_updated_at, created_at) AS voice_updated_at
            FROM files
            WHERE filename = ? AND owner_email = ?
            """,
            (file_id, owner_n),
        )
    else:
        cursor.execute(
            """
            SELECT
                filename, title, format, reading_position, voice,
                created_at,
                COALESCE(updated_at, created_at) AS updated_at,
                COALESCE(position_updated_at, created_at) AS position_updated_at,
                COALESCE(highlights_updated_at, created_at) AS highlights_updated_at,
                COALESCE(voice_updated_at, created_at) AS voice_updated_at
            FROM files
            WHERE filename = ?
            """,
            (file_id,),
        )

    row = cursor.fetchone()
    conn.close()
    logger.debug("get_file_data: owner=%s file_id=%s hit=%s", owner_n or "*", file_id, bool(row))
    return dict(row) if row else None


def file_exists(file_id, owner_email=None):
    """Check if a file exists by file_id (filename).
    
    Args:
        file_id: The file identifier (filename)
        
    Returns:
        True if file exists, False otherwise
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    owner_n = _normalize_email(owner_email) if owner_email else None
    if owner_n:
        cursor.execute(
            """SELECT COUNT(*) FROM files WHERE filename = ? AND owner_email = ?""",
            (file_id, owner_n),
        )
    else:
        cursor.execute(
            """SELECT COUNT(*) FROM files WHERE filename = ?""",
            (file_id,),
        )
    
    count = cursor.fetchone()[0]
    conn.close()
    logger.debug("file_exists: owner=%s file_id=%s exists=%s", owner_n or "*", file_id, count > 0)
    return count > 0


def add_file_with_id(file_id, title, file_data, format, voice=None, owner_email=None):
    """Add or update a file in the database.
    
    Args:
        file_id: The file identifier (filename)
        title: The title of the file
        file_data: The binary file data
        format: Either 'pdf' or 'epub'
        voice: Optional voice setting
        
    Returns:
        The filename (file_id)
    """
    created_at = datetime.utcnow().isoformat()
    updated_at = created_at

    owner_n = _normalize_email(owner_email) if owner_email else None
    actual_filename = _extract_actual_filename(file_id)

    if owner_n and _is_actual_filename_deleted(actual_filename, owner_n):
        logger.info("add_file_with_id: rejected (tombstoned) owner=%s actual=%s", owner_n, actual_filename)
        raise FileDeletedError("File is marked deleted")

    logger.info(
        "add_file_with_id: owner=%s file_id=%s actual=%s bytes=%d format=%s",
        owner_n or "*",
        file_id,
        actual_filename,
        (len(file_data) if file_data else 0),
        format,
    )
    
    for attempt in range(4):
        try:
            with sqlite3.connect(DB_PATH, timeout=30) as conn:
                cursor = conn.cursor()

                # Check if file already exists

                if owner_n:
                    cursor.execute("SELECT id FROM files WHERE filename = ? AND owner_email = ?", (file_id, owner_n))
                else:
                    cursor.execute("SELECT id FROM files WHERE filename = ?", (file_id,))
                existing = cursor.fetchone()

                if existing:
                    logger.info("add_file_with_id: update owner=%s file_id=%s", owner_n or "*", file_id)
                    # Update existing file
                    if owner_n:
                        cursor.execute(
                            """
                            UPDATE files
                            SET
                                title = ?,
                                file_data = ?,
                                format = ?,
                                actual_filename = ?,
                                voice = COALESCE(?, voice),
                                updated_at = ?,
                                voice_updated_at = CASE WHEN ? IS NOT NULL THEN ? ELSE voice_updated_at END
                            WHERE filename = ? AND owner_email = ?
                            """,
                            (title, file_data, format, actual_filename, voice, updated_at, voice, updated_at, file_id, owner_n),
                        )
                    else:
                        cursor.execute(
                        """
                        UPDATE files
                        SET
                            title = ?,
                            file_data = ?,
                            format = ?,
                            actual_filename = ?,
                            voice = COALESCE(?, voice),
                            updated_at = ?,
                            voice_updated_at = CASE WHEN ? IS NOT NULL THEN ? ELSE voice_updated_at END
                        WHERE filename = ?
                        """,
                        (title, file_data, format, actual_filename, voice, updated_at, voice, updated_at, file_id),
                    )
                else:
                    logger.info("add_file_with_id: insert owner=%s file_id=%s", owner_n or "*", file_id)
                    # Insert new file
                    cursor.execute(
                        """
                        INSERT INTO files (
                            title, filename, format, file_data, reading_position, voice,
                            created_at, updated_at, position_updated_at, highlights_updated_at, voice_updated_at,
                            owner_email, actual_filename
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            title,
                            file_id,
                            format,
                            file_data,
                            None,
                            voice,
                            created_at,
                            updated_at,
                            updated_at,
                            updated_at,
                            updated_at,
                            owner_n,
                            actual_filename,
                        ),
                    )

            break
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < 3:
                logger.warning("DB locked on upsert (attempt %d): owner=%s file_id=%s", attempt + 1, owner_n or "*", file_id)
                _sleep_on_lock(attempt)
                continue
            raise
    
    return file_id


def update_position_by_file_id(file_id, position, owner_email=None):
    """Update the reading position for a file by file_id.
    
    Args:
        file_id: The file identifier (filename)
        position: The new reading position (string)
        
    Returns:
        True if update was successful, False if file not found
    """
    now = datetime.utcnow().isoformat()

    for attempt in range(4):
        try:
            with sqlite3.connect(DB_PATH, timeout=30) as conn:
                cursor = conn.cursor()
                owner_n = _normalize_email(owner_email) if owner_email else None
                if owner_n:
                    cursor.execute(
                        """
                        UPDATE files
                        SET reading_position = ?, updated_at = ?, position_updated_at = ?
                        WHERE filename = ? AND owner_email = ?
                        """,
                        (position, now, now, file_id, owner_n),
                    )
                else:
                    cursor.execute(
                        """
                        UPDATE files
                        SET reading_position = ?, updated_at = ?, position_updated_at = ?
                        WHERE filename = ?
                        """,
                        (position, now, now, file_id),
                    )
                rows_affected = cursor.rowcount
            ok = rows_affected > 0
            logger.info("update_position: owner=%s file_id=%s ok=%s", owner_n or "*", file_id, ok)
            return ok
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < 3:
                logger.warning("DB locked on update_position (attempt %d): owner=%s file_id=%s", attempt + 1, owner_n or "*", file_id)
                _sleep_on_lock(attempt)
                continue
            raise


def update_voice_by_file_id(file_id, voice, owner_email=None):
    """Update the voice for a file by file_id.
    
    Args:
        file_id: The file identifier (filename)
        voice: The voice setting
        
    Returns:
        True if update was successful, False if file not found
    """
    now = datetime.utcnow().isoformat()

    for attempt in range(4):
        try:
            with sqlite3.connect(DB_PATH, timeout=30) as conn:
                cursor = conn.cursor()
                owner_n = _normalize_email(owner_email) if owner_email else None
                if owner_n:
                    cursor.execute(
                        """
                        UPDATE files
                        SET voice = ?, updated_at = ?, voice_updated_at = ?
                        WHERE filename = ? AND owner_email = ?
                        """,
                        (voice, now, now, file_id, owner_n),
                    )
                else:
                    cursor.execute(
                        """
                        UPDATE files
                        SET voice = ?, updated_at = ?, voice_updated_at = ?
                        WHERE filename = ?
                        """,
                        (voice, now, now, file_id),
                    )
                rows_affected = cursor.rowcount
            ok = rows_affected > 0
            logger.info("update_voice: owner=%s file_id=%s ok=%s", owner_n or "*", file_id, ok)
            return ok
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < 3:
                logger.warning("DB locked on update_voice (attempt %d): owner=%s file_id=%s", attempt + 1, owner_n or "*", file_id)
                _sleep_on_lock(attempt)
                continue
            raise


def update_highlights(file_id, highlights, owner_email=None):
    """Update highlights for a file.
    
    Args:
        file_id: The file identifier (filename)
        highlights: List of dicts with sentenceIndex, color, text
        
    Returns:
        Number of highlights updated
    """
    created_at = datetime.utcnow().isoformat()

    def _coerce_sentence_index(h):
        if not isinstance(h, dict):
            return None
        idx = h.get("sentenceIndex")
        if idx is None:
            idx = h.get("sentence_index")
        if idx is None:
            return None
        try:
            return int(idx)
        except (TypeError, ValueError):
            return None

    for attempt in range(4):
        try:
            with sqlite3.connect(DB_PATH, timeout=30) as conn:
                cursor = conn.cursor()

                owner_n = _normalize_email(owner_email) if owner_email else None
                scoped_file_id = f"{owner_n}::{file_id}" if owner_n else file_id

                # Clear existing highlights for this file
                if owner_n:
                    cursor.execute(
                        "DELETE FROM highlights WHERE file_id = ? AND owner_email = ?",
                        (scoped_file_id, owner_n),
                    )
                else:
                    cursor.execute("DELETE FROM highlights WHERE file_id = ?", (scoped_file_id,))

                count = 0
                if highlights:
                    for highlight in highlights:
                        sentence_index = _coerce_sentence_index(highlight)
                        if sentence_index is None:
                            continue

                        color = "#ffda76"
                        text = ""
                        if isinstance(highlight, dict):
                            color = highlight.get("color", color)
                            text = highlight.get("text", text)

                        cursor.execute(
                            """
                            INSERT INTO highlights (file_id, sentence_index, color, text, created_at, owner_email)
                            VALUES (?, ?, ?, ?, ?, ?)
                            """,
                            (scoped_file_id, sentence_index, color, text, created_at, owner_n),
                        )
                        count += 1

                # Touch file timestamps for highlight sync
                if owner_n:
                    cursor.execute(
                        """
                        UPDATE files
                        SET updated_at = ?, highlights_updated_at = ?
                        WHERE filename = ? AND owner_email = ?
                        """,
                        (created_at, created_at, file_id, owner_n),
                    )
                else:
                    cursor.execute(
                        """
                        UPDATE files
                        SET updated_at = ?, highlights_updated_at = ?
                        WHERE filename = ?
                        """,
                        (created_at, created_at, file_id),
                    )

            return count
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < 3:
                owner_n = _normalize_email(owner_email) if owner_email else None
                logger.warning("DB locked on update_highlights (attempt %d): owner=%s file_id=%s", attempt + 1, owner_n or "*", file_id)
                _sleep_on_lock(attempt)
                continue
            raise


def get_highlights(file_id, owner_email=None):
    """Get highlights for a file.
    
    Args:
        file_id: The file identifier (filename)
        
    Returns:
        List of highlight dictionaries
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    owner_n = _normalize_email(owner_email) if owner_email else None
    scoped_file_id = f"{owner_n}::{file_id}" if owner_n else file_id
    if owner_n:
        cursor.execute(
            """
            SELECT sentence_index, color, text
            FROM highlights
            WHERE file_id = ? AND owner_email = ?
            ORDER BY sentence_index
            """,
            (scoped_file_id, owner_n),
        )
    else:
        cursor.execute(
            """
            SELECT sentence_index, color, text
            FROM highlights
            WHERE file_id = ?
            ORDER BY sentence_index
            """,
            (scoped_file_id,),
        )
    
    rows = cursor.fetchall()
    conn.close()

    out = [dict(row) for row in rows]
    logger.info("get_highlights: owner=%s file_id=%s count=%d", owner_n or "*", file_id, len(out))
    return out


if __name__ == "__main__":
    log_level = os.environ.get("LOG_LEVEL", "INFO").strip().upper()
    logging.basicConfig(
        level=getattr(logging, log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    init_db()
    print("Database initialized successfully")
