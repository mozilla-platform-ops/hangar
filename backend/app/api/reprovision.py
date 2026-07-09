"""Reprovision cockpit — allowlist-gated.

Hangar runs on Cloud Run with no network path to MDC1, so it cannot SSH to workers; the
destructive/SSH steps of a reprovision run in the on-VPN `reprovision` CLI. This module is the
control surface around that: it reports a worker's reprovision *readiness* (from the synced
worker row), hands back the exact CLI commands to run, and keeps an audit ledger of who
initiated a reprovision of what. Access is limited to the emails in
`settings.reprovision_authorized_list` (verified via Google IAP).
"""
from __future__ import annotations

import base64
import secrets as _secrets
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Request
from sqlalchemy import desc
from sqlalchemy.orm import Session

from ..auth import current_user
from ..config import settings
from ..database import get_db
from ..hosts import worker_fqdn
from ..models import ReprovisionEvent, ReprovisionJob, Worker

# Job states that mean a reprovision is still open for a host (blocks a second enqueue).
_OPEN_JOB_STATES = {"queued", "claimed", "running"}
# A job open longer than this is presumed dead — its runner finished but couldn't
# report, or vanished. We reap it so a lost completion never wedges a host (a new
# reprovision can't be enqueued while one is "open"). The ceiling must exceed a
# legitimate run: the on-host bootstrap alone can wait up to ~60m for the sentinel
# (bootstrap_max_wait_seconds) with no streamed output, so keep generous headroom.
_STALE_JOB_MINUTES = 120

router = APIRouter(prefix="/reprovision", tags=["reprovision"])

# TC run states that mean a task is still in flight (mirrors the CLI's safe_runner-based
# idle check: a run is busy unless its state is terminal).
_ACTIVE_TASK_STATES = {"pending", "running", "unscheduled", "claimed"}


def _authorized(user: str) -> bool:
    return user.lower() in settings.reprovision_authorized_list


def require_access(request: Request) -> str:
    """Dependency: the IAP-verified email, or 403 if not on the allowlist."""
    user = current_user(request)
    if not _authorized(user):
        raise HTTPException(status_code=403, detail="You aren't authorized for the reprovision action.")
    return user


def _spiffe_host(spiffe: str) -> str:
    """Short hostname from a forge SPIFFE id: spiffe://<td>/host/<host>/role/<role>."""
    marker = "/host/"
    i = spiffe.find(marker)
    if i == -1:
        return ""
    rest = unquote(spiffe[i + len(marker):])
    return rest.split("/", 1)[0].split(".")[0].lower()


def _cn_from_subject_dn(b64_der: str) -> str:
    """Short hostname from the cert's Subject CN, forwarded as X-Client-Cert-Subject-DN
    (base64 DER). We use the CN because GCP's LB unreliably drops the SPIFFE/URI-SAN fields
    (see the vault-broker's auth notes), whereas the Subject DN is forwarded reliably and the
    step-ca mint sets CN = the hostname. Minimal DER scan for the commonName (OID 2.5.4.3)."""
    try:
        der = base64.b64decode(b64_der)
    except Exception:  # noqa: BLE001
        return ""
    cn_oid = b"\x06\x03\x55\x04\x03"  # OID 2.5.4.3 = commonName
    i = der.find(cn_oid)
    if i == -1:
        return ""
    j = i + len(cn_oid)
    if j + 2 > len(der):
        return ""
    # <string-tag><length><value> — CN values are short (single-byte length).
    length = der[j + 1]
    value = der[j + 2 : j + 2 + length]
    return value.decode("utf-8", "replace").split(".")[0].strip().lower()


def require_runner(
    x_reprovision_runner_token: str = Header(default=""),
    x_client_cert_chain_verified: str = Header(default="", alias="X-Client-Cert-Chain-Verified"),
    x_client_cert_spiffe: str = Header(default="", alias="X-Client-Cert-Spiffe"),
    x_client_cert_subject_dn: str = Header(default="", alias="X-Client-Cert-Subject-DN"),
) -> str:
    """Authenticate the on-network runner. Preferred: an mTLS client cert the forge-style LB
    already validated against step-ca's Trust Config (chain-verified) whose host is allowlisted.
    Identity comes from the SPIFFE SAN when present, else the Subject CN (GCP drops the SAN
    fields unreliably; the DN is forwarded reliably). Fallback: the shared runner token.
    Disabled (503) until a host allowlist or token is set.

    Safe because Hangar's Cloud Run ingress is internal-LB-only — the backend is unreachable
    except through the LB, so the X-Client-Cert-* headers can't be spoofed by a direct caller.
    """
    host_allowlist = settings.reprovision_runner_host_list
    token = settings.reprovision_runner_token
    if not host_allowlist and not token:
        raise HTTPException(status_code=503, detail="reprovision runner is not enabled")

    # 1) mTLS client cert (chain validated + forwarded by the LB).
    if x_client_cert_chain_verified.lower() == "true":
        host = _spiffe_host(x_client_cert_spiffe) or _cn_from_subject_dn(x_client_cert_subject_dn)
        if host and host in host_allowlist:
            return f"cert:{host}"
        if host:
            raise HTTPException(status_code=403, detail=f"client cert host '{host}' is not an authorized runner")

    # 2) Shared token.
    if token and _secrets.compare_digest(x_reprovision_runner_token, token):
        return "token"

    raise HTTPException(status_code=401, detail="runner authentication required (client cert or token)")


