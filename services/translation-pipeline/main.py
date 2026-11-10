import os
import base64
import asyncio
from array import array
from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict, List, Any
from glossary_helper import create_or_update_gcs_glossary, create_translation_api_glossary
from dlp_helper import dlp_manager, DLP_INFO_TYPE_CATALOG
from languages import lang_info, resolve_language, same_language, public_catalog
from live_workers import (
    pipeline,
    SessionState,
    BaseStreamWorker,
    Chirp3StreamWorker,
    GeminiTranscribeWorker,
    GeminiLiveTranslateWorker,
    GeminiLiveTranslateBidiWorker,
    StreamingSTTWorker,
    GeminiLiveTranscribeWorker,
    create_stream_worker,
    process_text_turn,
    process_batch_audio_turn,
    translate_utterance_gemini35_live,
    translate_utterance_gemini38,
    apply_guest_detection,
    route_turn,
    safe_send,
    ENGINE_CHIRP3,
    ENGINE_GEMINI_TRANSCRIBE,
    ENGINE_LIVE_TRANSLATE,
    ENGINE_LIVE_38,
    GEMINI_TRANSCRIBE_MODEL,
    GEMINI_LIVE_TRANSLATE_MODEL,
    GEMINI_LIVE_MODEL,
)


def resolve_locale(lang_prefix: str) -> str:
    """Backward-compatible helper returning the BCP-47 STT/TTS locale for a language code."""
    return lang_info(lang_prefix)["stt"]


app = FastAPI(title="Enterprise Live Translation - Chirp 3 + Cloud DLP + MT v3 + Chirp 3 HD TTS + Gemini Live")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PROJECT_ID = os.getenv("PROJECT_ID", "gcp-live-translation")
LOCATION = os.getenv("LOCATION", "us-central1")

ENGINES = [
    {"id": ENGINE_CHIRP3, "label": "Chirp 3 -> Translation -> TTS", "speech_to_speech": False, "ptt_only": False},
    {"id": ENGINE_GEMINI_TRANSCRIBE, "label": f"{GEMINI_TRANSCRIBE_MODEL} -> Translation -> TTS", "speech_to_speech": False, "ptt_only": False},
    {"id": ENGINE_LIVE_TRANSLATE, "label": GEMINI_LIVE_TRANSLATE_MODEL, "speech_to_speech": True, "ptt_only": False},
    {"id": ENGINE_LIVE_38, "label": GEMINI_LIVE_MODEL, "speech_to_speech": True, "ptt_only": False},
]


class TextTranslateRequest(BaseModel):
    text: str
    source_lang: str = "en"
    target_lang: str = "es"
    use_glossary: bool = True
    model: Optional[str] = None
    use_dlp: bool = True
    dlp_info_types: Optional[List[str]] = None


class AudioTranslateRequest(BaseModel):
    audio_base64: str
    # Cast member language anchor (preferred)
    cast_lang: Optional[str] = None
    guest_lang: Optional[str] = None
    smart_detect: bool = True
    voice: Optional[str] = "Aoede"
    engine: Optional[str] = None
    # Legacy source/target pair (used when cast_lang/guest_lang are omitted)
    source_lang: str = "en"
    target_lang: str = "es"
    use_glossary: bool = True
    model: Optional[str] = None
    stt_model: Optional[str] = "chirp_3"
    use_dlp: bool = True
    dlp_info_types: Optional[List[str]] = None


class DlpSanitizeRequest(BaseModel):
    text: str
    enabled: bool = True
    info_types: Optional[List[str]] = None


