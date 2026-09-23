import os
import base64
import asyncio
from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict, List, Any
from google.cloud import speech_v1p1beta1 as speech
from google import genai
from google.genai import types
from pipeline import LiveTranslationPipeline, DisneyTranslationPipeline
from glossary_helper import create_or_update_gcs_glossary, create_translation_api_glossary
from dlp_helper import dlp_manager, DLP_INFO_TYPE_CATALOG

app = FastAPI(title="Enterprise Live Translation - Chirp 3 GA + Cloud DLP + MT v3 + Chirp 3 HD TTS")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pipeline = LiveTranslationPipeline()

PROJECT_ID = os.getenv("PROJECT_ID", "gcp-live-translation")
LOCATION = os.getenv("LOCATION", "us-central1")

def resolve_locale(lang: str) -> str:
    """Resolve language identifier to standard STT & TTS BCP-47 locale code."""
    l = lang.lower()
    if l in ["en", "en-us"]:
        return "en-US"
    if l in ["es", "es-us", "es-419", "es-latam"]:
        return "es-US"  # Latin America & US Spanish
    if l in ["es-es", "es-spain"]:
        return "es-ES"  # European Spanish
    if "-" in lang:
        parts = lang.split("-")
        return f"{parts[0].lower()}-{parts[1].upper()}"
    return f"{lang}-{lang.upper()}"

