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
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Alert, SyncLog, Worker

log = logging.getLogger(__name__)

SIMPLEMDM_BASE = "https://a.simplemdm.com/api/v1"


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
                attrs = item.get("attributes", {})
                name = attrs.get("name", "")
                value = attrs.get("value") or ""
                if name:
                    result[name] = value
            return result
        except Exception:
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
        if candidate and any(candidate.startswith(p) for p in ("macmini-", "adhoc-mac", "dep-mac", "fx-mac", "tb-mac", "vpn-mac")):
            short = candidate.split(".")[0]
            return f"{short}.test.releng.mdc1.mozilla.com"
    return None


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

        count = 0
        for device in devices:
            hostname = _hostname_from_device(device)
            if not hostname:
                continue

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

            # Backfill worker_pool from MDM Worker_Config if Puppet/TC haven't set it.
            if not worker.worker_pool and worker.worker_config:
                worker.worker_pool = worker.worker_config

            if not worker.generation:
                h = hostname.lower()
                worker.generation = "m4" if "-m4-" in h else "m2" if "-m2-" in h else "r8" if "-r8-" in h else None

            worker.last_synced_mdm = datetime.utcnow()

            # Alert: MDM unenrolled for production worker
            if (worker.sheet_state == "production" or worker.puppet_role) and attrs.get("status") == "unenrolled":
                existing = (
                    db.query(Alert)
                    .filter(Alert.hostname == hostname, Alert.alert_type == "mdm_unenrolled", Alert.resolved_at == None)  # noqa: E711
                    .first()
                )
                if not existing:
                    db.add(Alert(alert_type="mdm_unenrolled", hostname=hostname, detail="MDM enrollment status: unenrolled"))
            count += 1

        db.commit()
        log_entry.finished_at = datetime.utcnow()
        log_entry.records_updated = count
        log_entry.success = True
        db.commit()
        log.info("SimpleMDM sync complete: %d records", count)
        return count

    except Exception as exc:
        db.rollback()
        log.exception("SimpleMDM sync failed")
        log_entry.finished_at = datetime.utcnow()
        log_entry.error = str(exc)
        log_entry.success = False
        db.commit()
        raise
