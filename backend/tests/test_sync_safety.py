from __future__ import annotations

import unittest
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import Alert, SyncLog, Worker
from app.sync import puppet, taskcluster
from app.sync.reconcile import prune_decommissioned


class DatabaseTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.session = sessionmaker(bind=self.engine)()

    def tearDown(self) -> None:
        self.session.close()
        self.engine.dispose()


class ReconcileSafetyTests(DatabaseTestCase):
    def test_worker_present_in_windows_inventory_is_not_pruned(self) -> None:
        now = datetime.utcnow()
        source_started = now - timedelta(minutes=1)
        for source in ("puppet", "taskcluster", "simplemdm", "windows_inventory"):
            self.session.add(
                SyncLog(
                    source=source,
                    started_at=source_started,
                    finished_at=now,
                    success=True,
                )
            )

        hostname = "t-nuc12-001.test.releng.mdc1.mozilla.com"
        self.session.add(
            Worker(
                hostname=hostname,
                last_synced_windows_inventory=now,
            )
        )
        self.session.commit()

        removed = prune_decommissioned(self.session)

        self.assertEqual(removed, 0)
        self.assertIsNotNone(self.session.get(Worker, hostname))


class TaskclusterSyncSafetyTests(DatabaseTestCase):
    def test_pool_fetch_failure_fails_the_entire_sync(self) -> None:
        hostname = "macmini-r8-001.test.releng.mdc1.mozilla.com"
        self.session.add(Worker(hostname=hostname, puppet_role="production"))
        self.session.commit()

        with (
            patch.object(taskcluster, "ALL_WORKER_POOLS", [("provisioner", "pool")]),
            patch.object(
                taskcluster,
                "_fetch_pool_workers",
                side_effect=RuntimeError("Taskcluster unavailable"),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "Taskcluster unavailable"):
                taskcluster.run_sync(self.session)

        sync_log = (
            self.session.query(SyncLog)
            .filter(SyncLog.source == "taskcluster")
            .one()
        )
        self.assertIs(sync_log.success, False)
        self.assertIn("Taskcluster unavailable", sync_log.error)
        self.assertEqual(self.session.query(Alert).count(), 0)


class PuppetSyncSafetyTests(DatabaseTestCase):
    def test_invalid_inventory_file_fails_the_entire_sync(self) -> None:
        with TemporaryDirectory() as repo_path:
            inventory_path = Path(repo_path) / "inventory.d"
            inventory_path.mkdir()
            (inventory_path / "broken.yaml").write_text("groups: [")

            with (
                patch.object(puppet.settings, "puppet_repo_path", repo_path),
                patch.object(puppet, "ensure_repo"),
            ):
                with self.assertRaisesRegex(RuntimeError, "broken.yaml"):
                    puppet.run_sync(self.session)

        sync_log = (
            self.session.query(SyncLog)
            .filter(SyncLog.source == "puppet")
            .one()
        )
        self.assertIs(sync_log.success, False)
        self.assertIn("broken.yaml", sync_log.error)


if __name__ == "__main__":
    unittest.main()
