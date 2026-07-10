"""Shared thread-safe TTL cache with stale-while-revalidate (SWR).

The dashboard has a few read paths that fan out to slow external services on
every request — Taskcluster per-task sampling (job sources), Treeherder (try
pushes), Bugzilla (needinfos). Left uncached (or cached but blocking on expiry)
they make pages "pop in" seconds after the rest of the UI has rendered.

This cache serves a value the instant one exists — *including a stale one, while
a single background thread refreshes it* — so only the very first (cold) fetch
for a key ever blocks a request. A background warmer can pre-populate keys so
even that first request is warm (see ``fleet.warm_pool_sources``).
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

log = logging.getLogger(__name__)

# key -> (monotonic_ts, payload)
_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
# keys with an in-flight background refresh, so we never spawn duplicates
_refreshing: set[str] = set()
_MAX_ENTRIES = 1000


def get_stale(key: str) -> Any | None:
    """Return the cached payload regardless of age, or None if the key is absent."""
    with _lock:
        hit = _cache.get(key)
    return hit[1] if hit else None


def set(key: str, payload: Any) -> None:  # noqa: A001 - deliberate cache-style API
    """Store/replace a value (used by warmers and the cold-miss path)."""
    with _lock:
        if len(_cache) > _MAX_ENTRIES:
            _cache.clear()  # crude bound; these caches are tiny and self-heal
        _cache[key] = (time.monotonic(), payload)


def _background_refresh(key: str, fetch: Callable[[], Any]) -> None:
    try:
        payload = fetch()
    except Exception:
        # Keep the last good value; a transient upstream blip must not evict it.
        log.warning("cache: background refresh failed for %s", key, exc_info=True)
        return
    finally:
        with _lock:
            _refreshing.discard(key)
    set(key, payload)


def _spawn_refresh(key: str, fetch: Callable[[], Any]) -> None:
    with _lock:
        if key in _refreshing:
            return
        _refreshing.add(key)
    threading.Thread(
        target=_background_refresh, args=(key, fetch), name=f"cache-refresh:{key}", daemon=True
    ).start()


def swr(key: str, ttl: float, fetch: Callable[[], Any]) -> Any:
    """Stale-while-revalidate get.

    - Fresh hit  -> return it.
    - Stale hit  -> return the stale value immediately, refresh in the background.
    - Cold miss  -> fetch synchronously (blocks this one request), store, return.

    ``fetch`` may run on a background thread, so it must NOT close over a
    request-scoped DB session — open its own (SessionLocal) if it needs one.
    """
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None:
        ts, payload = hit
        if (now - ts) >= ttl:
            _spawn_refresh(key, fetch)
        return payload
    payload = fetch()  # cold: block once
    set(key, payload)
    return payload