def _short(hostname: str) -> str:
    return hostname.split(".")[0]


def _active_job(db: Session, hostname: str) -> ReprovisionJob | None:
    job = (
        db.query(ReprovisionJob)
        .filter(ReprovisionJob.hostname == hostname, ReprovisionJob.state.in_(_OPEN_JOB_STATES))
        .order_by(desc(ReprovisionJob.created_at))
        .first()
    )
    if job is None:
        return None
    # Reap a job whose runner vanished / lost its completion, so it stops wedging
    # the host (enqueue 409s while a job is open). Lazy: happens on any status read
    # or enqueue attempt, no background sweep needed.
    ref = job.claimed_at or job.created_at
    if ref and datetime.utcnow() - ref > timedelta(minutes=_STALE_JOB_MINUTES):
        job.state = "failed"
        job.detail = f"stale: no completion within {_STALE_JOB_MINUTES}m — runner presumed gone"
        job.finished_at = datetime.utcnow()
        db.add(ReprovisionEvent(hostname=job.hostname, user="system", action="stale", detail=job.detail))
        db.commit()
        return None
    return job


def _last_job(db: Session, hostname: str) -> ReprovisionJob | None:
    """Most recent job for the host regardless of state — drives the 'last run' line."""
    return (
        db.query(ReprovisionJob)
        .filter(ReprovisionJob.hostname == hostname)
        .order_by(desc(ReprovisionJob.created_at))
        .first()
    )


def _job_dict(j: ReprovisionJob) -> dict[str, Any]:
    return {
        "id": j.id,
        "hostname": j.hostname,
        "short": _short(j.hostname),
        "requested_by": j.requested_by,
        "state": j.state,
        "runner": j.runner,
        "detail": j.detail,
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "claimed_at": j.claimed_at.isoformat() if j.claimed_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
    }


def _readiness(w: Worker) -> dict[str, Any]:
    busy = (w.tc_latest_task_state or "").lower() in _ACTIVE_TASK_STATES
    quarantined = bool(w.tc_quarantined)
    is_m4 = (w.generation or "").lower() == "m4"

    if not quarantined and busy:
        status = "in service — running a task"
    elif quarantined and busy:
        status = "quarantined — draining (task still running)"
    elif quarantined and not busy:
        status = "quarantined & idle — ready to reprovision"
    else:
        status = "in service — idle"

    return {
        "status": status,
        "generation": w.generation,
        "worker_pool": w.worker_pool,
        "puppet_role": w.puppet_role,
        "mdm_enrollment": w.mdm_enrollment_status,
        "tc_state": w.tc_state,
        "quarantined": quarantined,
        "quarantine_until": w.tc_quarantine_until.isoformat() if w.tc_quarantine_until else None,
        "running_task": busy,
        "latest_task_id": w.tc_latest_task_id,
        "latest_task_state": w.tc_latest_task_state,
        # The EACS reprovision flow is Apple-Silicon (M4) only today.
        "supported": is_m4,
    }


def _plan(hostname: str) -> dict[str, Any]:
    short = _short(hostname)
    return {
        "one_command": f"reprovision run {short}",
        "from_wipe": [
            f"reprovision wipe {short}",
            f"reprovision wait-reenroll {short}",
            f"reprovision mint {short}",
            f"reprovision escrow-bst {short}",
            f"reprovision wait-sentinel {short}",
        ],
        "note": (
            "Run on the VPN — the SSH steps (mint/escrow/sentinel) can't run from Hangar. "
            "`run` stays quarantined unless you pass --unquarantine."
        ),
    }


