#!/usr/bin/env bash
set -e

PROJECT_ID="${PROJECT_ID:-your-gcp-project-id}"
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
