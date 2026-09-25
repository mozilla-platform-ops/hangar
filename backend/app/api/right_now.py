"""Right now: every machine in the fleet, lit by whose Firefox work it is running.

One request (``GET /right-now``) behind the SWR cache, drawn on the Overview under
Fleet Load. Each running worker is bucketed by its task's project (autoland, try,
central, beta/release/ESR, Thunderbird); Android devices aren't worker rows, so they
come from the load sampler's per-pool counts.

A task's project comes from its tags and never changes, so lookups go through
``fleet._task_meta``'s indefinite cache: after the first pass only newly started tasks
cost a Taskcluster call.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter

from .. import cache
from ..database import SessionLocal
from ..models import PoolLoadSample, Worker
from .fleet import ANDROID_WORKER_POOLS, _task_meta

router = APIRouter(prefix="/right-now", tags=["right-now"])

CACHE_KEY = "right-now"
_TTL = 60
_ACTIVE = timedelta(hours=24)

# Fixed order -- the frontend palette is validated against exactly this sequence.
PROJECTS = ("autoland", "try", "release", "central", "thunderbird")
PROJECT_LABEL = {
    "autoland": "Autoland",
    "try": "Try",
    "release": "Beta · Release · ESR",
    "central": "Nightly (central)",
    "thunderbird": "Thunderbird",
}
PLATFORMS = ("mac", "linux", "windows", "android")
_ANDROID_POOLS = {wt for _, wt in ANDROID_WORKER_POOLS}


def project_bucket(project: str | None) -> str | None:
    """Collapse Taskcluster project names into the handful a visitor recognises.

    Anything else (enterprise, nss, mozillavpn, github, unknown) returns None and is
    drawn as "other work", so no ninth colour is ever invented.
    """
    p = (project or "").lower()
    if not p or p == "unknown":
        return None
    if "thunderbird" in p or p.startswith("comm-"):
        return "thunderbird"
    if p == "try" or p.endswith("-try"):
        return "try"
    if p == "autoland":
        return "autoland"
    if p == "mozilla-central":
        return "central"
    if p.startswith(("mozilla-beta", "mozilla-release", "mozilla-esr")):
        return "release"
    return None


def pool_platform(pool: str, by_worker: dict[str, str]) -> str | None:
    """A pool's platform: what its workers say, else what its name says."""
    if pool in by_worker:
        return by_worker[pool]
    if pool in _ANDROID_POOLS or "bitbar" in pool or "lambda" in pool:
        return "android"
    if "osx" in pool or "mac" in pool:
        return "mac"
    if "linux" in pool:
        return "linux"
    if pool.startswith("win") or "-win" in pool:
        return "windows"
    return None


def _latest_samples(db, since: datetime) -> dict[str, PoolLoadSample]:
    latest: dict[str, PoolLoadSample] = {}
    for r in db.query(PoolLoadSample).filter(PoolLoadSample.ts >= since).order_by(PoolLoadSample.ts).all():
        latest[r.pool] = r
    return latest


def compute_right_now() -> dict[str, Any]:
    now = datetime.utcnow()
    with SessionLocal() as db:
        workers = [w for w in db.query(Worker).all() if w.counts_toward_pool and w.platform in PLATFORMS]
        latest = _latest_samples(db, now - timedelta(minutes=30))

    # ── pool -> platform ──
    votes: dict[str, Counter] = defaultdict(Counter)
    for w in workers:
        if w.worker_pool:
            votes[w.worker_pool][w.platform] += 1
    by_worker = {pool: c.most_common(1)[0][0] for pool, c in votes.items()}
    all_pools = set(latest) | set(by_worker)
    platform_of = {p: pool_platform(p, by_worker) for p in all_pools}

    # ── right now: one dot per machine ──
    running_ids = [w.tc_latest_task_id for w in workers
                   if (w.tc_latest_task_state or "").upper() == "RUNNING" and w.tc_latest_task_id]
    with ThreadPoolExecutor(max_workers=16) as ex:
        meta = dict(zip(running_ids, ex.map(_task_meta, running_ids)))

    dots: dict[str, list[list[Any]]] = {p: [] for p in PLATFORMS}
    project_counts: Counter = Counter()
    status_counts: dict[str, Counter] = {p: Counter() for p in PLATFORMS}
    for w in sorted(workers, key=lambda w: (w.worker_pool or "", w.hostname)):
        if (w.tc_latest_task_state or "").upper() == "RUNNING":
            status = "r"
            bucket = project_bucket(meta.get(w.tc_latest_task_id or "", {}).get("project"))
            project_counts[bucket or "other"] += 1
        elif not w.tc_quarantined and w.tc_last_active and now - w.tc_last_active <= _ACTIVE:
            status, bucket = "i", None
        else:
            status, bucket = "o", None
        status_counts[w.platform][status] += 1
        # [short hostname, status, project index or -1, pool]
        dots[w.platform].append([
            w.hostname.split(".")[0], status,
            PROJECTS.index(bucket) if bucket else -1, w.worker_pool,
        ])

    # Android devices aren't worker rows; draw them from the sampler's per-pool counts.
    android_running = android_total = 0
    for pool, s in latest.items():
        if platform_of.get(pool) == "android":
            android_running += s.running or 0
            android_total += max(s.capacity or 0, s.running or 0)
    status_counts["android"].update({"r": android_running, "i": max(0, android_total - android_running)})
    project_counts["other"] += android_running

    pending_now = sum(s.pending or 0 for s in latest.values())
    pending_by_platform: Counter = Counter()
    for pool, s in latest.items():
        if platform_of.get(pool):
            pending_by_platform[platform_of[pool]] += s.pending or 0

    return {
        "generated_at": now.isoformat(),
        "now": {
            "machines": sum(sum(c.values()) for c in status_counts.values()),
            "running": sum(c["r"] for c in status_counts.values()),
            "pending": pending_now,
            "pools": len([p for p in all_pools if platform_of.get(p)]),
            "by_platform": {
                p: {"running": status_counts[p]["r"], "idle": status_counts[p]["i"],
                    "offline": status_counts[p]["o"], "pending": pending_by_platform[p]}
                for p in PLATFORMS
            },
        },
        "projects": {
            "order": list(PROJECTS),
            "labels": PROJECT_LABEL,
            "running": {p: project_counts.get(p, 0) for p in (*PROJECTS, "other")},
        },
        "dots": dots,
        "android_dots": {"running": android_running, "total": android_total},
    }


@router.get("")
def right_now() -> dict[str, Any]:
    return cache.swr(CACHE_KEY, _TTL, compute_right_now)
