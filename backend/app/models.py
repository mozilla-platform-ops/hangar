"""SQLAlchemy ORM models."""
from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base

# SimpleMDM assignment groups whose members are out of production service. A host
# keeps its last-known worker_pool label after it's pulled from ronin_puppet and
# moved to one of these groups (no sync clears worker_pool), so it would otherwise
# inflate the pool total and show up in the pool's fleet table. Members of these
# groups count toward no worker pool. Names must match SimpleMDM exactly. Edit
# this set to add/remove excluded groups.
EXCLUDED_MDM_GROUPS = {"Defective / Spares", "Loaner", "Loaner - No Profiles"}


class Worker(Base):
    __tablename__ = "workers"

    hostname: Mapped[str] = mapped_column(String(255), primary_key=True)
    worker_id: Mapped[str | None] = mapped_column(String(255))
    generation: Mapped[str | None] = mapped_column(String(20))  # r8 / m2 / m4 / 2404 / 1804
    platform: Mapped[str | None] = mapped_column(String(20))   # mac / linux / windows

    # From Puppet inventory.d
    worker_pool: Mapped[str | None] = mapped_column(String(255))
    puppet_role: Mapped[str | None] = mapped_column(String(255))

    # From master Google Sheet
    sheet_state: Mapped[str | None] = mapped_column(String(50))   # production/loaner/defective/spare/staging
    sheet_kvm: Mapped[str | None] = mapped_column(String(255))
    sheet_loaner_assignee: Mapped[str | None] = mapped_column(String(100))
    sheet_notes: Mapped[str | None] = mapped_column(Text)
    dashboard_notes: Mapped[str | None] = mapped_column(Text)  # editable from UI

    # From SimpleMDM
    mdm_id: Mapped[int | None] = mapped_column(Integer)
    mdm_name: Mapped[str | None] = mapped_column(String(255))
    serial_number: Mapped[str | None] = mapped_column(String(50))
    os_version: Mapped[str | None] = mapped_column(String(50))
    mdm_enrollment_status: Mapped[str | None] = mapped_column(String(50))
    mdm_groups: Mapped[str | None] = mapped_column(Text)  # JSON list of group names
    # Custom attributes
    safari_driver: Mapped[str | None] = mapped_column(String(50))
    video_dongle: Mapped[str | None] = mapped_column(String(50))
    worker_config: Mapped[str | None] = mapped_column(String(255))
    refresh_hz: Mapped[str | None] = mapped_column(String(20))
    resolution: Mapped[str | None] = mapped_column(String(50))
    branch: Mapped[str | None] = mapped_column(String(255))
    git_version: Mapped[str | None] = mapped_column(String(100))

    # From Taskcluster
    tc_worker_id: Mapped[str | None] = mapped_column(String(255))
    tc_worker_group: Mapped[str | None] = mapped_column(String(255))
    tc_state: Mapped[str | None] = mapped_column(String(50))
    tc_last_active: Mapped[datetime | None] = mapped_column(DateTime)
    tc_quarantined: Mapped[bool | None] = mapped_column(Boolean)
    tc_quarantine_until: Mapped[datetime | None] = mapped_column(DateTime)
    tc_first_claim: Mapped[datetime | None] = mapped_column(DateTime)
    tc_latest_task_id: Mapped[str | None] = mapped_column(String(100))
    tc_latest_task_state: Mapped[str | None] = mapped_column(String(50))
    tc_latest_task_owner: Mapped[str | None] = mapped_column(String(255))
    tc_latest_task_routes: Mapped[str | None] = mapped_column(Text)  # JSON list of route strings
    tc_worker_pool_id: Mapped[str | None] = mapped_column(String(255))

    @property
    def effective_state(self) -> str:
        """State from Google Sheets if available; otherwise infer from TC/Puppet membership."""
        if self.sheet_state:
            return self.sheet_state
        if self.tc_worker_pool_id or self.puppet_role:
            return "production"
        return "unknown"

    @property
    def mdm_group_names(self) -> list[str]:
        """SimpleMDM group names for this host (mdm_groups is a JSON list)."""
        if not self.mdm_groups:
            return []
        try:
            groups = json.loads(self.mdm_groups)
        except (ValueError, TypeError):
            return []
        return groups if isinstance(groups, list) else []

    @property
    def in_excluded_mdm_group(self) -> bool:
        """True if this host is in a non-production SimpleMDM group (e.g.
        Defective/Spares, Loaners) and so belongs to no worker pool."""
        return any(g in EXCLUDED_MDM_GROUPS for g in self.mdm_group_names)

    # Sync bookkeeping
    last_synced_puppet: Mapped[datetime | None] = mapped_column(DateTime)
    last_synced_mdm: Mapped[datetime | None] = mapped_column(DateTime)
    last_synced_tc: Mapped[datetime | None] = mapped_column(DateTime)
    last_synced_sheet: Mapped[datetime | None] = mapped_column(DateTime)
    last_synced_windows_inventory: Mapped[datetime | None] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    alert_type: Mapped[str] = mapped_column(String(50))  # missing_from_tc / quarantined / mdm_unenrolled / pool_mismatch
    hostname: Mapped[str] = mapped_column(String(255))
    detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)


