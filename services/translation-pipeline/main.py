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

class AudioTranslateRequest(BaseModel):
    audio_base64: str
    source_lang: str = "en"
    target_lang: str = "es"
    use_glossary: bool = True

@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "translation-pipeline",
        "project_id": os.getenv("PROJECT_ID", "disney-parks-live-translation"),
        "location": os.getenv("LOCATION", "us-central1")
    }

@app.post("/api/translate-text")
def translate_text(req: TextTranslateRequest):
    return pipeline.translate_text(
        text=req.text,
        source_lang=req.source_lang,
        target_lang=req.target_lang,
        use_glossary=req.use_glossary
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
            if data.get("type") == "audio" and "pcm" in data:
                pcm_bytes = base64.b64decode(data["pcm"])
                src = data.get("sourceLang", "en")
                tgt = data.get("targetLang", "es")
                use_glossary = data.get("useGlossary", True)
                
                result = pipeline.run_full_pipeline(
                    pcm_bytes=pcm_bytes,
                    source_lang=src,
                    target_lang=tgt,
                    use_glossary=use_glossary
                )
                await websocket.send_json(result)
    except WebSocketDisconnect:
        print("[PipelineWS] Client disconnected")
    except Exception as e:
        print(f"[PipelineWS] Error: {e}")
        await websocket.close()

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8081"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
