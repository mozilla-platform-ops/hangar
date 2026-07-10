# Dedicated frontend for the on-network reprovision-runner + hangar-screen-agent.
#
# WHY THIS EXISTS: mTLS (server_tls_policy) can only be attached at the target-proxy level.
# On the single shared proxy that made the LB send a TLS CertificateRequest to EVERY client
# — including browsers, which on corp-managed laptops present the company TLS-inspection cert
# from the macOS keychain and then fail to load Hangar (fix was a per-user Firefox pref).
# Giving the runner its own hostname + proxy keeps mTLS OFF the human frontend entirely, so
# no browser ever gets a client-cert request.
#
# Same Cloud Run NEG/backend as the human path (google_compute_backend_service.hangar_runner);
# Cloud Armor still IP-locks it to the MDC1 egress, and the app's require_runner still enforces
# a valid client cert on the runner endpoints. Only the runner talks to this hostname.

resource "google_compute_global_address" "hangar_runner" {
  name = "hangar-runner-ip"
}

resource "google_compute_managed_ssl_certificate" "hangar_runner" {
  name = "hangar-runner-cert"
  managed {
    domains = [var.runner_domain]
  }
}

# Route ONLY the runner/screen mTLS endpoints to the non-IAP backend. Anything else on this
# hostname is redirected to the human (IAP) domain, so the non-IAP backend never serves the
# rest of the app without IAP — preserving the current posture (non-runner paths always go
# through IAP), on top of the Cloud Armor IP lock.
resource "google_compute_url_map" "hangar_runner" {
  name = "hangar-runner-url-map"

  default_url_redirect {
    host_redirect          = var.domain
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }

  host_rule {
    hosts        = ["*"]
    path_matcher = "runner"
  }

  path_matcher {
    name = "runner"

    default_url_redirect {
      host_redirect          = var.domain
      https_redirect         = true
      redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
      strip_query            = false
    }

    path_rule {
      paths   = ["/api/reprovision/runner", "/api/reprovision/runner/*"]
      service = google_compute_backend_service.hangar_runner.id
    }

    path_rule {
      paths   = ["/api/screen/agent", "/api/screen/agent/*"]
      service = google_compute_backend_service.hangar_runner.id
    }
  }
}

# mTLS lives HERE (moved off the human proxy). ALLOW_INVALID_OR_MISSING so the app enforces
# the cert per-path via require_runner; the LB validates the chain + injects X-Client-Cert-*.
resource "google_compute_target_https_proxy" "hangar_runner" {
  name              = "hangar-runner-https-proxy"
  url_map           = google_compute_url_map.hangar_runner.id
  ssl_certificates  = [google_compute_managed_ssl_certificate.hangar_runner.id]
  server_tls_policy = google_network_security_server_tls_policy.runner.id
}

resource "google_compute_global_forwarding_rule" "hangar_runner_https" {
  name                  = "hangar-runner-https"
  target                = google_compute_target_https_proxy.hangar_runner.id
  port_range            = "443"
  ip_address            = google_compute_global_address.hangar_runner.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
