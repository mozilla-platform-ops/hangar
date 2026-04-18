"""Fleet summary and consolidation endpoints."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Any

import requests
from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import Alert, FailureEvent, SyncLog, Worker
from ..sync.taskcluster import MAC_WORKER_POOLS

router = APIRouter(prefix="/fleet", tags=["fleet"])

DEFAULT_BRANCH = "master"


def _classify_source(routes_json: str | None) -> str:
    if not routes_json:
        return "other"
    try:
        routes = json.loads(routes_json)
    except (ValueError, TypeError):
        return "other"
    joined = " ".join(routes)
    if ".try." in joined:
        return "try"
    if ".autoland." in joined or ".integration." in joined:
        return "autoland"
    if ".releases." in joined or ".release." in joined:
        return "release"
    if ".mozilla-central." in joined:
        return "mozilla-central"
    if ".mozilla-beta." in joined or ".mozilla-esr" in joined:
        return "release"
    return "other"


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
    quarantined_non_staging = 0
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

        if w.tc_quarantined and state != "staging":
            quarantined_non_staging += 1

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
            "quarantined_non_staging": quarantined_non_staging,
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
                "running_tasks": 0,
                "healthy": 0,
                "running_sources": {},
                "_owners": {},
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

        if (w.tc_latest_task_state or "").upper() == "RUNNING":
            p["running_tasks"] += 1

        # Running task source + owner tracking
        if w.tc_latest_task_state == "running":
            source = _classify_source(w.tc_latest_task_routes)
            p["running_sources"][source] = p["running_sources"].get(source, 0) + 1
            if w.tc_latest_task_owner:
                p["_owners"][w.tc_latest_task_owner] = p["_owners"].get(w.tc_latest_task_owner, 0) + 1

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
        p["top_owners"] = sorted(
            [{"email": email, "count": cnt} for email, cnt in p["_owners"].items()],
            key=lambda x: x["count"],
            reverse=True,
        )[:5]
        del p["_owners"]
        result.append(p)

    result.sort(key=lambda x: x["total"], reverse=True)
    return {"pools": result}


def _fetch_pending_count(provisioner_id: str, worker_type: str) -> tuple[str, int | None]:
    try:
        resp = requests.get(
            f"{settings.tc_root_url}/api/queue/v1/pending/{provisioner_id}/{worker_type}",
            timeout=5,
            headers={"User-Agent": "relops-dashboard/1.0"},
        )
        if resp.ok:
            return worker_type, resp.json().get("pendingTasks", 0)
    except Exception:
        pass
    return worker_type, None


@router.get("/pending-counts")
def pending_counts() -> dict[str, Any]:
    """Live pending task counts from TC Queue API for all monitored pools."""
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(_fetch_pending_count, p, w): w for p, w in MAC_WORKER_POOLS}
        results: dict[str, int | None] = {}
        for fut in as_completed(futures):
            worker_type, count = fut.result()
            results[worker_type] = count
    return {"pending_counts": results}


@router.get("/pool-sources")
def pool_sources(pool: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Sample running tasks for a pool to determine job source (project/tree) breakdown."""
    task_ids: list[str] = [
        row[0] for row in db.query(Worker.tc_latest_task_id)
        .filter(
            Worker.worker_pool == pool,
            Worker.tc_latest_task_id.isnot(None),
        )
        .filter(Worker.tc_latest_task_state.ilike("running"))
        .limit(60)
        .all()
        if row[0]
    ]

    if not task_ids:
        return {"pool": pool, "sample_size": 0, "by_project": {}, "by_user": {}}

    def _scheduler_project(scheduler_id: str) -> str:
        if "level-3" in scheduler_id:
            return "autoland"
        if "level-1" in scheduler_id:
            return "try"
        if "github" in scheduler_id:
            return "github"
        return "other"

    def _fetch(task_id: str) -> dict[str, str]:
        url = f"{settings.tc_root_url}/api/queue/v1/task/{task_id}"
        try:
            r = requests.get(url, timeout=4, headers={"User-Agent": "relops-dashboard/1.0"})
            if r.ok:
                d = r.json()
                tags = d.get("tags") or {}
                project = tags.get("project") or _scheduler_project(d.get("schedulerId", ""))
                user = tags.get("createdForUser") or ""
                return {"project": project, "user": user}
        except Exception:
            pass
        return {"project": "unknown", "user": ""}

    by_project: dict[str, int] = {}
    by_user: dict[str, int] = {}

    with ThreadPoolExecutor(max_workers=20) as ex:
        for meta in [f.result() for f in [ex.submit(_fetch, tid) for tid in task_ids]]:
            p = meta["project"] or "unknown"
            by_project[p] = by_project.get(p, 0) + 1
            if meta["user"]:
                by_user[meta["user"]] = by_user.get(meta["user"], 0) + 1

    return {
        "pool": pool,
        "sample_size": len(task_ids),
        "by_project": dict(sorted(by_project.items(), key=lambda x: x[1], reverse=True)),
        "by_user": dict(sorted(by_user.items(), key=lambda x: x[1], reverse=True)[:10]),
    }


@router.get("/failures")
def failure_insights(days: int = 7, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Top failing machines and test task types over the last N days."""
    from sqlalchemy import desc
    cutoff = datetime.utcnow() - timedelta(days=days)

    machine_rows = (
        db.query(
            FailureEvent.hostname,
            FailureEvent.worker_pool,
            func.count(FailureEvent.id).label("cnt"),
            func.max(FailureEvent.failed_at).label("last_at"),
        )
        .filter(FailureEvent.failed_at >= cutoff)
        .group_by(FailureEvent.hostname, FailureEvent.worker_pool)
        .order_by(desc("cnt"))
        .limit(10)
        .all()
    )

    test_rows = (
        db.query(
            FailureEvent.task_name,
            func.count(FailureEvent.id).label("cnt"),
            func.max(FailureEvent.failed_at).label("last_at"),
        )
        .filter(
            FailureEvent.failed_at >= cutoff,
            FailureEvent.state == "failed",
            FailureEvent.task_name.isnot(None),
        )
        .group_by(FailureEvent.task_name)
        .order_by(desc("cnt"))
        .limit(10)
        .all()
    )

    def _fmt(dt: datetime | None) -> str | None:
        return dt.isoformat() if dt else None

    return {
        "machine_failures": [
            {
                "hostname": r.hostname,
                "short_hostname": r.hostname.split(".")[0],
                "worker_pool": r.worker_pool,
                "count": r.cnt,
                "last_at": _fmt(r.last_at),
            }
            for r in machine_rows
        ],
        "test_failures": [
            {"task_name": r.task_name, "count": r.cnt, "last_at": _fmt(r.last_at)}
            for r in test_rows
        ],
        "window_days": days,
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
