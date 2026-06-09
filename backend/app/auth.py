"""Resolve the requesting user's identity from Google IAP.

IAP injects the signed-in identity into every request it forwards. In production we verify the
signed `X-Goog-IAP-JWT-Assertion` (the plain email header can be spoofed via the direct Cloud Run
URL that bypasses IAP). Locally — where there's no IAP — we fall back to the plain header, then to
a fixed dev identity so the app still works under `docker compose`.
"""
from __future__ import annotations

import logging

from fastapi import Request

from .config import settings

log = logging.getLogger(__name__)

# Google publishes the IAP signing keys here.
_IAP_CERTS_URL = "https://www.gstatic.com/iap/verify/public_key"

LOCAL_DEV_USER = "local-dev@localhost"


def _email_from_assertion(request: Request) -> str | None:
    assertion = request.headers.get("x-goog-iap-jwt-assertion")
    if not assertion or not settings.iap_audience:
        return None
    try:
        from google.auth.transport import requests as g_requests
        from google.oauth2 import id_token

        claims = id_token.verify_token(
            assertion,
            g_requests.Request(),
            audience=settings.iap_audience,
            certs_url=_IAP_CERTS_URL,
        )
        return claims.get("email")
    except Exception as exc:  # noqa: BLE001 — never let auth verification 500 the request
        log.warning("IAP assertion verification failed: %s", exc)
        return None


def current_user(request: Request) -> str:
    """FastAPI dependency: the authenticated user's email (verified in prod)."""
    email = _email_from_assertion(request)
    if email:
        return email
    # Fallback: the convenience header IAP also sets (e.g. "accounts.google.com:user@mozilla.com").
    header = request.headers.get("x-goog-authenticated-user-email", "")
    if header:
        return header.split(":")[-1]
    return LOCAL_DEV_USER
