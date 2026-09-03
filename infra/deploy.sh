#!/usr/bin/env bash
set -e

# ==============================================================================
# Disney Parks Live Translation - GCP Cloud Run Multi-Container Deployer
# Target Project: disney-parks-live-translation
# Region: us-central1
# ==============================================================================

PROJECT_ID="${PROJECT_ID:-disney-parks-live-translation}"
REGION="${REGION:-us-central1}"
BUCKET_NAME="${PROJECT_ID}-glossaries"

echo "======================================================================"
echo "🏰 Deploying Disney Parks Live Translation POC to GCP Argolis"
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

# 3. Create GCS Glossary Bucket & Upload Disney Glossary
echo ""
echo "📦 Step 2: Creating GCS Glossary Bucket and Uploading Glossary..."
if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" > /dev/null 2>&1; then
    gcloud storage buckets create "gs://${BUCKET_NAME}" --project="${PROJECT_ID}" --location="${REGION}"
fi

gcloud storage cp glossaries/disney_glossary_en_es.csv "gs://${BUCKET_NAME}/disney_glossary_en_es.csv"
echo "✅ Glossary uploaded to gs://${BUCKET_NAME}/disney_glossary_en_es.csv"

# 4. Deploy Service 1: Gemini Live Proxy (Node.js WebSocket Gateway)
echo ""
echo "🚀 Step 3: Deploying Gemini Live Proxy to Cloud Run..."
gcloud run deploy disney-gemini-live-proxy \
    --source services/gemini-live-proxy \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --quiet \
    --set-env-vars "PROJECT_ID=${PROJECT_ID},LOCATION=${REGION},GEMINI_LIVE_MODEL=gemini-2.0-flash-exp,DEFAULT_VOICE=Aoede" \
    --session-affinity \
    --timeout 3600 \
    --cpu 2 \
    --memory 2Gi

PROXY_URL=$(gcloud run services describe disney-gemini-live-proxy --project "${PROJECT_ID}" --region "${REGION}" --format="value(status.url)")
echo "✅ Gemini Live Proxy URL: ${PROXY_URL}"

# 5. Deploy Service 2: Translation Pipeline (Python FastAPI: STT + MT v3 + TTS)
echo ""
echo "🚀 Step 4: Deploying Translation Pipeline to Cloud Run..."
gcloud run deploy disney-translation-pipeline \
    --source services/translation-pipeline \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --quiet \
    --set-env-vars "PROJECT_ID=${PROJECT_ID},LOCATION=${REGION},GLOSSARY_ID=disney-parks-glossary-en-es,GLOSSARY_BUCKET=${BUCKET_NAME}" \
    --timeout 3600 \
    --cpu 2 \
    --memory 2Gi

PIPELINE_URL=$(gcloud run services describe disney-translation-pipeline --project "${PROJECT_ID}" --region "${REGION}" --format="value(status.url)")
echo "✅ Translation Pipeline URL: ${PIPELINE_URL}"

# 6. Deploy Service 3: Web & Mobile Testbed Client
echo ""
echo "🚀 Step 5: Deploying Web & Mobile Testbed to Cloud Run..."
WS_PROXY_URL="${PROXY_URL/https:\/\//wss:\/\/}/live-translate"
gcloud run deploy disney-live-web-client \
    --source services/web-client \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --quiet \
    --set-env-vars "GEMINI_LIVE_PROXY_URL=${WS_PROXY_URL},TRANSLATION_PIPELINE_URL=${PIPELINE_URL}" \
    --cpu 1 \
    --memory 1Gi

CLIENT_URL=$(gcloud run services describe disney-live-web-client --project "${PROJECT_ID}" --region "${REGION}" --format="value(status.url)")

echo ""
echo "======================================================================"
echo "✨ DEPLOYMENT COMPLETE ✨"
echo "======================================================================"
echo "🏰 Web & Mobile Testbed:      ${CLIENT_URL}"
echo "⚡ Gemini Live Proxy (WS):     ${WS_PROXY_URL}"
echo "⚙️ Translation Pipeline (API):  ${PIPELINE_URL}"
echo "📱 iOS App Config: Point serverBaseUrl to ${WS_PROXY_URL}"
echo "======================================================================"
