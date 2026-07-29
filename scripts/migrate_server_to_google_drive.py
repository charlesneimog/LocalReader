#!/usr/bin/env python3
"""Export a PocketReader server database as documents and Drive-model JSON."""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export PocketReader PDFs and metadata JSON from database.db.",
    )
    parser.add_argument(
        "database",
        nargs="?",
        type=Path,
        default=Path("data/database.db"),
        help="SQLite database path (default: data/database.db)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("google-drive-export"),
        help="Output directory (default: google-drive-export)",
    )
    owner = parser.add_mutually_exclusive_group()
    owner.add_argument("--owner", help="Export only this owner email")
    owner.add_argument(
        "--legacy",
        action="store_true",
        help="Export old rows whose owner_email is NULL",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace files already present in the output directory",
    )
    return parser.parse_args()


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}


def select_owners(
    connection: sqlite3.Connection,
    columns: set[str],
    requested: str | None,
    legacy: bool,
) -> list[str | None]:
    if "owner_email" not in columns:
        return [None]

    owners = [row[0] for row in connection.execute("SELECT DISTINCT owner_email FROM files")]
    if requested:
        normalized = requested.strip().lower()
        known = {str(owner).strip().lower() for owner in owners if owner is not None}
        if normalized not in known:
            raise ValueError(f"No files found for owner {requested!r}")
        return [normalized]
    if legacy:
        if None not in owners:
            raise ValueError("No legacy files with a NULL owner_email were found")
        return [None]
    if not owners:
        raise ValueError("The database contains no files")
    return [str(owner).strip().lower() if owner is not None else None for owner in owners]


def column_expression(columns: set[str], name: str) -> str:
    return name if name in columns else f"NULL AS {name}"


def load_documents(
    connection: sqlite3.Connection,
    columns: set[str],
    owner: str | None,
) -> list[sqlite3.Row]:
    names = [
        "filename",
        "title",
        "format",
        "file_data",
        "reading_position",
        "voice",
        "translation_target",
        "translation_mode",
        "created_at",
        "updated_at",
        "position_updated_at",
        "highlights_updated_at",
        "voice_updated_at",
        "translation_updated_at",
        "actual_filename",
    ]
    required = {"filename", "title", "format", "file_data", "created_at"}
    missing = sorted(required - columns)
    if missing:
        raise ValueError(f"Unsupported files table; missing: {', '.join(missing)}")

    expressions = [column_expression(columns, name) for name in names]
    where = ""
    parameters: tuple[Any, ...] = ()
    if "owner_email" in columns:
        if owner is None:
            where = " WHERE owner_email IS NULL"
        else:
            where = " WHERE lower(trim(owner_email)) = ?"
            parameters = (owner,)
    query = f"SELECT {', '.join(expressions)} FROM files{where} ORDER BY created_at"
    return list(connection.execute(query, parameters))


def load_highlights(
    connection: sqlite3.Connection,
    filename: str,
    owner: str | None,
) -> list[dict[str, Any]]:
    columns = table_columns(connection, "highlights")
    if not columns:
        return []

    scoped_id = f"{owner}::{filename}" if owner else filename
    possible_ids = [scoped_id] if scoped_id == filename else [scoped_id, filename]
    placeholders = ",".join("?" for _ in possible_ids)
    comment = "comment" if "comment" in columns else "NULL AS comment"
    page_index = "page_index" if "page_index" in columns else "NULL AS page_index"
    word_start = "word_start" if "word_start" in columns else "NULL AS word_start"
    words = "words" if "words" in columns else "NULL AS words"
    query = (
        f"SELECT sentence_index, color, text, {comment}, {page_index}, {word_start}, {words} "
        "FROM highlights "
        f"WHERE file_id IN ({placeholders})"
    )
    parameters: list[Any] = list(possible_ids)
    if "owner_email" in columns:
        if owner is None:
            query += " AND owner_email IS NULL"
        else:
            query += " AND lower(trim(owner_email)) = ?"
            parameters.append(owner)
    query += " ORDER BY sentence_index"

    highlights: dict[int, dict[str, Any]] = {}
    for row in connection.execute(query, parameters):
        index = int(row[0])
        highlight = {
            "sentenceIndex": index,
            "color": row[1] or "#ffda76",
            "text": row[2] or "",
            "comment": row[3] or "",
        }
        if row[4] is not None:
            highlight["pageIndex"] = int(row[4])
        if row[5] is not None:
            highlight["wordStart"] = int(row[5])
        if row[6]:
            try:
                parsed_words = json.loads(row[6])
                if isinstance(parsed_words, list):
                    highlight["words"] = [str(word) for word in parsed_words]
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
        highlights[index] = highlight
    return list(highlights.values())


