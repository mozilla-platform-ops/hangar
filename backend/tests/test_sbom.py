"""macOS fleet SBOM: dedup on the content hash, and drift by role."""
from __future__ import annotations

import copy
from datetime import datetime, timedelta

import pytest
from app.api import sbom
from app.database import Base
from app.models import SbomDocument, Worker, WorkerSbom
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

# Computed by ronin_puppet modules/macos_sbom/files/generate_sbom.py fingerprint()
# on these exact components. If this breaks, the two implementations have diverged
# and every pushed document will be rejected.
COMPONENTS = [
    {"type": "operating-system", "name": "macOS", "version": "15.7.1"},
    {"type": "application", "name": "com.apple.pkg.CLTools_Executables", "version": "16.4",
     "purl": "pkg:generic/com.apple.pkg.CLTools_Executables@16.4",
     "properties": [{"name": "install_date", "value": "x"}]},
    {"type": "file", "name": "/usr/local/bin/generic-worker",
     "hashes": [{"alg": "SHA-256", "content": "ab" * 32}]},
    {"type": "library", "name": "pyyaml", "version": "6.0.2", "purl": "pkg:pypi/pyyaml@6.0.2"},
]
SHA = "79bcd2edce48ca428a549013ffccf517fc35b60edc437292655a2632ddc60e7e"

ROLE = "gecko_t_osx_1500_m4"


def doc(components: list[dict]) -> dict:
    return {"bomFormat": "CycloneDX", "specVersion": "1.6", "components": components}


def drifted_components() -> list[dict]:
    c = copy.deepcopy(COMPONENTS)
    c[3]["version"] = "6.0.3"
    c[3]["purl"] = "pkg:pypi/pyyaml@6.0.3"
    c.append({"type": "application", "name": "com.example.stray", "version": "1"})
    return c


def fingerprint(sha: str, role: str = ROLE, **kw) -> dict:
    return {
        "schema_version": 1,
        "generated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "puppet_role": role,
        "macos_version": "15.7.1",
        "arch": "arm64",
        "hw_model": "Mac16,10",
        "is_vm": False,
        "sip": "enabled",
        "sbom_sha256": sha,
        "component_count": 4,
        "generator_version": "2.0.0",
        **kw,
    }


@pytest.fixture
def db() -> Session:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        yield session


def push(db: Session, hosts: list[dict], documents: dict | None = None) -> dict:
    payload = sbom.SbomPush(hosts=[sbom.HostPush(**h) for h in hosts], documents=documents or {})
    return sbom.agent_push(payload, runner="test", db=db)


def test_fingerprint_matches_ronin_generator() -> None:
    assert sbom.component_fingerprint(COMPONENTS) == SHA
    # Order and non-identity fields (install dates) must not move it.
    shuffled = list(reversed(copy.deepcopy(COMPONENTS)))
    shuffled[2]["properties"] = [{"name": "install_date", "value": "later"}]
    assert sbom.component_fingerprint(shuffled) == SHA


def test_document_stored_once_and_reported_missing_until_then(db: Session) -> None:
    hosts = [{"hostname": f"macmini-m4-{n}", "fingerprint": fingerprint(SHA)} for n in (1, 2)]

    r = push(db, hosts)
    assert r["accepted"] == 2
    assert r["missing_sha256"] == [SHA]

    r = push(db, hosts, {SHA: doc(COMPONENTS)})
    assert r["documents_stored"] == 1
    assert r["missing_sha256"] == []
    assert db.get(SbomDocument, SHA).source_hostname == "macmini-m4-1.test.releng.mdc1.mozilla.com"

    r = push(db, hosts, {SHA: doc(COMPONENTS)})
    assert r["documents_stored"] == 0
    assert db.query(SbomDocument).count() == 1


def test_document_whose_content_does_not_match_its_key_is_rejected(db: Session) -> None:
    r = push(db, [], {SHA: doc(drifted_components())})
    assert r["documents_stored"] == 0
    assert "content hashes to" in r["documents_rejected"][SHA]
    assert db.query(SbomDocument).count() == 0

    r = push(db, [], {"nothex": doc(COMPONENTS), SHA: {"components": COMPONENTS}})
    assert set(r["documents_rejected"]) == {"nothex", SHA}


def test_failed_read_keeps_last_good_fingerprint(db: Session) -> None:
    h = "macmini-m4-1"
    push(db, [{"hostname": h, "fingerprint": fingerprint(SHA)}])
    push(db, [{"hostname": h, "fingerprint": None, "agent_error": "ssh timed out after 120s"}])

    row = db.get(WorkerSbom, "macmini-m4-1.test.releng.mdc1.mozilla.com")
    assert row.sbom_sha256 == SHA
    assert row.agent_error == "ssh timed out after 120s"


