"""missing_from_tc must not fire for hosts that aren't expected to work tasks.

m4-117 kept alerting after its pool (gecko-1-b-osx-arm64-vms-host) was retired:
the alert paths checked effective_state but not pool membership, and a mac pulled
from inventory.d keeps its tc_worker_pool_id forever, which alone made it a
"production" candidate for the absent-from-TC check.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from app.database import Base
from app.models import Alert, Worker
from app.sync.taskcluster import _check_absent_workers, _generate_alerts
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

STALE = datetime.utcnow() - timedelta(days=30)
POOL = "gecko-t-osx-1500-m4"


@pytest.fixture
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        yield session


def add(db: Session, hostname: str, **kw) -> Worker:
    fields = {"worker_pool": POOL, "puppet_role": "gecko_t_osx_1500_m4",
              "tc_worker_pool_id": f"releng-hardware/{POOL}", "tc_last_active": STALE} | kw
    w = Worker(hostname=hostname, **fields)
    db.add(w)
    db.flush()
    return w


def active(db: Session, hostname: str) -> list[Alert]:
    db.flush()
    return db.query(Alert).filter(Alert.hostname == hostname, Alert.alert_type == "missing_from_tc",
                                  Alert.resolved_at == None).all()  # noqa: E711


# ── Absent from TC ───────────────────────────────────────────────────────────────

def test_absent_production_mac_still_alerts(db: Session) -> None:
    add(db, "macmini-m4-50.test.releng.mdc1.mozilla.com")
    _check_absent_workers(db, set())
    assert len(active(db, "macmini-m4-50.test.releng.mdc1.mozilla.com")) == 1


def test_absent_mac_in_retired_pool_resolves(db: Session) -> None:
    """m4-117: still in inventory.d under the retired pool."""
    h = "macmini-m4-117.test.releng.mdc1.mozilla.com"
    add(db, h, worker_pool="gecko-1-b-osx-arm64-vms-host", puppet_role="gecko_1_b_osx_arm64_vms_host")
    db.add(Alert(alert_type="missing_from_tc", hostname=h, detail="old"))
    _check_absent_workers(db, set())
    assert active(db, h) == []


def test_absent_mac_out_of_puppet_resolves(db: Session) -> None:
    """m4-117 after leaving inventory.d: puppet_role cleared, tc_worker_pool_id sticks."""
    h = "macmini-m4-117.test.releng.mdc1.mozilla.com"
    add(db, h, worker_pool="some-future-retired-pool", puppet_role=None)
    db.add(Alert(alert_type="missing_from_tc", hostname=h, detail="old"))
    _check_absent_workers(db, set())
    assert active(db, h) == []


def test_absent_linux_without_puppet_role_still_alerts(db: Session) -> None:
    """Linux hosts aren't in inventory.d; tc_worker_pool_id is their only membership signal."""
    add(db, "t-nuc12-001", worker_pool="gecko-t-linux-talos-2204", puppet_role=None)
    _check_absent_workers(db, set())
    assert len(active(db, "t-nuc12-001")) == 1


def test_absent_mac_in_loaner_group_resolves(db: Session) -> None:
    """m4-81, the reprovision runner: still in inventory.d, but in the loaner MDM group."""
    h = "macmini-m4-81.test.releng.mdc1.mozilla.com"
    add(db, h, mdm_groups='["Loaner - Nosleep Profile Only", "Enable SSH"]')
    db.add(Alert(alert_type="missing_from_tc", hostname=h, detail="old"))
    _check_absent_workers(db, set())
    assert active(db, h) == []


# ── Returned by TC but stale ─────────────────────────────────────────────────────

def test_stale_production_mac_alerts(db: Session) -> None:
    h = "macmini-m4-70.test.releng.mdc1.mozilla.com"
    _generate_alerts(db, h, add(db, h))
    assert len(active(db, h)) == 1


def test_stale_mac_in_retired_pool_resolves(db: Session) -> None:
    h = "macmini-m4-117.test.releng.mdc1.mozilla.com"
    w = add(db, h, worker_pool="gecko-1-b-osx-arm64-vms-host")
    db.add(Alert(alert_type="missing_from_tc", hostname=h, detail="old"))
    _generate_alerts(db, h, w)
    assert active(db, h) == []
