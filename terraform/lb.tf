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

# --- Reprovision runner: mTLS, non-IAP backend for /api/reprovision/runner/* ---
# The runner presents a step-ca client cert (validated at the proxy via the Trust Config in
# mtls.tf). IAP would block a cert-only request (no Google identity), so the runner path gets
# its own backend WITHOUT iap{}. Auth is the LB-validated cert + the app's SPIFFE-host allowlist
# (require_runner), and Cloud Armor caps the source range to the MDC1 runner.

resource "google_compute_security_policy" "hangar_runner" {
  name = "hangar-runner-armor"

  rule {
    action   = "allow"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = var.runner_source_cidrs
      }
    }
    description = "Allow the MDC1 runner source range"
  }

  rule {
    action   = "deny(403)"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default deny (runner path is source-restricted)"
  }
}

resource "google_compute_backend_service" "hangar_runner" {
  name                  = "hangar-runner-backend"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  security_policy       = google_compute_security_policy.hangar_runner.id

  backend {
    group = google_compute_region_network_endpoint_group.hangar.id
  }

  # No iap{} block: the runner authenticates by client cert, not a Google identity.
  # The LB injects these after validating the cert chain against the Trust Config.
  custom_request_headers = [
    "X-Client-Cert-Present: {client_cert_present}",
    "X-Client-Cert-Chain-Verified: {client_cert_chain_verified}",
    "X-Client-Cert-Error: {client_cert_error}",
    # GCP unreliably drops the parsed SPIFFE / URI-SAN fields; the app authorizes on the
    # Subject-DN CN (reliably forwarded; step-ca mints CN = hostname). SPIFFE/URI-SANs kept
    # for when they populate.
    "X-Client-Cert-SPIFFE: {client_cert_spiffe_id}",
    "X-Client-Cert-URI-SANs: {client_cert_uri_sans}",
    "X-Client-Cert-Subject-DN: {client_cert_subject_dn}",
    "X-Client-Cert-Serial-Number: {client_cert_serial_number}",
  ]

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# URL map — default (IAP) backend for the app; runner path → non-IAP mTLS backend.
resource "google_compute_url_map" "hangar" {
  name            = "hangar-url-map"
  default_service = google_compute_backend_service.hangar.id

  host_rule {
    hosts        = ["*"]
    path_matcher = "main"
  }

  path_matcher {
    name            = "main"
    default_service = google_compute_backend_service.hangar.id

    path_rule {
      paths   = ["/api/reprovision/runner", "/api/reprovision/runner/*"]
      service = google_compute_backend_service.hangar_runner.id
    }
  }
}

# HTTPS proxy — mTLS enabled (ALLOW_INVALID_OR_MISSING); cert is optional for browser/IAP
# traffic and required-by-the-app only on the runner path.
resource "google_compute_target_https_proxy" "hangar" {
  name              = "hangar-https-proxy"
  url_map           = google_compute_url_map.hangar.id
  ssl_certificates  = [google_compute_managed_ssl_certificate.hangar.id]
  server_tls_policy = google_network_security_server_tls_policy.runner.id
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