@app.get("/")
def root():
    return {
        "service": "Enterprise Live Translation Advanced Pipeline",
        "status": "online",
        "models": {
            "speech_to_text": [
                "chirp_3 (Speech-to-Text V2, streaming + language auto-detect)",
                f"{GEMINI_TRANSCRIBE_MODEL} (Gemini 3.5 Live Transcribe, global)",
            ],
            "data_loss_prevention": "Google Cloud Sensitive Data Protection (DLP)",
            "machine_translation": os.getenv("TRANSLATION_MODEL", "general/translation-llm"),
            "text_to_speech": "Google Cloud Chirp 3 HD Voices",
            "speech_to_speech": [GEMINI_LIVE_TRANSLATE_MODEL, GEMINI_LIVE_MODEL],
        },
        "endpoints": {
            "health": "/health",
            "swagger_docs": "/docs",
            "languages": "GET /api/languages",
            "dlp_catalog": "GET /api/dlp/catalog",
            "dlp_sanitize": "POST /api/dlp/sanitize",
            "translate_text": "POST /api/translate-text",
            "translate_audio": "POST /api/translate-audio",
            "stream_translate_ws": "WS /ws/stream-translate"
        },
        "web_ui": "http://localhost:3000"
    }


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "translation-pipeline",
        "project_id": PROJECT_ID,
        "location": LOCATION,
        "chirp_region": pipeline.chirp_region,
        "dlp_enabled": True,
        "translation_model": os.getenv("TRANSLATION_MODEL", "general/translation-llm"),
        "engines": [e["id"] for e in ENGINES],
    }


@app.get("/api/languages")
def get_languages():
    return {"languages": public_catalog(), "engines": ENGINES}


@app.get("/api/dlp/catalog")
def get_dlp_catalog():
    return {
        "status": "ok",
        "catalog": dlp_manager.get_catalog()
    }


@app.post("/api/dlp/sanitize")
def sanitize_dlp_text(req: DlpSanitizeRequest):
    return dlp_manager.sanitize_text(
        text=req.text,
        enabled=req.enabled,
        active_info_types=req.info_types
    )


@app.post("/api/translate-text")
def translate_text(req: TextTranslateRequest):
    dlp_res = dlp_manager.sanitize_text(
        text=req.text,
        enabled=req.use_dlp,
        active_info_types=req.dlp_info_types
    )
    res = pipeline.translate_text(
        text=dlp_res["sanitized_text"],
        source_lang=lang_info(req.source_lang)["mt"],
        target_lang=lang_info(req.target_lang)["mt"],
        use_glossary=req.use_glossary,
        model=req.model
    )
    res["dlp"] = dlp_res
    return res


