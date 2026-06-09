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
from .taskcluster import HW_WORKER_POOLS

log = logging.getLogger(__name__)

RETENTION_DAYS = 14


def run_sync(db: Session) -> int:
    """Record one load sample per hardware pool. Returns the number of pools sampled."""
    from ..api.fleet import _fetch_pending_count  # lazy import avoids an import cycle

    # Live pending per hardware pool (Taskcluster Queue API), fetched in parallel.
    pending: dict[str, int | None] = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(_fetch_pending_count, prov, wt) for prov, wt in HW_WORKER_POOLS]
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
    worker_types = [wt for _, wt in HW_WORKER_POOLS]
    for pool in worker_types:
        db.add(PoolLoadSample(
            pool=pool,
            ts=ts,
            pending=pending.get(pool),
            running=running.get(pool, 0),
            capacity=capacity.get(pool, 0),
        ))

    # Bound table growth — Grafana keeps the long history; we only need a short horizon.
    cutoff = ts - timedelta(days=RETENTION_DAYS)
    deleted = db.query(PoolLoadSample).filter(PoolLoadSample.ts < cutoff).delete(synchronize_session=False)

    db.commit()
    log.info("Load sampler: recorded %d pools, pruned %d old samples", len(worker_types), deleted)
    return len(worker_types)