def test_rollup_flags_the_host_off_its_roles_modal_state(db: Session) -> None:
    drift_sha = sbom.component_fingerprint(drifted_components())
    hosts = [{"hostname": f"macmini-m4-{n}", "fingerprint": fingerprint(SHA)} for n in (1, 2, 3)]
    hosts.append({"hostname": "macmini-m4-4", "fingerprint": fingerprint(drift_sha)})
    push(db, hosts, {SHA: doc(COMPONENTS), drift_sha: doc(drifted_components())})

    out = sbom.sbom_rollup(user="u", db=db)
    role = out["roles"][0]
    assert role["modal_sha256"] == SHA
    assert role["drifted"] == 1
    assert out["hosts"][0]["hostname"].startswith("macmini-m4-4.")
    assert out["hosts"][0]["state"] == "drifted"
    assert out["totals"] == {"hosts": 4, "reporting": 4, "distinct_states": 2, "documents": 2, "drifted": 1,
                             "updating": 0, "roles": 1, "roles_drifted": 1}
    assert out["hosts"][0]["drift"] == {
        "added": 1, "removed": 0, "changed": 1,
        "highlights": ["~ pyyaml 6.0.2 → 6.0.3", "+ com.example.stray 1"],
    }
    assert out["hosts"][1]["drift"] is None


def test_tied_role_is_split_and_flags_nobody(db: Session) -> None:
    drift_sha = sbom.component_fingerprint(drifted_components())
    push(db, [
        {"hostname": "macmini-m4-1", "fingerprint": fingerprint(SHA)},
        {"hostname": "macmini-m4-2", "fingerprint": fingerprint(drift_sha)},
    ])
    role = sbom.sbom_rollup(user="u", db=db)["roles"][0]
    assert role["split"] is True
    assert role["modal_sha256"] is None
    assert role["drifted"] == 0