def actual_filename(row: sqlite3.Row) -> str:
    if row["actual_filename"]:
        name = str(row["actual_filename"]).strip()
    else:
        file_id = str(row["filename"]).strip()
        parts = file_id.split("::") if file_id.startswith("file::") else []
        name = parts[1].strip() if len(parts) > 1 and parts[1] else file_id
    # Never allow a database filename to escape the output directory.
    return Path(name.replace("\\", "/")).name or "document.pdf"


def numeric_position(value: Any) -> int | float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(number):
        return 0
    return int(number) if number.is_integer() else number


def timestamp(row: sqlite3.Row, name: str) -> str:
    return str(row[name] or row["created_at"])


def build_record(row: sqlite3.Row, highlights: list[dict[str, Any]]) -> dict[str, Any]:
    filename = actual_filename(row)
    return {
        "version": 1,
        "fileId": str(row["filename"]).strip(),
        "actualFilename": filename,
        "format": "epub" if str(row["format"]).lower() == "epub" else "pdf",
        "title": str(row["title"] or filename).strip(),
        "position": numeric_position(row["reading_position"]),
        "voice": row["voice"],
        "translationTarget": row["translation_target"],
        "translationMode": row["translation_mode"],
        "highlights": highlights,
        "documentDriveId": None,
        "deleted": False,
        "createdAt": timestamp(row, "created_at"),
        "updatedAt": timestamp(row, "updated_at"),
        "positionUpdatedAt": timestamp(row, "position_updated_at"),
        "highlightsUpdatedAt": timestamp(row, "highlights_updated_at"),
        "voiceUpdatedAt": timestamp(row, "voice_updated_at"),
        "translationUpdatedAt": timestamp(row, "translation_updated_at"),
    }


def unique_output_name(name: str, used_names: set[str]) -> str:
    candidate = name
    path = Path(name)
    counter = 2
    while candidate.casefold() in used_names:
        candidate = f"{path.stem}-{counter}{path.suffix}"
        counter += 1
    used_names.add(candidate.casefold())
    return candidate


def owner_folder_name(owner: str | None) -> str:
    if owner is None:
        return "legacy-unowned"
    return owner.replace("/", "_").replace("\\", "_")


def write_file(path: Path, content: bytes | str, overwrite: bool) -> None:
    if path.exists() and not overwrite:
        raise FileExistsError(f"Output already exists: {path} (use --overwrite)")
    if isinstance(content, str):
        path.write_text(content, encoding="utf-8")
    else:
        path.write_bytes(content)


def main() -> int:
    args = parse_args()
    if not args.database.is_file():
        print(f"Database not found: {args.database}", file=sys.stderr)
        return 2

    try:
        with sqlite3.connect(f"file:{args.database.resolve()}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row
            columns = table_columns(connection, "files")
            owners = select_owners(connection, columns, args.owner, args.legacy)
            args.output.mkdir(parents=True, exist_ok=True)

            for owner in owners:
                documents = load_documents(connection, columns, owner)
                owner_directory = args.output / owner_folder_name(owner)
                owner_directory.mkdir(parents=True, exist_ok=True)
                print(f"Owner: {owner or '<legacy/unowned>'}")

                used_names: set[str] = set()
                for index, row in enumerate(documents, 1):
                    output_name = unique_output_name(actual_filename(row), used_names)
                    document_path = owner_directory / output_name
                    metadata_path = owner_directory / f".{output_name}.pocketreader.json"
                    highlights = load_highlights(connection, str(row["filename"]), owner)
                    record = build_record(row, highlights)
                    record["actualFilename"] = output_name

                    write_file(document_path, bytes(row["file_data"]), args.overwrite)
                    write_file(
                        metadata_path,
                        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
                        args.overwrite,
                    )
                    print(
                        f"  [{index}/{len(documents)}] "
                        f"{document_path.name} + {metadata_path.name}"
                    )
    except (ValueError, FileExistsError, sqlite3.Error) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    print(f"Export complete: {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
