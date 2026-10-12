"""
macOS fleet SBOM.

ronin_puppet's macos_sbom writes two files on every macOS host: a CycloneDX 1.6
document (`/var/sbom/sbom.cdx.json`) and a small `fingerprint.json` carrying a hash
over component identity only. Every host is built from a role, so the fleet holds a
handful of distinct software states rather than one per host, and storage is
deduped on that hash.

Cloud Run can't reach MDC1, so the on-network agent (relops-bootstrap
`orchestrator/sbom_agent.py`) does the collecting, same as tart-health and screen:

  1. GET  /sbom/agent/targets  -> which hosts to read, which hashes Hangar already has
  2. ssh each host, read fingerprint.json; fetch sbom.cdx.json only for unknown hashes
  3. POST /sbom/agent/push     -> fingerprints + any new documents

Drift falls out for free: a host whose hash differs from its role's most common hash
has software its siblings don't. Nothing else in the fleet surfaces that today.

Scope: the provisioned image only. Toolchains mozharness fetches per task are
ephemeral and are not in any of these documents.

Auth mirrors tart-health: mTLS client cert for the agent (`require_runner`), the
IAP allowlist for viewers (`require_access`). An SBOM is a map of what to attack, so
it stays behind the same allowlist rather than open to every IAP user.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..hosts import worker_fqdn
from ..models import SbomDocument, Worker, WorkerSbom
from .reprovision import require_access, require_runner

router = APIRouter(prefix="/sbom", tags=["sbom"])

# The generator regenerates at most once per macos_sbom::refresh_minutes (1440 by
# default) and puppet runs at boot, so a busy worker can legitimately go a day
# between runs. Two days without a fresh fingerprint means puppet isn't converging.
_FINGERPRINT_STALE = timedelta(hours=48)
# The agent sweeps hourly; three missed sweeps and its last read is not current.
_COLLECTION_STALE = timedelta(hours=3)
# Documents nobody points at any more are kept this long, so a host that flips back
# to an older state, or a diff against last month's image, still has something to read.
_ORPHAN_RETENTION = timedelta(days=90)

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def component_fingerprint(components: list[dict[str, Any]]) -> str:
    """The hash macos_sbom computes, recomputed here.

    Must stay byte-identical to `fingerprint()` in ronin_puppet
    modules/macos_sbom/files/generate_sbom.py. Hangar recomputes it rather than
    trusting the key the agent sends, because dedup is only sound if the key really
    is the content -- a mismatched document would silently stand in for every host
    that reports that hash.
    """
    identities = []
    for c in components:
        digest = ""
        for h in c.get("hashes", []) or []:
            if h.get("alg") == "SHA-256":
                digest = h.get("content", "")
                break
        identities.append("|".join([
            c.get("type", ""),
            c.get("name", ""),
            c.get("version", "") or "",
            c.get("purl", "") or "",
            digest,
        ]))
    identities.sort()
    return hashlib.sha256("\n".join(identities).encode("utf-8")).hexdigest()


def _parse_ts(v: Any) -> datetime | None:
    """`2026-08-13T15:20:36Z` -> naive UTC, matching every other Hangar timestamp."""
    if not isinstance(v, str):
        return None
    try:
        return datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def _is_mac_target(w: Worker) -> bool:
    """Puppet-managed macOS hosts. `platform` is only set once a host has been seen
    in Taskcluster, so fall back to the hostname and role for hosts that haven't."""
    if not w.puppet_role:
        return False
    if w.platform == "mac":
        return True
    if w.platform in ("linux", "windows"):
        return False
    short = w.hostname.split(".", 1)[0]
    return short.startswith("macmini") or "osx" in w.puppet_role or "mac" in w.puppet_role


# --- agent side ---------------------------------------------------------------


class HostPush(BaseModel):
    hostname: str
    fingerprint: dict[str, Any] | None = None
    agent_error: str | None = None


class SbomPush(BaseModel):
    hosts: list[HostPush] = Field(default_factory=list)
    documents: dict[str, dict[str, Any]] = Field(default_factory=dict)


