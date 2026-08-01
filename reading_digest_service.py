"""Server-side reading summary emails.

The scheduler deliberately reads persisted reward snapshots rather than browser
events, so a closed tab cannot generate or prevent a scheduled digest.
"""

from __future__ import annotations

import logging
import math
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from html import escape
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


logger = logging.getLogger("localreader.reading_digest")


@dataclass(frozen=True)
class DigestWindow:
    digest_type: str
    period_key: str
    start_date: date
    end_date: date


def resolve_timezone(timezone_name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(str(timezone_name or "UTC"))
    except (ZoneInfoNotFoundError, ValueError):
        logger.warning("Unknown digest timezone %r; using UTC", timezone_name)
        return ZoneInfo("UTC")


def scheduled_digest_windows(
    now_utc: datetime,
    timezone_name: str,
    *,
    weekly_hour: int = 18,
    monthly_hour: int = 9,
    yearly_hour: int = 18,
) -> list[DigestWindow]:
    """Return digest periods due at the supplied instant in the user's timezone."""
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)
    local_now = now_utc.astimezone(resolve_timezone(timezone_name))
    current = local_now.date()
    due: list[DigestWindow] = []

    # Python weekday: Monday=0, Saturday=5.
    if local_now.weekday() == 5 and local_now.hour >= weekly_hour:
        start = current - timedelta(days=local_now.weekday())
        due.append(DigestWindow("weekly", current.isoformat(), start, current))

    if current.day == 1 and local_now.hour >= monthly_hour:
        previous_end = current - timedelta(days=1)
        previous_start = previous_end.replace(day=1)
        due.append(
            DigestWindow(
                "monthly",
                previous_start.strftime("%Y-%m"),
                previous_start,
                previous_end,
            )
        )

    if current.month == 12 and current.day == 31 and local_now.hour >= yearly_hour:
        due.append(DigestWindow("yearly", str(current.year), current.replace(month=1, day=1), current))

    return due


def summarize_reward_snapshot(snapshot: dict | None, window: DigestWindow, timezone_name: str) -> dict:
    """Aggregate active time, reading days, completed trees, and points."""
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    active_by_day = snapshot.get("activeTimeByDay")
    active_by_day = active_by_day if isinstance(active_by_day, dict) else {}

    total_ms = 0.0
    reading_days = 0
    for day_key, raw_ms in active_by_day.items():
        try:
            day = date.fromisoformat(str(day_key))
            milliseconds = max(0.0, float(raw_ms))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(milliseconds):
            continue
        if window.start_date <= day <= window.end_date:
            total_ms += milliseconds
            if milliseconds > 0:
                reading_days += 1

    zone = resolve_timezone(timezone_name)
    mature_trees = 0
    for plant in snapshot.get("plants") if isinstance(snapshot.get("plants"), list) else []:
        if not isinstance(plant, dict) or plant.get("stage") != "mature":
            continue
        raw_timestamp = plant.get("completedAt") or plant.get("plantedAt")
        try:
            completed = datetime.fromtimestamp(float(raw_timestamp) / 1000, timezone.utc).astimezone(zone).date()
        except (TypeError, ValueError, OSError, OverflowError):
            continue
        if window.start_date <= completed <= window.end_date:
            mature_trees += 1

    points = 0
    ledger = snapshot.get("rewardLedger")
    for transaction in ledger if isinstance(ledger, list) else []:
        if not isinstance(transaction, dict):
            continue
        try:
            transaction_date = date.fromisoformat(str(transaction.get("localDate")))
            transaction_points = int(transaction.get("points") or 0)
        except (TypeError, ValueError):
            continue
        if window.start_date <= transaction_date <= window.end_date:
            points += transaction_points

    return {
        "activeReadingMs": total_ms,
        "readingDays": reading_days,
        "matureTrees": mature_trees,
        "growthPoints": points,
        # The digest period controls the counters above. The garden is deliberately
        # current: it gives the email a familiar snapshot of what the reader has
        # built without pretending that older trees were planted this period.
        "gardenPlants": [
            {
                "speciesId": str(plant.get("speciesId") or "tree"),
                "stage": str(plant.get("stage") or "seed"),
                "cell": plant.get("cell") if isinstance(plant.get("cell"), dict) else None,
            }
            for plant in snapshot.get("plants", [])
            if isinstance(plant, dict)
        ],
    }