class ReprovisionEvent(Base):
    """Audit ledger for the Hangar reprovision action — who initiated a reprovision of what,
    when. Execution itself happens in the on-VPN `reprovision` CLI (Cloud Run can't SSH to
    MDC1); this records the intent + who, gated to the allowlist in settings."""

    __tablename__ = "reprovision_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hostname: Mapped[str] = mapped_column(String(255))
    user: Mapped[str] = mapped_column(String(255))     # IAP-verified email of who acted
    action: Mapped[str] = mapped_column(String(50))    # initiated / quarantined / …
    detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ReprovisionJob(Base):
    """A queued reprovision, executed by an on-network runner (Cloud Run can't SSH to MDC1).

    Phase 2: Hangar enqueues; a pull-based runner on the VPN claims the job, runs the
    `reprovision` CLI, and reports events/outcome back. See
    docs/reprovision-mdc1-runner-design.md. Gated to the same allowlist for enqueue; the
    runner authenticates with `settings.reprovision_runner_token`.
    """

    __tablename__ = "reprovision_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    hostname: Mapped[str] = mapped_column(String(255))
    requested_by: Mapped[str] = mapped_column(String(255))          # IAP email that enqueued it
    # What the runner should do: "reprovision" (default/legacy) | "quarantine" | "unquarantine".
    # Same pull-based queue + runner; the runner branches on this. NULL = "reprovision" (old rows).
    action: Mapped[str | None] = mapped_column(String(20), default="reprovision")
    params: Mapped[str | None] = mapped_column(Text)               # JSON args for the action (e.g. quarantine until/info)
    # queued → claimed → running → succeeded | failed | canceled
    state: Mapped[str] = mapped_column(String(20), default="queued")
    runner: Mapped[str | None] = mapped_column(String(255))         # which runner claimed it
    detail: Mapped[str | None] = mapped_column(Text)               # last message / failure reason
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)


class WorkerScreenshot(Base):
    """Latest VNC frame for a worker, captured on-demand by the on-network agent.

    Cloud Run can't reach MDC1, so it can't VNC to a worker directly. The frontend bumps
    requested_at (only while someone is actively watching); the on-network agent polls
    pending requests, grabs ONE passive frame over VNC (admin account, ~3s hold, no input
    injected — safe on a busy worker), and pushes the JPEG here. Latest-only, no history.
    """

    __tablename__ = "worker_screenshots"

    hostname: Mapped[str] = mapped_column(String(255), primary_key=True)
    image: Mapped[bytes | None] = mapped_column(LargeBinary)
    content_type: Mapped[str] = mapped_column(String(50), default="image/jpeg")
    captured_at: Mapped[datetime | None] = mapped_column(DateTime)   # when the frame was grabbed
    requested_at: Mapped[datetime | None] = mapped_column(DateTime)  # last time a viewer asked for one


