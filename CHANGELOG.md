# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Planned enhancements and upcoming changes go here before a release is tagged.

---

## [1.5.0] - 2026-11-11

### Added
- **Gemini 3.5 Live Translate (`gemini-3.5-live-translate-preview`) Bidirectional 2-Way Streaming & System Prompt Support**:
  - Verified and enabled `system_instruction` (bidirectional `<->` Enterprise Brand Glossary + DLP/Model Armor rules), dynamic `custom_vocabulary` ASR biasing (`brand_vocabulary`), and `speech_config` voice persona selection on `GeminiLiveTranslateWorker`.
  - Added `GeminiLiveTranslateBidiWorker` for Continuous 2-Way hands-free conversations (`role="ambient"`), coordinating paired Cast $\rightarrow$ Guest and Guest $\rightarrow$ Cast sessions with `echo_target_language=False`, speaker-direction language filtering (`_ignore_input_lang`), automatic 0.85s silence turn finalization (`_idle_finalizer`), and automatic Cast $\rightarrow$ Guest hot-swap when Smart Guest Language Detection switches the guest language.
  - Added `translate_utterance_gemini35_live` to support **Gemini 3.5 Live Translate** on multi-turn Recorded Audio Uploads (`/api/translate-audio`).
  - Added `mtime`-aware `load_brand_glossary()` hot-reloading and automatic `gcloud auth print-access-token` local credential fallback (`get_gcp_credentials`).

---

## [1.4.0] - 2026-10-05

### Added
- **GCP Model Armor Integration (`:sanitizeUserPrompt` & `:sanitizeModelResponse`)**:
  - Integrated regional Google Cloud Model Armor (`modelarmor.{LOCATION}.rep.googleapis.com`) into `LiveTranslationDLPManager` (`dlp_helper.py`), screening all live and uploaded transcripts for **Prompt Injection & Jailbreak**, **Responsible AI (Hate Speech, Harassment, Dangerous, Sexually Explicit, CSAM)**, **Malicious URLs**, and **Advanced Sensitive Data Protection (SDP)** de-identification.
  - Provisioned `live-translation-armor` (Concierge default) and `live-translation-armor-coppa` (Public Kiosk with `PERSON_NAME`) templates backed by Cloud DLP Inspect (`live-translation-inspect`, `live-translation-inspect-coppa`) and De-identify (`live-translation-deid`) templates.
  - Added an audio circuit-breaker (`model_armor_block`) that blocks translation/TTS on Cascade engines (`chirp_3`, `gemini-3.5-transcribe`) and halts/drops buffered audio on `gemini-3.8-live` whenever a prompt injection or Responsible AI policy violation is detected.
  - Added a Prompt Injection / Jailbreak test chip to the Interactive Model Armor & DLP Sandbox in the web client.
  - Updated `infra/deploy.sh` to automatically enable `modelarmor.googleapis.com`, grant `roles/modelarmor.user` and `roles/modelarmor.admin`, bind `roles/dlp.user` and `roles/dlp.reader` to the Model Armor service agent, and provision the SDP + Model Armor templates idempotently.

---

## [1.3.0] - 2026-10-02

### Added
- **Four Selectable Translation Engines** over a unified `/ws/stream-translate` WebSocket and `/api/translate-audio` REST pipeline:
  - **Chirp 3 (`chirp_3`)**: Cloud Speech-to-Text V2 (`us-speech.googleapis.com`) + Cloud DLP + Cloud Translation Advanced v3 + Chirp 3 HD TTS.
  - **Gemini 3.5 Transcribe (`gemini-3.5-transcribe`)**: Vertex AI `gemini-3.5-transcribe-live-preview` (`location="global"`) + Cloud DLP + Cloud Translation Advanced v3 + Chirp 3 HD TTS.
  - **Gemini 3.8 Live (`gemini-3.8-live`)**: Native speech-to-speech bidirectional audio via Vertex AI `gemini-3.8-live` (`location="us-central1"`).
  - **Gemini 3.5 Live Translate (`gemini-3.5-live-translate`)**: Native speech-to-speech push-to-talk translation via Vertex AI `gemini-3.5-live-translate-preview` (`location="global"`).
