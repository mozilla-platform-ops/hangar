# CLAUDE.md

Hangar is the RelOps fleet dashboard — a FastAPI backend + React/TypeScript frontend aggregating data from Taskcluster, SimpleMDM, Puppet (GitHub), and Google Sheets to give visibility into the Mozilla macOS CI worker fleet (~400 Mac minis across MDC1).

Production URL: **https://hangar.relops.mozilla.com** (GCP Cloud Run, IAP-protected)

## Stack

- **Backend**: FastAPI, SQLAlchemy, PostgreSQL 16, Python 3.11+
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS
- **Infra**: GCP Cloud Run + Cloud SQL, provisioned via Terraform in `terraform/`
- **CI/CD**: Cloud Build (`cloudbuild.yaml`) — pushes to `main` trigger a build and deploy

## Local dev

```bash
cp .env.example .env          # fill in API keys
docker compose up -d db       # start postgres
cd frontend && npm install && npm run dev   # frontend on :5173, proxies API to :8000
# in another terminal:
docker compose up backend     # backend on :8000 with --reload
```

Frontend dev server proxies `/api/*` to `:8000` via `vite.config.ts`. No need to rebuild the frontend to iterate on the backend.

To run the full built app locally (mirrors prod):

```bash
cd frontend && npm run build
docker compose up
```

## Key file locations

| Area | Path |
|---|---|
| FastAPI app | `backend/app/main.py` |
| API routes | `backend/app/api/{workers,fleet,alerts,prs,reprovision}.py` |
| Sync schedulers | `backend/app/sync/{taskcluster,simplemdm,puppet,google_sheets,scheduler}.py` |
| DB models | `backend/app/models.py` |
| Config/env | `backend/app/config.py` |
| Reprovision allowlist | `backend/app/reprovision_access.py` (CODEOWNERS-gated) |
| Frontend pages | `frontend/src/pages/` |
| Frontend components | `frontend/src/components/` |
| API client | `frontend/src/api.ts` |
| Terraform | `terraform/` |

## Infrastructure (GCP)

Hangar runs in its own project, **`relops-dashboard`** (distinct from `relops-bootstrap`), `us-central1`.

