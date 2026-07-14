"""Fleet summary and consolidation endpoints."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Any

import requests
from fastapi import APIRouter, Depends
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .. import cache
from ..config import settings
from ..database import SessionLocal, get_db
from ..models import Alert, FailureEvent, PoolLoadSample, SyncLog, Worker
from ..sync.taskcluster import HW_WORKER_POOLS

# Job-source sampling is served through the SWR cache so page loads never block on
# live Taskcluster fan-out; a task's project/user is immutable, so it's cached too.
_POOL_SOURCES_TTL = 90

HW_POOL_PROVISIONERS: dict[str, str] = {worker_type: provisioner for provisioner, worker_type in HW_WORKER_POOLS}
LINUX_CLOUD_EXCLUDED_PROVISIONERS = {"releng-hardware", "proj-autophone"}
LINUX_CLOUD_WORKER_MATCH = "linux"

# Used only if live worker-type discovery is unavailable.
FALLBACK_LINUX_CLOUD_WORKER_POOLS: list[tuple[str, str]] = [
    ("app-services-1", "b-linux"),
    ("app-services-3", "b-linux"),
    ("code-analysis-1", "linux-gw-gcp"),
    ("code-analysis-3", "linux-gw-gcp"),
    ("comm-1", "b-linux"),
    ("comm-3", "b-linux"),
    ("comm-3", "b-linux-docker-amd"),
    ("comm-3", "b-linux-docker-large-amd"),
    ("comm-3", "b-linux-docker-xlarge-amd"),
    ("comm-t", "t-linux-docker-amd"),
    ("comm-t", "t-linux-docker-noscratch-amd"),
    ("enterprise-1", "b-linux"),
    ("enterprise-1", "b-linux-docker-amd"),
    ("enterprise-1", "b-linux-docker-large-amd"),
    ("enterprise-1", "b-linux-docker-xlarge-amd"),
    ("enterprise-3", "b-linux"),
    ("enterprise-3", "b-linux-docker-amd"),
    ("enterprise-3", "b-linux-docker-large-amd"),
    ("enterprise-3", "b-linux-docker-xlarge-amd"),
    ("enterprise-t", "t-linux-docker-16c32gb-amd"),
    ("enterprise-t", "t-linux-docker-amd"),
    ("enterprise-t", "t-linux-docker-noscratch-amd"),
    ("gecko-1", "b-linux"),
    ("gecko-1", "b-linux-aarch64"),
    ("gecko-1", "b-linux-docker-amd"),
    ("gecko-1", "b-linux-docker-large-amd"),
    ("gecko-1", "b-linux-docker-xlarge-amd"),
    ("gecko-1", "b-linux-kvm"),
    ("gecko-1", "b-linux-medium"),
    ("gecko-3", "b-linux"),
    ("gecko-3", "b-linux-docker-amd"),
    ("gecko-3", "b-linux-docker-large-amd"),
    ("gecko-3", "b-linux-docker-xlarge-amd"),
    ("gecko-3", "b-linux-kvm"),
    ("gecko-3", "b-linux-medium"),
    ("gecko-3", "b-linux-xlarge"),
    ("gecko-t", "t-linux-2204-wayland"),
    ("gecko-t", "t-linux-2204-wayland-snap"),
    ("gecko-t", "t-linux-2404-wayland-snap"),
    ("gecko-t", "t-linux-arm64-docker"),
    ("gecko-t", "t-linux-docker"),
    ("gecko-t", "t-linux-docker-16c32gb-amd"),
    ("gecko-t", "t-linux-docker-amd"),
    ("gecko-t", "t-linux-docker-kvm"),
    ("gecko-t", "t-linux-docker-noscratch"),
    ("gecko-t", "t-linux-docker-noscratch-amd"),
    ("gecko-t", "t-linux-vm-2204-wayland"),
    ("gecko-t", "t-linux-xlarge-2204-wayland"),
    ("glean-1", "b-linux"),
    ("mobile-1", "b-linux"),
    ("mobile-3", "b-linux"),
    ("mozilla-t", "t-linux-2204-wayland"),
    ("mozilla-t", "t-linux-2404-wayland"),
    ("mozilla-t", "t-linux-2404-wayland-relsre"),
    ("mozilla-t", "t-linux-docker"),
    ("mozilla-t", "t-linux-docker-noscratch"),
    ("mozillavpn-1", "b-linux"),
    ("mozillavpn-1", "b-linux-large"),
    ("mozillavpn-3", "b-linux"),
    ("mozillavpn-3", "b-linux-large"),
    ("nss-1", "linux-docker"),
    ("nss-t", "t-linux-docker"),
    ("releng-1", "linux-docker"),
    ("releng-3", "linux-docker"),
    ("releng-t", "linux-docker"),
    ("taskgraph-t", "linux-docker"),
    ("translations-1", "b-linux-large-gcp-d2g"),
    ("xpi-1", "b-linux"),
]

ANDROID_WORKER_POOLS: list[tuple[str, str]] = [
    ("proj-autophone", "gecko-t-bitbar-gw-perf-a55"),
    ("proj-autophone", "gecko-t-bitbar-gw-perf-p6"),
    ("proj-autophone", "gecko-t-bitbar-gw-perf-s24"),
    ("proj-autophone", "gecko-t-bitbar-gw-unit-p5"),
    ("proj-autophone", "gecko-t-lambda-alpha-a55"),
    ("proj-autophone", "gecko-t-lambda-perf-a55"),
    ("proj-autophone", "gecko-t-lambda-test-1"),
]

router = APIRouter(prefix="/fleet", tags=["fleet"])

DEFAULT_BRANCH = "master"

# Pools that no longer exist in Taskcluster but still linger in MDM/sheet
# metadata on a stray worker or two (e.g. a mini whose pool label wasn't
# cleared when the pool was retired). Hidden from all pool views.
DECOMMISSIONED_POOLS = {"gecko-1-b-osx-arm64-vms-host"}


def _is_branch_override(branch: str | None) -> bool:
    """Return True only if the branch is set and differs from the default."""
    return bool(branch and branch.lower() != DEFAULT_BRANCH.lower())


def _pool_provisioner(worker_pool: str, tc_worker_pool_id: str | None) -> str | None:
    if tc_worker_pool_id and "/" in tc_worker_pool_id:
        return tc_worker_pool_id.split("/", 1)[0]
    return HW_POOL_PROVISIONERS.get(worker_pool)


@router.get("/summary")
def fleet_summary(db: Session = Depends(get_db)) -> dict[str, Any]:
    workers = db.query(Worker).all()
    now = datetime.utcnow()
    threshold_24h = now - timedelta(hours=24)

    # Counts by generation
    by_generation: dict[str, int] = {}
    # Same, but only workers present in SimpleMDM (MDM is source of truth for hardware counts)
    by_generation_mdm: dict[str, int] = {}
    by_state: dict[str, int] = {}
    by_pool: dict[str, int] = {}
    by_os: dict[str, int] = {}

    mdm_unenrolled = 0
    quarantined_non_staging = 0
    mac_quarantined = 0
    branch_by_branch: dict[str, int] = {}
    branch_by_pool: dict[str, int] = {}
    branch_total = 0

    for w in workers:
        gen = w.generation or "unknown"
        by_generation[gen] = by_generation.get(gen, 0) + 1
        if w.mdm_id is not None:
            by_generation_mdm[gen] = by_generation_mdm.get(gen, 0) + 1

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
            if w.platform == "mac":
                mac_quarantined += 1

        if _is_branch_override(w.branch):
            branch_total += 1
            branch_by_branch[w.branch] = branch_by_branch.get(w.branch, 0) + 1  # type: ignore[index]
            # A retired pool label shouldn't surface as a pool name here.
            pool_key = "unknown" if pool in DECOMMISSIONED_POOLS else pool
            branch_by_pool[pool_key] = branch_by_pool.get(pool_key, 0) + 1

    # Read alert counts directly from the alerts table — single source of truth. Acknowledged
    # alerts are excluded: an acked alert is a known / not-a-real-problem (e.g. an inventoried
    # worker temporarily repurposed to run VMs), so it must not inflate the fleet-wide numbers.
    def _active_alert_count(alert_type: str) -> int:
        return (
            db.query(func.count(Alert.id))
            .filter(Alert.alert_type == alert_type, Alert.resolved_at == None, Alert.acknowledged == False)  # noqa: E711,E712
            .scalar() or 0
        )

    quarantined = _active_alert_count("quarantined")
    missing_from_tc = _active_alert_count("missing_from_tc")

    # macOS-hardware-scoped "missing from TC" (join the alert back to its worker's platform)
    mac_missing_from_tc = (
        db.query(func.count(Alert.id))
        .join(Worker, Worker.hostname == Alert.hostname)
        .filter(
            Alert.alert_type == "missing_from_tc",
            Alert.resolved_at == None,  # noqa: E711
            Alert.acknowledged == False,  # noqa: E712
            Worker.platform == "mac",
        )
        .scalar() or 0
    )

    # Sync status
    sync_status = {}
    for source in ("puppet", "windows_inventory", "simplemdm", "taskcluster", "sheets"):
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
        "by_generation_mdm": by_generation_mdm,
        "by_state": by_state,
        "by_pool": by_pool,
        "by_os": by_os,
        "alerts": {
            "quarantined": quarantined,
            "quarantined_non_staging": quarantined_non_staging,
            "missing_from_tc": missing_from_tc,
            "mdm_unenrolled": mdm_unenrolled,
        },
        "attention_mac": {
            "quarantined": mac_quarantined,
            "missing_from_tc": mac_missing_from_tc,
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
        if pool in DECOMMISSIONED_POOLS:
            continue  # retired pool lingering on a stray worker's metadata
        if pool not in pools:
            pools[pool] = {
                "name": pool,
                "provisioner": _pool_provisioner(pool, w.tc_worker_pool_id),
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
            }

        p = pools[pool]
        if not p.get("provisioner"):
            p["provisioner"] = _pool_provisioner(pool, w.tc_worker_pool_id)
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

        # Fully healthy: production + not quarantined + active <24h
        # MDM only disqualifies if explicitly unenrolled (linux workers have null MDM — not a disqualifier)
        if (
            is_production
            and w.mdm_enrollment_status != "unenrolled"
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


def _list_provisioners() -> list[str]:
    """List Taskcluster provisioners from TC Queue, following pagination."""
    provisioners: list[str] = []
    continuation_token: str | None = None

    while True:
        params: dict[str, str | int] = {"limit": 1000}
        if continuation_token:
            params["continuationToken"] = continuation_token

        try:
            resp = requests.get(
                f"{settings.tc_root_url}/api/queue/v1/provisioners",
                params=params,
                timeout=8,
                headers={"User-Agent": "relops-dashboard/1.0"},
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            return provisioners

        provisioners.extend(
            p["provisionerId"]
            for p in data.get("provisioners", [])
            if p.get("provisionerId")
        )

        continuation_token = data.get("continuationToken")
        if not continuation_token:
            break

    return provisioners


def _list_worker_types(provisioner: str) -> list[str]:
    """List worker types for a provisioner from TC Queue, following pagination."""
    worker_types: list[str] = []
    continuation_token: str | None = None

    while True:
        params: dict[str, str | int] = {"limit": 1000}
        if continuation_token:
            params["continuationToken"] = continuation_token

        try:
            resp = requests.get(
                f"{settings.tc_root_url}/api/queue/v1/provisioners/{provisioner}/worker-types",
                params=params,
                timeout=8,
                headers={"User-Agent": "relops-dashboard/1.0"},
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            return worker_types

        worker_types.extend(
            wt["workerType"]
            for wt in data.get("workerTypes", [])
            if wt.get("workerType")
        )

        continuation_token = data.get("continuationToken")
        if not continuation_token:
            break

    return worker_types


def _linux_cloud_worker_pools() -> list[tuple[str, str]]:
    """Discover all Linux cloud pools from non-hardware Taskcluster provisioners."""
    pools: set[tuple[str, str]] = set()
    provisioners = [
        provisioner
        for provisioner in _list_provisioners()
        if provisioner not in LINUX_CLOUD_EXCLUDED_PROVISIONERS
    ]

    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(_list_worker_types, provisioner): provisioner for provisioner in provisioners}
        for fut in as_completed(futures):
            provisioner = futures[fut]
            for worker_type in fut.result():
                if LINUX_CLOUD_WORKER_MATCH in worker_type.lower():
                    pools.add((provisioner, worker_type))

    if not pools:
        return FALLBACK_LINUX_CLOUD_WORKER_POOLS

    return sorted(pools, key=lambda p: (p[0], p[1]))


@router.get("/pending-counts")
def pending_counts() -> dict[str, Any]:
    """Live pending task counts from TC Queue API for all monitored hardware pools."""
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(_fetch_pending_count, p, w): w for p, w in HW_WORKER_POOLS}
        results: dict[str, int | None] = {}
        for fut in as_completed(futures):
            worker_type, count = fut.result()
            results[worker_type] = count
    return {"pending_counts": results}


@router.get("/load-history")
def load_history(hours: int = 48, include_series: bool = False, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Per-pool load time series from our local sampler — fast, no external calls.

    Returns a compact fleet-wide totals series (one point per sampler tick) plus the
    latest per-pool snapshot. Backed by the indexed pool_load_samples table so the
    dashboard stays snappy; Yardstick/Grafana remains the deep-history tool.
    """
    hours = max(1, min(hours, 24 * 14))
    since = datetime.utcnow() - timedelta(hours=hours)

    # Fleet-wide totals per tick, aggregated in SQL so we never materialize
    # hours × pools individual sample rows in Python.
    totals_rows = (
        db.query(
            PoolLoadSample.ts,
            func.sum(PoolLoadSample.pending).label("pending"),
            func.sum(PoolLoadSample.running).label("running"),
            func.count(PoolLoadSample.id).label("n"),
        )
        .filter(PoolLoadSample.ts >= since)
        .group_by(PoolLoadSample.ts)
        .order_by(PoolLoadSample.ts)
        .all()
    )
    totals = [
        {"ts": r.ts.isoformat(), "pending": int(r.pending or 0), "running": int(r.running or 0)}
        for r in totals_rows
    ]

    # Latest sample per pool within the window
    last_ts = (
        db.query(PoolLoadSample.pool, func.max(PoolLoadSample.ts).label("max_ts"))
        .filter(PoolLoadSample.ts >= since)
        .group_by(PoolLoadSample.pool)
        .subquery()
    )
    latest: dict[str, dict[str, Any]] = {}
    for r in (
        db.query(PoolLoadSample)
        .join(last_ts, (PoolLoadSample.pool == last_ts.c.pool) & (PoolLoadSample.ts == last_ts.c.max_ts))
        .all()
    ):
        latest[r.pool] = {
            "pool": r.pool,
            "pending": r.pending,
            "running": r.running,
            "capacity": r.capacity,
            "ts": r.ts.isoformat(),
        }

    # Optional compact per-pool series (parallel ts/pending/running arrays) for
    # sparklines. Tuple query, not ORM objects, to keep it light.
    pool_series: dict[str, dict[str, list[Any]]] = {}
    if include_series:
        for pool, ts, pending, running in (
            db.query(PoolLoadSample.pool, PoolLoadSample.ts, PoolLoadSample.pending, PoolLoadSample.running)
            .filter(PoolLoadSample.ts >= since)
            .order_by(PoolLoadSample.ts)
            .all()
        ):
            s = pool_series.setdefault(pool, {"ts": [], "pending": [], "running": []})
            s["ts"].append(ts.isoformat())
            s["pending"].append(pending)
            s["running"].append(running)

    out: dict[str, Any] = {
        "hours": hours,
        "since": since.isoformat(),
        "sample_count": int(sum(r.n for r in totals_rows)),
        "totals": totals,
        "pools": sorted(latest.values(), key=lambda x: (x["pending"] or 0), reverse=True),
    }
    if include_series:
        out["pool_series"] = pool_series
    return out


