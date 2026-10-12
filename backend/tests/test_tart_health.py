"""Tart slot severity under per-task VM reversion, and probe coverage vs health.

Since 2026-09-15 every task ends with the guest halting and the host re-cloning the
VM, so a sweep can catch a healthy slot stopped or still booting. And the guest probe
key is placed by hand, so most hosts never probe the guest at all. Neither is a slot
fault, and both were painting 30+ of 42 slots warn/crit.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from app.api import tart_health
from app.api.tart_health import DOWN_CONFIRM_S, HealthPush, SlotPush, evaluate
from app.database import Base
from app.models import TartSlotHealth
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker


def slot(**kw) -> SlotPush:
    fields = {"hostname": "macmini-m4-185", "slot": 1, "vm_name": "sequoia-tester-1",
              "worker_id": "mac-d94b4a", "vm_state": "running", "registered": True,
              "quarantined": False} | kw
    return SlotPush(**fields)


def test_no_probe_key_is_not_a_warning():
    status, problems = evaluate(slot(guest_reachable=False, probe_key_present=False))
    assert (status, problems) == ("ok", [])


def test_agent_too_old_to_report_the_key_is_not_a_warning():
    status, _ = evaluate(slot(guest_reachable=False, probe_key_present=None))
    assert status == "ok"


def test_silent_guest_with_key_is_a_note_on_first_sighting():
    status, problems = evaluate(slot(guest_reachable=False, probe_key_present=True))
    assert status == "ok"
    assert "booting" in problems[0]


def test_silent_guest_with_key_warns_on_second_sweep():
    status, _ = evaluate(slot(guest_reachable=False, probe_key_present=True),
                         guest_unreachable_for_s=DOWN_CONFIRM_S + 300)
    assert status == "warn"


@pytest.mark.parametrize("state", ["stopped", "missing"])
def test_vm_down_once_is_the_reclone_window(state):
    status, problems = evaluate(slot(vm_state=state))
    assert status == "ok"
    assert "re-cloned" in problems[0]


def test_vm_down_across_sweeps_is_crit():
    status, _ = evaluate(slot(vm_state="stopped"), vm_down_for_s=600)
    assert status == "crit"


def test_unregistered_is_crit_even_on_first_sighting():
    status, _ = evaluate(slot(vm_state="stopped", registered=False))
    assert status == "crit"


@pytest.fixture
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        yield session


def push(db: Session, *slots: SlotPush, at: datetime) -> None:
    class _Clock(datetime):
        @classmethod
        def utcnow(cls):
            return at
    orig = tart_health.datetime
    tart_health.datetime = _Clock
    try:
        tart_health.agent_push(HealthPush(slots=list(slots)), runner="test", db=db)
    finally:
        tart_health.datetime = orig


def test_stopped_vm_goes_crit_only_on_the_next_sweep(db):
    t0 = datetime.utcnow() - timedelta(minutes=10)
    push(db, slot(vm_state="stopped"), at=t0)
    assert db.get(TartSlotHealth, ("macmini-m4-185", 1)).status == "ok"
    push(db, slot(vm_state="stopped"), at=t0 + timedelta(seconds=600))
    assert db.get(TartSlotHealth, ("macmini-m4-185", 1)).status == "crit"


def test_running_again_resets_the_clock(db):
    t0 = datetime.utcnow() - timedelta(minutes=20)
    push(db, slot(vm_state="stopped"), at=t0)
    push(db, slot(), at=t0 + timedelta(seconds=600))
    push(db, slot(vm_state="stopped"), at=t0 + timedelta(seconds=1200))
    row = db.get(TartSlotHealth, ("macmini-m4-185", 1))
    assert row.status == "ok"
    assert row.vm_down_since == t0 + timedelta(seconds=1200)


def test_failed_collection_keeps_the_clock(db):
    t0 = datetime.utcnow() - timedelta(minutes=20)
    push(db, slot(vm_state="stopped"), at=t0)
    push(db, SlotPush(hostname="macmini-m4-185", slot=1, agent_error="ssh failed twice"),
         at=t0 + timedelta(seconds=600))
    push(db, slot(vm_state="stopped"), at=t0 + timedelta(seconds=1200))
    assert db.get(TartSlotHealth, ("macmini-m4-185", 1)).status == "crit"


def test_summary_counts_hosts_not_slots(db):
    now = datetime.utcnow()
    push(
        db,
        slot(guest_reachable=False, probe_key_present=False),
        slot(slot=2, worker_id="mac-2d0121", guest_reachable=False, probe_key_present=False),
        slot(hostname="macmini-m4-235", guest_reachable=True, guest_uptime_s=600,
             probe_key_present=True),
        SlotPush(hostname="macmini-m4-190", slot=1, agent_error="ssh failed twice: exec request failed"),
        SlotPush(hostname="macmini-m4-190", slot=2, agent_error="ssh failed twice: exec request failed"),
        at=now,
    )
    out = tart_health.tart_health(user="test", db=db)
    summary = out["summary"]
    assert summary["serving"] == 3
    assert summary["guest_checked"] == 1
    assert summary["no_probe_key_hosts"] == ["macmini-m4-185"]
    assert [h["hostname"] for h in summary["uncollected_hosts"]] == ["macmini-m4-190"]
    assert out["counts"] == {"ok": 3, "warn": 0, "crit": 0, "unknown": 2}
