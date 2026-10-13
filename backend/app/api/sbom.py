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
_FINGERPRINT_PROPERTY = "relops:fingerprint"


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
        # macos_sbom >= 2.2.0 tags components that record how a host was built rather
        # than what it runs (old munki receipts, bundled Apple apps, the generator
        # itself). They stay in the document but not in the identity.
        if any(p.get("name") == _FINGERPRINT_PROPERTY for p in c.get("properties", []) or []):
            continue
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


def _clip(v: Any, n: int) -> str | None:
    """A fingerprint string, trimmed to its column.

    Postgres rejects an over-long VARCHAR, and the whole push shares one transaction,
    so one host's odd value used to fail every host's update. Seen 2026-10-13: r8s in
    SIP "Custom Configuration" report a 371-character multi-line csrutil status.
    """
    if not isinstance(v, str) or not v.strip():
        return None
    return v.strip()[:n]


def _sip(v: Any) -> str | None:
    """First line of the csrutil status: `unknown (Custom Configuration)` rather than
    the per-protection breakdown that follows it on hosts in a custom configuration."""
    if not isinstance(v, str):
        return None
    return _clip(v.strip().splitlines()[0].rstrip(".") if v.strip() else "", 64)


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
        row.puppet_role = _clip(fp.get("puppet_role"), 255)
        row.macos_version = _clip(fp.get("macos_version"), 32)
        row.macos_build = _clip(fp.get("macos_build"), 32)
        row.arch = _clip(fp.get("arch"), 16)
        row.hw_model = _clip(fp.get("hw_model"), 64)
        row.is_vm = fp.get("is_vm") if isinstance(fp.get("is_vm"), bool) else None
        row.sip = _sip(fp.get("sip"))
        row.component_count = fp.get("component_count") if isinstance(fp.get("component_count"), int) else None
        row.generator_version = _clip(fp.get("generator_version"), 32)
        row.puppet_branch = _clip(fp.get("puppet_branch"), 255)
        row.puppet_sha = _clip(fp.get("puppet_sha"), 64)
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


def _gen_key(version: str | None) -> tuple[int, ...]:
    """`2.2.0` -> (2, 2, 0). Unknown sorts oldest."""
    try:
        return tuple(int(x) for x in (version or "").split("."))
    except ValueError:
        return (0,)


def _host_view(r: WorkerSbom, modal: str | None, now: datetime, outdated: bool = False) -> dict[str, Any]:
    fp_stale = r.generated_at is None or now - r.generated_at > _FINGERPRINT_STALE
    read_stale = r.collected_at is None or now - r.collected_at > _COLLECTION_STALE
    drifted = bool(modal and r.sbom_sha256 and r.sbom_sha256 != modal)
    if r.sbom_sha256 is None:
        state = "unknown"
    elif read_stale:
        state = "unreachable"
    elif outdated:
        # Hashed by an older macos_sbom than the rest of its role. A generator change
        # can change what counts toward the hash, so comparing across versions would
        # report every host mid-rollout as drifted. It isn't; it's updating.
        state = "updating"
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


# --- findings ---------------------------------------------------------------
#
# Comparing whole hashes marks most of a role as drifted on this fleet: hosts carry
# small independent leftovers (an old script here, an older pip package there), and
# every combination is its own hash. So drift is reported per component instead.
# Within a cohort (same role, same puppet branch, same generator), take what most
# hosts have for each component; each exception is a finding with its hosts. A host
# with two leftovers shows under two findings rather than becoming a state of its own,
# and findings that hit exactly the same hosts merge, so a leftover Python 2.7 install
# reads as one thing, not twelve.

_IDMAP_CACHE: dict[str, dict[tuple[str, str], str]] = {}


def _idmap(db: Session, sha: str) -> dict[tuple[str, str], str] | None:
    """(type, name) -> version identity for one state; None if the document isn't held.
    Components tagged out of the fingerprint are left out here too."""
    if sha in _IDMAP_CACHE:
        return _IDMAP_CACHE[sha]
    row = db.get(SbomDocument, sha)
    if row is None:
        return None
    out = {}
    for c in json.loads(row.document).get("components", []):
        if any(p.get("name") == _FINGERPRINT_PROPERTY for p in c.get("properties", []) or []):
            continue
        out[_identity(c)] = _version(c)
    if len(_IDMAP_CACHE) >= 256:
        _IDMAP_CACHE.clear()
    _IDMAP_CACHE[sha] = out
    return out