def format_reading_duration(milliseconds: float) -> str:
    minutes = max(0, math.floor(float(milliseconds or 0) / 60000))
    if minutes == 0:
        return "less than one minute" if milliseconds > 0 else "0 minutes"
    hours, remainder = divmod(minutes, 60)
    if not hours:
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    if not remainder:
        return f"{hours} hour{'s' if hours != 1 else ''}"
    return (
        f"{hours} hour{'s' if hours != 1 else ''} and "
        f"{remainder} minute{'s' if remainder != 1 else ''}"
    )


def _compact_text(value, limit: int) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: max(1, limit - 1)].rstrip() + "…"


def build_digest_email(
    app_name: str,
    window: DigestWindow,
    summary: dict,
    public_app_url: str = "",
    memories: list[dict] | None = None,
) -> tuple[str, str]:
    period_name = {
        "weekly": "weekly",
        "monthly": "monthly",
        "yearly": "yearly",
    }[window.digest_type]
    duration = format_reading_duration(summary["activeReadingMs"])
    days = int(summary["readingDays"])
    trees = int(summary["matureTrees"])
    points = int(summary["growthPoints"])
    subject = f"Your {app_name} {period_name} reading summary"
    body = (
        f"Your {period_name} reading summary\n\n"
        f"{window.start_date.isoformat()} to {window.end_date.isoformat()}\n\n"
        f"You read for {duration} across {days} reading day{'s' if days != 1 else ''}.\n"
        f"You planted {trees} tree{'s' if trees != 1 else ''} and earned {points} growth point"
        f"{'s' if points != 1 else ''}.\n\n"
        "Keep reading at your own pace—your existing garden never decays."
    )
    memories = memories if isinstance(memories, list) else []
    if memories:
        body += "\n\nPhrases & notes from your library"
        for memory in memories[:4]:
            text = _compact_text(memory.get("text"), 420)
            comment = _compact_text(memory.get("comment"), 280)
            title = _compact_text(memory.get("documentTitle"), 100)
            if text:
                body += f'\n\n“{text}”'
            if comment:
                body += f"\nNote: {comment}"
            if title:
                body += f"\n— {title}"
    if public_app_url:
        body += f"\n\n{public_app_url.rstrip('/')}/"
    body += "\n\nYou can turn off reading summary emails in Settings."
    return subject, body


def _plant_emoji(species_id: str, stage: str) -> str:
    if stage == "seed":
        return "•"
    if stage in {"sprout", "young"}:
        return "🌱"
    species_id = species_id.lower()
    if any(token in species_id for token in ("blossom", "ipe", "flower", "coral")):
        return "🌸"
    if any(token in species_id for token in ("pine", "cypress", "araucaria")):
        return "🌲"
    if any(token in species_id for token in ("palm", "buriti")):
        return "🌴"
    return "🌳"


def _garden_html(summary: dict) -> str:
    plants = summary.get("gardenPlants")
    plants = plants if isinstance(plants, list) else []
    mature_count = sum(1 for plant in plants if plant.get("stage") == "mature")
    def cell_coordinate(plant: dict, axis: str) -> int:
        try:
            return int((plant.get("cell") or {}).get(axis, 999))
        except (TypeError, ValueError):
            return 999

    visible = sorted(
        plants,
        key=lambda plant: (
            cell_coordinate(plant, "y"),
            cell_coordinate(plant, "x"),
        ),
    )[-18:]
    icons = [_plant_emoji(str(item.get("speciesId") or ""), str(item.get("stage") or "")) for item in visible]
    if not icons:
        icons = ["🌱"]
    rows = []
    for offset in range(0, len(icons), 6):
        cells = "".join(
            '<td align="center" valign="bottom" style="width:16.66%;height:54px;'
            'font-size:31px;line-height:36px;padding:2px">'
            f'{escape(icon)}</td>'
            for icon in icons[offset:offset + 6]
        )
        cells += '<td style="width:16.66%"></td>' * (6 - len(icons[offset:offset + 6]))
        rows.append(f"<tr>{cells}</tr>")
    tree_label = f"{mature_count} tree{'s' if mature_count != 1 else ''} growing here"
    return (
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" '
        'style="background-color:#dff6e8;background-image:linear-gradient(180deg,#dff6e8 0%,#edf8d7 64%,#b9d98b 65%,#8ebc6d 100%);'
        'border-radius:20px;border:1px solid #c8e5cf;padding:18px 14px 13px">'
        '<tr><td align="center" style="color:#315c43;font:700 12px Arial,sans-serif;letter-spacing:.08em;'
        f'text-transform:uppercase;padding-bottom:8px">Your current forest · {escape(tree_label)}</td></tr>'
        f'<tr><td><table role="presentation" width="100%" cellspacing="0" cellpadding="0">{"".join(rows)}</table></td></tr>'
        '</table>'
    )


