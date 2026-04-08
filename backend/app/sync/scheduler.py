"""APScheduler setup for periodic sync jobs."""
from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from ..config import settings
from ..database import SessionLocal

log = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def _run_puppet() -> None:
    from . import puppet
    with SessionLocal() as db:
        puppet.run_sync(db)


def _run_simplemdm() -> None:
    from . import simplemdm
    with SessionLocal() as db:
        simplemdm.run_sync(db)


def _run_taskcluster() -> None:
    from . import taskcluster
    with SessionLocal() as db:
        taskcluster.run_sync(db)


def _run_sheets() -> None:
    from . import google_sheets
    with SessionLocal() as db:
        google_sheets.run_sync(db)


def run_all_sync() -> None:
    """Run all sync jobs sequentially (used for manual trigger)."""
    log.info("Manual sync: starting all sources")
    for fn in (_run_puppet, _run_simplemdm, _run_taskcluster, _run_sheets):
        try:
            fn()
        except Exception:
            log.exception("Sync job %s failed", fn.__name__)
    log.info("Manual sync: complete")


def start_scheduler() -> None:
    global _scheduler
    _scheduler = BackgroundScheduler(daemon=True)

    _scheduler.add_job(_run_puppet, IntervalTrigger(seconds=settings.sync_interval_puppet), id="puppet", replace_existing=True)
    _scheduler.add_job(_run_simplemdm, IntervalTrigger(seconds=settings.sync_interval_simplemdm), id="simplemdm", replace_existing=True)
    _scheduler.add_job(_run_taskcluster, IntervalTrigger(seconds=settings.sync_interval_tc), id="taskcluster", replace_existing=True)
    _scheduler.add_job(_run_sheets, IntervalTrigger(seconds=settings.sync_interval_sheets), id="sheets", replace_existing=True)

    _scheduler.start()
    log.info("Background sync scheduler started")


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
