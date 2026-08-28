import os
import time
import base64
from typing import Dict, Any, List
from google.cloud import speech_v1p1beta1 as speech
from google.cloud import translate_v3 as translate
from google.cloud import texttospeech_v1 as texttospeech
from glossary_helper import get_glossary_config

PROJECT_ID = os.getenv("PROJECT_ID", "disney-parks-live-translation")
LOCATION = os.getenv("LOCATION", "us-central1")

class DisneyTranslationPipeline:
    def __init__(self):
        self.speech_client = speech.SpeechClient()
        self.translate_client = translate.TranslationServiceClient()
        self.tts_client = texttospeech.TextToSpeechClient()
        self.disney_phrases = [
            "Lightning Lane", "MagicBand+", "Cast Member", "Space Mountain",
            "Rise of the Resistance", "Haunted Mansion", "Big Thunder Mountain",
            "Galaxy's Edge", "Fantasyland", "PhotoPass", "Rider Switch",
            "Single Rider", "Tiana's Bayou Adventure", "Rope Drop", "Park Hopper"
        ]

    def transcribe_audio(self, pcm_data: bytes, sample_rate: int = 16000, lang_code: str = "en-US") -> Dict[str, Any]:
        start_time = time.time()
        
        # Build speech adaptation phrase set to bias Disney terms
        speech_context = speech.SpeechContext(
            phrases=self.disney_phrases,
            boost=15.0
        )

        config = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=sample_rate,
            language_code=lang_code,
            speech_contexts=[speech_context],
            enable_automatic_punctuation=True,
            model="default"
        )
        
        audio = speech.RecognitionAudio(content=pcm_data)
        response = self.speech_client.recognize(config=config, audio=audio)
        
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
            "confidence": confidence,
            "latency_ms": round(duration_ms, 2)
        }

    def translate_text(self, text: str, source_lang: str = "en", target_lang: str = "es", use_glossary: bool = True) -> Dict[str, Any]:
        start_time = time.time()
        parent = f"projects/{PROJECT_ID}/locations/{LOCATION}"
        
        request_kwargs: Dict[str, Any] = {
            "parent": parent,
            "contents": [text],
            "mime_type": "text/plain",
            "source_language_code": source_lang,
            "target_language_code": target_lang,
        }

        if use_glossary:
            try:
                request_kwargs["glossary_config"] = get_glossary_config(source_lang, target_lang)
            except Exception as e:
                print(f"[Pipeline] Glossary config error (skipping glossary): {e}")

        response = self.translate_client.translate_text(**request_kwargs)
        duration_ms = (time.time() - start_time) * 1000

        translated_text = ""
        glossary_applied = False

        if response.glossary_translations:
            translated_text = response.glossary_translations[0].translated_text
            glossary_applied = True
        elif response.translations:
            translated_text = response.translations[0].translated_text

        return {
            "translated_text": translated_text,
            "glossary_applied": glossary_applied,
            "latency_ms": round(duration_ms, 2)
        }

    def synthesize_speech(self, text: str, target_lang: str = "es-US") -> Dict[str, Any]:
        start_time = time.time()
        
        synthesis_input = texttospeech.SynthesisInput(text=text)
        
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
            "glossary_applied": mt_result["glossary_applied"]
        }
