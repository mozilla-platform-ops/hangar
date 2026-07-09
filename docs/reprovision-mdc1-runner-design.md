# Design: secure Hangar → MDC1 reprovision execution (the on-network runner)

**Status:** proposal · **Author:** RelOps + Claude · **Date:** 2026-07-09
**Context:** follows the shipped read-only reprovision *cockpit* (allowlisted panel + audit ledger in Hangar).

## Problem

Hangar runs on **Cloud Run** (`INGRESS_INTERNAL_LOAD_BALANCER`, a VPC connector scoped to Cloud
SQL). It reaches SimpleMDM and Taskcluster over **public APIs** and has **no network path to the
MDC1 test network** (`*.test.releng.mdc1.mozilla.com`). The `reprovision` flow's core steps —
`mint` (interactive SSH password login), `escrow-bst`, the BST-escrowed guard, and the sentinel
poll — **require on-VPN SSH to the worker**. So Hangar can present, audit, and monitor a
reprovision, but it **cannot execute** one.

We want the "Reprovision" button to *actually run* the flow, without punching an inbound hole
into MDC1 or putting SSH/admin credentials into Cloud Run.

## Constraints & principles

- **No inbound to MDC1.** Whatever runs on-network must initiate all connections outward.
  (Same model as GitHub self-hosted runners.)
- **No SSH/admin creds in Cloud Run.** Hangar holds *intent + audit*, never the operator key or
  admin password.
- **Reuse the proven CLI.** Execution = the exact `reprovision` CLI, so all its safety guards
  (BST-escrowed check, busy-worker guard, `DoNotObliterate`, graceful errors) apply unchanged.
- **Authorization stays in Hangar.** Only the allowlisted users can enqueue (already built +
  IAP-verified). Every job is attributed to a real human.
- **Auditable end-to-end.** who / what / when / outcome, with live step events.

## Non-goals

- Fully autonomous/self-healing reprovision (a later phase; this design is the substrate for it).
- Replacing the CLI. The runner *invokes* it.

## Recommended architecture: a pull-based on-network runner

```
   operator (IAP)                 Hangar (Cloud Run)            on-network runner (MDC1/VPN)         worker
        │  click "Reprovision"          │                                │                              │
        │─────────────────────────────►│  enqueue job                    │                              │
        │                              │  {id, host, requested_by, scope}│                              │
        │                              │            (queue)  ◄───────────│  pull next job (OUTBOUND)    │
        │                              │                                │  reprovision run <host> ─────►│ ssh/EACS/mint/…
        │                              │  ◄─── stream step/wire events ──│  (on VPN, holds creds)       │
        │  live cockpit (SSE/poll) ◄───│  persist to audit ledger        │                              │
```

**Components**

1. **Hangar (control plane)** — extends the shipped cockpit:
   - `POST /api/reprovision/{host}/enqueue` (allowlisted) → creates a `ReprovisionJob` (queued),
     attributed to the IAP user.
   - A job channel the runner pulls from (see Transport).
   - `POST /api/reprovision/jobs/{id}/events` (runner-authenticated) → append step events;
     drives the live cockpit + audit ledger.
   - Concurrency lock: at most one active job per host.

2. **The runner (execution plane)** — a small, long-running service on an **on-network host**
   (an MDC1 jump box, a dedicated relops runner mac/VM, or an always-on operator machine on the
   VPN). It:
   - Authenticates *outbound* with its **mTLS step-ca client cert** (validated by the LB).
   - Pulls a job, acquires the per-host lock, runs `reprovision run <host>` (the real CLI).
   - Streams the CLI's `ui` events back (the `step`/`wire`/`ok`/summary vocabulary already exists —
     add an emitter sink so the same events feed both the terminal and an HTTP/queue callback).
   - Holds the operator SSH key + admin creds locally (1Password / Secret Manager on-network),
     and ideally short-lived **OIDC TC creds** (see "Avenue A").

**Why pull, not push:** the runner initiates everything → **zero inbound firewall exceptions into
MDC1**. Hangar never connects to a worker and never holds SSH creds. This is the crux of the
security story.

## Chosen transport: mTLS via the forge trust model  ✅

We do **not** need a Google/IAP identity or a GCP service account on the runner. We reuse the
**exact primitive `forge` already runs** for the vault-broker: an HTTPS LB terminates mTLS,
validates the client cert against step-ca's **Trust Config**, and forwards `X-Client-Cert-*`
headers; the app authorizes on the cert's SPIFFE identity. The runner is just another
step-ca-cert-holding on-network client — same trust model as the workers.

- **Transport:** runner → Hangar over HTTPS **long-poll** (`claim`/`event`/`complete`),
  authenticated by an **mTLS client cert** (not IAP). Outbound-only from MDC1.
- **AuthN/Z (done in code):** `require_runner` accepts a chain-verified `X-Client-Cert-Spiffe`
  whose host is in `reprovision_runner_hosts`, or the shared token for local/dev.
- **Bonus — secrets:** the runner can fetch its `REPROVISION_*` creds from the **vault-broker
  over the same mTLS cert** (exactly how a worker fetches `vault.yaml`), so no 1Password
  service account or secrets file on the box.
- **Runner cert:** issue a **dedicated on-disk** step-ca client cert (so `httpx` can do mTLS
  directly). The keychain SCEP key can't be used in-process (the ACL constraint that forced
  `securetransport-curl` for the vault fetch); a dedicated cert/key file sidesteps that.

Rejected alternatives: **GCP SA + IAP bearer token** (needs a Google identity on m4-81),
**Pub/Sub** (also needs a GCP SA; more infra). Both viable, but mTLS reuses infra we already
run and unifies the runner with the worker trust model. Pub/Sub remains a fine future upgrade
for durability/fan-out.

