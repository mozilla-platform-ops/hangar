# Hangar — Claude Handoff Document

Share this file at the start of a new session to restore full context.

---

## What this project is

**Hangar** is the RelOps Fleet Dashboard — a FastAPI + React SPA that aggregates data from Taskcluster, SimpleMDM, Puppet, and Google Sheets to give visibility into the Mozilla macOS CI worker fleet (~400 mac minis across MDC1).

Production URL: **https://hangar.relops.mozilla.com**

---

## GCP Infrastructure

| Resource | Value |
|---|---|
| GCP Project | `relops-dashboard` |
| Region | `us-central1` |
| Cloud Run service | `hangar` |
| Cloud Run direct URL | `https://hangar-vyqzdo4yva-uc.a.run.app` (blocked — LB only) |
| Load balancer IP | `34.54.129.77` |
| Target DNS | `hangar.relops.mozilla.com → 34.54.129.77` ✅ |
| Cloud SQL instance | `hangar-db` (Postgres 16, private IP, `ENCRYPTED_ONLY` SSL) |
| Artifact Registry | `us-central1-docker.pkg.dev/relops-dashboard/hangar` |
| IAP OAuth client | `488152629256-83ivupuuj3gtrbl9s1minapsv9bq0td5.apps.googleusercontent.com` |
| IAP service account | `service-488152629256@gcp-sa-iap.iam.gserviceaccount.com` |
| Cloud Build trigger | Watches `main` branch (`hangar-security-deploy` trigger, renamed but not yet renamed) |
| Terraform state | Local `terraform/terraform.tfvars` + `terraform.tfstate` (gitignored) |

**Ingress**: `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` — direct Cloud Run URL returns 404. All traffic must go through the load balancer.

**Auth**: Cloud IAP restricts access to `@mozilla.com` Google accounts (via `domain:mozilla.com` in `iap_authorized_members`). No GCP access required. OAuth consent screen is set to **External**.

**Note**: `allUsers roles/run.invoker` is still present on the Cloud Run IAM policy. This is harmless because the ingress is LB-only, but it should be cleaned up via Terraform.

---

## Terraform

State is local. `terraform.tfvars` is gitignored and lives at `terraform/terraform.tfvars`.

```bash
# Auth
gcloud auth application-default login

cd terraform
terraform plan   # uses terraform.tfvars automatically
terraform apply
```

Current `terraform.tfvars` contains:
```hcl
project_id      = "relops-dashboard"
region          = "us-central1"
db_password     = "placeholder"
domain          = "hangar.relops.mozilla.com"
cloud_run_image = "us-central1-docker.pkg.dev/relops-dashboard/hangar/backend:<latest-sha>"
```

`iap_oauth2_client_id` and `iap_oauth2_client_secret` must be passed via `-var` flag (not stored in tfvars).

**Important**: `run.tf` has `lifecycle { ignore_changes = [template[0].containers[0].image, ...] }` so Terraform never touches the running image. Cloud Build owns image updates.

Key files:
- `terraform/main.tf` — providers, project services, VPC, VPC Access Connector
- `terraform/run.tf` — Cloud Run service definition, secrets volume mounts
- `terraform/sql.tf` — Cloud SQL Postgres 16
- `terraform/lb.tf` — Global LB, IAP, Cloud Armor (OWASP rules + rate limit), SSL cert
- `terraform/iam.tf` — Service accounts and IAM bindings
- `terraform/secrets.tf` — Secret Manager secrets
- `terraform/variables.tf` — All configurable vars

**Known Terraform issue**: `require_ssl=true` maps to `TRUSTED_CLIENT_CERTIFICATE_REQUIRED` in Cloud SQL. DB was patched via `gcloud sql instances patch hangar-db --ssl-mode=ENCRYPTED_ONLY`. The `sql.tf` already has `ssl_mode = "ENCRYPTED_ONLY"`.

---

## CI/CD

`cloudbuild.yaml` at repo root. Triggers on push to `main` (trigger ID `534ffaaf-fd52-48fa-be26-fcb52b1bb905`, named `hangar-security-deploy` — name is stale but functional).

Steps: build frontend → build+push Docker image to Artifact Registry → deploy to Cloud Run.

To trigger manually:
```bash
gcloud builds triggers run 534ffaaf-fd52-48fa-be26-fcb52b1bb905 --branch=main
```

To deploy a specific image directly (bypasses Cloud Build):
```bash
gcloud run services update hangar \
  --region=us-central1 \
  --image=us-central1-docker.pkg.dev/relops-dashboard/hangar/backend:<sha>
```

---

## Secrets in Secret Manager

All under project `relops-dashboard`:

| Secret name | Status | Notes |
|---|---|---|
| `hangar-db-url` | ✅ real | Full Postgres DSN including password (`placeholder`) |
| `hangar-simplemdm-api-key` | ✅ real | SimpleMDM key |
| `hangar-iap-client-secret` | ✅ real | IAP OAuth secret |
| `hangar-tc-client-id` | placeholder | TC doesn't need auth for public GraphQL |
| `hangar-tc-access-token` | placeholder | Same |
| `hangar-google-sheets-id` | placeholder | Not yet configured |
| `hangar-google-export-sheet-id` | placeholder | Not yet configured |
| `hangar-google-credentials-json` | placeholder | Not yet configured |

