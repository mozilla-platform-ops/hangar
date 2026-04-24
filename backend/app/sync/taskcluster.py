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
from ..hosts import worker_fqdn
from ..models import Alert, FailureEvent, SyncLog, Worker

log = logging.getLogger(__name__)

TC_GRAPHQL_URL = f"{settings.tc_root_url}/graphql"

# In-memory cache of taskId → task name. Cleared when it exceeds 5 000 entries.
_task_name_cache: dict[str, str] = {}


def _fetch_task_name(task_id: str) -> str | None:
    """Fetch metadata.name for a TC task via REST. Best-effort: returns None on any error."""
    if task_id in _task_name_cache:
        return _task_name_cache[task_id]
    try:
        resp = requests.get(
            f"{settings.tc_root_url}/api/queue/v1/task/{task_id}",
            timeout=3,
            headers={"User-Agent": "relops-dashboard/1.0"},
        )
        if resp.ok:
            name = resp.json().get("metadata", {}).get("name")
            if name:
                if len(_task_name_cache) > 5000:
                    _task_name_cache.clear()
                _task_name_cache[task_id] = name
            return name
    except Exception as exc:
        log.debug("task name lookup failed %s: %s", task_id, exc)
    return None

# All hardware worker pools to monitor (provisioner_id, worker_type)
HW_WORKER_POOLS: list[tuple[str, str]] = [
    # macOS
    ("releng-hardware", "gecko-t-osx-1400-r8"),
    ("releng-hardware", "gecko-t-osx-1400-r8-staging"),
    ("releng-hardware", "gecko-t-osx-1015-r8"),
    ("releng-hardware", "gecko-t-osx-1015-r8-staging"),
    ("releng-hardware", "gecko-t-osx-1500-m4"),
    ("releng-hardware", "gecko-t-osx-1500-m4-staging"),
    ("releng-hardware", "gecko-t-osx-1500-m4-ipv6"),
    # macOS VM pools
    ("releng-hardware", "gecko-1-b-osx-arm64-vms"),
    ("releng-hardware", "gecko-3-b-osx-arm64-vms"),
    ("releng-hardware", "gecko-t-osx-1500-m-vms"),
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
    # Linux hardware
    ("releng-hardware", "gecko-t-linux-talos-1804"),
    ("releng-hardware", "gecko-t-linux-talos-2404"),
    ("releng-hardware", "gecko-t-linux-netperf-1804"),
    ("releng-hardware", "gecko-t-linux-netperf-2404"),
    # Windows hardware
    ("releng-hardware", "win11-64-24h2-hw"),
    ("releng-hardware", "win11-64-24h2-hw-alpha"),
    ("releng-hardware", "win11-64-24h2-hw-perf-debug"),
    ("releng-hardware", "win11-64-24h2-hw-perf-sheriff"),
    ("releng-hardware", "win11-64-24h2-hw-ref"),
    ("releng-hardware", "win11-64-24h2-hw-ref-alpha"),
    ("releng-hardware", "win11-64-24h2-hw-relops1213"),
    ("releng-hardware", "gecko-t-win7-32-hw"),
]

# Keep old name as alias so fleet.py import doesn't break until updated
MAC_WORKER_POOLS = HW_WORKER_POOLS


def _detect_platform(worker_id: str, worker_pool_id: str | None) -> str:
    combined = f"{worker_id} {worker_pool_id or ''}".lower()
    if "linux" in combined or worker_id.startswith("t-linux"):
        return "linux"
    if "win" in combined or worker_id.startswith("nuc"):
        return "windows"
    return "mac"


def _detect_generation(hostname: str, worker_pool: str | None) -> str | None:
    pool = (worker_pool or "").lower()
    host = hostname.lower()
    if "2404" in pool:
        return "2404"
    if "1804" in pool:
        return "1804"
    if host.startswith("t-nuc12-") or "hw-ref" in pool:
        return "nuc12"
    if host.startswith("nuc13-"):
        return "nuc13"
    if host.startswith("win7-32-") or "win7" in pool:
        return "win7"
    if "m4" in hostname:
        return "m4"
    if "m2" in hostname:
        return "m2"
    if "r8" in hostname:
        return "r8"
    return None

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
        latestTask {
          run { taskId runId started resolved state reasonResolved }
        }
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
    return worker_fqdn(worker_id)


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

    # Only test-pool hardware workers are expected to be in TC.
    # Signing workers (mac-v3-signing, adhoc-mac, etc.) and macmini machines
    # assigned to signing pools never use TC the same way — exclude them.
    candidates = (
        db.query(Worker)
        .filter(
            (Worker.puppet_role != None) | (Worker.tc_worker_pool_id != None)  # noqa: E711
        )
        .filter(
            Worker.hostname.like("macmini-%")
            | Worker.hostname.like("nuc13-%")
            | Worker.hostname.like("t-nuc12-%")
            | Worker.hostname.like("win7-32-%")
        )
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
        # Track workers added this session — db.get() won't find unflushed pending
        # objects, so workers appearing in multiple pools would get double-inserted.
        session_workers: dict[str, Worker] = {}

        for provisioner_id, worker_type in HW_WORKER_POOLS:
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

                worker = session_workers.get(hostname) or db.get(Worker, hostname)
                if worker is None:
                    worker = Worker(hostname=hostname, worker_id=worker_id)
                    db.add(worker)
                session_workers[hostname] = worker

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

                latest_task_node = node.get("latestTask") or {}
                latest_task = latest_task_node.get("run") or {}
                new_task_id = latest_task.get("taskId")
                new_task_state_raw = latest_task.get("state") or ""

                prev_task_id = worker.tc_latest_task_id
                worker.tc_latest_task_id = new_task_id
                worker.tc_latest_task_state = new_task_state_raw

                # Record a FailureEvent when we first observe a new failed/exception task.
                new_state = new_task_state_raw.lower()
                if new_task_id and new_task_id != prev_task_id and new_state in ("failed", "exception"):
                    task_name: str | None = None
                    if new_state == "failed":
                        task_name = _fetch_task_name(new_task_id)
                    db.add(FailureEvent(
                        task_id=new_task_id,
                        task_name=task_name,
                        hostname=hostname,
                        worker_pool=worker.worker_pool,
                        state=new_state,
                        reason_resolved=latest_task.get("reasonResolved"),
                        failed_at=datetime.utcnow(),
                    ))

                if not worker.platform:
                    worker.platform = _detect_platform(worker_id, node.get("workerPoolId"))
                if not worker.generation:
                    worker.generation = _detect_generation(hostname, worker.worker_pool)

                worker.last_synced_tc = datetime.utcnow()
                _generate_alerts(db, hostname, worker)
                total += 1

        # Second pass: flag known production workers absent from TC entirely
        _check_absent_workers(db, seen_hostnames)

        # Prune failure events older than 14 days
        prune_cutoff = datetime.utcnow() - timedelta(days=14)
        db.query(FailureEvent).filter(FailureEvent.failed_at < prune_cutoff).delete(synchronize_session=False)

        db.commit()
        log_entry.finished_at = datetime.utcnow()
        log_entry.records_updated = total
        log_entry.success = True
        db.commit()
        log.info("TC sync complete: %d records across %d pools", total, len(MAC_WORKER_POOLS))
        return total

    except Exception as exc:
        log.exception("TC sync failed")
        db.rollback()
        # log_entry may be detached after rollback if the first commit never ran;
        # re-add it to the session so the failure record is saved.
        db.add(log_entry)
        log_entry.finished_at = datetime.utcnow()
        log_entry.error = str(exc)[:500]
        log_entry.success = False
        db.commit()
        raise
