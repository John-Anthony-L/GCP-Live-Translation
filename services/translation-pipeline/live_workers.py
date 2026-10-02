"""Live streaming workers for the /ws/stream-translate WebSocket.

Engines
-------
- chirp_3                    Chirp 3 StreamingRecognize (Speech V2) -> DLP -> Translation v3 -> Chirp 3 HD TTS
- gemini-3.5-transcribe      Gemini 3.5 Transcribe Live            -> DLP -> Translation v3 -> Chirp 3 HD TTS
- gemini-3.5-live-translate  Gemini 3.5 Live Translate (speech-to-speech, push-to-talk only)
- gemini-3.8-live            Gemini 3.8 Live with a strict interpreter system prompt (speech-to-speech)

Cast Member Language anchor
---------------------------
The cast member's language is fixed. Guest speech is translated into the cast language; cast
speech is translated into the current guest language. With Smart Guest Language Detection on,
guest turns are transcribed in language-agnostic mode (Chirp 3 language_codes=["auto"], Gemini
auto-detect) and the detected language becomes the new guest language.
"""
import asyncio
import base64
import json
import os
import time
import traceback
from array import array
from collections import Counter
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from fastapi import WebSocket
from google import genai
from google.genai import types
from google.api_core.client_options import ClientOptions
from google.cloud import speech_v2

from dlp_helper import dlp_manager, DLP_INFO_TYPE_CATALOG
from languages import lang_info, resolve_language, same_language
from pipeline import LiveTranslationPipeline, PROJECT_ID, LOCATION, CHIRP_REGION

pipeline = LiveTranslationPipeline()

ENGINE_CHIRP3 = "chirp_3"
ENGINE_GEMINI_TRANSCRIBE = "gemini-3.5-transcribe"
ENGINE_LIVE_TRANSLATE = "gemini-3.5-live-translate"
ENGINE_LIVE_38 = "gemini-3.8-live"
SPEECH_TO_SPEECH_ENGINES = (ENGINE_LIVE_TRANSLATE, ENGINE_LIVE_38)

GEMINI_TRANSCRIBE_MODEL = os.getenv("GEMINI_TRANSCRIBE_MODEL", "gemini-3.5-transcribe-live-preview")
GEMINI_TRANSCRIBE_LOCATION = os.getenv("GEMINI_TRANSCRIBE_LOCATION", "global")
GEMINI_LIVE_TRANSLATE_MODEL = os.getenv("GEMINI_LIVE_TRANSLATE_MODEL", "gemini-3.5-live-translate-preview")
GEMINI_LIVE_TRANSLATE_LOCATION = os.getenv("GEMINI_LIVE_TRANSLATE_LOCATION", "global")
GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.8-live")
GEMINI_LIVE_LOCATION = os.getenv("GEMINI_LIVE_LOCATION", LOCATION)

MAX_STREAM_CHUNK_BYTES = 15360          # keep each StreamingRecognize audio message well under the API limit
MAX_REPLAY_BYTES = 16000 * 2 * 30       # 30s of 16kHz PCM kept for replay after a stream error
AUDIO_FLUSH_BYTES = int(24000 * 2 * 0.4)  # forward Gemini output audio in ~400ms batches


# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------
@dataclass
class SessionState:
    cast_lang: str = "en"
    guest_lang: str = "es"
    smart_detect: bool = True
    engine: str = ENGINE_CHIRP3
    use_glossary: bool = True
    use_dlp: bool = True
    dlp_info_types: Optional[List[str]] = None
    voice: str = "Aoede"
    guest_detected: bool = False

    def update_from_message(self, data: Dict[str, Any]) -> None:
        role = data.get("speakerRole", "cast-member")
        if "castLang" in data or "guestLang" in data:
            self.cast_lang = resolve_language(data.get("castLang")) or self.cast_lang
            new_guest = resolve_language(data.get("guestLang")) or self.guest_lang
        else:
            # Backward compatibility with sourceLang/targetLang messages (swapped for guest turns)
            src, tgt = data.get("sourceLang"), data.get("targetLang")
            if role == "guest":
                src, tgt = tgt, src
            self.cast_lang = resolve_language(src) or self.cast_lang
            new_guest = resolve_language(tgt) or self.guest_lang
        if new_guest != self.guest_lang:
            self.guest_lang = new_guest
            self.guest_detected = False
        if "smartDetect" in data:
            self.smart_detect = bool(data.get("smartDetect"))
        engine = data.get("engine") or data.get("sttModel")
        if engine:
            self.engine = engine
        if "useGlossary" in data:
            self.use_glossary = bool(data.get("useGlossary"))
        if "useDlp" in data:
            self.use_dlp = bool(data.get("useDlp"))
        if "dlpInfoTypes" in data:
            self.dlp_info_types = data.get("dlpInfoTypes")
        if data.get("voice"):
            self.voice = data.get("voice")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def safe_send(ws: WebSocket, payload: Dict[str, Any]) -> None:
    try:
        await ws.send_json(payload)
    except Exception:
        pass


def _dedupe(items: List[str]) -> List[str]:
    out: List[str] = []
    for item in items:
        if item and item not in out:
            out.append(item)
    return out


def _split_audio(chunk: bytes, size: int = MAX_STREAM_CHUNK_BYTES):
    for i in range(0, len(chunk), size):
        yield chunk[i:i + size]


def passes_stability_guard(text: str) -> bool:
    """Only switch the guest language on utterances with 2+ words (or 2+ CJK characters)."""
    t = (text or "").strip()
    cjk = sum(1 for ch in t if "\u3040" <= ch <= "\u30ff" or "\u4e00" <= ch <= "\u9fff" or "\uac00" <= ch <= "\ud7af")
    return cjk >= 2 or len(t.split()) >= 2


def apply_guest_detection(state: SessionState, detected: Optional[str], transcript: str) -> Optional[Dict[str, Any]]:
    """Update the sticky guest language from a detection. Returns an event payload if it was updated."""
    if not state.smart_detect or not detected:
        return None
    key = resolve_language(detected)
    if not key or same_language(key, state.cast_lang):
        return None
    if not passes_stability_guard(transcript):
        return None
    if key == state.guest_lang and state.guest_detected:
        return None
    changed = key != state.guest_lang
    state.guest_lang = key
    state.guest_detected = True
    info = lang_info(key)
    return {
        "type": "guest_language_detected",
        "lang": key,
        "label": info["label"],
        "flag": info["flag"],
        "raw": detected,
        "changed": changed,
    }


def route_turn(state: SessionState, role: str, detected: Optional[str]):
    """Resolve (effective_role, source_lang_key, target_lang_key) with the cast member language as anchor."""
    cast = state.cast_lang
    det = resolve_language(detected) if detected else None
    if role == "cast-member":
        return "cast-member", cast, state.guest_lang
    if role == "guest":
        src = det if (state.smart_detect and det) else state.guest_lang
        return "guest", src, cast
    # ambient / continuous: whoever is not speaking the cast language is the guest
    if det and same_language(det, cast):
        return "cast-member", cast, state.guest_lang
    return "guest", (det or state.guest_lang), cast


