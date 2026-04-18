# Global static IP for the load balancer
resource "google_compute_global_address" "hangar" {
  name = "hangar-ip"
}

# Managed SSL certificate
resource "google_compute_managed_ssl_certificate" "hangar" {
  name = "hangar-cert"
  managed {
    domains = [var.domain]
  }
}

# Serverless NEG — maps the LB backend to the Cloud Run service
resource "google_compute_region_network_endpoint_group" "hangar" {
  name                  = "hangar-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region

  cloud_run {
    service = google_cloud_run_v2_service.hangar.name
  }
}

# Cloud Armor security policy (OWASP rules + rate limiting)
resource "google_compute_security_policy" "hangar" {
  name = "hangar-armor"

  # Rate limit: 100 requests/min per IP
  rule {
    action   = "throttle"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      rate_limit_threshold {
        count        = 100
        interval_sec = 60
      }
      enforce_on_key = "IP"
    }
    description = "Rate limit per IP"
  }

  # OWASP Top 10 pre-configured rules
  rule {
    action   = "deny(403)"
    priority = 2000
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('xss-v33-stable')"
      }
    }
    description = "Block XSS"
  }

  rule {
    action   = "deny(403)"
    priority = 2001
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('sqli-v33-stable')"
      }
    }
    description = "Block SQL injection"
  }

  rule {
    action   = "deny(403)"
    priority = 2002
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('rfi-v33-stable')"
      }
    }
    description = "Block remote file inclusion"
  }

  # Default: allow
  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow"
  }
}

# Backend service with IAP and Cloud Armor
resource "google_compute_backend_service" "hangar" {
  name                  = "hangar-backend"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  security_policy       = google_compute_security_policy.hangar.id

  backend {
    group = google_compute_region_network_endpoint_group.hangar.id
  }

  iap {
    oauth2_client_id     = var.iap_oauth2_client_id
    oauth2_client_secret = var.iap_oauth2_client_secret
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# URL map
resource "google_compute_url_map" "hangar" {
  name            = "hangar-url-map"
  default_service = google_compute_backend_service.hangar.id

  # Redirect HTTP → HTTPS
  # (handled via a separate URL map + HTTP proxy below)
}

# HTTPS proxy
resource "google_compute_target_https_proxy" "hangar" {
  name             = "hangar-https-proxy"
  url_map          = google_compute_url_map.hangar.id
  ssl_certificates = [google_compute_managed_ssl_certificate.hangar.id]
}

# Forwarding rule (HTTPS)
resource "google_compute_global_forwarding_rule" "hangar_https" {
  name                  = "hangar-https"
  target                = google_compute_target_https_proxy.hangar.id
  port_range            = "443"
  ip_address            = google_compute_global_address.hangar.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# HTTP → HTTPS redirect
resource "google_compute_url_map" "hangar_redirect" {
  name = "hangar-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "hangar_redirect" {
  name    = "hangar-http-proxy"
  url_map = google_compute_url_map.hangar_redirect.id
}

resource "google_compute_global_forwarding_rule" "hangar_http" {
  name                  = "hangar-http"
  target                = google_compute_target_http_proxy.hangar_redirect.id
  port_range            = "80"
  ip_address            = google_compute_global_address.hangar.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
