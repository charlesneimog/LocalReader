import unittest
import tempfile
from datetime import date, datetime, timezone

import app
from reading_digest_service import (
    DigestWindow,
    ReadingDigestService,
    build_digest_email,
    scheduled_digest_windows,
    summarize_reward_snapshot,
)


class FakeRepository:
    def __init__(self):
        self.claims = set()
        self.completed = set()
        self.released = set()

    def list_email_digest_recipients(self):
        return [
            {"email": "reader@example.com", "enabled": True, "timezone": "America/Sao_Paulo"},
            {"email": "opted-out@example.com", "enabled": False, "timezone": "UTC"},
        ]

    def claim_email_digest_delivery(self, email, digest_type, period_key):
        key = (email, digest_type, period_key)
        if key in self.claims:
            return False
        self.claims.add(key)
        return True

    def complete_email_digest_delivery(self, email, digest_type, period_key):
        self.completed.add((email, digest_type, period_key))
        return True

    def release_email_digest_delivery(self, email, digest_type, period_key):
        self.released.add((email, digest_type, period_key))
        return True

    def get_reward_state(self, _email):
        return {"activeTimeByDay": {"2026-07-30": 600_000}}


class ReadingDigestServiceTests(unittest.TestCase):
    def test_database_preferences_default_to_enabled_and_delivery_is_idempotent(self):
        original_path = app.DB_PATH
        try:
            with tempfile.TemporaryDirectory() as directory:
                app.DB_PATH = f"{directory}/database.db"
                app.init_db()
                self.assertTrue(app.create_user("reader@example.com", "strong-password"))
                self.assertEqual(
                    app.get_email_digest_preference("reader@example.com")["enabled"],
                    True,
                )
                self.assertTrue(
                    app.update_email_digest_preference(
                        "reader@example.com",
                        False,
                        "America/Sao_Paulo",
                    )
                )
                self.assertEqual(
                    app.list_email_digest_recipients(),
                    [{
                        "email": "reader@example.com",
                        "enabled": False,
                        "timezone": "America/Sao_Paulo",
                    }],
                )
                self.assertTrue(
                    app.claim_email_digest_delivery("reader@example.com", "weekly", "2026-08-01")
                )
                self.assertFalse(
                    app.claim_email_digest_delivery("reader@example.com", "weekly", "2026-08-01")
                )
                self.assertTrue(
                    app.complete_email_digest_delivery("reader@example.com", "weekly", "2026-08-01")
                )
        finally:
            app.DB_PATH = original_path

    def test_weekly_monthly_and_yearly_schedules_use_local_calendar(self):
        weekly = scheduled_digest_windows(
            datetime(2026, 8, 8, 21, tzinfo=timezone.utc),
            "America/Sao_Paulo",
        )
        self.assertEqual([(item.digest_type, item.start_date, item.end_date) for item in weekly], [
            ("weekly", date(2026, 8, 3), date(2026, 8, 8)),
        ])

        monthly = scheduled_digest_windows(
            datetime(2026, 9, 1, 12, tzinfo=timezone.utc),
            "America/Sao_Paulo",
        )
        self.assertEqual([(item.digest_type, item.period_key) for item in monthly], [("monthly", "2026-08")])

        yearly = scheduled_digest_windows(
            datetime(2026, 12, 31, 21, tzinfo=timezone.utc),
            "America/Sao_Paulo",
        )
        self.assertIn(("yearly", "2026"), [(item.digest_type, item.period_key) for item in yearly])

    def test_summary_uses_active_milliseconds_and_counts_trees_and_points(self):
        completed_at = datetime(2026, 7, 30, 15, tzinfo=timezone.utc).timestamp() * 1000
        window = DigestWindow("monthly", "2026-07", date(2026, 7, 1), date(2026, 7, 31))
        summary = summarize_reward_snapshot(
            {
                "activeTimeByDay": {
                    "2026-07-29": 300_000,
                    "2026-07-30": 600_000,
                    "bad": "bad",
                },
                "plants": [
                    {"stage": "mature", "completedAt": completed_at},
                    {"stage": "young", "completedAt": completed_at},
                ],
                "rewardLedger": [
                    {"localDate": "2026-07-30", "points": 4},
                    {"localDate": "2026-06-30", "points": 10},
                ],
            },
            window,
            "America/Sao_Paulo",
        )
        self.assertEqual(summary["activeReadingMs"], 900_000)
        self.assertEqual(summary["readingDays"], 2)
        self.assertEqual(summary["matureTrees"], 1)
        self.assertEqual(summary["growthPoints"], 4)
        subject, body = build_digest_email("PocketReader", window, summary)
        self.assertIn("monthly", subject)
        self.assertIn("15 minutes", body)

    def test_opt_out_and_delivery_claim_prevent_duplicate_email(self):
        repository = FakeRepository()
        sent = []
        service = ReadingDigestService(
            repository=repository,
            send_email=lambda *message: sent.append(message),
            now=lambda: datetime(2026, 8, 8, 21, tzinfo=timezone.utc),
        )
        self.assertEqual(service.run_once(), 1)
        self.assertEqual(service.run_once(), 0)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], "reader@example.com")
        self.assertEqual(len(repository.completed), 1)


if __name__ == "__main__":
    unittest.main()
