"""Batched job-source endpoints: one request per page, not one per pool.

These exist because the per-pool loops were measured, on 2026-09-17, as 49 of the
100 requests in a single minute that tripped Cloud Armor and replaced the
dashboard with a bare "429 Too Many Requests" page:

    /api/fleet/pool-sources          35
    /api/fleet/android-pool-sources  14

Both per-pool computations were already cached server-side, so the cost was purely
request COUNT -- which is exactly what a per-IP rate limiter charges for. The batch
variants must therefore collapse N requests into 1 while returning byte-identical
per-pool payloads, so no card changes behaviour.

Dependency-light on purpose (no DB, no Taskcluster): the compute functions are
monkeypatched, since what is under test is batching, parsing and fan-out -- not
the sampling itself.
"""
from __future__ import annotations

import pytest
from app import cache
from app.api import fleet


@pytest.fixture(autouse=True)
def _clear_cache():
    """The SWR cache is module-global; a leaked key would make these order-dependent."""
    cache._cache.clear()
    cache._refreshing.clear()
    yield
    cache._cache.clear()
    cache._refreshing.clear()


# ── Parsing ─────────────────────────────────────────────────────────────────────

def test_parses_and_preserves_order():
    assert fleet._parse_pools("b,a,c") == ["b", "a", "c"]


def test_tolerates_whitespace_and_empty_segments():
    assert fleet._parse_pools(" a , ,b ,") == ["a", "b"]


def test_deduplicates_repeated_pools():
    """A repeated name must not become a repeated compute -- that is the whole point."""
    assert fleet._parse_pools("a,b,a,b,a") == ["a", "b"]


def test_empty_input_yields_no_pools():
    assert fleet._parse_pools("") == []
    assert fleet._parse_pools(" , , ") == []


def test_batch_size_is_bounded():
    """An unbounded batch would just move the fan-out server-side."""
    names = ",".join(f"pool-{i}" for i in range(fleet._MAX_BATCH_POOLS + 50))
    assert len(fleet._parse_pools(names)) == fleet._MAX_BATCH_POOLS


# ── Batching ────────────────────────────────────────────────────────────────────

def test_batch_returns_one_entry_per_pool(monkeypatch):
    calls: list[str] = []

    def fake(pool: str) -> dict:
        calls.append(pool)
        return {"pool": pool, "sample_size": 7, "by_project": {}, "by_user": {}}

    monkeypatch.setattr(fleet, "_compute_pool_sources", fake)
    out = fleet.pool_sources_batch("alpha,beta,gamma")

    assert sorted(out["sources"]) == ["alpha", "beta", "gamma"]
    assert sorted(calls) == ["alpha", "beta", "gamma"]
    assert out["sources"]["beta"]["sample_size"] == 7


def test_batch_payload_is_identical_to_the_single_pool_route(monkeypatch):
    """The frontend swapped N single calls for one batch; the per-pool value must not drift."""
    payload = {"pool": "alpha", "sample_size": 3,
               "by_project": {"autoland": 3}, "by_user": {"someone": 3}}
    monkeypatch.setattr(fleet, "_compute_pool_sources", lambda pool: dict(payload, pool=pool))

    single = fleet.pool_sources("alpha")
    cache._cache.clear()
    batched = fleet.pool_sources_batch("alpha")["sources"]["alpha"]

    assert batched == single


def test_batch_is_served_from_the_existing_cache(monkeypatch):
    """A warm batch must do zero computation -- these keys share the single route's cache."""
    calls: list[str] = []
    monkeypatch.setattr(fleet, "_compute_pool_sources",
                        lambda pool: (calls.append(pool), {"pool": pool})[1])

    fleet.pool_sources_batch("alpha,beta")
    assert sorted(calls) == ["alpha", "beta"]

    calls.clear()
    fleet.pool_sources_batch("alpha,beta")
    assert calls == []


def test_one_failing_pool_does_not_fail_the_batch(monkeypatch):
    """Previously each pool was its own request, so one failure cost one card."""
    def flaky(pool: str) -> dict:
        if pool == "bad":
            raise RuntimeError("taskcluster said no")
        return {"pool": pool, "sample_size": 1, "by_project": {}, "by_user": {}}

    monkeypatch.setattr(fleet, "_compute_pool_sources", flaky)
    out = fleet.pool_sources_batch("good,bad,alsogood")

    assert sorted(out["sources"]) == ["alsogood", "good"]
    assert "bad" not in out["sources"]


def test_empty_batch_short_circuits(monkeypatch):
    called = False

    def fake(pool: str) -> dict:
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr(fleet, "_compute_pool_sources", fake)
    assert fleet.pool_sources_batch("") == {"sources": {}}
    assert called is False


def test_android_batch_uses_the_android_compute(monkeypatch):
    """The two batches must not share a cache namespace, or pools with the same
    name in both would collide."""
    monkeypatch.setattr(fleet, "_compute_pool_sources",
                        lambda pool: {"pool": pool, "which": "hardware"})
    monkeypatch.setattr(fleet, "_compute_android_pool_sources",
                        lambda pool: {"pool": pool, "which": "android"})

    assert fleet.pool_sources_batch("p")["sources"]["p"]["which"] == "hardware"
    assert fleet.android_pool_sources_batch("p")["sources"]["p"]["which"] == "android"


def test_android_single_route_is_now_cached(monkeypatch):
    """It was the one uncached path: one live TC workers call (limit=1000) per pool,
    per page load, 14 times on the Pools page."""
    calls: list[str] = []
    monkeypatch.setattr(fleet, "_compute_android_pool_sources",
                        lambda pool: (calls.append(pool), {"pool": pool})[1])

    fleet.android_pool_sources("gecko-t-lambda-test-1")
    fleet.android_pool_sources("gecko-t-lambda-test-1")

    assert calls == ["gecko-t-lambda-test-1"]