- **Dynamic DLP System Prompt Redaction for Gemini 3.8 Live (`dlp_prompt`)**:
  - Dynamically injects active built-in and custom InfoTypes (`RESERVATION_ID`, `ANNUAL_PASS_ID`, `MAGICBAND_ID`, `ROOM_NUMBER`, `PIN_CODE`, `CREDIT_CARD_NUMBER`, etc.) into the Gemini 3.8 Live system prompt so sensitive numbers are never spoken aloud in generated audio (`dlp_scope: "prompt_and_transcript"`).
  - Deterministic Cloud DLP (`redact_pii`) continues to scrub all input and output transcripts before UI rendering and Firestore persistence.
- **Hot-Swap Translation Engine & DLP Config During Continuous 2-Way Stream**:
  - Changing the Translation Engine, Cast/Guest languages, Voice, or DLP InfoType settings while **Continuous 2-Way Stream** is active now hot-swaps the backend worker session on the fly without restarting the microphone.
- **Recorded Audio Upload Across Engines**:
  - Supports **Chirp 3 (Speech V2)**, **Gemini 3.5 Live Transcribe**, and **Gemini 3.8 Live** for multi-turn uploaded audio files, with automatic protection against selecting Push-to-Talk-only (`gemini-3.5-live-translate`).
- **Per-Turn Latency Breakdown & Interactive Synced Timeline Scrubber**:
  - Captures and stores per-turn `latencyMs` (`stt`, `dlp`, `mt`, `tts`, `total`, `engine`) across Live Streaming, Uploaded Audio, and Past Conversations.
  - Added an interactive audio player and timeline scrubber in **Past Conversations** with turn boundary markers, active turn highlighting, and click-to-seek turn playback.
- **System Architecture Diagrams**:
  - Added dedicated Mermaid architecture diagrams in [`README.md`](README.md) comparing the **Modular Cascade Pipeline** and **Gemini 3.8 Live Native Speech-to-Speech Architecture**.

### Changed
- **Automated Cloud Run Provisioning (`infra/deploy.sh`)**:
  - Automatically enables `firestore.googleapis.com` and `iam.googleapis.com`, provisions the Firestore `(default)` database, grants `roles/speech.client`, `roles/datastore.user`, `roles/dlp.user`, `roles/aiplatform.user`, `roles/cloudtranslate.user`, and `roles/storage.objectAdmin`, sets all Gemini 3.5/3.8 environment variables, and triggers `/api/glossary/sync` post-deploy.
- **Strict Cloud Speech-to-Text V2 Enforcement**:
  - Removed V1 fallback in `Chirp3StreamWorker` and `transcribe_audio` so Chirp 3 exclusively uses Cloud Speech-to-Text V2 (`projects/{PROJECT_ID}/locations/us/recognizers/_`).

### Removed
- **Legacy `services/gemini-live-proxy/`**:
  - Removed the unused standalone Node.js `gemini-live-proxy` directory; all 4 engines run inside `services/translation-pipeline`.

### Migration & Backward Compatibility Notes (Upgrading from `v1.2.0` / `61955be`)

For engineers familiar with commit `61955be`, all existing REST endpoints, WebSocket payloads, and Python classes remain **100% backward-compatible**:

1. **Removed Unused `services/gemini-live-proxy/`**:
   - All 4 engines (`chirp_3`, `gemini-3.5-transcribe`, `gemini-3.5-live-translate`, `gemini-3.8-live`) run inside `services/translation-pipeline` over the single `/ws/stream-translate` WebSocket.
2. **Module Layout in `services/translation-pipeline/`**:
   - Streaming workers were modularized into `live_workers.py` and the language catalog into `languages.py`.
   - **Backward-compatible exports in `main.py` & `pipeline.py`**:
     - `StreamingSTTWorker` (alias of `Chirp3StreamWorker`), `GeminiLiveTranscribeWorker` (alias of `GeminiTranscribeWorker`), `create_stream_worker(...)`, and `resolve_locale(...)` are still exported directly from `main.py` and accept both the original keyword arguments (`websocket`, `src_lang`, `tgt_lang`, `speaker_role`, `stt_model`) and the new `SessionState` signature.
     - `DisneyTranslationPipeline` (alias of `LiveTranslationPipeline`), `transcribe_audio(...)`, `get_streaming_config(...)`, and `run_full_pipeline(...)` are preserved in `pipeline.py`.
     - Cloud Translation v3 automatically checks both `brand-parks-glossary-*` and legacy `disney-parks-glossary-*` IDs.
