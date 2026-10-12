"""
Tart VM slot health.

Cloud Run can't reach MDC1, so Hangar can't SSH a tart host directly — the same
constraint as reprovision and screen. So the on-network agent SSHes each host,
runs the checks, and pushes one row per slot here; viewers read the rollup.

Auth mirrors screen/reprovision: mTLS client cert for the agent (`require_runner`),
IAP allowlist for viewers (`require_access`).

Why this exists at all: between 2026-07-27 and 07-29, five of 26 slots in
gecko-t-osx-1500-m-vms were out of production and nobody knew. Three were in a
crash-reboot loop from exhausted guest disk, cycling every ~84 seconds for weeks,
while `tart run` on the host stayed up 11+ days — so every host-level check looked
green. And it could not have surfaced through Taskcluster either: hardware pools
have no worker-manager representation, so `reportWorkerError` returns
ResourceNotFound whatever scopes the client holds (hence the revert of
fxci-config #1099). This endpoint is the channel that was missing.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import TartSlotHealth
from .reprovision import require_access, require_runner

router = APIRouter(prefix="/tart-health", tags=["tart-health"])

# A slot whose last push is older than this is reported stale rather than healthy —
# absence of news is not good news, and a wedged agent must not read as a green fleet.
_STALE = timedelta(minutes=30)

# generic-worker refuses to start a task without this much free space in the guest and
# panics (exit 69) when it cannot free enough. Warn with headroom, not at the cliff.
DISK_CRIT_GIB = 22
DISK_WARN_GIB = 30

# The crash loop is detected from the guest's own /opt/worker/worker_exit_69 semaphore,
# NOT from guest-vs-tart-run uptime.
#
# worker-runner.sh writes that file the first time generic-worker exits 69 (the "cannot
# free enough disk" path) and deletes it on any other exit, logging "Worker recovered
# from previous exit code 69". So presence means the last worker exit was the panic path,
# and the file's age means how long that has been true. worker-runner itself treats
# `find -mmin +15` on the same file as "problem repeated for 15m", so we reuse that
# boundary rather than inventing one.
#
# The previous rule was `guest_uptime_s < tart_run_uptime_s * 0.5` once tart run had been
# up an hour. That is wrong for this pool and was never true-tested: these guests are
# numberOfTasksToRun=1, so they reboot after EVERY task. A healthy guest's uptime is one
# task (600-2400s) while tart run is days, which satisfies the ratio permanently.
# Measured 2026-08-17 on two independently verified-healthy slots:
#   mac-c51932  guest 368s  vs tart run 5760s   -> would CRIT
#   mac-962a94  guest 616s  vs tart run 10464s  -> would CRIT
# The genuine loop rebooted every ~84s. No single-sample ratio separates 84s from 600s
# reliably, so the ratio is gone rather than retuned.
EXIT69_CRIT_AGE_S = 900  # 15m, matching worker-runner.sh's own "problem repeated" test

# Every task now ends with the guest halting and the host deleting and re-cloning the
# VM (ronin_puppet tart.revert_after_task, live 2026-09-15). For that window a healthy
# slot's VM is stopped or missing and its guest is still booting, and a sweep can land
# in it. So a stopped VM or a silent guest is only a fault once a SECOND sweep sees it.
# The agent sweeps every 600s; half that is safely past one push and short of two.
DOWN_CONFIRM_S = 300

CLOCK_SKEW_CRIT_S = 300  # a cloned VM inheriting the image RTC is out by weeks, not minutes

# Cert expiry is judged against the cert's OWN lifetime, not a fixed number of days.
# `step ca renew --daemon` renews once the remaining validity drops below 1/3, so on a
# 168h cert "expires in 4 days" is the steady state, and a fixed 7-day warning would
# hold every such slot permanently at warn. Warn only once the daemon has clearly
# missed its window — below this fraction remaining, renewal should already have run.
CERT_RENEW_MISSED_FRACTION = 0.15
# Fallback when notBefore is unavailable and no lifetime can be derived.
CERT_EXPIRY_WARN_DAYS = 2


class SlotPush(BaseModel):
    """One slot, as collected by the on-network agent."""

    hostname: str
    slot: int
    vm_name: str | None = None
    worker_id: str | None = None
    configured_worker_id: str | None = None
    vm_state: str | None = None
    guest_reachable: bool | None = None
    guest_uptime_s: int | None = None
    tart_run_uptime_s: int | None = None
    guest_disk_free_gib: int | None = None
    clock_skew_s: int | None = None
    worker_exit_69_age_s: int | None = None
    registered: bool | None = None
    quarantined: bool | None = None
    last_task_state: str | None = None
    cert_expiry: datetime | None = None
    cert_not_before: datetime | None = None
    cert_owner_ok: bool | None = None
    inject_vault: bool | None = None
    vault_present: bool | None = None
    checkout_sha: str | None = None
    refspec_pinned: bool | None = None
    probe_key_present: bool | None = None
    agent_error: str | None = None


class HealthPush(BaseModel):
    slots: list[SlotPush] = Field(default_factory=list)


def evaluate(
    s: SlotPush,
    vm_down_for_s: float | None = None,
    guest_unreachable_for_s: float | None = None,
) -> tuple[str, list[str]]:
    """Derive status + human-readable problems.

    Server-side on purpose: the agent stays a dumb collector, so thresholds can be
    tuned here without redeploying an on-network component, and the API and UI can
    never disagree about severity.

    `vm_down_for_s` / `guest_unreachable_for_s` are how long the condition has held
    across pushes (None on first sighting). A problem can be listed without raising
    severity, as a note for the operator.
    """
    problems: list[str] = []
    crit = False
    warn = False

    if s.agent_error:
        return "unknown", [f"collection failed: {s.agent_error}"]

    if s.vm_state and s.vm_state != "running":
        if vm_down_for_s is not None and vm_down_for_s >= DOWN_CONFIRM_S:
            crit = True
            problems.append(f"VM {s.vm_state} for {int(vm_down_for_s // 60)}m")
        else:
            problems.append(f"VM {s.vm_state}, likely being re-cloned between tasks")

    # The crash loop. Checked before reachability, because a looping guest is often
    # briefly SSH-able and would otherwise look merely flaky.
    if s.worker_exit_69_age_s is not None:
        if s.worker_exit_69_age_s >= EXIT69_CRIT_AGE_S:
            crit = True
            problems.append(
                f"worker has been exiting 69 for {s.worker_exit_69_age_s // 60}m — "
                "crash-reboot loop, slot is resolving no tasks"
            )
        else:
            # A single exit 69 recovers on its own often enough (a task that filled the
            # disk, then cleanUpTaskDirs reclaims it) that paging on the first one would
            # be noise. It becomes crit if it is still there at the next sweep.
            warn = True
            problems.append(
                f"worker exited 69 {s.worker_exit_69_age_s // 60}m ago — watch for a loop"
            )

    if s.guest_disk_free_gib is not None:
        if s.guest_disk_free_gib < DISK_CRIT_GIB:
            crit = True
            problems.append(f"guest disk {s.guest_disk_free_gib} GiB free — worker needs 20 GiB, will panic")
        elif s.guest_disk_free_gib < DISK_WARN_GIB:
            warn = True
            problems.append(f"guest disk {s.guest_disk_free_gib} GiB free — approaching the 20 GiB floor")

    if s.identity_mismatch:
        crit = True
        problems.append(
            f"identity mismatch: guest claims {s.configured_worker_id}, MAC implies {s.worker_id} "
            "— may be impersonating another host's worker"
        )

    if s.clock_skew_s is not None and abs(s.clock_skew_s) > CLOCK_SKEW_CRIT_S:
        crit = True
        problems.append(f"clock off by {s.clock_skew_s}s — TLS to Taskcluster will fail, worker cannot register")

    if s.registered is False and not s.quarantined:
        crit = True
        problems.append("not registered in Taskcluster")

    if s.inject_vault and s.vault_present is False:
        crit = True
        problems.append("inject_vault on but no vault was shared in — slot will run without credentials")

    if s.cert_owner_ok is False:
        crit = True
        problems.append("cert not readable by the tart user — vault injection cannot work")

    if s.cert_expiry is not None:
        remaining_s = (s.cert_expiry - datetime.utcnow()).total_seconds()
        if remaining_s < 0:
            crit = True
            problems.append(f"client cert EXPIRED {abs(int(remaining_s // 86400))}d ago")
        elif s.cert_not_before is not None:
            lifetime_s = (s.cert_expiry - s.cert_not_before).total_seconds()
            if lifetime_s > 0 and remaining_s / lifetime_s < CERT_RENEW_MISSED_FRACTION:
                warn = True
                problems.append(
                    f"client cert has {int(remaining_s // 3600)}h of a "
                    f"{int(lifetime_s // 3600)}h lifetime left — renew daemon should "
                    "already have renewed it"
                )
        elif remaining_s < CERT_EXPIRY_WARN_DAYS * 86400:
            warn = True
            problems.append(f"client cert expires in {int(remaining_s // 86400)}d — renewal may have stopped")

    if s.refspec_pinned:
        warn = True
        problems.append("puppet clone is pinned to a single branch — this host cannot follow master")

    # Without the probe key on the host the guest is never asked, so "unreachable" says
    # nothing about the slot. That is reported as coverage (see guest_check), not health.
    if s.guest_reachable is False and s.probe_key_present and not problems:
        if guest_unreachable_for_s is not None and guest_unreachable_for_s >= DOWN_CONFIRM_S:
            warn = True
            problems.append(f"guest not answering the probe for {int(guest_unreachable_for_s // 60)}m")
        else:
            problems.append("guest not answering yet, likely booting a fresh clone")

    if crit:
        return "crit", problems
    if warn:
        return "warn", problems
    return "ok", problems


# `identity_mismatch` is a derived property rather than a pushed field so the agent
# cannot report "fine" while the two ids plainly differ.
def _identity_mismatch(self: SlotPush) -> bool:
    if not self.worker_id or not self.configured_worker_id:
        return False
    return self.worker_id != self.configured_worker_id


SlotPush.identity_mismatch = property(_identity_mismatch)  # type: ignore[attr-defined]


def _since(prev: datetime | None, holds: bool, now: datetime) -> datetime | None:
    """Start of a condition that persists across pushes; None once it clears."""
    if not holds:
        return None
    return prev or now


def _held_for(since: datetime | None, now: datetime) -> float | None:
    """Seconds a condition has held, or None if this push is the first to see it."""
    if since is None or since >= now:
        return None
    return (now - since).total_seconds()


def guest_check(r: TartSlotHealth) -> str:
    """Whether the in-guest checks (disk, clock, identity, exit 69) actually ran.

    checked      the guest answered the probe
    no_key       the host has no probe key, so the guest was never asked
    unreachable  the key is there and the guest didn't answer
    not_checked  anything else (collection failed, VM down, agent too old to say)
    """
    if r.agent_error:
        return "not_checked"
    if r.guest_reachable:
        return "checked"
    if r.probe_key_present is False:
        return "no_key"
    if r.probe_key_present and r.guest_reachable is False:
        return "unreachable"
    return "not_checked"


@router.post("/agent/push")
def agent_push(
    payload: HealthPush,
    runner: str = Depends(require_runner),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """On-network agent pushes collected slot health. Latest-only, upserted per slot."""
    now = datetime.utcnow()
    written = 0
    for s in payload.slots:
        row = db.get(TartSlotHealth, (s.hostname, s.slot))
        if row is None:
            row = TartSlotHealth(hostname=s.hostname, slot=s.slot)
            db.add(row)
        # A failed collection says nothing either way, so it leaves the clocks alone.
        if not s.agent_error:
            row.vm_down_since = _since(row.vm_down_since, bool(s.vm_state and s.vm_state != "running"), now)
            row.guest_unreachable_since = _since(row.guest_unreachable_since, s.guest_reachable is False, now)
        status, problems = evaluate(
            s,
            vm_down_for_s=_held_for(row.vm_down_since, now),
            guest_unreachable_for_s=_held_for(row.guest_unreachable_since, now),
        )
        for field in (
            "vm_name", "worker_id", "configured_worker_id", "vm_state", "guest_reachable",
            "guest_uptime_s", "tart_run_uptime_s", "guest_disk_free_gib", "clock_skew_s",
            "worker_exit_69_age_s",
            "registered", "quarantined", "last_task_state", "cert_expiry", "cert_not_before", "cert_owner_ok",
            "inject_vault", "vault_present", "checkout_sha", "refspec_pinned", "probe_key_present",
            "agent_error",
        ):
            setattr(row, field, getattr(s, field))
        row.identity_ok = not s.identity_mismatch
        row.status = status
        row.problems = json.dumps(problems)
        row.collected_at = now
        written += 1
    db.commit()
    return {"accepted": written, "runner": runner, "collected_at": now.isoformat()}


@router.get("")
def tart_health(user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Fleet-wide tart slot health, worst first."""
    rows = list(db.scalars(select(TartSlotHealth)))
    now = datetime.utcnow()
    # Uncollected slots sort last: they are summarised per host in `summary`, and
    # listing them above real faults buried the one host that was actually down.
    order = {"crit": 0, "warn": 1, "ok": 2, "unknown": 3}

    slots: list[dict[str, Any]] = []
    for r in rows:
        stale = r.collected_at is None or (now - r.collected_at) > _STALE
        # A stale row is reported as unknown regardless of its last status: a wedged
        # agent must not leave the fleet looking green.
        status = "unknown" if stale else (r.status or "unknown")
        problems = r.problem_list
        if stale:
            age = "never" if r.collected_at is None else f"{int((now - r.collected_at).total_seconds() // 60)}m ago"
            problems = [f"stale data (last collected {age})"] + problems
        slots.append({
            "hostname": r.hostname,
            "slot": r.slot,
            "vm_name": r.vm_name,
            "worker_id": r.worker_id,
            "configured_worker_id": r.configured_worker_id,
            "identity_ok": r.identity_ok,
            "vm_state": r.vm_state,
            "guest_reachable": r.guest_reachable,
            "guest_uptime_s": r.guest_uptime_s,
            "tart_run_uptime_s": r.tart_run_uptime_s,
            "guest_disk_free_gib": r.guest_disk_free_gib,
            "clock_skew_s": r.clock_skew_s,
            "worker_exit_69_age_s": r.worker_exit_69_age_s,
            "registered": r.registered,
            "quarantined": r.quarantined,
            "last_task_state": r.last_task_state,
            "cert_expiry": r.cert_expiry.isoformat() if r.cert_expiry else None,
            "cert_not_before": r.cert_not_before.isoformat() if r.cert_not_before else None,
            "cert_owner_ok": r.cert_owner_ok,
            "inject_vault": r.inject_vault,
            "vault_present": r.vault_present,
            "checkout_sha": r.checkout_sha,
            "refspec_pinned": r.refspec_pinned,
            "probe_key_present": r.probe_key_present,
            "guest_check": guest_check(r),
            "vm_down_since": r.vm_down_since.isoformat() if r.vm_down_since else None,
            "agent_error": r.agent_error,
            "status": status,
            "problems": problems,
            "collected_at": r.collected_at.isoformat() if r.collected_at else None,
            "stale": stale,
        })

    slots.sort(key=lambda s: (order.get(s["status"], 9), s["hostname"], s["slot"]))
    counts = {k: sum(1 for s in slots if s["status"] == k) for k in ("ok", "warn", "crit", "unknown")}

    # Host-level failures are one problem per host, not two per slot.
    uncollected: dict[str, str] = {}
    for s in slots:
        if s["stale"] or s["agent_error"]:
            uncollected.setdefault(s["hostname"], s["problems"][0] if s["problems"] else "not collected")
    collected = [s for s in slots if s["hostname"] not in uncollected]
    summary = {
        # Taking tasks as far as anyone outside the guest can tell. A VM caught mid
        # re-clone still counts; once that outlasts DOWN_CONFIRM_S the slot is crit.
        "serving": sum(
            1 for s in collected
            if s["registered"] and not s["quarantined"] and s["status"] != "crit"
        ),
        "guest_checked": sum(1 for s in collected if s["guest_check"] == "checked"),
        "no_probe_key_hosts": sorted({s["hostname"] for s in collected if s["guest_check"] == "no_key"}),
        "uncollected_hosts": [{"hostname": h, "reason": why} for h, why in sorted(uncollected.items())],
    }
    return {
        "slots": slots,
        "counts": counts,
        "summary": summary,
        "total": len(slots),
        # Worst status present, so a caller (or a cron) can act on one field.
        "worst": next((k for k in ("crit", "unknown", "warn", "ok") if counts.get(k)), "ok"),
    }


@router.get("/{hostname}")
def tart_health_host(
    hostname: str, user: str = Depends(require_access), db: Session = Depends(get_db)
) -> dict[str, Any]:
    rows = list(db.scalars(select(TartSlotHealth).where(TartSlotHealth.hostname == hostname)))
    if not rows:
        raise HTTPException(status_code=404, detail=f"No tart health data for {hostname}")
    all_slots = tart_health(user=user, db=db)["slots"]
    return {"hostname": hostname, "slots": [s for s in all_slots if s["hostname"] == hostname]}
