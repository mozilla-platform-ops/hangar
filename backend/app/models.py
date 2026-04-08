"""SQLAlchemy ORM models."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class Worker(Base):
    __tablename__ = "workers"

    hostname: Mapped[str] = mapped_column(String(255), primary_key=True)
    worker_id: Mapped[str | None] = mapped_column(String(255))
    generation: Mapped[str | None] = mapped_column(String(20))  # r8 / m2 / m4

    # From Puppet inventory.d
    worker_pool: Mapped[str | None] = mapped_column(String(255))
    puppet_role: Mapped[str | None] = mapped_column(String(255))

    # From master Google Sheet
    sheet_state: Mapped[str | None] = mapped_column(String(50))   # production/loaner/defective/spare/staging
    sheet_kvm: Mapped[str | None] = mapped_column(String(255))
    sheet_loaner_assignee: Mapped[str | None] = mapped_column(String(100))
    sheet_notes: Mapped[str | None] = mapped_column(Text)

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
    tc_worker_pool_id: Mapped[str | None] = mapped_column(String(255))

    @property
    def effective_state(self) -> str:
        """State from Google Sheets if available; otherwise infer from TC/Puppet membership."""
        if self.sheet_state:
            return self.sheet_state
        if self.tc_worker_pool_id or self.puppet_role:
            return "production"
        return "unknown"

    # Sync bookkeeping
    last_synced_puppet: Mapped[datetime | None] = mapped_column(DateTime)
    last_synced_mdm: Mapped[datetime | None] = mapped_column(DateTime)
    last_synced_tc: Mapped[datetime | None] = mapped_column(DateTime)
    last_synced_sheet: Mapped[datetime | None] = mapped_column(DateTime)
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


class SyncLog(Base):
    __tablename__ = "sync_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(50))   # puppet / simplemdm / taskcluster / sheets
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
    records_updated: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    success: Mapped[bool | None] = mapped_column(Boolean)
