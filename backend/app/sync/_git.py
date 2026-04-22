"""Shared git clone/pull helper for sync jobs backed by GitHub repos."""
from __future__ import annotations

import logging
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)


def ensure_repo(repo_url: str, local_path: str, branch: str) -> None:
    """Initialise or update a shallow clone of ``repo_url`` at ``local_path``.

    Uses git-init-in-place so the directory itself is never removed — important
    because Docker volume mount points cannot be rmdir'd (EBUSY).
    """
    path = Path(local_path)
    git_dir = path / ".git"

    if git_dir.exists():
        log.info("Pulling %s at %s", repo_url, local_path)
        subprocess.run(
            ["git", "-C", local_path, "fetch", "--depth=1", "--quiet", "origin", branch],
            check=True, timeout=120,
        )
        subprocess.run(
            ["git", "-C", local_path, "checkout", "--quiet", "FETCH_HEAD"],
            check=True, timeout=60,
        )
        return

    log.info("Initialising %s in %s from %s", branch, local_path, repo_url)
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "-C", local_path, "init", "--quiet"], check=True, timeout=30)
    subprocess.run(
        ["git", "-C", local_path, "remote", "add", "origin", repo_url],
        check=True, timeout=10,
    )
    subprocess.run(
        ["git", "-C", local_path, "fetch", "--depth=1", "--quiet", "origin", branch],
        check=True, timeout=300,
    )
    subprocess.run(
        ["git", "-C", local_path, "checkout", "--quiet", "FETCH_HEAD"],
        check=True, timeout=60,
    )
