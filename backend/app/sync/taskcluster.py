"""Sync Taskcluster worker data into the workers table.

Uses the TC queue REST API. This previously used the GraphQL API, but TC removed the
queue-worker surface from its schema (`Query.workers` is gone, and no type exposes
`lastDateActive`/`quarantineUntil` any more), which silently reduced every pool fetch to
an error and made the whole fleet look absent from TC.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Any

import requests
from sqlalchemy.orm import Session

from ..config import settings
from ..hosts import worker_fqdn
from ..models import Alert, FailureEvent, SyncLog, Worker

log = logging.getLogger(__name__)


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
    ("releng-hardware", "gecko-t-osx-2600-m4"),
    ("releng-hardware", "gecko-t-osx-2600-m4-staging"),
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

# macOS v4 signing scriptworkers. These report under the scriptworker-prov-v1
# provisioner (not releng-hardware) and their workerId is a logical instance name
# (e.g. gecko-signing-mac14m2-01), NOT a hostname — one physical mini runs several
# instances. They're keyed by workerId rather than an FQDN (see run_sync).
SCRIPTWORKER_POOLS: list[tuple[str, str]] = [
    ("scriptworker-prov-v1", "gecko-signing-mac14m2"),
    ("scriptworker-prov-v1", "dep-gecko-signing-mac14m2"),
    ("scriptworker-prov-v1", "comm-signing-mac14m2"),
    ("scriptworker-prov-v1", "dep-comm-signing-mac14m2"),
    ("scriptworker-prov-v1", "enterprise-signing-mac14m2"),
    ("scriptworker-prov-v1", "dep-enterprise-signing-mac14m2"),
    ("scriptworker-prov-v1", "mozillavpn-signing-mac14m2"),
    ("scriptworker-prov-v1", "dep-mozillavpn-signing-mac14m2"),
    ("scriptworker-prov-v1", "adhoc-signing-mac14m2"),
    ("scriptworker-prov-v1", "dep-adhoc-signing-mac14m2"),
]

# All pools the sync fetches and the pending-count endpoint polls.
ALL_WORKER_POOLS: list[tuple[str, str]] = HW_WORKER_POOLS + SCRIPTWORKER_POOLS

SCRIPTWORKER_PROVISIONER = "scriptworker-prov-v1"

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

# The TC GraphQL API dropped the queue-worker surface (the `workers` query on `Query`
# no longer exists, and no type exposes `lastDateActive`/`quarantineUntil` any more), so
# worker listings come from the queue REST API instead. See _fetch_pool_workers.
_WORKERS_PATH = "{root}/api/queue/v1/provisioners/{prov}/worker-types/{wt}/workers"
_TASK_STATUS_PATH = "{root}/api/queue/v1/task/{task_id}/status"

# Task states that will never change again — a worker whose latestTask is in one of
# these needs no further status lookup until it claims a different task.
_TERMINAL_TASK_STATES = {"completed", "failed", "exception"}

# Concurrency for the per-task status lookups. Deliberately modest: hangar has tripped
# the Cloud Armor rate limit before (PR #106), and the lookup set is already narrowed to
# tasks that changed or have not yet reached a terminal state.
_STATUS_WORKERS = 8


def _new_session() -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = "relops-dashboard/1.0"
    return session


def _fetch_pool_workers(provisioner_id: str, worker_type: str) -> list[dict[str, Any]]:
    """Fetch all workers for a pool from the queue REST API, with pagination.

    Returns nodes in the shape the sync loop already expects, so the only fields lost
    relative to the retired GraphQL query are:

    * ``state`` -- worker-manager state. Not served by the queue API. It read
      ``standalone`` for essentially every host in this (statically provisioned) fleet,
      so the caller leaves ``Worker.tc_state`` at its previous value rather than
      nulling it out.
    * ``capacity`` -- unused by the sync.

    ``latestTask.run`` carries only ``taskId``/``runId`` here; ``state`` and
    ``reasonResolved`` are filled in by _fetch_task_statuses.
    """
    session = _new_session()
    workers: list[dict[str, Any]] = []
    token: str | None = None
    worker_pool_id = f"{provisioner_id}/{worker_type}"

    while True:
        params: dict[str, Any] = {"limit": 1000}
        if token:
            params["continuationToken"] = token

        resp = session.get(
            _WORKERS_PATH.format(root=settings.tc_root_url, prov=provisioner_id, wt=worker_type),
            params=params,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

        for node in data.get("workers") or []:
            latest = node.get("latestTask") or {}
            workers.append({
                "workerId": node.get("workerId"),
                "workerGroup": node.get("workerGroup"),
                "firstClaim": node.get("firstClaim"),
                "lastDateActive": node.get("lastDateActive"),
                "quarantineUntil": node.get("quarantineUntil"),
                "workerPoolId": worker_pool_id,
                "latestTask": {"run": {
                    "taskId": latest.get("taskId"),
                    "runId": latest.get("runId"),
                }},
            })

        token = data.get("continuationToken")
        if not token:
            break

    return workers


def _fetch_task_status(task_id: str, run_id: int | None) -> tuple[str, dict[str, Any]]:
    """Return (task_id, {state, reasonResolved}) for one task. Best-effort: {} on error."""
    try:
        resp = requests.get(
            _TASK_STATUS_PATH.format(root=settings.tc_root_url, task_id=task_id),
            timeout=10,
            headers={"User-Agent": "relops-dashboard/1.0"},
        )
        resp.raise_for_status()
        status = resp.json().get("status") or {}
        runs = status.get("runs") or []
        run = None
        if run_id is not None:
            run = next((r for r in runs if r.get("runId") == run_id), None)
        if run is None:
            run = runs[-1] if runs else {}
        return task_id, {
            "state": run.get("state") or status.get("state"),
            "reasonResolved": run.get("reasonResolved"),
        }
    except Exception as exc:
        log.debug("task status lookup failed %s: %s", task_id, exc)
        return task_id, {}


def _fetch_task_statuses(tasks: dict[str, int | None]) -> dict[str, dict[str, Any]]:
    """Concurrently resolve {taskId: runId} -> {taskId: {state, reasonResolved}}.

    Callers pass only tasks that changed or have not yet reached a terminal state, so the
    size of this set tracks how many workers are actually busy, not the size of the fleet.

    A task that fails to resolve is simply absent from the result; the caller leaves that
    worker's stored state alone rather than guessing.
    """
    if not tasks:
        return {}
    out: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=_STATUS_WORKERS) as pool:
        futures = [pool.submit(_fetch_task_status, tid, rid) for tid, rid in tasks.items()]
        for fut in as_completed(futures):
            task_id, status = fut.result()
            if status:
                out[task_id] = status
    log.info("Resolved %d/%d task states", len(out), len(tasks))
    return out


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


def _record_rank(entry: tuple[str, str, dict[str, Any]]) -> tuple[bool, datetime, bool]:
    """Sort key picking the most trustworthy of several TC records for one host.

    Prefers a record that has a lastDateActive at all, then the most recent one, then a
    record that is not "parked" (TC marks a registration the host has moved away from
    with an absurdly far-future quarantineUntil; the same >2y rule _generate_alerts uses).
    """
    _prov, _wt, node = entry
    last_active = _parse_dt(node.get("lastDateActive"))
    quarantine_until = _parse_dt(node.get("quarantineUntil"))
    parked = quarantine_until is not None and quarantine_until > datetime.utcnow() + timedelta(days=730)
    return (last_active is not None, last_active or datetime.min, not parked)


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

        # Phase 1 — fetch every pool up front and record which ones failed, so the
        # absence check below can be skipped when the picture is incomplete.
        fetched: list[tuple[str, str, list[dict[str, Any]]]] = []
        failed_pools: list[str] = []
        for provisioner_id, worker_type in ALL_WORKER_POOLS:
            log.info("Fetching TC workers: %s/%s", provisioner_id, worker_type)
            try:
                fetched.append(
                    (provisioner_id, worker_type, _fetch_pool_workers(provisioner_id, worker_type))
                )
            except Exception as exc:
                log.warning("Failed to fetch %s/%s: %s", provisioner_id, worker_type, exc)
                failed_pools.append(f"{provisioner_id}/{worker_type}")

        # Phase 2 — pick one winning record per host before touching the DB.
        #
        # A host that has moved pools keeps a registration in its old pool, parked with a
        # far-future quarantineUntil and a frozen lastDateActive, and TC returns both.
        # Choosing up front rather than writing whichever pool is iterated last (and
        # correcting afterwards) matters for two reasons: iteration order stops mattering,
        # and _generate_alerts runs exactly once per host, so a cycle can never commit a
        # transient alert that a later pool in the same cycle resolves.
        best_nodes: dict[str, tuple[str, str, dict[str, Any]]] = {}
        for provisioner_id, worker_type, workers in fetched:
            for node in workers:
                worker_id = node.get("workerId", "")
                # Scriptworker workerIds are logical instance names, not hostnames,
                # so key on the workerId directly instead of synthesising an FQDN.
                hostname = (
                    worker_id
                    if provisioner_id == SCRIPTWORKER_PROVISIONER
                    else _worker_hostname(worker_id)
                )
                entry = (provisioner_id, worker_type, node)
                incumbent = best_nodes.get(hostname)
                if incumbent is None or _record_rank(entry) > _record_rank(incumbent):
                    best_nodes[hostname] = entry

        # Phase 3 — resolve task state for the winning records.
        # The REST worker listing gives only taskId/runId,
        # so state comes from a per-task lookup. Two cases need one:
        #   * the taskId changed since the last sync, or
        #   * the stored state is non-terminal — a worker keeps the same latestTask after
        #     it resolves, so refreshing only on change would pin it at "running" forever.
        # Everything else keeps its stored state, which keeps the request count near the
        # number of genuinely busy workers instead of the whole fleet.
        stale_tasks: dict[str, int | None] = {}
        for hostname, (_prov, _wt, node) in best_nodes.items():
            run = (node.get("latestTask") or {}).get("run") or {}
            task_id = run.get("taskId")
            if not task_id:
                continue
            existing = db.get(Worker, hostname)
            if (
                existing is None
                or existing.tc_latest_task_id != task_id
                or (existing.tc_latest_task_state or "").lower() not in _TERMINAL_TASK_STATES
            ):
                stale_tasks[task_id] = run.get("runId")
        task_statuses = _fetch_task_statuses(stale_tasks)

        # Phase 4 — apply to the DB.
        for provisioner_id, worker_type, node in best_nodes.values():
            is_scriptworker = provisioner_id == SCRIPTWORKER_PROVISIONER

            worker_id = node.get("workerId", "")
            hostname = worker_id if is_scriptworker else _worker_hostname(worker_id)
            seen_hostnames.add(hostname)

            worker = session_workers.get(hostname) or db.get(Worker, hostname)
            if worker is None:
                worker = Worker(hostname=hostname, worker_id=worker_id)
                db.add(worker)
            session_workers[hostname] = worker

            last_active = _parse_dt(node.get("lastDateActive"))

            # lastDateActive only moves forward for a given worker, so a value older
            # than what we already stored can only have come from a parked
            # registration in a pool the host has left. That happens even with the
            # winner chosen above, because a pool intermittently returns a partial
            # listing with no error at all (observed record totals swing by ~25), so
            # the live record can simply be missing from a cycle. Writing the parked
            # record then is what made missing_from_tc flap on and off.
            #
            # Keep the last known-good TC state instead, but still evaluate alerts:
            # a host that has genuinely dropped out of its live pool must not be
            # silenced, and tc_last_active still holds its real last activity, so the
            # threshold fires on schedule.
            if last_active is None or (
                worker.tc_last_active is not None and last_active < worker.tc_last_active
            ):
                worker.last_synced_tc = datetime.utcnow()
                _generate_alerts(db, hostname, worker)
                total += 1
                continue

            quarantine_until = _parse_dt(node.get("quarantineUntil"))
            worker.tc_worker_id = worker_id
            worker.tc_worker_group = node.get("workerGroup")
            # tc_state (worker-manager state) is not served by the queue REST API;
            # leave the last known value rather than nulling the column fleet-wide.
            worker.tc_last_active = last_active
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
            resolved = task_statuses.get(new_task_id or "") or {}

            prev_task_id = worker.tc_latest_task_id
            # Only overwrite the stored state when this sync actually resolved one;
            # a failed or skipped lookup must not silently mark a busy worker idle,
            # which is what the reprovision interlock reads (api/reprovision.py).
            if resolved.get("state"):
                worker.tc_latest_task_state = resolved["state"]
            elif new_task_id != prev_task_id:
                worker.tc_latest_task_state = None
            new_task_state_raw = worker.tc_latest_task_state or ""
            worker.tc_latest_task_id = new_task_id

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
                    reason_resolved=resolved.get("reasonResolved"),
                    failed_at=datetime.utcnow(),
                ))

            if not worker.platform:
                worker.platform = _detect_platform(worker_id, node.get("workerPoolId"))
            if not worker.generation:
                worker.generation = _detect_generation(hostname, worker.worker_pool)

            worker.last_synced_tc = datetime.utcnow()
            _generate_alerts(db, hostname, worker)
            total += 1

        # Second pass: flag known production workers absent from TC entirely.
        #
        # Only safe when this cycle actually saw the whole fleet. A partial fetch makes
        # every unseen worker look deregistered, which is how an upstream TC API change
        # once turned into hundreds of false missing_from_tc alerts while the sync still
        # reported success. Mirrors the guard reconcile.prune_decommissioned already has.
        if failed_pools:
            incomplete = f"{len(failed_pools)} pool(s) failed to fetch: {', '.join(failed_pools[:5])}"
        elif not seen_hostnames:
            incomplete = "no workers returned by any pool"
        else:
            incomplete = ""

        if incomplete:
            log.error("Skipping absence check — incomplete TC picture (%s)", incomplete)
        else:
            _check_absent_workers(db, seen_hostnames)

        # Prune failure events older than 14 days
        prune_cutoff = datetime.utcnow() - timedelta(days=14)
        db.query(FailureEvent).filter(FailureEvent.failed_at < prune_cutoff).delete(synchronize_session=False)

        db.commit()

        # Collapse any duplicate active alerts a host picked up across hostname variants
        # (renames / EACS re-enrollment / quarantine churn) right after generating them, so a
        # muted host can't reappear as a live problem between the hourly prune cycles. Ack-preserving.
        from .reconcile import dedup_alerts
        dedup_alerts(db)
        log_entry.finished_at = datetime.utcnow()
        log_entry.records_updated = total
        # A partial fetch is a failed sync, even though the rows we did get were saved.
        # Reporting success here is what let the outage stay invisible for a week.
        log_entry.success = not incomplete
        log_entry.error = incomplete[:500] or None
        db.commit()
        log.info(
            "TC sync complete: %d records across %d pools (%d failed)",
            total, len(ALL_WORKER_POOLS), len(failed_pools),
        )
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
