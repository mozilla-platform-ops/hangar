"""
Worker live-view (VNC screenshots).

Cloud Run can't reach MDC1, so it can't VNC to a worker directly — same constraint as
reprovision. So: the frontend bumps `requested_at` (only while someone is watching a host);
the on-network agent polls pending requests, grabs ONE passive VNC frame (admin account,
~3s hold, no input injected — safe on a busy worker), and pushes the JPEG back. We keep
only the latest frame per host.

Auth reuses reprovision's: IAP allowlist for viewers, mTLS client cert for the agent.
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..hosts import worker_fqdn
from ..models import Worker, WorkerScreenshot
from .reprovision import _short, require_access, require_runner

router = APIRouter(prefix="/screen", tags=["screen"])

# A viewer's request keeps a host "watched" for this long after the last poll.
_REQUEST_TTL = timedelta(seconds=45)
# The agent re-captures a watched host once its frame is older than this (the effective rate limit).
_CAPTURE_STALE = timedelta(seconds=15)
# Frames older than this are considered stale and not served (viewer sees "no recent frame").
_FRESH = timedelta(minutes=5)


def _row(db: Session, hostname: str) -> WorkerScreenshot | None:
    return db.get(WorkerScreenshot, worker_fqdn(hostname))


@router.post("/{hostname:path}/request")
def request_capture(hostname: str, user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Viewer asks for a fresh frame (called while the live-view card is open). Just marks the
    host watched; the on-network agent does the actual capture on its next poll."""
    w = db.get(Worker, worker_fqdn(hostname))
    if not w:
        raise HTTPException(status_code=404, detail=f"Worker {hostname} not found")
    row = db.get(WorkerScreenshot, w.hostname)
    if row is None:
        row = WorkerScreenshot(hostname=w.hostname)
        db.add(row)
    row.requested_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@router.get("/{hostname:path}/latest")
def latest(hostname: str, user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Latest frame for a host as a data URL + capture time (null if none/stale)."""
    row = _row(db, hostname)
    fresh = bool(row and row.image and row.captured_at and datetime.utcnow() - row.captured_at < _FRESH)
    return {
        "hostname": worker_fqdn(hostname),
        "short": _short(worker_fqdn(hostname)),
        "captured_at": row.captured_at.isoformat() if (row and row.captured_at) else None,
        "data_url": (
            f"data:{row.content_type};base64,{base64.b64encode(row.image).decode()}" if fresh else None
        ),
    }


# ── Agent endpoints (mTLS client cert, same as the reprovision runner) ──────────────────────

@router.get("/requests")
def pending(runner: str = Depends(require_runner), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Hosts a viewer is currently watching whose frame is missing/stale — the agent captures
    these (FQDNs, so the agent can VNC straight to them)."""
    now = datetime.utcnow()
    rows = db.execute(select(WorkerScreenshot)).scalars().all()
    hosts = [
        r.hostname
        for r in rows
        if r.requested_at
        and now - r.requested_at < _REQUEST_TTL
        and (r.captured_at is None or now - r.captured_at > _CAPTURE_STALE)
    ]
    return {"hosts": hosts}


@router.post("/{hostname:path}/frame")
async def upload_frame(
    hostname: str, request: Request, runner: str = Depends(require_runner), db: Session = Depends(get_db)
) -> dict[str, Any]:
    """Agent uploads a captured JPEG (raw body). Stores it as the latest frame for the host."""
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty frame")
    fqdn = worker_fqdn(hostname)
    row = db.get(WorkerScreenshot, fqdn)
    if row is None:
        row = WorkerScreenshot(hostname=fqdn)
        db.add(row)
    row.image = body
    row.content_type = request.headers.get("content-type", "image/jpeg")
    row.captured_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "bytes": len(body)}
