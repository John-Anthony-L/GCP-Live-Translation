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
BUCKET_NAME="${GLOSSARY_BUCKET:-${PROJECT_ID}-glossaries}"
CONVERSATIONS_BUCKET="${CONVERSATIONS_BUCKET:-${PROJECT_ID}-conversations}"

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
    modelarmor.googleapis.com \
    firestore.googleapis.com \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    storage.googleapis.com \
    cloudbuild.googleapis.com

# 2b. Ensure Cloud Run runtime service account and Model Armor service agent have required IAM permissions
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' 2>/dev/null || true)"
if [ -n "${PROJECT_NUMBER}" ]; then
    RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
    MODEL_ARMOR_SA="service-${PROJECT_NUMBER}@gcp-sa-modelarmor.iam.gserviceaccount.com"
    gcloud beta services identity create --service=modelarmor.googleapis.com --project="${PROJECT_ID}" --quiet > /dev/null 2>&1 || true
    echo "🔐 Ensuring IAM roles on ${RUNTIME_SA} (Speech V2, Vertex AI, Translation v3, Storage, Cloud DLP, Model Armor, Firestore, Cloud Run Invoker)..."
    for ROLE in \
        roles/speech.client \
        roles/aiplatform.user \
        roles/cloudtranslate.admin \
        roles/storage.objectAdmin \
        roles/dlp.user \
        roles/dlp.reader \
        roles/modelarmor.user \
        roles/modelarmor.admin \
        roles/datastore.user \
        roles/run.invoker; do
        gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
            --member="serviceAccount:${RUNTIME_SA}" \
            --role="${ROLE}" \
            --condition=None \
            --quiet > /dev/null 2>&1 || true
    done
    for ROLE in roles/dlp.user roles/dlp.reader; do
        gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
            --member="serviceAccount:${MODEL_ARMOR_SA}" \
            --role="${ROLE}" \
            --condition=None \
            --quiet > /dev/null 2>&1 || true
    done
fi

