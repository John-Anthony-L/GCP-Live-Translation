#!/usr/bin/env bash

# ==============================================================================
# Enterprise Live Translation - Cloud Run Port-Forwarding / Proxy Manager
# ==============================================================================

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
  echo "   PROJECT_ID=your-actual-project-id ./infra/start_proxy.sh"
  exit 1
fi

REGION="${REGION:-${LOCATION:-us-central1}}"

# Auto-detect Cloud Run service names (supports both generic names and deployed legacy names)
resolve_service() {
  local preferred="$1"
  local legacy="$2"
  if gcloud run services describe "${preferred}" --project="${PROJECT_ID}" --region="${REGION}" >/dev/null 2>&1; then
    echo "${preferred}"
  elif gcloud run services describe "${legacy}" --project="${PROJECT_ID}" --region="${REGION}" >/dev/null 2>&1; then
    echo "${legacy}"
  else
    echo "${preferred}"
  fi
}

echo "🔍 Detecting deployed Cloud Run services..."
SVC_WEB=$(resolve_service "${SERVICE_WEB:-live-web-client}" "disney-live-web-client")
SVC_PROXY=$(resolve_service "${SERVICE_PROXY:-gemini-live-proxy}" "disney-gemini-live-proxy")
SVC_PIPELINE=$(resolve_service "${SERVICE_PIPELINE:-live-translation-pipeline}" "disney-translation-pipeline")

echo "======================================================================"
echo "🌐 Starting Secure Local Port-Forwarding to Cloud Run Services..."
echo "Project: ${PROJECT_ID}"
echo "Region:  ${REGION}"
echo "======================================================================"
echo ""
echo "🚀 1. Web & Mobile Testbed UI   -> http://localhost:3000   (${SVC_WEB})"
echo "⚡ 2. Gemini Live Proxy (WS)    -> ws://localhost:8090    (${SVC_PROXY})"
echo "⚙️ 3. Translation Pipeline      -> http://localhost:8092   (${SVC_PIPELINE})"
echo ""
echo "Press Ctrl+C to stop all proxies."
echo "======================================================================"

# Start Proxy 1: Web Client (Port 3000)
gcloud run services proxy "${SVC_WEB}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --port=3000 &
PID_WEB=$!

# Start Proxy 2: Gemini Live Proxy (Port 8090)
gcloud run services proxy "${SVC_PROXY}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --port=8090 &
PID_PROXY=$!

# Start Proxy 3: Translation Pipeline (Port 8092)
gcloud run services proxy "${SVC_PIPELINE}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --port=8092 &
PID_PIPELINE=$!

# Trap Ctrl+C and kill background processes
trap "echo 'Stopping proxies...'; kill $PID_WEB $PID_PROXY $PID_PIPELINE 2>/dev/null; exit 0" INT TERM

wait
