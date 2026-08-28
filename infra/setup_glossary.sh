#!/usr/bin/env bash
set -e

PROJECT_ID="${PROJECT_ID:-disney-parks-live-translation}"
LOCATION="${LOCATION:-us-central1}"
GLOSSARY_ID="disney-parks-glossary-en-es"
BUCKET_NAME="${PROJECT_ID}-glossaries"

echo "Configuring Cloud Translation API Advanced Glossary: ${GLOSSARY_ID}..."

# Upload CSV to GCS using gcloud storage
gcloud storage cp glossaries/disney_glossary_en_es.csv "gs://${BUCKET_NAME}/disney_glossary_en_es.csv"

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
        "inputUri": "gs://'"${BUCKET_NAME}"'/disney_glossary_en_es.csv"
      }
    }
  }'

echo ""
echo "✅ Glossary creation initiated for ${GLOSSARY_ID}"
