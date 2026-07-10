"""Decommission cleanup — delete workers absent from every live source.

The per-source syncs are upsert-only and never remove a row, so a host removed
from Taskcluster, Puppet inventory, *and* SimpleMDM lingers forever: a stale
``puppet_role`` keeps it reading as ``production`` and regenerating
``missing_from_tc`` alerts. (Resolving those by hand doesn't stick — the next TC
sync recreates them, because the worker row still looks like a live candidate.)

This deletes a worker (and its alerts) once it is absent from all three sources,
judged the same way the UI's source badges are: a source counts as present when
the worker's ``last_synced_<source>`` is at or after that source's most recent
completed successful sync. A guard skips the whole pass unless all three sources
have synced successfully recently, so a broken sync can't trigger mass deletion.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Alert, SyncLog, Worker

log = logging.getLogger(__name__)

# SyncLog source name -> the Worker.last_synced_* attribute it stamps.
_SOURCE_ATTR = {
    "puppet": "last_synced_puppet",
    "taskcluster": "last_synced_tc",
    "simplemdm": "last_synced_mdm",
}


def _last_success_start(db: Session, source: str) -> datetime | None:
    row = (
        db.query(SyncLog.started_at)
        .filter(SyncLog.source == source, SyncLog.success == True, SyncLog.finished_at != None)  # noqa: E711,E712
        .order_by(SyncLog.finished_at.desc())
        .first()
    )
    return row[0] if row else None


def prune_decommissioned(db: Session) -> int:
    """Delete workers absent from Puppet, Taskcluster, and SimpleMDM.

    A worker is absent from a source when its ``last_synced_<source>`` predates
    that source's latest successful sync (or is unset). Only workers absent from
    *every* source are removed, so a host still in any one source — including a
    Mac freshly added to Puppet but not yet enrolled — is preserved.
    """
    now = datetime.utcnow()
    fresh_cutoff = now - timedelta(hours=settings.prune_source_freshness_hours)
    starts = {src: _last_success_start(db, src) for src in _SOURCE_ATTR}

    # Guard: every source must have a recent successful sync, otherwise "absent"
    # is untrustworthy and we must not delete.
    untrustworthy = [src for src, t in starts.items() if t is None or t < fresh_cutoff]
    if untrustworthy:
        log.warning(
            "Skipping decommission cleanup — no recent successful sync for: %s", untrustworthy
        )
        return 0

    def absent_everywhere(w: Worker) -> bool:
        return all(
            (ts := getattr(w, attr)) is None or ts < starts[src]
            for src, attr in _SOURCE_ATTR.items()
        )

    removed = 0
    for worker in db.query(Worker).all():
        if not absent_everywhere(worker):
            continue
        # Alerts reference hostname with no FK cascade — remove them explicitly.
        db.query(Alert).filter(Alert.hostname == worker.hostname).delete(synchronize_session=False)
        db.delete(worker)
        removed += 1
        log.info("Decommissioned %s — absent from Puppet, TC, and SimpleMDM", worker.hostname)
    return removed


def _canonical_host(hostname: str) -> str:
    """Short, lowercased host identity. Collapses every stored FQDN/domain/format variant of one
    physical host (e.g. 'macmini-m4-81', 'macmini-m4-81.test.releng...', a re-enrollment under a
    different domain) to a single key. Short names are unique per physical host, so this can never
    merge two different hosts."""
    return hostname.split(".")[0].strip().lower()


def dedup_alerts(db: Session) -> int:
    """Resolve duplicate *active* alerts so one host never shows the same alert twice.

    Groups active alerts by (canonical short host, alert_type) and resolves all but the newest in
    each group. Keying on the short host — not the full FQDN — is what unifies variants a host
    picks up across renames / EACS re-enrollments / quarantine churn, which the exact-hostname
    generator checks miss (so they create a second active alert for what is really one host).

    Crucially, the ACK is preserved: if any alert in a group is acknowledged, the surviving newest
    one is marked acknowledged too. Otherwise dedup could keep a fresh *unacked* variant and resolve
    the one you acked, so a muted host would silently pop back as a live problem. Idempotent.
    """
    now = datetime.utcnow()
    active = db.query(Alert).filter(Alert.resolved_at == None).all()  # noqa: E711
    groups: dict[tuple[str, str], list[Alert]] = {}
    for a in active:
        groups.setdefault((_canonical_host(a.hostname), a.alert_type), []).append(a)

    resolved = 0
    for alerts in groups.values():
        if len(alerts) < 2:
            continue
        alerts.sort(key=lambda a: a.created_at or datetime.min, reverse=True)  # newest first
        keep = alerts[0]
        if any(a.acknowledged for a in alerts):
            keep.acknowledged = True  # an ack on any variant sticks to the survivor
        for dup in alerts[1:]:
            dup.resolved_at = now
            resolved += 1
    if resolved:
        db.commit()
        log.info("Alert dedup: resolved %d duplicate active alert(s)", resolved)
    return resolved


def run_sync(db: Session) -> int:
    """SyncLog-wrapped entry point so the cleanup shows in /api/fleet/sync-logs."""
    log_entry = SyncLog(source="prune", started_at=datetime.utcnow())
    db.add(log_entry)
    db.flush()
    try:
        removed = prune_decommissioned(db)
        deduped = dedup_alerts(db)
        db.commit()
        log_entry.finished_at = datetime.utcnow()
        log_entry.records_updated = removed + deduped
        log_entry.success = True
        db.commit()
        log.info("Cleanup complete: %d decommissioned, %d duplicate alerts resolved", removed, deduped)
        return removed + deduped
    except Exception:
        db.rollback()
        log.exception("Decommission cleanup failed")
        log_entry.finished_at = datetime.utcnow()
        log_entry.error = "see logs"
        log_entry.success = False
        db.commit()
        raise
