# Service account for the Cloud Run service
resource "google_service_account" "hangar_run" {
  account_id   = "hangar-run"
  display_name = "Hangar Cloud Run"
}

# Read all Hangar secrets
resource "google_secret_manager_secret_iam_binding" "run_secret_accessor" {
  for_each  = toset(local.secret_ids)
  secret_id = google_secret_manager_secret.hangar[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  members   = ["serviceAccount:${google_service_account.hangar_run.email}"]
}

# Connect to Cloud SQL
resource "google_project_iam_member" "run_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.hangar_run.email}"
}

# Write logs
resource "google_project_iam_member" "run_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.hangar_run.email}"
}

# Pull images from Artifact Registry
resource "google_artifact_registry_repository_iam_member" "run_ar_reader" {
  location   = var.region
  repository = google_artifact_registry_repository.hangar.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.hangar_run.email}"
}

# Service account for Cloud Build
resource "google_project_iam_member" "cloudbuild_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${data.google_project.project.number}@cloudbuild.gserviceaccount.com"
}

resource "google_project_iam_member" "cloudbuild_sa_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${data.google_project.project.number}@cloudbuild.gserviceaccount.com"
}

resource "google_project_iam_member" "cloudbuild_ar_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${data.google_project.project.number}@cloudbuild.gserviceaccount.com"
}

data "google_project" "project" {
  project_id = var.project_id
}

# IAP access — only @mozilla.com Google accounts
resource "google_iap_web_backend_service_iam_binding" "hangar_users" {
  web_backend_service = google_compute_backend_service.hangar.name
  role                = "roles/iap.httpsResourceAccessor"
  members             = var.iap_authorized_members
}
