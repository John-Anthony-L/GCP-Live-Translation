#!/usr/bin/env bash

# ==============================================================================
# Disney Parks Live Translation - Cloud Run Port-Forwarding / Proxy Manager
# target: disney-parks-live-translation (Argolis GCP)
# ==============================================================================

PROJECT_ID="disney-parks-live-translation"
REGION="us-central1"

echo "======================================================================"
echo "🏰 Starting Secure Local Port-Forwarding to Cloud Run Services..."
echo "Project: ${PROJECT_ID}"
echo "Region:  ${REGION}"
echo "======================================================================"
echo ""
echo "🚀 1. Web & Mobile Testbed UI   -> http://localhost:3000"
echo "⚡ 2. Gemini Live Proxy (WS)    -> ws://localhost:8090"
echo "⚙️ 3. Translation Pipeline      -> http://localhost:8092"
echo ""
echo "Press Ctrl+C to stop all proxies."
echo "======================================================================"

# Start Proxy 1: Web Client (Port 3000)
gcloud run services proxy disney-live-web-client \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --port=3000 &
PID_WEB=$!

# Start Proxy 2: Gemini Live Proxy (Port 8090)
gcloud run services proxy disney-gemini-live-proxy \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --port=8090 &
PID_PROXY=$!

# Start Proxy 3: Translation Pipeline (Port 8092)
gcloud run services proxy disney-translation-pipeline \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --port=8092 &
PID_PIPELINE=$!

# Trap Ctrl+C and kill background processes
trap "echo 'Stopping proxies...'; kill $PID_WEB $PID_PROXY $PID_PIPELINE 2>/dev/null; exit 0" INT TERM

wait
