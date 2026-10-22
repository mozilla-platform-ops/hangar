"""current_user must not trust the spoofable plain IAP header once an audience is configured.

The runner hostname serves the non-IAP backend to the MDC1 NAT, so a caller there can set
X-Goog-Authenticated-User-Email to an allowlisted address on any route it can reach.
"""
from __future__ import annotations

import pytest
from app import auth
from app.config import settings
from fastapi import HTTPException
from starlette.requests import Request

SPOOF = {"x-goog-authenticated-user-email": "accounts.google.com:rcurran@mozilla.com"}


def req(headers: dict[str, str]) -> Request:
    return Request({"type": "http", "headers": [(k.encode(), v.encode()) for k, v in headers.items()]})


def test_prod_rejects_plain_header(monkeypatch):
    monkeypatch.setattr(settings, "iap_audience", "/projects/1/global/backendServices/2")
    with pytest.raises(HTTPException) as e:
        auth.current_user(req(SPOOF))
    assert e.value.status_code == 401


def test_prod_rejects_bad_assertion(monkeypatch):
    monkeypatch.setattr(settings, "iap_audience", "/projects/1/global/backendServices/2")
    with pytest.raises(HTTPException):
        auth.current_user(req(SPOOF | {"x-goog-iap-jwt-assertion": "not-a-jwt"}))


def test_prod_accepts_verified_assertion(monkeypatch):
    monkeypatch.setattr(settings, "iap_audience", "/projects/1/global/backendServices/2")
    monkeypatch.setattr(auth, "_email_from_assertion", lambda r: "jmoss@mozilla.com")
    assert auth.current_user(req(SPOOF)) == "jmoss@mozilla.com"


def test_local_dev_falls_back(monkeypatch):
    monkeypatch.setattr(settings, "iap_audience", "")
    assert auth.current_user(req(SPOOF)) == "rcurran@mozilla.com"
    assert auth.current_user(req({})) == auth.LOCAL_DEV_USER