class StreamingSTTWorker:
    """
    Standard Cloud Speech Streaming Worker (Speech v1p1beta1 / v2 Chirp 3).
    Includes real-time Cloud DLP Sensitive Data Protection and PII Scrubbing.
    """
    def __init__(
        self,
        websocket: WebSocket,
        src_lang: str,
        tgt_lang: str,
        speaker_role: str,
        use_glossary: bool,
        use_dlp: bool = True,
        dlp_info_types: Optional[List[str]] = None
    ):
        self.websocket = websocket
        self.src_lang = src_lang
        self.tgt_lang = tgt_lang
        self.speaker_role = speaker_role
        self.use_glossary = use_glossary
        self.use_dlp = use_dlp
        self.dlp_info_types = dlp_info_types
        self.queue = asyncio.Queue()
        self.is_running = True
        self.task = None

    def start(self):
        self.task = asyncio.create_task(self._run_stream())

    async def push_audio(self, pcm_bytes: bytes):
        if self.is_running:
            await self.queue.put(pcm_bytes)

    async def stop(self):
        self.is_running = False
        await self.queue.put(None)
        if self.task and not self.task.done():
            try:
                # Wait up to 3.5 seconds for final speech results to be delivered
                await asyncio.wait_for(asyncio.shield(self.task), timeout=3.5)
            except Exception:
                if not self.task.done():
                    self.task.cancel()

    async def _generator(self):
        while True:
            chunk = await self.queue.get()
            if chunk is None:
                break
            yield speech.StreamingRecognizeRequest(audio_content=chunk)

    async def _run_stream(self):
        try:
            if self.speaker_role == "guest":
                stt_lang = resolve_locale(self.tgt_lang)
                alt_langs = None
            elif self.speaker_role == "ambient":
                stt_lang = "en-US"
                target_stt = resolve_locale(self.tgt_lang)
                alt_langs = [target_stt]
            else:
                stt_lang = resolve_locale(self.src_lang)
                alt_langs = None

            print(f"[StreamingSTT] Starting stream: lang={stt_lang}, alt={alt_langs}, role={self.speaker_role}, dlp={self.use_dlp}", flush=True)
            streaming_config = pipeline.get_streaming_config(lang_code=stt_lang, alternative_lang_codes=alt_langs)
            
            async def request_stream():
                yield speech.StreamingRecognizeRequest(streaming_config=streaming_config)
                async for req in self._generator():
                    yield req

            responses = await pipeline.speech_async_client.streaming_recognize(requests=request_stream())
            
            async for response in responses:
                if not response.results:
                    continue
                result = response.results[0]
                if not result.alternatives:
                    continue
                
                transcript = result.alternatives[0].transcript
                if not transcript or not transcript.strip():
                    continue

                is_final = result.is_final
                detected = getattr(result, 'language_code', stt_lang)
                print(f"[StreamingSTT] STT Response: '{transcript}' (is_final={is_final}, detected={detected})", flush=True)

                if self.speaker_role == "ambient":
                    if detected.lower().startswith(self.tgt_lang.lower()):
                        cur_src = self.tgt_lang
                        cur_tgt = self.src_lang
                        cur_role = "guest"
                    else:
                        cur_src = self.src_lang
                        cur_tgt = self.tgt_lang
                        cur_role = "cast-member"
                elif self.speaker_role == "guest":
                    cur_src = self.tgt_lang
                    cur_tgt = self.src_lang
                    cur_role = "guest"
                else:
                    cur_src = self.src_lang
                    cur_tgt = self.tgt_lang
                    cur_role = "cast-member"

                if not is_final:
                    # Live interim progressive text
                    await self.websocket.send_json({
                        "type": "interim_transcript",
                        "transcript": transcript,
                        "speakerRole": cur_role
                    })
                else:
                    # Final sentence boundary reached!
                    # 1. Cloud DLP Sensitive Data Protection Scrubbing
                    dlp_res = dlp_manager.sanitize_text(
                        transcript,
                        enabled=self.use_dlp,
                        active_info_types=self.dlp_info_types
                    )
                    sanitized_transcript = dlp_res["sanitized_text"]

                    stt_time = 45.0
                    await self.websocket.send_json({
                        "type": "stt_transcript",
                        "transcript": transcript,
                        "sanitized_transcript": sanitized_transcript,
                        "dlp_applied": dlp_res["pii_detected"],
                        "confidence": result.alternatives[0].confidence,
                        "stt_ms": stt_time,
                        "stt_model": "chirp_3 (GA Speech Generation)",
                        "speakerRole": cur_role,
                        "detectedLang": detected,
                        "is_final": True
                    })

                    # Send DLP status event
                    await self.websocket.send_json({
                        "type": "dlp_status",
                        "original_text": transcript,
                        "sanitized_text": sanitized_transcript,
                        "pii_detected": dlp_res["pii_detected"],
                        "findings": dlp_res["findings"],
                        "active_info_types": dlp_res["active_info_types"],
                        "dlp_latency_ms": dlp_res["latency_ms"],
                        "dlp_enabled": self.use_dlp,
                        "speakerRole": cur_role
                    })

                    # 2. Translate sanitized sentence immediately
                    mt_res = pipeline.translate_text(
                        sanitized_transcript,
                        source_lang=cur_src,
                        target_lang=cur_tgt,
                        use_glossary=self.use_glossary
                    )
                    print(f"[StreamingSTT] Translation: '{sanitized_transcript}' -> '{mt_res['translated_text']}'", flush=True)
                    await self.websocket.send_json({
                        "type": "translation_text",
                        "translated_text": mt_res["translated_text"],
                        "glossary_applied": mt_res["glossary_applied"],
                        "translation_ms": mt_res["latency_ms"],
                        "model": mt_res["model"],
                        "speakerRole": cur_role
                    })

                    # 3. Synthesize speech (Audio never says raw credit card or PII aloud)
                    tts_lang_code = f"{cur_tgt}-US" if cur_tgt in ["en", "es"] else f"{cur_tgt}-{cur_tgt.upper()}"
                    tts_res = pipeline.synthesize_speech(mt_res["translated_text"], target_lang=tts_lang_code)
                    
                    total_latency = round(stt_time + dlp_res["latency_ms"] + mt_res["latency_ms"] + tts_res["latency_ms"], 2)
                    await self.websocket.send_json({
                        "type": "audio",
                        "pcm": tts_res["audio_base64"],
                        "sampleRate": 24000,
                        "total_latency_ms": total_latency,
                        "latency_breakdown": {
                            "stt_ms": stt_time,
                            "dlp_ms": dlp_res["latency_ms"],
                            "translation_ms": mt_res["latency_ms"],
                            "tts_ms": tts_res["latency_ms"]
                        },
                        "speakerRole": cur_role
                    })
        except asyncio.CancelledError:
            pass
        except Exception as err:
            import traceback
            print(f"[StreamingSTT] Worker stream error: {err}", flush=True)
            traceback.print_exc()

