"""Queued-by-repo sample for the pool cards.

The running sample can't see a starved repo: on 2026-10-16 win11-64-24h2-hw had
1717 pending, mostly try, while every running task was autoland or
mozilla-central (try is the lowest priority). These pin the queue sample that
makes that visible. Taskcluster is faked; no network.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import mohawk
import pytest
from app import cache
from app.api import fleet
from app.config import settings

POOL = "win11-64-24h2-hw"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    cache._cache.clear()
    cache._refreshing.clear()
    monkeypatch.setattr(settings, "tc_client_id", "project/relops/hangar")
    monkeypatch.setattr(settings, "tc_access_token", "secret")
    yield
    cache._cache.clear()
    cache._refreshing.clear()


class _Resp:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def _task(project=None, scheduler="gecko-level-1"):
    tags = {"project": project} if project else {}
    return {"taskId": "x", "runId": 0, "task": {"tags": tags, "schedulerId": scheduler}}


def _fake_tc(monkeypatch, pending, pages):
    """pages: list of task lists; each page but the last carries a continuationToken."""
    calls: list[dict] = []

    def get(url, timeout=None, headers=None, params=None):
        if "/pending/" in url and "task-queues" not in url:
            calls.append({"url": url, "headers": headers or {}})
            return _Resp({"pendingTasks": pending})
        calls.append({"url": url, "headers": headers or {}})
        tok = parse_qs(urlparse(url).query).get("continuationToken", ["0"])[0]
        i = int(tok)
        body = {"tasks": pages[i]}
        if i + 1 < len(pages):
            body["continuationToken"] = str(i + 1)
        return _Resp(body)

    monkeypatch.setattr(fleet.requests, "get", get)
    return calls


def test_counts_queued_tasks_by_project(monkeypatch):
    _fake_tc(monkeypatch, 4, [[_task("try"), _task("try"), _task("autoland"), _task(scheduler="gecko-level-1")]])
    q = fleet._compute_pool_queue(POOL)
    assert q["queued_available"] is True
    assert q["queued_total"] == 4
    assert q["queued_sampled"] == 4
    # No project tag falls back to the scheduler: level-1 is try.
    assert q["queued_by_project"] == {"try": 3, "autoland": 1}


def test_follows_continuation_tokens(monkeypatch):
    calls = _fake_tc(monkeypatch, 3, [[_task("try")], [_task("try")], [_task("autoland")]])
    q = fleet._compute_pool_queue(POOL)
    assert q["queued_sampled"] == 3
    assert sum(1 for c in calls if "task-queues" in c["url"]) == 3


def test_stops_at_the_cap(monkeypatch):
    monkeypatch.setattr(fleet, "_QUEUE_CAP", 2)
    calls = _fake_tc(monkeypatch, 50, [[_task("try"), _task("try")], [_task("autoland")]])
    q = fleet._compute_pool_queue(POOL)
    assert q["queued_total"] == 50
    assert q["queued_sampled"] == 2
    assert sum(1 for c in calls if "task-queues" in c["url"]) == 1


def test_empty_queue_skips_the_signed_listing(monkeypatch):
    calls = _fake_tc(monkeypatch, 0, [[]])
    q = fleet._compute_pool_queue(POOL)
    assert q == {"queued_available": True, "queued_total": 0, "queued_sampled": 0, "queued_by_project": {}}
    assert not any("task-queues" in c["url"] for c in calls)


def test_off_without_credentials(monkeypatch):
    monkeypatch.setattr(settings, "tc_access_token", "")
    calls = _fake_tc(monkeypatch, 5, [[_task("try")]])
    assert fleet._compute_pool_queue(POOL) == {"queued_available": False}
    assert calls == []


def test_off_for_pools_we_dont_know_the_provisioner_of(monkeypatch):
    calls = _fake_tc(monkeypatch, 5, [[_task("try")]])
    assert fleet._compute_pool_queue("not-a-hardware-pool") == {"queued_available": False}
    assert calls == []


def test_listing_is_hawk_signed_with_the_configured_client(monkeypatch):
    calls = _fake_tc(monkeypatch, 1, [[_task("try")]])
    fleet._compute_pool_queue(POOL)
    listing = next(c for c in calls if "task-queues" in c["url"])
    assert "releng-hardware%2Fwin11-64-24h2-hw/pending" in listing["url"]
    creds = {"id": "project/relops/hangar", "key": "secret", "algorithm": "sha256"}
    # Raises if the header doesn't verify for this exact URL and method.
    mohawk.Receiver(lambda _id: creds, listing["headers"]["Authorization"], listing["url"], "GET",
                    accept_untrusted_content=True)


def test_a_queue_failure_leaves_the_card_without_a_queued_bar(monkeypatch):
    def boom(pool):
        raise RuntimeError("tc down")

    monkeypatch.setattr(fleet, "_compute_pool_queue", boom)
    assert fleet._pool_queue(POOL) == {"queued_available": False}


def test_android_pools_list_their_queue_under_proj_autophone(monkeypatch):
    prov, pool = fleet.ANDROID_WORKER_POOLS[0]
    assert prov == "proj-autophone"
    calls = _fake_tc(monkeypatch, 1, [[_task("try")]])
    q = fleet._compute_pool_queue(pool)
    assert q["queued_by_project"] == {"try": 1}
    assert any(f"task-queues/proj-autophone%2F{pool}/pending" in c["url"] for c in calls)
