"""Sync SimpleMDM device data into the workers table.

Uses SimpleMDM REST API v1 (https://a.simplemdm.com/api/v1/).
Auth: HTTP Basic with API key as username, blank password.
"""
from __future__ import annotations

import logging
from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Any

import requests
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Alert, SyncLog, Worker

log = logging.getLogger(__name__)

SIMPLEMDM_BASE = "https://a.simplemdm.com/api/v1"

# Hostname prefixes for the Mac fleet that SimpleMDM is the source of truth for.
# Only these hosts are eligible for MDM-driven removal — Linux/Windows workers
# are never enrolled in SimpleMDM and must be left untouched.
MDM_MANAGED_PREFIXES = ("macmini-", "adhoc-mac", "dep-mac", "fx-mac", "tb-mac", "vpn-mac")


class SimpleMDMClient:
    def __init__(self, api_key: str) -> None:
        self.session = requests.Session()
        token = b64encode(f"{api_key}:".encode()).decode()
        self.session.headers["Authorization"] = f"Basic {token}"
        self.session.headers["Accept"] = "application/json"

    def _get(self, path: str, params: dict | None = None) -> dict[str, Any]:
        resp = self.session.get(f"{SIMPLEMDM_BASE}{path}", params=params or {}, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def list_devices(self) -> list[dict[str, Any]]:
        """Paginate through all devices."""
        devices: list[dict] = []
        params: dict[str, Any] = {"limit": 100}
        while True:
            data = self._get("/devices", params)
            devices.extend(data.get("data", []))
            if not data.get("has_more"):
                break
            # next page: use the last device id as starting_after
            last_id = data["data"][-1]["id"]
            params["starting_after"] = last_id
        return devices

    def get_device_custom_attributes(self, device_id: int) -> dict[str, str]:
        """Return {attr_name: value} for a single device."""
        try:
            data = self._get(f"/devices/{device_id}/custom_attribute_values")
            result: dict[str, str] = {}
            for item in data.get("data", []):
                name = item.get("id", "")
                value = item.get("attributes", {}).get("value") or ""
                if name:
                    result[name] = value
            return result
        except Exception:
            log.warning("Failed to fetch custom attributes for device %s", device_id, exc_info=True)
            return {}

    def bulk_custom_attribute_values(self, device_ids: list[int], workers: int = 10) -> dict[int, dict[str, str]]:
        """Fetch custom attributes for all devices in parallel."""
        result: dict[int, dict[str, str]] = {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(self.get_device_custom_attributes, did): did for did in device_ids}
            for future in as_completed(futures):
                did = futures[future]
                result[did] = future.result()
        return result



def _hostname_from_device(device: dict[str, Any]) -> str | None:
    """Derive hostname from SimpleMDM device name or device_name field."""
    attrs = device.get("attributes", {})
    name = attrs.get("name", "")
    device_name = attrs.get("device_name", "")
    # prefer the SimpleMDM name (which should be set to the hostname short form)
    for candidate in (name, device_name):
        if candidate and any(candidate.startswith(p) for p in MDM_MANAGED_PREFIXES):
            short = candidate.split(".")[0]
            return f"{short}.test.releng.mdc1.mozilla.com"
    return None


def _remove_absent_from_mdm(db: Session, seen_hostnames: set[str]) -> int:
    """Delete Mac workers that SimpleMDM no longer knows about.

    SimpleMDM is the source of truth for the Mac fleet: once a host is removed
    from MDM (e.g. on decommission) it should disappear from the dashboard.

    A host qualifies for removal only if it (a) previously had an MDM record
    (``last_synced_mdm`` set), (b) carries an MDM-managed Mac prefix, and (c) was
    not returned in the current sync cycle. Requiring a prior MDM record means a
    Mac still mid-provisioning — puppet-managed but not yet enrolled — is never
    deleted; only hosts that were enrolled and then dropped get swept.
    """
    # Guard: if the device fetch returned nothing usable, do not interpret that
    # as "the whole fleet was decommissioned" and wipe every Mac.
    if not seen_hostnames:
        log.warning("SimpleMDM returned no recognizable hosts — skipping removal pass")
        return 0

    orphans = (
        db.query(Worker)
        .filter(Worker.last_synced_mdm != None)  # noqa: E711 — was managed by MDM
        .filter(or_(*[Worker.hostname.like(f"{p}%") for p in MDM_MANAGED_PREFIXES]))
        .filter(Worker.hostname.notin_(seen_hostnames))
        .all()
    )

    removed = 0
    for worker in orphans:
        # Drop any alerts tied to the host — they reference hostname, no FK cascade.
        db.query(Alert).filter(Alert.hostname == worker.hostname).delete(synchronize_session=False)
        db.delete(worker)
        removed += 1
        log.info("Removing %s — no longer present in SimpleMDM", worker.hostname)
    return removed


def run_sync(db: Session) -> int:
    if not settings.simplemdm_api_key:
        log.warning("SIMPLEMDM_API_KEY not set — skipping MDM sync")
        return 0

    log_entry = SyncLog(source="simplemdm", started_at=datetime.utcnow())
    db.add(log_entry)
    db.flush()

    try:
        client = SimpleMDMClient(settings.simplemdm_api_key)

        log.info("Fetching SimpleMDM devices...")
        devices = client.list_devices()
        log.info("Fetched %d devices", len(devices))

        device_ids = [d["id"] for d in devices]
        log.info("Fetching SimpleMDM custom attribute values for %d devices...", len(device_ids))
        custom_attrs = client.bulk_custom_attribute_values(device_ids)
        sample = next((v for v in custom_attrs.values() if v), None)
        if sample:
            log.info("Sample custom attribute keys: %s", sorted(sample.keys()))
        else:
            log.warning("No custom attribute values returned for any device")

        count = 0
        seen_hostnames: set[str] = set()
        for device in devices:
            hostname = _hostname_from_device(device)
            if not hostname:
                continue
            seen_hostnames.add(hostname)

            attrs = device.get("attributes", {})
            device_id = device["id"]

            worker = db.get(Worker, hostname)
            if worker is None:
                worker = Worker(hostname=hostname)
                db.add(worker)

            worker.mdm_id = device_id
            worker.mdm_name = attrs.get("name")
            worker.serial_number = attrs.get("serial_number")
            worker.os_version = attrs.get("os_version")
            worker.mdm_enrollment_status = attrs.get("status")  # enrolled/unenrolled

            # Custom attributes for this device
            ca = custom_attrs.get(device_id, {})
            worker.safari_driver = ca.get("SafariDriver") or ca.get("safaridriver")
            worker.video_dongle = ca.get("VideoDongle") or ca.get("videodongle")
            worker.worker_config = ca.get("Worker_Config") or ca.get("worker_config")
            worker.refresh_hz = ca.get("Hz") or ca.get("hz")
            worker.resolution = ca.get("Resolution") or ca.get("resolution")
            worker.branch = ca.get("Branch") or ca.get("branch") or None
            worker.git_version = ca.get("git") or None

            # Backfill worker_pool from MDM Worker_Config if Puppet/TC haven't set it.
            if not worker.worker_pool and worker.worker_config:
                worker.worker_pool = worker.worker_config

            if not worker.generation:
                h = hostname.lower()
                worker.generation = "m4" if "-m4-" in h else "m2" if "-m2-" in h else "r8" if "-r8-" in h else None

            worker.last_synced_mdm = datetime.utcnow()

            # Alert: MDM unenrolled for production worker
            if worker.effective_state == "production" and attrs.get("status") == "unenrolled":
                existing = (
                    db.query(Alert)
                    .filter(Alert.hostname == hostname, Alert.alert_type == "mdm_unenrolled", Alert.resolved_at == None)  # noqa: E711
                    .first()
                )
                if not existing:
                    db.add(Alert(alert_type="mdm_unenrolled", hostname=hostname, detail="MDM enrollment status: unenrolled"))
            count += 1

        db.commit()

        # MDM is authoritative for the Mac fleet: remove hosts it no longer lists.
        removed = _remove_absent_from_mdm(db, seen_hostnames)
        db.commit()

        log_entry.finished_at = datetime.utcnow()
        log_entry.records_updated = count
        log_entry.success = True
        db.commit()
        log.info("SimpleMDM sync complete: %d records, %d removed", count, removed)
        return count

    except Exception as exc:
        db.rollback()
        log.exception("SimpleMDM sync failed")
        log_entry.finished_at = datetime.utcnow()
        log_entry.error = str(exc)
        log_entry.success = False
        db.commit()
        raise