def build_digest_html(
    app_name: str,
    window: DigestWindow,
    summary: dict,
    public_app_url: str = "",
    memories: list[dict] | None = None,
) -> str:
    """Build a conservative, inline-styled HTML email for broad client support."""
    period_name = {"weekly": "weekly", "monthly": "monthly", "yearly": "yearly"}[window.digest_type]
    duration = format_reading_duration(summary["activeReadingMs"])
    days = int(summary["readingDays"])
    trees = int(summary["matureTrees"])
    points = int(summary["growthPoints"])
    memories = memories if isinstance(memories, list) else []
    app_url = public_app_url.rstrip("/") + "/" if public_app_url else ""
    button = (
        f'<a href="{escape(app_url, quote=True)}" style="display:inline-block;background:#315c43;color:#fff;'
        'font:700 15px Arial,sans-serif;text-decoration:none;padding:13px 22px;border-radius:999px">'
        'Return to your library&nbsp; →</a>'
        if app_url else ""
    )
    memory_cards = []
    for memory in memories[:4]:
        text = escape(_compact_text(memory.get("text"), 420))
        comment = escape(_compact_text(memory.get("comment"), 280))
        title = escape(_compact_text(memory.get("documentTitle"), 100))
        if not text and not comment:
            continue
        quote = f'<div style="font:italic 16px/1.55 Georgia,serif;color:#273d31">“{text}”</div>' if text else ""
        note = (
            '<div style="margin-top:10px;padding:9px 11px;background:#fff7da;border-radius:9px;'
            f'font:14px/1.5 Arial,sans-serif;color:#5c4b22"><b>Your note:</b> {comment}</div>'
            if comment else ""
        )
        source = f'<div style="margin-top:9px;font:12px Arial,sans-serif;color:#6b7d72">{title}</div>' if title else ""
        memory_cards.append(
            '<td style="padding:0 0 10px"><div style="background:#f7faf7;border:1px solid #e1ebe3;'
            f'border-radius:13px;padding:15px 16px">{quote}{note}{source}</div></td>'
        )
    memories_html = ""
    if memory_cards:
        memories_html = (
            '<tr><td style="padding:28px 32px 0"><div style="font:700 19px Georgia,serif;color:#213d2d;'
            'margin-bottom:12px">Phrases &amp; notes worth revisiting</div>'
            '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>'
            + '</tr><tr>'.join(memory_cards) + '</tr></table></td></tr>'
        )
    return f'''<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{escape(app_name)} reading summary</title></head>
<body style="margin:0;background:#eef2ed;padding:24px 10px;color:#23352a">
<div style="display:none;max-height:0;overflow:hidden">{escape(duration)} of reading, {trees} new tree{'s' if trees != 1 else ''}, and a look at your forest.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 8px 28px rgba(35,53,42,.09)">
<tr><td style="padding:34px 32px 25px;background:#294e39;color:#fff">
<div style="font:700 12px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#cbe8d4">{escape(app_name)}</div>
<h1 style="margin:9px 0 7px;font:700 32px/1.15 Georgia,serif">Your {period_name} reading story</h1>
<div style="font:14px Arial,sans-serif;color:#d9eade">{window.start_date.strftime('%b %d, %Y')} – {window.end_date.strftime('%b %d, %Y')}</div>
</td></tr>
<tr><td style="padding:26px 32px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
<td width="33%" align="center" style="padding:8px"><div style="font:700 23px Georgia,serif;color:#294e39">{escape(duration)}</div><div style="font:12px Arial,sans-serif;color:#708078;margin-top:4px">READING</div></td>
<td width="33%" align="center" style="padding:8px;border-left:1px solid #e5ece6;border-right:1px solid #e5ece6"><div style="font:700 23px Georgia,serif;color:#294e39">{days}</div><div style="font:12px Arial,sans-serif;color:#708078;margin-top:4px">READING DAY{'S' if days != 1 else ''}</div></td>
<td width="33%" align="center" style="padding:8px"><div style="font:700 23px Georgia,serif;color:#294e39">+{points}</div><div style="font:12px Arial,sans-serif;color:#708078;margin-top:4px">GROWTH POINTS</div></td>
</tr></table></td></tr>
<tr><td style="padding:27px 32px 0">{_garden_html(summary)}</td></tr>
<tr><td style="padding:17px 35px 0;text-align:center;font:15px/1.55 Arial,sans-serif;color:#53655a">You planted <b>{trees} new tree{'s' if trees != 1 else ''}</b> this {period_name}. Keep reading at your own pace—your garden never decays.</td></tr>
{memories_html}
<tr><td align="center" style="padding:27px 32px 31px">{button}</td></tr>
<tr><td align="center" style="padding:18px 24px;background:#f5f7f4;font:12px/1.5 Arial,sans-serif;color:#7a877f">You can turn off reading summary emails in Settings.</td></tr>
</table></td></tr></table></body></html>'''


