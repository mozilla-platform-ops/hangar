"""Hostname → FQDN resolution for worker records."""
from __future__ import annotations

_DEFAULT_SUFFIX = "test.releng.mdc1.mozilla.com"
# Windows NUC test pools live behind a separate domain; see
# worker-images/provisioners/windows/MDC1Windows/pools.yml
_WINTEST2_SUFFIX = "wintest2.releng.mdc1.mozilla.com"


def worker_fqdn(host_or_id: str) -> str:
    """Return the fully-qualified hostname for a worker short ID."""
    if "." in host_or_id:
        return host_or_id
    if host_or_id.startswith("nuc13-") or host_or_id.startswith("t-nuc12-"):
        return f"{host_or_id}.{_WINTEST2_SUFFIX}"
    return f"{host_or_id}.{_DEFAULT_SUFFIX}"
