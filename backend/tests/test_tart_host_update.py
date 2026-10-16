"""tart-host-update jobs: eligibility, exclusions, one tart host at a time, and a stale
ceiling long enough for a real run (OS update up to 3h + verify up to 2h)."""
from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest
from app.api import reprovision as rp
from app.database import Base
from app.models import ReprovisionJob, TartSlotHealth
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for host in ("macmini-m4-249", "macmini-m4-250", "macmini-m4-117"):
        for slot in (1, 2):
            s.add(TartSlotHealth(hostname=host, slot=slot, collected_at=datetime.utcnow()))
    s.commit()
    yield s
    s.close()


def test_hosts_lists_tart_hosts_and_marks_exclusions(db):
    out = rp.tart_hosts(user="rcurran@mozilla.com", db=db)
    hosts = {h["host"]: h for h in out["hosts"]}
    assert set(hosts) == {"macmini-m4-117", "macmini-m4-249", "macmini-m4-250"}
    assert hosts["macmini-m4-117"]["excluded"]
    assert hosts["macmini-m4-249"]["excluded"] is None


def test_update_queues_a_tart_job(db):
    res = rp.tart_update("macmini-m4-249", user="rcurran@mozilla.com", db=db, puppet_only=False)
    job = db.get(ReprovisionJob, res["job"]["id"])
    assert (job.action, job.state, job.hostname) == ("tart-host-update", "queued", "macmini-m4-249.test.releng.mdc1.mozilla.com")
    assert json.loads(job.params) == {}


def test_update_puppet_only_param(db):
    res = rp.tart_update("macmini-m4-249", user="u", db=db, puppet_only=True)
    assert res["job"]["params"] == {"puppet_only": True}


def test_update_refuses_excluded_canary(db):
    with pytest.raises(HTTPException) as e:
        rp.tart_update("macmini-m4-117", user="u", db=db, puppet_only=False)
    assert e.value.status_code == 409


def test_update_refuses_unknown_host(db):
    with pytest.raises(HTTPException) as e:
        rp.tart_update("macmini-m4-999", user="u", db=db, puppet_only=False)
    assert e.value.status_code == 404


def test_update_refuses_second_open_job_for_same_host(db):
    rp.tart_update("macmini-m4-249", user="u", db=db, puppet_only=False)
    with pytest.raises(HTTPException) as e:
        rp.tart_update("macmini-m4-249", user="u", db=db, puppet_only=False)
    assert e.value.status_code == 409


def test_claim_runs_only_one_tart_host_at_a_time(db):
    rp.tart_update("macmini-m4-249", user="u", db=db, puppet_only=False)
    rp.tart_update("macmini-m4-250", user="u", db=db, puppet_only=False)
    first = rp.runner_claim(runner="m4-81", db=db)["job"]
    assert first["short"] == "macmini-m4-249"
    assert rp.runner_claim(runner="m4-81", db=db)["job"] is None  # 250 waits
    rp.runner_complete(first["id"], runner="m4-81", db=db, success=True, detail="ok")
    assert rp.runner_claim(runner="m4-81", db=db)["job"]["short"] == "macmini-m4-250"


def test_claim_still_serves_other_actions_while_a_tart_host_runs(db):
    rp.tart_update("macmini-m4-249", user="u", db=db, puppet_only=False)
    rp.tart_update("macmini-m4-250", user="u", db=db, puppet_only=False)
    db.add(ReprovisionJob(hostname="macmini-m4-90.test.releng.mdc1.mozilla.com", requested_by="u",
                          state="queued", action="quarantine"))
    db.commit()
    assert rp.runner_claim(runner="r", db=db)["job"]["short"] == "macmini-m4-249"
    # the tart job for 250 is older than the quarantine job, but it must not block it
    assert rp.runner_claim(runner="r", db=db)["job"]["action"] == "quarantine"


def test_tart_job_is_not_reaped_at_the_bare_metal_ceiling(db):
    rp.tart_update("macmini-m4-249", user="u", db=db, puppet_only=False)
    job = rp.runner_claim(runner="r", db=db)["job"]
    row = db.get(ReprovisionJob, job["id"])
    row.claimed_at = datetime.utcnow() - timedelta(minutes=rp._STALE_JOB_MINUTES + 30)
    db.commit()
    assert rp._active_job(db, row.hostname) is not None  # still open at 2.5h
    row.claimed_at = datetime.utcnow() - timedelta(minutes=rp._TART_STALE_JOB_MINUTES + 1)
    db.commit()
    assert rp._active_job(db, row.hostname) is None
    assert db.get(ReprovisionJob, job["id"]).state == "failed"