async def process_final_turn(
    ws: WebSocket,
    state: SessionState,
    *,
    turn_id: Optional[str],
    transcript: str,
    role: str,
    detected_raw: Optional[str],
    stt_ms: float,
    stt_model: str,
    confidence: Optional[float] = None,
) -> None:
    """DLP -> Translation v3 -> Chirp 3 HD TTS for one finalized transcript, emitting the standard WS events."""
    try:
        if role != "cast-member":
            event = apply_guest_detection(state, detected_raw, transcript)
            if event:
                await safe_send(ws, event)
        eff_role, src, tgt = route_turn(state, role, detected_raw)
        src_info, tgt_info = lang_info(src), lang_info(tgt)

        dlp_res = await asyncio.to_thread(
            dlp_manager.sanitize_text, transcript, enabled=state.use_dlp, active_info_types=state.dlp_info_types
        )
        sanitized = dlp_res["sanitized_text"]

        await safe_send(ws, {
            "type": "stt_transcript",
            "turnId": turn_id,
            "transcript": transcript,
            "sanitized_transcript": sanitized,
            "dlp_applied": dlp_res["pii_detected"],
            "confidence": confidence,
            "stt_ms": round(stt_ms, 1),
            "stt_model": stt_model,
            "speakerRole": eff_role,
            "detectedLang": detected_raw or src_info["stt"],
            "srcLang": src_info["key"],
            "tgtLang": tgt_info["key"],
            "guestLang": state.guest_lang,
            "is_final": True,
        })
        await safe_send(ws, {
            "type": "dlp_status",
            "turnId": turn_id,
            "original_text": transcript,
            "sanitized_text": sanitized,
            "pii_detected": dlp_res["pii_detected"],
            "findings": dlp_res["findings"],
            "active_info_types": dlp_res["active_info_types"],
            "dlp_latency_ms": dlp_res["latency_ms"],
            "dlp_enabled": state.use_dlp,
            "speakerRole": eff_role,
        })

        if same_language(src, tgt):
            mt_res = {"translated_text": sanitized, "glossary_applied": False, "latency_ms": 0.0, "model": "passthrough (same language)"}
        else:
            mt_res = await asyncio.to_thread(
                pipeline.translate_text, sanitized,
                source_lang=src_info["mt"], target_lang=tgt_info["mt"], use_glossary=state.use_glossary,
            )
        await safe_send(ws, {
            "type": "translation_text",
            "turnId": turn_id,
            "translated_text": mt_res["translated_text"],
            "glossary_applied": mt_res["glossary_applied"],
            "translation_ms": mt_res["latency_ms"],
            "model": mt_res["model"],
            "speakerRole": eff_role,
            "srcLang": src_info["key"],
            "tgtLang": tgt_info["key"],
        })

        tts_res = await asyncio.to_thread(
            pipeline.synthesize_speech, mt_res["translated_text"], target_lang=tgt_info["tts"], voice=state.voice
        )
        total_latency = round(stt_ms + dlp_res["latency_ms"] + mt_res["latency_ms"] + tts_res["latency_ms"], 2)
        await safe_send(ws, {
            "type": "audio",
            "turnId": turn_id,
            "pcm": tts_res["audio_base64"],
            "sampleRate": 24000,
            "voice": tts_res.get("voice"),
            "total_latency_ms": total_latency,
            "latency_breakdown": {
                "stt_ms": round(stt_ms, 1),
                "dlp_ms": dlp_res["latency_ms"],
                "translation_ms": mt_res["latency_ms"],
                "tts_ms": tts_res["latency_ms"],
            },
            "speakerRole": eff_role,
        })
    except Exception as err:
        traceback.print_exc()
        await safe_send(ws, {"type": "error", "turnId": turn_id, "message": f"Turn processing failed: {err}"})


async def process_text_turn(ws: WebSocket, state: SessionState, text: str, role: str, turn_id: Optional[str]) -> None:
    if role == "cast-member":
        detected = lang_info(state.cast_lang)["stt"]
    elif state.smart_detect:
        det = await asyncio.to_thread(pipeline.detect_language, text)
        detected = det["language_code"] or lang_info(state.guest_lang)["stt"]
    else:
        detected = lang_info(state.guest_lang)["stt"]
    await process_final_turn(
        ws, state, turn_id=turn_id, transcript=text, role=role,
        detected_raw=detected, stt_ms=0.0, stt_model="text input",
    )


def chirp3_language_codes(state: SessionState, role: str) -> List[str]:
    cast = lang_info(state.cast_lang)["stt"]
    guest = lang_info(state.guest_lang)["stt"]
    if role == "cast-member":
        return [cast]
    if role == "guest":
        return ["auto"] if state.smart_detect else [guest]
    return ["auto"] if state.smart_detect else _dedupe([cast, guest])


def _pcm_is_audible(pcm: bytes, threshold: int = 120) -> bool:
    """Return True if 16-bit PCM has any sample above `threshold` (filters 0x0000 digital silence frames)."""
    n = len(pcm) // 2 * 2
    if n <= 0:
        return False
    samples = array("h", pcm[:n])
    return any(s > threshold or s < -threshold for s in samples)


async def process_batch_audio_turn(ws: WebSocket, state: SessionState, pcm: bytes, role: str, turn_id: Optional[str]) -> None:
    """One-shot utterance handler for `{type: "audio"}` WebSocket messages across all configured engines."""
    tid = turn_id or "t-audio"
    engine = (state.engine or ENGINE_CHIRP3).lower()
    if engine in (ENGINE_LIVE_TRANSLATE, ENGINE_LIVE_38):
        worker_cls = GeminiLiveTranslateWorker if engine == ENGINE_LIVE_TRANSLATE else GeminiLive38Worker
        worker = worker_cls(
            ws, state, "cast-member" if role == "ambient" and engine == ENGINE_LIVE_TRANSLATE else role,
            tid, initial_chunks=_split_audio(pcm, 3200), input_done=True,
        )
        await worker.run()
        return

    if "gemini" in engine:
        codes = None if (state.smart_detect and role != "cast-member") else chirp3_language_codes(state, role)
        stt_res = await asyncio.to_thread(pipeline.transcribe_gemini35, pcm, codes)
        default_model = GEMINI_TRANSCRIBE_MODEL
    else:
        codes = chirp3_language_codes(state, role)
        stt_res = await asyncio.to_thread(pipeline.transcribe_chirp3, pcm, codes)
        default_model = "chirp_3 (Speech v2)"

    if not stt_res.get("transcript"):
        await safe_send(ws, {"type": "no_speech", "turnId": tid, "message": "No audible speech detected"})
        return
    await process_final_turn(
        ws, state, turn_id=tid, transcript=stt_res["transcript"], role=role,
        detected_raw=stt_res.get("detected_lang"), stt_ms=stt_res["latency_ms"],
        stt_model=stt_res.get("stt_model", default_model), confidence=stt_res.get("confidence"),
    )


_speech_v2_async_client = None


def get_speech_v2_async_client() -> speech_v2.SpeechAsyncClient:
    """Created lazily so the gRPC aio channel binds to the running event loop."""
    global _speech_v2_async_client
    if _speech_v2_async_client is None:
        _speech_v2_async_client = speech_v2.SpeechAsyncClient(
            client_options=ClientOptions(api_endpoint=f"{CHIRP_REGION}-speech.googleapis.com")
        )
    return _speech_v2_async_client


_genai_clients: Dict[str, genai.Client] = {}


def get_genai_client(location: str) -> genai.Client:
    if location not in _genai_clients:
        try:
            _genai_clients[location] = genai.Client(enterprise=True, project=PROJECT_ID, location=location)
        except Exception:
            _genai_clients[location] = genai.Client(vertexai=True, project=PROJECT_ID, location=location)
    return _genai_clients[location]


def friendly_gemini_error(model: str, location: str, err: Exception) -> str:
    msg = str(err)
    if "403" in msg or "PERMISSION_DENIED" in msg.upper():
        return (f"{model} ({location}): permission denied. The project may need Preview access/allowlisting "
                f"or Vertex AI permissions. Details: {msg[:240]}")
    if "404" in msg or "NOT_FOUND" in msg.upper():
        return f"{model} is not available in location '{location}'. Details: {msg[:240]}"
    return f"{model} ({location}) error: {msg[:300]}"


_glossary_cache: Optional[Dict[str, Any]] = None


def load_brand_glossary() -> Dict[str, Any]:
    global _glossary_cache
    if _glossary_cache is not None:
        return _glossary_cache
    here = os.path.dirname(os.path.abspath(__file__))
    for path in ("/app/glossaries/enterprise_parks_glossary.json",
                 os.path.join(here, "../../glossaries/enterprise_parks_glossary.json"),
                 os.path.join(here, "enterprise_parks_glossary.json")):
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    _glossary_cache = json.load(f)
                    return _glossary_cache
            except Exception as e:
                print(f"[Glossary] Failed to load {path}: {e}", flush=True)
    _glossary_cache = {"brand_rules": [], "terms": []}
    return _glossary_cache


def glossary_prompt(target_keys: List[str]) -> str:
    g = load_brand_glossary()
    bases = _dedupe([lang_info(k)["mt"].split("-")[0] for k in target_keys])
    lines = []
    for rule in g.get("brand_rules", []):
        lines.append(f"- {rule}")
    for term in g.get("terms", []):
        en = term.get("en")
        if not en:
            continue
        translations = term.get("translations", {})
        parts = [f"{b}: {translations[b]}" for b in bases if b in translations]
        suffix = " (keep original)" if term.get("keep_original") else ""
        lines.append(f"- {en}{suffix}" + (f" -> {'; '.join(parts)}" if parts else ""))
    return "\n".join(lines)


