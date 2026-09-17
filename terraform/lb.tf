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

  # Rate limiting. IAP already restricts this origin to @mozilla.com, so these
  # limits are DoS hygiene, not access control — sized to never deny a human.
  #
  # Two rules, because the app shell and the API have very different shapes and
  # very different failure modes:
  #
  #   - Denying an /api/* call degrades a card inside a loaded page, and the
  #     client retries it (frontend/src/api.ts).
  #   - Denying the document or a hashed asset replaces the whole dashboard with
  #     Cloud Armor's bare "429 Too Many Requests" page. That is what an operator
  #     actually reported, twice, on 2026-09-17 — the document was denied after a
  #     burst of API calls had already spent the budget.
  #
  # Sizing: one Pools page load was measured at ~100 requests, of which 49 were
  # two unbatched per-pool loops (now batched — see fleet.pool_sources_batch).
  # A heavy load is ~50 requests post-fix, so 1200/min is ~24 page loads per
  # minute per IP. That headroom matters because enforce_on_key = "IP" and corp
  # VPN/NAT means many operators can share one egress address and therefore one
  # budget — the reason this gets worse, not better, as the audience grows.
  #
  # NOTE: Cloud Armor enforces the FIRST matching rule and stops, and these two
  # rules between them match every request. That is why the WAF rules now sit
  # ABOVE them (700-702) rather than below — at 2000+ they were unreachable and
  # had never evaluated a single request since the policy was created.
  # ── OWASP preconfigured WAF (PREVIEW — logging only, not yet enforcing) ───────
  #
  # These were created at priority 2000-2002, below the rate-limit rules. Cloud
  # Armor stops at the first matching rule and the throttle rules match every
  # request, so these three never evaluated anything: LB logs showed every single
  # request, including a scanner walking /cgi-bin and /docSQL, reporting
  # enforcedSecurityPolicy priority 1000. They were dead config, not protection.
  #
  # Moving them above the throttles is what makes them run. They are deliberately
  # `preview = true` for now: a preview rule LOGS its match and evaluation
  # continues to the next rule, so the 429 ceilings below still apply and nothing
  # is denied. That is the point — preconfigured CRS rules false-positive on
  # ordinary traffic, and this dashboard has never had them in the request path,
  # so their real hit rate here is unknown rather than assumed to be zero.
  #
  # To measure what they WOULD have blocked (previewSecurityPolicy is only
  # populated by preview rules):
  #
  #   gcloud logging read \
  #     'resource.type="http_load_balancer" AND jsonPayload.previewSecurityPolicy.outcome="DENY"' \
  #     --project=relops-dashboard --freshness=7d --limit=200 \
  #     --format="value(httpRequest.remoteIp,httpRequest.requestUrl,jsonPayload.previewSecurityPolicy.priority)"
  #
  # Graduating to enforcement: run for at least a week of normal use, confirm
  # every DENY is a scanner and not an operator, then drop `preview = true` one
  # rule at a time — sqli last, it is the most false-positive-prone. If a rule
  # matches legitimate traffic, tune sensitivity or add a rule exclusion rather
  # than deleting it outright.
  rule {
    action   = "deny(403)"
    priority = 700
    preview  = true
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('xss-v33-stable')"
      }
    }
    description = "Block XSS (preview)"
  }

  rule {
    action   = "deny(403)"
    priority = 701
    preview  = true
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('sqli-v33-stable')"
      }
    }
    description = "Block SQL injection (preview)"
  }

  rule {
    action   = "deny(403)"
    priority = 702
    preview  = true
    match {
      expr {
        expression = "evaluatePreconfiguredExpr('rfi-v33-stable')"
      }
    }
    description = "Block remote file inclusion (preview)"
  }

  rule {
    action   = "throttle"
    priority = 900
    match {
      expr {
        expression = "request.path.startsWith('/api/')"
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      rate_limit_threshold {
        count        = 1200
        interval_sec = 60
      }
      enforce_on_key = "IP"
    }
    description = "Rate limit API calls per IP"
  }

  # Everything else: the document, hashed assets, favicon. Cheap and cacheable, so
  # the only client that reaches this ceiling is a scanner. Deliberately generous —
  # a human must never be shown a bare 429 instead of the dashboard.
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
        count        = 3000
        interval_sec = 60
      }
      enforce_on_key = "IP"
    }
    description = "Rate limit the app shell per IP (generous; scanner backstop)"
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

  # `enabled` became a required argument in provider 6.0 — before that, the mere
  # presence of an `iap` block implied it was on. It must stay `true`: IAP at the
  # LB is the only thing authenticating human traffic to the dashboard, so
  # flipping this to false would expose Hangar to the internet.
  iap {
    enabled              = true
    oauth2_client_id     = var.iap_oauth2_client_id
    oauth2_client_secret = var.iap_oauth2_client_secret
  }

  # SECURITY — clobber the client-cert headers on the human path. This proxy has NO
  # server_tls_policy (mTLS lives only on the runner proxy, lb_runner.tf), so a client
  # can supply its own X-Client-Cert-* headers and, because this backend previously set
  # none of its own, they passed through untouched to Cloud Run. Both backends share one
  # Cloud Run service, and the app's require_runner() (backend/app/api/reprovision.py)
  # trusts these headers regardless of which frontend served the request — so any
  # IAP-authenticated @mozilla.com user could forge `X-Client-Cert-Chain-Verified: true`
  # + a SPIFFE/DN naming an allowlisted host and be authorized as the on-network runner
  # (claim/complete reprovision jobs, forge the audit ledger, push screen frames + tart
  # health). CONFIRMED live 2026-09-14. Overwriting each header with the LB's own
  # client-cert variable — which resolves EMPTY on a proxy without mTLS — strips any
  # inbound value, so require_runner sees chain-verified != "true" and returns 401.
  # These names mirror the runner backend's custom_request_headers exactly.
  custom_request_headers = [
    "X-Client-Cert-Present: {client_cert_present}",
    "X-Client-Cert-Chain-Verified: {client_cert_chain_verified}",
    "X-Client-Cert-Error: {client_cert_error}",
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

  # The runner + screen-agent mTLS endpoints now live on their own frontend
  # (hangar_runner.*, see lb_runner.tf) so mTLS is never attached to this human proxy.
  # Everything on this hostname goes through IAP.
  path_matcher {
    name            = "main"
    default_service = google_compute_backend_service.hangar.id
  }
}

# HTTPS proxy — NO server_tls_policy: this human/browser frontend must NOT request a client
# cert (a client-cert request breaks Firefox on corp laptops that carry a TLS-inspection cert
# in the keychain). mTLS lives on the dedicated runner proxy in lb_runner.tf.
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
