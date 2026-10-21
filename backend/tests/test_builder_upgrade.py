"""builder-upgrade jobs: only 1015-pool builders, one open job per host, never the pool's last
in-service worker, one upgrade per pool at a time, and a stale ceiling long enough to drain."""
from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest
from app.api import reprovision as rp
from app.database import Base
from app.models import ReprovisionJob, Worker
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

NSS3 = "releng-hardware/nss-3-b-osx-1015"
G3 = "releng-hardware/gecko-3-b-osx-1015"


def _fqdn(short: str) -> str:
    return f"{short}.test.releng.mdc1.mozilla.com"


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for short, pool, os_v, quar in (
        ("macmini-r8-124", NSS3, "10.15.7", False),
        ("macmini-r8-370", NSS3, "15.8.1", False),
        ("macmini-r8-241", G3, "15.8.1", False),
        ("macmini-r8-242", G3, "15.8.1", False),
        ("macmini-r8-198", G3, "10.15.7", True),
        ("macmini-r8-17", "releng-hardware/gecko-t-osx-1400-r8", "14.7.5", False),
    ):
        s.add(Worker(hostname=_fqdn(short), generation="r8", platform="mac", tc_worker_pool_id=pool,
                     os_version=os_v, tc_quarantined=quar))
    s.commit()
    yield s
    s.close()


def _queue(db, short, **kw):
    return rp.builder_upgrade(short, user="rcurran@mozilla.com", db=db, dry_run=kw.get("dry_run", False),
                              unquarantine=kw.get("unquarantine", False))


def test_hosts_lists_only_builder_pools(db):
    out = rp.builder_hosts(user="rcurran@mozilla.com", db=db)
    hosts = {h["host"]: h for h in out["hosts"]}
    assert "macmini-r8-17" not in hosts  # a tester, not a builder
    assert hosts["macmini-r8-124"]["upgraded"] is False
    assert hosts["macmini-r8-370"]["upgraded"] is True
    assert hosts["macmini-r8-198"]["quarantined"] is True


def test_upgrade_queues_job_with_pool_and_flags(db):
    res = _queue(db, "macmini-r8-124", unquarantine=True)
    job = db.get(ReprovisionJob, res["job"]["id"])
    assert (job.action, job.state, job.hostname) == ("builder-upgrade", "queued", _fqdn("macmini-r8-124"))
    assert json.loads(job.params) == {"pool": NSS3, "unquarantine": True}


def test_upgrade_refuses_non_builder(db):
    with pytest.raises(HTTPException) as e:
        _queue(db, "macmini-r8-17")
    assert e.value.status_code == 404


def test_upgrade_refuses_second_open_job(db):
    _queue(db, "macmini-r8-124")
    with pytest.raises(HTTPException) as e:
        _queue(db, "macmini-r8-124")
    assert e.value.status_code == 409


def test_capacity_guard_refuses_last_in_service_worker(db):
    # nss-3 has r8-124 and r8-370; take r8-370 out and r8-124 becomes the last one.
    db.get(Worker, _fqdn("macmini-r8-370")).tc_quarantined = True
    db.commit()
    with pytest.raises(HTTPException) as e:
        _queue(db, "macmini-r8-124")
    assert e.value.status_code == 409 and "last in-service" in e.value.detail


def test_capacity_guard_counts_hosts_mid_upgrade_as_out(db):
    # r8-241 is mid-upgrade (but not yet quarantined in the synced Worker row); then r8-242
    # would leave gecko-3 with nobody (r8-198 is quarantined).
    _queue(db, "macmini-r8-241")
    with pytest.raises(HTTPException) as e:
        _queue(db, "macmini-r8-242")
    assert e.value.status_code == 409


def test_dry_run_skips_capacity_guard(db):
    db.get(Worker, _fqdn("macmini-r8-370")).tc_quarantined = True
    db.commit()
    res = _queue(db, "macmini-r8-124", dry_run=True)
    assert res["job"]["params"] == {"pool": NSS3, "dry_run": True}


def test_claim_runs_one_upgrade_per_pool(db):
    db.add(Worker(hostname=_fqdn("macmini-r8-139"), generation="r8", tc_worker_pool_id=G3, os_version="10.15.7"))
    db.commit()
    first = _queue(db, "macmini-r8-241")["job"]["id"]
    second = _queue(db, "macmini-r8-139", dry_run=True)["job"]["id"]  # same pool
    other = _queue(db, "macmini-r8-124")["job"]["id"]  # different pool
    assert rp.runner_claim(runner="r", db=db)["job"]["id"] == first
    # second waits behind first (same pool); the nss-3 job goes ahead
    assert rp.runner_claim(runner="r", db=db)["job"]["id"] == other
    assert rp.runner_claim(runner="r", db=db)["job"] is None
    db.get(ReprovisionJob, first).state = "succeeded"
    db.commit()
    assert rp.runner_claim(runner="r", db=db)["job"]["id"] == second


def test_stale_ceiling_allows_a_long_drain(db):
    jid = _queue(db, "macmini-r8-124")["job"]["id"]
    job = db.get(ReprovisionJob, jid)
    job.state, job.claimed_at = "running", datetime.utcnow() - timedelta(hours=5)
    db.commit()
    assert rp._active_job(db, _fqdn("macmini-r8-124")) is not None  # 5h: still legitimately running
    job.claimed_at = datetime.utcnow() - timedelta(hours=10)
    db.commit()
    assert rp._active_job(db, _fqdn("macmini-r8-124")) is None
    assert db.get(ReprovisionJob, jid).state == "failed"
