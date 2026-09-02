import os
import time
import base64
import html
from typing import Dict, Any, List
from google.cloud import speech_v1p1beta1 as speech
from google.cloud import speech_v2
from google.cloud import translate_v3 as translate
from google.cloud import texttospeech_v1 as texttospeech
from glossary_helper import get_glossary_config

PROJECT_ID = os.getenv("PROJECT_ID", "disney-parks-live-translation")
LOCATION = os.getenv("LOCATION", "us-central1")

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

class DisneyTranslationPipeline:
    def __init__(self):
        self.speech_client = speech.SpeechClient()
        self.speech_async_client = speech.SpeechAsyncClient()
        self.speech_v2_client = speech_v2.SpeechClient()
        self.speech_v2_async_client = speech_v2.SpeechAsyncClient()
        self.translate_client = translate.TranslationServiceClient()
        self.tts_client = texttospeech.TextToSpeechClient()
        
        self.chirp2_en_recognizer = f"projects/{PROJECT_ID}/locations/{LOCATION}/recognizers/disney-live-recognizer"
        self.chirp2_es_recognizer = f"projects/{PROJECT_ID}/locations/{LOCATION}/recognizers/disney-live-recognizer-es"
        
        self.disney_phrases = [
            "Lightning Lane", "MagicBand+", "Cast Member", "Space Mountain",
            "Rise of the Resistance", "Haunted Mansion", "Big Thunder Mountain",
            "Galaxy's Edge", "Fantasyland", "PhotoPass", "Rider Switch",
            "Single Rider", "Tiana's Bayou Adventure", "Rope Drop", "Park Hopper"
        ]
        self.cached_speech_context = speech.SpeechContext(
            phrases=self.disney_phrases,
            boost=20.0
        )

    def get_streaming_config(self, lang_code: str = "en-US", alternative_lang_codes: List[str] = None, model: str = None) -> speech.StreamingRecognitionConfig:
        stt_model = model or os.getenv("STT_MODEL", "latest_short")
        if stt_model in ["gemini-3.5-transcribe", "gemini-transcribe", "chirp"]:
            stt_model = "latest_short"

        # Use default model when multi-language auto detection is active in streaming
        if alternative_lang_codes:
            stt_model = "default"

        config_kwargs = {
            "encoding": speech.RecognitionConfig.AudioEncoding.LINEAR16,
            "sample_rate_hertz": 16000,
            "language_code": lang_code,
            "speech_contexts": [self.cached_speech_context],
            "enable_automatic_punctuation": True,
            "model": stt_model
        }
        if alternative_lang_codes:
            config_kwargs["alternative_language_codes"] = alternative_lang_codes

        rec_config = speech.RecognitionConfig(**config_kwargs)
        return speech.StreamingRecognitionConfig(
            config=rec_config,
            interim_results=True,
            single_utterance=False
        )

    def transcribe_audio(self, pcm_data: bytes, sample_rate: int = 16000, lang_code: str = "en-US", alternative_lang_codes: List[str] = None, model: str = None) -> Dict[str, Any]:
        start_time = time.time()
        
        # 1. Fast silence trimming to cut payload and model inference time
        trimmed_pcm = trim_pcm_silence(pcm_data)
        
        # 2. Select optimized low-latency model (latest_short is tuned by Google for fast conversational speech)
        stt_model = model or os.getenv("STT_MODEL", "latest_short")
        if stt_model in ["gemini-3.5-transcribe", "gemini-transcribe", "chirp"]:
            stt_model = "latest_short"

        config_kwargs = {
            "encoding": speech.RecognitionConfig.AudioEncoding.LINEAR16,
            "sample_rate_hertz": sample_rate,
            "language_code": lang_code,
            "speech_contexts": [self.cached_speech_context],
            "enable_automatic_punctuation": True,
            "model": stt_model
        }
        if alternative_lang_codes:
            config_kwargs["alternative_language_codes"] = alternative_lang_codes

        config = speech.RecognitionConfig(**config_kwargs)
        
        audio = speech.RecognitionAudio(content=trimmed_pcm)
        response = self.speech_client.recognize(config=config, audio=audio)
        
        duration_ms = (time.time() - start_time) * 1000
        
        transcript = ""
        confidence = 0.0
        detected_lang = lang_code
        if response.results:
            result = response.results[0]
            if hasattr(result, 'language_code') and result.language_code:
                detected_lang = result.language_code
            if result.alternatives:
                transcript = result.alternatives[0].transcript
                confidence = result.alternatives[0].confidence

        return {
            "transcript": transcript,
            "confidence": round(confidence, 3),
            "stt_model": stt_model,
            "detected_lang": detected_lang,
            "latency_ms": round(duration_ms, 2)
        }

    def transcribe_chirp2(self, pcm_data: bytes, lang_code: str = "en-US") -> Dict[str, Any]:
        start_time = time.time()
        recognizer = self.chirp2_es_recognizer if "es" in lang_code.lower() else self.chirp2_en_recognizer
        trimmed_pcm = trim_pcm_silence(pcm_data)
        
        request = speech_v2.RecognizeRequest(
            recognizer=recognizer,
            content=trimmed_pcm,
        )
        try:
            response = self.speech_v2_client.recognize(request=request)
            duration_ms = (time.time() - start_time) * 1000
            
            transcript = ""
            confidence = 0.0
            if response.results:
                result = response.results[0]
                if result.alternatives:
                    transcript = result.alternatives[0].transcript
                    confidence = result.alternatives[0].confidence
                    
            return {
                "transcript": transcript,
                "confidence": round(confidence, 3),
                "stt_model": "chirp_2 (Gemini Speech Generation)",
                "detected_lang": lang_code,
                "latency_ms": round(duration_ms, 2)
            }
        except Exception as e:
            print(f"[Pipeline] Chirp2 error: {e}, falling back to latest_short", flush=True)
            return self.transcribe_audio(pcm_data, lang_code=lang_code)

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

        if use_glossary:
            try:
                g_cfg = get_glossary_config(source_lang, target_lang)
                if g_cfg:
                    request.glossary_config = g_cfg
            except Exception as e:
                print(f"[Pipeline] Glossary config error (skipping glossary): {e}")

        response = None
        try:
            response = self.translate_client.translate_text(request=request)
        except Exception as err:
            print(f"[Pipeline] Translation with glossary failed ({err}), retrying without glossary...")
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

    def synthesize_speech(self, text: str, target_lang: str = "es-US") -> Dict[str, Any]:
        start_time = time.time()
        
        clean_text = html.unescape(text)
        synthesis_input = texttospeech.SynthesisInput(text=clean_text)
        
        # Select natural Neural2 or Journey voice
        voice_params = texttospeech.VoiceSelectionParams(
            language_code=target_lang,
            name=f"{target_lang}-Neural2-F" if "es" in target_lang else f"{target_lang}-Neural2-A",
            ssml_gender=texttospeech.SsmlVoiceGender.FEMALE
        )

        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.LINEAR16,
            sample_rate_hertz=24000,
            speaking_rate=1.05
        )

        try:
            response = self.tts_client.synthesize_speech(
                input=synthesis_input,
                voice=voice_params,
                audio_config=audio_config
            )
            audio_content = response.audio_content
        except Exception:
            # Fallback to standard voice if neural voice is unavailable for locale
            fallback_voice = texttospeech.VoiceSelectionParams(
                language_code=target_lang,
                ssml_gender=texttospeech.SsmlVoiceGender.FEMALE
            )
            response = self.tts_client.synthesize_speech(
                input=synthesis_input,
                voice=fallback_voice,
                audio_config=audio_config
            )
            audio_content = response.audio_content

        duration_ms = (time.time() - start_time) * 1000
        return {
            "audio_base64": base64.b64encode(audio_content).decode("utf-8"),
            "audio_bytes_length": len(audio_content),
            "sample_rate": 24000,
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
        tts_lang_code = f"{target_lang}-US" if target_lang == "es" else f"{target_lang}-{target_lang.upper()}"
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
                "stt_model": stt_result.get("stt_model", "gemini-3.5-transcribe"),
                "translation_model": mt_result.get("model", "general/translation-llm"),
                "tts_voice": tts_lang_code
            },
            "glossary_applied": mt_result["glossary_applied"]
        }
