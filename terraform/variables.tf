variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "relops-dashboard"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "domain" {
  description = "Public domain for the dashboard (e.g. hangar.relops.mozilla.com)"
  type        = string
}

variable "db_tier" {
  description = "Cloud SQL machine tier"
  type        = string
  default     = "db-g1-small"
}

variable "db_password" {
  description = "Password for the hangar Postgres user (stored in Secret Manager)"
  type        = string
  sensitive   = true
}

# IAP OAuth2 client — create manually in GCP Console → APIs & Services →
# Credentials → OAuth 2.0 Client ID (type: Web application). Set
# Authorized redirect URI to https://iap.googleapis.com/v1/oauth/clientIds/<client_id>:handleRedirect
variable "iap_oauth2_client_id" {
  description = "OAuth2 client ID for IAP"
  type        = string
}

variable "iap_oauth2_client_secret" {
  description = "OAuth2 client secret for IAP"
  type        = string
  sensitive   = true
}

variable "iap_authorized_members" {
  description = "IAM members allowed through IAP (e.g. [\"domain:mozilla.com\"])"
  type        = list(string)
  default     = ["domain:mozilla.com"]
}

variable "cloud_run_min_instances" {
  description = "Minimum Cloud Run instances (keep ≥1 so APScheduler stays alive)"
  type        = number
  default     = 1
}

variable "cloud_run_max_instances" {
  description = "Maximum Cloud Run instances"
  type        = number
  default     = 3
}

variable "cloud_run_image" {
  description = "Full Artifact Registry image reference for initial deploy"
  type        = string
  default     = ""
}

variable "runner_source_cidrs" {
  description = "Source IP ranges allowed to reach the mTLS /api/reprovision/runner/* path (MDC1 NAT)."
  type        = list(string)
  default     = ["63.245.209.101/32"]
}

variable "reprovision_runner_hosts" {
  description = "Comma-separated short hostnames allowed to act as the reprovision runner (cert SPIFFE host allowlist)."
  type        = string
  default     = "macmini-m4-81"
}

variable "iap_audience" {
  description = <<-EOT
    Google IAP audience used by the backend to verify per-user identity assertions.
    Default is this deployment's value; the `iap_audience` output recomputes it from the
    backend service as a cross-check. Kept as a var (not a direct reference) to avoid a
    Cloud Run <-> backend-service dependency cycle. Not a secret — just resource IDs.
  EOT
  type        = string
  default     = "/projects/488152629256/global/backendServices/8358478090234365077"
}
