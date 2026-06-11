"""Firefox release schedule — sourced from Mozilla's public release data.

Two upstream feeds, both slow-moving reference data (they change a few times a
quarter), so we fetch on demand and hold an in-memory TTL cache rather than
syncing into the DB:

* product-details `firefox_versions.json` — current version per channel plus the
  in-flight train's next string-freeze / merge / release dates.
* whattrainisitnow `future/releases/` — a small ICS feed of the upcoming major
  release dates (the forward calendar), which product-details does not provide.

Release-notes URLs are deterministic from the version, so we build them directly.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from typing import Any

import requests
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/releases", tags=["releases"])

log = logging.getLogger(__name__)

_VERSIONS_URL = "https://product-details.mozilla.org/1.0/firefox_versions.json"
_FUTURE_ICS_URL = "https://whattrainisitnow.com/calendar/future/releases/"
_NOTES_TEMPLATE = "https://www.mozilla.org/en-US/firefox/{}/releasenotes/"
_CACHE_TTL_SECONDS = 60 * 60  # 1h — the feeds update at most a few times a week.
_USER_AGENT = "relops-dashboard/1.0"

_cache: dict[str, Any] | None = None
_cache_at: float = 0.0
_cache_lock = threading.Lock()

# "Firefox 152 go-live ..." -> 152
_FUTURE_SUMMARY_RE = re.compile(r"Firefox\s+(\d+)")


def _notes_url(slug: str) -> str:
    return _NOTES_TEMPLATE.format(slug)


def _major(version: str) -> str:
    """Leading major number, e.g. '152.0b10' -> '152', '140.11.0esr' -> '140'."""
    return version.split(".", 1)[0]


def _build_channels(raw: dict[str, str]) -> list[dict[str, Any]]:
    """Current version per channel, each with a release-notes URL where one exists.

    Nightly has no stable release-notes page, so its notes URL is null.
    """
    beta = raw.get("FIREFOX_DEVEDITION") or raw.get("LATEST_FIREFOX_DEVEL_VERSION") or ""
    release = raw.get("LATEST_FIREFOX_VERSION", "")
    esr = raw.get("FIREFOX_ESR", "")
    esr_prev = raw.get("FIREFOX_ESR115", "")

    def esr_notes(v: str) -> str | None:
        return _notes_url(v.replace("esr", "")) if v else None

    candidates = [
        {"channel": "nightly", "label": "Nightly", "version": raw.get("FIREFOX_NIGHTLY", ""),
         "release_notes": None},
        {"channel": "beta", "label": "Beta / DevEdition", "version": beta,
         "release_notes": _notes_url(f"{beta.split('b', 1)[0]}beta") if beta else None},
        {"channel": "release", "label": "Release", "version": release,
         "release_notes": _notes_url(release) if release else None},
        {"channel": "esr", "label": "ESR", "version": esr, "release_notes": esr_notes(esr)},
        {"channel": "esr_prev", "label": "ESR (previous)", "version": esr_prev,
         "release_notes": esr_notes(esr_prev)},
    ]
    return [c for c in candidates if c["version"]]


def _parse_future_releases(ics_text: str) -> list[dict[str, Any]]:
    """Parse the minimal future-releases ICS into [{version, date, release_notes}]."""
    out: list[dict[str, Any]] = []
    date: str | None = None
    summary: str | None = None
    for line in ics_text.splitlines():
        line = line.strip()
        if line == "BEGIN:VEVENT":
            date = summary = None
        elif line.startswith("DTSTART"):
            val = line.split(":", 1)[1] if ":" in line else ""
            if len(val) >= 8:
                date = f"{val[0:4]}-{val[4:6]}-{val[6:8]}"
        elif line.startswith("SUMMARY"):
            summary = line.split(":", 1)[1] if ":" in line else ""
        elif line == "END:VEVENT" and date and summary:
            m = _FUTURE_SUMMARY_RE.search(summary)
            if m:
                version = m.group(1)
                out.append({
                    "version": version,
                    "date": date,
                    "release_notes": _notes_url(f"{version}.0"),
                })
    out.sort(key=lambda r: r["date"])
    return out


def _build_schedule(versions: dict[str, str], future_ics: str | None) -> dict[str, Any]:
    upcoming = _parse_future_releases(future_ics) if future_ics else []

    # Headline: the imminent major release. Prefer product-details' precise date;
    # fall back to the first future-calendar entry.
    beta = versions.get("FIREFOX_DEVEDITION") or versions.get("LATEST_FIREFOX_DEVEL_VERSION") or ""
    next_version = beta.split("b", 1)[0] if beta else (upcoming[0]["version"] + ".0" if upcoming else "")
    next_date = versions.get("NEXT_RELEASE_DATE") or (upcoming[0]["date"] if upcoming else None)
    next_release = {
        "version": next_version,
        "date": next_date,
        "release_notes": _notes_url(next_version) if next_version else None,
    } if next_version else None

    # In-flight train prep dates leading up to the next release.
    milestones = [
        {"key": "stringfreeze", "label": "String freeze", "date": versions.get("NEXT_STRINGFREEZE_DATE")},
        {"key": "merge", "label": "Merge day", "date": versions.get("NEXT_MERGE_DATE")},
    ]
    milestones = [m for m in milestones if m["date"]]

    return {
        "next_release": next_release,
        "channels": _build_channels(versions),
        "milestones": milestones,
        "upcoming": upcoming,
        "sources": [_VERSIONS_URL, _FUTURE_ICS_URL],
    }


def _get(url: str) -> requests.Response:
    resp = requests.get(url, timeout=5, headers={"User-Agent": _USER_AGENT})
    resp.raise_for_status()
    return resp


def _fetch_schedule() -> dict[str, Any]:
    """Fetch + normalize both feeds, with a process-wide TTL cache.

    Channel versions are required (502 on failure); the future calendar is
    best-effort and degrades to an empty upcoming list. Serves stale cache on error.
    """
    global _cache, _cache_at
    now = time.monotonic()
    with _cache_lock:
        if _cache is not None and (now - _cache_at) < _CACHE_TTL_SECONDS:
            return _cache

    try:
        versions = _get(_VERSIONS_URL).json()
    except (requests.RequestException, ValueError) as exc:
        log.warning("Failed to fetch Firefox versions: %s", exc)
        with _cache_lock:
            if _cache is not None:
                return _cache  # serve stale rather than failing the Overview page
        raise HTTPException(status_code=502, detail="Unable to fetch Firefox release schedule") from exc

    future_ics: str | None = None
    try:
        future_ics = _get(_FUTURE_ICS_URL).text
    except requests.RequestException as exc:
        log.warning("Failed to fetch Firefox future-releases calendar: %s", exc)

    schedule = _build_schedule(versions, future_ics)
    with _cache_lock:
        _cache = schedule
        _cache_at = time.monotonic()
    return schedule


@router.get("")
def get_release_schedule() -> dict[str, Any]:
    """Current Firefox release schedule: channel versions, in-flight train
    milestones, and the upcoming major-release calendar — each linkable to its
    release notes."""
    return _fetch_schedule()
