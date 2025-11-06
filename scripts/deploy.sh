#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Cloud Run deploy helper
#
# Usage:
#   1) Deploy code only (reuse existing secrets/config already bound on the
#      latest healthy revision). This script will *re-bind all required secrets*
#      explicitly on every deploy:
#        ./scripts/deploy.sh
#
#   2) Create/Update a Secret in Secret Manager, grant access to the Cloud Run
#      runtime service account, then deploy (the new secret will also be bound):
#        SECRET_KEY=SLACK_WEBHOOK_URL_SECOND \
#        SECRET_VALUE="https://hooks.slack.com/services/xxx/yyy/zzz" \
#        ./scripts/deploy.sh
#
#   3) Use a specific service account (optional; defaults to project's
#      Compute Engine default service account for secret access binding):
#        SERVICE_ACCOUNT="cloud-run-sa@sales-ops-hub.iam.gserviceaccount.com" \
#        ./scripts/deploy.sh
#
# Prerequisites (first time only):
#   gcloud auth login
#   gcloud auth application-default login
#   gcloud config set project <PROJECT_ID>   # (this script also does it)
# ==============================================================================

# ----------------------------
# Project / service parameters
# ----------------------------
PROJECT_ID="sales-ops-hub"
REGION="asia-northeast1"
SERVICE_NAME="sales-ops-bot"

# -----------------------------------
# Required secrets to bind each deploy
# (add a new key here when you add one)
# -----------------------------------
REQUIRED_SECRETS=(
  FIREBASE_PROJECT_ID
  GCP_PROJECT_ID
  GCP_LOCATION_ID
  GCP_TASKS_QUEUE
  CHATS_SPREADSHEET_ID
  SLACK_WEBHOOK_URL
  SLACK_WEBHOOK_URL_SECOND
  TELEGRAM_BOT_TOKEN
  TELEGRAM_WEBHOOK_SECRET
  MESSAGE_TTL_DAYS
  PUBLIC_BASE_URL
  VERTEX_API_KEY
)

# ---------------------------------------
# Optional inputs via environment variables
# ---------------------------------------
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"  # For granting Secret Manager access
SECRET_KEY="${SECRET_KEY:-}"            # e.g. SLACK_WEBHOOK_URL_SECOND
SECRET_VALUE="${SECRET_VALUE:-}"        # e.g. https://hooks.slack.com/...

# ---------------
# Helper functions
# ---------------
log()   { printf "\033[1;34m>> %s\033[0m\n" "$*"; }
warn()  { printf "\033[1;33m[warn] %s\033[0m\n" "$*"; }
error() { printf "\033[1;31m[error] %s\033[0m\n" "$*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || error "Required command not found: $1"
}

# --------------------
# Basic sanity checks
# --------------------
require_cmd gcloud
log "Project: ${PROJECT_ID} / Service: ${SERVICE_NAME} / Region: ${REGION}"
gcloud config set project "${PROJECT_ID}" >/dev/null

# ----------------------------------------------------------
# (Optional) Upsert a secret and grant read access to the SA
# ----------------------------------------------------------
if [[ -n "${SECRET_KEY}" && -n "${SECRET_VALUE}" ]]; then
  log "Upserting Secret Manager secret: ${SECRET_KEY}"

  # Create secret if it does not exist
  if ! gcloud secrets describe "${SECRET_KEY}" >/dev/null 2>&1; then
    gcloud secrets create "${SECRET_KEY}" --replication-policy=automatic
  fi

  # Add a new version from STDIN
  printf "%s" "${SECRET_VALUE}" | gcloud secrets versions add "${SECRET_KEY}" --data-file=-

  # Determine which service account to grant (if not provided)
  if [[ -z "${SERVICE_ACCOUNT}" ]]; then
    PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
    SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
    warn "SERVICE_ACCOUNT not specified. Using default: ${SERVICE_ACCOUNT}"
  fi

  # Grant Secret Manager access
  gcloud secrets add-iam-policy-binding "${SECRET_KEY}" \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null

  # Ensure the newly upserted key is in the binding list
  if [[ ! " ${REQUIRED_SECRETS[*]} " =~ " ${SECRET_KEY} " ]]; then
    REQUIRED_SECRETS+=("${SECRET_KEY}")
  fi
fi

# ---------------------------------------------------
# (Optional) Warn if any required secret is missing
# ---------------------------------------------------
for key in "${REQUIRED_SECRETS[@]}"; do
  if ! gcloud secrets describe "${key}" >/dev/null 2>&1; then
    warn "Required secret '${key}' not found in Secret Manager. Deploy will fail if the app expects it."
  fi
done

# ---------------------------------------------
# Build --set-secrets flags for ALL required keys
# ---------------------------------------------
SET_SECRETS_FLAGS=()
for key in "${REQUIRED_SECRETS[@]}"; do
  SET_SECRETS_FLAGS+=( --set-secrets "${key}=${key}:latest" )
done

# -----------------------
# Deploy to Cloud Run
# (Buildpacks; no Dockerfile required)
# -----------------------
log "Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --region "${REGION}" \
  --allow-unauthenticated \
  "${SET_SECRETS_FLAGS[@]}"

log "Done. ✅"
