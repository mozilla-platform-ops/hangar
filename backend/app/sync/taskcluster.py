"""Sync Taskcluster worker data into the workers table.

Uses the TC GraphQL API (same approach as fleetroll_mvp) which returns richer
data than the REST API, including latestTask details.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

import requests
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Alert, SyncLog, Worker

log = logging.getLogger(__name__)

TC_GRAPHQL_URL = f"{settings.tc_root_url}/graphql"

# All macOS worker pools to monitor (provisioner_id, worker_type)
MAC_WORKER_POOLS: list[tuple[str, str]] = [
    ("releng-hardware", "gecko-t-osx-1400-r8"),
    ("releng-hardware", "gecko-t-osx-1400-r8-staging"),
    ("releng-hardware", "gecko-t-osx-1015-r8"),
    ("releng-hardware", "gecko-t-osx-1015-r8-staging"),
    ("releng-hardware", "gecko-t-osx-1500-m4"),
    ("releng-hardware", "gecko-t-osx-1500-m4-staging"),
    ("releng-hardware", "gecko-t-osx-1500-m4-ipv6"),
    ("releng-hardware", "gecko-1-b-osx-1015"),
    ("releng-hardware", "gecko-3-b-osx-1015"),
    ("releng-hardware", "gecko-1-b-osx-1015-staging"),
    ("releng-hardware", "gecko-1-b-osx-arm64"),
    ("releng-hardware", "gecko-3-b-osx-arm64"),
    ("releng-hardware", "enterprise-1-b-osx-arm64"),
    ("releng-hardware", "enterprise-3-b-osx-arm64"),
    ("releng-hardware", "applicationservices-b-1-osx1015"),
    ("releng-hardware", "applicationservices-b-3-osx1015"),
    ("releng-hardware", "mozillavpn-b-1-osx"),
    ("releng-hardware", "mozillavpn-b-3-osx"),
    ("releng-hardware", "nss-1-b-osx-1015"),
    ("releng-hardware", "nss-3-b-osx-1015"),
]

_GRAPHQL_QUERY = """
query ViewWorkers($provisionerId: String!, $workerType: String!, $workersConnection: PageConnection) {
  workers(
    provisionerId: $provisionerId
    workerType: $workerType
    connection: $workersConnection
  ) {
    pageInfo { hasNextPage nextCursor }
    edges {
      node {
        workerId
        workerGroup
        latestTask { run { taskId runId started resolved state } }
        firstClaim
        quarantineUntil
        lastDateActive
        state
        capacity
        workerPoolId
      }
    }
  }
}
"""


def _fetch_pool_workers(provisioner_id: str, worker_type: str) -> list[dict[str, Any]]:
    """Fetch all workers for a pool via GraphQL, with pagination."""
    session = requests.Session()
    session.headers["User-Agent"] = "relops-dashboard/1.0"

    workers: list[dict] = []
    cursor: str | None = None

    while True:
        variables: dict[str, Any] = {
            "provisionerId": provisioner_id,
            "workerType": worker_type,
            "workersConnection": {"limit": 1000},
        }
        if cursor:
            variables["workersConnection"]["cursor"] = cursor

        resp = session.post(
            TC_GRAPHQL_URL,
            json={"operationName": "ViewWorkers", "variables": variables, "query": _GRAPHQL_QUERY},
            headers={
                "Content-Type": "application/json",
                "Origin": settings.tc_root_url,
                "Referer": f"{settings.tc_root_url}/",
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

        workers_data = (data.get("data") or {}).get("workers", {})
        for edge in workers_data.get("edges", []):
            node = edge.get("node")
            if node:
                workers.append(node)

        page_info = workers_data.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        cursor = page_info.get("nextCursor")
        if not cursor:
            break

    return workers


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except (ValueError, AttributeError):
        return None


def _worker_hostname(worker_id: str) -> str:
    """Convert worker ID to FQDN. worker_id is typically the short hostname."""
    if "." in worker_id:
        return worker_id
    return f"{worker_id}.test.releng.mdc1.mozilla.com"


def _generate_alerts(db: Session, hostname: str, worker: Worker) -> None:
    """Create or resolve alerts for a worker based on current TC state."""
    now = datetime.utcnow()
    threshold_hours = settings.tc_missing_threshold_hours

    def _active_alert(alert_type: str) -> Alert | None:
        return (
            db.query(Alert)
            .filter(Alert.hostname == hostname, Alert.alert_type == alert_type, Alert.resolved_at == None)  # noqa: E711
            .first()
        )

    # Quarantine alert — only for genuine near-term quarantines.
    # TC uses year-3000+ quarantine dates as a "staging/parked" marker; those are not actionable.
    two_years_from_now = now + timedelta(days=730)
    is_real_quarantine = (
        worker.tc_quarantined
        and worker.tc_quarantine_until is not None
        and worker.tc_quarantine_until < two_years_from_now
    )
    if is_real_quarantine:
        if not _active_alert("quarantined"):
            db.add(Alert(alert_type="quarantined", hostname=hostname, detail=f"Quarantined until {worker.tc_quarantine_until}"))
    else:
        a = _active_alert("quarantined")
        if a:
            a.resolved_at = now

    # Missing-from-TC alert: production/staging workers with no recent TC activity
    is_active_state = worker.effective_state not in ("loaner", "defective", "spare", "unknown")
    if is_active_state and worker.tc_last_active:
        hours_inactive = (now - worker.tc_last_active).total_seconds() / 3600
        if hours_inactive > threshold_hours:
            if not _active_alert("missing_from_tc"):
                db.add(Alert(
                    alert_type="missing_from_tc",
                    hostname=hostname,
                    detail=f"No TC activity for {hours_inactive:.0f}h (last: {worker.tc_last_active})",
                ))
        else:
            a = _active_alert("missing_from_tc")
            if a:
                a.resolved_at = now


def _check_absent_workers(db: Session, seen_hostnames: set[str]) -> None:
    """Flag production workers that TC did not return at all in this sync cycle.

    A worker known to Puppet or previously seen in TC that is completely absent
    from TC's current worker list has either crashed and dropped off or was
    deregistered.  We generate a missing_from_tc alert so the operator is
    notified immediately rather than waiting for a stale lastDateActive.
    """
    now = datetime.utcnow()
    threshold_hours = settings.tc_missing_threshold_hours

    # Only macmini workers are expected to be in TC.
    # Signing workers (mac-v3-signing, adhoc-mac, etc.) and macmini machines
    # assigned to signing pools never use TC the same way — exclude them.
    candidates = (
        db.query(Worker)
        .filter(
            (Worker.puppet_role != None) | (Worker.tc_worker_pool_id != None)  # noqa: E711
        )
        .filter(Worker.hostname.like("macmini-%"))
        .filter(
            (Worker.worker_pool == None) | (~Worker.worker_pool.ilike("%signing%"))  # noqa: E711
        )
        .all()
    )

    for worker in candidates:
        hostname = worker.hostname
        if hostname in seen_hostnames:
            continue  # TC returned this worker — handled by _generate_alerts

        # Worker not returned by TC this cycle
        def _active_alert(alert_type: str) -> Alert | None:
            return (
                db.query(Alert)
                .filter(Alert.hostname == hostname, Alert.alert_type == alert_type, Alert.resolved_at == None)  # noqa: E711
                .first()
            )

        # Skip states that are intentionally offline
        if worker.effective_state in ("loaner", "defective", "spare"):
            # Resolve any existing missing_from_tc alert if state changed
            a = _active_alert("missing_from_tc")
            if a:
                a.resolved_at = now
            continue

        if worker.tc_last_active:
            hours_inactive = (now - worker.tc_last_active).total_seconds() / 3600
            if hours_inactive > threshold_hours:
                if not _active_alert("missing_from_tc"):
                    db.add(Alert(
                        alert_type="missing_from_tc",
                        hostname=hostname,
                        detail=f"Not found in any TC pool. Last seen {hours_inactive:.0f}h ago ({worker.tc_last_active.date()})",
                    ))
            else:
                a = _active_alert("missing_from_tc")
                if a:
                    a.resolved_at = now
        else:
            # Never seen in TC — alert if Puppet knows about it (confirmed production worker)
            if worker.puppet_role and not _active_alert("missing_from_tc"):
                db.add(Alert(
                    alert_type="missing_from_tc",
                    hostname=hostname,
                    detail="Not found in any TC pool and has no recorded TC activity",
                ))


def run_sync(db: Session) -> int:
    log_entry = SyncLog(source="taskcluster", started_at=datetime.utcnow())
    db.add(log_entry)
    db.flush()

    try:
        total = 0
        seen_hostnames: set[str] = set()

        for provisioner_id, worker_type in MAC_WORKER_POOLS:
            log.info("Fetching TC workers: %s/%s", provisioner_id, worker_type)
            try:
                workers = _fetch_pool_workers(provisioner_id, worker_type)
            except Exception as exc:
                log.warning("Failed to fetch %s/%s: %s", provisioner_id, worker_type, exc)
                continue

            for node in workers:
                worker_id = node.get("workerId", "")
                hostname = _worker_hostname(worker_id)
                seen_hostnames.add(hostname)

                worker = db.get(Worker, hostname)
                if worker is None:
                    worker = Worker(hostname=hostname, worker_id=worker_id)
                    db.add(worker)

                quarantine_until = _parse_dt(node.get("quarantineUntil"))
                worker.tc_worker_id = worker_id
                worker.tc_worker_group = node.get("workerGroup")
                worker.tc_state = node.get("state")
                worker.tc_last_active = _parse_dt(node.get("lastDateActive"))
                worker.tc_quarantined = quarantine_until is not None and quarantine_until > datetime.utcnow()
                worker.tc_quarantine_until = quarantine_until
                worker.tc_first_claim = _parse_dt(node.get("firstClaim"))
                worker.tc_worker_pool_id = node.get("workerPoolId")

                # Backfill worker_pool from TC if Puppet hasn't set it yet.
                # workerPoolId is "releng-hardware/gecko-t-osx-1500-m4" → "gecko-t-osx-1500-m4"
                if not worker.worker_pool and worker.tc_worker_pool_id:
                    worker.worker_pool = worker.tc_worker_pool_id.split("/")[-1]

                latest_task = (node.get("latestTask") or {}).get("run") or {}
                worker.tc_latest_task_id = latest_task.get("taskId")
                worker.tc_latest_task_state = latest_task.get("state")

                if not worker.generation:
                    worker.generation = (
                        "m4" if "m4" in hostname else
                        "m2" if "m2" in hostname else
                        "r8" if "r8" in hostname else None
                    )

                worker.last_synced_tc = datetime.utcnow()
                _generate_alerts(db, hostname, worker)
                total += 1

        # Second pass: flag known production workers absent from TC entirely
        _check_absent_workers(db, seen_hostnames)

        db.commit()
        log_entry.finished_at = datetime.utcnow()
        log_entry.records_updated = total
        log_entry.success = True
        db.commit()
        log.info("TC sync complete: %d records across %d pools", total, len(MAC_WORKER_POOLS))
        return total

    except Exception as exc:
        db.rollback()
        log.exception("TC sync failed")
        log_entry.finished_at = datetime.utcnow()
        log_entry.error = str(exc)
        log_entry.success = False
        db.commit()
        raise