class GeminiLiveTranscribeWorker:
    """
    Gemini 3.5 Live Transcribe Worker (gemini-3.5-transcribe-live-preview).
    Connects to the Live API session using the official google-genai SDK,
    streams raw 16kHz PCM audio chunks via send_realtime_input,
    receives real-time interim & final transcripts, runs Cloud DLP sanitization,
    and triggers downstream Translation LLM and Neural TTS immediately.
    """
    def __init__(
        self,
        websocket: WebSocket,
        src_lang: str,
        tgt_lang: str,
        speaker_role: str,
        use_glossary: bool,
        use_dlp: bool = True,
        dlp_info_types: Optional[List[str]] = None
    ):
        self.websocket = websocket
        self.src_lang = src_lang
        self.tgt_lang = tgt_lang
        self.speaker_role = speaker_role
        self.use_glossary = use_glossary
        self.use_dlp = use_dlp
        self.dlp_info_types = dlp_info_types
        self.queue = asyncio.Queue()
        self.is_running = True
        self.task = None

    def start(self):
        self.task = asyncio.create_task(self._run_stream())

    async def push_audio(self, pcm_bytes: bytes):
        if self.is_running:
            await self.queue.put(pcm_bytes)

    async def stop(self):
        self.is_running = False
        await self.queue.put(None)
        if self.task and not self.task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self.task), timeout=3.5)
            except Exception:
                if not self.task.done():
                    self.task.cancel()

    async def _run_stream(self):
        try:
            # 1. Configure language codes
            if self.speaker_role == "guest":
                lang_code = f"{self.tgt_lang}-US" if self.tgt_lang in ["en", "es"] else f"{self.tgt_lang}-{self.tgt_lang.upper()}"
                stt_langs = [lang_code]
            elif self.speaker_role == "ambient":
                tgt_code = f"{self.tgt_lang}-US" if self.tgt_lang in ["es"] else f"{self.tgt_lang}-{self.tgt_lang.upper()}"
                stt_langs = ["en-US", tgt_code]
            else:
                lang_code = f"{self.src_lang}-US" if self.src_lang in ["en", "es"] else f"{self.src_lang}-{self.src_lang.upper()}"
                stt_langs = [lang_code]

            print(f"[GeminiLiveTranscribe] Connecting session: langs={stt_langs}, role={self.speaker_role}, dlp={self.use_dlp}", flush=True)

            try:
                client = genai.Client(enterprise=True, project=PROJECT_ID, location=LOCATION)
            except Exception:
                client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)

            config = types.LiveConnectConfig(
                response_modalities=["TEXT"],
                input_audio_transcription=types.AudioTranscriptionConfig(
                    language_codes=stt_langs,
                ),
            )

            async with client.aio.live.connect(model="gemini-3.5-transcribe-live-preview", config=config) as session:
                print(f"[GeminiLiveTranscribe] Connected to gemini-3.5-transcribe-live-preview successfully!", flush=True)

                async def audio_sender():
                    try:
                        while self.is_running:
                            chunk = await self.queue.get()
                            if chunk is None:
                                await session.send_realtime_input(audio_stream_end=True)
                                break
                            await session.send_realtime_input(
                                audio=types.Blob(data=chunk, mime_type="audio/pcm;rate=16000")
                            )
                    except asyncio.CancelledError:
                        pass
                    except Exception as err:
                        print(f"[GeminiLiveTranscribe] Send error: {err}", flush=True)

                async def transcript_receiver():
                    try:
                        async for message in session.receive():
                            if not message.server_content:
                                continue

                            sc = message.server_content

                            # Determine speaker and translation routing
                            cur_role = self.speaker_role
                            if cur_role == "guest":
                                cur_src = self.tgt_lang
                                cur_tgt = self.src_lang
                            else:
                                cur_src = self.src_lang
                                cur_tgt = self.tgt_lang

                            # 1. Interim live transcription
                            if hasattr(sc, "interim_input_transcription") and sc.interim_input_transcription:
                                interim_text = getattr(sc.interim_input_transcription, "text", str(sc.interim_input_transcription))
                                if interim_text and interim_text.strip():
                                    await self.websocket.send_json({
                                        "type": "interim_transcript",
                                        "transcript": interim_text,
                                        "speakerRole": cur_role
                                    })

                            # 2. Final input transcription boundary
                            if hasattr(sc, "input_transcription") and sc.input_transcription:
                                transcript = getattr(sc.input_transcription, "text", str(sc.input_transcription))
                                if transcript and transcript.strip():
                                    # Cloud DLP Sanitization
                                    dlp_res = dlp_manager.sanitize_text(
                                        transcript,
                                        enabled=self.use_dlp,
                                        active_info_types=self.dlp_info_types
                                    )
                                    sanitized_transcript = dlp_res["sanitized_text"]

                                    stt_time = 35.0
                                    await self.websocket.send_json({
                                        "type": "stt_transcript",
                                        "transcript": transcript,
                                        "sanitized_transcript": sanitized_transcript,
                                        "dlp_applied": dlp_res["pii_detected"],
                                        "confidence": 1.0,
                                        "stt_ms": stt_time,
                                        "stt_model": "gemini-3.5-transcribe-live-preview",
                                        "speakerRole": cur_role,
                                        "detectedLang": stt_langs[0],
                                        "is_final": True
                                    })

                                    # Send DLP status event
                                    await self.websocket.send_json({
                                        "type": "dlp_status",
                                        "original_text": transcript,
                                        "sanitized_text": sanitized_transcript,
                                        "pii_detected": dlp_res["pii_detected"],
                                        "findings": dlp_res["findings"],
                                        "active_info_types": dlp_res["active_info_types"],
                                        "dlp_latency_ms": dlp_res["latency_ms"],
                                        "dlp_enabled": self.use_dlp,
                                        "speakerRole": cur_role
                                    })

                                    # Translate sanitized sentence immediately
                                    mt_res = pipeline.translate_text(
                                        sanitized_transcript,
                                        source_lang=cur_src,
                                        target_lang=cur_tgt,
                                        use_glossary=self.use_glossary
                                    )
                                    print(f"[GeminiLiveTranscribe] Translation: '{sanitized_transcript}' -> '{mt_res['translated_text']}'", flush=True)
                                    await self.websocket.send_json({
                                        "type": "translation_text",
                                        "translated_text": mt_res["translated_text"],
                                        "glossary_applied": mt_res["glossary_applied"],
                                        "translation_ms": mt_res["latency_ms"],
                                        "model": mt_res["model"],
                                        "speakerRole": cur_role
                                    })

                                    # Synthesize speech
                                    tts_lang_code = f"{cur_tgt}-US" if cur_tgt in ["en", "es"] else f"{cur_tgt}-{cur_tgt.upper()}"
                                    tts_res = pipeline.synthesize_speech(mt_res["translated_text"], target_lang=tts_lang_code)

                                    total_latency = round(stt_time + dlp_res["latency_ms"] + mt_res["latency_ms"] + tts_res["latency_ms"], 2)
                                    await self.websocket.send_json({
                                        "type": "audio",
                                        "pcm": tts_res["audio_base64"],
                                        "sampleRate": 24000,
                                        "total_latency_ms": total_latency,
                                        "latency_breakdown": {
                                            "stt_ms": stt_time,
                                            "dlp_ms": dlp_res["latency_ms"],
                                            "translation_ms": mt_res["latency_ms"],
                                            "tts_ms": tts_res["latency_ms"]
                                        },
                                        "speakerRole": cur_role
                                    })
                    except asyncio.CancelledError:
                        pass
                    except Exception as err:
                        print(f"[GeminiLiveTranscribe] Receive error: {err}", flush=True)

                await asyncio.gather(audio_sender(), transcript_receiver())

        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[GeminiLiveTranscribe] Live session fallback triggered: {e}", flush=True)
            fallback = StreamingSTTWorker(
                websocket=self.websocket,
                src_lang=self.src_lang,
                tgt_lang=self.tgt_lang,
                speaker_role=self.speaker_role,
                use_glossary=self.use_glossary,
                use_dlp=self.use_dlp,
                dlp_info_types=self.dlp_info_types
            )
            while not self.queue.empty():
                c = await self.queue.get()
                if c is not None:
                    await fallback.push_audio(c)
            fallback.start()
            while self.is_running:
                c = await self.queue.get()
                if c is None:
                    await fallback.stop()
                    break
                await fallback.push_audio(c)

