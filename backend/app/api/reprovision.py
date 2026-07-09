"""Reprovision cockpit — allowlist-gated.

Hangar runs on Cloud Run with no network path to MDC1, so it cannot SSH to workers; the
destructive/SSH steps of a reprovision run in the on-VPN `reprovision` CLI. This module is the
control surface around that: it reports a worker's reprovision *readiness* (from the synced
worker row), hands back the exact CLI commands to run, and keeps an audit ledger of who
initiated a reprovision of what. Access is limited to the emails in
`settings.reprovision_authorized_list` (verified via Google IAP).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import desc
from sqlalchemy.orm import Session

from ..auth import current_user
from ..config import settings
from ..database import get_db
from ..hosts import worker_fqdn
from ..models import ReprovisionEvent, Worker

router = APIRouter(prefix="/reprovision", tags=["reprovision"])

# TC run states that mean a task is still in flight (mirrors the CLI's safe_runner-based
# idle check: a run is busy unless its state is terminal).
_ACTIVE_TASK_STATES = {"pending", "running", "unscheduled", "claimed"}


def _authorized(user: str) -> bool:
    return user.lower() in settings.reprovision_authorized_list


def require_access(request: Request) -> str:
    """Dependency: the IAP-verified email, or 403 if not on the allowlist."""
    user = current_user(request)
    if not _authorized(user):
        raise HTTPException(status_code=403, detail="You aren't authorized for the reprovision action.")
    return user


def _short(hostname: str) -> str:
    return hostname.split(".")[0]


def _readiness(w: Worker) -> dict[str, Any]:
    busy = (w.tc_latest_task_state or "").lower() in _ACTIVE_TASK_STATES
    quarantined = bool(w.tc_quarantined)
    is_m4 = (w.generation or "").lower() == "m4"

    if not quarantined and busy:
        status = "in service — running a task"
    elif quarantined and busy:
        status = "quarantined — draining (task still running)"
    elif quarantined and not busy:
        status = "quarantined & idle — ready to reprovision"
    else:
        status = "in service — idle"

    return {
        "status": status,
        "generation": w.generation,
        "worker_pool": w.worker_pool,
        "puppet_role": w.puppet_role,
        "mdm_enrollment": w.mdm_enrollment_status,
        "tc_state": w.tc_state,
        "quarantined": quarantined,
        "quarantine_until": w.tc_quarantine_until.isoformat() if w.tc_quarantine_until else None,
        "running_task": busy,
        "latest_task_id": w.tc_latest_task_id,
        "latest_task_state": w.tc_latest_task_state,
        # The EACS reprovision flow is Apple-Silicon (M4) only today.
        "supported": is_m4,
    }


def _plan(hostname: str) -> dict[str, Any]:
    short = _short(hostname)
    return {
        "one_command": f"reprovision run {short}",
        "from_wipe": [
            f"reprovision wipe {short}",
            f"reprovision wait-reenroll {short}",
            f"reprovision mint {short}",
            f"reprovision escrow-bst {short}",
            f"reprovision wait-sentinel {short}",
        ],
        "note": (
            "Run on the VPN — the SSH steps (mint/escrow/sentinel) can't run from Hangar. "
            "`run` stays quarantined unless you pass --unquarantine."
        ),
    }


def _recent_events(db: Session, hostname: str) -> list[dict[str, Any]]:
    rows = (
        db.query(ReprovisionEvent)
        .filter(ReprovisionEvent.hostname == hostname)
        .order_by(desc(ReprovisionEvent.created_at))
        .limit(10)
        .all()
    )
    return [
        {
            "user": e.user,
            "action": e.action,
            "detail": e.detail,
            "at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in rows
    ]


@router.get("/access")
def access(request: Request) -> dict[str, Any]:
    """Whether the caller may use the reprovision action (drives showing the panel)."""
    user = current_user(request)
    return {"user": user, "authorized": _authorized(user)}


@router.get("/{hostname:path}")
def status(hostname: str, user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    w = db.get(Worker, worker_fqdn(hostname))
    if not w:
        raise HTTPException(status_code=404, detail=f"Worker {hostname} not found")
    return {
        "hostname": w.hostname,
        "short": _short(w.hostname),
        "readiness": _readiness(w),
        "plan": _plan(w.hostname),
        "events": _recent_events(db, w.hostname),
    }


@router.post("/{hostname:path}/initiate")
def initiate(hostname: str, user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Record that an authorized user is kicking off a reprovision (audit ledger). Execution
    itself is the on-VPN CLI — Hangar can't SSH to the host — so this logs intent + who and
    returns the command to run."""
    w = db.get(Worker, worker_fqdn(hostname))
    if not w:
        raise HTTPException(status_code=404, detail=f"Worker {hostname} not found")
    cmd = f"reprovision run {_short(w.hostname)}"
    ev = ReprovisionEvent(
        hostname=w.hostname,
        user=user,
        action="initiated",
        detail=f"initiated from Hangar — run `{cmd}` on the VPN",
    )
    db.add(ev)
    db.commit()
    return {
        "ok": True,
        "user": user,
        "command": cmd,
        "at": ev.created_at.isoformat() if ev.created_at else None,
        "events": _recent_events(db, w.hostname),
    }
