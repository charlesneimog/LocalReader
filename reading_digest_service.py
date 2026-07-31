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


def build_digest_email(
    app_name: str,
    window: DigestWindow,
    summary: dict,
    public_app_url: str = "",
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
        "Keep reading at your own pace—your existing garden never decays.\n\n"
        "You can turn off reading summary emails in Settings."
    )
    if public_app_url:
        body += f"\n{public_app_url.rstrip('/')}/"
    return subject, body


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
                    subject, body = build_digest_email(
                        self.app_name,
                        window,
                        summary,
                        self.public_app_url,
                    )
                    self.send_email(email, subject, body)
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