---

## IAP Setup (completed steps)

1. OAuth consent screen changed from **Internal** to **External** (GCP Console → APIs & Services → OAuth consent screen)
2. IAP service account provisioned: `gcloud beta services identity create --service=iap.googleapis.com --project=relops-dashboard`
3. IAP service account granted Cloud Run invoker: `gcloud run services add-iam-policy-binding hangar --member="serviceAccount:service-488152629256@gcp-sa-iap.iam.gserviceaccount.com" --role="roles/run.invoker"`
4. IAP OAuth credentials added to backend service via Terraform
5. `iap_authorized_members` defaults to `["domain:mozilla.com"]` in `variables.tf`

These IAP service account steps are not yet in Terraform — should be added to `iam.tf`.

---

## Teardown

**Quick (stop service, keep resources):**
```bash
gcloud run services delete hangar --region=us-central1 --project=relops-dashboard
```

**Full teardown (destroy everything Terraform manages):**
```bash
cd terraform && terraform destroy \
  -var="iap_oauth2_client_id=<id>" \
  -var="iap_oauth2_client_secret=<secret>"
```

**Nuclear (delete entire GCP project — 30-day grace period):**
```bash
gcloud projects delete relops-dashboard
```

---

## What still needs doing

1. **Remove `allUsers` invoker**: Clean up Cloud Run IAM to remove `allUsers roles/run.invoker` via Terraform
2. **Terraform IAP service account**: Add `gcloud beta services identity create` and the IAP invoker binding to `iam.tf`
3. **Rename Cloud Build trigger**: `hangar-security-deploy` → `hangar-main` for clarity
4. **Google Sheets integration**: Populate `hangar-google-sheets-id`, `hangar-google-export-sheet-id`, and `hangar-google-credentials-json` secrets
5. **Terraform GCS backend**: Move `terraform.tfstate` from local to a GCS bucket
6. **DB password**: Change from `placeholder` to something real

---

## Key decisions made

- **Cloud Run min-instances=1**: Keeps APScheduler alive so background syncs run continuously
- **VPC Access Connector**: Cloud Run → Cloud SQL private IP (no public IP on DB)
- **Secrets as volume mounts** (not env vars): Google creds at `/run/secrets/google/`
- **IAP at load balancer level**: All auth happens at the LB before traffic reaches Cloud Run
- **`lifecycle { ignore_changes }` on Cloud Run image**: Terraform manages config, Cloud Build manages the image — they don't step on each other
- **Multi-stage Dockerfile**: Node builds the React SPA, Python serves it via FastAPI `StaticFiles`
- **Mobile responsive layout**: Sidebar collapses to a hamburger drawer on screens < 768px. Desktop layout unchanged. All logic in `Layout.tsx`.
- **OAuth consent screen External**: Required because the GCP project is not in Mozilla's Google Workspace org. IAP `domain:mozilla.com` restriction still enforces @mozilla.com-only access.

---

## Repo structure

```
hangar/
├── backend/
│   └── app/
│       ├── api/
│       │   ├── alerts.py
│       │   ├── fleet.py        # /fleet/* (summary, pools, pending-counts, pool-sources, failures, consolidation)
│       │   ├── prs.py          # ronin_puppet PR queue + voting
│       │   └── workers.py
│       ├── sync/
│       │   ├── taskcluster.py
│       │   ├── simplemdm.py
│       │   ├── puppet.py
│       │   ├── google_sheets.py
│       │   └── scheduler.py
│       ├── config.py
│       ├── database.py
│       ├── models.py
│       └── main.py
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── Layout.tsx           # Sidebar + mobile hamburger drawer
│       │   ├── CommandPalette.tsx   # ⌘K search
│       │   └── KeyboardShortcuts.tsx
│       ├── pages/
│       │   ├── Overview.tsx
│       │   ├── Pools.tsx
│       │   ├── Workers.tsx
│       │   ├── WorkerDetail.tsx
│       │   ├── Alerts.tsx
│       │   └── Consolidation.tsx
│       └── api.ts
├── terraform/
├── cloudbuild.yaml
├── docker-compose.yml
└── .env.example
```

---

## Local dev

```bash
cp .env.example .env
docker compose up -d db
cd frontend && npm install && npm run dev   # :5173 proxies to :8000
cd backend && uvicorn app.main:app --reload  # :8000
```

---

## Database

Auto-migrated on startup via `init_db()` in `database.py`. Adds missing columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. No Alembic.

Tables: `workers`, `alerts`, `sync_log`, `failure_events`

---

## Worker pools monitored

20 macOS pools in `releng-hardware` provisioner, defined in `backend/app/sync/taskcluster.py::MAC_WORKER_POOLS`.

---

## Branding

Brand kit in `hangar-brand-kit.html`. Tailwind config uses `brand-*` tokens:

| Token | Color | Name |
|---|---|---|
| brand-900 | #042C53 | Midnight |
| brand-600 | #185FA5 | Primary |
| brand-500 | #378ADD | Sky |
| brand-300 | #85B7EB | Lift |
| brand-100 | #B5D4F4 | Haze |
| brand-50  | #E6F1FB | Cloud |

Fonts: **DM Sans** (UI) + **DM Mono** (pool names, hostnames, code).
