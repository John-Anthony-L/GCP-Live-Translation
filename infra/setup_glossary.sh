#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load .env file from root directory if present
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
  echo "   PROJECT_ID=your-actual-project-id ./infra/setup_glossary.sh"
  exit 1
fi

cd "${ROOT_DIR}"

LOCATION="${LOCATION:-us-central1}"
GLOSSARY_ID="${GLOSSARY_ID:-brand-parks-glossary-en-es}"
BUCKET_NAME="${PROJECT_ID}-glossaries"

CSV_FILE="brand_glossary_en_es.csv"
if [ ! -f "glossaries/${CSV_FILE}" ]; then
  CSV_FILE="disney_glossary_en_es.csv"
fi

echo "Configuring Cloud Translation API Advanced Glossary: ${GLOSSARY_ID}..."

# Upload CSV to GCS using gcloud storage
gcloud storage cp "glossaries/${CSV_FILE}" "gs://${BUCKET_NAME}/${CSV_FILE}"

# Call GCP Translation API v3 to register glossary
TOKEN=$(gcloud auth print-access-token)

curl -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-goog-user-project: ${PROJECT_ID}" \
  "https://translation.googleapis.com/v3/projects/${PROJECT_ID}/locations/${LOCATION}/glossaries" \
  -d '{
    "name": "projects/'"${PROJECT_ID}"'/locations/'"${LOCATION}"'/glossaries/'"${GLOSSARY_ID}"'",
    "languagePair": {
      "sourceLanguageCode": "en",
      "targetLanguageCode": "es"
    },
    "inputConfig": {
      "gcsSource": {
        "inputUri": "gs://'"${BUCKET_NAME}"'/'"${CSV_FILE}"'"
      }
    }
  }'

echo ""
echo "✅ Glossary creation initiated for ${GLOSSARY_ID}"