3. **Model & Endpoint Requirements**:
   - **Chirp 3 (`chirp_3`)**: Uses **Cloud Speech-to-Text V2** (`us-speech.googleapis.com`, recognizer `projects/{PROJECT_ID}/locations/us/recognizers/_`). Requires `roles/speech.client` on the Cloud Run service account (granted automatically by `infra/deploy.sh`). Note that Speech V2 only allows `adaptation` (`biasing_phrases`) when a single explicit locale is passed (e.g., `["en-US"]`), so `adaptation` is automatically omitted when `language_codes=["auto"]` (Smart Guest Language Detection) is active.
   - **Gemini 3.5 Live Transcribe (`gemini-3.5-transcribe-live-preview`)**: Hosted on Vertex AI in **`location="global"`** (`GEMINI_TRANSCRIBE_LOCATION=global`).
   - **Gemini 3.5 Live Translate (`gemini-3.5-live-translate-preview`)**: Hosted on Vertex AI in **`location="global"`** (`GEMINI_LIVE_TRANSLATE_LOCATION=global`), push-to-talk only.
   - **Gemini 3.8 Live (`gemini-3.8-live`)**: Hosted on Vertex AI in **`location="us-central1"`** (`GEMINI_LIVE_LOCATION=us-central1`).

---

## [1.2.0] - 2026-09-24

### Added
- **Recorded Audio Upload (`/api/translate-audio`)**: Upload WAV/MP3/WebM/OGG/FLAC recordings for automated turn-by-turn translation and TTS playback (`61955be`).
- **Conversation Transcript & Audio Export**: Download full conversation transcripts (`.txt`) and stitched stereo/mono WAV audio recordings (`61955be`).
- **Past Conversations Tab**: Firestore-backed persistence for reviewing and deleting historical sessions (`61955be`).
- **Interactive Glossary Language Pairs Editor**: Add, filter, and manage multi-language glossary translations (`ES`, `PT`, `FR`, `JA`, `ZH`) directly from the web UI (`5432ea4`).

### Changed
- Updated UI branding to **2-Way Live Translation** and generalized glossary filenames (`b2582ab`).
- Auto-detected deployed Cloud Run service names with legacy fallback in `infra/start_proxy.sh` (`2ffccd3`).

---

## [1.1.0] - 2026-09-22

### Added
- **Chirp 3 HD Text-to-Speech Voices**: Upgraded pipeline TTS synthesis to Chirp 3 HD voices (`Aoede`, `Puck`, `Charon`, `Kore`, `Fenrir`, `Leda`, `Orus`, `Zephyr`) (`7e3fc5f`).
- **Multi-Tenant GCP Onboarding**: Added `.env.example` and automated `.env` loading in `infra/deploy.sh` and `infra/start_proxy.sh` (`7dd5f91`, `e07f8cd`).

### Removed
- Removed deprecated `gemini-2.0-flash-exp` configuration and moved the legacy `ios-app` directory to the `ios-version` branch (`e824435`, `17fb650`).

---

## [1.0.0] - 2026-09-03

### Added
- **Cloud DLP Sensitive Data Protection**: Real-time PII inspection and redaction (`dlp_helper.py`) with interactive privacy presets (`Full Park Protection`, `Payment & PCI Only`, `Bypass`) and custom regex detectors (`464cfe8`).
- **Gemini 3.5 Live Transcribe Integration**: Official `google-genai` Live API streaming transcription (`7f2afc2`).
- **Live Running Pipeline Telemetry Terminal**: Real-time RMS audio meter, STT interim word streaming, 4-card latency HUD, and Voice Activity Detection (VAD) for Continuous 2-Way mode (`db02a0c`, `089b466`, `ee81369`).
- **Initial Cloud Run Multi-Service Architecture**: FastAPI `translation-pipeline` and Express `web-client` with Cloud Translation Advanced v3 brand glossaries (`eee34d3`, `384e582`).
