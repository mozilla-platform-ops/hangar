locals {
  image = (
    var.cloud_run_image != ""
    ? var.cloud_run_image
    : "us-docker.pkg.dev/cloudrun/container/hello"
  )
}

resource "google_cloud_run_v2_service" "hangar" {
  name     = "hangar"
  location = var.region

  # Only reachable via the load balancer — not directly from the internet
  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  template {
    service_account = google_service_account.hangar_run.email

    scaling {
      min_instance_count = var.cloud_run_min_instances
      max_instance_count = var.cloud_run_max_instances
    }

    vpc_access {
      connector = google_vpc_access_connector.hangar.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.image

      resources {
        limits = {
          cpu    = "1"
          memory = "768Mi"
        }
        cpu_idle = false # keep CPU allocated when min_instance_count > 0
      }

      # Database URL from Secret Manager
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.hangar["hangar-db-url"].secret_id
            version = "latest"
          }
        }
      }

      # SimpleMDM
      env {
        name = "SIMPLEMDM_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.hangar["hangar-simplemdm-api-key"].secret_id
            version = "latest"
          }
        }
      }

      # Taskcluster
      env {
        name  = "TC_ROOT_URL"
        value = "https://firefox-ci-tc.services.mozilla.com"
      }
      env {
        name = "TC_CLIENT_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.hangar["hangar-tc-client-id"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "TC_ACCESS_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.hangar["hangar-tc-access-token"].secret_id
            version = "latest"
          }
        }
      }

      # Google Sheets IDs (non-sensitive, but consistent with secret approach)
      env {
        name = "GOOGLE_SHEETS_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.hangar["hangar-google-sheets-id"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GOOGLE_EXPORT_SHEET_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.hangar["hangar-google-export-sheet-id"].secret_id
            version = "latest"
          }
        }
      }

      # Google service account key (path points to the secret volume mount below)
      env {
        name  = "GOOGLE_CREDENTIALS_JSON"
        value = "/run/secrets/google/credentials.json"
      }

      # SSH known_hosts path (points to the secret volume mount below)
      env {
        name  = "SSH_KNOWN_HOSTS_PATH"
        value = "/run/secrets/ssh/known_hosts"
      }

      # Production settings
      env {
        name  = "LOG_JSON"
        value = "true"
      }
      env {
        name  = "CORS_ORIGINS"
        value = "https://${var.domain}"
      }
      env {
        name  = "STATIC_DIR"
        value = "/app/frontend/dist"
      }

      # Secret volume mounts — mount_path is a directory; item path is the filename
      volume_mounts {
        name       = "ssh-known-hosts"
        mount_path = "/run/secrets/ssh"
      }
      volume_mounts {
        name       = "google-credentials"
        mount_path = "/run/secrets/google"
      }

      # Health probes are configured via Cloud Build after the real image is deployed.
      # Cloud Run uses default TCP health checking in the interim.
    }

    volumes {
      name = "ssh-known-hosts"
      secret {
        secret = google_secret_manager_secret.hangar["hangar-ssh-known-hosts"].secret_id
        items {
          version = "latest"
          path    = "known_hosts" # → /run/secrets/ssh/known_hosts
          mode    = 256           # 0400
        }
      }
    }

    volumes {
      name = "google-credentials"
      secret {
        secret = google_secret_manager_secret.hangar["hangar-google-credentials-json"].secret_id
        items {
          version = "latest"
          path    = "credentials.json" # → /run/secrets/google/credentials.json
          mode    = 256                # 0400
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.db_url,
    google_vpc_access_connector.hangar,
    google_project_service.apis,
  ]
}
