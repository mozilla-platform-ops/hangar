# Hangar — Claude Handoff Document

Share this file at the start of a new session to restore full context.

---

## What this project is

**Hangar** is the RelOps Fleet Dashboard — a FastAPI + React SPA that aggregates data from Taskcluster, SimpleMDM, Puppet, and Google Sheets to give visibility into the Mozilla macOS CI worker fleet (~400 mac minis across MDC1).

- **Original version**: running on `macmini-m4-117.test.releng.mdc1.mozilla.com`, code at `/Users/admin/relops-dashboard/`, served by uvicorn on port 8000.
- **New GCP version**: deployed to Cloud Run in project `relops-dashboard` (GCP), accessible behind Cloud IAP. This is the version in this repo, on branch `security_deploy`.

---

## GCP Infrastructure

| Resource | Value |
|---|---|
| GCP Project | `relops-dashboard` |
| Region | `us-central1` |
| Cloud Run service | `hangar` |
| Cloud Run URL | `https://hangar-vyqzdo4yva-uc.a.run.app` |
| Load balancer IP | `34.54.129.77` |
| Target DNS | `hangar.relops.mozilla.com` → `34.54.129.77` (not yet pointed) |
| Cloud SQL instance | `hangar-db` (Postgres 16, private IP, `ENCRYPTED_ONLY` SSL) |
| Artifact Registry | `us-central1-docker.pkg.dev/relops-dashboard/hangar/hangar` |
| IAP OAuth client | `488152629256-83ivupuuj3gtrbl9s1minapsv9bq0td5.apps.googleusercontent.com` |
| Cloud Build trigger | Watches `security_deploy` branch, uses `hangar-run` service account |
| Terraform state | Local (TODO: migrate to GCS backend) |

**Ingress**: Currently set to `INGRESS_TRAFFIC_ALL` (public) with `allUsers roles/run.invoker` for testing. Should be locked back to `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` and remove the allUsers binding after DNS/IAP is confirmed working.

**Auth**: Cloud IAP restricts access to `@mozilla.com` Google accounts. IAP members list is in `terraform/variables.tf` → `iap_authorized_members`.

---

## Terraform

State is local (not in GCS yet). All infra is in `terraform/`.

```bash
# Auth workaround — ADC doesn't work, use access token:
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)
cd terraform
terraform plan
terraform apply
```

Key files:
- `terraform/main.tf` — providers, project services, VPC, VPC Access Connector
- `terraform/run.tf` — Cloud Run service definition, secrets volume mounts
- `terraform/sql.tf` — Cloud SQL Postgres 16
- `terraform/lb.tf` — Global LB, IAP, Cloud Armor (OWASP rules + rate limit)
- `terraform/iam.tf` — Service accounts and IAM bindings
- `terraform/secrets.tf` — Secret Manager secrets
- `terraform/variables.tf` — All configurable vars

**Known Terraform issue**: `require_ssl=true` maps to `TRUSTED_CLIENT_CERTIFICATE_REQUIRED` in Cloud SQL. The DB was already patched via `gcloud sql instances patch hangar-db --ssl-mode=ENCRYPTED_ONLY`. The Terraform `sql.tf` already has the correct `ssl_mode = "ENCRYPTED_ONLY"` so a fresh apply would be correct.

---

## Teardown

**Quick (stop service, keep resources):**
```bash
gcloud run services delete hangar --region=us-central1 --project=relops-dashboard
```

**Full teardown (destroy everything Terraform manages):**
```bash
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)
cd terraform && terraform destroy
```

**Nuclear (delete entire GCP project — 30-day grace period):**
```bash
gcloud projects delete relops-dashboard
```

---

## Secrets in Secret Manager

All under project `relops-dashboard`. Seeded via `gcloud secrets versions add`:

| Secret name | Status | Notes |
|---|---|---|
| `hangar-db-password` | ✅ real | Postgres password |
| `hangar-simplemdm-key` | ✅ real | `MoZiKH2mPknoeRjmajWACyLSlr0YS6NTMNQQ2UflcLMpYDwxUBTaySQPS1iwVYeT` |
| `hangar-iap-client-secret` | ✅ real | IAP OAuth secret |
| `hangar-tc-client-id` | placeholder | TC doesn't need auth for public GraphQL |
| `hangar-tc-access-token` | placeholder | Same |
| `hangar-google-sheets-id` | placeholder | Not yet configured |
| `hangar-google-credentials` | placeholder | Not yet configured |
| `hangar-ssh-known-hosts` | placeholder | **Needs real known_hosts populated** |

**SSH dashboard key**: The pool batch SSH operations (`/api/pools/{pool}/set-branch` etc.) need the `relops` user's private key. This should be added as a new secret and mounted at `SSH_DASHBOARD_KEY_PATH` (default `/run/secrets/ssh/dashboard_key`). Not yet done.

---

## CI/CD

`cloudbuild.yaml` at repo root. Triggered on push to `security_deploy`. Uses `hangar-run` service account (not the default Cloud Build SA).

Steps: build frontend → build+push Docker image → deploy to Cloud Run.

To deploy manually:
```bash
gcloud builds submit --region=us-central1 --config=cloudbuild.yaml .
```

---

## Repo structure

