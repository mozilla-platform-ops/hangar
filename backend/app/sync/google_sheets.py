"""Sync Google Sheets master inventory (read) and write a live export sheet."""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..models import SyncLog, Worker

log = logging.getLogger(__name__)

# Column indices in the master sheet (0-based).
# Adjust if the sheet layout changes.
# Expected header: Hostname | Worker ID | Worker Pool | State | Assigned (if loaner) | MDM Status | Notes | ...
_COL_HOSTNAME = 0
_COL_WORKER_ID = 1
_COL_WORKER_POOL = 2
_COL_STATE = 3
_COL_LOANER_ASSIGNEE = 4
_COL_MDM_STATUS = 5
_COL_NOTES = 6
_COL_KVM = 7  # "Notes" column in source often contains KVM info


def _get_sheets_service() -> Any:
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build  # type: ignore[import-untyped]

    cred_path = settings.google_credentials_json
    if not cred_path or not Path(cred_path).exists():
        raise FileNotFoundError(f"Google credentials file not found: {cred_path}")

    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(cred_path, scopes=scopes)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def _read_sheet(service: Any, sheet_id: str, range_: str = "A:Z") -> list[list[str]]:
    result = service.spreadsheets().values().get(spreadsheetId=sheet_id, range=range_).execute()
    return result.get("values", [])


def run_sync(db: Session) -> int:
    if not settings.google_sheets_id or not settings.google_credentials_json:
        log.warning("Google Sheets not configured — skipping sheets sync")
        return 0

    log_entry = SyncLog(source="sheets", started_at=datetime.utcnow())
    db.add(log_entry)
    db.flush()

    try:
        service = _get_sheets_service()
        rows = _read_sheet(service, settings.google_sheets_id)
        if not rows:
            raise ValueError("No data returned from master sheet")

        # Skip header row
        data_rows = rows[1:] if rows[0] and rows[0][0].lower() in ("hostname", "host") else rows

        def cell(row: list[str], idx: int) -> str:
            return row[idx].strip() if idx < len(row) else ""

        count = 0
        for row in data_rows:
            hostname = cell(row, _COL_HOSTNAME)
            if not hostname or "." not in hostname:
                continue

            worker = db.get(Worker, hostname)
            if worker is None:
                worker = Worker(hostname=hostname)
                db.add(worker)

            worker.worker_id = cell(row, _COL_WORKER_ID) or worker.worker_id
            if not worker.worker_pool:
                worker.worker_pool = cell(row, _COL_WORKER_POOL)
            worker.sheet_state = cell(row, _COL_STATE) or None
            worker.sheet_loaner_assignee = cell(row, _COL_LOANER_ASSIGNEE) or None
            # Notes column often has KVM info (e.g., "nuckvm11.wintest2.releng.mdc1.mozilla.com:10")
            notes_raw = cell(row, _COL_NOTES)
            if "nuckvm" in notes_raw or "wintest" in notes_raw:
                worker.sheet_kvm = notes_raw
            else:
                worker.sheet_notes = notes_raw or worker.sheet_notes

            if not worker.generation:
                h = hostname.lower()
                worker.generation = "m4" if "-m4-" in h else "m2" if "-m2-" in h else "r8" if "-r8-" in h else None

            worker.last_synced_sheet = datetime.utcnow()
            count += 1

        db.commit()

        # Write the live export sheet
        if settings.google_export_sheet_id:
            _write_export_sheet(service, db)

        log_entry.finished_at = datetime.utcnow()
        log_entry.records_updated = count
        log_entry.success = True
        db.commit()
        log.info("Sheets sync complete: %d records", count)
        return count

    except Exception as exc:
        db.rollback()
        log.exception("Sheets sync failed")
        log_entry.finished_at = datetime.utcnow()
        log_entry.error = str(exc)
        log_entry.success = False
        db.commit()
        raise


def _write_export_sheet(service: Any, db: Session) -> None:
    """Overwrite the export sheet with the current merged worker data."""
    workers = db.query(Worker).order_by(Worker.hostname).all()

    header = [
        "Hostname", "Worker ID", "Generation", "Worker Pool", "Puppet Role",
        "State", "OS Version", "MDM Enrollment", "MDM Groups",
        "TC State", "TC Last Active", "TC Quarantined",
        "SafariDriver", "VideoDongle", "Worker Config", "Hz", "Resolution",
        "KVM", "Loaner Assignee", "Notes",
        "Last Synced (Puppet)", "Last Synced (MDM)", "Last Synced (TC)", "Last Synced (Sheet)",
    ]

    rows = [header]
    for w in workers:
        rows.append([
            w.hostname or "",
            w.worker_id or "",
            w.generation or "",
            w.worker_pool or "",
            w.puppet_role or "",
            w.sheet_state or "",
            w.os_version or "",
            w.mdm_enrollment_status or "",
            w.mdm_groups or "",
            w.tc_state or "",
            str(w.tc_last_active) if w.tc_last_active else "",
            str(w.tc_quarantined) if w.tc_quarantined is not None else "",
            w.safari_driver or "",
            w.video_dongle or "",
            w.worker_config or "",
            w.refresh_hz or "",
            w.resolution or "",
            w.sheet_kvm or "",
            w.sheet_loaner_assignee or "",
            w.sheet_notes or "",
            str(w.last_synced_puppet) if w.last_synced_puppet else "",
            str(w.last_synced_mdm) if w.last_synced_mdm else "",
            str(w.last_synced_tc) if w.last_synced_tc else "",
            str(w.last_synced_sheet) if w.last_synced_sheet else "",
        ])

    service.spreadsheets().values().update(
        spreadsheetId=settings.google_export_sheet_id,
        range="A1",
        valueInputOption="RAW",
        body={"values": rows},
    ).execute()
    log.info("Wrote %d rows to export sheet", len(rows) - 1)
