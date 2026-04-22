# CLAUDE.md

Hangar is the RelOps fleet dashboard — a FastAPI backend + React/TypeScript frontend aggregating data from Taskcluster, SimpleMDM, Puppet (GitHub), and Google Sheets.

Production URL: https://hangar.relops.mozilla.com (GCP Cloud Run, IAP-protected)

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
| API routes | `backend/app/api/{workers,fleet,pools,alerts,shell}.py` |
| Sync schedulers | `backend/app/sync/{taskcluster,simplemdm,puppet,google_sheets,scheduler}.py` |
| DB models | `backend/app/models.py` |
| Config/env | `backend/app/config.py` |
| Frontend pages | `frontend/src/pages/` |
| Frontend components | `frontend/src/components/` |
| API client | `frontend/src/api.ts` |
| Terraform | `terraform/` |

## Sync system

Background threads run on configurable intervals (env vars `SYNC_INTERVAL_*`). `scheduler.py` coordinates them; individual sync modules pull from external APIs and upsert into Postgres. A manual trigger is available at `POST /api/sync/run`.

## Environment / secrets

See `.env.example` for all variables. In production, secrets (API keys, `ssh_known_hosts`, DB password) are injected via GCP Secret Manager — see `terraform/secrets.tf`.

Local dev: set `SSH_INSECURE_SKIP_HOST_CHECK=true` to skip SSH host key checking for the worker terminal feature.

## Production deployment

Cloud Build handles deploys on push to `main`. To deploy manually:

```bash
gcloud builds triggers run <trigger-name> --branch=main
```

Terraform manages Cloud Run, Cloud SQL, IAP, Load Balancer, Artifact Registry. State is in `terraform/terraform.tfstate` (local, not remote — handle with care).

```bash
cd terraform
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```
