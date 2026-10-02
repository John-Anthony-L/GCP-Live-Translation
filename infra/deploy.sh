#!/usr/bin/env bash
set -e

# ==============================================================================
# Enterprise Live Translation - GCP Cloud Run Multi-Container Deployer
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 1. Load .env file from root directory if present
if [ -f "${ROOT_DIR}/.env" ]; then
  echo "📄 Loading environment variables from ${ROOT_DIR}/.env..."
  set -a
  source "${ROOT_DIR}/.env"
  set +a
elif [ -f ".env" ]; then
  echo "📄 Loading environment variables from .env..."
  set -a
  source ".env"
  set +a
fi

PROJECT_ID="${PROJECT_ID:-${GOOGLE_CLOUD_PROJECT}}"

# Fallback to current gcloud CLI configuration if PROJECT_ID is empty or placeholder
if [ -z "${PROJECT_ID}" ] || [ "${PROJECT_ID}" = "your-gcp-project-id" ]; then
  GCLOUD_ACTIVE_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  if [ -n "${GCLOUD_ACTIVE_PROJECT}" ] && [ "${GCLOUD_ACTIVE_PROJECT}" != "(unset)" ]; then
    PROJECT_ID="${GCLOUD_ACTIVE_PROJECT}"
  fi
fi

if [ -z "${PROJECT_ID}" ] || [ "${PROJECT_ID}" = "your-gcp-project-id" ]; then
  echo "❌ ERROR: PROJECT_ID is not configured."
  echo "Please set PROJECT_ID in your .env file or export it in your shell:"
  echo "   PROJECT_ID=your-actual-project-id ./infra/deploy.sh"
  echo "or configure gcloud:"
  echo "   gcloud config set project <your-actual-project-id>"
  exit 1
fi

REGION="${REGION:-${LOCATION:-us-central1}}"
BUCKET_NAME="${PROJECT_ID}-glossaries"

CSV_FILE="brand_glossary_en_es.csv"

cd "${ROOT_DIR}"

echo "======================================================================"
echo "🌐 Deploying Enterprise Live Translation POC to Google Cloud Run"
echo "Project ID: ${PROJECT_ID}"
echo "Region:     ${REGION}"
echo "======================================================================"

# 1. Set Active GCP Project
gcloud config set project "${PROJECT_ID}"

# 2. Enable Required Google Cloud APIs
echo ""
echo "🔧 Step 1: Enabling Required Google Cloud APIs..."
gcloud services enable \
    aiplatform.googleapis.com \
    translate.googleapis.com \
    speech.googleapis.com \
    texttospeech.googleapis.com \
    dlp.googleapis.com \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    storage.googleapis.com \
    cloudbuild.googleapis.com

# 2b. Ensure Cloud Run runtime service account has Speech V2, Vertex AI, Translation, and DLP permissions
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' 2>/dev/null || true)"
if [ -n "${PROJECT_NUMBER}" ]; then
    RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
    echo "🔐 Ensuring IAM roles on ${RUNTIME_SA} (Speech V2, Vertex AI, Translation v3, Cloud DLP)..."
    for ROLE in roles/speech.client roles/aiplatform.user roles/cloudtranslate.user roles/dlp.user roles/run.invoker; do
        gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
            --member="serviceAccount:${RUNTIME_SA}" \
            --role="${ROLE}" \
            --Condition=None \
            --quiet > /dev/null 2>&1 || true
    done
fi

# 3. Create GCS Glossary Bucket & Upload Brand Glossary
echo ""
echo "📦 Step 2: Creating GCS Glossary Bucket and Uploading Glossary..."
if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" > /dev/null 2>&1; then
    gcloud storage buckets create "gs://${BUCKET_NAME}" --project="${PROJECT_ID}" --location="${REGION}"
fi

gcloud storage cp "glossaries/${CSV_FILE}" "gs://${BUCKET_NAME}/${CSV_FILE}"
echo "✅ Glossary uploaded to gs://${BUCKET_NAME}/${CSV_FILE}"

# 4. Deploy Service 1: Translation Pipeline (Python FastAPI: Chirp 3 V2 + Gemini 3.5/3.8 Live + Cloud DLP + MT v3 + Chirp 3 HD TTS)
echo ""
echo "🚀 Step 3: Deploying Translation Pipeline to Cloud Run..."
gcloud run deploy live-translation-pipeline \
    --source services/translation-pipeline \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --quiet \
    --set-env-vars "PROJECT_ID=${PROJECT_ID},LOCATION=${REGION},CHIRP_REGION=${CHIRP_REGION:-us},GLOSSARY_ID=brand-parks-glossary-en-es,GLOSSARY_BUCKET=${BUCKET_NAME},GEMINI_TRANSCRIBE_MODEL=${GEMINI_TRANSCRIBE_MODEL:-gemini-3.5-transcribe-live-preview},GEMINI_TRANSCRIBE_LOCATION=${GEMINI_TRANSCRIBE_LOCATION:-global},GEMINI_LIVE_TRANSLATE_MODEL=${GEMINI_LIVE_TRANSLATE_MODEL:-gemini-3.5-live-translate-preview},GEMINI_LIVE_TRANSLATE_LOCATION=${GEMINI_LIVE_TRANSLATE_LOCATION:-global},GEMINI_LIVE_MODEL=${GEMINI_LIVE_MODEL:-gemini-3.8-live},GEMINI_LIVE_LOCATION=${GEMINI_LIVE_LOCATION:-${REGION}}" \
    --timeout 3600 \
    --cpu 2 \
    --memory 2Gi

PIPELINE_URL=$(gcloud run services describe live-translation-pipeline --project "${PROJECT_ID}" --region "${REGION}" --format="value(status.url)")
echo "✅ Translation Pipeline URL: ${PIPELINE_URL}"

# 5. Deploy Service 2: Web & Mobile Testbed Client
echo ""
echo "🚀 Step 4: Deploying Web & Mobile Testbed to Cloud Run..."
WS_PIPELINE_URL="${PIPELINE_URL/https:\/\//wss:\/\/}/ws/stream-translate"
gcloud run deploy live-web-client \
    --source services/web-client \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --quiet \
    --set-env-vars "TRANSLATION_PIPELINE_URL=${PIPELINE_URL},TRANSLATION_PIPELINE_WS_URL=${WS_PIPELINE_URL}" \
    --cpu 1 \
    --memory 1Gi

CLIENT_URL=$(gcloud run services describe live-web-client --project "${PROJECT_ID}" --region "${REGION}" --format="value(status.url)")

echo ""
echo "======================================================================"
echo "✨ DEPLOYMENT COMPLETE ✨"
echo "======================================================================"
echo "🌐 Web & Mobile Testbed:        ${CLIENT_URL}"
echo "⚙️ Translation Pipeline (API):   ${PIPELINE_URL}"
echo "⚡ Pipeline WebSocket:           ${WS_PIPELINE_URL}"
echo "======================================================================"