| Resource | Value |
|---|---|
| Cloud Run service | `hangar` |
| Cloud Run direct URL | blocked — ingress is `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, so the direct URL 404s; all traffic goes through the LB |
| Load balancer IP | `34.54.129.77` (`hangar.relops.mozilla.com`) |
| Cloud SQL | `hangar-db` (Postgres 16, private IP via VPC connector, `ENCRYPTED_ONLY` SSL) |
| Artifact Registry | `us-central1-docker.pkg.dev/relops-dashboard/hangar` |
| IAP OAuth client id | `488152629256-83ivupuuj3gtrbl9s1minapsv9bq0td5.apps.googleusercontent.com` (client *secret* is not committed — see Secrets) |
| IAP service account | `service-488152629256@gcp-sa-iap.iam.gserviceaccount.com` |

**Auth**: Cloud IAP at the load balancer restricts access to `@mozilla.com` Google accounts (`iap_authorized_members` defaults to `["domain:mozilla.com"]`). All human auth happens upstream at the IAP LB before traffic reaches Cloud Run; no GCP access is required to use the app. The OAuth consent screen is **External** (the project isn't in Mozilla's Workspace org; the `domain:mozilla.com` restriction still enforces @mozilla.com-only).

**Invoker IAM**: `roles/run.invoker` is Terraform-managed via an authoritative `google_cloud_run_v2_service_iam_binding.hangar_invoker` (`iam.tf`) with the IAP service account as the only member (the previous stray `allUsers` grant was removed 2026-06-30).

## Terraform

State is **local** (`terraform/terraform.tfstate`); `terraform.tfvars` is gitignored. Both hold secrets (DB DSN, IAP secret) — handle with care. Moving state to a GCS backend is a known security follow-up.

```bash
gcloud auth application-default login
cd terraform
terraform plan     # uses terraform.tfvars automatically
terraform apply    # IAP OAuth creds must be passed at apply time (below)
```

- `iap_oauth2_client_id` / `iap_oauth2_client_secret` and `db_password` are passed via `-var` / `TF_VAR_*` at apply time (or in the gitignored tfvars), never committed.
- `run.tf` has `lifecycle { ignore_changes = [template[0].containers[0].image, ...] }` — **Terraform manages config, Cloud Build manages the running image**; they don't step on each other.
- Cloud SQL gotcha: `require_ssl=true` maps to `TRUSTED_CLIENT_CERTIFICATE_REQUIRED`; the instance uses `ssl_mode = "ENCRYPTED_ONLY"` instead.

Key files: `main.tf` (providers, VPC, VPC Access Connector), `run.tf` (Cloud Run + secret volume mounts), `sql.tf` (Cloud SQL), `lb.tf` (LB, IAP, Cloud Armor OWASP + rate limit, SSL cert), `iam.tf` (SAs + IAM), `secrets.tf` (Secret Manager), `variables.tf`.

## Secrets

`.env.example` lists all variables. In production, secrets are injected from **GCP Secret Manager** (project `relops-dashboard`) as volume mounts (not env vars); Google creds mount at `/run/secrets/google/`. See `terraform/secrets.tf`.

| Secret | Status |
|---|---|
| `hangar-db-url` | real (full Postgres DSN; password rotated off `placeholder` 2026-06-30, version 2) |
| `hangar-simplemdm-api-key` | real |
| `hangar-tc-client-id` / `hangar-tc-access-token` | placeholder (TC public GraphQL needs no auth) |
| `hangar-google-sheets-id` / `-export-sheet-id` / `-credentials-json` | placeholder (Sheets not yet configured) |

The **IAP OAuth client secret** and **db_password** are *not* in Secret Manager — they're Terraform `-var` inputs, and their values live in **1Password** (search "hangar IAP").

## CI/CD

`cloudbuild.yaml` at repo root builds the frontend → builds/pushes the Docker image to Artifact Registry → deploys to Cloud Run, on push to `main`.

```bash
# manual trigger
gcloud builds triggers run 534ffaaf-fd52-48fa-be26-fcb52b1bb905 --branch=main
# deploy a specific image directly (bypasses Cloud Build)
gcloud run services update hangar --region=us-central1 \
  --image=us-central1-docker.pkg.dev/relops-dashboard/hangar/backend:<sha>
```

## Sync system

Background threads run on configurable intervals (env vars `SYNC_INTERVAL_*`); `scheduler.py` coordinates them and individual sync modules pull from external APIs and upsert into Postgres. Manual trigger: `POST /api/sync/run`. Cloud Run runs `min-instances=1` so the scheduler stays alive for continuous syncs.

## Database

Auto-migrated on startup via `init_db()` in `database.py` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; no Alembic). Tables: `workers`, `alerts`, `sync_log`, `failure_events`.

## Worker pools

The macOS pools monitored live in `backend/app/sync/taskcluster.py::MAC_WORKER_POOLS` (`releng-hardware` provisioner).

## Reprovision action

`backend/app/api/reprovision.py` is the IAP-gated control surface for reprovisioning a worker (the destructive steps run in the on-VPN `reprovision` CLI / on-network runner — Hangar can't reach MDC1). Access is limited to the emails in `reprovision_access.py`, which is **CODEOWNERS-gated** (`.github/CODEOWNERS`) so the allowlist can't be widened without review.

## Key architectural decisions

- **IAP at the LB**: all auth happens at the load balancer before traffic reaches Cloud Run.
- **VPC Access Connector**: Cloud Run reaches Cloud SQL over private IP (no public IP on the DB).
- **Secrets as volume mounts**, not env vars.
- **`lifecycle { ignore_changes }` on the Cloud Run image**: Terraform owns config, Cloud Build owns the image.
- **Multi-stage Dockerfile**: Node builds the React SPA, Python serves it via FastAPI `StaticFiles`.
- **Responsive layout**: sidebar collapses to a hamburger drawer < 768px (logic in `Layout.tsx`).

## Branding

Brand kit in `hangar-brand-kit.html`. Tailwind uses `brand-*` tokens: `brand-900` #042C53 (Midnight), `brand-600` #185FA5 (Primary), `brand-500` #378ADD (Sky), `brand-300` #85B7EB (Lift), `brand-100` #B5D4F4 (Haze), `brand-50` #E6F1FB (Cloud). Fonts: **DM Sans** (UI) + **DM Mono** (pool names, hostnames, code).
