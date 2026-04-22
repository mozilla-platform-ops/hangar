"""Sync Windows NUC inventory from worker-images/pools.yml.

Taskcluster only knows about workers that have successfully checked in, so
NUCs that are deployed but offline, broken, or waiting for reimage never
appear there. The canonical Windows inventory is a YAML file maintained in
the ``worker-images`` repo; parsing it lets hangar track the full fleet and
raise missing_from_tc alerts for silent workers.
"""
from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

import yaml
from sqlalchemy.orm import Session

from ..config import settings
from ..models import SyncLog, Worker
from ._git import ensure_repo

log = logging.getLogger(__name__)

POOLS_YAML_RELPATH = "provisioners/windows/MDC1Windows/pools.yml"


def _generation_from_hostname(hostname: str) -> str | None:
    short = hostname.split(".", 1)[0]
    if short.startswith("t-nuc12-"):
        return "nuc12"
    if short.startswith("nuc13-"):
        return "nuc13"
    return None


def _parse_pools_yaml(path: Path) -> list[dict]:
    """Return a flat list of {hostname, worker_pool, puppet_role}."""
    raw = yaml.safe_load(path.read_text()) or {}
    entries: list[dict] = []
    for pool in raw.get("pools", []):
        pool_name = pool.get("name")
        suffix = pool.get("domain_suffix", "").strip(".")
        if not pool_name or not suffix:
            log.warning("Skipping pool with missing name/domain_suffix: %r", pool)
            continue
        for node in pool.get("nodes", []) or []:
            short = str(node).strip()
            if not short:
                continue
            entries.append({
                "hostname": f"{short}.{suffix}",
                "worker_pool": pool_name,
                "puppet_role": pool_name,
            })
    return entries


def run_sync(db: Session) -> int:
    log_entry = SyncLog(source="windows_inventory", started_at=datetime.utcnow())
    db.add(log_entry)
    db.flush()

    try:
        ensure_repo(
            settings.worker_images_repo_url,
            settings.worker_images_repo_path,
            "main",
        )
        pools_yaml = Path(settings.worker_images_repo_path) / POOLS_YAML_RELPATH
        if not pools_yaml.exists():
            raise FileNotFoundError(f"pools.yml not found at {pools_yaml}")

        entries = _parse_pools_yaml(pools_yaml)
        log.info("Parsed %d Windows inventory entries", len(entries))

        count = 0
        for entry in entries:
            hostname = entry["hostname"]
            worker = db.get(Worker, hostname)
            if worker is None:
                worker = Worker(hostname=hostname)
                db.add(worker)

            worker.worker_id = hostname.split(".", 1)[0]
            worker.platform = "windows"
            worker.worker_pool = entry["worker_pool"]
            worker.puppet_role = entry["puppet_role"]
            gen = _generation_from_hostname(hostname)
            if gen:
                worker.generation = gen
            worker.last_synced_windows_inventory = datetime.utcnow()
            count += 1

        db.commit()
        log_entry.finished_at = datetime.utcnow()
        log_entry.records_updated = count
        log_entry.success = True
        db.commit()
        log.info("Windows inventory sync complete: %d records", count)
        return count

    except Exception as exc:
        db.rollback()
        log.exception("Windows inventory sync failed")
        db.add(log_entry)
        log_entry.finished_at = datetime.utcnow()
        log_entry.error = str(exc)[:500]
        log_entry.success = False
        db.commit()
        raise
