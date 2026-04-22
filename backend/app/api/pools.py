"""Pool-level batch SSH operations (set/clear branch overrides)."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import asyncssh
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import Worker

log = logging.getLogger(__name__)
router = APIRouter(prefix="/pools", tags=["pools"])

_CONCURRENCY = 10
_RELOPS_USER = "relops"


def _ssh_key() -> asyncssh.SSHKey | None:
    path = Path(settings.ssh_dashboard_key_path)
    if path.exists():
        try:
            return asyncssh.read_private_key(str(path))
        except Exception as exc:
            log.warning("Could not load dashboard SSH key %s: %s", path, exc)
    return None


def _known_hosts() -> str | None:
    path = Path(settings.ssh_known_hosts_path)
    if path.exists():
        return str(path)
    if settings.ssh_insecure_skip_host_check:
        return None
    return None


async def _ssh_run(fqdn: str, command: str, stdin_data: bytes | None = None) -> tuple[int, str]:
    key = _ssh_key()
    try:
        conn = await asyncio.wait_for(
            asyncssh.connect(
                fqdn,
                username=_RELOPS_USER,
                client_keys=[key] if key else [],
                known_hosts=_known_hosts(),
                connect_timeout=10,
            ),
            timeout=15,
        )
        async with conn:
            result = await asyncio.wait_for(
                conn.run(command, input=stdin_data),
                timeout=20,
            )
            rc = result.exit_status or 0
            out = (result.stderr or result.stdout or "").strip()
            return rc, out
    except asyncio.TimeoutError:
        return -1, "timed out"
    except asyncssh.PermissionDenied:
        return -1, "permission denied"
    except Exception as exc:
        return -1, str(exc)


async def _run_pool_op(workers: list[Worker], command: str, stdin_data: bytes | None = None) -> dict[str, Any]:
    sem = asyncio.Semaphore(_CONCURRENCY)

    async def _one(w: Worker) -> dict:
        async with sem:
            rc, err = await _ssh_run(w.hostname, command, stdin_data)
            return {"hostname": w.hostname.split(".")[0], "ok": rc == 0, "error": err if rc != 0 else None}

    results = await asyncio.gather(*[_one(w) for w in workers])
    failed = [r for r in results if not r["ok"]]
    return {"total": len(workers), "succeeded": len(results) - len(failed), "failed": failed}


def _settings_path(platform: str | None) -> str:
    return "/etc/puppet/ronin_settings" if platform == "linux" else "/opt/puppet_environments/ronin_settings"


def _reject_windows(workers: list[Worker], pool_name: str) -> None:
    """Windows workers have no ronin_settings file; refuse branch ops on them."""
    if any(w.platform == "windows" for w in workers):
        raise HTTPException(
            status_code=400,
            detail=f"Branch overrides are not supported on Windows pool {pool_name!r}",
        )


class SetBranchRequest(BaseModel):
    branch: str
    repo: str = "https://github.com/mozilla-platform-ops/ronin_puppet.git"
    email: str = "relops@mozilla.com"


@router.post("/{pool_name}/set-branch")
async def set_pool_branch(pool_name: str, body: SetBranchRequest, db: Session = Depends(get_db)) -> dict[str, Any]:
    workers = db.query(Worker).filter(Worker.worker_pool == pool_name).all()
    if not workers:
        raise HTTPException(status_code=404, detail=f"Pool {pool_name!r} not found")
    _reject_windows(workers, pool_name)

    content = (
        f"# puppet overrides\n"
        f"PUPPET_REPO='{body.repo}'\n"
        f"PUPPET_BRANCH='{body.branch}'\n"
        f"PUPPET_MAIL='{body.email}'\n"
    ).encode()

    async def _set_one(w: Worker) -> dict:
        path = _settings_path(w.platform)
        rc, err = await _ssh_run(w.hostname, f"sudo tee {path} > /dev/null", stdin_data=content)
        if rc == 0 and w.platform == "linux":
            await _ssh_run(w.hostname, f"sudo chmod 640 {path}")
        return {"hostname": w.hostname.split(".")[0], "ok": rc == 0, "error": err if rc != 0 else None}

    sem = asyncio.Semaphore(_CONCURRENCY)
    async def _one(w: Worker) -> dict:
        async with sem:
            return await _set_one(w)

    results = await asyncio.gather(*[_one(w) for w in workers])
    failed = [r for r in results if not r["ok"]]
    return {"total": len(workers), "succeeded": len(results) - len(failed), "failed": failed}


@router.post("/{pool_name}/clear-branch")
async def clear_pool_branch(pool_name: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    workers = db.query(Worker).filter(Worker.worker_pool == pool_name).all()
    if not workers:
        raise HTTPException(status_code=404, detail=f"Pool {pool_name!r} not found")
    _reject_windows(workers, pool_name)

    async def _clear_one(w: Worker) -> dict:
        path = _settings_path(w.platform)
        rc, err = await _ssh_run(w.hostname, f"sudo rm -f {path} && echo ok")
        return {"hostname": w.hostname.split(".")[0], "ok": rc == 0, "error": err if rc != 0 else None}

    sem = asyncio.Semaphore(_CONCURRENCY)
    async def _one(w: Worker) -> dict:
        async with sem:
            return await _clear_one(w)

    results = await asyncio.gather(*[_one(w) for w in workers])
    failed = [r for r in results if not r["ok"]]
    return {"total": len(workers), "succeeded": len(results) - len(failed), "failed": failed}
