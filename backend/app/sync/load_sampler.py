"""Periodic sampler that records per-pool load (pending/running/capacity) as a time series.

The data source is identical to what Yardstick/Grafana charts: live pending counts from the
Taskcluster Queue API plus running/capacity derived from current worker rows. We persist a row
per hardware pool each tick so the dashboard can render its own short-horizon load trends.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..models import PoolLoadSample, Worker
from .taskcluster import ALL_WORKER_POOLS

log = logging.getLogger(__name__)

RETENTION_DAYS = 14


def run_sync(db: Session) -> int:
    """Record one load sample per hardware pool. Returns the number of pools sampled."""
    # Lazy import avoids an import cycle (fleet imports from this package's siblings).
    from ..api.fleet import ANDROID_WORKER_POOLS, _fetch_cloud_pool, _fetch_pending_count

    # Live pending per hardware pool (Taskcluster Queue API), fetched in parallel.
    pending: dict[str, int | None] = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(_fetch_pending_count, prov, wt) for prov, wt in ALL_WORKER_POOLS]
        for fut in futures:
            worker_type, count = fut.result()
            pending[worker_type] = count

    # Running + capacity per pool from the current worker inventory.
    running: dict[str, int] = {}
    capacity: dict[str, int] = {}
    for w in db.query(Worker).all():
        pool = w.worker_pool
        if not pool:
            continue
        capacity[pool] = capacity.get(pool, 0) + 1
        if (w.tc_latest_task_state or "").upper() == "RUNNING":
            running[pool] = running.get(pool, 0) + 1

    ts = datetime.utcnow()
    worker_types = [wt for _, wt in ALL_WORKER_POOLS]
    for pool in worker_types:
        db.add(PoolLoadSample(
            pool=pool,
            ts=ts,
            pending=pending.get(pool),
            running=running.get(pool, 0),
            capacity=capacity.get(pool, 0),
        ))

    # Android (proj-autophone) pools live entirely in Taskcluster — they have no rows in
    # our Worker table — so pending/running/capacity all come straight from the TC queue,
    # exactly like /fleet/android-pools. Without this the dashboard's Android sparklines
    # never accumulate any history and stay stuck on the "collecting…" placeholder.
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_fetch_cloud_pool, prov, wt): wt for prov, wt in ANDROID_WORKER_POOLS}
        for fut in futures:
            p = fut.result()
            db.add(PoolLoadSample(
                pool=futures[fut],
                ts=ts,
                pending=p["pending"],
                running=p["running"],
                capacity=p["total"],
            ))
    total_pools = len(worker_types) + len(ANDROID_WORKER_POOLS)

    # Bound table growth — Grafana keeps the long history; we only need a short horizon.
    cutoff = ts - timedelta(days=RETENTION_DAYS)
    deleted = db.query(PoolLoadSample).filter(PoolLoadSample.ts < cutoff).delete(synchronize_session=False)

    db.commit()
    log.info("Load sampler: recorded %d pools, pruned %d old samples", total_pools, deleted)
    return total_pools
