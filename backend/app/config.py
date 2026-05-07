"""Application configuration via environment variables."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database
    database_url: str = "postgresql://relops:relops@localhost:5432/relops"

    # SimpleMDM
    simplemdm_api_key: str = ""

    # Taskcluster
    tc_root_url: str = "https://firefox-ci-tc.services.mozilla.com"
    tc_client_id: str = ""
    tc_access_token: str = ""

    # Google Sheets
    google_sheets_id: str = ""
    google_export_sheet_id: str = ""
    google_credentials_json: str = ""

    # ronin_puppet repo
    puppet_repo_url: str = "https://github.com/mozilla-platform-ops/ronin_puppet"
    puppet_repo_path: str = "/tmp/ronin_puppet"

    # worker-images repo — source for Windows NUC inventory (pools.yml).
    worker_images_repo_url: str = "https://github.com/mozilla-platform-ops/worker-images"
    worker_images_repo_path: str = "/tmp/worker-images"

    # GitHub (optional — increases rate limit from 60 to 5000 req/hr)
    github_token: str = ""

    # Sync intervals (seconds)
    sync_interval_tc: int = 300
    sync_interval_simplemdm: int = 900
    sync_interval_sheets: int = 1800
    sync_interval_puppet: int = 3600
    sync_interval_windows_inventory: int = 3600
    sync_interval_github_prs: int = 1800

    # Alert thresholds
    tc_missing_threshold_hours: int = 24

    # Security
    # Comma-separated allowed CORS origins. Use "*" for local dev only.
    cors_origins: str = "*"

    # Logging: set LOG_JSON=true in production for Cloud Logging structured output.
    log_json: bool = False

    # Frontend static files directory (auto-detected; override if needed).
    static_dir: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
