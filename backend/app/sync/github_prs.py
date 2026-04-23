"""Sync ronin_puppet PRs labelled 'Mac Improvement' or 'Mac Feature' from GitHub."""
from __future__ import annotations

import json
import logging
from datetime import datetime

import requests
from sqlalchemy.orm import Session

from ..config import settings
from ..models import RoninPR, SyncLog

log = logging.getLogger(__name__)

_REPO = "mozilla-platform-ops/ronin_puppet"
_LABELS = ["Mac Improvement", "Mac Feature"]
_API_BASE = "https://api.github.com"


def _headers() -> dict[str, str]:
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if settings.github_token:
        h["Authorization"] = f"Bearer {settings.github_token}"
    return h


def _fetch_prs_for_label(label: str) -> list[dict]:
    prs: list[dict] = []
    page = 1
    while True:
        resp = requests.get(
            f"{_API_BASE}/repos/{_REPO}/issues",
            headers=_headers(),
            params={"state": "open", "labels": label, "per_page": 100, "page": page},
            timeout=30,
        )
        resp.raise_for_status()
        items = resp.json()
        if not items:
            break
        prs.extend(i for i in items if "pull_request" in i)
        if len(items) < 100:
            break
        page += 1
    return prs


def run_sync(db: Session) -> int:
    log_entry = SyncLog(source="github_prs", started_at=datetime.utcnow())
    db.add(log_entry)
    db.flush()

    try:
        seen: dict[int, dict] = {}
        for label in _LABELS:
            for pr in _fetch_prs_for_label(label):
                pr_num = pr["number"]
                if pr_num not in seen:
                    seen[pr_num] = pr
                else:
                    existing_labels = {l["name"] for l in seen[pr_num].get("labels", [])}
                    for lbl in pr.get("labels", []):
                        existing_labels.add(lbl["name"])

        count = 0
        for pr_num, pr in seen.items():
            row = db.get(RoninPR, pr_num)
            if row is None:
                row = RoninPR(id=pr_num, upvotes=0, downvotes=0)
                db.add(row)

            row.title = pr["title"]
            row.url = pr["html_url"]
            row.state = pr.get("state", "open")
            row.author = pr.get("user", {}).get("login")
            row.labels = json.dumps([l["name"] for l in pr.get("labels", [])])
            row.pr_created_at = datetime.fromisoformat(pr["created_at"].replace("Z", "+00:00")) if pr.get("created_at") else None
            row.pr_updated_at = datetime.fromisoformat(pr["updated_at"].replace("Z", "+00:00")) if pr.get("updated_at") else None
            row.last_synced = datetime.utcnow()
            count += 1

        # Remove PRs that are no longer open / no longer carry the tracked labels
        db.query(RoninPR).filter(RoninPR.id.not_in(list(seen.keys()))).delete(synchronize_session=False)

        db.commit()
        log_entry.finished_at = datetime.utcnow()
        log_entry.records_updated = count
        log_entry.success = True
        db.commit()
        log.info("github_prs sync: %d PRs", count)
        return count

    except Exception as exc:
        db.rollback()
        log_entry.finished_at = datetime.utcnow()
        log_entry.error = str(exc)
        log_entry.success = False
        db.commit()
        log.error("github_prs sync failed: %s", exc)
        raise
