"""Sync Puppet inventory.d YAML files into the workers table."""
from __future__ import annotations

import logging
import re
import subprocess
from datetime import datetime
from pathlib import Path

import yaml
from sqlalchemy.orm import Session

from ..config import settings
from ..models import SyncLog, Worker

log = logging.getLogger(__name__)

# Map short hostname prefix → generation label
_GENERATION = {
    "macmini-r8": "r8",
    "macmini-m2": "m2",
    "macmini-m4": "m4",
}

# Signing / non-test hostnames that are not mac minis
_SIGNING_PREFIXES = ("adhoc-mac", "dep-mac", "fx-mac", "tb-mac", "vpn-mac")


def _generation_from_hostname(hostname: str) -> str | None:
    for prefix, gen in _GENERATION.items():
        if hostname.startswith(prefix):
            return gen
    return None


def _worker_id_from_hostname(hostname: str) -> str:
    """Strip domain suffix → worker ID (e.g. macmini-r8-50.test.releng... → macmini-r8-50)."""
    return hostname.split(".")[0]


def _ensure_repo(repo_url: str, local_path: str) -> None:
    """Clone or pull the puppet repo."""
    path = Path(local_path)
    git_dir = path / ".git"
    if path.exists() and git_dir.exists():
        log.info("Pulling puppet repo at %s", local_path)
        subprocess.run(["git", "-C", local_path, "pull", "--ff-only", "--quiet"], check=True, timeout=120)
    else:
        log.info("Cloning puppet repo %s → %s", repo_url, local_path)
        # Remove any empty directory left by the Docker volume mount
        if path.exists() and not any(path.iterdir()):
            path.rmdir()
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--depth=1", repo_url, local_path], check=True, timeout=300)


def _parse_inventory_d(inventory_d: Path) -> list[dict]:
    """Parse all YAML files in inventory.d and return a flat list of {hostname, group, puppet_role}."""
    entries = []
    for yaml_file in sorted(inventory_d.glob("*.yaml")):
        try:
            data = yaml.safe_load(yaml_file.read_text())
        except Exception as exc:
            log.warning("Failed to parse %s: %s", yaml_file, exc)
            continue
        for group in data.get("groups", []):
            group_name = group.get("name", "")
            puppet_role = (group.get("facts") or {}).get("puppet_role", "")
            for target in group.get("targets", []):
                if isinstance(target, str):
                    entries.append({
                        "hostname": target,
                        "worker_pool": group_name,
                        "puppet_role": puppet_role,
                    })
    return entries


def run_sync(db: Session) -> int:
    log_entry = SyncLog(source="puppet", started_at=datetime.utcnow())
    db.add(log_entry)
    db.flush()

    try:
        _ensure_repo(settings.puppet_repo_url, settings.puppet_repo_path)
        inventory_d = Path(settings.puppet_repo_path) / "inventory.d"
        if not inventory_d.exists():
            raise FileNotFoundError(f"inventory.d not found at {inventory_d}")

        entries = _parse_inventory_d(inventory_d)
        log.info("Parsed %d entries from puppet inventory.d", len(entries))

        count = 0
        for entry in entries:
            hostname = entry["hostname"]
            worker = db.get(Worker, hostname)
            if worker is None:
                worker = Worker(hostname=hostname)
                db.add(worker)
                count += 1
            else:
                count += 1

            worker.worker_id = _worker_id_from_hostname(hostname)
            worker.generation = _generation_from_hostname(hostname)
            worker.worker_pool = entry["worker_pool"]
            worker.puppet_role = entry["puppet_role"]
            worker.last_synced_puppet = datetime.utcnow()

        db.commit()
        log_entry.finished_at = datetime.utcnow()
        log_entry.records_updated = count
        log_entry.success = True
        db.commit()
        log.info("Puppet sync complete: %d records", count)
        return count

    except Exception as exc:
        db.rollback()
        log.exception("Puppet sync failed")
        log_entry.finished_at = datetime.utcnow()
        log_entry.error = str(exc)
        log_entry.success = False
        db.commit()
        raise