def _item_label(kind: str, name: str, value: str | None, baseline: str | None) -> str:
    short = _short_name(name)
    if kind == "added":
        return f"+ {short} {value or ''}".rstrip() if not (value or "").startswith("sha256:") else f"+ {short}"
    if kind == "removed":
        return f"− {short}"
    if (value or "").startswith("sha256:") and (baseline or "").startswith("sha256:"):
        return f"~ {short} (different build)"
    return f"~ {short} {baseline} → {value}"


def _findings(db: Session, hosts_by_sha: dict[str, list[str]]) -> tuple[list[dict[str, Any]], set[str]]:
    """Finding groups for one cohort, plus the shas whose documents aren't held yet."""
    maps = {sha: _idmap(db, sha) for sha in hosts_by_sha}
    known = {sha: m for sha, m in maps.items() if m is not None}
    pending = set(maps) - set(known)
    if not known:
        return [], pending

    keys = set().union(*known.values())
    groups: dict[frozenset[str], list[dict[str, Any]]] = {}
    for key in keys:
        weight: Counter[str | None] = Counter()
        for sha, m in known.items():
            weight[m.get(key)] += len(hosts_by_sha[sha])
        ranked_values = weight.most_common()
        if len(ranked_values) > 1 and ranked_values[0][1] == ranked_values[1][1]:
            # No majority (typically a two-host role that disagrees). Don't pick a
            # "correct" host at random: report the disagreement against everyone in it.
            tied = [v for v, n in ranked_values if n == ranked_values[0][1]]
            hosts = frozenset(h for sha, m in known.items() for h in hosts_by_sha[sha])
            if any((v or "").startswith("sha256:") for v in tied):
                shown = f"{len(weight)} variants"  # hashes say nothing to a reader
            else:
                shown = " vs ".join(v or "absent" for v in tied)
            groups.setdefault(hosts, []).append({
                "kind": "split", "type": key[0], "name": key[1], "value": None, "baseline": None,
                "label": f"≠ {_short_name(key[1])}: {shown}" if ":" not in shown and "variants" not in shown
                         else f"≠ {_short_name(key[1])} ({shown})",
            })
            continue
        baseline = ranked_values[0][0]
        # Values that read the same merge into one item: a stray file that is a
        # different build on different hosts is still one "+ virtualenv".
        by_label: dict[str, tuple[dict[str, Any], set[str]]] = {}
        for value, _n in weight.items():
            if value == baseline:
                continue
            kind = "added" if baseline is None else "removed" if value is None else "changed"
            label = _item_label(kind, key[1], value, baseline)
            item, hosts_set = by_label.setdefault(label, ({
                "kind": kind, "type": key[0], "name": key[1], "value": value, "baseline": baseline, "label": label,
            }, set()))
            hosts_set.update(h for sha, m in known.items() if m.get(key) == value for h in hosts_by_sha[sha])
        for item, hosts_set in by_label.values():
            groups.setdefault(frozenset(hosts_set), []).append(item)

    order = {"split": 0, "changed": 1, "added": 2, "removed": 3}
    out = []
    for hosts, items in groups.items():
        items.sort(key=lambda i: (order[i["kind"]], i["name"].lower()))
        out.append({"hosts": sorted(hosts), "items": items})
    out.sort(key=lambda g: (-len(g["hosts"]), g["items"][0]["name"].lower()))
    for i, g in enumerate(out):
        g["id"] = i
    return out, pending


