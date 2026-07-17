"""Application configuration via environment variables."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict

from .reprovision_access import REPROVISION_AUTHORIZED_USERS_DEFAULT


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

    # macOS VM image pipeline card (build → promote → rollout).
    # The on-network OCI registry serving the tester image (anon pull), the
    # GitHub repo whose Actions build it, and the image repository name.
    oci_registry_url: str = "http://10.49.56.161:5000"
    macos_vms_repo: str = "mozilla-platform-ops/macos-vms"
    oci_image_repo: str = "sequoia-tester"

    # Sync intervals (seconds)
    sync_interval_tc: int = 300
    sync_interval_simplemdm: int = 900
    sync_interval_sheets: int = 1800
    sync_interval_puppet: int = 3600
    sync_interval_windows_inventory: int = 3600
    sync_interval_github_prs: int = 1800
    sync_interval_prune: int = 3600
    sync_interval_load: int = 300   # per-pool load time-series sampler
    sync_interval_pool_sources_warm: int = 60   # background warm of per-pool job-source cache

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
    # panel is hidden and the endpoints 403 for anyone not listed. The default lives in
    # reprovision_access.py, which is CODEOWNERS-gated so the allowlist can't be widened
    # without review (adding an entry grants destructive wipe/rebuild of prod workers).
    reprovision_authorized_users: str = REPROVISION_AUTHORIZED_USERS_DEFAULT

    # The on-network reprovision runner authenticates one of two ways:
    #  1. mTLS (preferred): the forge-style LB validates its step-ca client cert against the
    #     Trust Config and forwards X-Client-Cert-* headers. We authorize on the cert's SPIFFE
    #     hostname being in this allowlist (comma-separated short hostnames, e.g. "macmini-m4-81").
    #  2. Shared token (local/dev or a non-mTLS ingress): X-Reprovision-Runner-Token.
    # Runner endpoints are disabled (503) until at least one of these is configured.
    reprovision_runner_hosts: str = ""
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

    @property
    def reprovision_runner_host_list(self) -> list[str]:
        return [h.strip().lower() for h in self.reprovision_runner_hosts.split(",") if h.strip()]


settings = Settings()
