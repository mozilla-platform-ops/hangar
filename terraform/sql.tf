resource "google_sql_database_instance" "hangar" {
  name             = "hangar-db"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = "REGIONAL"

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.hangar.id
      enable_private_path_for_google_cloud_services = true
      require_ssl                                   = true
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "02:00"
      point_in_time_recovery_enabled = true
      backup_retention_settings {
        retained_backups = 7
      }
    }

    maintenance_window {
      day          = 7 # Sunday
      hour         = 3
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled = true
    }

    deletion_protection_enabled = true
  }

  depends_on = [google_service_networking_connection.sql_vpc_peering]
}

resource "google_sql_database" "relops" {
  name     = "relops"
  instance = google_sql_database_instance.hangar.name
}

resource "google_sql_user" "hangar" {
  name     = "hangar"
  instance = google_sql_database_instance.hangar.name
  password = var.db_password
}