@router.get("/agent/targets")
def agent_targets(runner: str = Depends(require_runner), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Which hosts the agent should read, and which documents it needn't fetch."""
    workers = db.scalars(select(Worker).where(Worker.puppet_role.is_not(None)))
    hosts = sorted({worker_fqdn(w.hostname) for w in workers if _is_mac_target(w)})
    known = sorted(db.scalars(select(SbomDocument.sha256)))
    return {"hosts": hosts, "known_sha256": known}


def _store_document(db: Session, sha: str, doc: dict[str, Any], source: str | None) -> tuple[bool, str | None]:
    """Store one document. Returns (stored, rejection reason); already held is (False, None)."""
    if not _SHA256.match(sha):
        return False, "key is not a sha256"
    if db.get(SbomDocument, sha) is not None:
        return False, None
    if doc.get("bomFormat") != "CycloneDX":
        return False, "not a CycloneDX document"
    components = doc.get("components")
    if not isinstance(components, list):
        return False, "no components array"
    actual = component_fingerprint(components)
    if actual != sha:
        return False, f"content hashes to {actual[:12]}, not {sha[:12]}"
    db.add(SbomDocument(
        sha256=sha,
        document=json.dumps(doc, separators=(",", ":")),
        component_count=len(components),
        source_hostname=source,
    ))
    return True, None


@router.post("/agent/push")
def agent_push(
    payload: SbomPush,
    runner: str = Depends(require_runner),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """On-network agent pushes fingerprints, plus documents for hashes Hangar lacked."""
    now = datetime.utcnow()

    # Which host each document came from, for provenance only.
    source_for: dict[str, str] = {}
    for h in payload.hosts:
        sha = (h.fingerprint or {}).get("sbom_sha256")
        if isinstance(sha, str):
            source_for.setdefault(sha, worker_fqdn(h.hostname))

    stored, rejected = 0, {}
    for sha, doc in payload.documents.items():
        ok, why = _store_document(db, sha, doc, source_for.get(sha))
        if why:
            rejected[sha] = why
        stored += ok
    db.flush()

    accepted = 0
    for h in payload.hosts:
        host = worker_fqdn(h.hostname)
        row = db.get(WorkerSbom, host)
        if row is None:
            row = WorkerSbom(hostname=host)
            db.add(row)
        row.attempted_at = now
        fp = h.fingerprint
        sha = (fp or {}).get("sbom_sha256")
        if not fp or not isinstance(sha, str) or not _SHA256.match(sha):
            # Keep the last good fingerprint; just record why this read failed.
            row.agent_error = (h.agent_error or "fingerprint missing sbom_sha256")[:500]
            continue
        row.agent_error = None
        row.sbom_sha256 = sha
        row.puppet_role = fp.get("puppet_role") or None
        row.macos_version = fp.get("macos_version") or None
        row.macos_build = fp.get("macos_build") or None
        row.arch = fp.get("arch") or None
        row.hw_model = fp.get("hw_model") or None
        row.is_vm = fp.get("is_vm") if isinstance(fp.get("is_vm"), bool) else None
        row.sip = fp.get("sip") or None
        row.component_count = fp.get("component_count") if isinstance(fp.get("component_count"), int) else None
        row.generator_version = fp.get("generator_version") or None
        row.generated_at = _parse_ts(fp.get("generated_at"))
        row.collected_at = now
        accepted += 1
    db.flush()

    # Hashes some host reports that Hangar still has no document for: the agent
    # fetches these next sweep (it caps documents per sweep to spare MDC1 bandwidth).
    referenced = set(db.scalars(select(WorkerSbom.sbom_sha256).where(WorkerSbom.sbom_sha256.is_not(None))))
    held = set(db.scalars(select(SbomDocument.sha256)))
    missing = sorted(referenced - held)

    orphans = db.query(SbomDocument).filter(SbomDocument.first_seen_at < now - _ORPHAN_RETENTION)
    if referenced:
        orphans = orphans.filter(SbomDocument.sha256.notin_(referenced))
    pruned = orphans.delete(synchronize_session=False)
    db.commit()
    return {
        "runner": runner,
        "accepted": accepted,
        "documents_stored": stored,
        "documents_rejected": rejected,
        "documents_pruned": pruned,
        "missing_sha256": missing,
    }


# --- viewer side --------------------------------------------------------------


def _host_view(r: WorkerSbom, modal: str | None, now: datetime) -> dict[str, Any]:
    fp_stale = r.generated_at is None or now - r.generated_at > _FINGERPRINT_STALE
    read_stale = r.collected_at is None or now - r.collected_at > _COLLECTION_STALE
    drifted = bool(modal and r.sbom_sha256 and r.sbom_sha256 != modal)
    if r.sbom_sha256 is None:
        state = "unknown"
    elif read_stale:
        state = "unreachable"
    elif drifted:
        state = "drifted"
    elif fp_stale:
        state = "stale"
    else:
        state = "ok"
    return {
        "hostname": r.hostname,
        "puppet_role": r.puppet_role,
        "sbom_sha256": r.sbom_sha256,
        "macos_version": r.macos_version,
        "macos_build": r.macos_build,
        "arch": r.arch,
        "hw_model": r.hw_model,
        "is_vm": r.is_vm,
        "sip": r.sip,
        "component_count": r.component_count,
        "generated_at": r.generated_at.isoformat() if r.generated_at else None,
        "collected_at": r.collected_at.isoformat() if r.collected_at else None,
        "agent_error": r.agent_error,
        "state": state,
    }


def _uncovered_reason(pool: str) -> str:
    if "signing" in pool:
        return "signers are excluded from macos_sbom"
    if pool.endswith("-vms"):
        return "VM guests aren't reachable by the agent"
    return "not in puppet inventory"


def _uncovered(db: Session, covered: set[str]) -> list[dict[str, Any]]:
    """Macs Hangar knows about that can't have an SBOM here, grouped by pool, so the
    page states its own blind spots instead of letting a short list read as complete."""
    counts: Counter[str] = Counter()
    for w in db.scalars(select(Worker).where(Worker.platform == "mac")):
        if worker_fqdn(w.hostname) in covered or _is_mac_target(w):
            continue
        pool = w.worker_pool or "(no pool)"
        # One synced label is a script's stderr ("grep: ... No such file ...unknown");
        # don't print that as if it were a pool.
        if not re.fullmatch(r"[\w.()-]+", pool):
            pool = "(unrecognised pool label)"
        counts[pool] += 1
    return [
        {"pool": pool, "hosts": n, "reason": _uncovered_reason(pool)}
        for pool, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


@router.get("")
def sbom_rollup(user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Fleet SBOM by role: distinct states, the modal one, and who has drifted off it."""
    rows = list(db.scalars(select(WorkerSbom)))
    held = {
        sha: (count, first_seen)
        for sha, count, first_seen in db.execute(
            select(SbomDocument.sha256, SbomDocument.component_count, SbomDocument.first_seen_at)
        )
    }
    now = datetime.utcnow()

    # A host that has never produced a fingerprint has no role of its own yet; group
    # it under the role puppet's inventory assigns, so it shows up where it's missing.
    inventory_role = dict(db.execute(select(Worker.hostname, Worker.puppet_role)).all())
    by_role: dict[str, list[WorkerSbom]] = {}
    for r in rows:
        role = r.puppet_role or inventory_role.get(r.hostname) or "(unknown role)"
        by_role.setdefault(role, []).append(r)

    roles: list[dict[str, Any]] = []
    hosts: list[dict[str, Any]] = []
    for role, members in by_role.items():
        counts = Counter(r.sbom_sha256 for r in members if r.sbom_sha256)
        ranked = counts.most_common()
        # A tie for most common is a role mid-rollout, not one host drifting: call it
        # split and flag nobody, rather than pick a "correct" state at random.
        split = len(ranked) > 1 and ranked[0][1] == ranked[1][1]
        modal = None if split or not ranked else ranked[0][0]
        views = [{**_host_view(r, modal, now), "puppet_role": role} for r in members]
        for v in views:
            v["drift"] = drift_summary(db, modal, v["sbom_sha256"]) if v["state"] == "drifted" else None
        hosts.extend(views)
        roles.append({
            "puppet_role": role,
            "hosts": len(members),
            "states": [
                {
                    "sbom_sha256": sha,
                    "hosts": n,
                    "component_count": held.get(sha, (None, None))[0],
                    "document": sha in held,
                    "first_seen_at": held[sha][1].isoformat() if sha in held else None,
                }
                for sha, n in ranked
            ],
            "modal_sha256": modal,
            "split": split,
            "drifted": sum(1 for v in views if v["state"] == "drifted"),
            "unhealthy": sum(1 for v in views if v["state"] in ("unreachable", "stale", "unknown")),
        })

    roles.sort(key=lambda r: (-r["drifted"], -r["unhealthy"], r["puppet_role"]))
    order = {"drifted": 0, "unreachable": 1, "stale": 2, "unknown": 3, "ok": 4}
    hosts.sort(key=lambda h: (order[h["state"]], h["puppet_role"] or "", h["hostname"]))
    last = max((r.attempted_at for r in rows if r.attempted_at), default=None)
    return {
        "roles": roles,
        "hosts": hosts,
        "totals": {
            "hosts": len(rows),
            "reporting": sum(1 for h in hosts if h["state"] != "unknown"),
            "distinct_states": len({r.sbom_sha256 for r in rows if r.sbom_sha256}),
            "documents": len(held),
            "drifted": sum(1 for h in hosts if h["state"] == "drifted"),
            "roles": len(roles),
            "roles_drifted": sum(1 for r in roles if r["drifted"]),
        },
        "uncovered": _uncovered(db, {r.hostname for r in rows}),
        "last_collected_at": last.isoformat() if last else None,
        "agent_stale": last is None or now - last > _COLLECTION_STALE,
    }


def _get_doc(db: Session, sha: str) -> dict[str, Any]:
    row = db.get(SbomDocument, sha) if _SHA256.match(sha) else None
    if row is None:
        raise HTTPException(status_code=404, detail="no SBOM document for that hash")
    return json.loads(row.document)


@router.get("/documents/{sha}")
def sbom_document(sha: str, user: str = Depends(require_access), db: Session = Depends(get_db)) -> Response:
    """The CycloneDX document for one software state, as a download."""
    doc = _get_doc(db, sha)
    return Response(
        content=json.dumps(doc, indent=2),
        media_type="application/vnd.cyclonedx+json",
        headers={"Content-Disposition": f'attachment; filename="sbom-{sha[:12]}.cdx.json"'},
    )


def _identity(c: dict[str, Any]) -> tuple[str, str]:
    return (c.get("type", ""), c.get("name", ""))


def _version(c: dict[str, Any]) -> str:
    """Version, or the binary's sha256 for unversioned files (worker binaries)."""
    if c.get("version"):
        return str(c["version"])
    for h in c.get("hashes", []) or []:
        if h.get("alg") == "SHA-256":
            return "sha256:" + h.get("content", "")[:12]
    return ""


def _diff(a_doc: dict[str, Any], b_doc: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    a = {_identity(c): c for c in a_doc.get("components", [])}
    b = {_identity(c): c for c in b_doc.get("components", [])}

    def row(k: tuple[str, str], **v: Any) -> dict[str, Any]:
        return {"type": k[0], "name": k[1], **v}

    return {
        "added": [row(k, version=_version(b[k])) for k in sorted(b.keys() - a.keys())],
        "removed": [row(k, version=_version(a[k])) for k in sorted(a.keys() - b.keys())],
        "changed": [
            row(k, base=_version(a[k]), head=_version(b[k]))
            for k in sorted(a.keys() & b.keys())
            if _version(a[k]) != _version(b[k])
        ],
    }


# A document's content is fixed by its hash, so a diff between two hashes never
# changes and can be kept for the life of the process. Bounded anyway.
_SUMMARY_CACHE: dict[tuple[str, str], dict[str, Any]] = {}
_SUMMARY_CACHE_MAX = 512


def _short_name(name: str) -> str:
    """`/usr/local/bin/generic-worker` -> `generic-worker`, `com.apple.pkg.X` stays."""
    return name.rsplit("/", 1)[-1]


def drift_summary(db: Session, base: str, head: str) -> dict[str, Any] | None:
    """Counts plus the first few changes, phrased for a table row. None if either
    document hasn't been collected yet -- say nothing rather than guess."""
    key = (base, head)
    if key in _SUMMARY_CACHE:
        return _SUMMARY_CACHE[key]
    a, b = db.get(SbomDocument, base), db.get(SbomDocument, head)
    if a is None or b is None:
        return None
    d = _diff(json.loads(a.document), json.loads(b.document))
    lines = (
        [f"~ {_short_name(c['name'])} {c['base']} → {c['head']}" for c in d["changed"]]
        + [f"+ {_short_name(c['name'])} {c['version']}".rstrip() for c in d["added"]]
        + [f"− {_short_name(c['name'])} {c['version']}".rstrip() for c in d["removed"]]
    )
    out = {
        "added": len(d["added"]),
        "removed": len(d["removed"]),
        "changed": len(d["changed"]),
        "highlights": lines[:3],
    }
    if len(_SUMMARY_CACHE) >= _SUMMARY_CACHE_MAX:
        _SUMMARY_CACHE.clear()
    _SUMMARY_CACHE[key] = out
    return out


@router.get("/diff")
def sbom_diff(
    base: str = Query(..., description="sha256 of the reference state, usually the role's modal one"),
    head: str = Query(..., description="sha256 of the state to compare"),
    user: str = Depends(require_access),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """What a drifted host has that its role's usual state doesn't, and vice versa."""
    return {"base": base, "head": head, **_diff(_get_doc(db, base), _get_doc(db, head))}
