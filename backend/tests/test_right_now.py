"""Right now: project buckets and pool platforms."""
from __future__ import annotations

import pytest

from app.api.right_now import pool_platform, project_bucket


@pytest.mark.parametrize("project, bucket", [
    ("autoland", "autoland"),
    ("try", "try"),
    ("comm-try", "thunderbird"),        # Thunderbird's try is Thunderbird work
    ("enterprise-thunderbird", "thunderbird"),
    ("comm-central", "thunderbird"),
    ("mozilla-central", "central"),
    ("mozilla-beta", "release"),
    ("mozilla-release", "release"),
    ("mozilla-esr140", "release"),
    ("enterprise-firefox", None),       # everything else is "other work", no new colour
    ("unknown", None),
    ("", None),
    (None, None),
])
def test_project_bucket(project: str | None, bucket: str | None) -> None:
    assert project_bucket(project) == bucket


def test_pool_platform_prefers_worker_rows_then_name() -> None:
    by_worker = {"gecko-t-osx-1500-m4": "mac"}
    assert pool_platform("gecko-t-osx-1500-m4", by_worker) == "mac"
    assert pool_platform("gecko-t-bitbar-gw-perf-a55", {}) == "android"
    assert pool_platform("gecko-t-lambda-perf-a55", {}) == "android"
    assert pool_platform("gecko-t-osx-2600-m4", {}) == "mac"
    assert pool_platform("gecko-t-linux-talos-2404-relops", {}) == "linux"
    assert pool_platform("win11-64-24h2-hw-perf-sheriff", {}) == "windows"
    assert pool_platform("something-else", {}) is None