def create_stream_worker(
    websocket: WebSocket,
    src: str,
    tgt: str,
    speaker_role: str,
    use_glossary: bool,
    use_dlp: bool = True,
    dlp_info_types: Optional[List[str]] = None,
    stt_model: Optional[str] = None
):
    stt_engine = stt_model or os.getenv("STT_MODEL", "chirp_3")
    if "gemini" in stt_engine.lower():
        return GeminiLiveTranscribeWorker(
            websocket=websocket,
            src_lang=src,
            tgt_lang=tgt,
            speaker_role=speaker_role,
            use_glossary=use_glossary,
            use_dlp=use_dlp,
            dlp_info_types=dlp_info_types
        )
    return StreamingSTTWorker(
        websocket=websocket,
        src_lang=src,
        tgt_lang=tgt,
        speaker_role=speaker_role,
        use_glossary=use_glossary,
        use_dlp=use_dlp,
        dlp_info_types=dlp_info_types
    )

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
            "speech_to_text": os.getenv("STT_MODEL", "chirp_3"),
            "data_loss_prevention": "Google Cloud Sensitive Data Protection (DLP)",
            "machine_translation": os.getenv("TRANSLATION_MODEL", "general/translation-llm"),
            "text_to_speech": "Google Cloud Chirp 3 HD Voices"
        },
        "endpoints": {
            "health": "/health",
            "swagger_docs": "/docs",
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
        "project_id": os.getenv("PROJECT_ID", "gcp-live-translation"),
        "location": os.getenv("LOCATION", "us-central1"),
        "stt_model": os.getenv("STT_MODEL", "chirp_3"),
        "dlp_enabled": True,
        "translation_model": os.getenv("TRANSLATION_MODEL", "general/translation-llm")
    }

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
        source_lang=req.source_lang,
        target_lang=req.target_lang,
        use_glossary=req.use_glossary,
        model=req.model
    )
    res["dlp"] = dlp_res
    return res

