"""Bugzilla proxy — bugs that have a `needinfo?` requested of the signed-in user.

An Overview nicety, in the same spirit as the `try`-push rail: surface the bugs
that are blocked on *you* so they don't rot in an inbox you never check. Bugzilla's
REST API is keyless and CORS-friendly, but we proxy it server-side so we can:

* derive the requestee from the IAP-authenticated identity (the same mozilla.com
  address Bugzilla flags are addressed to),
* hold a short TTL cache (needinfo flags move on the order of minutes, not seconds),
* and soft-fail to an empty list so an upstream hiccup just hides the rail.

The `quicksearch=flag:needinfo?<email>` form is exactly Bugzilla's "needinfo
requested of this person" search — it matches the flag *and* its requestee in one
token, which the raw boolean-chart fields make awkward.

Read-only reference data, so we fetch on demand rather than syncing into the DB.
"""
from __future__ import annotations

import logging
from typing import Any

import requests
from fastapi import APIRouter, Depends, Query

from .. import cache
from ..auth import current_user
from ..config import settings

router = APIRouter(prefix="/me", tags=["me"])

log = logging.getLogger(__name__)

_USER_AGENT = "relops-dashboard/1.0"
_CACHE_TTL_SECONDS = 120  # needinfo flags move on the order of minutes
_MAX_BUGS = 50
# `flags` carries the per-flag creation_date — the true "waiting since" for the
# needinfo, which is far more useful than the bug's overall last_change_time.
_FIELDS = "id,summary,status,product,component,flags"



def _build_bugs(email: str, limit: int) -> list[dict[str, Any]]:
    base = settings.bugzilla_url.rstrip("/")
    resp = requests.get(
        f"{base}/rest/bug",
        params={
            "quicksearch": f"flag:needinfo?{email}",
            "include_fields": _FIELDS,
            "limit": limit,
        },
        timeout=8,
        headers={"User-Agent": _USER_AGENT},
    )
    resp.raise_for_status()
    results = resp.json().get("bugs") or []

    bugs = []
    for b in results:
        bug_id = b.get("id")
        bugs.append({
            "id": bug_id,
            "summary": b.get("summary", ""),
            "status": b.get("status", ""),
            "product": b.get("product", ""),
            "component": b.get("component", ""),
            "waiting_since": _needinfo_since(b.get("flags") or [], email),
            "url": f"{base}/show_bug.cgi?id={bug_id}",
        })
    # Oldest-waiting first — the stalest needinfos (the ones nagging you) lead.
    bugs.sort(key=lambda x: x["waiting_since"] or "")
    return bugs


def _needinfo_since(flags: list[dict[str, Any]], email: str) -> str | None:
    """Creation date of *this user's* open needinfo flag, if present."""
    for f in flags:
        if (
            f.get("name") == "needinfo"
            and f.get("status") == "?"
            and (f.get("requestee") or "").lower() == email.lower()
        ):
            return f.get("creation_date") or f.get("modification_date")
    return None


@router.get("/needinfos")
def get_needinfos(
    limit: int = Query(25, ge=1, le=_MAX_BUGS),
    user: str = Depends(current_user),
) -> dict[str, Any]:
    """Bugs with a `needinfo?` flag requested of the signed-in user.

    The requestee is the IAP-authenticated identity; `TRY_AUTHOR_OVERRIDE` forces
    a fixed address instead (for local dev, where there is no IAP to assert one).
    """
    email = settings.try_author_override or user
    # No real identity to query (e.g. the local-dev placeholder, override unset).
    if "@" not in email or email.endswith("@localhost"):
        return {"email": email, "bugs": [], "buglist_url": None}

    base = settings.bugzilla_url.rstrip("/")
    key = f"needinfo:{email}:{limit}"

    def _fetch() -> dict[str, Any]:
        return {
            "email": email,
            "bugs": _build_bugs(email, limit),
            "buglist_url": f"{base}/buglist.cgi?quicksearch=flag%3Aneedinfo%3F{email}",
        }

    # SWR: serve warm/stale instantly, refresh behind the scenes; only a cold miss
    # blocks, and an upstream error there soft-fails.
    try:
        return cache.swr(key, _CACHE_TTL_SECONDS, _fetch)
    except (requests.RequestException, ValueError) as exc:
        log.warning("Bugzilla needinfo fetch failed (%s): %s", email, exc)
        stale = cache.get_stale(key)
        if stale is not None:
            return stale
        # Soft-fail: the Overview rail just hides itself rather than erroring.
        return {"email": email, "bugs": [], "buglist_url": None}
