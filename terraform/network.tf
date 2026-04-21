resource "google_compute_network" "hangar" {
  name                    = "hangar-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "hangar" {
  name          = "hangar-subnet"
  ip_cidr_range = "10.8.0.0/24"
  region        = var.region
  network       = google_compute_network.hangar.id
}

# Private services access range — used by Cloud SQL private IP
resource "google_compute_global_address" "sql_private_ip_range" {
  name          = "hangar-sql-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.hangar.id
}

resource "google_service_networking_connection" "sql_vpc_peering" {
  network                 = google_compute_network.hangar.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql_private_ip_range.name]
  depends_on              = [google_project_service.apis]
}

# Serverless VPC Access Connector — lets Cloud Run reach private IPs (Cloud SQL)
resource "google_vpc_access_connector" "hangar" {
  name          = "hangar-connector"
  region        = var.region
  network       = google_compute_network.hangar.name
  ip_cidr_range = "10.8.1.0/28"
  min_instances = 2
  max_instances = 3
  depends_on    = [google_project_service.apis]
}

# Firewall: allow health checks from GCP load balancer ranges
resource "google_compute_firewall" "allow_lb_health_checks" {
  name    = "hangar-allow-lb-health-checks"
  network = google_compute_network.hangar.name

  allow {
    protocol = "tcp"
    ports    = ["8000"]
  }

  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
  target_tags   = ["hangar-backend"]
}
