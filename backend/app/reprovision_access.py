"""Reprovision authorization allowlist — SECURITY-SENSITIVE.

This module is the committed source of truth for which IAP-authenticated users
may trigger a worker **reprovision** — a *destructive* EACS wipe + rebuild of
production CI hardware. It is deliberately isolated in its own file so that any
change to the allowlist is:

  * obvious in a diff (it is the only thing this file contains), and
  * gated by CODEOWNERS review (see ``.github/CODEOWNERS``).

DO NOT widen ``REPROVISION_AUTHORIZED_USERS_DEFAULT`` without review by the code
owners. Adding an entry grants the ability to wipe and rebuild production
workers.

The value is consumed as the default of ``Settings.reprovision_authorized_users``
(``config.py``). It can be overridden at deploy time via the
``REPROVISION_AUTHORIZED_USERS`` environment variable — if you rely on that
override in production, protect that surface too (this file only safeguards the
committed baseline). Format: comma-separated, case-insensitive emails.
"""
from __future__ import annotations

REPROVISION_AUTHORIZED_USERS_DEFAULT = (
    "rcurran@mozilla.com,"
    "aerickson@mozilla.com,"
    "jmoss@mozilla.com,"
    "jgibbs@mozilla.com,"
    "mcornmesser@mozilla.com"
)
