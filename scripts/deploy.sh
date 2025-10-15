#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Cloud Run deploy helper
#
# Usage:
#   1) Deploy code only (reuse existing secrets/config):
#        ./scripts/deploy.sh
#
#   2) Create/Update a Secret in Secret Manager, bind it, then deploy:
#        SECRET_KEY=SLACK_WEBHOOK_URL \
#        SECRET_VALUE="https://hooks.slack.com/services/xxx/yyy/zzz" \
#        ./scripts/deploy.sh
#
#   3) Use a specific service account (optional; defaults to project's compute SA):
#        SERVICE_ACCOUNT="my-run-sa@sales-ops-hub.iam.gserviceaccount.com" ./scripts/deploy.sh
#
# Prerequisites (first time only):
#   gcloud auth login
#   gcloud auth application-default login
# ==============================================================================

# --- Fixed values (do not change unless your env changes) ---
PROJECT_ID="sales-ops-hub"
REGION="asia-northeast1"
SERVICE_NAME="sales-ops-bot"

# --- Optional inputs (override via env when needed) ---
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"  # If empty, will be auto-detected
SECRET_KEY="${SECRET_KEY:-}"            # e.g. SLACK_WEBHOOK_URL
SECRET_VALUE="${SECRET_VALUE:-}"        # e.g. https://hooks.slack.com/...

echo ">> Project: $PROJECT_ID / Service: $SERVICE_NAME / Region: $REGION"
gcloud config set project "$PROJECT_ID" >/dev/null

# --- Secret upsert & IAM binding (only when SECRET_* is provided) ---
USE_SECRETS_FLAG=()
if [[ -n "$SECRET_KEY" && -n "$SECRET_VALUE" ]]; then
  echo ">> Upserting Secret: $SECRET_KEY"

  # Create the secret if it does not exist
  if ! gcloud secrets describe "$SECRET_KEY" >/dev/null 2>&1; then
    gcloud secrets create "$SECRET_KEY" --replication-policy=automatic
  fi

  # Add a new version from STDIN
  printf "%s" "$SECRET_VALUE" | gcloud secrets versions add "$SECRET_KEY" --data-file=-

  # Grant secret access to the Cloud Run runtime service account
  if [[ -z "$SERVICE_ACCOUNT" ]]; then
    PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
    SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
  fi

  gcloud secrets add-iam-policy-binding "$SECRET_KEY" \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null

  # Inject the latest secret version into the new revision
  USE_SECRETS_FLAG=(--set-secrets "${SECRET_KEY}=${SECRET_KEY}:latest")
fi

# --- Deploy to Cloud Run (Buildpacks; no Dockerfile required) ---
echo ">> Deploying to Cloud Run..."

if ((${#USE_SECRETS_FLAG[@]})); then
  gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --region "$REGION" \
    --allow-unauthenticated \
    "${USE_SECRETS_FLAG[@]}"
else
  gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --region "$REGION" \
    --allow-unauthenticated
fi

echo ">> Done. ✅"
