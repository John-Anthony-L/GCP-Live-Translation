import os
import time
import base64
import html
from typing import Dict, Any, List, Optional, Union
from google.cloud import speech_v1p1beta1 as speech
from google.cloud import speech_v2
from google.cloud import translate_v3 as translate
from google.cloud import texttospeech_v1 as texttospeech
from google.api_core.client_options import ClientOptions
from google import genai
from google.genai import types
from glossary_helper import get_glossary_config, get_glossary_candidates
from languages import lang_info

PROJECT_ID = os.getenv("PROJECT_ID", "gcp-live-translation")
LOCATION = os.getenv("LOCATION", "us-central1")
CHIRP_REGION = os.getenv("CHIRP_REGION", "us")
GEMINI_TRANSCRIBE_BATCH_MODEL = os.getenv("GEMINI_TRANSCRIBE_BATCH_MODEL", "gemini-3.5-transcribe-preview")
GEMINI_TRANSCRIBE_LOCATION = os.getenv("GEMINI_TRANSCRIBE_LOCATION", "global")


def pcm_to_wav(pcm_data: bytes, sample_rate: int = 16000, channels: int = 1, bits_per_sample: int = 16) -> bytes:
    """Wrap raw 16-bit mono PCM in a 44-byte RIFF/WAV header."""
    import struct
    byte_rate = sample_rate * channels * (bits_per_sample // 8)
    block_align = channels * (bits_per_sample // 8)
    data_size = len(pcm_data)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )
    return header + pcm_data

def trim_pcm_silence(pcm_data: bytes, threshold: int = 350) -> bytes:
    """Trim leading and trailing silence from 16-bit mono PCM to dramatically speed up STT processing."""
    if len(pcm_data) < 4:
        return pcm_data
    import struct
    num_samples = len(pcm_data) // 2
    try:
        samples = struct.unpack(f"<{num_samples}h", pcm_data)
        start_idx = 0
        while start_idx < num_samples and abs(samples[start_idx]) < threshold:
            start_idx += 1
            
        end_idx = num_samples - 1
        while end_idx > start_idx and abs(samples[end_idx]) < threshold:
            end_idx -= 1
            
        if start_idx >= end_idx:
            return pcm_data
            
        # Add 100ms padding on edges (1600 samples at 16kHz)
        start_idx = max(0, start_idx - 1600)
        end_idx = min(num_samples, end_idx + 1600)
        
        trimmed = samples[start_idx:end_idx]
        return struct.pack(f"<{len(trimmed)}h", *trimmed)
    except Exception:
        return pcm_data

class LiveTranslationPipeline:
    def __init__(self):
        self.speech_client = speech.SpeechClient()
        self.speech_async_client = speech.SpeechAsyncClient()
        self.chirp_region = CHIRP_REGION
        self.speech_v2_client = speech_v2.SpeechClient(
            client_options=ClientOptions(api_endpoint=f"{self.chirp_region}-speech.googleapis.com")
        )
        self.speech_v2_async_client = speech_v2.SpeechAsyncClient(
            client_options=ClientOptions(api_endpoint=f"{self.chirp_region}-speech.googleapis.com")
        )
        self.translate_client = translate.TranslationServiceClient()
        self.tts_client = texttospeech.TextToSpeechClient()
        self._genai_transcribe_client = None
        
        self.chirp3_en_recognizer = f"projects/{PROJECT_ID}/locations/{self.chirp_region}/recognizers/live-translation-recognizer"
        self.chirp3_es_recognizer = f"projects/{PROJECT_ID}/locations/{self.chirp_region}/recognizers/live-translation-recognizer-es"
        # Backward compatibility aliases
        self.chirp2_en_recognizer = self.chirp3_en_recognizer
        self.chirp2_es_recognizer = self.chirp3_es_recognizer
        
        self.brand_phrases = [
            "Lightning Lane", "MagicBand+", "Cast Member", "Space Mountain",
            "Rise of the Resistance", "Haunted Mansion", "Big Thunder Mountain",
            "Galaxy's Edge", "Fantasyland", "PhotoPass", "Rider Switch",
            "Single Rider", "Tiana's Bayou Adventure", "Rope Drop", "Park Hopper", "Express Pass"
        ]
        self.disney_phrases = self.brand_phrases
        self.cached_speech_context = speech.SpeechContext(
            phrases=self.brand_phrases,
            boost=20.0
        )

    def _get_genai_transcribe_client(self) -> genai.Client:
        if self._genai_transcribe_client is None:
            try:
                self._genai_transcribe_client = genai.Client(
                    enterprise=True, project=PROJECT_ID, location=GEMINI_TRANSCRIBE_LOCATION
                )
            except Exception:
                self._genai_transcribe_client = genai.Client(
                    vertexai=True, project=PROJECT_ID, location=GEMINI_TRANSCRIBE_LOCATION
                )
        return self._genai_transcribe_client

    # ------------------------------------------------------------------
    # Chirp 3 (Speech-to-Text V2) helpers
    # ------------------------------------------------------------------
    def chirp3_recognizer(self) -> str:
        return f"projects/{PROJECT_ID}/locations/{self.chirp_region}/recognizers/_"

    def chirp3_adaptation(self) -> speech_v2.SpeechAdaptation:
        """Inline phrase set biasing Chirp 3 toward brand terminology (max 1,000 phrases)."""
        return speech_v2.SpeechAdaptation(
            phrase_sets=[
                speech_v2.SpeechAdaptation.AdaptationPhraseSet(
                    inline_phrase_set=speech_v2.PhraseSet(
                        phrases=[{"value": phrase, "boost": 20.0} for phrase in self.brand_phrases]
                    )
                )
            ]
        )

    def chirp3_recognition_config(
        self,
        language_codes: List[str],
        use_adaptation: bool = True,
        sample_rate: int = 16000,
    ) -> speech_v2.RecognitionConfig:
        """Chirp 3 config for raw 16-bit mono PCM. language_codes=["auto"] enables language-agnostic mode.

        Note: Chirp 3 Speech Adaptation (phrase biasing) is only supported when a single explicit
        locale is specified; passing adaptation with language_codes=["auto"] or multiple locales
        returns 404 'Prompt not found for feature combination'.
        """
        kwargs = {
            "explicit_decoding_config": speech_v2.ExplicitDecodingConfig(
                encoding=speech_v2.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=sample_rate,
                audio_channel_count=1,
            ),
            "language_codes": language_codes,
            "model": "chirp_3",
            "features": speech_v2.RecognitionFeatures(enable_automatic_punctuation=True),
        }
        if use_adaptation and "auto" not in language_codes and len(language_codes) == 1:
            kwargs["adaptation"] = self.chirp3_adaptation()
        return speech_v2.RecognitionConfig(**kwargs)

    def build_chirp3_streaming_request(
        self,
        language_codes: List[str],
        use_adaptation: bool = True,
        interim_results: bool = True,
    ) -> speech_v2.StreamingRecognizeRequest:
        """First (config) message of a Chirp 3 StreamingRecognize call.

        - SHORT endpointing finalizes conversational turns quickly.
        - Voice activity events give real speech-start / speech-end timestamps for latency metrics.
        """
        return speech_v2.StreamingRecognizeRequest(
            recognizer=self.chirp3_recognizer(),
            streaming_config=speech_v2.StreamingRecognitionConfig(
                config=self.chirp3_recognition_config(language_codes, use_adaptation=use_adaptation),
                streaming_features=speech_v2.StreamingRecognitionFeatures(
                    interim_results=interim_results,
                    enable_voice_activity_events=True,
                    endpointing_sensitivity=speech_v2.StreamingRecognitionFeatures.EndpointingSensitivity.ENDPOINTING_SENSITIVITY_SHORT,
                ),
            ),
        )

    def detect_language(self, text: str) -> Dict[str, Any]:
        """Detect the language of a transcript with Cloud Translation v3 (used for Gemini engines)."""
        start_time = time.time()
        if not text or not text.strip():
            return {"language_code": None, "confidence": 0.0, "latency_ms": 0.0}
        try:
            response = self.translate_client.detect_language(
                parent=f"projects/{PROJECT_ID}/locations/{LOCATION}",
                content=text,
                mime_type="text/plain",
            )
            best = max(response.languages, key=lambda l: l.confidence) if response.languages else None
            return {
                "language_code": best.language_code if best else None,
                "confidence": round(best.confidence, 3) if best else 0.0,
                "latency_ms": round((time.time() - start_time) * 1000, 2),
            }
        except Exception as e:
            print(f"[Pipeline] detect_language error: {e}", flush=True)
            return {"language_code": None, "confidence": 0.0, "latency_ms": round((time.time() - start_time) * 1000, 2)}

    def get_streaming_config(self, lang_code: str = "en-US", alternative_lang_codes: List[str] = None, model: str = None) -> speech_v2.StreamingRecognitionConfig:
        """Build a Speech-to-Text V2 Chirp 3 StreamingRecognitionConfig (kept for backward compatibility)."""
        codes = [lang_code]
        if alternative_lang_codes:
            for c in alternative_lang_codes:
                if c and c not in codes:
                    codes.append(c)
        return self.build_chirp3_streaming_request(codes, use_adaptation=(len(codes) == 1 and "auto" not in codes)).streaming_config

    def transcribe_gemini35(
        self,
        pcm_data: bytes,
        lang_code: Union[str, List[str], None] = None,
        sample_rate: int = 16000,
    ) -> Dict[str, Any]:
        """One-shot synchronous transcription using Gemini 3.5 Transcribe (gemini-3.5-transcribe-preview in global)."""
        start_time = time.time()
        trimmed_pcm = trim_pcm_silence(pcm_data)
        wav_bytes = pcm_to_wav(trimmed_pcm, sample_rate=sample_rate)

        language_codes: Optional[List[str]] = None
        if isinstance(lang_code, str) and lang_code != "auto":
            language_codes = [lang_code]
        elif isinstance(lang_code, list):
            filtered = [c for c in lang_code if c and c != "auto"]
            if filtered:
                language_codes = filtered

        tconf_kwargs: Dict[str, Any] = {"custom_vocabulary": self.brand_phrases}
        if language_codes:
            tconf_kwargs["language_codes"] = language_codes

        client = self._get_genai_transcribe_client()
        response = client.models.generate_content(
            model=GEMINI_TRANSCRIBE_BATCH_MODEL,
            contents=[types.Part.from_bytes(data=wav_bytes, mime_type="audio/wav")],
            config=types.GenerateContentConfig(
                audio_transcription_config=types.AudioTranscriptionConfig(**tconf_kwargs),
            ),
        )
        duration_ms = (time.time() - start_time) * 1000
        parts = getattr(response, "parts", []) or []
        transcript = " ".join(
            (getattr(p, "text", "") or getattr(getattr(p, "audio_transcription", None), "text", "")).strip()
            for p in parts
            if (getattr(p, "text", "") or getattr(getattr(p, "audio_transcription", None), "text", "")).strip()
        ).strip()
        detected_lang = language_codes[0] if language_codes else None
        if not detected_lang and transcript:
            det = self.detect_language(transcript)
            detected_lang = det.get("language_code")
        return {
            "transcript": transcript,
            "segments": [{"transcript": transcript, "language_code": detected_lang}] if transcript else [],
            "confidence": 1.0 if transcript else 0.0,
            "stt_model": GEMINI_TRANSCRIBE_BATCH_MODEL,
            "detected_lang": detected_lang,
            "latency_ms": round(duration_ms, 2),
        }

    def transcribe_audio(self, pcm_data: bytes, sample_rate: int = 16000, lang_code: str = "en-US", alternative_lang_codes: List[str] = None, model: str = None) -> Dict[str, Any]:
        """Transcribe raw PCM using Speech-to-Text V2 (Chirp 3) or Gemini 3.5 Transcribe."""
        stt_model = (model or os.getenv("STT_MODEL", "chirp_3")).lower()
        codes = [lang_code]
        if alternative_lang_codes:
            for c in alternative_lang_codes:
                if c and c not in codes:
                    codes.append(c)
        if "gemini" in stt_model:
            return self.transcribe_gemini35(pcm_data, lang_code=codes, sample_rate=sample_rate)
        return self.transcribe_chirp3(pcm_data, lang_code=codes, sample_rate=sample_rate)

    def transcribe_chirp3(
        self,
        pcm_data: bytes,
        lang_code: Union[str, List[str]] = "en-US",
        sample_rate: int = 16000,
    ) -> Dict[str, Any]:
        """One-shot Chirp 3 Recognize (Speech-to-Text V2) on raw 16-bit mono PCM (< 1 minute).

        lang_code may be a single locale, a list of candidate locales, or "auto"
        for language-agnostic transcription. The detected language is returned in
        detected_lang (from result.language_code). Uses Speech V2 exclusively.
        """
        start_time = time.time()
        trimmed_pcm = trim_pcm_silence(pcm_data)
        language_codes = [lang_code] if isinstance(lang_code, str) else list(lang_code)

        # Single-locale requests try with inline phrase adaptation first, then without.
        # "auto" or multi-locale requests only run with use_adaptation=False (Chirp 3 V2 requirement).
        can_adapt = "auto" not in language_codes and len(language_codes) == 1
        adaptation_options = (True, False) if can_adapt else (False,)

        last_error = None
        for use_adaptation in adaptation_options:
            request = speech_v2.RecognizeRequest(
                recognizer=self.chirp3_recognizer(),
                config=self.chirp3_recognition_config(language_codes, use_adaptation=use_adaptation, sample_rate=sample_rate),
                content=trimmed_pcm,
            )
            try:
                response = self.speech_v2_client.recognize(request=request)
                duration_ms = (time.time() - start_time) * 1000

                transcripts = []
                segments = []
                confidence = 0.0
                detected_lang = None
                for result in response.results:
                    if result.language_code and not detected_lang:
                        detected_lang = result.language_code
                    if result.alternatives and result.alternatives[0].transcript.strip():
                        text = result.alternatives[0].transcript.strip()
                        transcripts.append(text)
                        segments.append({"transcript": text, "language_code": result.language_code or None})
                        confidence = max(confidence, result.alternatives[0].confidence)
                if not detected_lang and language_codes[0] != "auto":
                    detected_lang = language_codes[0]

                return {
                    "transcript": " ".join(transcripts),
                    "segments": segments,
                    "confidence": round(confidence, 3),
                    "stt_model": "chirp_3 (Speech v2)",
                    "detected_lang": detected_lang,
                    "language_codes": language_codes,
                    "latency_ms": round(duration_ms, 2)
                }
            except Exception as e:
                last_error = e
                print(f"[Pipeline] Chirp 3 Recognize error (adaptation={use_adaptation}, langs={language_codes}): {e}", flush=True)

        raise RuntimeError(f"Chirp 3 Speech V2 Recognize failed ({language_codes}): {last_error}")

    def transcribe_chirp2(self, pcm_data: bytes, lang_code: str = "en-US") -> Dict[str, Any]:
        """Backward compatibility alias pointing to Chirp 3 (Speech V2)."""
        return self.transcribe_chirp3(pcm_data, lang_code=lang_code)

    def translate_text(self, text: str, source_lang: str = "en", target_lang: str = "es", use_glossary: bool = True, model: str = None) -> Dict[str, Any]:
        start_time = time.time()
        parent = f"projects/{PROJECT_ID}/locations/{LOCATION}"
        model_name = model or os.getenv("TRANSLATION_MODEL", "general/translation-llm")
        model_path = f"{parent}/models/{model_name}" if not model_name.startswith("projects/") else model_name
        
        request = translate.TranslateTextRequest(
            parent=parent,
            contents=[text],
            mime_type="text/plain",
            source_language_code=source_lang,
            target_language_code=target_lang,
            model=model_path
        )

        response = None
        if use_glossary:
            for g_cfg in get_glossary_candidates(source_lang, target_lang):
                try:
                    request.glossary_config = g_cfg
                    response = self.translate_client.translate_text(request=request)
                    break
                except Exception as err:
                    print(f"[Pipeline] Glossary {g_cfg.glossary} unavailable ({err}), trying next...", flush=True)
                    request.glossary_config = None

        if response is None:
            request.glossary_config = None
            response = self.translate_client.translate_text(request=request)

        duration_ms = (time.time() - start_time) * 1000

        translated_text = ""
        glossary_applied = False
        used_model = model_path

        if response and response.glossary_translations:
            translated_text = response.glossary_translations[0].translated_text
            glossary_applied = True
            used_model = getattr(response.glossary_translations[0], "model", model_path)
        elif response and response.translations:
            translated_text = response.translations[0].translated_text
            used_model = getattr(response.translations[0], "model", model_path)

        # Unescape HTML entities (e.g. &#39; -> ' , &quot; -> ") so TTS doesn't read entity names phonetically
        translated_text = html.unescape(translated_text)

        return {
            "translated_text": translated_text,
            "glossary_applied": glossary_applied,
            "model": used_model,
            "latency_ms": round(duration_ms, 2)
        }

    def synthesize_speech(self, text: str, target_lang: str = "es-US", voice: str = "Aoede") -> Dict[str, Any]:
        start_time = time.time()
        
        clean_text = html.unescape(text)
        synthesis_input = texttospeech.SynthesisInput(text=clean_text)
        
        # Audio configuration: LINEAR16, 24kHz for ultra HD playback
        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.LINEAR16,
            sample_rate_hertz=24000
        )

        # 1. Primary: Google Cloud Chirp 3 HD Voice (state-of-the-art conversational neural voice)
        # Note: Chirp 3 HD uses expressive named voices such as Aoede, Puck, Kore, Charon, Fenrir
        chirp3_voice_name = f"{target_lang}-Chirp3-HD-{voice or 'Aoede'}"
        voice_params = texttospeech.VoiceSelectionParams(
            language_code=target_lang,
            name=chirp3_voice_name
        )

        used_voice = chirp3_voice_name
        audio_content = None

        try:
            response = self.tts_client.synthesize_speech(
                input=synthesis_input,
                voice=voice_params,
                audio_config=audio_config
            )
            audio_content = response.audio_content
        except Exception as e_chirp:
            # 2. Secondary fallback: Neural2 voice
            neural2_voice_name = f"{target_lang}-Neural2-F" if "es" in target_lang else f"{target_lang}-Neural2-A"
            used_voice = neural2_voice_name
            try:
                fallback_voice = texttospeech.VoiceSelectionParams(
                    language_code=target_lang,
                    name=neural2_voice_name,
                    ssml_gender=texttospeech.SsmlVoiceGender.FEMALE
                )
                response = self.tts_client.synthesize_speech(
                    input=synthesis_input,
                    voice=fallback_voice,
                    audio_config=audio_config
                )
                audio_content = response.audio_content
            except Exception:
                # 3. Tertiary fallback: Standard voice
                used_voice = f"{target_lang}-Standard"
                standard_voice = texttospeech.VoiceSelectionParams(
                    language_code=target_lang,
                    ssml_gender=texttospeech.SsmlVoiceGender.FEMALE
                )
                response = self.tts_client.synthesize_speech(
                    input=synthesis_input,
                    voice=standard_voice,
                    audio_config=audio_config
                )
                audio_content = response.audio_content

        # LINEAR16 responses include a WAV (RIFF) header; the client expects raw PCM samples
        if audio_content and audio_content[:4] == b"RIFF":
            data_idx = audio_content.find(b"data")
            if data_idx != -1:
                audio_content = audio_content[data_idx + 8:]

        duration_ms = (time.time() - start_time) * 1000
        return {
            "audio_base64": base64.b64encode(audio_content).decode("utf-8"),
            "audio_bytes_length": len(audio_content),
            "sample_rate": 24000,
            "voice": used_voice,
            "latency_ms": round(duration_ms, 2)
        }

    def run_full_pipeline(self, pcm_bytes: bytes, source_lang: str = "en", target_lang: str = "es", use_glossary: bool = True) -> Dict[str, Any]:
        total_start = time.time()
        
        # 1. Speech-to-Text
        stt_result = self.transcribe_audio(pcm_bytes, sample_rate=16000, lang_code=f"{source_lang}-US")
        
        if not stt_result["transcript"]:
            return {
                "success": False,
                "error": "No speech detected",
                "total_latency_ms": round((time.time() - total_start) * 1000, 2),
                "steps": { "stt": stt_result }
            }

        # 2. Cloud Translation API Advanced (v3)
        mt_result = self.translate_text(stt_result["transcript"], source_lang=source_lang, target_lang=target_lang, use_glossary=use_glossary)

        # 3. Text-to-Speech
        tts_lang_code = lang_info(target_lang)["tts"]
        tts_result = self.synthesize_speech(mt_result["translated_text"], target_lang=tts_lang_code)

        total_latency_ms = (time.time() - total_start) * 1000

        return {
            "success": True,
            "source_transcript": stt_result["transcript"],
            "translated_text": mt_result["translated_text"],
            "audio_base64": tts_result["audio_base64"],
            "total_latency_ms": round(total_latency_ms, 2),
            "latency_breakdown": {
                "stt_ms": stt_result["latency_ms"],
                "translation_ms": mt_result["latency_ms"],
                "tts_ms": tts_result["latency_ms"]
            },
            "models": {
                "stt_model": stt_result.get("stt_model", "chirp_3"),
                "translation_model": mt_result.get("model", "general/translation-llm"),
                "tts_voice": tts_lang_code
            },
            "glossary_applied": mt_result["glossary_applied"]
        }

DisneyTranslationPipeline = LiveTranslationPipeline
