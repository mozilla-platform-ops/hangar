"""Treeherder proxy — the signed-in user's recent `try` pushes.

A small Overview nicety: show whoever is logged in (via IAP) their last few
`try` pushes with live job status, linking straight into Treeherder. Treeherder's
API is keyless and CORS-friendly, but we proxy it server-side so we can:

* derive the author from the IAP-authenticated identity (the push author on
  `try` is the engineer's mozilla.com address — the same identity IAP asserts),
* hold a short TTL cache (job status moves on the order of minutes), and
* fan out the per-push status calls concurrently instead of in the browser.

Read-only reference data, so we fetch on demand rather than syncing into the DB.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

import requests
from fastapi import APIRouter, Depends, Query

from .. import cache
from ..auth import current_user
from ..config import settings

router = APIRouter(prefix="/me", tags=["me"])

log = logging.getLogger(__name__)

_TH_BASE = "https://treeherder.mozilla.org"
_PUSH_URL = f"{_TH_BASE}/api/project/try/push/"
_USER_AGENT = "relops-dashboard/1.0"
_CACHE_TTL_SECONDS = 120  # job status moves on the order of minutes
_MAX_PUSHES = 10

# Treeherder status keys that mean "this job went wrong" (anything not in
# {success, completed, pending, running, unknown} we treat as a failure).
_FAILURE_KEYS = ("testfailed", "busted", "exception", "usercancel", "retry", "superseded")

def _get_json(url: str, params: dict[str, Any] | None = None) -> Any:
    resp = requests.get(url, params=params, timeout=6, headers={"User-Agent": _USER_AGENT})
    resp.raise_for_status()
    return resp.json()


def _tip_comment(push: dict[str, Any]) -> str:
    """First line of the tip commit message — for `mach try` pushes this is the
    fuzzy/try query, which is the most useful one-liner for 'what did I test'."""
    revs = push.get("revisions") or []
    if not revs:
        return ""
    return (revs[0].get("comments") or "").splitlines()[0].strip() if revs[0].get("comments") else ""


def _state_from_status(status: dict[str, Any]) -> dict[str, Any]:
    """Collapse Treeherder's per-result counts into a single display state."""
    running = int(status.get("running", 0)) + int(status.get("pending", 0))
    failed = sum(int(status.get(k, 0)) for k in _FAILURE_KEYS)
    success = int(status.get("success", 0))
    if running > 0:
        state = "running"
    elif failed > 0:
        state = "failed"
    elif success > 0 or status:
        state = "success"
    else:
        state = "unknown"
    return {"state": state, "running": running, "failed": failed, "success": success}


def _fetch_status(push_id: int) -> dict[str, Any]:
    try:
        status = _get_json(f"{_PUSH_URL}{push_id}/status/")
        if isinstance(status, dict):
            return _state_from_status(status)
    except (requests.RequestException, ValueError) as exc:
        log.warning("Treeherder push status failed (id=%s): %s", push_id, exc)
    return {"state": "unknown", "running": 0, "failed": 0, "success": 0}


def _build_pushes(author: str, count: int) -> list[dict[str, Any]]:
    data = _get_json(_PUSH_URL, {"author": author, "count": count})
    results = data.get("results") or []

    # Fan out the per-push status calls concurrently — each is cheap, but doing
    # them serially would stack 5+ round-trips onto the request.
    statuses: dict[int, dict[str, Any]] = {}
    if results:
        with ThreadPoolExecutor(max_workers=min(len(results), 8)) as pool:
            for push, status in zip(results, pool.map(lambda p: _fetch_status(p["id"]), results)):
                statuses[push["id"]] = status

    pushes = []
    for p in results:
        rev = p.get("revision", "")
        ts = p.get("push_timestamp")
        pushes.append({
            "revision": rev,
            "short_revision": rev[:12],
            "comment": _tip_comment(p),
            "revision_count": p.get("revision_count", len(p.get("revisions") or [])),
            "pushed_at": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None,
            "treeherder_url": f"{_TH_BASE}/jobs?repo=try&revision={rev}",
            **statuses.get(p["id"], {"state": "unknown", "running": 0, "failed": 0, "success": 0}),
        })
    return pushes


@router.get("/try-pushes")
def get_try_pushes(
    count: int = Query(5, ge=1, le=_MAX_PUSHES),
    user: str = Depends(current_user),
) -> dict[str, Any]:
    """The signed-in user's recent `try` pushes, with live job status.

    The author is the IAP-authenticated identity; `TRY_AUTHOR_OVERRIDE` forces a
    fixed author instead (for local dev, where there is no IAP to assert one).
    """
    author = settings.try_author_override or user
    # No real author to query (e.g. the local-dev placeholder, override unset).
    if "@" not in author or author.endswith("@localhost"):
        return {"author": author, "pushes": [], "treeherder_url": None}

    key = f"try:{author}:{count}"

    def _fetch() -> dict[str, Any]:
        return {
            "author": author,
            "pushes": _build_pushes(author, count),
            "treeherder_url": f"{_TH_BASE}/jobs?repo=try&author={author}",
        }

    # SWR: a warm (even slightly stale) result returns instantly and refreshes in
    # the background; only a cold miss blocks, and an upstream error there soft-fails.
    try:
        return cache.swr(key, _CACHE_TTL_SECONDS, _fetch)
    except (requests.RequestException, ValueError) as exc:
        log.warning("Treeherder try-push fetch failed (%s): %s", author, exc)
        stale = cache.get_stale(key)
        if stale is not None:
            return stale
        # Soft-fail: the Overview rail just hides itself rather than erroring.
        return {"author": author, "pushes": [], "treeherder_url": None}