def _recent_events(db: Session, hostname: str) -> list[dict[str, Any]]:
    rows = (
        db.query(ReprovisionEvent)
        .filter(ReprovisionEvent.hostname == hostname)
        .order_by(desc(ReprovisionEvent.created_at))
        .limit(80)  # a full EACS run streams dozens of lines; the cockpit renders them as a live timeline
        .all()
    )
    return [
        {
            "user": e.user,
            "action": e.action,
            "detail": e.detail,
            "at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in rows
    ]


@router.get("/access")
def access(request: Request) -> dict[str, Any]:
    """Whether the caller may use the reprovision action (drives showing the panel)."""
    user = current_user(request)
    return {"user": user, "authorized": _authorized(user)}


# NOTE: must be declared before the `/{hostname:path}` catch-all GET below, or "jobs"
# would be matched as a hostname.
@router.get("/jobs")
def jobs(user: str = Depends(require_access), db: Session = Depends(get_db), limit: int = 20) -> dict[str, Any]:
    """Fleet-wide recent reprovision jobs (all hosts) — drives the dashboard activity indicator."""
    rows = db.query(ReprovisionJob).order_by(desc(ReprovisionJob.created_at)).limit(limit).all()
    return {"jobs": [_job_dict(j) for j in rows]}


# ── Runner endpoints (Phase 2) — authenticated by the shared runner token, not IAP ──────────
# An on-network runner pulls jobs and reports progress; Cloud Run can't reach MDC1 to execute.
# See docs/reprovision-mdc1-runner-design.md.

@router.post("/runner/claim")
def runner_claim(runner: str = Depends(require_runner), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Claim the oldest queued job (FIFO). Returns {job: null} when the queue is empty."""
    job = (
        db.query(ReprovisionJob)
        .filter(ReprovisionJob.state == "queued")
        .order_by(ReprovisionJob.created_at)
        .first()
    )
    if not job:
        return {"job": None}
    job.state = "running"
    job.runner = runner
    job.claimed_at = datetime.utcnow()
    db.add(ReprovisionEvent(hostname=job.hostname, user=f"runner:{runner}", action="claimed", detail=f"job {job.id} claimed"))
    db.commit()
    db.refresh(job)
    return {"job": _job_dict(job)}


@router.post("/runner/jobs/{job_id}/event")
def runner_event(
    job_id: int,
    runner: str = Depends(require_runner),
    db: Session = Depends(get_db),
    message: str = Body(..., embed=True),
) -> dict[str, Any]:
    """Append a progress line from the runner (feeds the live cockpit + audit ledger)."""
    job = db.get(ReprovisionJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    job.state = "running"
    job.detail = message
    db.add(ReprovisionEvent(hostname=job.hostname, user=f"runner:{runner}", action="step", detail=message))
    db.commit()
    return {"ok": True}


@router.post("/runner/jobs/{job_id}/complete")
def runner_complete(
    job_id: int,
    runner: str = Depends(require_runner),
    db: Session = Depends(get_db),
    success: bool = Body(..., embed=True),
    detail: str | None = Body(None, embed=True),
) -> dict[str, Any]:
    job = db.get(ReprovisionJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    job.state = "succeeded" if success else "failed"
    job.detail = detail or job.detail
    job.finished_at = datetime.utcnow()
    db.add(ReprovisionEvent(hostname=job.hostname, user=f"runner:{runner}", action=job.state, detail=detail or f"job {job.id} {job.state}"))
    db.commit()
    return {"ok": True, "state": job.state}


@router.post("/{hostname:path}/enqueue")
def enqueue(hostname: str, user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Queue a reprovision for the on-network runner. One open job per host."""
    w = db.get(Worker, worker_fqdn(hostname))
    if not w:
        raise HTTPException(status_code=404, detail=f"Worker {hostname} not found")
    existing = _active_job(db, w.hostname)
    if existing:
        raise HTTPException(status_code=409, detail=f"a reprovision is already {existing.state} for {hostname}")
    job = ReprovisionJob(hostname=w.hostname, requested_by=user, state="queued")
    db.add(job)
    db.add(ReprovisionEvent(hostname=w.hostname, user=user, action="enqueued", detail="reprovision enqueued for the on-network runner"))
    db.commit()
    db.refresh(job)
    return {"ok": True, "job": _job_dict(job)}


@router.get("/{hostname:path}")
def status(hostname: str, user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    w = db.get(Worker, worker_fqdn(hostname))
    if not w:
        raise HTTPException(status_code=404, detail=f"Worker {hostname} not found")
    aj = _active_job(db, w.hostname)
    lj = _last_job(db, w.hostname)
    return {
        "hostname": w.hostname,
        "short": _short(w.hostname),
        "readiness": _readiness(w),
        "plan": _plan(w.hostname),
        "active_job": _job_dict(aj) if aj else None,
        "last_job": _job_dict(lj) if lj else None,
        "runner_enabled": bool(settings.reprovision_runner_token or settings.reprovision_runner_host_list),
        "events": _recent_events(db, w.hostname),
    }


@router.post("/{hostname:path}/initiate")
def initiate(hostname: str, user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Record that an authorized user is kicking off a reprovision (audit ledger). Execution
    itself is the on-VPN CLI — Hangar can't SSH to the host — so this logs intent + who and
    returns the command to run."""
    w = db.get(Worker, worker_fqdn(hostname))
    if not w:
        raise HTTPException(status_code=404, detail=f"Worker {hostname} not found")
    cmd = f"reprovision run {_short(w.hostname)}"
    ev = ReprovisionEvent(
        hostname=w.hostname,
        user=user,
        action="initiated",
        detail=f"initiated from Hangar — run `{cmd}` on the VPN",
    )
    db.add(ev)
    db.commit()
    return {
        "ok": True,
        "user": user,
        "command": cmd,
        "at": ev.created_at.isoformat() if ev.created_at else None,
        "events": _recent_events(db, w.hostname),
    }