def _split_pcm_windows(pcm: bytes, window_s: int = 55, search_s: int = 5) -> List[bytes]:
    """Split 16kHz PCM into < 1 minute windows (Chirp 3 Recognize limit), cutting at the quietest 100ms frame."""
    bytes_per_s = 32000
    win, search, frame = window_s * bytes_per_s, search_s * bytes_per_s, 3200
    windows, start, n = [], 0, len(pcm)
    while n - start > win:
        best_pos, best_energy = start + win, None
        for pos in range(start + win - search, start + win, frame):
            seg = pcm[pos:pos + frame]
            seg = seg[: len(seg) // 2 * 2]
            energy = sum(abs(s) for s in array("h", seg))
            if best_energy is None or energy < best_energy:
                best_pos, best_energy = pos, energy
        windows.append(pcm[start:best_pos])
        start = best_pos
    windows.append(pcm[start:])
    return windows


def _split_pcm_utterances(pcm: bytes, max_window_s: int = 35) -> List[bytes]:
    """Split 16kHz PCM at natural pauses (>= 650ms silence after >= 1.2s of speech) so multi-turn
    recordings are segmented per speaker turn for Gemini 3.5 Transcribe and Gemini 3.8 Live.
    """
    frame = 3200  # 100ms at 16kHz 16-bit mono
    n = len(pcm) // 2 * 2
    if n <= frame * 15:
        return [pcm] if pcm else []

    energies = []
    for pos in range(0, n, frame):
        seg = pcm[pos:min(pos + frame, n)]
        seg = seg[: len(seg) // 2 * 2]
        if not seg:
            break
        samples = array("h", seg)
        energies.append(sum(abs(s) for s in samples) / max(1, len(samples)))

    if not energies:
        return [pcm]

    sorted_e = sorted(energies)
    noise_floor = sorted_e[max(0, len(sorted_e) // 5)]
    peak_e = sorted_e[-1]
    silence_thresh = max(120.0, min(450.0, noise_floor * 1.8 + (peak_e - noise_floor) * 0.06))

    utterances: List[bytes] = []
    cur_start = 0
    voiced_frames = 0
    silent_run = 0
    max_frames = max_window_s * 10

    for idx, e in enumerate(energies):
        if e >= silence_thresh:
            voiced_frames += 1
            silent_run = 0
        else:
            silent_run += 1

        frames_in_seg = idx - (cur_start // frame) + 1
        # Cut when >= 700ms of silence follows >= 1.2s of voiced speech, or when reaching max_window_s
        if (voiced_frames >= 12 and silent_run >= 7) or frames_in_seg >= max_frames:
            cut_byte = min(n, (idx + 1) * frame)
            chunk = pcm[cur_start:cut_byte]
            if voiced_frames >= 3:
                utterances.append(chunk)
            cur_start = cut_byte
            voiced_frames = 0
            silent_run = 0

    if cur_start < n and voiced_frames >= 2:
        utterances.append(pcm[cur_start:n])

    return utterances or _split_pcm_windows(pcm, window_s=max_window_s)


@app.post("/api/translate-audio")
async def translate_audio(req: AudioTranslateRequest):
    """Translate a recorded conversation with the cast member language as anchor.

    Supports three engines:
      - `chirp_3`: Speech-to-Text V2 (`chirp_3`) -> Cloud DLP -> Translation v3 -> Chirp 3 HD TTS
      - `gemini-3.5-transcribe`: `gemini-3.5-transcribe-preview` (`global`) -> Cloud DLP -> Translation v3 -> Chirp 3 HD TTS
      - `gemini-3.8-live`: `gemini-3.8-live` speech-to-speech interpreter (`us-central1`) + Cloud DLP on transcripts
    """
    pcm_bytes = base64.b64decode(req.audio_base64)
    selected_engine = (req.engine or req.stt_model or ENGINE_CHIRP3).lower()
    state = SessionState(
        cast_lang=resolve_language(req.cast_lang or req.source_lang) or "en",
        guest_lang=resolve_language(req.guest_lang or req.target_lang) or "es",
        smart_detect=req.smart_detect,
        engine=selected_engine,
        use_glossary=req.use_glossary,
        use_dlp=req.use_dlp,
        dlp_info_types=req.dlp_info_types,
        voice=req.voice or "Aoede",
    )

    # Path A: Speech-to-Speech Live Engines (`gemini-3.8-live` or `gemini-3.5-live-translate`)
    if selected_engine in (ENGINE_LIVE_38, ENGINE_LIVE_TRANSLATE):
        is_35_live = selected_engine == ENGINE_LIVE_TRANSLATE
        s2s_model = GEMINI_LIVE_TRANSLATE_MODEL if is_35_live else GEMINI_LIVE_MODEL
        s2s_engine = ENGINE_LIVE_TRANSLATE if is_35_live else ENGINE_LIVE_38
        segments_out, pcm_parts = [], []
        stt_ms = mt_ms = tts_ms = dlp_ms = 0.0
        cur_pcm_bytes = 0
        pause_bytes = b"\x00" * int(24000 * 2 * 0.35)
        findings: List[Dict[str, Any]] = []
        voice_used = f"{s2s_model} ({state.voice})"
        for utterance in _split_pcm_utterances(pcm_bytes, max_window_s=35):
            res_s2s = (
                await translate_utterance_gemini35_live(utterance, state)
                if is_35_live
                else await translate_utterance_gemini38(utterance, state)
            )
            seg_stt_ms = round(float(res_s2s.get("stt_ms", res_s2s.get("latency_ms", 0.0))), 1)
            seg_mt_ms = round(float(res_s2s.get("translation_ms", res_s2s.get("latency_ms", 0.0))), 1)
            seg_tts_ms = round(float(res_s2s.get("tts_ms", 0.0)), 1)
            stt_ms += seg_stt_ms
            mt_ms += seg_mt_ms
            tts_ms += seg_tts_ms
            inp_text = res_s2s.get("transcript", "").strip()
            out_text = res_s2s.get("translated_text", "").strip()
            raw_audio = res_s2s.get("audio_pcm") or b""
            if not inp_text and not out_text and not raw_audio:
                continue
            detected = res_s2s.get("detected_lang")
            if not detected and inp_text:
                det = await asyncio.to_thread(pipeline.detect_language, inp_text)
                detected = det.get("language_code")
            apply_guest_detection(state, detected, inp_text)
            role, src, tgt = route_turn(state, "ambient", detected)
            src_info, tgt_info = lang_info(src), lang_info(tgt)

            dlp_in = await asyncio.to_thread(
                dlp_manager.sanitize_text, inp_text, enabled=state.use_dlp, active_info_types=state.dlp_info_types, is_response=False
            )
            dlp_out = await asyncio.to_thread(
                dlp_manager.sanitize_text, out_text, enabled=state.use_dlp, active_info_types=state.dlp_info_types, is_response=True
            )
            seg_dlp_ms = round(float(dlp_in["latency_ms"] + dlp_out["latency_ms"]), 1)
            dlp_ms += seg_dlp_ms
            findings.extend(dlp_in["findings"] + dlp_out["findings"])
            ma_blocked = bool(dlp_in.get("model_armor_blocked") or dlp_out.get("model_armor_blocked"))
            ma_enabled = bool(dlp_in.get("model_armor_enabled") or dlp_out.get("model_armor_enabled"))
            if ma_blocked:
                raw_audio = b""
            audio_start_s = round(cur_pcm_bytes / 48000.0, 2)
            if raw_audio:
                pcm_parts.append(raw_audio)
                cur_pcm_bytes += len(raw_audio)
                audio_end_s = round(cur_pcm_bytes / 48000.0, 2)
                pcm_parts.append(pause_bytes)
                cur_pcm_bytes += len(pause_bytes)
            else:
                audio_end_s = audio_start_s
            seg_total_ms = round(max(seg_stt_ms, seg_mt_ms) + seg_tts_ms + seg_dlp_ms, 1)
            segments_out.append({
                "role": role,
                "src_lang": src_info["key"],
                "tgt_lang": tgt_info["key"],
                "detected_lang": detected or src_info["stt"],
                "transcript": inp_text,
                "sanitized_transcript": dlp_in["sanitized_text"],
                "dlp_applied": dlp_in["pii_detected"] or dlp_out["pii_detected"],
                "dlp_scope": "prompt_and_transcript" if state.use_dlp else "transcript_only",
                "model_armor_enabled": ma_enabled,
                "model_armor_blocked": ma_blocked,
                "translated_text": dlp_in["sanitized_text"] if (ma_blocked and not out_text) else dlp_out["sanitized_text"],
                "glossary_applied": bool(state.use_glossary),
                "glossary_mode": "prompt" if state.use_glossary else "none",
                "stt_ms": seg_stt_ms,
                "dlp_ms": seg_dlp_ms,
                "translation_ms": seg_mt_ms,
                "tts_ms": seg_tts_ms,
                "total_latency_ms": seg_total_ms,
                "stt_model": s2s_model,
                "model": s2s_model,
                "voice": voice_used,
                "engine": s2s_engine,
                "audio_start_s": audio_start_s,
                "audio_end_s": audio_end_s,
            })

        guest_info = lang_info(state.guest_lang)
        return {
            "engine": s2s_engine,
            "segments": segments_out,
            "cast_lang": state.cast_lang,
            "guest_lang": state.guest_lang,
            "detected_guest_lang": state.guest_lang if state.guest_detected else None,
            "detected_guest_label": f"{guest_info['flag']} {guest_info['label']}" if state.guest_detected else None,
            "stt": {
                "transcript": "\n".join(s["transcript"] for s in segments_out),
                "stt_model": s2s_model,
                "detected_lang": state.guest_lang,
                "latency_ms": round(stt_ms, 2),
            },
            "dlp": {
                "sanitized_text": "\n".join(s["sanitized_transcript"] for s in segments_out),
                "pii_detected": any(s["dlp_applied"] for s in segments_out),
                "dlp_scope": "prompt_and_transcript" if state.use_dlp else "transcript_only",
                "model_armor_enabled": any(s.get("model_armor_enabled") for s in segments_out),
                "model_armor_blocked": any(s.get("model_armor_blocked") for s in segments_out),
                "findings": findings,
                "latency_ms": round(dlp_ms, 2),
            },
            "translation": {
                "translated_text": "\n".join(s["translated_text"] for s in segments_out),
                "glossary_applied": bool(state.use_glossary),
                "glossary_mode": "prompt" if state.use_glossary else "none",
                "model": s2s_model,
                "latency_ms": round(mt_ms, 2),
            },
            "tts": {
                "audio_base64": base64.b64encode(b"".join(pcm_parts)).decode("utf-8") if pcm_parts else "",
                "sample_rate": 24000,
                "voice": voice_used,
                "latency_ms": round(tts_ms, 2),
            },
            "total_latency_ms": round(max(stt_ms, mt_ms) + tts_ms + dlp_ms, 2),
        }

    # Path B: Cascade engines (`chirp_3` or `gemini-3.5-transcribe`) -> DLP / Model Armor -> Translation v3 -> Chirp 3 HD TTS
    cast_stt, guest_stt = lang_info(state.cast_lang)["stt"], lang_info(state.guest_lang)["stt"]
    codes = ["auto"] if state.smart_detect else list(dict.fromkeys([cast_stt, guest_stt]))
    use_gemini_stt = "gemini" in selected_engine

    stt_ms, stt_model, raw_segments = 0.0, "chirp_3 (Speech v2)", []
    windows = _split_pcm_utterances(pcm_bytes, max_window_s=45)
    for window in windows:
        if use_gemini_stt:
            stt_res = await asyncio.to_thread(pipeline.transcribe_gemini35, window, None if state.smart_detect else codes)
        else:
            stt_res = await asyncio.to_thread(pipeline.transcribe_chirp3, window, codes)
        win_stt_ms = float(stt_res.get("latency_ms", 0.0))
        stt_ms += win_stt_ms
        stt_model = stt_res.get("stt_model", stt_model)
        segs = stt_res.get("segments") or (
            [{"transcript": stt_res["transcript"], "language_code": stt_res.get("detected_lang")}] if stt_res.get("transcript") else []
        )
        total_chars = max(1, sum(len(s.get("transcript", "")) for s in segs))
        for s in segs:
            share = len(s.get("transcript", "")) / total_chars if len(segs) > 1 else 1.0
            raw_segments.append({**s, "stt_ms": round(win_stt_ms * share, 1)})

    # 2. Route each utterance with the cast member anchor; merge consecutive same-direction utterances
    merged: List[Dict[str, Any]] = []
    for seg in raw_segments:
        detected = seg.get("language_code")
        apply_guest_detection(state, detected, seg["transcript"])
        role, src, tgt = route_turn(state, "ambient", detected)
        if merged and merged[-1]["role"] == role and merged[-1]["src"] == src:
            merged[-1]["transcript"] += " " + seg["transcript"]
            merged[-1]["stt_ms"] = round(merged[-1].get("stt_ms", 0.0) + seg.get("stt_ms", 0.0), 1)
        else:
            merged.append({
                "role": role,
                "src": src,
                "tgt": tgt,
                "detected_lang": detected,
                "transcript": seg["transcript"],
                "stt_ms": round(seg.get("stt_ms", 0.0), 1),
            })

    # 3. DLP + Model Armor -> Translation -> TTS per segment
    segments_out, pcm_parts = [], []
    dlp_ms = mt_ms = tts_ms = 0.0
    cur_pcm_bytes = 0
    pause_bytes = b"\x00" * int(24000 * 2 * 0.35)
    findings: List[Dict[str, Any]] = []
    glossary_applied, voice_used, mt_model = False, None, None
    engine_out = ENGINE_GEMINI_TRANSCRIBE if use_gemini_stt else ENGINE_CHIRP3
    for seg in merged:
        dlp_res = await asyncio.to_thread(
            dlp_manager.sanitize_text, seg["transcript"], enabled=state.use_dlp, active_info_types=state.dlp_info_types, is_response=False
        )
        seg_dlp_ms = round(float(dlp_res["latency_ms"]), 1)
        dlp_ms += seg_dlp_ms
        findings.extend(dlp_res["findings"])
        src_info, tgt_info = lang_info(seg["src"]), lang_info(seg["tgt"])
        ma_blocked = bool(dlp_res.get("model_armor_blocked", False))
        ma_enabled = bool(dlp_res.get("model_armor_enabled", False))
        if ma_blocked:
            mt_res = {"translated_text": dlp_res["sanitized_text"], "glossary_applied": False, "latency_ms": 0.0, "model": "GCP Model Armor (Blocked)"}
            tts_res = {"audio_base64": "", "latency_ms": 0.0, "voice": state.voice}
        elif same_language(seg["src"], seg["tgt"]):
            mt_res = {"translated_text": dlp_res["sanitized_text"], "glossary_applied": False, "latency_ms": 0.0, "model": "passthrough"}
            tts_res = await asyncio.to_thread(
                pipeline.synthesize_speech, mt_res["translated_text"], target_lang=tgt_info["tts"], voice=state.voice
            )
        else:
            mt_res = await asyncio.to_thread(
                pipeline.translate_text, dlp_res["sanitized_text"], source_lang=src_info["mt"], target_lang=tgt_info["mt"],
                use_glossary=state.use_glossary, model=req.model
            )
            tts_res = await asyncio.to_thread(
                pipeline.synthesize_speech, mt_res["translated_text"], target_lang=tgt_info["tts"], voice=state.voice
            )
        seg_mt_ms = round(float(mt_res["latency_ms"]), 1)
        mt_ms += seg_mt_ms
        glossary_applied = glossary_applied or mt_res["glossary_applied"]
        mt_model = mt_res["model"]
        seg_tts_ms = round(float(tts_res["latency_ms"]), 1)
        tts_ms += seg_tts_ms
        voice_used = tts_res.get("voice")
        raw_tts_pcm = base64.b64decode(tts_res["audio_base64"]) if tts_res.get("audio_base64") else b""
        audio_start_s = round(cur_pcm_bytes / 48000.0, 2)
        if raw_tts_pcm:
            pcm_parts.append(raw_tts_pcm)
            cur_pcm_bytes += len(raw_tts_pcm)
            audio_end_s = round(cur_pcm_bytes / 48000.0, 2)
            pcm_parts.append(pause_bytes)
            cur_pcm_bytes += len(pause_bytes)
        else:
            audio_end_s = audio_start_s
        seg_stt_ms = round(float(seg.get("stt_ms", 0.0)), 1)
        seg_total_ms = round(seg_stt_ms + seg_dlp_ms + seg_mt_ms + seg_tts_ms, 1)
        segments_out.append({
            "role": seg["role"],
            "src_lang": src_info["key"],
            "tgt_lang": tgt_info["key"],
            "detected_lang": seg["detected_lang"],
            "transcript": seg["transcript"],
            "sanitized_transcript": dlp_res["sanitized_text"],
            "dlp_applied": dlp_res["pii_detected"],
            "dlp_scope": "full",
            "model_armor_enabled": ma_enabled,
            "model_armor_blocked": ma_blocked,
            "translated_text": mt_res["translated_text"],
            "glossary_applied": mt_res["glossary_applied"],
            "glossary_mode": "translation_v3" if mt_res["glossary_applied"] else "none",
            "stt_ms": seg_stt_ms,
            "dlp_ms": seg_dlp_ms,
            "translation_ms": seg_mt_ms,
            "tts_ms": seg_tts_ms,
            "total_latency_ms": seg_total_ms,
            "stt_model": stt_model,
            "model": mt_model,
            "voice": voice_used,
            "engine": engine_out,
            "audio_start_s": audio_start_s,
            "audio_end_s": audio_end_s,
        })

    guest_info = lang_info(state.guest_lang)
    return {
        "engine": ENGINE_GEMINI_TRANSCRIBE if use_gemini_stt else ENGINE_CHIRP3,
        "segments": segments_out,
        "cast_lang": state.cast_lang,
        "guest_lang": state.guest_lang,
        "detected_guest_lang": state.guest_lang if state.guest_detected else None,
        "detected_guest_label": f"{guest_info['flag']} {guest_info['label']}" if state.guest_detected else None,
        "stt": {
            "transcript": "\n".join(s["transcript"] for s in segments_out),
            "stt_model": stt_model,
            "detected_lang": state.guest_lang,
            "latency_ms": round(stt_ms, 2),
        },
        "dlp": {
            "sanitized_text": "\n".join(s["sanitized_transcript"] for s in segments_out),
            "pii_detected": any(s["dlp_applied"] for s in segments_out),
            "dlp_scope": "full",
            "findings": findings,
            "latency_ms": round(dlp_ms, 2),
        },
        "translation": {
            "translated_text": "\n".join(s["translated_text"] for s in segments_out),
            "glossary_applied": glossary_applied,
            "model": mt_model,
            "latency_ms": round(mt_ms, 2),
        },
        "tts": {
            "audio_base64": base64.b64encode(b"".join(pcm_parts)).decode("utf-8") if pcm_parts else "",
            "sample_rate": 24000,
            "voice": voice_used,
            "latency_ms": round(tts_ms, 2),
        },
        "total_latency_ms": round(stt_ms + dlp_ms + mt_ms + tts_ms, 2),
    }


@app.post("/api/upload-audio")
async def upload_audio(
    file: UploadFile = File(...),
    source_lang: str = Form("en"),
    target_lang: str = Form("es"),
    use_glossary: bool = Form(True),
    use_dlp: bool = Form(True),
    stt_model: str = Form("chirp_3"),
):
    pcm_bytes = await file.read()
    src_info, tgt_info = lang_info(source_lang), lang_info(target_lang)
    if stt_model and stt_model.lower() == ENGINE_LIVE_38:
        state = SessionState(
            cast_lang=src_info["key"], guest_lang=tgt_info["key"], smart_detect=False,
            engine=ENGINE_LIVE_38, use_glossary=use_glossary, use_dlp=use_dlp,
        )
        res38 = await translate_utterance_gemini38(pcm_bytes, state)
        dlp_res = dlp_manager.sanitize_text(text=res38.get("transcript", ""), enabled=use_dlp)
        dlp_out = dlp_manager.sanitize_text(text=res38.get("translated_text", ""), enabled=use_dlp)
        return {
            "stt": {"transcript": res38.get("transcript", ""), "stt_model": GEMINI_LIVE_MODEL,
                    "detected_lang": res38.get("detected_lang") or src_info["stt"],
                    "latency_ms": res38.get("stt_ms", res38["latency_ms"])},
            "dlp": dlp_res,
            "translation": {"translated_text": dlp_out["sanitized_text"], "glossary_applied": use_glossary,
                            "model": GEMINI_LIVE_MODEL,
                            "latency_ms": res38.get("translation_ms", res38["latency_ms"])},
            "tts": {"audio_base64": base64.b64encode(res38.get("audio_pcm", b"")).decode("utf-8"),
                    "sample_rate": 24000, "voice": res38.get("voice"),
                    "latency_ms": res38.get("tts_ms", 0.0)},
            "total_latency_ms": round(res38["latency_ms"] + dlp_res["latency_ms"] + dlp_out["latency_ms"], 2),
        }
    if stt_model and "gemini" in stt_model.lower():
        stt_res = await asyncio.to_thread(pipeline.transcribe_gemini35, pcm_bytes, [src_info["stt"]])
    else:
        stt_res = await asyncio.to_thread(pipeline.transcribe_chirp3, pcm_bytes, src_info["stt"])
    raw_transcript = stt_res.get("transcript", "")
    dlp_res = dlp_manager.sanitize_text(
        text=raw_transcript,
        enabled=use_dlp
    )
    mt_res = pipeline.translate_text(
        text=dlp_res["sanitized_text"],
        source_lang=src_info["mt"],
        target_lang=tgt_info["mt"],
        use_glossary=use_glossary
    )
    tts_res = pipeline.synthesize_speech(mt_res["translated_text"], target_lang=tgt_info["tts"])
    
    return {
        "stt": stt_res,
        "dlp": dlp_res,
        "translation": mt_res,
        "tts": tts_res,
        "total_latency_ms": round(stt_res["latency_ms"] + dlp_res["latency_ms"] + mt_res["latency_ms"] + tts_res["latency_ms"], 2)
    }


@app.post("/api/glossary/sync")
def sync_glossary(csv_path: Optional[str] = None):
    target_path = csv_path
    if not target_path:
        for candidate in [
            "/app/glossaries/brand_glossary_en_es.csv",
            "../../glossaries/brand_glossary_en_es.csv"
        ]:
            if os.path.exists(candidate):
                target_path = candidate
                break
    target_path = target_path or "../../glossaries/brand_glossary_en_es.csv"
    
    gcs_uri = create_or_update_gcs_glossary(target_path)
    result = create_translation_api_glossary(gcs_uri)
    return {
        "status": "synchronized",
        "gcs_uri": gcs_uri,
        "glossary_name": result.name if hasattr(result, "name") else str(result)
    }


@app.websocket("/ws/stream-translate")
async def websocket_endpoint(websocket: WebSocket):
    """Bidirectional live translation stream.

    Client messages:
      config             {castLang, guestLang, smartDetect, engine, voice, useGlossary, useDlp, dlpInfoTypes}
      audio_stream_start {speakerRole: cast-member|guest|ambient, turnId, ...config fields}
      audio_chunk        {pcm: base64 16kHz 16-bit mono}
      audio_stream_end   {}
      audio              {pcm, speakerRole}  one-shot utterance (Chirp 3 Recognize)
      text               {text, speakerRole}
    """
    await websocket.accept()
    print("[PipelineWS] Client connected", flush=True)
    state = SessionState()
    active_worker: Optional[BaseStreamWorker] = None
    background: set = set()
    turn_counter = 0

    def track(coro):
        task = asyncio.create_task(coro)
        background.add(task)
        task.add_done_callback(background.discard)
        return task

    def next_turn_id(data: Dict[str, Any]) -> str:
        nonlocal turn_counter
        turn_counter += 1
        return str(data.get("turnId") or f"t{turn_counter}")

    async def finish(worker: BaseStreamWorker):
        await worker.stop()
        await safe_send(websocket, {"type": "turn_complete", "turnId": worker.turn_id})

    def state_payload() -> Dict[str, Any]:
        return {"castLang": state.cast_lang, "guestLang": state.guest_lang,
                "smartDetect": state.smart_detect, "engine": state.engine}

    def stream_cfg_key():
        return (
            state.engine.lower(),
            state.cast_lang,
            state.guest_lang,
            state.smart_detect,
            state.voice,
            state.use_dlp,
            tuple(state.dlp_info_types or []),
        )

    try:
        await websocket.send_json({"type": "ready", **state_payload()})
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            prev_stream_cfg = stream_cfg_key()
            if msg_type != "audio_chunk":
                state.update_from_message(data)
                print(f"[PipelineWS] Msg: {msg_type}, role={data.get('speakerRole')}, cast={state.cast_lang}, "
                      f"guest={state.guest_lang}, smart={state.smart_detect}, engine={state.engine}", flush=True)
            new_stream_cfg = stream_cfg_key()
            speaker_role = data.get("speakerRole", "cast-member")

            if msg_type == "config":
                if active_worker is not None and not active_worker.is_ptt and new_stream_cfg != prev_stream_cfg:
                    old_worker = active_worker
                    active_worker = None
                    track(finish(old_worker))
                    turn_id = next_turn_id(data)
                    worker = create_stream_worker(websocket, state, "ambient", turn_id)
                    if worker is not None:
                        active_worker = worker
                        worker.start()
                        await websocket.send_json({
                            "type": "stream_started",
                            "turnId": turn_id,
                            "speakerRole": "ambient",
                            "hotSwapped": True,
                            **state_payload(),
                        })
                await websocket.send_json({"type": "config_ack", **state_payload()})

            elif msg_type == "audio_stream_start":
                if active_worker:
                    track(finish(active_worker))
                    active_worker = None
                turn_id = next_turn_id(data)
                worker = create_stream_worker(websocket, state, speaker_role, turn_id)
                if worker is None:
                    await websocket.send_json({
                        "type": "error", "turnId": turn_id,
                        "message": "Gemini 3.5 Live Translate supports push-to-talk only. Use the Cast / Guest buttons or pick another engine for continuous mode."
                    })
                    continue
                active_worker = worker
                worker.start()
                await websocket.send_json({"type": "stream_started", "turnId": turn_id, "speakerRole": speaker_role, **state_payload()})

            elif msg_type == "audio_chunk" and "pcm" in data:
                if not active_worker:
                    chunk_role = data.get("speakerRole", "ambient")
                    active_worker = create_stream_worker(websocket, state, chunk_role, next_turn_id(data))
                    if active_worker is None:
                        continue
                    active_worker.start()
                await active_worker.push_audio(base64.b64decode(data["pcm"]))

            elif msg_type == "audio_stream_end":
                if active_worker:
                    track(finish(active_worker))
                    active_worker = None
                else:
                    await websocket.send_json({"type": "turn_complete"})

            elif msg_type == "audio" and "pcm" in data:
                track(process_batch_audio_turn(websocket, state, base64.b64decode(data["pcm"]), speaker_role, next_turn_id(data)))

            elif msg_type == "text" and data.get("text"):
                track(process_text_turn(websocket, state, data["text"], speaker_role, next_turn_id(data)))

    except WebSocketDisconnect:
        print("[PipelineWS] Client disconnected", flush=True)
    except Exception as e:
        print(f"[PipelineWS] Error: {e}", flush=True)
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        if active_worker:
            active_worker.cancel()
        for task in list(background):
            task.cancel()


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8081"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