def dlp_prompt(state: SessionState) -> str:
    """Build in-model DLP redaction instructions for Gemini 3.8 Live spoken audio."""
    if not state.use_dlp:
        return "- Preserve names, numbers, times, and prices exactly.\n"

    active = state.dlp_info_types
    if active is None:
        active = [k for k, v in DLP_INFO_TYPE_CATALOG.items() if v.get("defaultEnabled", True)]
    if not active:
        return "- Preserve names, numbers, times, and prices exactly.\n"

    rules = []
    for info_type in active:
        meta = DLP_INFO_TYPE_CATALOG.get(info_type)
        if meta:
            rules.append(
                f"  * {meta['displayName']} ({meta['description']}): never speak this value aloud; "
                f"replace it in your spoken translation with the word 'redacted' (in the target language)."
            )
    if not rules:
        return "- Preserve names, numbers, times, and prices exactly.\n"

    preserve_note = (
        "- Preserve non-sensitive times, wait times, and prices.\n"
        if "PERSON_NAME" in active
        else "- Preserve guest names, non-sensitive times, wait times, and prices.\n"
    )
    return (
        f"{preserve_note}"
        "- STRICT PRIVACY / DLP REDACTION IN SPOKEN AUDIO: Never repeat any of the following sensitive PII/PCI identifiers aloud in your translation:\n"
        + "\n".join(rules)
        + "\n"
    )


# ---------------------------------------------------------------------------
# Worker base
# ---------------------------------------------------------------------------
class BaseStreamWorker:
    engine_label = "stream"

    def __init__(
        self,
        ws: Optional[WebSocket] = None,
        state: Optional[SessionState] = None,
        role: str = "cast-member",
        turn_id: str = "t0",
        queue: Optional[asyncio.Queue] = None,
        initial_chunks: Optional[List[bytes]] = None,
        input_done: bool = False,
        parent: Optional["BaseStreamWorker"] = None,
        *,
        # Backward-compatible keyword arguments from previous commit
        websocket: Optional[WebSocket] = None,
        src: Optional[str] = None,
        tgt: Optional[str] = None,
        src_lang: Optional[str] = None,
        tgt_lang: Optional[str] = None,
        speaker_role: Optional[str] = None,
        use_glossary: bool = True,
        use_dlp: bool = True,
        dlp_info_types: Optional[List[str]] = None,
    ):
        actual_ws = ws or websocket
        if actual_ws is None:
            raise ValueError("WebSocket instance is required")
        if state is None:
            s_lang = resolve_language(src or src_lang) or "en"
            t_lang = resolve_language(tgt or tgt_lang) or "es"
            eff_role = speaker_role or role or "cast-member"
            cast_l = t_lang if eff_role == "guest" else s_lang
            guest_l = s_lang if eff_role == "guest" else t_lang
            state = SessionState(
                cast_lang=cast_l,
                guest_lang=guest_l,
                smart_detect=False,
                use_glossary=use_glossary,
                use_dlp=use_dlp,
                dlp_info_types=dlp_info_types,
            )
        self.ws = actual_ws
        self.state = state
        self.role = speaker_role or role
        self.turn_id = turn_id
        self.queue: asyncio.Queue = queue or asyncio.Queue()
        self.initial_chunks = list(initial_chunks or [])
        self.input_done = input_done
        self.parent = parent
        self.is_running = True
        self.task: Optional[asyncio.Task] = None
        self._stop_time: Optional[float] = None
        self.last_chunk_time: Optional[float] = None
        self.segment_idx = 0

    @property
    def is_ptt(self) -> bool:
        return self.role in ("cast-member", "guest")

    @property
    def stop_time(self) -> Optional[float]:
        if self._stop_time is None and self.parent is not None:
            return self.parent.stop_time
        return self._stop_time

    def current_segment_id(self) -> str:
        return self.turn_id if self.is_ptt else f"{self.turn_id}-{self.segment_idx + 1}"

    def advance_segment(self) -> None:
        self.segment_idx += 1

    def start(self) -> None:
        self.task = asyncio.create_task(self._safe_run())

    async def _safe_run(self) -> None:
        try:
            await self.run()
        except asyncio.CancelledError:
            pass
        except Exception as err:
            traceback.print_exc()
            await safe_send(self.ws, {"type": "error", "turnId": self.turn_id, "message": f"{self.engine_label}: {err}"})

    async def run(self) -> None:  # pragma: no cover - implemented by subclasses
        raise NotImplementedError

    async def push_audio(self, pcm_bytes: bytes) -> None:
        if self.is_running:
            self.last_chunk_time = time.time()
            await self.queue.put(pcm_bytes)

    async def stop(self, timeout: float = 25.0) -> None:
        """Signal end of audio and wait for the worker to finish (transcript, translation, audio)."""
        if self._stop_time is None:
            self._stop_time = time.time()
        if self.is_running:
            self.is_running = False
            await self.queue.put(None)
        if self.task and not self.task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self.task), timeout=timeout)
            except Exception:
                if not self.task.done():
                    self.task.cancel()

    def cancel(self) -> None:
        self.is_running = False
        if self.task and not self.task.done():
            self.task.cancel()