# 2c. Ensure SDP Inspect/Deidentify templates and GCP Model Armor templates exist in ${REGION}
echo "🛡️ Ensuring GCP Model Armor & Cloud SDP templates in ${REGION}..."
ACCESS_TOKEN="$(gcloud auth print-access-token 2>/dev/null || true)"
if [ -n "${ACCESS_TOKEN}" ]; then
    curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "x-goog-user-project: ${PROJECT_ID}" \
        -d '{"templateId":"live-translation-inspect","inspectTemplate":{"displayName":"Live Translation SDP Inspect Template (Default)","inspectConfig":{"infoTypes":[{"name":"CREDIT_CARD_NUMBER"},{"name":"PHONE_NUMBER"},{"name":"EMAIL_ADDRESS"},{"name":"US_PASSPORT"}],"minLikelihood":"POSSIBLE","includeQuote":true}}}' \
        "https://dlp.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/inspectTemplates" > /dev/null 2>&1 || true

    curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "x-goog-user-project: ${PROJECT_ID}" \
        -d '{"templateId":"live-translation-inspect-coppa","inspectTemplate":{"displayName":"Live Translation SDP Inspect Template (COPPA + Names)","inspectConfig":{"infoTypes":[{"name":"CREDIT_CARD_NUMBER"},{"name":"PHONE_NUMBER"},{"name":"EMAIL_ADDRESS"},{"name":"PERSON_NAME"},{"name":"US_PASSPORT"}],"minLikelihood":"POSSIBLE","includeQuote":true}}}' \
        "https://dlp.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/inspectTemplates" > /dev/null 2>&1 || true

    curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "x-goog-user-project: ${PROJECT_ID}" \
        -d '{"templateId":"live-translation-deid","deidentifyTemplate":{"displayName":"Live Translation SDP Deidentify Template (Default)","deidentifyConfig":{"infoTypeTransformations":{"transformations":[{"infoTypes":[{"name":"CREDIT_CARD_NUMBER"}],"primitiveTransformation":{"replaceConfig":{"newValue":{"stringValue":"[CREDIT_CARD_REDACTED]"}}}},{"infoTypes":[{"name":"PHONE_NUMBER"}],"primitiveTransformation":{"replaceConfig":{"newValue":{"stringValue":"[PHONE_REDACTED]"}}}},{"infoTypes":[{"name":"EMAIL_ADDRESS"}],"primitiveTransformation":{"replaceConfig":{"newValue":{"stringValue":"[EMAIL_REDACTED]"}}}},{"infoTypes":[{"name":"US_PASSPORT"}],"primitiveTransformation":{"replaceConfig":{"newValue":{"stringValue":"[PASSPORT_REDACTED]"}}}}]}}}}' \
        "https://dlp.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/deidentifyTemplates" > /dev/null 2>&1 || true

    curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "x-goog-user-project: ${PROJECT_ID}" \
        -d '{"templateId":"live-translation-deid-coppa","deidentifyTemplate":{"displayName":"Live Translation SDP Deidentify Template (COPPA + Names)","deidentifyConfig":{"infoTypeTransformations":{"transformations":[{"infoTypes":[{"name":"CREDIT_CARD_NUMBER"}],"primitiveTransformation":{"replaceConfig":{"newValue":{"stringValue":"[CREDIT_CARD_REDACTED]"}}}},{"infoTypes":[{"name":"PHONE_NUMBER"}],"primitiveTransformation":{"replaceConfig":{"newValue":{"stringValue":"[PHONE_REDACTED]"}}}},{"infoTypes":[{"name":"EMAIL_ADDRESS"}],"primitiveTransformation":{"replaceConfig":{"newValue":{"stringValue":"[EMAIL_REDACTED]"}}}},{"infoTypes":[{"name":"PERSON_NAME"}],"primitiveTransformation":{"replaceConfig":{"newValue":{"stringValue":"[GUEST_NAME_REDACTED]"}}}},{"infoTypes":[{"name":"US_PASSPORT"}],"primitiveTransformation":{"replaceConfig":{"newValue":{"stringValue":"[PASSPORT_REDACTED]"}}}}]}}}}' \
        "https://dlp.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/deidentifyTemplates" > /dev/null 2>&1 || true

    curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "x-goog-user-project: ${PROJECT_ID}" \
        -d '{"filter_config":{"rai_settings":{"rai_filters":[{"filter_type":"HATE_SPEECH","confidence_level":"MEDIUM_AND_ABOVE"},{"filter_type":"HARASSMENT","confidence_level":"MEDIUM_AND_ABOVE"},{"filter_type":"DANGEROUS","confidence_level":"MEDIUM_AND_ABOVE"},{"filter_type":"SEXUALLY_EXPLICIT","confidence_level":"MEDIUM_AND_ABOVE"}]},"pi_and_jailbreak_filter_settings":{"filter_enforcement":"ENABLED","confidence_level":"LOW_AND_ABOVE"},"malicious_uri_filter_settings":{"filter_enforcement":"ENABLED"},"sdp_settings":{"advanced_config":{"inspect_template":"projects/'"${PROJECT_ID}"'/locations/'"${REGION}"'/inspectTemplates/live-translation-inspect","deidentify_template":"projects/'"${PROJECT_ID}"'/locations/'"${REGION}"'/deidentifyTemplates/live-translation-deid"}}},"template_metadata":{"enforcement_type":"INSPECT_AND_BLOCK","multi_language_detection":{"enable_multi_language_detection":true}}}' \
        "https://modelarmor.${REGION}.rep.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/templates?template_id=live-translation-armor" > /dev/null 2>&1 || true

    curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "x-goog-user-project: ${PROJECT_ID}" \
        -d '{"filter_config":{"rai_settings":{"rai_filters":[{"filter_type":"HATE_SPEECH","confidence_level":"MEDIUM_AND_ABOVE"},{"filter_type":"HARASSMENT","confidence_level":"MEDIUM_AND_ABOVE"},{"filter_type":"DANGEROUS","confidence_level":"MEDIUM_AND_ABOVE"},{"filter_type":"SEXUALLY_EXPLICIT","confidence_level":"MEDIUM_AND_ABOVE"}]},"pi_and_jailbreak_filter_settings":{"filter_enforcement":"ENABLED","confidence_level":"LOW_AND_ABOVE"},"malicious_uri_filter_settings":{"filter_enforcement":"ENABLED"},"sdp_settings":{"advanced_config":{"inspect_template":"projects/'"${PROJECT_ID}"'/locations/'"${REGION}"'/inspectTemplates/live-translation-inspect-coppa","deidentify_template":"projects/'"${PROJECT_ID}"'/locations/'"${REGION}"'/deidentifyTemplates/live-translation-deid-coppa"}}},"template_metadata":{"enforcement_type":"INSPECT_AND_BLOCK","multi_language_detection":{"enable_multi_language_detection":true}}}' \
        "https://modelarmor.${REGION}.rep.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/templates?template_id=live-translation-armor-coppa" > /dev/null 2>&1 || true
fi

# 3. Create GCS Glossary & Conversations Buckets & Upload Brand Glossary
echo ""
echo "📦 Step 2: Creating GCS Glossary & Conversations Buckets..."
if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" > /dev/null 2>&1; then
    gcloud storage buckets create "gs://${BUCKET_NAME}" --project="${PROJECT_ID}" --location="${REGION}"
