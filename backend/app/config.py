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
    sync_interval_prune: int = 3600
    sync_interval_load: int = 300   # per-pool load time-series sampler

    # Alert thresholds
    tc_missing_threshold_hours: int = 24

    # Decommission cleanup: a worker is deleted once it is absent from Puppet, TC,
    # and SimpleMDM. The prune only runs if each of those sources has a successful
    # sync within this many hours, so a broken/slow sync can't trigger deletions.
    prune_source_freshness_hours: int = 6

    # Security
    # Comma-separated allowed CORS origins. Use "*" for local dev only.
    cors_origins: str = "*"

    # Reprovision action is gated to these emails (comma-separated, case-insensitive). The
    # panel is hidden and the endpoints 403 for anyone not listed. Start small; widen later.
    reprovision_authorized_users: str = (
        "rcurran@mozilla.com,aerickson@mozilla.com,jmoss@mozilla.com,jgibbs@mozilla.com,mcornmesser@mozilla.com"
    )

    # Shared secret the on-network reprovision runner presents (X-Reprovision-Runner-Token) to
    # claim jobs and post events. Empty (default) disables the runner endpoints — Phase 2.
    reprovision_runner_token: str = ""

    # Google IAP audience for verifying the signed identity assertion, of the form
    # "/projects/<PROJECT_NUMBER>/global/backendServices/<BACKEND_SERVICE_ID>".
    # When unset (local dev), identity falls back to the X-Goog-Authenticated-User-Email header.
    iap_audience: str = ""

    # Overview "your recent try pushes" rail derives the Treeherder author from the
    # IAP identity. Set this to a fixed mozilla.com address to force an author
    # instead — handy for local dev, where there's no IAP to assert one. The
    # "needinfos requested of you" rail reuses this same identity.
    try_author_override: str = ""

    # Bugzilla base URL for the Overview "needinfos requested of you" rail (keyless).
    bugzilla_url: str = "https://bugzilla.mozilla.org"

    # Logging: set LOG_JSON=true in production for Cloud Logging structured output.
    log_json: bool = False

    # Frontend static files directory (auto-detected; override if needed).
    static_dir: str = ""

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def reprovision_authorized_list(self) -> list[str]:
        return [u.strip().lower() for u in self.reprovision_authorized_users.split(",") if u.strip()]


settings = Settings()