# ---------------------------------------------------------------------------
# Chirp 3 streaming (Speech-to-Text V2, no V1 fallback)
# ---------------------------------------------------------------------------
class Chirp3StreamWorker(BaseStreamWorker):
    engine_label = "chirp_3 (Speech v2 streaming)"

    def _attempts(self):
        codes = chirp3_language_codes(self.state, self.role)
        # Speech V2 chirp_3 only supports adaptation (biasing_phrases) with a single explicit locale (not "auto")
        if "auto" not in codes and len(codes) == 1:
            return [(codes, True), (codes, False)]
        attempts = [(codes, False)]
        if "auto" in codes:
            candidates = _dedupe([lang_info(self.state.guest_lang)["stt"], lang_info(self.state.cast_lang)["stt"]])
            attempts.append((candidates, False))
        return attempts

    def _remember(self, chunk: bytes) -> None:
        self.replay.append(chunk)
        self.replay_bytes += len(chunk)
        while self.replay_bytes > MAX_REPLAY_BYTES and self.replay:
            self.replay_bytes -= len(self.replay.pop(0))

    async def _requests(self, cfg_req, replay: List[bytes], stop_evt: asyncio.Event):
        yield cfg_req
        for chunk in replay:
            if stop_evt.is_set():
                return
            for piece in _split_audio(chunk):
                yield speech_v2.StreamingRecognizeRequest(audio=piece)
        while not self.input_done and not stop_evt.is_set():
            try:
                chunk = await asyncio.wait_for(self.queue.get(), timeout=0.25)
            except asyncio.TimeoutError:
                continue
            if chunk is None:
                self.input_done = True
                break
            self._remember(chunk)
            for piece in _split_audio(chunk):
                yield speech_v2.StreamingRecognizeRequest(audio=piece)

    def _finalization_ms(self) -> float:
        ref = self.speech_end_time or self.stop_time or self.last_chunk_time
        self.speech_end_time = None
        return max(0.0, (time.time() - ref) * 1000) if ref else 0.0

    async def _handle_response(self, resp) -> bool:
        event = resp.speech_event_type
        SpeechEvent = speech_v2.StreamingRecognizeResponse.SpeechEventType
        if event == SpeechEvent.SPEECH_ACTIVITY_END:
            self.speech_end_time = time.time()

        got_text = False
        for result in resp.results:
            if not result.alternatives:
                continue
            text = result.alternatives[0].transcript
            if not text or not text.strip():
                continue
            got_text = True
            if not result.is_final:
                self.last_interim = text.strip()
                shown = (" ".join(f["text"] for f in self.ptt_finals) + " " + text).strip() if self.is_ptt else text
                await safe_send(self.ws, {
                    "type": "interim_transcript", "turnId": self.current_segment_id(),
                    "transcript": shown, "speakerRole": self.role,
                })
                continue

            # Final result for this utterance
            self.last_interim = ""
            self.replay, self.replay_bytes = [], 0
            codes = self.active_codes
            detected = result.language_code or (codes[0] if codes and codes[0] != "auto" else None)
            final = {"text": text.strip(), "lang": detected, "confidence": result.alternatives[0].confidence}
            if self.is_ptt:
                self.ptt_finals.append(final)
                await safe_send(self.ws, {
                    "type": "interim_transcript", "turnId": self.turn_id,
                    "transcript": " ".join(f["text"] for f in self.ptt_finals), "speakerRole": self.role,
                })
            else:
                seg_id = self.current_segment_id()
                self.advance_segment()
                await self.turns.put({**final, "turn_id": seg_id, "stt_ms": self._finalization_ms()})
        return got_text

    async def _consume_turns(self) -> None:
        while True:
            item = await self.turns.get()
            if item is None:
                break
            await process_final_turn(
                self.ws, self.state, turn_id=item["turn_id"], transcript=item["text"], role=self.role,
                detected_raw=item["lang"], stt_ms=item["stt_ms"], stt_model=self.engine_label,
                confidence=item["confidence"],
            )

    async def run(self) -> None:
        self.replay: List[bytes] = []
        self.replay_bytes = 0
        for chunk in self.initial_chunks:
            self._remember(chunk)
        self.ptt_finals: List[Dict[str, Any]] = []
        self.last_interim: str = ""
        self.speech_end_time: Optional[float] = None
        self.turns: asyncio.Queue = asyncio.Queue()
        self.active_codes: List[str] = []
        consumer = asyncio.create_task(self._consume_turns())

        attempts = self._attempts()
        idx, failures = 0, 0
        client = get_speech_v2_async_client()
        try:
            while True:
                codes, use_adaptation = attempts[idx]
                self.active_codes = codes
                got_transcript = False
                stop_evt = asyncio.Event()
                try:
                    cfg_req = pipeline.build_chirp3_streaming_request(codes, use_adaptation=use_adaptation)
                    print(f"[Chirp3Stream] turn={self.turn_id} role={self.role} langs={codes} adaptation={use_adaptation}", flush=True)
                    responses = await client.streaming_recognize(
                        requests=self._requests(cfg_req, list(self.replay), stop_evt)
                    )
                    async for resp in responses:
                        if await self._handle_response(resp):
                            got_transcript = True
                    stop_evt.set()
                    if self.input_done:
                        break
                    # Server closed the stream while audio is still flowing (e.g. duration limit): reconnect
                except asyncio.CancelledError:
                    stop_evt.set()
                    raise
                except Exception as err:
                    stop_evt.set()
                    failures = 1 if got_transcript else failures + 1
                    print(f"[Chirp3Stream] Stream error (attempt {idx}, langs={codes}, adaptation={use_adaptation}): {err}", flush=True)
                    if not got_transcript and idx < len(attempts) - 1:
                        idx += 1
                    if failures >= 3:
                        await safe_send(self.ws, {"type": "error", "turnId": self.turn_id,
                                                  "message": f"Chirp 3 (Speech v2) streaming failed: {str(err)[:300]}"})
                        return

            if self.is_ptt:
                if not self.ptt_finals and self.replay_bytes > 1600:
                    # Short push-to-talk utterances may close before streaming emits is_final=True;
                    # run Speech V2 synchronous Recognize on the buffered PCM (still Chirp 3 V2).
                    try:
                        sync_res = await asyncio.to_thread(
                            pipeline.transcribe_chirp3, b"".join(self.replay), self.active_codes or ["auto"]
                        )
                        if sync_res.get("transcript"):
                            self.ptt_finals.append({
                                "text": sync_res["transcript"].strip(),
                                "lang": sync_res.get("detected_lang"),
                                "confidence": sync_res.get("confidence", 0.0),
                            })
                    except Exception as sync_err:
                        print(f"[Chirp3Stream] Speech V2 sync finalize error: {sync_err}", flush=True)
                if not self.ptt_finals and self.last_interim:
                    codes = self.active_codes
                    self.ptt_finals.append({
                        "text": self.last_interim,
                        "lang": codes[0] if codes and codes[0] != "auto" else None,
                        "confidence": 0.0,
                    })
                if self.ptt_finals:
                    langs = [f["lang"] for f in self.ptt_finals if f["lang"]]
                    detected = Counter(langs).most_common(1)[0][0] if langs else None
                    ref = self.stop_time or self.last_chunk_time or time.time()
                    await self.turns.put({
                        "turn_id": self.turn_id,
                        "text": " ".join(f["text"] for f in self.ptt_finals),
                        "lang": detected,
                        "confidence": max(f["confidence"] for f in self.ptt_finals),
                        "stt_ms": max(0.0, (time.time() - ref) * 1000),
                    })
                else:
                    await safe_send(self.ws, {"type": "no_speech", "turnId": self.turn_id, "message": "No audible speech detected"})
        finally:
            await self.turns.put(None)
            await consumer