class SyncLog(Base):
    __tablename__ = "sync_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(50))   # puppet / simplemdm / taskcluster / sheets
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
    records_updated: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    success: Mapped[bool | None] = mapped_column(Boolean)


class RoninPR(Base):
    __tablename__ = "ronin_prs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)  # GitHub PR number
    title: Mapped[str] = mapped_column(Text)
    url: Mapped[str] = mapped_column(String(512))
    state: Mapped[str] = mapped_column(String(20))  # open / closed / merged
    author: Mapped[str | None] = mapped_column(String(100))
    labels: Mapped[str] = mapped_column(Text, default="[]")  # JSON list of label names
    pr_created_at: Mapped[datetime | None] = mapped_column(DateTime)
    pr_updated_at: Mapped[datetime | None] = mapped_column(DateTime)
    upvotes: Mapped[int] = mapped_column(Integer, default=0)
    downvotes: Mapped[int] = mapped_column(Integer, default=0)
    last_synced: Mapped[datetime | None] = mapped_column(DateTime)


class FailureEvent(Base):
    __tablename__ = "failure_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[str] = mapped_column(String(100), index=True)
    task_name: Mapped[str | None] = mapped_column(Text)
    hostname: Mapped[str] = mapped_column(String(255), index=True)
    worker_pool: Mapped[str | None] = mapped_column(String(255))
    state: Mapped[str] = mapped_column(String(20))           # "failed" | "exception"
    reason_resolved: Mapped[str | None] = mapped_column(String(100))
    failed_at: Mapped[datetime] = mapped_column(DateTime, index=True)


class UserPref(Base):
    """Per-user dashboard preferences, keyed by the IAP-authenticated email."""
    __tablename__ = "user_prefs"

    email: Mapped[str] = mapped_column(String(255), primary_key=True)
    monitored_pools: Mapped[str | None] = mapped_column(Text)  # JSON list (Overview dashboard)
    tracked_pools: Mapped[str | None] = mapped_column(Text)     # JSON {section: [pool, ...]} (Pool Health tabs)
    weather: Mapped[str | None] = mapped_column(Text)           # JSON {enabled, label, lat, lon, unit} (opt-in chip)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class PoolLoadSample(Base):
    """Time-series sample of per-pool load, recorded each sampler tick.

    Source is the same Taskcluster Queue/Worker data Grafana (Yardstick) charts;
    we persist it so the dashboard can draw its own short-horizon load trends.
    """
    __tablename__ = "pool_load_samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pool: Mapped[str] = mapped_column(String(255), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    pending: Mapped[int | None] = mapped_column(Integer)
    running: Mapped[int | None] = mapped_column(Integer)
    capacity: Mapped[int | None] = mapped_column(Integer)


