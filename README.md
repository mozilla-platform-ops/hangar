# Hangar

**The RelOps Fleet Dashboard** — one place to see everything, fix anything, and lose no more sleep over mystery workers.

Hangar pulls data from Taskcluster, SimpleMDM, Puppet, and Google Sheets and stitches it into a single live view of your entire test infrastructure. Pool health, hardware generations, task failures, quarantined machines, missing workers — all in one dark-themed dashboard with web SSH and VNC built right in. No more tab soup.

> Currently tracking Mozilla's CI fleet. Built to grow with the rest of the infrastructure.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript, Vite, Tailwind CSS, Recharts, TanStack Table |
| Backend | FastAPI (Python 3.11), SQLAlchemy 2, APScheduler |
| Database | PostgreSQL 16 |
| Infrastructure | Docker Compose |

---

## Quick Start

```bash
# 1. Configure environment
cp .env.example .env
# edit .env — see Environment Variables below

# 2. Start the database
docker compose up -d db

# 3. Build frontend
cd frontend && npm install && npm run build && cd ..

# 4. Start backend (serves built frontend at /)
docker compose up backend
```

Open `http://localhost:8000`.

### Frontend dev (hot reload)

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173 → proxies API to :8000
```

### Backend dev (no Docker)

```bash
cd backend
pip install -r requirements.txt
export DATABASE_URL=postgresql://relops:relops@localhost:5432/relops
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
# requires: docker compose up -d db
```

---

## Environment Variables

All variables are optional unless marked required.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://relops:relops@localhost:5432/relops` | **Required.** PostgreSQL DSN |
| `SIMPLEMDM_API_KEY` | — | SimpleMDM REST API key |
| `TC_ROOT_URL` | `https://firefox-ci-tc.services.mozilla.com` | Taskcluster root URL |
| `TC_CLIENT_ID` | — | TC client ID (public pools work unauthenticated) |
| `TC_ACCESS_TOKEN` | — | TC access token |
| `GOOGLE_SHEETS_ID` | — | Master inventory spreadsheet ID |
| `GOOGLE_EXPORT_SHEET_ID` | — | Export/dashboard spreadsheet ID |
| `GOOGLE_CREDENTIALS_JSON` | — | Path to service account JSON |
| `PUPPET_REPO_URL` | `https://github.com/mozilla-platform-ops/ronin_puppet` | Puppet repo |
| `PUPPET_REPO_PATH` | `/tmp/ronin_puppet` | Local clone location |
| `SYNC_INTERVAL_TC` | `300` | Taskcluster sync interval (seconds) |
| `SYNC_INTERVAL_SIMPLEMDM` | `900` | SimpleMDM sync interval |
| `SYNC_INTERVAL_SHEETS` | `1800` | Google Sheets sync interval |
| `SYNC_INTERVAL_PUPPET` | `3600` | Puppet sync interval |
| `TC_MISSING_THRESHOLD_HOURS` | `24` | Hours before raising a `missing_from_tc` alert |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   React SPA (Vite)                  │
│  Overview · Workers · Alerts · Pools · Consolidation│
│  WorkerDetail + web SSH (xterm.js) + VNC (noVNC)    │
└──────────────────────┬──────────────────────────────┘
                       │ REST / WebSocket
┌──────────────────────▼──────────────────────────────┐
│                  FastAPI backend                     │
│  /api/workers  /api/fleet  /api/alerts               │
│  /api/pools    /api/shell/{host}/ws                  │
│                                                     │
│  APScheduler ─── sync/taskcluster.py   (5 min)      │
│               ├── sync/simplemdm.py    (15 min)      │
│               ├── sync/google_sheets.py(30 min)      │
│               └── sync/puppet.py       (60 min)      │
└──────────────────────┬──────────────────────────────┘
                       │ SQLAlchemy