@app.post("/api/translate-audio")
def translate_audio(req: AudioTranslateRequest):
    pcm_bytes = base64.b64decode(req.audio_base64)
    model = req.stt_model or os.getenv("STT_MODEL", "chirp_3")
    stt_lang = f"{req.source_lang}-US" if req.source_lang in ["en", "es"] else f"{req.source_lang}-{req.source_lang.upper()}"
    if model in ["chirp_3", "chirp_2", "chirp"]:
        stt_res = pipeline.transcribe_chirp3(pcm_bytes, lang_code=stt_lang)
    else:
        stt_res = pipeline.transcribe_audio(
            pcm_bytes,
            sample_rate=16000,
            lang_code=stt_lang,
            model=model
        )
    raw_transcript = stt_res.get("transcript", "")
    dlp_res = dlp_manager.sanitize_text(
        text=raw_transcript,
        enabled=req.use_dlp,
        active_info_types=req.dlp_info_types
    )
    mt_res = pipeline.translate_text(
        text=dlp_res["sanitized_text"],
        source_lang=req.source_lang,
        target_lang=req.target_lang,
        use_glossary=req.use_glossary,
        model=req.model
    )
    tts_lang_code = f"{req.target_lang}-US" if req.target_lang in ["en", "es"] else f"{req.target_lang}-{req.target_lang.upper()}"
    tts_res = pipeline.synthesize_speech(mt_res["translated_text"], target_lang=tts_lang_code)
    
    return {
        "stt": stt_res,
        "dlp": dlp_res,
        "translation": mt_res,
        "tts": tts_res,
        "total_latency_ms": round(stt_res["latency_ms"] + dlp_res["latency_ms"] + mt_res["latency_ms"] + tts_res["latency_ms"], 2)
    }