class TartSlotHealth(Base):
    """Health of one tart VM slot, pushed by the on-network agent.

    Cloud Run can't reach MDC1, so Hangar can't SSH a tart host directly — same
    constraint as reprovision and screen. The on-network agent SSHes each host,
    runs the checks below, and pushes one row per slot. Latest-only, no history.

    Every check here is a failure that actually happened and was invisible at the
    time (2026-07-27..29):

    guest_uptime_s vs tart_run_uptime_s
        Three slots sat in a crash-reboot loop, guest rebooting every ~84s from an
        exhausted disk, while `tart run` stayed up 11+ days. The host looked
        perfectly healthy from outside and the loop ran for weeks. A guest uptime
        far below the tart-run uptime is the tell.
    guest_disk_free_gib
        The root cause of that loop: generic-worker needs 20 GiB free and panics
        (exit 69, INTERNAL_ERROR) when it can't free enough. Alerting on the
        margin catches it before the panic instead of after.
    registered
        Five of 26 slots were out of production, unnoticed. Hardware pools do not
        exist in worker-manager, so `reportWorkerError` can never surface this
        (see the revert of fxci-config #1099) — it has to be checked from here.
    identity_ok
        A fresh clone came up running as another host's live workerId, because
        set_hostname.sh aborted under `set -e` before rewriting the worker config.
        Quarantine cannot drain an impostor, so it must be detected.
    clock_skew_s
        A cloned VM inherits the image's RTC and can sit indefinitely believing it
        is the capture date, failing every TLS call to Taskcluster and never
        registering. Not a startup delay — three of five clones never recovered.
    cert_expiry / cert_owner_ok
        The injected-vault path needs a cert readable BY THE TART USER; step writes
        it 0600 root:wheel, which silently breaks injection (ronin_puppet #1303).
        Owner is as load-bearing as expiry here.
    checkout_sha / refspec_pinned
        A host with `remote.origin.fetch = +refs/heads/<branch>:...` is
        structurally unable to follow master — one sat on 7-week-old code and no
        `git fetch` would ever have moved it.
    """

    __tablename__ = "tart_slot_health"

    # hostname + slot identifies a slot; the VM name and workerId both change on reclone.
    hostname: Mapped[str] = mapped_column(String(255), primary_key=True)
    slot: Mapped[int] = mapped_column(Integer, primary_key=True)

    vm_name: Mapped[str | None] = mapped_column(String(255))
    worker_id: Mapped[str | None] = mapped_column(String(64))        # MAC-derived, from the host
    configured_worker_id: Mapped[str | None] = mapped_column(String(64))  # what the guest believes
    identity_ok: Mapped[bool | None] = mapped_column(Boolean)

    vm_state: Mapped[str | None] = mapped_column(String(32))         # running / stopped / missing
    guest_reachable: Mapped[bool | None] = mapped_column(Boolean)
    guest_uptime_s: Mapped[int | None] = mapped_column(Integer)
    tart_run_uptime_s: Mapped[int | None] = mapped_column(Integer)
    guest_disk_free_gib: Mapped[int | None] = mapped_column(Integer)
    clock_skew_s: Mapped[int | None] = mapped_column(Integer)

    registered: Mapped[bool | None] = mapped_column(Boolean)
    quarantined: Mapped[bool | None] = mapped_column(Boolean)
    last_task_state: Mapped[str | None] = mapped_column(String(32))

    # host-level, repeated per slot so a slot row is self-contained for the UI
    cert_expiry: Mapped[datetime | None] = mapped_column(DateTime)
    # Kept alongside expiry so severity is relative to this cert's own lifetime; a
    # short-lived cert is otherwise permanently "about to expire".
    cert_not_before: Mapped[datetime | None] = mapped_column(DateTime)
    cert_owner_ok: Mapped[bool | None] = mapped_column(Boolean)
    inject_vault: Mapped[bool | None] = mapped_column(Boolean)
    vault_present: Mapped[bool | None] = mapped_column(Boolean)
    checkout_sha: Mapped[str | None] = mapped_column(String(40))
    refspec_pinned: Mapped[bool | None] = mapped_column(Boolean)

    # Agent-computed rollup so the API and UI agree on severity, plus why.
    status: Mapped[str | None] = mapped_column(String(16))           # ok / warn / crit / unknown
    problems: Mapped[str | None] = mapped_column(Text)               # JSON list of strings
    collected_at: Mapped[datetime | None] = mapped_column(DateTime)
    agent_error: Mapped[str | None] = mapped_column(Text)            # set when collection itself failed

    @property
    def problem_list(self) -> list[str]:
        if not self.problems:
            return []
        try:
            v = json.loads(self.problems)
            return v if isinstance(v, list) else []
        except (ValueError, TypeError):
            return []
