"""Sync Puppet inventory.d YAML files into the workers table."""
from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

import yaml
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Alert, SyncLog, Worker
from ._git import ensure_repo

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


def _parse_inventory_d(inventory_d: Path) -> tuple[list[dict], bool]:
    """Parse all YAML files in inventory.d → (entries, clean).

    `clean` is False if any file failed to parse — the caller must not clear stale roles off a
    partial parse (it would wrongly strip hosts whose file happened to be unreadable)."""
    entries = []
    clean = True
    for yaml_file in sorted(inventory_d.glob("*.yaml")):
        try:
            data = yaml.safe_load(yaml_file.read_text())
        except Exception as exc:
            log.warning("Failed to parse %s: %s", yaml_file, exc)
            clean = False
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
    return entries, clean


def run_sync(db: Session) -> int:
    log_entry = SyncLog(source="puppet", started_at=datetime.utcnow())
    db.add(log_entry)
    db.flush()

    try:
        ensure_repo(settings.puppet_repo_url, settings.puppet_repo_path, "master")
        inventory_d = Path(settings.puppet_repo_path) / "inventory.d"
        if not inventory_d.exists():
            raise FileNotFoundError(f"inventory.d not found at {inventory_d}")

        entries, clean = _parse_inventory_d(inventory_d)
        log.info("Parsed %d entries from puppet inventory.d (clean=%s)", len(entries), clean)

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

        # Clear stale puppet_role for hosts no longer in inventory.d, so a host removed from
        # Puppet (e.g. converted to a one-off loaner) stops looking like a production worker and
        # stops generating missing_from_tc alerts. Only puppet_role is cleared (it's puppet-owned;
        # worker_pool is set by several syncs). Resolve its now-spurious missing_from_tc alert too.
        # Guarded on a clean, non-empty parse so a broken/partial inventory can't mass-clear.
        cleared = 0
        if clean and entries:
            seen = {e["hostname"] for e in entries}
            stale = db.query(Worker).filter(Worker.puppet_role != None, Worker.hostname.notin_(seen)).all()  # noqa: E711
            for w in stale:
                w.puppet_role = None
                for a in (
                    db.query(Alert)
                    .filter(Alert.hostname == w.hostname, Alert.alert_type == "missing_from_tc", Alert.resolved_at == None)  # noqa: E711
                    .all()
                ):
                    a.resolved_at = datetime.utcnow()
                cleared += 1
            if cleared:
                log.info("Puppet sync: cleared stale puppet_role on %d host(s) no longer in inventory.d", cleared)

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