# ---------------------------------------------------------------------------
# Gemini 3.5 Transcribe Live -> cascade (strictly gemini-3.5-transcribe-live-preview in global, no fallback)
# ---------------------------------------------------------------------------
class GeminiTranscribeWorker(BaseStreamWorker):
    engine_label = GEMINI_TRANSCRIBE_MODEL

    def _language_codes(self) -> Optional[List[str]]:
        cast = lang_info(self.state.cast_lang)["stt"]
        guest = lang_info(self.state.guest_lang)["stt"]
        if self.role == "cast-member":
            return [cast]
        if self.state.smart_detect:
            return None  # omitted -> automatic language detection
        return [guest] if self.role == "guest" else _dedupe([cast, guest])

    async def run(self) -> None:
        self.consumed: List[bytes] = list(self.initial_chunks)
        self.initial_chunks = []
        last_err: Optional[Exception] = None
        for use_vocab in (True, False):
            try:
                await self._run_gemini(use_vocab=use_vocab)
                return
            except asyncio.CancelledError:
                raise
            except Exception as err:
                last_err = err
                print(f"[GeminiTranscribe] Session error (use_vocab={use_vocab}): {err}", flush=True)
                if not use_vocab:
                    break
        if last_err is not None:
            reason = friendly_gemini_error(GEMINI_TRANSCRIBE_MODEL, GEMINI_TRANSCRIBE_LOCATION, last_err)
            await safe_send(self.ws, {"type": "error", "turnId": self.turn_id, "message": reason})

    async def _finish_segment(self, text: str, lang: Optional[str], stt_ms: float) -> None:
        detected = lang
        if self.role == "cast-member":
            detected = detected or lang_info(self.state.cast_lang)["stt"]
        elif not detected:
            if self.state.smart_detect:
                det = await asyncio.to_thread(pipeline.detect_language, text)
                detected = det["language_code"]
            else:
                detected = lang_info(self.state.guest_lang)["stt"]
        seg_id = self.current_segment_id()
        self.advance_segment()
        await process_final_turn(self.ws, self.state, turn_id=seg_id, transcript=text, role=self.role,
                                 detected_raw=detected, stt_ms=stt_ms, stt_model=self.engine_label)

    async def _run_gemini(self, use_vocab: bool = True) -> None:
        client = get_genai_client(GEMINI_TRANSCRIBE_LOCATION)
        codes = self._language_codes()
        tconf_kwargs: Dict[str, Any] = {}
        if use_vocab and pipeline.brand_phrases:
            tconf_kwargs["custom_vocabulary"] = pipeline.brand_phrases
        if codes:
            tconf_kwargs["language_codes"] = codes
        config = types.LiveConnectConfig(
            response_modalities=["TEXT"],
            input_audio_transcription=types.AudioTranscriptionConfig(**tconf_kwargs),
        )
        finals: List[Dict[str, Any]] = []
        last_interim: str = ""
        done = asyncio.Event()
        session_start_time = time.time()
        last_audible_input_time: Optional[float] = None
        last_interim_time: Optional[float] = None
        last_final_time: Optional[float] = None

        async with client.aio.live.connect(model=GEMINI_TRANSCRIBE_MODEL, config=config) as session:
            print(f"[GeminiTranscribe] Connected turn={self.turn_id} role={self.role} "
                  f"loc={GEMINI_TRANSCRIBE_LOCATION} langs={codes or 'auto'} vocab={use_vocab}", flush=True)

            async def sender():
                nonlocal last_audible_input_time
                backlog = list(self.consumed)
                for chunk in backlog:
                    for piece in _split_audio(chunk, 3200):
                        if _pcm_is_audible(piece):
                            last_audible_input_time = time.time()
                        await session.send_realtime_input(audio=types.Blob(data=piece, mime_type="audio/pcm;rate=16000"))
                        if len(backlog) > 2:
                            await asyncio.sleep(0.015)
                while not self.input_done:
                    chunk = await self.queue.get()
                    if chunk is None:
                        self.input_done = True
                        break
                    self.consumed.append(chunk)
                    for piece in _split_audio(chunk, 3200):
                        if _pcm_is_audible(piece):
                            last_audible_input_time = time.time()
                        await session.send_realtime_input(audio=types.Blob(data=piece, mime_type="audio/pcm;rate=16000"))
                # Send ~600ms of trailing silence so server-side VAD flushes the final transcript
                silence = b"\x00" * 3200
                for _ in range(6):
                    if done.is_set():
                        break
                    await session.send_realtime_input(audio=types.Blob(data=silence, mime_type="audio/pcm;rate=16000"))
                    await asyncio.sleep(0.025)
                await session.send_realtime_input(audio_stream_end=True)

            async def receiver():
                nonlocal last_interim, last_audible_input_time, last_interim_time, last_final_time
                empty_rounds = 0
                while not done.is_set():
                    got_any = False
                    async for message in session.receive():
                        got_any = True
                        now = time.time()
                        sc = message.server_content
                        if not sc:
                            continue
                        if sc.interim_input_transcription and sc.interim_input_transcription.text:
                            last_interim = sc.interim_input_transcription.text.strip()
                            last_interim_time = now
                            prefix = " ".join(f["text"] for f in finals) if self.is_ptt else ""
                            await safe_send(self.ws, {
                                "type": "interim_transcript", "turnId": self.current_segment_id(),
                                "transcript": f"{prefix} {last_interim}".strip(),
                                "speakerRole": self.role,
                            })
                        tr = sc.input_transcription
                        if tr and tr.text and tr.text.strip():
                            last_interim = ""
                            last_final_time = now
                            ref = (
                                self.stop_time
                                or last_audible_input_time
                                or last_interim_time
                                or self.last_chunk_time
                                or session_start_time
                            )
                            seg_stt_ms = round(max(15.0, (now - ref) * 1000), 1)
                            item = {
                                "text": tr.text.strip(),
                                "lang": getattr(tr, "language_code", None),
                                "stt_ms": seg_stt_ms,
                            }
                            last_audible_input_time = None
                            last_interim_time = None
                            if self.is_ptt:
                                finals.append(item)
                            else:
                                await self._finish_segment(item["text"], item["lang"], seg_stt_ms)
                            if self.input_done:
                                done.set()
                        if (sc.turn_complete or getattr(sc, "generation_complete", False)) and self.input_done:
                            done.set()
                        if done.is_set():
                            return
                    if got_any:
                        empty_rounds = 0
                    else:
                        empty_rounds += 1
                        if self.input_done and empty_rounds >= 3:
                            return
                        await asyncio.sleep(0.05)

            send_task = asyncio.create_task(sender())
            recv_task = asyncio.create_task(receiver())
            await asyncio.wait({send_task, recv_task}, return_when=asyncio.FIRST_COMPLETED)
            if recv_task.done() and not send_task.done() and not self.input_done:
                send_task.cancel()
                exc = None if recv_task.cancelled() else recv_task.exception()
                raise exc or RuntimeError("Gemini Transcribe session closed before the audio finished")
            else:
                await send_task
                try:
                    await asyncio.wait_for(done.wait(), timeout=4.5)
                except asyncio.TimeoutError:
                    pass
                recv_task.cancel()
                if recv_task.done() and not recv_task.cancelled() and recv_task.exception():
                    raise recv_task.exception()

        if self.is_ptt:
            if not finals and last_interim:
                ref = self.stop_time or last_audible_input_time or last_interim_time or session_start_time
                finals.append({
                    "text": last_interim,
                    "lang": None,
                    "stt_ms": round(max(15.0, (time.time() - ref) * 1000), 1),
                })
            if finals:
                langs = [f["lang"] for f in finals if f["lang"]]
                if self.stop_time and last_final_time and last_final_time >= self.stop_time:
                    ptt_stt_ms = round(max(15.0, (last_final_time - self.stop_time) * 1000), 1)
                elif finals[-1].get("stt_ms"):
                    ptt_stt_ms = float(finals[-1]["stt_ms"])
                else:
                    ref = self.stop_time or last_audible_input_time or session_start_time
                    ptt_stt_ms = round(max(15.0, (time.time() - ref) * 1000), 1)
                await self._finish_segment(" ".join(f["text"] for f in finals),
                                           Counter(langs).most_common(1)[0][0] if langs else None,
                                           ptt_stt_ms)
            else:
                await safe_send(self.ws, {"type": "no_speech", "turnId": self.turn_id, "message": "No audible speech detected"})


