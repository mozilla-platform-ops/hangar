"""RelOps Fleet Dashboard — FastAPI application."""
from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api.alerts import router as alerts_router
from .api.fleet import router as fleet_router
from .api.prs import router as prs_router
from .api.workers import router as workers_router
from .config import settings
from .database import init_db
from .sync.scheduler import run_all_sync, start_scheduler, stop_scheduler


def _configure_logging() -> None:
    if settings.log_json:
        try:
            from pythonjsonlogger import jsonlogger

            handler = logging.StreamHandler()
            handler.setFormatter(
                jsonlogger.JsonFormatter("%(asctime)s %(levelname)s %(name)s %(message)s")
            )
            logging.root.handlers = [handler]
            logging.root.setLevel(logging.INFO)
            return
        except ImportError:
            pass
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


_configure_logging()
log = logging.getLogger(__name__)


def _resolve_static_dir() -> Path:
    if settings.static_dir:
        return Path(settings.static_dir)
    # Works when run from repo root (local dev) or when STATIC_DIR is set (Docker).
    return Path(__file__).parent.parent.parent / "frontend" / "dist"


STATIC_DIR = _resolve_static_dir()


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Initialising database...")
    init_db()

    log.info("Starting background sync scheduler...")
    start_scheduler()

    # Kick off an immediate initial sync in a background thread
    thread = threading.Thread(target=run_all_sync, daemon=True)
    thread.start()

    yield

    stop_scheduler()


app = FastAPI(title="RelOps Fleet Dashboard", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
app.include_router(workers_router, prefix="/api")
app.include_router(fleet_router, prefix="/api")
app.include_router(alerts_router, prefix="/api")
app.include_router(prs_router, prefix="/api")


@app.post("/api/sync/run")
def trigger_sync() -> dict[str, Any]:
    """Manually trigger a full sync (runs in background thread)."""
    thread = threading.Thread(target=run_all_sync, daemon=True)
    thread.start()
    return {"status": "sync started"}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# Serve React SPA for all non-API routes (only when dist exists)
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str) -> FileResponse:
        index = STATIC_DIR / "index.html"
        return FileResponse(str(index))
