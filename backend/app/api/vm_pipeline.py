"""macOS VM image pipeline — build → promote → rollout visibility.

The macos-vms tester image (`sequoia-tester`) is built by a self-hosted GitHub
Actions runner, pushed to an on-network OCI registry as `prod-<sha>` +
`prod-latest`, and pulled onto Tart worker hosts. This endpoint stitches those
stages into one view:

* **Registry** — the live `prod-latest` digest and the recent `prod-<sha>` builds
  (anonymous pull; the registry is anon-pull / auth-push).
* **Pipeline** — the latest GitHub Actions build run (including in-progress or
  failed runs that have not produced a tag), and provenance for each shipped
  image (which commit / run built it).
* **Rollout** — best-effort count of VM workers currently in the fleet inventory.

All external calls are wrapped in a short-TTL stale-while-revalidate cache so a
slow or unreachable registry/API never blocks (or breaks) the request — the card
degrades gracefully to whatever is reachable.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import requests
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import cache
from ..config import settings
from ..database import get_db
from ..models import Worker

router = APIRouter(prefix="/vm-pipeline", tags=["vm-pipeline"])

log = logging.getLogger(__name__)

_CACHE_KEY = "vm_pipeline"
_TTL = 60.0  # seconds
_GH_API = "https://api.github.com"
_WORKFLOW_FILE = "build-mac.yaml"
_MANIFEST_ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
])
_HISTORY_LIMIT = 8  # how many recent prod-<sha> builds to resolve digests for


def _gh_headers() -> dict[str, str]:
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if settings.github_token:
        h["Authorization"] = f"Bearer {settings.github_token}"
    return h


def _short(s: str | None, n: int = 12) -> str | None:
    if not s:
        return None
    return s[7:7 + n] if s.startswith("sha256:") else s[:n]


# ── Registry ────────────────────────────────────────────────────────────────

def _registry_tags(sess: requests.Session, base: str, repo: str) -> list[str]:
    r = sess.get(f"{base}/v2/{repo}/tags/list", timeout=6)
    r.raise_for_status()
    return r.json().get("tags") or []


def _manifest_digest(sess: requests.Session, base: str, repo: str, tag: str) -> str | None:
    """Content digest for a tag (anon HEAD). None if the tag/registry is unreachable."""
    try:
        r = sess.head(
            f"{base}/v2/{repo}/manifests/{tag}",
            headers={"Accept": _MANIFEST_ACCEPT},
            timeout=6,
        )
        if r.status_code >= 400:
            return None
        return r.headers.get("Docker-Content-Digest")
    except requests.RequestException:
        return None


# ── GitHub Actions ──────────────────────────────────────────────────────────

def _run_dict(run: dict[str, Any]) -> dict[str, Any]:
    sha = run.get("head_sha")
    return {
        "run_number": run.get("run_number"),
        "status": run.get("status"),          # queued | in_progress | completed
        "conclusion": run.get("conclusion"),  # success | failure | cancelled | None
        "title": run.get("display_title"),
        "actor": (run.get("actor") or {}).get("login"),
        "url": run.get("html_url"),
        "created_at": run.get("created_at"),
        "updated_at": run.get("updated_at"),
        "event": run.get("event"),
        "sha": sha,
        "short_sha": _short(sha, 7),
    }


def _fetch_runs() -> list[dict[str, Any]]:
    try:
        r = requests.get(
            f"{_GH_API}/repos/{settings.macos_vms_repo}/actions/workflows/{_WORKFLOW_FILE}/runs",
            headers=_gh_headers(),
            params={"per_page": 20},
            timeout=10,
        )
        r.raise_for_status()
        return [_run_dict(x) for x in r.json().get("workflow_runs", [])]
    except (requests.RequestException, ValueError) as exc:
        log.warning("vm-pipeline: GitHub Actions fetch failed: %s", exc)
        return []


# ── Assembly ──────────────────────────────────────────────────────────────

def _build_payload() -> dict[str, Any]:
    base = settings.oci_registry_url.rstrip("/")
    repo = settings.oci_image_repo

    runs = _fetch_runs()
    latest_run = runs[0] if runs else None
    # Successful runs, newest first, keyed by full sha for provenance joins.
    runs_by_sha = {r["sha"]: r for r in runs if r.get("sha")}

    registry: dict[str, Any] = {
        "url": base,
        "repo": repo,
        "reachable": False,
        "prod_latest_digest": None,
        "prod_latest_digest_short": None,
        "tag_count": None,
        "error": None,
    }
    current: dict[str, Any] = {"digest": None, "digest_short": None, "sha": None, "short_sha": None, "run": None}
    history: list[dict[str, Any]] = []

    sess = requests.Session()
    try:
        tags = _registry_tags(sess, base, repo)
        registry["reachable"] = True
        registry["tag_count"] = len(tags)

        prod_latest = _manifest_digest(sess, base, repo, "prod-latest") if "prod-latest" in tags else None
        registry["prod_latest_digest"] = prod_latest
        registry["prod_latest_digest_short"] = _short(prod_latest)

        # Recent prod-<sha> builds, newest first (GH run order is the best proxy
        # for recency; fall back to tag order for any not seen in runs).
        prod_tags = [t for t in tags if t.startswith("prod-") and t != "prod-latest"]

        def _recency(tag: str) -> str:
            sha = tag[len("prod-"):]
            run = runs_by_sha.get(sha)
            return run["created_at"] if run and run.get("created_at") else ""

        prod_tags.sort(key=_recency, reverse=True)

        for tag in prod_tags[:_HISTORY_LIMIT]:
            sha = tag[len("prod-"):]
            digest = _manifest_digest(sess, base, repo, tag)
            is_current = bool(prod_latest and digest and digest == prod_latest)
            run = runs_by_sha.get(sha)
            entry = {
                "tag": tag,
                "sha": sha,
                "short_sha": _short(sha, 7),
                "digest": digest,
                "digest_short": _short(digest),
                "is_current": is_current,
                "run": run,
                "built_at": run["created_at"] if run else None,
            }
            history.append(entry)
            if is_current:
                current.update({
                    "digest": digest,
                    "digest_short": _short(digest),
                    "sha": sha,
                    "short_sha": _short(sha, 7),
                    "run": run,
                    "built_at": run["created_at"] if run else None,
                })
    except requests.RequestException as exc:
        registry["error"] = str(exc)
        log.warning("vm-pipeline: registry unreachable (%s): %s", base, exc)
    finally:
        sess.close()

    return {
        "registry": registry,
        "current": current,
        "latest_run": latest_run,
        "history": history,
        "repo_url": f"https://github.com/{settings.macos_vms_repo}",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def _rollout(db: Session) -> dict[str, Any]:
    """Best-effort VM-worker rollout snapshot from the fleet inventory.

    Per-host *running image digest* isn't instrumented yet (it needs a `tart list`
    on each host, which Hangar can't reach in MDC1), so drift is reported as
    unknown; this just shows how many VM workers exist and how many are active.
    """
    try:
        rows = (
            db.query(Worker)
            .filter(
                (Worker.worker_pool.ilike("%vms%"))
                | (Worker.puppet_role.ilike("%_m_vms"))
            )
            .all()
        )
    except Exception:  # DB not ready / empty local dev
        log.debug("vm-pipeline: rollout query failed", exc_info=True)
        rows = []

    pools: dict[str, int] = {}
    active = 0
    now = datetime.now(timezone.utc)
    for w in rows:
        if w.worker_pool:
            pools[w.worker_pool] = pools.get(w.worker_pool, 0) + 1
        la = w.tc_last_active
        if la:
            dt = la.replace(tzinfo=timezone.utc) if la.tzinfo is None else la
            if (now - dt).total_seconds() < 24 * 3600:
                active += 1

    return {
        "vm_worker_count": len(rows),
        "active_24h": active,
        "pools": pools,
        "digest_drift_instrumented": False,
        "note": "Per-host running-image digest is not yet instrumented; "
                "counts come from the fleet inventory.",
    }


@router.get("")
def get_vm_pipeline(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Build → promote → rollout state for the macos-vms tester image."""
    payload = cache.swr(_CACHE_KEY, _TTL, _build_payload)
    # Rollout is a cheap local DB read; compute per-request (not cached).
    return {**payload, "rollout": _rollout(db)}