@router.get("")
def sbom_rollup(user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Fleet SBOM by role and puppet branch: what most hosts run, and what differs."""
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
    cohorts: dict[tuple[str, str], list[WorkerSbom]] = {}
    for r in rows:
        role = r.puppet_role or inventory_role.get(r.hostname) or "(unknown role)"
        cohorts.setdefault((role, r.puppet_branch or "master"), []).append(r)

    roles: list[dict[str, Any]] = []
    hosts: list[dict[str, Any]] = []
    for (role, branch), members in cohorts.items():
        # Only hosts hashed by the cohort's newest generator are compared with each other.
        reported = [r for r in members if r.sbom_sha256]
        current = max((_gen_key(r.generator_version) for r in reported), default=(0,))
        is_outdated = {r.hostname: _gen_key(r.generator_version) < current for r in reported}
        comparable = [
            r for r in reported
            if not is_outdated[r.hostname] and r.collected_at and now - r.collected_at <= _COLLECTION_STALE
        ]
        hosts_by_sha: dict[str, list[str]] = {}
        for r in comparable:
            hosts_by_sha.setdefault(r.sbom_sha256, []).append(r.hostname)
        groups, pending = _findings(db, hosts_by_sha)
        in_group: dict[str, list[int]] = {}
        for g in groups:
            for h in g["hosts"]:
                in_group.setdefault(h, []).append(g["id"])
        ranked = Counter({sha: len(h) for sha, h in hosts_by_sha.items()}).most_common()
        modal = ranked[0][0] if ranked else None

        key = role if branch == "master" else f"{role}@{branch}"
        views = []
        for r in members:
            v = {**_host_view(r, None, now, is_outdated.get(r.hostname, False)), "puppet_role": role, "cohort": key}
            if v["state"] in ("ok", "stale") and r.sbom_sha256 in pending and r.sbom_sha256 != modal:
                v["state"] = "pending"
            elif v["state"] == "ok" and r.hostname in in_group:
                v["state"] = "drifted"
            ids = in_group.get(r.hostname, [])
            items = [i for gid in ids for i in groups[gid]["items"]]
            v["findings"] = ids
            v["drift"] = {
                "added": sum(i["kind"] == "added" for i in items),
                "removed": sum(i["kind"] == "removed" for i in items),
                "changed": sum(i["kind"] == "changed" for i in items),
                "highlights": [i["label"] for i in items[:3]],
            } if items else None
            views.append(v)
        hosts.extend(views)
        roles.append({
            "key": key,
            "puppet_role": role,
            "puppet_branch": None if branch == "master" else branch,
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
            "split": False,
            "findings": groups,
            "drifted": sum(1 for v in views if v["state"] == "drifted"),
            "pending": sum(1 for v in views if v["state"] == "pending"),
            "updating": sum(1 for v in views if v["state"] == "updating"),
            "unhealthy": sum(1 for v in views if v["state"] in ("unreachable", "stale", "unknown")),
            "generator_version": ".".join(map(str, current)) if reported else None,
        })

    roles.sort(key=lambda r: (-len(r["findings"]), -r["unhealthy"], r["puppet_role"], r["puppet_branch"] or ""))
    order = {"drifted": 0, "pending": 1, "unreachable": 2, "stale": 3, "updating": 4, "unknown": 5, "ok": 6}
    hosts.sort(key=lambda h: (order[h["state"]], h["puppet_role"] or "", h["hostname"]))
    last = max((r.attempted_at for r in rows if r.attempted_at), default=None)
    return {
        "roles": roles,
        "hosts": hosts,
        "totals": {
            "hosts": len(rows),
            "reporting": sum(1 for h in hosts if h["state"] != "unknown"),
            "distinct_states": len({h["sbom_sha256"] for h in hosts if h["sbom_sha256"] and h["state"] != "updating"}),
            "updating": sum(1 for h in hosts if h["state"] == "updating"),
            "pending": sum(1 for h in hosts if h["state"] == "pending"),
            "documents": len(held),
            "drifted": sum(1 for h in hosts if h["state"] == "drifted"),
            "findings": sum(len(r["findings"]) for r in roles),
            "roles": len(roles),
            "roles_drifted": sum(1 for r in roles if r["findings"]),
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


# --- configuration summary -----------------------------------------------------
#
# A CycloneDX document is built for scanners: 600+ flat components. People want to
# know "what is this machine": its OS, toolchain, the worker binaries and who signed
# them, the Python it carries. This reshapes one document into that, for the
# configuration sheet. Content is fixed by the hash, so each summary is computed once.

_CONFIG_CACHE: dict[str, dict[str, Any]] = {}
_WORKER_BINARIES = ("generic-worker", "start-worker", "worker-runner", "livelog", "taskcluster")
_VERSION_IN = re.compile(r"\d+(?:\.\d+)+(?:[-+.\w]*)?")


def _props(c: dict[str, Any]) -> dict[str, str]:
    return {p.get("name", ""): p.get("value", "") for p in c.get("properties", []) or []}


def _clean_version(v: str | None) -> str | None:
    """`taskcluster version 67.1.0` -> `67.1.0`; leaves a plain version alone."""
    if not v:
        return None
    m = _VERSION_IN.search(v)
    return m.group(0) if m else v


def _signer(authority: str | None) -> str | None:
    """`Developer ID Application: Mozilla Corporation (43AQ936H96)` -> `Mozilla Corporation`."""
    if not authority:
        return None
    m = re.match(r"^(?:Developer ID Application|Apple Development|Apple Distribution):\s*(.+?)(?:\s*\([A-Z0-9]{10}\))?$", authority)
    return m.group(1) if m else authority


def _interpreter_label(path: str) -> str:
    m = re.search(r"python(\d+\.\d+)", path)
    return f"Python {m.group(1)}" if m else "Python 3"


def config_summary(sha: str, doc: dict[str, Any]) -> dict[str, Any]:
    if sha in _CONFIG_CACHE:
        return _CONFIG_CACHE[sha]
    comps = doc.get("components", [])
    os_c = next((c for c in comps if c.get("type") == "operating-system"), {})
    os_p = _props(os_c)

    binaries, devtools, receipts, apple, brew = [], [], [], [], []
    python: dict[str, list[dict[str, Any]]] = {}
    for c in comps:
        t, name, p = c.get("type"), c.get("name", ""), _props(c)
        if t == "file":
            signer = _signer(p.get("macos:codesign_authority"))
            binaries.append({
                "name": name.rsplit("/", 1)[-1],
                "version": _clean_version(c.get("version")),
                "detail": f"Signed · {signer}" if signer else ("→ " + p["file:target"] if p.get("file:target") else "Unsigned"),
                "signed": bool(signer),
            })
        elif t == "library":
            interp = p.get("python:interpreter", "")
            python.setdefault(interp, []).append({"name": name, "version": c.get("version")})
        elif t == "application" and p.get("xcode:path"):
            devtools.append({
                "name": name.removesuffix(".app"),
                "version": c.get("version"),
                "detail": ("Selected · " if p.get("xcode:selected") == "true" else "") + f"build {p.get('xcode:build', '?')}",
            })
        elif t == "application" and name.startswith("com.apple.pkg.CLTools"):
            devtools.append({"name": "Command Line Tools", "version": c.get("version"), "detail": name.removeprefix("com.apple.pkg.")})
        elif t == "application" and p.get("brew:kind"):
            brew.append({"name": name, "version": c.get("version"), "detail": p["brew:kind"]})
        elif t == "application":
            item = {"name": name, "version": c.get("version"), "detail": p.get("macos:install_date", "")[:10] or None}
            (apple if name.startswith("com.apple.") else receipts).append(item)

    # Several receipts per CLT install; show the tool once.
    seen: set[tuple[str, str | None]] = set()
    devtools = [d for d in devtools if not ((d["name"], d["version"]) in seen or seen.add((d["name"], d["version"])))]
    # Taskcluster's own binaries are why these machines exist; they lead.
    binaries.sort(key=lambda b: (not b["name"].startswith(_WORKER_BINARIES), b["name"].lower()))
    receipts.sort(key=lambda r: r["name"].lower())

    interpreters = [
        {
            "label": _interpreter_label(path),
            "path": path,
            "packages": sorted(pkgs, key=lambda x: x["name"].lower()),
        }
        for path, pkgs in sorted(python.items(), key=lambda kv: -len(kv[1]))
    ]

    # The handful of facts that identify a machine, in reading order. Only what's present.
    glance = [{"label": "macOS", "value": os_c.get("version") or "—", "detail": os_p.get("macos:build")}]
    xcode = next((d for d in devtools if d["name"] != "Command Line Tools" and d["detail"].startswith("Selected")), None) \
        or next((d for d in devtools if d["name"] != "Command Line Tools"), None)
    if xcode:
        glance.append({"label": "Xcode", "value": xcode["version"], "detail": xcode["detail"].replace("Selected · ", "")})
    elif devtools:
        glance.append({"label": "Command Line Tools", "value": devtools[0]["version"], "detail": None})
    if interpreters:
        versions = sorted({i["label"].removeprefix("Python ") for i in interpreters})
        glance.append({
            "label": "Python",
            "value": versions[-1],
            "detail": f"{len(interpreters)} interpreters" if len(interpreters) > 1 else f"{len(interpreters[0]['packages'])} packages",
        })
    gw = next((b for b in binaries if b["name"].startswith("generic-worker")), None)
    if gw:
        glance.append({"label": "generic-worker", "value": gw["version"] or "present", "detail": gw["detail"].removeprefix("Signed · ")})

    out = {
        "sha256": sha,
        "component_count": len(comps),
        "generated_at": (doc.get("metadata") or {}).get("timestamp"),
        "os": {"name": os_c.get("name", "macOS"), "version": os_c.get("version"), "build": os_p.get("macos:build"),
               "arch": os_p.get("macos:arch"), "sip": os_p.get("macos:sip")},
        "glance": glance,
        "binaries": binaries,
        "devtools": devtools,
        "python": interpreters,
        "packages": receipts,
        "apple_packages": apple,
        "homebrew": brew,
    }
    if len(_CONFIG_CACHE) >= 64:
        _CONFIG_CACHE.clear()
    _CONFIG_CACHE[sha] = out
    return out


@router.get("/documents/{sha}/config")
def sbom_config(sha: str, user: str = Depends(require_access), db: Session = Depends(get_db)) -> dict[str, Any]:
    """One software state, reshaped from a flat component list into what a person reads."""
    if sha in _CONFIG_CACHE:
        return _CONFIG_CACHE[sha]
    return config_summary(sha, _get_doc(db, sha))


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
