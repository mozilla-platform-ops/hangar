# Secret Manager secrets for Hangar.
# Terraform creates the secret containers. Populate values with:
#
#   echo -n "value" | gcloud secrets versions add hangar-<name> --data-file=-
#
# Or run terraform/scripts/populate_secrets.sh after first apply.

locals {
  secret_ids = [
    "hangar-db-url",
    "hangar-simplemdm-api-key",
    "hangar-tc-client-id",
    "hangar-tc-access-token",
    "hangar-google-credentials-json",
    "hangar-google-sheets-id",
    "hangar-google-export-sheet-id",
    "hangar-ssh-known-hosts",
  ]
}

resource "google_secret_manager_secret" "hangar" {
  for_each  = toset(local.secret_ids)
  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# Populate db-url from the Cloud SQL instance (convenience — avoids chicken-and-egg)
resource "google_secret_manager_secret_version" "db_url" {
  secret = google_secret_manager_secret.hangar["hangar-db-url"].id
  secret_data = (
    "postgresql://hangar:${var.db_password}@${google_sql_database_instance.hangar.private_ip_address}/relops"
    + "?sslmode=require"
  )
}