# ---------------------------------------------------------------------------
# Gemini speech-to-speech engines (3.5 Live Translate, 3.8 Live)
# ---------------------------------------------------------------------------
class GeminiSpeechWorker(BaseStreamWorker):
    model = ""
    location = ""
    engine_key = ""
    glossary_mode = "none"

    def build_config(self, minimal: bool = False) -> types.LiveConnectConfig:  # pragma: no cover
        raise NotImplementedError

    def uses_manual_activity(self) -> bool:
        return False

    def _reset_segment(self) -> None:
        self.input_text = ""
        self.output_text = ""
        self.input_lang: Optional[str] = None
        self.first_audible_input_time: Optional[float] = None
        self.last_audible_input_time: Optional[float] = None
        self.speech_pause_ref_time: Optional[float] = None
        self.first_input_tr_time: Optional[float] = None
        self.last_input_tr_time: Optional[float] = None
        self.input_tr_latency_ms: Optional[float] = None
        self.first_output_tr_time: Optional[float] = None
        self.last_output_tr_time: Optional[float] = None
        self.first_model_turn_time: Optional[float] = None
        self.first_audio_time: Optional[float] = None
        self.first_audio_flush_time: Optional[float] = None
        self.first_audio_sent = False
        self.audio_active = False
        self.last_audible_time: float = 0.0

    async def run(self) -> None:
        self.consumed: List[bytes] = []
        self.audio_buf = bytearray()
        self.input_done_time: Optional[float] = None
        self.last_msg_time = time.time()
        self.last_active_time = time.time()
        self.turn_done = asyncio.Event()
        self.segment_had_output = False
        self._reset_segment()

        client = get_genai_client(self.location)
        last_err: Optional[Exception] = None
        for minimal in (False, True):
            try:
                await self._session(client, minimal)
                last_err = None
                break
            except asyncio.CancelledError:
                raise
            except Exception as err:
                last_err = err
                print(f"[{self.engine_key}] Session error (minimal={minimal}): {err}", flush=True)
                if self.segment_had_output:
                    break
        if last_err is not None:
            await safe_send(self.ws, {"type": "error", "turnId": self.turn_id,
                                      "message": friendly_gemini_error(self.model, self.location, last_err)})
            return
        await self._flush_audio()
        if self.is_ptt:
            await self._finalize_segment()

    async def _session(self, client: genai.Client, minimal: bool) -> None:
        config = self.build_config(minimal=minimal)
        async with client.aio.live.connect(model=self.model, config=config) as session:
            print(f"[{self.engine_key}] Connected turn={self.turn_id} role={self.role} minimal={minimal}", flush=True)
            send_task = asyncio.create_task(self._sender(session))
            recv_task = asyncio.create_task(self._receiver(session))
            try:
                await asyncio.wait({send_task, recv_task}, return_when=asyncio.FIRST_COMPLETED)
                if recv_task.done() and not send_task.done() and not self.input_done:
                    send_task.cancel()
                    exc = None if recv_task.cancelled() else recv_task.exception()
                    raise exc or RuntimeError("Live session closed before the audio finished")
                await send_task
                # Wait for the model to finish speaking the translation.
                # Note: gemini-3.5-live-translate-preview streams continuous silent 24kHz frames when idle,
                # so we check `last_active_time` (audible audio or transcript updates), not `last_msg_time`.
                deadline = time.time() + 14.0
                while time.time() < deadline:
                    if self.turn_done.is_set() or recv_task.done():
                        break
                    now = time.time()
                    if self.segment_had_output and self.last_active_time >= (self.input_done_time or 0):
                        if now - self.last_active_time > 1.4:
                            break
                    elif self.segment_had_output:
                        # Output occurred while user was still speaking; allow model time to translate final clause
                        if now - (self.input_done_time or now) > 2.4:
                            break
                    else:
                        if now - (self.input_done_time or now) > 4.5:
                            break
                    await asyncio.sleep(0.08)
            finally:
                recv_task.cancel()
            if recv_task.done() and not recv_task.cancelled() and recv_task.exception():
                raise recv_task.exception()

    async def _sender(self, session) -> None:
        manual = self.uses_manual_activity()
        if manual:
            await session.send_realtime_input(activity_start=types.ActivityStart())
        backlog = list(self.consumed) + self.initial_chunks
        if self.initial_chunks:
            self.consumed.extend(self.initial_chunks)
            self.initial_chunks = []
        for chunk in backlog:
            for piece in _split_audio(chunk, 3200):
                now_send = time.time()
                if _pcm_is_audible(piece):
                    if self.first_audible_input_time is None:
                        self.first_audible_input_time = now_send
                    self.last_audible_input_time = now_send
                    if self.first_audio_time is None and self.first_output_tr_time is None:
                        self.speech_pause_ref_time = now_send
                await session.send_realtime_input(audio=types.Blob(data=piece, mime_type="audio/pcm;rate=16000"))
                if not manual and len(backlog) > 2:
                    await asyncio.sleep(0.03)
        while not self.input_done:
            chunk = await self.queue.get()
            if chunk is None:
                self.input_done = True
                break
            self.consumed.append(chunk)
            for piece in _split_audio(chunk, 3200):
                now_send = time.time()
                if _pcm_is_audible(piece):
                    if self.first_audible_input_time is None:
                        self.first_audible_input_time = now_send
                    self.last_audible_input_time = now_send
                    if self.first_audio_time is None and self.first_output_tr_time is None:
                        self.speech_pause_ref_time = now_send
                await session.send_realtime_input(audio=types.Blob(data=piece, mime_type="audio/pcm;rate=16000"))
        if manual:
            self.input_done_time = time.time()
            await session.send_realtime_input(activity_end=types.ActivityEnd())
        else:
            # Automatic server-side VAD (gemini-3.5-live-translate-preview) needs ~1.2s of trailing silence
            # before audio_stream_end so the final clause is committed reliably.
            silence = b"\x00" * 3200
            for _ in range(12):
                if self.turn_done.is_set():
                    break
                await session.send_realtime_input(audio=types.Blob(data=silence, mime_type="audio/pcm;rate=16000"))
                await asyncio.sleep(0.035)
            self.input_done_time = time.time()
            await session.send_realtime_input(audio_stream_end=True)

    async def _receiver(self, session) -> None:
        empty_rounds = 0
        while True:
            got_any = False
            async for message in session.receive():
                got_any = True
                now = time.time()
                self.last_msg_time = now
                sc = message.server_content
                if not sc:
                    continue
                tr_in = sc.input_transcription
                if tr_in and tr_in.text:
                    self.last_active_time = now
                    if self.first_input_tr_time is None:
                        self.first_input_tr_time = now
                    self.last_input_tr_time = now
                    ref_in = (
                        self.input_done_time
                        or self.stop_time
                        or self.speech_pause_ref_time
                        or self.last_audible_input_time
                        or self.first_audible_input_time
                    )
                    if ref_in is not None and now >= ref_in:
                        delta_ms = round((now - ref_in) * 1000, 1)
                        if delta_ms >= 10.0 or self.input_tr_latency_ms is None:
                            self.input_tr_latency_ms = max(15.0, delta_ms)
                    self.input_text += tr_in.text
                    self.input_lang = getattr(tr_in, "language_code", None) or self.input_lang
                    await safe_send(self.ws, {"type": "interim_transcript", "turnId": self.current_segment_id(),
                                              "transcript": self.input_text.strip(), "speakerRole": self.role})
                tr_out = sc.output_transcription
                if tr_out and tr_out.text:
                    self.last_active_time = now
                    if self.first_output_tr_time is None:
                        self.first_output_tr_time = now
                    self.last_output_tr_time = now
                    self.output_text += tr_out.text
                    self.segment_had_output = True
                    await safe_send(self.ws, {"type": "interim_translation", "turnId": self.current_segment_id(),
                                              "translated_text": self.output_text.strip(), "speakerRole": self.role})
                if sc.model_turn and sc.model_turn.parts:
                    if self.first_model_turn_time is None:
                        self.first_model_turn_time = now
                    for part in sc.model_turn.parts:
                        if part.inline_data and part.inline_data.data:
                            data = part.inline_data.data
                            audible = _pcm_is_audible(data)
                            if audible:
                                self.audio_active = True
                                self.last_audible_time = now
                                self.last_active_time = now
                                if self.first_audio_time is None:
                                    self.first_audio_time = now
                                self.segment_had_output = True
                            # Keep audible audio and short (<350ms) inter-word pauses; drop continuous idle silence
                            if self.audio_active and (audible or (now - self.last_audible_time) < 0.35):
                                self.audio_buf.extend(data)
                                if len(self.audio_buf) >= AUDIO_FLUSH_BYTES:
                                    await self._flush_audio()
                            elif self.audio_active and (now - self.last_audible_time) >= 0.35:
                                await self._flush_audio()
                                self.audio_active = False
                if sc.interrupted:
                    await safe_send(self.ws, {"type": "interrupted", "turnId": self.current_segment_id()})
                if sc.turn_complete or getattr(sc, "generation_complete", False):
                    await self._flush_audio()
                    if not self.is_ptt:
                        await self._finalize_segment()
                    elif self.input_done:
                        self.turn_done.set()
            if got_any:
                empty_rounds = 0
            else:
                empty_rounds += 1
                if self.input_done and empty_rounds >= 3:
                    return
                await asyncio.sleep(0.05)

    def _stt_latency_ms(self) -> float:
        if self.last_input_tr_time is None:
            return 0.0
        t_in = self.last_input_tr_time
        for ref in (
            self.input_done_time,
            self.stop_time,
            self.speech_pause_ref_time,
            self.last_audible_input_time,
            self.first_audible_input_time,
        ):
            if ref is not None and t_in > ref and (t_in - ref) * 1000 >= 15.0:
                return round((t_in - ref) * 1000, 1)
        if self.input_tr_latency_ms:
            return round(self.input_tr_latency_ms, 1)
        if self.first_input_tr_time and t_in > self.first_input_tr_time:
            return round(max(25.0, (t_in - self.first_input_tr_time) * 1000), 1)
        return 45.0

    def _first_audio_latency_ms(self) -> float:
        t_out = self.first_audio_time or self.first_output_tr_time or self.last_output_tr_time
        if t_out is None:
            return 0.0
        for ref in (
            self.input_done_time,
            self.stop_time,
            self.speech_pause_ref_time,
            self.last_audible_input_time,
            self.last_input_tr_time,
            self.first_input_tr_time,
            self.first_audible_input_time,
        ):
            if ref is not None and t_out > ref and (t_out - ref) * 1000 >= 15.0:
                return round((t_out - ref) * 1000, 1)
        return 60.0

    def _tts_synth_latency_ms(self) -> float:
        if self.first_audio_time is None:
            return 0.0
        end_t = self.first_audio_flush_time or self.last_audible_time or time.time()
        candidates = [t for t in (self.first_model_turn_time, self.first_output_tr_time, self.first_audio_time) if t is not None]
        start_t = min(candidates) if candidates else self.first_audio_time
        if end_t > start_t:
            return round(max(20.0, (end_t - start_t) * 1000), 1)
        return 35.0

    async def _flush_audio(self) -> None:
        if not self.audio_buf:
            return
        pcm = bytes(self.audio_buf)
        self.audio_buf = bytearray()
        payload: Dict[str, Any] = {
            "type": "audio",
            "turnId": self.current_segment_id(),
            "pcm": base64.b64encode(pcm).decode("utf-8"),
            "sampleRate": 24000,
            "streaming": True,
            "engine": self.engine_key,
            "speakerRole": self.role,
        }
        if not self.first_audio_sent:
            self.first_audio_flush_time = time.time()
            first_audio_ms = self._first_audio_latency_ms()
            stt_ms = self._stt_latency_ms()
            tts_ms = self._tts_synth_latency_ms()
            payload["total_latency_ms"] = round(first_audio_ms + tts_ms, 1)
            payload["latency_breakdown"] = {
                "first_audio_ms": first_audio_ms,
                "stt_ms": stt_ms if stt_ms > 0 else None,
                "translation_ms": first_audio_ms,
                "tts_ms": tts_ms,
            }
            self.first_audio_sent = True
        await safe_send(self.ws, payload)

    async def _finalize_segment(self) -> None:
        inp, out = self.input_text.strip(), self.output_text.strip()
        seg_id = self.current_segment_id()
        detected = self.input_lang
        stt_ms = self._stt_latency_ms()
        trans_ms = self._first_audio_latency_ms()
        tts_ms = self._tts_synth_latency_ms()
        self.advance_segment()
        self._reset_segment()
        if not inp and not out:
            if self.is_ptt:
                await safe_send(self.ws, {"type": "no_speech", "turnId": seg_id, "message": "No speech detected by the model"})
            return

        if self.role == "cast-member":
            detected = detected or lang_info(self.state.cast_lang)["stt"]
        elif not detected and inp:
            det = await asyncio.to_thread(pipeline.detect_language, inp)
            detected = det["language_code"]
        if self.role != "cast-member":
            event = apply_guest_detection(self.state, detected, inp)
            if event:
                await safe_send(self.ws, event)
        eff_role, src, tgt = route_turn(self.state, self.role, detected)

        # Cloud DLP scrubs both input and output transcripts; for Gemini 3.8 Live, spoken audio is also protected via system prompt
        dlp_in = await asyncio.to_thread(dlp_manager.sanitize_text, inp, enabled=self.state.use_dlp,
                                         active_info_types=self.state.dlp_info_types)
        dlp_out = await asyncio.to_thread(dlp_manager.sanitize_text, out, enabled=self.state.use_dlp,
                                          active_info_types=self.state.dlp_info_types)
        dlp_ms = round(dlp_in["latency_ms"] + dlp_out["latency_ms"], 2)
        total_ms = round((trans_ms or stt_ms) + tts_ms + dlp_ms, 1)
        dlp_scope = "prompt_and_transcript" if (self.engine_key == ENGINE_LIVE_38 and self.state.use_dlp) else "transcript_only"
        await safe_send(self.ws, {
            "type": "stt_transcript", "turnId": seg_id,
            "transcript": inp, "sanitized_transcript": dlp_in["sanitized_text"],
            "dlp_applied": dlp_in["pii_detected"] or dlp_out["pii_detected"],
            "dlp_scope": dlp_scope,
            "stt_ms": stt_ms, "stt_model": self.model, "speakerRole": eff_role,
            "detectedLang": detected, "srcLang": src, "tgtLang": tgt, "guestLang": self.state.guest_lang,
            "is_final": True,
        })
        await safe_send(self.ws, {
            "type": "dlp_status", "turnId": seg_id,
            "original_text": inp, "sanitized_text": dlp_in["sanitized_text"],
            "pii_detected": dlp_in["pii_detected"] or dlp_out["pii_detected"],
            "findings": dlp_in["findings"] + dlp_out["findings"],
            "active_info_types": dlp_in["active_info_types"],
            "dlp_latency_ms": dlp_ms,
            "dlp_enabled": self.state.use_dlp, "dlp_scope": dlp_scope, "speakerRole": eff_role,
        })
        await safe_send(self.ws, {
            "type": "translation_text", "turnId": seg_id,
            "translated_text": dlp_out["sanitized_text"],
            "glossary_applied": self.glossary_mode == "prompt",
            "glossary_mode": self.glossary_mode,
            "translation_ms": trans_ms,
            "tts_ms": tts_ms,
            "dlp_ms": dlp_ms,
            "stt_ms": stt_ms,
            "total_latency_ms": total_ms,
            "model": self.model, "speakerRole": eff_role,
            "srcLang": src, "tgtLang": tgt, "engine": self.engine_key,
        })


