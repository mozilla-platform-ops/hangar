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
   - Authenticates *outbound* to the job channel with its own identity (GCP SA / OIDC).
   - Pulls a job, acquires the per-host lock, runs `reprovision run <host>` (the real CLI).
   - Streams the CLI's `ui` events back (the `step`/`wire`/`ok`/summary vocabulary already exists —
     add an emitter sink so the same events feed both the terminal and an HTTP/queue callback).
   - Holds the operator SSH key + admin creds locally (1Password / Secret Manager on-network),
     and ideally short-lived **OIDC TC creds** (see "Avenue A").

**Why pull, not push:** the runner initiates everything → **zero inbound firewall exceptions into
MDC1**. Hangar never connects to a worker and never holds SSH creds. This is the crux of the
security story.

## Transport options (pick one)

| Option | How | Pros | Cons |
|---|---|---|---|
| **Cloud Pub/Sub** *(recommended)* | Hangar publishes to `reprovision-jobs`; runner is a pull subscriber; events to `reprovision-events` (Hangar subscribes) | GCP-native, durable, SA-auth, decoupled, outbound-only | one more GCP resource |
| **Authenticated HTTP long-poll** | runner polls `GET /jobs/next` + `POST /jobs/{id}/events` with an SA/OIDC token | no new infra; simplest | Hangar must be reachable from MDC1 (outbound HTTPS to the LB — fine) |
| **GitHub Actions self-hosted runner** | Hangar triggers `workflow_dispatch`; a self-hosted runner in MDC1 runs `reprovision` | reuses CI infra + audit + runner mgmt | couples to GH Actions; coarser live streaming |

Recommendation: **HTTP long-poll for the MVP** (fewest moving parts, reuses Hangar's existing
auth surface), migrate to **Pub/Sub** when we want durability + fan-out.

## Security properties

- **Outbound-only from MDC1** — no inbound path opened; runner dials out to GCP/Hangar.
- **Creds isolation** — SSH/admin/TC creds live only on the on-network runner; Cloud Run holds
  none. Compromise of Hangar ≠ compromise of worker SSH.
- **Human-attributed, allowlisted** — only the four allowlisted users can enqueue; every job
  carries the IAP-verified email; the runner records execution + streams events → full ledger.
- **Runner authN** — the runner authenticates to the job channel with its own GCP SA / OIDC;
  Hangar authorizes only that identity to pull jobs and post events.
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
