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