class GeminiLiveTranslateWorker(GeminiSpeechWorker):
    """Gemini 3.5 Live Translate: one target language per session, push-to-talk only.

    Cast turns target the current guest language; guest turns target the cast language.
    System instructions are not supported, so the brand glossary cannot be enforced.
    """
    model = GEMINI_LIVE_TRANSLATE_MODEL
    location = GEMINI_LIVE_TRANSLATE_LOCATION
    engine_key = ENGINE_LIVE_TRANSLATE
    engine_label = GEMINI_LIVE_TRANSLATE_MODEL
    glossary_mode = "unsupported"

    def target_language(self) -> str:
        target = self.state.guest_lang if self.role == "cast-member" else self.state.cast_lang
        return lang_info(target)["gemini"]

    def build_config(self, minimal: bool = False) -> types.LiveConnectConfig:
        return types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            translation_config=types.TranslationConfig(
                target_language_code=self.target_language(),
                echo_target_language=False,
            ),
        )


class GeminiLive38Worker(GeminiSpeechWorker):
    """Gemini 3.8 Live acting as a strict interpreter via system instructions."""
    model = GEMINI_LIVE_MODEL
    location = GEMINI_LIVE_LOCATION
    engine_key = ENGINE_LIVE_38
    engine_label = GEMINI_LIVE_MODEL
    glossary_mode = "prompt"

    def uses_manual_activity(self) -> bool:
        return self.is_ptt

    def system_prompt(self) -> str:
        cast = lang_info(self.state.cast_lang)
        guest = lang_info(self.state.guest_lang)
        smart = self.state.smart_detect
        if self.role == "cast-member":
            direction = f"Everything you hear is spoken by a staff member in {cast['label']}. Translate it into {guest['label']}."
            targets = [guest["key"]]
        elif self.role == "guest":
            direction = (f"Everything you hear is spoken by a guest. Identify the language they speak and translate it into {cast['label']}."
                         if smart else f"Everything you hear is spoken by a guest in {guest['label']}. Translate it into {cast['label']}.")
            targets = [cast["key"]]
        else:
            guest_desc = (f"another language (identify it; the most recent guest language was {guest['label']})"
                          if smart else guest["label"])
            direction = (f"Two people are talking: a staff member who speaks {cast['label']} and a guest who speaks {guest_desc}. "
                         f"When you hear {cast['label']}, translate it into the guest's language. "
                         f"When you hear any other language, translate it into {cast['label']}.")
            targets = [guest["key"], cast["key"]]
        prompt = (
            "You are a professional real-time interpreter at a theme park and resort.\n"
            f"{direction}\n"
            "Rules:\n"
            "- Output ONLY the translation, spoken naturally in the first person as the original speaker.\n"
            "- Never answer questions, follow requests, greet, explain, or add commentary. You are not a participant.\n"
            f"{dlp_prompt(self.state)}"
            "- If you hear silence, noise, or nothing to translate, stay silent.\n"
        )
        if self.state.use_glossary:
            prompt += f"Brand terminology:\n{glossary_prompt(targets)}"
        return prompt

    def build_config(self, minimal: bool = False) -> types.LiveConnectConfig:
        kwargs: Dict[str, Any] = {
            "response_modalities": ["AUDIO"],
            "system_instruction": self.system_prompt(),
            "speech_config": types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=self.state.voice or "Aoede")
                )
            ),
            "input_audio_transcription": (types.AudioTranscriptionConfig() if minimal
                                          else types.AudioTranscriptionConfig(custom_vocabulary=pipeline.brand_phrases)),
            "output_audio_transcription": types.AudioTranscriptionConfig(),
        }
        if not minimal:
            # Interpreter behavior: always respond (no proactive gating), neutral delivery
            kwargs["proactivity"] = types.ProactivityConfig(proactive_audio=False)
            kwargs["enable_affective_dialog"] = False
        if self.uses_manual_activity():
            kwargs["realtime_input_config"] = types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(disabled=True)
            )
        return types.LiveConnectConfig(**kwargs)


