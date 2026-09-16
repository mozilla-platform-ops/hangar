"""Pool membership: a stale ``worker_pool`` label must not count as membership.

Hangar's first backend tests. They exist because this rule has now been missed
twice on the same pool:

* 2026-07-15 (bf141e8) added the rule to ``fleet.pool_health`` and
  ``workers.list_workers`` but not to the load sampler, so the pinned-pool card
  kept reporting 9 workers for ``gecko-3-b-osx-arm64`` against a real 6 -- the
  three ``macmini-m2`` builders dropped from the pool in 2025, still labelled
  with it and still SimpleMDM-managed in Defective / Spares.
* Nothing in CI executes ``backend/``, so neither miss could be caught.

Deliberately dependency-light: the rule and the sampler's counting are pure, and
the SQL half runs against in-memory SQLite, so there is no database or
Taskcluster round-trip here.
"""
from __future__ import annotations

import pytest
from app.database import Base
from app.models import Worker, exclude_non_pool_members
from app.sync.load_sampler import pool_worker_counts
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

POOL = "gecko-3-b-osx-arm64"


def worker(hostname: str, *, pool: str | None = POOL, groups: str | None = None,
           task_state: str | None = None) -> Worker:
    """A Worker row, unattached to any session -- enough for the pure rule."""
    return Worker(hostname=hostname, worker_pool=pool, mdm_groups=groups,
                  tc_latest_task_state=task_state)


# ── The rule itself ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("groups, pool, expected", [
    (None, POOL, True),                                   # ordinary pool member
    ('["Mac Production"]', POOL, True),                    # a production MDM group
    ('["Defective / Spares"]', POOL, False),               # pulled from service
    ('["Loaner"]', POOL, False),
    ('["Loaner - No Profiles"]', POOL, False),
    ('["Mac Production", "Defective / Spares"]', POOL, False),  # any excluded group counts
    (None, "gecko-1-b-osx-arm64-vms-host", False),         # retired pool
    (None, None, True),                                    # unlabelled: callers bucket as unknown
    ("not json", POOL, True),                              # unparseable groups must not exclude
])
def test_counts_toward_pool(groups: str | None, pool: str | None, expected: bool) -> None:
    assert worker("h", pool=pool, groups=groups).counts_toward_pool is expected


def test_excluded_group_name_must_match_exactly() -> None:
    """Substring-ish names are not excluded -- the set is matched exactly."""
    assert worker("h", groups='["Loaner Pool - Retired"]').counts_toward_pool is True


# ── The sampler's numbers (what the pinned-pool card renders) ────────────────────

def test_sampler_capacity_ignores_stale_labels() -> None:
    """The regression: 6 real members + 3 Defective/Spares must report 6, not 9."""
    workers = [worker(f"macmini-m4-{i}") for i in (120, 123, 124, 193, 195, 196)]
    workers += [worker(f"macmini-m2-{i}", groups='["Defective / Spares"]') for i in (40, 41, 42)]

    capacity, _running = pool_worker_counts(workers)

    assert capacity[POOL] == 6


def test_sampler_running_ignores_stale_labels() -> None:
    """A stale label carrying a stale RUNNING task state must not inflate running."""
    workers = [
        worker("macmini-m4-120", task_state="running"),
        worker("macmini-m4-123", task_state="RUNNING"),
        worker("macmini-m4-124", task_state="completed"),
        worker("macmini-m2-40", groups='["Defective / Spares"]', task_state="running"),
    ]

    capacity, running = pool_worker_counts(workers)

    assert (capacity[POOL], running[POOL]) == (3, 2)


def test_sampler_skips_unlabelled_hosts() -> None:
    """No label means no pool to attribute to -- not an "unknown" sample row."""
    capacity, _running = pool_worker_counts([worker("macmini-m4-120", pool=None)])

    assert capacity == {}


def test_sampler_reports_zero_not_missing_for_a_fully_excluded_pool() -> None:
    """A pool whose every labelled host is excluded is absent, so run_sync's
    capacity.get(pool, 0) records 0 -- never a phantom count."""
    workers = [worker("macmini-m2-40", groups='["Defective / Spares"]')]

    capacity, _running = pool_worker_counts(workers)

    assert capacity.get(POOL, 0) == 0


# ── The SQL half agrees with the property ───────────────────────────────────────

@pytest.fixture
def session():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(bind=engine, tables=[Worker.__table__])
    with sessionmaker(bind=engine)() as s:
        yield s


def test_sql_filter_matches_the_property(session) -> None:
    """``exclude_non_pool_members`` and ``counts_toward_pool`` must not drift --
    the pool-filtered worker table and the pinned-pool card read the same pool."""
    rows = [worker(f"macmini-m4-{i}") for i in (120, 123, 124, 193, 195, 196)]
    rows += [worker(f"macmini-m2-{i}", groups='["Defective / Spares"]') for i in (40, 41, 42)]
    rows.append(worker("macmini-m4-99", groups='["Loaner"]'))
    session.add_all(rows)
    session.commit()

    q = exclude_non_pool_members(session.query(Worker).filter(Worker.worker_pool == POOL))
    kept = {w.hostname for w in q.all()}

    assert kept == {w.hostname for w in rows if w.counts_toward_pool}
    assert kept == {f"macmini-m4-{i}" for i in (120, 123, 124, 193, 195, 196)}


def test_sql_filter_keeps_hosts_with_no_mdm_groups(session) -> None:
    """A Linux worker has no SimpleMDM record at all; NULL must not be filtered out."""
    session.add(worker("t-linux64-ms-195", pool="gecko-t-linux-talos-2404", groups=None))
    session.commit()

    q = exclude_non_pool_members(session.query(Worker))

    assert [w.hostname for w in q.all()] == ["t-linux64-ms-195"]