### What's left to wire (needs GCP / step-ca access)

1. **Front `/api/reprovision/runner/*` with a forge-style mTLS ingress.** Mirror forge's
   `terraform/lb.tf` + `mtls.tf`: a URL-map path-matcher sending `/api/reprovision/runner/*` to
   a backend with a **Server TLS Policy** (`clientValidationMode = ALLOW_INVALID_OR_MISSING`) +
   the step-ca **Trust Config**, forwarding `X-Client-Cert-{Present,Chain-Verified,Leaf,Serial,Spiffe}`,
   Cloud-Armored to the MDC1 source CIDR. Hangar's main app stays IAP'd; only this path is mTLS.
   (Hangar's Cloud Run ingress is already internal-LB-only, so the cert headers can't be spoofed
   via a direct call.)
2. **Issue the runner a step-ca client cert** — runbook:
   ```bash
   # on the step-ca host (or with step-ca admin creds), add a runner provisioner once:
   step ca provisioner add reprovision-runner --type JWK --create   # or reuse a role provisioner
   # issue a dedicated on-disk cert for m4-81 with the forge SPIFFE SAN:
   step ca certificate "macmini-m4-81" runner.crt runner.key \
     --san "spiffe://relops.mozilla/host/macmini-m4-81/role/reprovision-runner" \
     --not-after 720h
   # place on m4-81 (0600) and point the runner at it:
   #   RUNNER_CLIENT_CERT=/path/runner.crt  RUNNER_CLIENT_KEY=/path/runner.key
   ```
   Then set `REPROVISION_RUNNER_HOSTS=macmini-m4-81` in Hangar's prod env. Renew via step-ca
   before `--not-after`.

### Other transports (kept for reference)

| Option | How | Why not (for now) |
|---|---|---|
| Cloud Pub/Sub | Hangar publishes jobs; runner pulls with a GCP SA | needs a GCP SA on the runner; more infra. Good future durability upgrade. |
| GCP SA + IAP bearer token | runner mints an IAP OIDC token | needs a Google identity on m4-81 |
| GitHub Actions self-hosted runner | `workflow_dispatch` → self-hosted runner | couples to GH Actions; coarser streaming |

Recommendation: **HTTP long-poll for the MVP** (fewest moving parts, reuses Hangar's existing
auth surface), migrate to **Pub/Sub** when we want durability + fan-out.

## Security properties

- **Outbound-only from MDC1** — no inbound path opened; runner dials out to GCP/Hangar.
- **Creds isolation** — SSH/admin/TC creds live only on the on-network runner; Cloud Run holds
  none. Compromise of Hangar ≠ compromise of worker SSH.
- **Human-attributed, allowlisted** — only the four allowlisted users can enqueue; every job
  carries the IAP-verified email; the runner records execution + streams events → full ledger.
- **Runner authN** — the runner authenticates with an **mTLS step-ca client cert** (forge Trust
  Config); Hangar authorizes only allowlisted SPIFFE hostnames (`reprovision_runner_hosts`) to
  pull jobs and post events. Per-cert identity — revocable + auditable, better than a shared token.
- **Least privilege + short-lived TC** — pair with **Avenue A** (short-lived OIDC Taskcluster
  creds) so the runner's TC access is scoped + expiring rather than a static token.
- **Safety preserved** — execution is the CLI, so BST-escrow guard + busy-worker guard +
  `DoNotObliterate` still prevent bricking/mid-task wipes even on a bad enqueue.
- **Single-flight** — per-host job lock prevents concurrent reprovisions of the same worker.

## Runner host options

- A **dedicated relops runner** (small Linux VM or mac) on the MDC1 network / relops VPN — cleanest.
- An **existing MDC1 jump/bastion** host, if one is already trusted for operator SSH.
- An **always-on operator machine** on the VPN (fine to bootstrap the MVP; not durable).

(Note: the runner must be *on-network*. Cloud-Run-based options like `relops-provisioner` can't
serve here — same network gap as Hangar.)

## Phased plan

- **Phase 1 — DONE:** read-only cockpit (allowlisted panel, readiness, CLI handoff, audit ledger).
- **Phase 2 — runner MVP:** `ReprovisionJob` model + enqueue endpoint + HTTP long-poll; a
  `reprovision-runner` service on one on-network host that pulls a job, runs `reprovision run`,
  and POSTs step events back. Turn the cockpit's "Log reprovision start" into "Reprovision"
  (actually executes) + a live step timeline in the browser.
- **Phase 3 — harden:** Pub/Sub transport, OIDC TC creds (Avenue A), signed jobs, per-host
  locking, retries/timeouts, and the full rainbow step stream rendered live in Hangar.
- **Phase 4 — autonomous:** wire worker_health/fitness signals to auto-enqueue reprovisions
  (guarded), so the fleet self-heals — the cockpit becomes the audit + override surface.

## Open questions

- Where does the runner live, and who owns it? (dedicated VM vs jump host vs operator machine)
- Do we adopt Avenue A (OIDC TC creds) for the runner, or give it a scoped static TC client?
- Pub/Sub vs HTTP long-poll for v1 (leaning HTTP for speed, Pub/Sub for durability).
- Live streaming: SSE from Hangar to the browser vs the existing poll — poll is fine for v1.

## What already exists to build on

- The `reprovision` CLI with all guards + a structured `ui` layer (easy to add an event-emitter
  sink for streaming) — `relops-bootstrap/orchestrator`.
- Hangar's allowlisted cockpit + `ReprovisionEvent` audit ledger + IAP identity — this repo,
  `backend/app/api/reprovision.py`.