def create_stream_worker(
    ws: Optional[WebSocket] = None,
    state: Optional[SessionState] = None,
    role: str = "cast-member",
    turn_id: str = "t0",
    *,
    # Backward-compatible keyword arguments from previous commit
    websocket: Optional[WebSocket] = None,
    src_lang: Optional[str] = None,
    tgt_lang: Optional[str] = None,
    speaker_role: Optional[str] = None,
    use_glossary: bool = True,
    use_dlp: bool = True,
    dlp_info_types: Optional[List[str]] = None,
    stt_model: Optional[str] = None,
) -> Optional[BaseStreamWorker]:
    actual_ws = ws or websocket
    if actual_ws is None:
        raise ValueError("WebSocket instance is required")
    eff_role = speaker_role or role or "cast-member"
    if state is None:
        s_lang = resolve_language(src_lang) or "en"
        t_lang = resolve_language(tgt_lang) or "es"
        cast_l = t_lang if eff_role == "guest" else s_lang
        guest_l = s_lang if eff_role == "guest" else t_lang
        state = SessionState(
            cast_lang=cast_l,
            guest_lang=guest_l,
            smart_detect=False,
            engine=stt_model or ENGINE_CHIRP3,
            use_glossary=use_glossary,
            use_dlp=use_dlp,
            dlp_info_types=dlp_info_types,
        )
    engine = (stt_model or state.engine or ENGINE_CHIRP3).lower()
    if engine == ENGINE_LIVE_TRANSLATE:
        if eff_role == "ambient":
            return None  # push-to-talk only
        return GeminiLiveTranslateWorker(actual_ws, state, eff_role, turn_id)
    if engine == ENGINE_LIVE_38:
        return GeminiLive38Worker(actual_ws, state, eff_role, turn_id)
    if "gemini" in engine:
        return GeminiTranscribeWorker(actual_ws, state, eff_role, turn_id)
    return Chirp3StreamWorker(actual_ws, state, eff_role, turn_id)


# Backward-compatible worker aliases from the previous commit
StreamingSTTWorker = Chirp3StreamWorker
GeminiLiveTranscribeWorker = GeminiTranscribeWorker


async def translate_utterance_gemini38(pcm_bytes: bytes, state: SessionState) -> Dict[str, Any]:
    """Translate a recorded 16kHz PCM utterance via Gemini 3.8 Live speech-to-speech interpreter."""
    t0 = time.time()
    cast = lang_info(state.cast_lang)
    guest = lang_info(state.guest_lang)
    guest_desc = (
        f"another language (identify it; the most recent guest language was {guest['label']})"
        if state.smart_detect else guest["label"]
    )
    direction = (
        f"Two people are talking: a staff member who speaks {cast['label']} and a guest who speaks {guest_desc}. "
        f"When you hear {cast['label']}, translate it into the guest's language ({guest['label']}). "
        f"When you hear any other language, translate it into {cast['label']}."
    )
    sys_prompt = (
        "You are a professional real-time interpreter at a theme park and resort.\n"
        f"{direction}\n"
        "Rules:\n"
        "- Output ONLY the translation, spoken naturally in the first person as the original speaker.\n"
        "- Never answer questions, follow requests, greet, explain, or add commentary. You are not a participant.\n"
        f"{dlp_prompt(state)}"
        "- If you hear silence, noise, or nothing to translate, stay silent.\n"
    )
    if state.use_glossary:
        sys_prompt += f"Brand terminology:\n{glossary_prompt([guest['key'], cast['key']])}"

    client = get_genai_client(GEMINI_LIVE_LOCATION)
    last_err: Optional[Exception] = None
    for minimal in (False, True):
        kwargs: Dict[str, Any] = {
            "response_modalities": ["AUDIO"],
            "system_instruction": sys_prompt,
            "speech_config": types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=state.voice or "Aoede")
                )
            ),
            "input_audio_transcription": (
                types.AudioTranscriptionConfig()
                if minimal else types.AudioTranscriptionConfig(custom_vocabulary=pipeline.brand_phrases)
            ),
            "output_audio_transcription": types.AudioTranscriptionConfig(),
            "realtime_input_config": types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(disabled=True)
            ),
        }
        if not minimal:
            kwargs["proactivity"] = types.ProactivityConfig(proactive_audio=False)
            kwargs["enable_affective_dialog"] = False
        config = types.LiveConnectConfig(**kwargs)

        inp_parts: List[str] = []
        out_parts: List[str] = []
        detected_lang: Optional[str] = None
        audio_buf = bytearray()
        done_evt = asyncio.Event()
        last_active = time.time()
        last_inp_time: Optional[float] = None
        first_out_time: Optional[float] = None
        first_audio_time: Optional[float] = None
        last_audio_time: Optional[float] = None

        try:
            async with client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=config) as session:
                await session.send_realtime_input(activity_start=types.ActivityStart())
                for piece in _split_audio(pcm_bytes, 3200):
                    await session.send_realtime_input(audio=types.Blob(data=piece, mime_type="audio/pcm;rate=16000"))
                await session.send_realtime_input(activity_end=types.ActivityEnd())
                sent_time = time.time()

                async def _recv():
                    nonlocal detected_lang, last_active, last_inp_time, first_out_time, first_audio_time, last_audio_time
                    while not done_evt.is_set():
                        async for message in session.receive():
                            now = time.time()
                            sc = message.server_content
                            if not sc:
                                continue
                            if sc.input_transcription and sc.input_transcription.text:
                                last_active = now
                                last_inp_time = now
                                inp_parts.append(sc.input_transcription.text)
                                detected_lang = getattr(sc.input_transcription, "language_code", None) or detected_lang
                            if sc.output_transcription and sc.output_transcription.text:
                                last_active = now
                                if first_out_time is None:
                                    first_out_time = now
                                out_parts.append(sc.output_transcription.text)
                            if sc.model_turn and sc.model_turn.parts:
                                for part in sc.model_turn.parts:
                                    if part.inline_data and part.inline_data.data:
                                        if _pcm_is_audible(part.inline_data.data):
                                            last_active = now
                                            if first_audio_time is None:
                                                first_audio_time = now
                                            if first_out_time is None:
                                                first_out_time = now
                                            last_audio_time = now
                                        audio_buf.extend(part.inline_data.data)
                            if sc.turn_complete or getattr(sc, "generation_complete", False):
                                done_evt.set()
                                return
                        await asyncio.sleep(0.05)

                recv_task = asyncio.create_task(_recv())
                try:
                    deadline = time.time() + 20.0
                    while time.time() < deadline and not done_evt.is_set() and not recv_task.done():
                        now = time.time()
                        if (out_parts or audio_buf) and (now - max(last_active, sent_time)) > 1.4:
                            break
                        if not out_parts and not audio_buf and (now - sent_time) > 6.0:
                            break
                        await asyncio.sleep(0.08)
                finally:
                    recv_task.cancel()

            end_ref = last_audio_time or last_active or time.time()
            stt_ref = last_inp_time or first_out_time or end_ref
            first_out_ref = first_audio_time or first_out_time or end_ref
            stt_ms = round(max(20.0, (stt_ref - sent_time) * 1000), 2)
            translation_ms = round(max(25.0, (first_out_ref - sent_time) * 1000), 2)
            tts_ms = round(max(20.0, (end_ref - first_out_ref) * 1000), 2) if audio_buf else 0.0
            return {
                "transcript": "".join(inp_parts).strip(),
                "translated_text": "".join(out_parts).strip(),
                "detected_lang": detected_lang,
                "audio_pcm": bytes(audio_buf),
                "stt_ms": stt_ms,
                "translation_ms": translation_ms,
                "tts_ms": tts_ms,
                "latency_ms": round(max(stt_ms, translation_ms) + tts_ms, 2),
                "model": GEMINI_LIVE_MODEL,
                "voice": f"{GEMINI_LIVE_MODEL} ({state.voice or 'Aoede'})",
            }
        except Exception as err:
            last_err = err
            print(f"[Gemini38Upload] Error (minimal={minimal}): {err}", flush=True)
            if not minimal:
                continue
            raise
    raise RuntimeError(f"Gemini 3.8 Live upload translation failed: {last_err}")


