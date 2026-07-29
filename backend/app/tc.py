"""Taskcluster write client for privileged worker actions (quarantine).

Read paths (the sync, pool health) use the public GraphQL/Queue APIs and need no
auth. Mutations do: quarantining a worker requires a TC client whose scopes
include ``queue:quarantine-worker:<provisionerId>/<workerType>``. Those creds are
supplied via ``TC_CLIENT_ID`` / ``TC_ACCESS_TOKEN`` (Secret Manager in prod). When
they're absent we raise :class:`TCCredentialsError` so the API can return a clear
"not configured" message instead of a 500.
"""
from __future__ import annotations

from datetime import datetime, timezone

import taskcluster

from .config import settings


class TCCredentialsError(RuntimeError):
    """Raised when a TC write is attempted without configured credentials."""


def credentials_configured() -> bool:
    return bool(settings.tc_client_id and settings.tc_access_token)


def _queue() -> "taskcluster.Queue":
    if not credentials_configured():
        raise TCCredentialsError(
            "Taskcluster credentials are not configured — set TC_CLIENT_ID / TC_ACCESS_TOKEN "
            "(a client with queue:quarantine-worker scope) to enable worker quarantine."
        )
    return taskcluster.Queue({
        "rootUrl": settings.tc_root_url,
        "credentials": {"clientId": settings.tc_client_id, "accessToken": settings.tc_access_token},
    })


def _stamp(dt: datetime) -> str:
    """Format a datetime as the ISO-8601/Z string TC expects."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def quarantine_worker(
    provisioner_id: str,
    worker_type: str,
    worker_group: str,
    worker_id: str,
    quarantine_until: datetime,
    info: str,
) -> None:
    """Set (or clear) a worker's quarantine. A ``quarantine_until`` in the past
    lifts an existing quarantine; a future date sets one. ``info`` is stored by TC
    (quarantineInfo) as the audit reason and shown in the TC worker view."""
    payload = {"quarantineUntil": _stamp(quarantine_until), "quarantineInfo": info}
    _queue().quarantineWorker(provisioner_id, worker_type, worker_group, worker_id, payload)