# ── Showcase: team-impact rollups for the Overview headliners ──────────────────

def _macos_axis(pool: str) -> str | None:
    """Classify a macOS test pool onto the Intel→Apple-Silicon migration axis.

    None means the pool isn't part of that migration story.
    """
    if "osx-1400-r8" in pool:    return "intel"     # Intel Sonoma — retiring
    if "osx-1015-r8" in pool:    return "catalina"  # Catalina — ESR-only, deprecating
    if "osx-1500-m-vms" in pool: return "m4_vm"     # Apple Silicon Tart VMs
    if "osx-1500-m4" in pool:    return "m4"         # Apple Silicon bare metal
    return None


# Pool-name fragments that place a pool on the migration axis — must stay in
# sync with _macos_axis above (used to pre-filter the SQL aggregation).
_MACOS_AXIS_FRAGMENTS = ("osx-1400-r8", "osx-1015-r8", "osx-1500-m-vms", "osx-1500-m4")


def _vm_pool_kind(pool: str) -> str | None:
    if "osx-1500-m-vms" in pool:  return "tester"
    if "b-osx-arm64-vms" in pool: return "builder"
    return None


@router.get("/showcase")
def fleet_showcase(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Team-impact rollups for the Overview showcase headliners.

    Entirely from the local DB + sampler (no external calls): fleet scale,
    the macOS Intel→Apple-Silicon migration load-shift, capacity efficiency,
    and the Tart VM fleet.
    """
    now = datetime.utcnow()
    t_24h = now - timedelta(hours=24)

    # ── Per-pool current state ──
    pools: dict[str, dict] = {}
    for w in db.query(Worker).all():
        pool = w.worker_pool or "unknown"
        p = pools.setdefault(pool, {"pool": pool, "workers": 0, "production": 0,
                                    "active_24h": 0, "running": 0, "quarantined": 0})
        p["workers"] += 1
        if w.effective_state == "production":
            p["production"] += 1
        if w.tc_quarantined:
            p["quarantined"] += 1
        if w.tc_last_active is not None and w.tc_last_active >= t_24h:
            p["active_24h"] += 1
        if (w.tc_latest_task_state or "").upper() == "RUNNING":
            p["running"] += 1
    total_workers = sum(p["workers"] for p in pools.values())

    # ── Latest per-pool pending/capacity from the sampler ──
    latest_sample: dict[str, PoolLoadSample] = {}
    for r in (db.query(PoolLoadSample)
                .filter(PoolLoadSample.ts >= now - timedelta(hours=3))
                .order_by(PoolLoadSample.ts).all()):
        latest_sample[r.pool] = r  # ascending → keeps the most recent
    for pool, p in pools.items():
        s = latest_sample.get(pool)
        p["pending"] = (s.pending or 0) if s else 0
        p["util"] = round(p["running"] / p["production"], 3) if p["production"] else 0.0

    # ── Worker-hours delivered: integrate running-workers over the sampled window ──
    # Aggregated in SQL (one row per tick + one per tick×migration-pool) instead of
    # loading every raw sample — this table grows by pools×288 rows a day.
    since_14d = now - timedelta(days=14)
    tick_rows = (db.query(PoolLoadSample.ts, func.sum(PoolLoadSample.running).label("running"))
                   .filter(PoolLoadSample.ts >= since_14d)
                   .group_by(PoolLoadSample.ts)
                   .order_by(PoolLoadSample.ts).all())
    ticks = [r.ts for r in tick_rows]
    CAP_H = 0.25  # cap per-tick interval at 15 min so sampler downtime doesn't inflate totals
    dt: dict[datetime, float] = {}
    for i, ts in enumerate(ticks):
        gap = (ticks[i + 1] - ts).total_seconds() / 3600.0 if i + 1 < len(ticks) else CAP_H
        dt[ts] = min(gap, CAP_H)
    fleet_hours = sum((r.running or 0) * dt[r.ts] for r in tick_rows)

    axis_rows = (db.query(PoolLoadSample.ts, PoolLoadSample.pool,
                          func.sum(PoolLoadSample.running).label("running"))
                   .filter(PoolLoadSample.ts >= since_14d,
                           or_(*[PoolLoadSample.pool.like(f"%{frag}%") for frag in _MACOS_AXIS_FRAGMENTS]))
                   .group_by(PoolLoadSample.ts, PoolLoadSample.pool).all())
    axis_hours: dict[str, float] = {}
    for r in axis_rows:
        axis = _macos_axis(r.pool)
        if axis:
            axis_hours[axis] = axis_hours.get(axis, 0.0) + (r.running or 0) * dt.get(r.ts, 0.0)
    window_hours = round((ticks[-1] - ticks[0]).total_seconds() / 3600.0, 1) if len(ticks) >= 2 else 0.0

    scale = {
        "workers": total_workers,
        "pools": len(pools),
        "running_now": sum(p["running"] for p in pools.values()),
        "worker_hours": round(fleet_hours),
        "window_hours": window_hours,
        "since": ticks[0].isoformat() if ticks else None,
    }

    # ── macOS migration axis ──
    def _axis_rollup(axis: str) -> dict[str, Any]:
        ps = [p for pool, p in pools.items() if _macos_axis(pool) == axis]
        return {
            "workers": sum(p["workers"] for p in ps),
            "production": sum(p["production"] for p in ps),
            "running": sum(p["running"] for p in ps),
            "worker_hours": round(axis_hours.get(axis, 0.0)),
        }
    migration = {k: _axis_rollup(k) for k in ("intel", "m4", "m4_vm", "catalina")}
    intel_h = migration["intel"]["worker_hours"]
    modern_h = migration["m4"]["worker_hours"] + migration["m4_vm"]["worker_hours"]
    denom = intel_h + modern_h or 1
    migration["modern_load_pct"] = round(modern_h / denom * 100)
    migration["intel_load_pct"] = round(intel_h / denom * 100)

    # Hourly Apple-Silicon share of macOS test load across the window — the
    # migration as a trend line rather than a snapshot.
    hour = func.date_trunc("hour", PoolLoadSample.ts)
    hour_axis: dict[datetime, dict[str, int]] = {}
    for ts_hour, pool, running in (
        db.query(hour, PoolLoadSample.pool, func.sum(PoolLoadSample.running))
        .filter(PoolLoadSample.ts >= since_14d,
                or_(*[PoolLoadSample.pool.like(f"%{frag}%") for frag in _MACOS_AXIS_FRAGMENTS]))
        .group_by(hour, PoolLoadSample.pool)
        .all()
    ):
        axis = _macos_axis(pool)
        if axis:
            bucket = hour_axis.setdefault(ts_hour, {})
            bucket[axis] = bucket.get(axis, 0) + int(running or 0)
    series = []
    for h in sorted(hour_axis):
        bucket = hour_axis[h]
        modern = bucket.get("m4", 0) + bucket.get("m4_vm", 0)
        intel = bucket.get("intel", 0)
        total = modern + intel
        series.append({
            "ts": h.isoformat(),
            "modern_pct": round(modern / total * 100, 1) if total else None,
            "modern": modern,
            "intel": intel,
        })
    migration["series"] = series

    # ── Capacity: over-provisioned (idle headroom) vs backed-up (starved) ──
    over, backed = [], []
    for pool, p in pools.items():
        # Over-provisioned = alive but idle with no queue (reclaimable headroom),
        # not just offline/staging or temporarily low-concurrency-with-a-backlog.
        if (p["production"] >= 20 and p["util"] < 0.25
                and p["active_24h"] >= 10 and p["pending"] < p["active_24h"]):
            over.append({"pool": pool, "workers": p["workers"], "production": p["production"],
                         "running": p["running"], "util": p["util"]})
        if p["pending"] > 0 and p["active_24h"] > 0 and p["pending"] >= p["active_24h"]:
            backed.append({"pool": pool, "pending": p["pending"], "workers": p["workers"],
                           "running": p["running"]})
    over.sort(key=lambda x: x["production"], reverse=True)
    backed.sort(key=lambda x: x["pending"], reverse=True)

    # ── Tart VM fleet ──
    vm_pools = [
        {"pool": pool, "kind": _vm_pool_kind(pool), "workers": p["workers"], "running": p["running"]}
        for pool, p in pools.items() if _vm_pool_kind(pool)
    ]
    vm_pools.sort(key=lambda x: x["workers"], reverse=True)

    return {
        "scale": scale,
        "migration": migration,
        "capacity": {"over_provisioned": over[:5], "backed_up": backed[:5]},
        "vms": {"pools": vm_pools, "total_workers": sum(v["workers"] for v in vm_pools)},
    }


def _fetch_cloud_pool(provisioner: str, worker_type: str) -> dict[str, Any]:
    pending = _fetch_pending_count(provisioner, worker_type)[1] or 0
    running, total = 0, 0
    try:
        # Keep this as the first queue page: later pages include older cloud workers and
        # inflate the load snapshot beyond what the dashboard has historically shown.
        resp = requests.get(
            f"{settings.tc_root_url}/api/queue/v1/provisioners/{provisioner}/worker-types/{worker_type}/workers",
            params={"limit": 1000},
            timeout=8,
            headers={"User-Agent": "relops-dashboard/1.0"},
        )
        if resp.ok:
            data = resp.json()
            workers = data.get("workers", [])
            total = len(workers)
            running = sum(1 for w in workers if w.get("latestTask") is not None)
    except Exception:
        pass
    return {
        "id": f"{provisioner}/{worker_type}",
        "name": worker_type,
        "provisioner": provisioner,
        "pending": pending,
        "running": running,
        "total": total,
    }


@router.get("/cloud-pools")
def cloud_pools() -> dict[str, Any]:
    """Live load stats for cloud Linux worker pools (no DB — all live from TC)."""
    worker_pools = _linux_cloud_worker_pools()
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(_fetch_cloud_pool, p, w) for p, w in worker_pools]
        results = [f.result() for f in as_completed(futures)]
    results.sort(key=lambda x: (x["provisioner"], x["name"]))
    return {"pools": results}


@router.get("/android-pools")
def android_pools() -> dict[str, Any]:
    """Live load stats for Android hardware pools (no DB — all live from TC)."""
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(_fetch_cloud_pool, p, w) for p, w in ANDROID_WORKER_POOLS]
        results = [f.result() for f in as_completed(futures)]
    results.sort(key=lambda x: x["name"])
    return {"pools": results}


_ANDROID_PROVISIONER: dict[str, str] = {wt: prov for prov, wt in ANDROID_WORKER_POOLS}


@router.get("/android-pool-sources")
def android_pool_sources(pool: str) -> dict[str, Any]:
    """Sample running tasks for an Android pool via the TC workers endpoint (no DB)."""
    provisioner = _ANDROID_PROVISIONER.get(pool)
    if not provisioner:
        return {"pool": pool, "sample_size": 0, "by_project": {}, "by_user": {}}

    task_ids: list[str] = []
    try:
        resp = requests.get(
            f"{settings.tc_root_url}/api/queue/v1/provisioners/{provisioner}/worker-types/{pool}/workers?limit=1000",
            timeout=8,
            headers={"User-Agent": "relops-dashboard/1.0"},
        )
        if resp.ok:
            for w in resp.json().get("workers", []):
                lt = w.get("latestTask")
                if lt and lt.get("taskId"):
                    task_ids.append(lt["taskId"])
    except Exception:
        pass

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


def _scheduler_project(scheduler_id: str) -> str:
    if "level-3" in scheduler_id:
        return "autoland"
    if "level-1" in scheduler_id:
        return "try"
    if "github" in scheduler_id:
        return "github"
    return "other"


def _task_meta(task_id: str) -> dict[str, str]:
    """Project/user for a task. A task's tags never change, so cache indefinitely —
    this collapses repeated Taskcluster lookups across pools and refresh cycles."""
    key = f"task-meta:{task_id}"
    hit = cache.get_stale(key)
    if hit is not None:
        return hit
    meta = {"project": "unknown", "user": ""}
    url = f"{settings.tc_root_url}/api/queue/v1/task/{task_id}"
    try:
        r = requests.get(url, timeout=4, headers={"User-Agent": "relops-dashboard/1.0"})
        if r.ok:
            d = r.json()
            tags = d.get("tags") or {}
            meta = {
                "project": tags.get("project") or _scheduler_project(d.get("schedulerId", "")),
                "user": tags.get("createdForUser") or "",
            }
            cache.set(key, meta)  # only cache successful lookups (immutable)
    except Exception:
        pass
    return meta


def _compute_pool_sources(pool: str) -> dict[str, Any]:
    """Sample running tasks for a pool → job-source (project/tree) + submitter mix.

    Opens its own DB session so it is safe to run from a background thread (the
    SWR refresh / warmer), not just a request."""
    with SessionLocal() as db:
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

    by_project: dict[str, int] = {}
    by_user: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=20) as ex:
        for meta in [f.result() for f in [ex.submit(_task_meta, tid) for tid in task_ids]]:
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


@router.get("/pool-sources")
def pool_sources(pool: str) -> dict[str, Any]:
    """Job-source breakdown for a pool, served stale-while-revalidate so the card
    fills instantly instead of waiting on live Taskcluster sampling."""
    return cache.swr(f"pool-sources:{pool}", _POOL_SOURCES_TTL, lambda: _compute_pool_sources(pool))


def warm_pool_sources() -> int:
    """Background job: refresh the job-source cache for every pool with running
    tasks, so the first page load already has warm data. Returns pools warmed."""
    with SessionLocal() as db:
        pools = [
            row[0] for row in db.query(Worker.worker_pool)
            .filter(Worker.worker_pool.isnot(None))
            .filter(Worker.tc_latest_task_state.ilike("running"))
            .distinct()
            .all()
            if row[0]
        ]
    for pool in pools:
        cache.set(f"pool-sources:{pool}", _compute_pool_sources(pool))
    return len(pools)


PLATFORM_POOL_PATTERNS: dict[str, list[str]] = {
    "mac": ["gecko-t-osx-%"],
    "linux": ["gecko-t-linux-%"],
    "windows": ["win11-%", "gecko-t-win%"],
}


def _platform_pool_filter(platform: str | None):
    """Return a SQLAlchemy OR clause for FailureEvent.worker_pool matching the platform, or None."""
    from sqlalchemy import or_
    patterns = PLATFORM_POOL_PATTERNS.get(platform or "")
    if not patterns:
        return None
    return or_(*[FailureEvent.worker_pool.like(p) for p in patterns])


@router.get("/failures")
def failure_insights(days: int = 7, platform: str | None = None, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Top failing machines and test task types over the last N days.

    Optional platform filter: "mac" | "linux" | "windows" (defaults to all hardware pools).
    """
    from sqlalchemy import desc
    cutoff = datetime.utcnow() - timedelta(days=days)
    pool_clause = _platform_pool_filter(platform)

    base_machine = (
        db.query(
            FailureEvent.hostname,
            FailureEvent.worker_pool,
            func.count(FailureEvent.id).label("cnt"),
            func.max(FailureEvent.failed_at).label("last_at"),
        )
        .filter(FailureEvent.failed_at >= cutoff)
    )
    if pool_clause is not None:
        base_machine = base_machine.filter(pool_clause)

    machine_rows = (
        base_machine
        .group_by(FailureEvent.hostname, FailureEvent.worker_pool)
        .order_by(desc("cnt"))
        .limit(10)
        .all()
    )

    base_test = (
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
    )
    if pool_clause is not None:
        base_test = base_test.filter(pool_clause)

    test_rows = (
        base_test
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
        "platform": platform,
    }


@router.get("/sync-logs")
def sync_logs(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Last 10 sync log entries per source, including failures."""
    rows = (
        db.query(SyncLog)
        .order_by(SyncLog.started_at.desc())
        .limit(40)
        .all()
    )
    return {
        "logs": [
            {
                "id": r.id,
                "source": r.source,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                "records_updated": r.records_updated,
                "success": r.success,
                "error": r.error,
            }
            for r in rows
        ]
    }


@router.post("/sync-tc-debug")
def sync_tc_debug(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Run TC sync synchronously and return result or full traceback."""
    import traceback
    try:
        from ..sync import taskcluster
        count = taskcluster.run_sync(db)
        return {"success": True, "records": count}
    except Exception as exc:
        return {"success": False, "error": str(exc), "traceback": traceback.format_exc()}


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
