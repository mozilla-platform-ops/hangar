"""Worker quarantine — allowlist-gated (same list as reprovision).

Reprovision already quarantines/un-quarantines hosts via its on-network runner
(orchestrator/clients/taskcluster.py), which holds the TC credentials. Rather than
give Hangar its own TC write creds, a standalone quarantine reuses that exact
wiring: Hangar enqueues a job on the shared runner queue with action
"quarantine"/"unquarantine"; the runner claims it and runs the `reprovision`
CLI's matching subcommand. Access is limited to ``settings.reprovision_authorized_list``
(IAP-verified) — the same gate as reprovision.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..auth import current_user
from ..config import settings
from ..database import get_db
from ..hosts import worker_fqdn
from ..models import ReprovisionEvent, ReprovisionJob, Worker
from .reprovision import _active_job, _authorized, _job_dict, _short, require_access

log = logging.getLogger(__name__)

router = APIRouter(prefix="/quarantine", tags=["quarantine"])

# Preset quarantine durations offered in the UI.
_DURATIONS: dict[str, timedelta] = {
    "1h": timedelta(hours=1),
    "4h": timedelta(hours=4),
    "1d": timedelta(days=1),
    "1w": timedelta(weeks=1),
}
# "indefinite" uses a far-future date — the convention the TC sync already treats
# as a parked/long-hold marker (see taskcluster.py's year-3000 cutoff).
_INDEFINITE = datetime(3000, 1, 1)


def _runner_enabled() -> bool:
    return bool(settings.reprovision_runner_token or settings.reprovision_runner_host_list)


def _stamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _lookup(db: Session, hostname: str) -> Worker | None:
    """Resolve a worker by exact key (scriptworker ids have no FQDN) or FQDN."""
    return db.get(Worker, hostname) or db.get(Worker, worker_fqdn(hostname))


def _enqueue(db: Session, w: Worker, user: str, action: str, params: dict[str, Any], summary: str) -> ReprovisionJob:
    if not w.tc_worker_pool_id:
        raise HTTPException(status_code=409, detail=f"{_short(w.hostname)} is not registered in Taskcluster")
    if _active_job(db, w.hostname):
        raise HTTPException(status_code=409, detail=f"a runner job is already open for {_short(w.hostname)}")
    if not _runner_enabled():
        raise HTTPException(status_code=503, detail="the reprovision runner is not enabled")
    job = ReprovisionJob(
        hostname=w.hostname, requested_by=user, action=action,
        params=json.dumps(params), state="queued",
    )
    db.add(job)
    db.add(ReprovisionEvent(hostname=w.hostname, user=user, action="enqueued", detail=summary))
    db.commit()
    db.refresh(job)
    log.info("%s enqueued %s for %s", user, action, w.hostname)
    return job


@router.get("/access")
def access(request: Request) -> dict[str, Any]:
    """Whether the caller may quarantine, and whether the runner is enabled
    (drives showing/enabling the control)."""
    user = current_user(request)
    return {
        "user": user,
        "authorized": _authorized(user),
        "runner_enabled": _runner_enabled(),
    }


@router.post("/{hostname:path}/lift")
def lift(
    hostname: str,
    user: str = Depends(require_access),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Queue an un-quarantine for the on-network runner."""
    w = _lookup(db, hostname)
    if not w:
        raise HTTPException(status_code=404, detail=f"Worker {hostname} not found")
    job = _enqueue(
        db, w, user, "unquarantine", {},
        summary="un-quarantine enqueued for the on-network runner",
    )
    return {"ok": True, "job": _job_dict(job)}


@router.post("/{hostname:path}")
def quarantine(
    hostname: str,
    user: str = Depends(require_access),
    db: Session = Depends(get_db),
    duration: str = Body(..., embed=True),
    reason: str = Body("", embed=True),
) -> dict[str, Any]:
    """Queue a quarantine (preset duration, optional reason) for the runner."""
    if duration != "indefinite" and duration not in _DURATIONS:
        raise HTTPException(status_code=400, detail=f"invalid duration '{duration}'")
    w = _lookup(db, hostname)
    if not w:
        raise HTTPException(status_code=404, detail=f"Worker {hostname} not found")

    until = _INDEFINITE if duration == "indefinite" else datetime.utcnow() + _DURATIONS[duration]
    info = f"quarantined via Hangar by {user} ({duration})" + (f": {reason.strip()}" if reason.strip() else "")
    params = {"until": _stamp(until), "info": info, "duration": duration}
    summary = f"quarantine ({duration}) enqueued for the on-network runner" + (f": {reason.strip()}" if reason.strip() else "")
    job = _enqueue(db, w, user, "quarantine", params, summary)
    return {"ok": True, "job": _job_dict(job), "quarantine_until": until.isoformat(), "duration": duration}
