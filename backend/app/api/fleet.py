"""Fleet summary and consolidation endpoints."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Alert, SyncLog, Worker

router = APIRouter(prefix="/fleet", tags=["fleet"])


@router.get("/summary")
def fleet_summary(db: Session = Depends(get_db)) -> dict[str, Any]:
    workers = db.query(Worker).all()

    # Counts by generation
    by_generation: dict[str, int] = {}
    by_state: dict[str, int] = {}
    by_pool: dict[str, int] = {}
    by_os: dict[str, int] = {}

    mdm_unenrolled = 0

    for w in workers:
        gen = w.generation or "unknown"
        by_generation[gen] = by_generation.get(gen, 0) + 1

        state = w.effective_state
        by_state[state] = by_state.get(state, 0) + 1

        pool = w.worker_pool or "unknown"
        by_pool[pool] = by_pool.get(pool, 0) + 1

        os = w.os_version or "unknown"
        by_os[os] = by_os.get(os, 0) + 1

        if w.mdm_enrollment_status == "unenrolled":
            mdm_unenrolled += 1

    # Read alert counts directly from the alerts table — single source of truth
    def _active_alert_count(alert_type: str) -> int:
        return (
            db.query(func.count(Alert.id))
            .filter(Alert.alert_type == alert_type, Alert.resolved_at == None)  # noqa: E711
            .scalar() or 0
        )

    quarantined = _active_alert_count("quarantined")
    missing_from_tc = _active_alert_count("missing_from_tc")

    # Sync status
    sync_status = {}
    for source in ("puppet", "simplemdm", "taskcluster", "sheets"):
        last = (
            db.query(SyncLog)
            .filter(SyncLog.source == source, SyncLog.success == True)  # noqa: E712
            .order_by(SyncLog.finished_at.desc())
            .first()
        )
        sync_status[source] = {
            "last_success": last.finished_at.isoformat() if last and last.finished_at else None,
            "records_updated": last.records_updated if last else None,
        }

    return {
        "total_workers": len(workers),
        "by_generation": by_generation,
        "by_state": by_state,
        "by_pool": by_pool,
        "by_os": by_os,
        "alerts": {
            "quarantined": quarantined,
            "missing_from_tc": missing_from_tc,
            "mdm_unenrolled": mdm_unenrolled,
        },
        "sync_status": sync_status,
    }


@router.get("/consolidation")
def consolidation_analysis(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Analyze r8 vs m4 capacity and retirement candidates."""
    now = datetime.utcnow()
    stale_threshold = now - timedelta(days=30)

    r8_workers = db.query(Worker).filter(Worker.generation == "r8").all()
    m4_workers = db.query(Worker).filter(Worker.generation == "m4").all()

    def _summarize(workers: list[Worker]) -> dict[str, Any]:
        by_state: dict[str, int] = {}
        by_pool: dict[str, int] = {}
        inactive_30d: list[str] = []
        for w in workers:
            s = w.effective_state
            by_state[s] = by_state.get(s, 0) + 1
            p = w.worker_pool or "unknown"
            by_pool[p] = by_pool.get(p, 0) + 1
            if w.tc_last_active and w.tc_last_active < stale_threshold:
                inactive_30d.append(w.hostname)
        return {
            "total": len(workers),
            "by_state": by_state,
            "by_pool": by_pool,
            "inactive_30d_count": len(inactive_30d),
            "inactive_30d_sample": inactive_30d[:20],
        }

    # Retirement candidates: r8 workers that are defective, spare, or inactive >30d
    retirement_candidates = [
        w.hostname for w in r8_workers
        if w.effective_state in ("defective", "spare") or (w.tc_last_active and w.tc_last_active < stale_threshold)
    ]

    return {
        "r8": _summarize(r8_workers),
        "m4": _summarize(m4_workers),
        "retirement_candidates": retirement_candidates[:50],
        "retirement_candidate_count": len(retirement_candidates),
        "analysis": {
            "r8_production_count": sum(1 for w in r8_workers if w.effective_state == "production"),
            "m4_production_count": sum(1 for w in m4_workers if w.effective_state == "production"),
            "r8_safe_to_retire_estimate": len([w for w in r8_workers if w.effective_state in ("defective", "spare")]),
        },
    }
