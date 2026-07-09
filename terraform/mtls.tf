# LB-layer mTLS for the reprovision-runner path.
#
# Mirrors the forge / vault-broker setup (relops-bootstrap/terraform/mtls.tf). The on-network
# runner authenticates with a step-ca client cert; the LB validates the chain against the
# Trust Config and forwards X-Client-Cert-* headers to a NON-IAP backend that serves only
# /api/reprovision/runner/* (see lb.tf). The rest of Hangar keeps IAP.
#
# client_validation_mode = ALLOW_INVALID_OR_MISSING so the policy can attach to the single
# shared HTTPS proxy without requiring a client cert for normal (browser + IAP) traffic — the
# app decides per-path (require_runner enforces a valid cert on the runner endpoints).

resource "google_project_service" "networksecurity" {
  service            = "networksecurity.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "certificatemanager" {
  service            = "certificatemanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_certificate_manager_trust_config" "runner" {
  name        = "hangar-runner-trust-config"
  location    = "global"
  description = "step-ca root + intermediate for reprovision-runner client cert validation"

  trust_stores {
    trust_anchors {
      pem_certificate = file("${path.module}/trust/root.pem")
    }
    intermediate_cas {
      pem_certificate = file("${path.module}/trust/intermediate.pem")
    }
  }

  depends_on = [google_project_service.certificatemanager]
}

resource "google_network_security_server_tls_policy" "runner" {
  provider = google-beta
  name     = "hangar-runner-tls-policy"
  location = "global"

  mtls_policy {
    client_validation_mode = "ALLOW_INVALID_OR_MISSING_CLIENT_CERT"
    # Reference the trust config by project NUMBER — the API normalizes to that form and the
    # field is immutable, so the ID form would force delete+recreate on every plan.
    client_validation_trust_config = "projects/${data.google_project.project.number}/locations/global/trustConfigs/${google_certificate_manager_trust_config.runner.name}"
  }

  depends_on = [google_project_service.networksecurity]
}
