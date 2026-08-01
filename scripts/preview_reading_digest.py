#!/usr/bin/env python3
"""Render the reading digest as a local HTML file without sending email."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app  # noqa: E402
from reading_digest_service import (  # noqa: E402
    DigestWindow,
    build_digest_html,
    summarize_reward_snapshot,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--email",
        help="Use this account's current forest and saved phrases. Without it, sample data is used.",
    )
    parser.add_argument(
        "--period",
        default="2026-07",
        help="Monthly period in YYYY-MM form (default: 2026-07).",
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("PUBLIC_APP_URL", "https://library.charlesneimog.duckdns.org/"),
        help="Public library URL used by the call-to-action button.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/tmp/pocketreader-reading-summary.html"),
        help="HTML output path.",
    )
    parser.add_argument(
        "--database",
        type=Path,
        help="Database path for --email (default: app.py's configured path).",
    )
    return parser.parse_args()


def monthly_window(period: str) -> DigestWindow:
    try:
        start = date.fromisoformat(f"{period}-01")
    except ValueError as error:
        raise SystemExit("--period must use YYYY-MM, for example 2026-07") from error
    if start.month == 12:
        next_month = start.replace(year=start.year + 1, month=1)
    else:
        next_month = start.replace(month=start.month + 1)
    end = date.fromordinal(next_month.toordinal() - 1)
    return DigestWindow("monthly", period, start, end)


def sample_snapshot(window: DigestWindow) -> dict:
    completed_at = datetime.combine(
        window.end_date,
        datetime.min.time(),
        tzinfo=timezone.utc,
    ).timestamp() * 1000
    species = [
        "minute-sprout",
        "reading-sapling",
        "aurora-pine",
        "violet-blossom",
        "sunset-maple",
        "ipe-amarelo-golden-rain",
        "buriti-sun-palm",
    ]
    return {
        "activeTimeByDay": {
            window.start_date.isoformat(): 58 * 60_000,
            window.end_date.isoformat(): 38 * 60_000,
        },
        "plants": [
            {
                "speciesId": species[index],
                "stage": "mature",
                "completedAt": completed_at,
                "cell": {"x": index % 4, "y": index // 4},
            }
            for index in range(len(species))
        ],
        "rewardLedger": [
            {"localDate": window.end_date.isoformat(), "points": 67},
        ],
    }


def main() -> None:
    args = parse_args()
    window = monthly_window(args.period)
    if args.database:
        app.DB_PATH = str(args.database)

    if args.email:
        if not Path(app.DB_PATH).exists():
            raise SystemExit(f"Database not found: {app.DB_PATH}")
        snapshot = app.get_reward_state(args.email) or {}
        memories = app.list_email_digest_memories(args.email, limit=4)
    else:
        snapshot = sample_snapshot(window)
        memories = [
            {
                "text": "A reader lives a thousand lives before he dies.",
                "comment": "A lovely reminder of why I keep making time for books.",
                "documentTitle": "A favorite book",
            },
            {
                "text": "Small, steady steps still carry us a very long way.",
                "comment": "Use this idea for the next reading goal.",
                "documentTitle": "Notes on slow progress",
            },
        ]

    summary = summarize_reward_snapshot(snapshot, window, "America/Sao_Paulo")
    html = build_digest_html("PocketReader", window, summary, args.url, memories)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html, encoding="utf-8")
    print(args.output.resolve().as_uri())


if __name__ == "__main__":
    main()
