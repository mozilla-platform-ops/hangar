"""Worker API endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Worker

router = APIRouter(prefix="/workers", tags=["workers"])


def _worker_to_dict(w: Worker) -> dict[str, Any]:
    return {
        "hostname": w.hostname,
        "worker_id": w.worker_id,
        "generation": w.generation,
        "worker_pool": w.worker_pool,
        "puppet_role": w.puppet_role,
        "state": w.effective_state,
        "kvm": w.sheet_kvm,
        "loaner_assignee": w.sheet_loaner_assignee,
        "notes": w.sheet_notes,
        "mdm": {
            "id": w.mdm_id,
            "name": w.mdm_name,
            "serial_number": w.serial_number,
            "os_version": w.os_version,
            "enrollment_status": w.mdm_enrollment_status,
            "groups": w.mdm_groups,
            "safari_driver": w.safari_driver,
            "video_dongle": w.video_dongle,
            "worker_config": w.worker_config,
            "refresh_hz": w.refresh_hz,
            "resolution": w.resolution,
        },
        "tc": {
            "worker_id": w.tc_worker_id,
            "worker_group": w.tc_worker_group,
            "state": w.tc_state,
            "last_active": w.tc_last_active.isoformat() if w.tc_last_active else None,
            "quarantined": w.tc_quarantined,
            "quarantine_until": w.tc_quarantine_until.isoformat() if w.tc_quarantine_until else None,
            "first_claim": w.tc_first_claim.isoformat() if w.tc_first_claim else None,
            "latest_task_id": w.tc_latest_task_id,
            "latest_task_state": w.tc_latest_task_state,
            "worker_pool_id": w.tc_worker_pool_id,
        },
        "sync": {
            "puppet": w.last_synced_puppet.isoformat() if w.last_synced_puppet else None,
            "mdm": w.last_synced_mdm.isoformat() if w.last_synced_mdm else None,
            "tc": w.last_synced_tc.isoformat() if w.last_synced_tc else None,
            "sheet": w.last_synced_sheet.isoformat() if w.last_synced_sheet else None,
        },
        "updated_at": w.updated_at.isoformat() if w.updated_at else None,
    }


@router.get("")
def list_workers(
    db: Session = Depends(get_db),
    generation: str | None = Query(None),
    state: str | None = Query(None),
    worker_pool: str | None = Query(None),
    tc_quarantined: bool | None = Query(None),
    mdm_enrollment: str | None = Query(None),
    search: str | None = Query(None),
    limit: int = Query(500, le=2000),
    offset: int = Query(0),
) -> dict[str, Any]:
    q = db.query(Worker)

    if generation:
        q = q.filter(Worker.generation == generation)
    if state:
        if state == "production":
            # production = explicit sheet state OR inferred (in TC pool or has puppet role)
            q = q.filter(
                (Worker.sheet_state == "production") |
                (Worker.sheet_state == None) & (  # noqa: E711
                    (Worker.tc_worker_pool_id != None) | (Worker.puppet_role != None)  # noqa: E711
                )
            )
        else:
            q = q.filter(Worker.sheet_state == state)
    if worker_pool:
        q = q.filter(Worker.worker_pool == worker_pool)
    if tc_quarantined is not None:
        q = q.filter(Worker.tc_quarantined == tc_quarantined)
    if mdm_enrollment:
        q = q.filter(Worker.mdm_enrollment_status == mdm_enrollment)
    if search:
        like = f"%{search}%"
        q = q.filter(Worker.hostname.ilike(like) | Worker.serial_number.ilike(like))

    total = q.count()
    workers = q.order_by(Worker.hostname).offset(offset).limit(limit).all()
    return {"total": total, "workers": [_worker_to_dict(w) for w in workers]}


@router.get("/{hostname:path}")
def get_worker(hostname: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    # Accept both short and FQDN
    fqdn = hostname if "." in hostname else f"{hostname}.test.releng.mdc1.mozilla.com"
    worker = db.get(Worker, fqdn)
    if not worker:
        raise HTTPException(status_code=404, detail=f"Worker {fqdn} not found")
    return _worker_to_dict(worker)
