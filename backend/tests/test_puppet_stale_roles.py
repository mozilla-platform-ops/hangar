"""Puppet sync must only clear puppet_role on hosts that inventory.d owns.

Windows NUCs get puppet_role from worker-images pools.yml (sync/windows_inventory.py).
The puppet sync treated every role-holder missing from inventory.d as stale, so each
hour it cleared all 173 NUC roles seconds after the Windows sync set them, and resolved
their missing_from_tc alerts along the way.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from app.database import Base
from app.models import Alert, Worker
from app.sync import puppet
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

INVENTORY = """\
groups:
  - name: gecko-t-osx-1500-m4
    targets:
      - macmini-m4-50.test.releng.mdc1.mozilla.com
    facts:
      puppet_role: gecko_t_osx_1500_m4
"""


@pytest.fixture
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Session:
    (tmp_path / "inventory.d").mkdir()
    (tmp_path / "inventory.d" / "macmini-m4.yaml").write_text(INVENTORY)
    monkeypatch.setattr(puppet.settings, "puppet_repo_path", str(tmp_path))
    monkeypatch.setattr(puppet, "ensure_repo", lambda *a, **k: None)
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        yield session


def test_windows_role_survives_puppet_sync(db: Session) -> None:
    h = "nuc13-001.wintest2.releng.mdc1.mozilla.com"
    db.add(Worker(hostname=h, platform="windows", puppet_role="win11-64-24h2-hw"))
    db.add(Alert(alert_type="missing_from_tc", hostname=h, detail="silent"))
    db.commit()

    puppet.run_sync(db)

    assert db.get(Worker, h).puppet_role == "win11-64-24h2-hw"
    assert db.query(Alert).filter(Alert.hostname == h, Alert.resolved_at == None).count() == 1  # noqa: E711


def test_mac_removed_from_inventory_is_still_cleared(db: Session) -> None:
    h = "macmini-m4-117.test.releng.mdc1.mozilla.com"
    db.add(Worker(hostname=h, puppet_role="gecko_1_b_osx_arm64_vms_host"))
    db.add(Alert(alert_type="missing_from_tc", hostname=h, detail="old"))
    db.commit()

    puppet.run_sync(db)

    assert db.get(Worker, h).puppet_role is None
    assert db.query(Alert).filter(Alert.hostname == h, Alert.resolved_at == None).count() == 0  # noqa: E711
