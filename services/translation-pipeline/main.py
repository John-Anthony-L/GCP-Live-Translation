import os
import base64
from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from pipeline import DisneyTranslationPipeline
from glossary_helper import create_or_update_gcs_glossary, create_translation_api_glossary

app = FastAPI(title="Disney Live Translation - Competitor Pipeline (STT + MT v3 + TTS)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pipeline = DisneyTranslationPipeline()

class TextTranslateRequest(BaseModel):
    text: str
    source_lang: str = "en"
    target_lang: str = "es"
    use_glossary: bool = True
    model: Optional[str] = None

class AudioTranslateRequest(BaseModel):
    audio_base64: str
    source_lang: str = "en"
    target_lang: str = "es"
    use_glossary: bool = True
    model: Optional[str] = None

@app.get("/")
def root():
    return {
        "service": "Disney Parks Live Translation Advanced Pipeline",
        "status": "online",
        "models": {
            "speech_to_text": os.getenv("STT_MODEL", "gemini-3.5-transcribe"),
            "machine_translation": os.getenv("TRANSLATION_MODEL", "general/translation-llm"),
            "text_to_speech": "Neural2 / Journey High Fidelity"
        },
        "endpoints": {
            "health": "/health",
            "swagger_docs": "/docs",
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
        "project_id": os.getenv("PROJECT_ID", "disney-parks-live-translation"),
        "location": os.getenv("LOCATION", "us-central1"),
        "stt_model": os.getenv("STT_MODEL", "gemini-3.5-transcribe"),
        "translation_model": os.getenv("TRANSLATION_MODEL", "general/translation-llm")
    }

@app.post("/api/translate-text")
def translate_text(req: TextTranslateRequest):
    return pipeline.translate_text(
        text=req.text,
        source_lang=req.source_lang,
        target_lang=req.target_lang,
        use_glossary=req.use_glossary,
        model=req.model
    )

@app.post("/api/translate-audio")
def translate_audio(req: AudioTranslateRequest):
    pcm_bytes = base64.b64decode(req.audio_base64)
    return pipeline.run_full_pipeline(
        pcm_bytes=pcm_bytes,
        source_lang=req.source_lang,
        target_lang=req.target_lang,
        use_glossary=req.use_glossary
    )

@app.post("/api/upload-audio")
async def upload_audio(
    file: UploadFile = File(...),
    source_lang: str = Form("en"),
    target_lang: str = Form("es"),
    use_glossary: bool = Form(True)
):
    pcm_bytes = await file.read()
    return pipeline.run_full_pipeline(
        pcm_bytes=pcm_bytes,
        source_lang=source_lang,
        target_lang=target_lang,
        use_glossary=use_glossary
    )

@app.post("/api/glossary/sync")
def sync_glossary(csv_path: Optional[str] = None):
    target_path = csv_path or "/app/glossaries/disney_glossary_en_es.csv"
    if not os.path.exists(target_path):
        target_path = "../../glossaries/disney_glossary_en_es.csv"
    
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
    print("[PipelineWS] Client connected")
    try:
        while True:
            data = await websocket.receive_json()
            src = data.get("sourceLang", "en")
            tgt = data.get("targetLang", "es")
            use_glossary = data.get("useGlossary", True)
            speaker_role = data.get("speakerRole", "cast-member")

            if data.get("type") == "audio" and "pcm" in data:
                pcm_bytes = base64.b64decode(data["pcm"])
                
                # 1. Real-time STT with Gemini 3.5 Transcribe
                stt_lang = f"{src}-US" if src in ["en", "es"] else f"{src}-{src.upper()}"
                stt_res = pipeline.transcribe_audio(pcm_bytes, sample_rate=16000, lang_code=stt_lang)
                
                # Push STT transcript immediately to client
                await websocket.send_json({
                    "type": "stt_transcript",
                    "transcript": stt_res["transcript"],
                    "confidence": stt_res["confidence"],
                    "stt_ms": stt_res["latency_ms"],
                    "stt_model": stt_res.get("stt_model", "gemini-3.5-transcribe"),
                    "speakerRole": speaker_role
                })

                if not stt_res["transcript"]:
                    await websocket.send_json({"type": "no_speech", "message": "No audible speech detected"})
                    continue

                # 2. Real-time Translation with Translation LLM
                mt_res = pipeline.translate_text(
                    stt_res["transcript"],
                    source_lang=src,
                    target_lang=tgt,
                    use_glossary=use_glossary
                )

                # Push Translation text immediately
                await websocket.send_json({
                    "type": "translation_text",
                    "translated_text": mt_res["translated_text"],
                    "glossary_applied": mt_res["glossary_applied"],
                    "translation_ms": mt_res["latency_ms"],
                    "model": mt_res["model"]
                })

                # 3. High Fidelity Speech Synthesis
                tts_lang_code = f"{tgt}-US" if tgt == "es" else f"{tgt}-{tgt.upper()}"
                tts_res = pipeline.synthesize_speech(mt_res["translated_text"], target_lang=tts_lang_code)
                
                total_latency = round(stt_res["latency_ms"] + mt_res["latency_ms"] + tts_res["latency_ms"], 2)
                
                # Push audio stream for instant playback
                await websocket.send_json({
                    "type": "audio",
                    "pcm": tts_res["audio_base64"],
                    "sampleRate": 24000,
                    "total_latency_ms": total_latency,
                    "latency_breakdown": {
                        "stt_ms": stt_res["latency_ms"],
                        "translation_ms": mt_res["latency_ms"],
                        "tts_ms": tts_res["latency_ms"]
                    }
                })

            elif data.get("type") == "text" and "text" in data:
                text_input = data["text"]
                # Send immediate STT confirmation
                await websocket.send_json({
                    "type": "stt_transcript",
                    "transcript": text_input,
                    "confidence": 1.0,
                    "stt_ms": 0.0,
                    "speakerRole": speaker_role
                })

                mt_res = pipeline.translate_text(
                    text_input,
                    source_lang=src,
                    target_lang=tgt,
                    use_glossary=use_glossary
                )

                await websocket.send_json({
                    "type": "translation_text",
                    "translated_text": mt_res["translated_text"],
                    "glossary_applied": mt_res["glossary_applied"],
                    "translation_ms": mt_res["latency_ms"],
                    "model": mt_res["model"]
                })

                tts_lang_code = f"{tgt}-US" if tgt == "es" else f"{tgt}-{tgt.upper()}"
                tts_res = pipeline.synthesize_speech(mt_res["translated_text"], target_lang=tts_lang_code)

                total_latency = round(mt_res["latency_ms"] + tts_res["latency_ms"], 2)

                await websocket.send_json({
                    "type": "audio",
                    "pcm": tts_res["audio_base64"],
                    "sampleRate": 24000,
                    "total_latency_ms": total_latency,
                    "latency_breakdown": {
                        "stt_ms": 0.0,
                        "translation_ms": mt_res["latency_ms"],
                        "tts_ms": tts_res["latency_ms"]
                    }
                })
    except WebSocketDisconnect:
        print("[PipelineWS] Client disconnected")
    except Exception as e:
        print(f"[PipelineWS] Error: {e}")
        await websocket.close()

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8081"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
