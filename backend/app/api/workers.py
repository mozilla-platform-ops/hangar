"""Worker API endpoints."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any

import requests
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import asc, desc, func, nullslast
from sqlalchemy.orm import Session

from .. import cache
from ..config import settings
from ..database import get_db
from .fleet import DEFAULT_BRANCH
from ..hosts import worker_fqdn
from ..models import FailureEvent, SyncLog, Worker

router = APIRouter(prefix="/workers", tags=["workers"])

# A terminal task's artifacts never change, so screenshot lookups are cached hard.
_SHOTS_TTL = 6 * 3600
_UA = {"User-Agent": "relops-dashboard/1.0"}


def _task_screenshots(task_id: str) -> list[dict[str, str]]:
    """Failure-screenshot artifact links for a task's last run. Firefox test tasks upload these
    as public artifacts (public/test_info/mozilla-test-fail-screenshot_*.png, contentType
    image/png), so the URLs are directly loadable in the browser — no proxy/auth needed.
    Cached (immutable once the task is terminal)."""
    def _fetch() -> list[dict[str, str]]:
        base = settings.tc_root_url.rstrip("/")
        try:
            st = requests.get(f"{base}/api/queue/v1/task/{task_id}/status", timeout=6, headers=_UA)
            runs = ((st.json().get("status") or {}).get("runs") or []) if st.ok else []
        except Exception:
            return []
        if not runs:
            return []
        run_id = runs[-1].get("runId", 0)  # the recorded failure is the last run
        try:
            r = requests.get(f"{base}/api/queue/v1/task/{task_id}/runs/{run_id}/artifacts", timeout=6, headers=_UA)
            arts = r.json().get("artifacts", []) if r.ok else []
        except Exception:
            return []
        shots = []
        for a in arts:
            name = a.get("name", "")
            if a.get("contentType") == "image/png" and "screenshot" in name.lower():
                shots.append({
                    "name": name.rsplit("/", 1)[-1],
                    "url": f"{base}/api/queue/v1/task/{task_id}/runs/{run_id}/artifacts/{name}",
                })
        return shots
    return cache.swr(f"task-shots:{task_id}", _SHOTS_TTL, _fetch)

# Sources whose presence we surface per worker. Maps the UI key -> SyncLog source.
_FOUND_SOURCES = {"puppet": "puppet", "mdm": "simplemdm", "tc": "taskcluster"}


def _source_cutoffs(db: Session) -> dict[str, datetime | None]:
    """Start time of each source's most recent *completed successful* sync.

    A worker is "found in" a source when its ``last_synced_<source>`` is at or
    after that cutoff — i.e. the source reported it in its latest run. A host
    that dropped out of a source keeps an older timestamp from a prior run and
    so reads as not-found, without needing any new column.
    """
    cutoffs: dict[str, datetime | None] = {}
    for source in set(_FOUND_SOURCES.values()):
        row = (
            db.query(SyncLog.started_at)
            .filter(SyncLog.source == source, SyncLog.success == True, SyncLog.finished_at != None)  # noqa: E711,E712
            .order_by(SyncLog.finished_at.desc())
            .first()
        )
        cutoffs[source] = row[0] if row else None
    return cutoffs


def _found_in(w: Worker, cutoffs: dict[str, datetime | None]) -> dict[str, bool]:
    stamps = {
        "puppet": w.last_synced_puppet,
        "mdm": w.last_synced_mdm,
        "tc": w.last_synced_tc,
    }
    return {
        key: bool(stamps[key] and (c := cutoffs.get(src)) and stamps[key] >= c)
        for key, src in _FOUND_SOURCES.items()
    }


def _worker_to_dict(w: Worker, cutoffs: dict[str, datetime | None]) -> dict[str, Any]:
    return {
        "found_in": _found_in(w, cutoffs),
        "hostname": w.hostname,
        "worker_id": w.worker_id,
        "generation": w.generation,
        "platform": w.platform,
        "worker_pool": w.worker_pool,
        "puppet_role": w.puppet_role,
        "state": w.effective_state,
        "kvm": w.sheet_kvm,
        "loaner_assignee": w.sheet_loaner_assignee,
        "notes": w.dashboard_notes or w.sheet_notes,
        "dashboard_notes": w.dashboard_notes,
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
            "branch": w.branch,
            "git_version": w.git_version,
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
    branch: str | None = Query(None),
    search: str | None = Query(None),
    limit: int = Query(500, le=2000),
    offset: int = Query(0),
    sort_by: str = Query("hostname"),
    sort_dir: str = Query("asc"),
) -> dict[str, Any]:
    _SORTABLE = {
        "hostname": Worker.hostname,
        "generation": Worker.generation,
        "worker_pool": Worker.worker_pool,
        "os_version": Worker.os_version,
        "tc_last_active": Worker.tc_last_active,
        "tc_state": Worker.tc_state,
        "mdm_enrollment_status": Worker.mdm_enrollment_status,
    }

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
    if branch == "set":
        # workers pinned to a non-default branch — mirrors fleet._is_branch_override
        q = q.filter(
            Worker.branch.isnot(None),
            Worker.branch != "",
            func.lower(Worker.branch) != DEFAULT_BRANCH.lower(),
        )
    if search:
        like = f"%{search}%"
        q = q.filter(Worker.hostname.ilike(like) | Worker.serial_number.ilike(like))

    total = q.count()
    sort_col = _SORTABLE.get(sort_by, Worker.hostname)
    order = nullslast(desc(sort_col)) if sort_dir == "desc" else nullslast(asc(sort_col))
    workers = q.order_by(order).offset(offset).limit(limit).all()
    cutoffs = _source_cutoffs(db)
    return {"total": total, "workers": [_worker_to_dict(w, cutoffs) for w in workers]}


@router.patch("/{hostname:path}/notes")
def update_notes(hostname: str, db: Session = Depends(get_db), notes: str | None = Body(None, embed=True)) -> dict[str, Any]:
    fqdn = worker_fqdn(hostname)
    worker = db.get(Worker, fqdn)
    if not worker:
        raise HTTPException(status_code=404, detail=f"Worker {fqdn} not found")
    worker.dashboard_notes = notes or None
    db.commit()
    return _worker_to_dict(worker, _source_cutoffs(db))


# Declared before the /{hostname:path} catch-all GET so it isn't matched as a hostname.
@router.get("/{hostname:path}/failure-screenshots")
def failure_screenshots(
    hostname: str, db: Session = Depends(get_db), limit: int = Query(8, ge=1, le=25)
) -> dict[str, Any]:
    """Recent failed tasks for this host that produced a failure screenshot, newest first —
    each with a directly-loadable PNG link. Powers the worker page's failure-screenshot view
    (post-hoc evidence with zero load on the worker, unlike the live VNC path)."""
    fqdn = worker_fqdn(hostname)
    events = (
        db.query(FailureEvent)
        .filter(FailureEvent.hostname == fqdn)
        .order_by(desc(FailureEvent.failed_at))
        .limit(limit)
        .all()
    )
    base = settings.tc_root_url.rstrip("/")
    shots_by_task: dict[str, list[dict[str, str]]] = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for e, shots in zip(events, ex.map(lambda ev: _task_screenshots(ev.task_id), events)):
            shots_by_task[e.task_id] = shots

    failures = []
    for e in events:  # preserve newest-first order
        shots = shots_by_task.get(e.task_id) or []
        if not shots:
            continue
        failures.append({
            "task_id": e.task_id,
            "task_name": e.task_name,
            "state": e.state,
            "failed_at": e.failed_at.isoformat() if e.failed_at else None,
            "task_url": f"{base}/tasks/{e.task_id}",
            "screenshots": shots,
        })
    return {"hostname": fqdn, "failures": failures}


@router.get("/{hostname:path}")
def get_worker(hostname: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    # Accept both short and FQDN
    fqdn = worker_fqdn(hostname)
    worker = db.get(Worker, fqdn)
    if not worker:
        raise HTTPException(status_code=404, detail=f"Worker {fqdn} not found")
    return _worker_to_dict(worker, _source_cutoffs(db))