fi
if ! gcloud storage buckets describe "gs://${CONVERSATIONS_BUCKET}" > /dev/null 2>&1; then
    gcloud storage buckets create "gs://${CONVERSATIONS_BUCKET}" --project="${PROJECT_ID}" --location="${REGION}"
fi

gcloud storage cp "glossaries/${CSV_FILE}" "gs://${BUCKET_NAME}/${CSV_FILE}"
echo "✅ Glossary uploaded to gs://${BUCKET_NAME}/${CSV_FILE}"
echo "✅ Conversations & Audio bucket ready at gs://${CONVERSATIONS_BUCKET}"

# 4. Deploy Service 1: Translation Pipeline (Python FastAPI: Chirp 3 V2 + Gemini 3.5/3.8 Live + GCP Model Armor & Cloud DLP + MT v3 + Chirp 3 HD TTS)
echo ""
echo "🚀 Step 3: Deploying Translation Pipeline to Cloud Run..."
gcloud run deploy live-translation-pipeline \
    --source services/translation-pipeline \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --quiet \
    --set-env-vars "PROJECT_ID=${PROJECT_ID},LOCATION=${REGION},CHIRP_REGION=${CHIRP_REGION:-us},GLOSSARY_ID=brand-parks-glossary-en-es,GLOSSARY_BUCKET=${BUCKET_NAME},CONVERSATIONS_BUCKET=${CONVERSATIONS_BUCKET},GEMINI_TRANSCRIBE_MODEL=${GEMINI_TRANSCRIBE_MODEL:-gemini-3.5-transcribe-live-preview},GEMINI_TRANSCRIBE_BATCH_MODEL=${GEMINI_TRANSCRIBE_BATCH_MODEL:-gemini-3.5-transcribe-preview},GEMINI_TRANSCRIBE_LOCATION=${GEMINI_TRANSCRIBE_LOCATION:-global},GEMINI_LIVE_TRANSLATE_MODEL=${GEMINI_LIVE_TRANSLATE_MODEL:-gemini-3.5-live-translate-preview},GEMINI_LIVE_TRANSLATE_LOCATION=${GEMINI_LIVE_TRANSLATE_LOCATION:-global},GEMINI_LIVE_MODEL=${GEMINI_LIVE_MODEL:-gemini-3.8-live},GEMINI_LIVE_LOCATION=${GEMINI_LIVE_LOCATION:-${REGION}},USE_MODEL_ARMOR=${USE_MODEL_ARMOR:-true},MODEL_ARMOR_LOCATION=${MODEL_ARMOR_LOCATION:-${REGION}},MODEL_ARMOR_TEMPLATE_ID=${MODEL_ARMOR_TEMPLATE_ID:-live-translation-armor},MODEL_ARMOR_COPPA_TEMPLATE_ID=${MODEL_ARMOR_COPPA_TEMPLATE_ID:-live-translation-armor-coppa}" \
    --timeout 3600 \
    --cpu 2 \
    --memory 2Gi

PIPELINE_URL=$(gcloud run services describe live-translation-pipeline --project "${PROJECT_ID}" --region "${REGION}" --format="value(status.url)")
echo "✅ Translation Pipeline URL: ${PIPELINE_URL}"

# 4b. Register Brand Glossary in Cloud Translation v3 (non-blocking if already registered)
echo "📖 Syncing Brand Glossary with Cloud Translation v3..."
ID_TOKEN="$(gcloud auth print-identity-token 2>/dev/null || true)"
if [ -n "${ID_TOKEN}" ]; then
    curl -s -X POST "${PIPELINE_URL}/api/glossary/sync" -H "Authorization: Bearer ${ID_TOKEN}" > /dev/null 2>&1 || true
else
    curl -s -X POST "${PIPELINE_URL}/api/glossary/sync" > /dev/null 2>&1 || true
fi
echo "✅ Brand Glossary registered."

# 5. Deploy Service 2: Web & Mobile Testbed Client
echo ""
echo "🚀 Step 4: Deploying Web & Mobile Testbed to Cloud Run..."
WS_PIPELINE_URL="${PIPELINE_URL/https:\/\//wss://}/ws/stream-translate"
gcloud run deploy live-web-client \
    --source services/web-client \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --quiet \
    --set-env-vars "TRANSLATION_PIPELINE_URL=${PIPELINE_URL},TRANSLATION_PIPELINE_WS_URL=${WS_PIPELINE_URL},CONVERSATIONS_BUCKET=${CONVERSATIONS_BUCKET}" \
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