class ReadingDigestService:
    """Polls persisted accounts and sends each period at most once."""

    def __init__(
        self,
        *,
        repository,
        send_email,
        app_name: str = "PocketReader",
        public_app_url: str = "",
        poll_interval_seconds: int = 900,
        weekly_hour: int = 18,
        monthly_hour: int = 9,
        yearly_hour: int = 18,
        now=lambda: datetime.now(timezone.utc),
    ):
        self.repository = repository
        self.send_email = send_email
        self.app_name = app_name
        self.public_app_url = public_app_url
        self.poll_interval_seconds = max(60, int(poll_interval_seconds))
        self.weekly_hour = max(0, min(23, int(weekly_hour)))
        self.monthly_hour = max(0, min(23, int(monthly_hour)))
        self.yearly_hour = max(0, min(23, int(yearly_hour)))
        self.now = now
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self) -> int:
        sent = 0
        current = self.now()
        for recipient in self.repository.list_email_digest_recipients():
            if not recipient.get("enabled"):
                continue
            email = str(recipient.get("email") or "").strip().lower()
            timezone_name = str(recipient.get("timezone") or "UTC")
            if not email:
                continue
            windows = scheduled_digest_windows(
                current,
                timezone_name,
                weekly_hour=self.weekly_hour,
                monthly_hour=self.monthly_hour,
                yearly_hour=self.yearly_hour,
            )
            for window in windows:
                if not self.repository.claim_email_digest_delivery(
                    email,
                    window.digest_type,
                    window.period_key,
                ):
                    continue
                try:
                    snapshot = self.repository.get_reward_state(email)
                    summary = summarize_reward_snapshot(snapshot, window, timezone_name)
                    get_memories = getattr(self.repository, "list_email_digest_memories", None)
                    memories = get_memories(email, limit=4) if callable(get_memories) else []
                    subject, body = build_digest_email(
                        self.app_name,
                        window,
                        summary,
                        self.public_app_url,
                        memories,
                    )
                    html_body = build_digest_html(
                        self.app_name,
                        window,
                        summary,
                        self.public_app_url,
                        memories,
                    )
                    self.send_email(email, subject, body, html_body)
                    self.repository.complete_email_digest_delivery(
                        email,
                        window.digest_type,
                        window.period_key,
                    )
                    sent += 1
                except Exception:
                    self.repository.release_email_digest_delivery(
                        email,
                        window.digest_type,
                        window.period_key,
                    )
                    logger.exception(
                        "Reading digest failed: email=%s type=%s period=%s",
                        email,
                        window.digest_type,
                        window.period_key,
                    )
        return sent

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception:
                logger.exception("Reading digest scheduler pass failed")
            self._stop_event.wait(self.poll_interval_seconds)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="reading-digest", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)
        self._thread = None
