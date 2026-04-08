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

DEFAULT_BRANCH = "master"


def _is_branch_override(branch: str | None) -> bool:
    """Return True only if the branch is set and differs from the default."""
    return bool(branch and branch.lower() != DEFAULT_BRANCH.lower())


@router.get("/summary")
def fleet_summary(db: Session = Depends(get_db)) -> dict[str, Any]:
    workers = db.query(Worker).all()
    now = datetime.utcnow()
    threshold_24h = now - timedelta(hours=24)

    # Counts by generation
    by_generation: dict[str, int] = {}
    by_state: dict[str, int] = {}
    by_pool: dict[str, int] = {}
    by_os: dict[str, int] = {}

    mdm_unenrolled = 0
    branch_by_branch: dict[str, int] = {}
    branch_by_pool: dict[str, int] = {}
    branch_total = 0

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

        if _is_branch_override(w.branch):
            branch_total += 1
            branch_by_branch[w.branch] = branch_by_branch.get(w.branch, 0) + 1  # type: ignore[index]
            branch_by_pool[pool] = branch_by_pool.get(pool, 0) + 1

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
        "branch_overrides": {
            "total": branch_total,
            "by_branch": branch_by_branch,
            "by_pool": branch_by_pool,
        },
        "sync_status": sync_status,
    }


@router.get("/pools")
def pool_health(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Per-pool health metrics with staleness breakdown."""
    now = datetime.utcnow()
    t_24h  = now - timedelta(hours=24)
    t_7d   = now - timedelta(days=7)
    t_30d  = now - timedelta(days=30)

    workers = db.query(Worker).all()

    pools: dict[str, dict] = {}

    for w in workers:
        pool = w.worker_pool or "unknown"
        if pool not in pools:
            pools[pool] = {
                "name": pool,
                "generation": w.generation,
                "total": 0,
                "production": 0,
                "quarantined": 0,
                "mdm_unenrolled": 0,
                "active_24h": 0,
                "stale_1_7d": 0,
                "stale_7_30d": 0,
                "stale_30d_plus": 0,
                "never_seen": 0,
                "branch_override_count": 0,
                "healthy": 0,
            }

        p = pools[pool]
        p["total"] += 1

        state = w.effective_state
        is_production = state == "production"
        if is_production:
            p["production"] += 1

        if w.tc_quarantined:
            p["quarantined"] += 1

        if w.mdm_enrollment_status == "unenrolled":
            p["mdm_unenrolled"] += 1

        if _is_branch_override(w.branch):
            p["branch_override_count"] += 1

        # Staleness bucket
        la = w.tc_last_active
        if la is None:
            p["never_seen"] += 1
        elif la >= t_24h:
            p["active_24h"] += 1
        elif la >= t_7d:
            p["stale_1_7d"] += 1
        elif la >= t_30d:
            p["stale_7_30d"] += 1
        else:
            p["stale_30d_plus"] += 1

        # Fully healthy: production + enrolled + not quarantined + active <24h
        if (
            is_production
            and w.mdm_enrollment_status == "enrolled"
            and not w.tc_quarantined
            and la is not None
            and la >= t_24h
        ):
            p["healthy"] += 1

    result = []
    for p in pools.values():
        prod = p["production"]
        p["health_score"] = round(p["healthy"] / prod, 3) if prod > 0 else 0.0
        result.append(p)

    result.sort(key=lambda x: x["total"], reverse=True)
    return {"pools": result}


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