def test_stale_fingerprint_means_puppet_is_not_converging(db: Session) -> None:
    old = (datetime.utcnow() - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    push(db, [{"hostname": "macmini-m4-1", "fingerprint": fingerprint(SHA, generated_at=old)}])
    assert sbom.sbom_rollup(user="u", db=db)["hosts"][0]["state"] == "stale"


def test_diff_shows_what_the_drifted_host_changed(db: Session) -> None:
    drift_sha = sbom.component_fingerprint(drifted_components())
    push(db, [], {SHA: doc(COMPONENTS), drift_sha: doc(drifted_components())})

    d = sbom.sbom_diff(base=SHA, head=drift_sha, user="u", db=db)
    assert d["added"] == [{"type": "application", "name": "com.example.stray", "version": "1"}]
    assert d["removed"] == []
    assert d["changed"] == [{"type": "library", "name": "pyyaml", "base": "6.0.2", "head": "6.0.3"}]


def test_targets_are_puppet_managed_macs_only(db: Session) -> None:
    db.add_all([
        Worker(hostname="macmini-m4-1.test.releng.mdc1.mozilla.com", platform="mac", puppet_role=ROLE),
        # Not yet seen in Taskcluster, so no platform: still a mac by name.
        Worker(hostname="macmini-m4-2.test.releng.mdc1.mozilla.com", puppet_role=ROLE),
        Worker(hostname="t-linux64-ms-001.test.releng.mdc1.mozilla.com", platform="linux",
               puppet_role="gecko_t_linux_talos"),
        Worker(hostname="nuc13-001.wintest2.releng.mdc1.mozilla.com", platform="windows",
               puppet_role="win11-64-24h2-hw"),
        Worker(hostname="macmini-m4-3.test.releng.mdc1.mozilla.com", platform="mac"),  # out of puppet
    ])
    db.add(SbomDocument(sha256=SHA, document="{}"))
    db.commit()

    out = sbom.agent_targets(runner="test", db=db)
    assert out["hosts"] == [
        "macmini-m4-1.test.releng.mdc1.mozilla.com",
        "macmini-m4-2.test.releng.mdc1.mozilla.com",
    ]
    assert out["known_sha256"] == [SHA]


def test_orphaned_documents_pruned_after_retention(db: Session) -> None:
    db.add(SbomDocument(sha256="0" * 64, document="{}",
                        first_seen_at=datetime.utcnow() - timedelta(days=91)))
    db.add(SbomDocument(sha256="1" * 64, document="{}",
                        first_seen_at=datetime.utcnow() - timedelta(days=91)))
    db.commit()
    r = push(db, [{"hostname": "macmini-m4-1", "fingerprint": fingerprint("1" * 64)}])
    assert r["documents_pruned"] == 1
    assert db.get(SbomDocument, "1" * 64) is not None


def test_never_reported_host_is_grouped_under_its_inventory_role(db: Session) -> None:
    h = "macmini-m4-9.test.releng.mdc1.mozilla.com"
    db.add(Worker(hostname=h, platform="mac", puppet_role=ROLE))
    db.commit()
    push(db, [
        {"hostname": "macmini-m4-1", "fingerprint": fingerprint(SHA)},
        {"hostname": h, "fingerprint": None, "agent_error": "no fingerprint (macos_sbom not applied?)"},
    ])
    out = sbom.sbom_rollup(user="u", db=db)
    assert [r["puppet_role"] for r in out["roles"]] == [ROLE]
    assert out["roles"][0]["unhealthy"] == 1
    assert {x["hostname"]: x["state"] for x in out["hosts"]}[h] == "unknown"


def test_rollup_names_the_macs_it_cannot_cover(db: Session) -> None:
    db.add_all([
        Worker(hostname="mac-070945", platform="mac", worker_pool="gecko-t-osx-1500-m-vms"),
        Worker(hostname="mac-070946", platform="mac", worker_pool="gecko-t-osx-1500-m-vms"),
        Worker(hostname="gecko-signing-mac14m2-01", platform="mac", worker_pool="gecko-signing-mac14m2"),
        # Targeted, so covered even before it reports.
        Worker(hostname="macmini-m4-1.test.releng.mdc1.mozilla.com", platform="mac", puppet_role=ROLE),
    ])
    db.commit()
    assert sbom.sbom_rollup(user="u", db=db)["uncovered"] == [
        {"pool": "gecko-t-osx-1500-m-vms", "hosts": 2, "reason": "VM guests aren't reachable by the agent"},
        {"pool": "gecko-signing-mac14m2", "hosts": 1, "reason": "signers are excluded from macos_sbom"},
    ]


def test_config_summary_reads_like_a_spec_sheet() -> None:
    comps = [
        {"type": "operating-system", "name": "macOS", "version": "15.7.1",
         "properties": [{"name": "macos:build", "value": "24G231"}]},
        {"type": "application", "name": "Xcode.app", "version": "16.4",
         "properties": [{"name": "xcode:path", "value": "/Applications/Xcode.app"},
                        {"name": "xcode:build", "value": "16F6"}, {"name": "xcode:selected", "value": "true"}]},
        {"type": "application", "name": "com.apple.pkg.CLTools_Executables", "version": "16.4"},
        {"type": "application", "name": "com.apple.pkg.MobileAssets", "version": "1"},
        {"type": "application", "name": "com.puppetlabs.puppet-agent", "version": "8.10.0"},
        {"type": "file", "name": "/usr/local/bin/generic-worker", "version": "generic-worker 83.4.1",
         "properties": [{"name": "macos:codesign_authority",
                         "value": "Developer ID Application: Mozilla Corporation (43AQ936H96)"}]},
        {"type": "file", "name": "/usr/local/bin/livelog"},
        {"type": "library", "name": "PyYAML", "version": "6.0.2",
         "properties": [{"name": "python:interpreter", "value": "/usr/local/bin/python3.11"}]},
    ]
    c = sbom.config_summary("x" * 64, {"components": comps})
    assert [(g["label"], g["value"]) for g in c["glance"]] == [
        ("macOS", "15.7.1"), ("Xcode", "16.4"), ("Python", "3.11"), ("generic-worker", "83.4.1"),
    ]
    assert c["binaries"][0] == {"name": "generic-worker", "version": "83.4.1",
                                "detail": "Signed · Mozilla Corporation", "signed": True}
    assert c["binaries"][1]["detail"] == "Unsigned"
    assert [d["name"] for d in c["devtools"]] == ["Xcode", "Command Line Tools"]
    assert [p["name"] for p in c["packages"]] == ["com.puppetlabs.puppet-agent"]
    assert [p["name"] for p in c["apple_packages"]] == ["com.apple.pkg.MobileAssets"]
    assert c["python"][0]["label"] == "Python 3.11"
    assert c["homebrew"] == []


def test_fingerprint_skips_components_tagged_out_of_identity() -> None:
    # Same tagging rule as macos_sbom 2.2.0: present in the document, absent from the hash.
    tagged = copy.deepcopy(COMPONENTS) + [
        {"type": "application", "name": "com.github.munki.pkg.p_role_1500", "version": "1.0",
         "properties": [{"name": "relops:fingerprint", "value": "excluded: provisioning history (munki)"}]},
    ]
    assert sbom.component_fingerprint(tagged) == SHA


def test_hosts_on_an_older_generator_are_updating_not_drifted(db: Session) -> None:
    # Mid-rollout of a generator that changes what counts toward the hash: the old
    # hashes differ, but that says nothing about the software.
    push(db, [
        {"hostname": "macmini-m4-1", "fingerprint": fingerprint(SHA, generator_version="2.2.0")},
        {"hostname": "macmini-m4-2", "fingerprint": fingerprint(SHA, generator_version="2.2.0")},
        {"hostname": "macmini-m4-3", "fingerprint": fingerprint("a" * 64, generator_version="2.1.0")},
        {"hostname": "macmini-m4-4", "fingerprint": fingerprint("b" * 64, generator_version="2.0.0")},
    ])
    out = sbom.sbom_rollup(user="u", db=db)
    role = out["roles"][0]
    assert role["modal_sha256"] == SHA
    assert (role["drifted"], role["updating"]) == (0, 2)
    assert role["generator_version"] == "2.2.0"
    assert [s["sbom_sha256"] for s in role["states"]] == [SHA]
    assert out["totals"]["distinct_states"] == 1
