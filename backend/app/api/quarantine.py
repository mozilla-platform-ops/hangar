"""Worker quarantine — allowlist-gated (same list as reprovision).

Quarantine is a single Taskcluster ``quarantineWorker`` call, and Cloud Run can
reach the public TC API, so — unlike reprovision (which needs the on-network
runner for SSH) — Hangar performs this directly. Access is limited to the emails
in ``settings.reprovision_authorized_list`` (verified via Google IAP), reusing
the reprovision gate so there's a single control surface allowlist.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..auth import current_user
from ..database import get_db
from ..hosts import worker_fqdn
from ..models import Worker
from .. import tc
from .reprovision import _authorized, _short, require_access

log = logging.getLogger(__name__)

router = APIRouter(prefix="/quarantine", tags=["quarantine"])

# Preset quarantine durations offered in the UI.
_DURATIONS: dict[str, timedelta] = {
    "1h": timedelta(hours=1),
    "4h": timedelta(hours=4),
    "1d": timedelta(days=1),
    "1w": timedelta(weeks=1),
}
# "indefinite" uses a far-future date — the same convention the TC sync already
# treats as a parked/long-hold marker (see taskcluster.py's year-3000 cutoff).
_INDEFINITE = datetime(3000, 1, 1)


def _lookup(db: Session, hostname: str) -> Worker | None:
    """Resolve a worker by exact key (scriptworker ids have no FQDN) or FQDN."""
    return db.get(Worker, hostname) or db.get(Worker, worker_fqdn(hostname))


def _tc_identity(w: Worker) -> tuple[str, str, str, str] | None:
    """(provisionerId, workerType, workerGroup, workerId) or None if the worker
    isn't currently registered in TC (nothing to quarantine)."""
    if not w.tc_worker_pool_id or "/" not in w.tc_worker_pool_id or not w.tc_worker_id:
        return None
    provisioner_id, worker_type = w.tc_worker_pool_id.split("/", 1)
    worker_group = w.tc_worker_group or worker_type
    return provisioner_id, worker_type, worker_group, w.tc_worker_id


@router.get("/access")
def access(request: Request) -> dict[str, Any]:
    """Whether the caller may quarantine, and whether TC creds are configured
    (drives showing the control + a 'not configured' hint)."""
    user = current_user(request)
    return {
        "user": user,
        "authorized": _authorized(user),
        "tc_configured": tc.credentials_configured(),
    }


@router.post("/{hostname:path}/lift")
def lift(
    hostname: str,
    user: str = Depends(require_access),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Lift a worker's quarantine (quarantineUntil = now)."""
    w = _lookup(db, hostname)
    if not w:
        raise HTTPException(status_code=404, detail=f"Worker {hostname} not found")
    ident = _tc_identity(w)
    if not ident:
        raise HTTPException(status_code=409, detail=f"{_short(w.hostname)} is not registered in Taskcluster")
    info = f"un-quarantined via Hangar by {user}"
    try:
        tc.quarantine_worker(*ident, datetime.utcnow(), info)
    except tc.TCCredentialsError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:  # noqa: BLE001 — surface the TC error to the operator
        log.exception("quarantine lift failed for %s", w.hostname)
        raise HTTPException(status_code=502, detail=f"Taskcluster rejected the request: {e}")
    # Optimistic local update so the UI reflects it before the next TC sync.
    w.tc_quarantined = False
    w.tc_quarantine_until = None
    db.commit()
    log.info("%s un-quarantined %s", user, w.hostname)
    return {"ok": True, "hostname": w.hostname, "quarantined": False}


@router.post("/{hostname:path}")
def quarantine(
    hostname: str,
    user: str = Depends(require_access),
    db: Session = Depends(get_db),
    duration: str = Body(..., embed=True),
    reason: str = Body("", embed=True),
) -> dict[str, Any]:
    """Quarantine a worker for a preset duration (or indefinitely)."""
    if duration != "indefinite" and duration not in _DURATIONS:
        raise HTTPException(status_code=400, detail=f"invalid duration '{duration}'")
    w = _lookup(db, hostname)
    if not w:
        raise HTTPException(status_code=404, detail=f"Worker {hostname} not found")
    ident = _tc_identity(w)
    if not ident:
        raise HTTPException(status_code=409, detail=f"{_short(w.hostname)} is not registered in Taskcluster")

    until = _INDEFINITE if duration == "indefinite" else datetime.utcnow() + _DURATIONS[duration]
    info = f"quarantined via Hangar by {user} ({duration})" + (f": {reason.strip()}" if reason.strip() else "")
    try:
        tc.quarantine_worker(*ident, until, info)
    except tc.TCCredentialsError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:  # noqa: BLE001
        log.exception("quarantine failed for %s", w.hostname)
        raise HTTPException(status_code=502, detail=f"Taskcluster rejected the request: {e}")
    # Optimistic local update so the UI reflects it before the next TC sync.
    w.tc_quarantined = True
    w.tc_quarantine_until = until
    db.commit()
    log.info("%s quarantined %s until %s (%s)", user, w.hostname, until, duration)
    return {
        "ok": True,
        "hostname": w.hostname,
        "quarantined": True,
        "quarantine_until": until.isoformat(),
        "duration": duration,
    }
