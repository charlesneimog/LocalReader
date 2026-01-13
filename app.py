import sqlite3
from datetime import datetime
import os
import time

DB_PATH = "data/database.db"


def init_db():
    """Initialize database and create tables if they don't exist."""
    # Ensure the data directory exists
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
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
    
    conn.commit()

    # Lightweight schema migrations for older DBs
    def _ensure_column(table_name: str, column_name: str, column_def: str):
        cursor.execute(f"PRAGMA table_info({table_name})")
        cols = {row[1] for row in cursor.fetchall()}  # row[1] is column name
        if column_name not in cols:
            cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_def}")

    _ensure_column("files", "updated_at", "TEXT")
    _ensure_column("files", "position_updated_at", "TEXT")
    _ensure_column("files", "highlights_updated_at", "TEXT")
    _ensure_column("files", "voice_updated_at", "TEXT")

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
    conn.commit()
    conn.close()


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


def get_files():
    """Get all files from the database (without file data).
    
    Returns:
        List of dictionaries containing file information (excluding file_data)
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
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
    return files


def get_file_blob(file_id):
    """Get the file blob data for a specific file by file_id.
    
    Args:
        file_id: The file identifier (filename)
        
    Returns:
        Binary file data or None if not found
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT file_data
        FROM files
        WHERE filename = ?
    """, (file_id,))
    
    row = cursor.fetchone()
    conn.close()
    
    return row[0] if row else None


def get_file_data(file_id):
    """Get file metadata by filename (file_id).

    Args:
        file_id: The file identifier (filename)

    Returns:
        Dict-like row with metadata, or None.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

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
    return dict(row) if row else None


def file_exists(file_id):
    """Check if a file exists by file_id (filename).
    
    Args:
        file_id: The file identifier (filename)
        
    Returns:
        True if file exists, False otherwise
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT COUNT(*) FROM files WHERE filename = ?
    """, (file_id,))
    
    count = cursor.fetchone()[0]
    conn.close()
    
    return count > 0


def add_file_with_id(file_id, title, file_data, format, voice=None):
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
    
    for attempt in range(4):
        try:
            with sqlite3.connect(DB_PATH, timeout=30) as conn:
                cursor = conn.cursor()

                # Check if file already exists
                cursor.execute("SELECT id FROM files WHERE filename = ?", (file_id,))
                existing = cursor.fetchone()

                if existing:
                    # Update existing file
                    cursor.execute(
                        """
                        UPDATE files
                        SET
                            title = ?,
                            file_data = ?,
                            format = ?,
                            voice = COALESCE(?, voice),
                            updated_at = ?,
                            voice_updated_at = CASE WHEN ? IS NOT NULL THEN ? ELSE voice_updated_at END
                        WHERE filename = ?
                        """,
                        (title, file_data, format, voice, updated_at, voice, updated_at, file_id),
                    )
                else:
                    # Insert new file
                    cursor.execute(
                        """
                        INSERT INTO files (
                            title, filename, format, file_data, reading_position, voice,
                            created_at, updated_at, position_updated_at, highlights_updated_at, voice_updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        ),
                    )

            break
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < 3:
                _sleep_on_lock(attempt)
                continue
            raise
    
    return file_id


def update_position_by_file_id(file_id, position):
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
                cursor.execute(
                    """
                    UPDATE files
                    SET reading_position = ?, updated_at = ?, position_updated_at = ?
                    WHERE filename = ?
                    """,
                    (position, now, now, file_id),
                )
                rows_affected = cursor.rowcount
            return rows_affected > 0
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < 3:
                _sleep_on_lock(attempt)
                continue
            raise


def update_voice_by_file_id(file_id, voice):
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
                cursor.execute(
                    """
                    UPDATE files
                    SET voice = ?, updated_at = ?, voice_updated_at = ?
                    WHERE filename = ?
                    """,
                    (voice, now, now, file_id),
                )
                rows_affected = cursor.rowcount
            return rows_affected > 0
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() and attempt < 3:
                _sleep_on_lock(attempt)
                continue
            raise


def update_highlights(file_id, highlights):
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

                # Clear existing highlights for this file
                cursor.execute("DELETE FROM highlights WHERE file_id = ?", (file_id,))

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
                            INSERT INTO highlights (file_id, sentence_index, color, text, created_at)
                            VALUES (?, ?, ?, ?, ?)
                            """,
                            (file_id, sentence_index, color, text, created_at),
                        )
                        count += 1

                # Touch file timestamps for highlight sync
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
                _sleep_on_lock(attempt)
                continue
            raise


def get_highlights(file_id):
    """Get highlights for a file.
    
    Args:
        file_id: The file identifier (filename)
        
    Returns:
        List of highlight dictionaries
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT sentence_index, color, text
        FROM highlights
        WHERE file_id = ?
        ORDER BY sentence_index
    """, (file_id,))
    
    rows = cursor.fetchall()
    conn.close()
    
    return [dict(row) for row in rows]


if __name__ == "__main__":
    init_db()
    print("Database initialized successfully")