┌──────────────────────▼──────────────────────────────┐
│              PostgreSQL 16                          │
│  workers · alerts · sync_logs · failure_events      │
└─────────────────────────────────────────────────────┘
```

### Data sources

| Source | What it provides | Sync |
|---|---|---|
| **Taskcluster** | Worker state, quarantine status, last active, latest task | GraphQL + REST |
| **SimpleMDM** | MDM enrollment, OS version, serial number, custom attributes | REST (paginated) |
| **Puppet** | Worker role, pool assignment | Git clone of `ronin_puppet` |
| **Google Sheets** | Canonical state (production / loaner / defective / spare / staging), notes | Sheets API v4 |

---

## Pages

### Overview
Your morning briefing. Fleet-wide summary stats, sync health, top-10 failing machines and tests over the last 7 days, generation breakdown chart, workers-by-pool bar chart.

### Workers
The full roster. Filterable and sortable across generation, state, pool, and MDM/TC status. Search by hostname or serial number. Up to 2,000 rows.

### Worker Detail
Everything Hangar knows about a single worker — Puppet role, sheet state, MDM enrollment, TC history. Edit notes, pop open a terminal, or launch VNC without leaving the page.

### Alerts
The stuff that needs your attention. Types: `missing_from_tc`, `quarantined`, `mdm_unenrolled`, `pool_mismatch`. Add notes, acknowledge, resolve.

### Pool Health
Per-pool health scores, staleness breakdowns (active <24 h / 1–7 d / 7–30 d / 30 d+ / never seen), and job source distribution. Batch SSH operations: set/clear branch overrides, restart workers, run Puppet.

### Consolidation
Side-by-side hardware generation comparison — state breakdowns, inactive machines, and retirement candidates.

---

## Database Schema

```
workers          — one row per hostname, columns from all four sources
alerts           — active/resolved per-worker alerts
sync_logs        — audit trail for each sync run (source, duration, records updated, errors)
failure_events   — TC task failures indexed by hostname and task name
```

**Worker state precedence:** `sheet_state` (if set) → inferred from TC/Puppet membership → `unknown`

**Health score:** fraction of production workers that are MDM-enrolled, not quarantined, and active within 24 hours.

---

## API Reference

```
GET    /api/workers                      list + filter + search + sort
GET    /api/workers/{hostname}           full worker record
PATCH  /api/workers/{hostname}/notes     update dashboard notes
POST   /api/workers/{hostname}/clear-branch  SSH: clear branch override

GET    /api/fleet/summary               dashboard stats
GET    /api/fleet/pools                 per-pool health
GET    /api/fleet/pending-counts        TC pending tasks per pool
GET    /api/fleet/pool-sources          running task project breakdown
GET    /api/fleet/failures?days=7       top failing machines + tests
GET    /api/fleet/consolidation         hardware generation analysis

GET    /api/alerts                      list (filter: type, active_only)
PATCH  /api/alerts/{id}/acknowledge
PATCH  /api/alerts/{id}/resolve

POST   /api/pools/{pool}/set-branch     batch SSH: set branch override
POST   /api/pools/{pool}/clear-branches batch SSH: clear overrides
POST   /api/pools/{pool}/restart        batch SSH: restart workers

GET    /api/shell/{hostname}/ws         WebSocket SSH terminal
POST   /api/sync/run                    trigger manual sync
GET    /api/health                      liveness check
```

---

## Project Structure

```
hangar/
├── backend/
│   ├── app/
│   │   ├── main.py              FastAPI app, lifespan, route registration
│   │   ├── config.py            Pydantic Settings — all env vars
│   │   ├── database.py          SQLAlchemy engine + table init
│   │   ├── models.py            ORM models
│   │   ├── api/
│   │   │   ├── workers.py
│   │   │   ├── fleet.py
│   │   │   ├── alerts.py
│   │   │   ├── pools.py
│   │   │   └── shell.py         WebSocket SSH via asyncssh
│   │   └── sync/
│   │       ├── scheduler.py     APScheduler job registration
│   │       ├── taskcluster.py   GraphQL + REST sync, alert generation
│   │       ├── simplemdm.py     Paginated REST sync + custom attributes
│   │       ├── puppet.py        Git clone + inventory.d parse
│   │       └── google_sheets.py Sheets API v4 read
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx              React Router setup
│   │   ├── api.ts               Typed API client + all TS interfaces
│   │   ├── components/
│   │   │   ├── Layout.tsx       App shell (collapsible sidebar)
│   │   │   ├── CommandPalette.tsx  ⌘K quick search
│   │   │   ├── KeyboardShortcuts.tsx
│   │   │   ├── ShellModal.tsx   xterm.js SSH terminal
│   │   │   └── VncModal.tsx     noVNC remote desktop
│   │   └── pages/
│   │       ├── Overview.tsx
│   │       ├── Workers.tsx
│   │       ├── WorkerDetail.tsx
│   │       ├── Alerts.tsx
│   │       ├── Pools.tsx
│   │       └── Consolidation.tsx
│   ├── vite.config.ts           Dev proxy → :8000
│   └── package.json
└── docker-compose.yml           postgres + backend services
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `⌘ K` | Open command palette (jump to any worker) |
| `⌘ /` | Open keyboard shortcuts help |
| `Esc` | Close any modal |
