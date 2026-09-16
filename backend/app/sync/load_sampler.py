"""Periodic sampler that records per-pool load (pending/running/capacity) as a time series.

The data source is identical to what Yardstick/Grafana charts: live pending counts from the
Taskcluster Queue API plus running/capacity derived from current worker rows. We persist a row
per hardware pool each tick so the dashboard can render its own short-horizon load trends.
"""
from __future__ import annotations

import logging
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..models import PoolLoadSample, Worker
from .taskcluster import ALL_WORKER_POOLS

log = logging.getLogger(__name__)

RETENTION_DAYS = 14


def pool_worker_counts(workers: Iterable[Worker]) -> tuple[dict[str, int], dict[str, int]]:
    """Per-pool (capacity, running) from a worker inventory.

    Split out of run_sync so the membership rule these numbers depend on is
    testable without a database or a Taskcluster round-trip.
    """
    capacity: dict[str, int] = {}
    running: dict[str, int] = {}
    for w in workers:
        pool = w.worker_pool
        if not pool:
            continue
        # A stale worker_pool label is not membership -- see Worker.counts_toward_pool.
        # Without this the pinned-pool card's running/capacity counts phantom workers
        # (gecko-3-b-osx-arm64 read 9 against a real 6), disagreeing with /fleet/pools
        # and the pool-filtered worker table, which both apply this rule.
        if not w.counts_toward_pool:
            continue
        capacity[pool] = capacity.get(pool, 0) + 1
        if (w.tc_latest_task_state or "").upper() == "RUNNING":
            running[pool] = running.get(pool, 0) + 1
    return capacity, running


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
    capacity, running = pool_worker_counts(db.query(Worker).all())

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
