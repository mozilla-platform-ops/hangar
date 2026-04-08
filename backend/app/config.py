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
    # TC client ID + access token are optional; unauthenticated works for public pools
    tc_client_id: str = ""
    tc_access_token: str = ""

    # Google Sheets
    google_sheets_id: str = ""           # read-only master inventory sheet
    google_export_sheet_id: str = ""     # dashboard-owned export sheet (written to)
    google_credentials_json: str = ""    # path to service account key JSON file

    # ronin_puppet repo
    puppet_repo_url: str = "https://github.com/mozilla-platform-ops/ronin_puppet"
    puppet_repo_path: str = "/tmp/ronin_puppet"

    # Sync intervals (seconds)
    sync_interval_tc: int = 300        # 5 min
    sync_interval_simplemdm: int = 900  # 15 min
    sync_interval_sheets: int = 1800   # 30 min
    sync_interval_puppet: int = 3600   # 60 min

    # Alert thresholds
    tc_missing_threshold_hours: int = 24  # flag worker if no TC activity for this long


settings = Settings()