```
hangar/
├── backend/
│   └── app/
│       ├── api/
│       │   ├── alerts.py       # Alert CRUD
│       │   ├── fleet.py        # /fleet/* endpoints (summary, pools, pending-counts, pool-sources, failures, consolidation)
│       │   ├── pools.py        # /pools/* batch SSH (set/clear branch)
│       │   ├── shell.py        # WebSocket SSH terminal + VNC proxy
│       │   └── workers.py      # Worker CRUD
│       ├── sync/
│       │   ├── taskcluster.py  # TC GraphQL sync + FailureEvent recording
│       │   ├── simplemdm.py    # SimpleMDM sync
│       │   ├── puppet.py       # Puppet inventory sync
│       │   ├── google_sheets.py
│       │   └── scheduler.py    # APScheduler
│       ├── config.py           # Settings (pydantic-settings, env vars)
│       ├── database.py         # SQLAlchemy engine + auto-migration (init_db)
│       ├── models.py           # Worker, Alert, SyncLog, FailureEvent
│       └── main.py             # FastAPI app, routers, lifespan
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── CommandPalette.tsx   # ⌘K search
│       │   ├── KeyboardShortcuts.tsx # ? overlay
│       │   ├── Layout.tsx           # Sidebar with Hangar wing logo
│       │   ├── ShellModal.tsx       # SSH terminal UI
│       │   └── VncModal.tsx
│       ├── pages/
│       │   ├── Overview.tsx         # Fleet summary — prod/staging pie charts, sync status, failure insights
│       │   ├── Pools.tsx            # Pool health — pinned cards with pending/utilization/job sources/top submitters, pool groups, branch modal
│       │   ├── Workers.tsx          # Worker list — quick pool filter buttons + pool dropdown + filters
│       │   ├── WorkerDetail.tsx     # Single worker detail
│       │   ├── Alerts.tsx
│       │   └── Consolidation.tsx
│       └── api.ts                   # Typed API client
├── terraform/                       # All GCP infra
├── cloudbuild.yaml                  # CI/CD
├── backend/Dockerfile               # Multi-stage: Node build → Python
├── hangar-brand-kit.html            # Brand reference — colors, logo SVG, typography
├── .env.example                     # Template for local dev
└── docker-compose.yml               # Local dev (postgres + backend)
```

---

## Local dev

```bash
cp .env.example .env          # fill in secrets
docker compose up -d db       # start postgres
cd frontend && npm install && npm run dev   # frontend on :5173 (proxies to :8000)
cd backend && uvicorn app.main:app --reload  # backend on :8000
```

---

## Database

Auto-migrated on startup via `init_db()` in `database.py`. Adds missing columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. No Alembic.

Tables: `workers`, `alerts`, `sync_log`, `failure_events`

---

## Worker pools monitored

20 macOS pools in `releng-hardware` provisioner, defined in `backend/app/sync/taskcluster.py::MAC_WORKER_POOLS`. Ranges from `gecko-t-osx-1400-r8` testers to `gecko-1-b-osx-1015` builders to `mozillavpn-b-*` etc.

---

## Branding

Brand kit is in `hangar-brand-kit.html`. The Tailwind config (`frontend/tailwind.config.js`) uses the Hangar palette for all `brand-*` tokens:

| Token | Color | Name |
|---|---|---|
| brand-900 | #042C53 | Midnight |
| brand-600 | #185FA5 | Primary |
| brand-500 | #378ADD | Sky |
| brand-300 | #85B7EB | Lift |
| brand-100 | #B5D4F4 | Haze |
| brand-50  | #E6F1FB | Cloud |

Fonts: **DM Sans** (UI) + **DM Mono** (pool names, hostnames, code). Wing SVG is in `Layout.tsx` sidebar header.

---

## What still needs doing

1. **DNS**: Point `hangar.relops.mozilla.com` → `34.54.129.77` (A record)
2. **Lock down ingress**: Change Cloud Run ingress back to `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` and remove `allUsers roles/run.invoker`
3. **SSH known_hosts secret**: Populate `hangar-ssh-known-hosts` with actual known_hosts content from MDC1 workers so the terminal feature works
4. **SSH dashboard key secret**: Add the `relops` user private key as a new secret + mount it so pool batch SSH (set/clear branch) works from Cloud Run
5. **Google Sheets integration**: Populate `hangar-google-sheets-id` and `hangar-google-credentials` secrets
6. **Terraform GCS backend**: Move `terraform.tfstate` from local to a GCS bucket
7. **IAP authorized members**: Review `iap_authorized_members` in `terraform/variables.tf` — should include the full team

---

## Key decisions made

- **Cloud Run min-instances=1**: Keeps APScheduler alive so background syncs run continuously
- **VPC Access Connector**: Cloud Run → Cloud SQL private IP (no public IP on DB)
- **Secrets as volume mounts** (not env vars): SSH keys at `/run/secrets/ssh/`, Google creds at `/run/secrets/google/`
- **IAP at load balancer level**: Cloud Run URL is technically accessible if you know it; real auth gate is the LB+IAP. Will be fixed when ingress is locked down.
- **Multi-stage Dockerfile**: Node builds the React SPA, Python serves it via FastAPI `StaticFiles`
- **Pool sources**: Live TC REST API query using `tags.project` + `tags.createdForUser` (more accurate than route parsing) — called per pinned pool when the Pools page loads
- **FailureEvents**: Detected in TC sync when `latestTask.run.state` transitions to `failed`/`exception` with a new task ID
- **Top Submitters**: Rendered in pinned pool cards from `by_user` in the `/fleet/pool-sources` response (strips email domain for display)
- **Original app source drift**: The original app at macmini-m4-117 has source files (Apr 10) that are newer than its built dist (Apr 9) — the running app may differ from what's on disk there

---

## Branch

All work is on `security_deploy`. Main branch has only the original code.
