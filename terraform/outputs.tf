output "load_balancer_ip" {
  description = "Point your DNS A record here: hangar.relops.mozilla.com → this IP"
  value       = google_compute_global_address.hangar.address
}

output "artifact_registry_hostname" {
  description = "Docker registry hostname for image pushes"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/hangar"
}

output "cloud_run_url" {
  description = "Direct Cloud Run URL (bypasses IAP — for health checks only)"
  value       = google_cloud_run_v2_service.hangar.uri
}

output "db_private_ip" {
  description = "Cloud SQL private IP (reachable only from the VPC)"
  value       = google_sql_database_instance.hangar.private_ip_address
  sensitive   = true
}

output "populate_secrets_commands" {
  description = "Run these after first apply to populate secret values"
  value       = <<-EOT
    # SimpleMDM API key:
    echo -n "YOUR_KEY" | gcloud secrets versions add hangar-simplemdm-api-key --data-file=-

    # Taskcluster credentials:
    echo -n "YOUR_TC_CLIENT_ID" | gcloud secrets versions add hangar-tc-client-id --data-file=-
    echo -n "YOUR_TC_ACCESS_TOKEN" | gcloud secrets versions add hangar-tc-access-token --data-file=-

    # Google Sheets IDs:
    echo -n "YOUR_SHEET_ID" | gcloud secrets versions add hangar-google-sheets-id --data-file=-
    echo -n "YOUR_EXPORT_SHEET_ID" | gcloud secrets versions add hangar-google-export-sheet-id --data-file=-

    # Google service account key JSON:
    gcloud secrets versions add hangar-google-credentials-json --data-file=credentials.json
  EOT
}