@app.post("/api/upload-audio")
async def upload_audio(
    file: UploadFile = File(...),
    source_lang: str = Form("en"),
    target_lang: str = Form("es"),
    use_glossary: bool = Form(True),
    use_dlp: bool = Form(True)
):
    pcm_bytes = await file.read()
    stt_res = pipeline.transcribe_audio(
        pcm_bytes,
        sample_rate=16000,
        lang_code=f"{source_lang}-US" if source_lang in ["en", "es"] else f"{source_lang}-{source_lang.upper()}"
    )
    raw_transcript = stt_res.get("transcript", "")
    dlp_res = dlp_manager.sanitize_text(
        text=raw_transcript,
        enabled=use_dlp
    )
    mt_res = pipeline.translate_text(
        text=dlp_res["sanitized_text"],
        source_lang=source_lang,
        target_lang=target_lang,
        use_glossary=use_glossary
    )
    tts_lang_code = f"{target_lang}-US" if target_lang in ["en", "es"] else f"{target_lang}-{target_lang.upper()}"
    tts_res = pipeline.synthesize_speech(mt_res["translated_text"], target_lang=tts_lang_code)
    
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
    await websocket.accept()
    print("[PipelineWS] Client connected", flush=True)
    active_stream_worker = None

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            src = data.get("sourceLang", "en")
            tgt = data.get("targetLang", "es")
            use_glossary = data.get("useGlossary", True)
            speaker_role = data.get("speakerRole", "cast-member")
            use_dlp = data.get("useDlp", True)
            dlp_info_types = data.get("dlpInfoTypes", None)

            if msg_type != "audio_chunk":
                print(f"[PipelineWS] Msg: {msg_type}, speaker={speaker_role}, src={src}, tgt={tgt}, dlp={use_dlp}", flush=True)

            if msg_type == "audio_stream_start":
                if active_stream_worker:
                    await active_stream_worker.stop()
                active_stream_worker = create_stream_worker(
                    websocket=websocket,
                    src=src,
                    tgt=tgt,
                    speaker_role=speaker_role,
                    use_glossary=use_glossary,
                    use_dlp=use_dlp,
                    dlp_info_types=dlp_info_types
                )
                active_stream_worker.start()
                await websocket.send_json({"type": "stream_started"})

            elif msg_type == "audio_chunk" and "pcm" in data:
                pcm_bytes = base64.b64decode(data["pcm"])
                if not active_stream_worker or not active_stream_worker.is_running:
                    active_stream_worker = create_stream_worker(
                        websocket=websocket,
                        src=src,
                        tgt=tgt,
                        speaker_role=speaker_role,
                        use_glossary=use_glossary,
                        use_dlp=use_dlp,
                        dlp_info_types=dlp_info_types
                    )
                    active_stream_worker.start()
                await active_stream_worker.push_audio(pcm_bytes)

            elif msg_type == "audio_stream_end":
                if active_stream_worker:
                    await active_stream_worker.stop()
                    active_stream_worker = None
                await websocket.send_json({"type": "turn_complete"})

            elif msg_type == "audio" and "pcm" in data:
                pcm_bytes = base64.b64decode(data["pcm"])
                
                # Determine language config based on speaker role
                if speaker_role == "guest":
                    stt_lang = resolve_locale(tgt)
                    src_lang = tgt.split("-")[0].lower()
                    tgt_lang = src.split("-")[0].lower()
                    alt_langs = None
                elif speaker_role == "ambient":
                    stt_lang = "en-US"
                    target_stt = resolve_locale(tgt)
                    alt_langs = [target_stt]
                    src_lang = src.split("-")[0].lower()
                    tgt_lang = tgt.split("-")[0].lower()
                else: # Cast Member
                    stt_lang = resolve_locale(src)
                    src_lang = src.split("-")[0].lower()
                    tgt_lang = tgt.split("-")[0].lower()
                    alt_langs = None

                req_model = data.get("sttModel") or os.getenv("STT_MODEL", "chirp_3")
                # 1. Real-time STT with Chirp 3 or latest_short
                if req_model in ["chirp_3", "chirp_2", "chirp"] and not alt_langs:
                    stt_res = pipeline.transcribe_chirp3(pcm_bytes, lang_code=stt_lang)
                else:
                    stt_res = pipeline.transcribe_audio(pcm_bytes, sample_rate=16000, lang_code=stt_lang, alternative_lang_codes=alt_langs)
                
                # If ambient continuous mode, adapt direction dynamically
                if speaker_role == "ambient":
                    detected = stt_res.get("detected_lang", "en-US")
                    if detected.lower().startswith(tgt.lower()):
                        src_lang = tgt
                        tgt_lang = src
                        effective_role = "guest"
                    else:
                        src_lang = src
                        tgt_lang = tgt
                        effective_role = "cast-member"
                else:
                    effective_role = speaker_role

                if not stt_res["transcript"]:
                    await websocket.send_json({"type": "no_speech", "message": "No audible speech detected"})
                    continue

                # 2. Cloud DLP Sanitization
                dlp_res = dlp_manager.sanitize_text(
                    stt_res["transcript"],
                    enabled=use_dlp,
                    active_info_types=dlp_info_types
                )
                sanitized_transcript = dlp_res["sanitized_text"]

                # Push STT transcript to client
                await websocket.send_json({
                    "type": "stt_transcript",
                    "transcript": stt_res["transcript"],
                    "sanitized_transcript": sanitized_transcript,
                    "dlp_applied": dlp_res["pii_detected"],
                    "confidence": stt_res["confidence"],
                    "stt_ms": stt_res["latency_ms"],
                    "stt_model": stt_res.get("stt_model", "chirp_3 (GA Speech Generation)"),
                    "speakerRole": effective_role,
                    "detectedLang": stt_res.get("detected_lang")
                })

                # Push DLP status event
                await websocket.send_json({
                    "type": "dlp_status",
                    "original_text": stt_res["transcript"],
                    "sanitized_text": sanitized_transcript,
                    "pii_detected": dlp_res["pii_detected"],
                    "findings": dlp_res["findings"],
                    "active_info_types": dlp_res["active_info_types"],
                    "dlp_latency_ms": dlp_res["latency_ms"],
                    "dlp_enabled": use_dlp,
                    "speakerRole": effective_role
                })

                # 3. Real-time Translation with Translation LLM (on sanitized text)
                mt_res = pipeline.translate_text(
                    sanitized_transcript,
                    source_lang=src_lang,
                    target_lang=tgt_lang,
                    use_glossary=use_glossary
                )

                # Push Translation text immediately
                await websocket.send_json({
                    "type": "translation_text",
                    "translated_text": mt_res["translated_text"],
                    "glossary_applied": mt_res["glossary_applied"],
                    "translation_ms": mt_res["latency_ms"],
                    "model": mt_res["model"],
                    "speakerRole": effective_role
                })

                # 4. High Fidelity Speech Synthesis
                active_target = tgt if effective_role in ["cast-member", "ambient"] else src
                tts_lang_code = resolve_locale(active_target)
                tts_res = pipeline.synthesize_speech(mt_res["translated_text"], target_lang=tts_lang_code)
                
                total_latency = round(stt_res["latency_ms"] + dlp_res["latency_ms"] + mt_res["latency_ms"] + tts_res["latency_ms"], 2)
                
                # Push audio stream for instant playback
                await websocket.send_json({
                    "type": "audio",
                    "pcm": tts_res["audio_base64"],
                    "sampleRate": 24000,
                    "total_latency_ms": total_latency,
                    "latency_breakdown": {
                        "stt_ms": stt_res["latency_ms"],
                        "dlp_ms": dlp_res["latency_ms"],
                        "translation_ms": mt_res["latency_ms"],
                        "tts_ms": tts_res["latency_ms"]
                    },
                    "speakerRole": effective_role
                })

            elif data.get("type") == "text" and "text" in data:
                text_input = data["text"]
                
                # 1. Cloud DLP Sanitization
                dlp_res = dlp_manager.sanitize_text(
                    text_input,
                    enabled=use_dlp,
                    active_info_types=dlp_info_types
                )
                sanitized_text = dlp_res["sanitized_text"]

                # Send immediate STT confirmation
                await websocket.send_json({
                    "type": "stt_transcript",
                    "transcript": text_input,
                    "sanitized_transcript": sanitized_text,
                    "dlp_applied": dlp_res["pii_detected"],
                    "confidence": 1.0,
                    "stt_ms": 0.0,
                    "speakerRole": speaker_role
                })

                # Send DLP status event
                await websocket.send_json({
                    "type": "dlp_status",
                    "original_text": text_input,
                    "sanitized_text": sanitized_text,
                    "pii_detected": dlp_res["pii_detected"],
                    "findings": dlp_res["findings"],
                    "active_info_types": dlp_res["active_info_types"],
                    "dlp_latency_ms": dlp_res["latency_ms"],
                    "dlp_enabled": use_dlp,
                    "speakerRole": speaker_role
                })

                # 2. Translation on sanitized text
                mt_res = pipeline.translate_text(
                    sanitized_text,
                    source_lang=src,
                    target_lang=tgt,
                    use_glossary=use_glossary
                )

                await websocket.send_json({
                    "type": "translation_text",
                    "translated_text": mt_res["translated_text"],
                    "glossary_applied": mt_res["glossary_applied"],
                    "translation_ms": mt_res["latency_ms"],
                    "model": mt_res["model"],
                    "speakerRole": speaker_role
                })

                # 3. TTS
                tts_lang_code = f"{tgt}-US" if tgt == "es" else f"{tgt}-{tgt.upper()}"
                tts_res = pipeline.synthesize_speech(mt_res["translated_text"], target_lang=tts_lang_code)

                total_latency = round(dlp_res["latency_ms"] + mt_res["latency_ms"] + tts_res["latency_ms"], 2)

                await websocket.send_json({
                    "type": "audio",
                    "pcm": tts_res["audio_base64"],
                    "sampleRate": 24000,
                    "total_latency_ms": total_latency,
                    "latency_breakdown": {
                        "stt_ms": 0.0,
                        "dlp_ms": dlp_res["latency_ms"],
                        "translation_ms": mt_res["latency_ms"],
                        "tts_ms": tts_res["latency_ms"]
                    },
                    "speakerRole": speaker_role
                })
    except WebSocketDisconnect:
        print("[PipelineWS] Client disconnected", flush=True)
    except Exception as e:
        print(f"[PipelineWS] Error: {e}", flush=True)
        await websocket.close()

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8081"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
