"""Google Cloud Storage (GCS) persistence for Saved Conversations (JSON records + WAV audio recordings).

Stores:
  - `gs://<CONVERSATIONS_BUCKET>/conversations/index.json`      (sorted list of conversation summaries)
  - `gs://<CONVERSATIONS_BUCKET>/conversations/<id>.json`       (full conversation turn & telemetry JSON)
  - `gs://<CONVERSATIONS_BUCKET>/conversations/<id>.wav`        (24kHz LINEAR16 WAV audio recording)
"""
import base64
import datetime
import json
import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from google.cloud import storage

from dlp_helper import get_gcp_credentials
from pipeline import PROJECT_ID, LOCATION, pcm_to_wav

CONVERSATIONS_BUCKET = os.getenv(
    "CONVERSATIONS_BUCKET",
    os.getenv("GLOSSARY_BUCKET", f"{PROJECT_ID}-conversations"),
)
CONVERSATIONS_PREFIX = "conversations"


def _safe_id(raw_id: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "", raw_id or "")


def _extract_wav_bytes(conv: Dict[str, Any]) -> Optional[bytes]:
    """Assemble playable 24kHz WAV bytes from audioBase64, synthesizedPcmChunks, or turn audio."""
    audio_b64 = conv.get("audioBase64")
    if isinstance(audio_b64, str) and audio_b64.strip():
        try:
            b64_clean = audio_b64.split(",", 1)[-1] if "," in audio_b64 else audio_b64
            raw = base64.b64decode(b64_clean)
            if raw:
                return raw if raw[:4] == b"RIFF" else pcm_to_wav(raw, sample_rate=24000)
        except Exception:
            pass

    meta = conv.get("metadata") or {}
    chunks = meta.get("synthesizedPcmChunks")
    if isinstance(chunks, list) and chunks:
        pcm_parts: List[bytes] = []
        pause = b"\x00" * int(24000 * 2 * 0.30)
        for ch in chunks:
            b64_str = ch.get("pcm") if isinstance(ch, dict) else (ch if isinstance(ch, str) else None)
            if not b64_str:
                continue
            try:
                raw = base64.b64decode(b64_str)
                if raw:
                    pcm_parts.append(raw[44:] if raw[:4] == b"RIFF" else raw)
                    pcm_parts.append(pause)
            except Exception:
                continue
        if pcm_parts:
            return pcm_to_wav(b"".join(pcm_parts), sample_rate=24000)

    turns = conv.get("turns") or []
    turn_pcm: List[bytes] = []
    pause = b"\x00" * int(24000 * 2 * 0.30)
    for t in turns:
        if not isinstance(t, dict):
            continue
        tb64 = t.get("audioBase64")
        if isinstance(tb64, str) and tb64.strip():
            try:
                b64_clean = tb64.split(",", 1)[-1] if "," in tb64 else tb64
                raw = base64.b64decode(b64_clean)
                if raw:
                    turn_pcm.append(raw[44:] if raw[:4] == b"RIFF" else raw)
                    turn_pcm.append(pause)
            except Exception:
                continue
    if turn_pcm:
        return pcm_to_wav(b"".join(turn_pcm), sample_rate=24000)

    return None


class GCSConversationsStore:
    """Manages saved conversations (JSON + WAV audio) in Google Cloud Storage with local fallback."""

    def __init__(self) -> None:
        self.project_id = PROJECT_ID
        self.bucket_name = os.getenv("CONVERSATIONS_BUCKET") or f"{PROJECT_ID}-conversations"
        self.fallback_bucket_name = os.getenv("GLOSSARY_BUCKET") or f"{PROJECT_ID}-glossaries"
        self._client: Optional[storage.Client] = None
        self._bucket: Optional[storage.Bucket] = None
        self.local_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "conversations_cache")
        os.makedirs(self.local_dir, exist_ok=True)

    def _get_bucket(self) -> Optional[storage.Bucket]:
        if self._bucket is not None:
            return self._bucket
        try:
            if self._client is None:
                creds = get_gcp_credentials(self.project_id)
                self._client = storage.Client(project=self.project_id, credentials=creds)
            bucket = self._client.bucket(self.bucket_name)
            if bucket.exists():
                self._bucket = bucket
                return self._bucket
            try:
                self._bucket = self._client.create_bucket(bucket, location=LOCATION)
                print(f"[ConversationsGCS] Created bucket gs://{self.bucket_name}", flush=True)
                return self._bucket
            except Exception:
                fb = self._client.bucket(self.fallback_bucket_name)
                if fb.exists():
                    self.bucket_name = self.fallback_bucket_name
                    self._bucket = fb
                    return self._bucket
        except Exception as err:
            print(f"[ConversationsGCS] GCS unavailable ({err}), using local cache", flush=True)
        return None

    def _index_blob_name(self) -> str:
        return f"{CONVERSATIONS_PREFIX}/index.json"

    def _json_blob_name(self, conv_id: str) -> str:
        return f"{CONVERSATIONS_PREFIX}/{conv_id}.json"

    def _wav_blob_name(self, conv_id: str) -> str:
        return f"{CONVERSATIONS_PREFIX}/{conv_id}.wav"

    def _summary_from_record(self, data: Dict[str, Any]) -> Dict[str, Any]:
        cid = data.get("id") or "unknown"
        has_audio = bool(
            data.get("hasAudio")
            or data.get("gcsAudioUri")
            or data.get("audioBase64")
            or (data.get("turns") and any(isinstance(t, dict) and t.get("audioBase64") for t in data["turns"]))
            or (
                isinstance(data.get("metadata"), dict)
                and isinstance(data["metadata"].get("synthesizedPcmChunks"), list)
                and len(data["metadata"]["synthesizedPcmChunks"]) > 0
            )
        )
        return {
            "id": cid,
            "title": data.get("title") or "Untitled Conversation",
            "sourceLang": data.get("sourceLang") or "en",
            "targetLang": data.get("targetLang") or "es",
            "mode": data.get("mode") or "live",
            "createdAt": data.get("createdAt") or datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "turnCount": len(data.get("turns") or []),
            "hasAudio": has_audio,
            "storageBackend": data.get("storageBackend") or "gcs",
            "gcsBucket": self.bucket_name,
            "gcsJsonUri": data.get("gcsJsonUri") or f"gs://{self.bucket_name}/{self._json_blob_name(cid)}",
            "gcsAudioUri": data.get("gcsAudioUri") or (
                f"gs://{self.bucket_name}/{self._wav_blob_name(cid)}" if has_audio else None
            ),
        }

    def list_conversations(self) -> List[Dict[str, Any]]:
        bucket = self._get_bucket()
        if bucket is not None:
            try:
                idx_blob = bucket.blob(self._index_blob_name())
                if idx_blob.exists():
                    items = json.loads(idx_blob.download_as_text(encoding="utf-8"))
                    if isinstance(items, list):
                        items.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
                        return items
                # Rebuild index from existing JSON blobs in GCS
                summaries: List[Dict[str, Any]] = []
                for blob in self._client.list_blobs(bucket, prefix=f"{CONVERSATIONS_PREFIX}/"):
                    if not blob.name.endswith(".json") or blob.name.endswith("/index.json"):
                        continue
                    try:
                        data = json.loads(blob.download_as_text(encoding="utf-8"))
                        summaries.append(self._summary_from_record(data))
                    except Exception:
                        continue
                summaries.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
                idx_blob.upload_from_string(
                    json.dumps(summaries, indent=2), content_type="application/json"
                )
                return summaries
            except Exception as err:
                print(f"[ConversationsGCS] list_conversations error: {err}", flush=True)

        # Local fallback
        out: List[Dict[str, Any]] = []
        for fname in os.listdir(self.local_dir):
            if not fname.endswith(".json") or fname == "index.json":
                continue
            try:
                with open(os.path.join(self.local_dir, fname), encoding="utf-8") as f:
                    out.append(self._summary_from_record(json.load(f)))
            except Exception:
                continue
        out.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
        return out

    def get_conversation(self, conv_id: str) -> Optional[Dict[str, Any]]:
        safe_id = _safe_id(conv_id)
        if not safe_id:
            return None
        bucket = self._get_bucket()
        if bucket is not None:
            try:
                blob = bucket.blob(self._json_blob_name(safe_id))
                if blob.exists():
                    data = json.loads(blob.download_as_text(encoding="utf-8"))
                    # If audioBase64 wasn't inline in the JSON but WAV exists in GCS, attach it
                    if not data.get("audioBase64"):
                        wav_blob = bucket.blob(self._wav_blob_name(safe_id))
                        if wav_blob.exists():
                            wav_bytes = wav_blob.download_as_bytes()
                            data["audioBase64"] = base64.b64encode(wav_bytes).decode("utf-8")
                    return data
            except Exception as err:
                print(f"[ConversationsGCS] get_conversation error ({safe_id}): {err}", flush=True)

        local_path = os.path.join(self.local_dir, f"{safe_id}.json")
        if os.path.exists(local_path):
            with open(local_path, encoding="utf-8") as f:
                return json.load(f)
        return None

    def get_conversation_wav(self, conv_id: str) -> Optional[bytes]:
        safe_id = _safe_id(conv_id)
        if not safe_id:
            return None
        bucket = self._get_bucket()
        if bucket is not None:
            try:
                wav_blob = bucket.blob(self._wav_blob_name(safe_id))
                if wav_blob.exists():
                    return wav_blob.download_as_bytes()
            except Exception:
                pass
        local_wav = os.path.join(self.local_dir, f"{safe_id}.wav")
        if os.path.exists(local_wav):
            return open(local_wav, "rb").read()
        conv = self.get_conversation(safe_id)
        return _extract_wav_bytes(conv) if conv else None

    def save_conversation(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        raw_id = payload.get("id") or f"conv_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
        cid = _safe_id(raw_id) or f"conv_{int(time.time() * 1000)}"
        now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()

        wav_bytes = _extract_wav_bytes(payload)
        has_audio = bool(wav_bytes)
        json_uri = f"gs://{self.bucket_name}/{self._json_blob_name(cid)}"
        audio_uri = f"gs://{self.bucket_name}/{self._wav_blob_name(cid)}" if has_audio else None

        record: Dict[str, Any] = {
            "id": cid,
            "title": payload.get("title") or f"Conversation ({now_iso[:10]})",
            "sourceLang": payload.get("sourceLang") or "en",
            "targetLang": payload.get("targetLang") or "es",
            "mode": payload.get("mode") or "live",
            "createdAt": payload.get("createdAt") or now_iso,
            "turns": payload.get("turns") or [],
            "metadata": payload.get("metadata") or {},
            "hasAudio": has_audio,
            "storageBackend": "gcs",
            "gcsBucket": self.bucket_name,
            "gcsJsonUri": json_uri,
            "gcsAudioUri": audio_uri,
        }
        if payload.get("audioBase64"):
            record["audioBase64"] = payload["audioBase64"]
        elif wav_bytes:
            record["audioBase64"] = base64.b64encode(wav_bytes).decode("utf-8")

        bucket = self._get_bucket()
        if bucket is not None:
            try:
                if wav_bytes:
                    wav_blob = bucket.blob(self._wav_blob_name(cid))
                    wav_blob.upload_from_string(wav_bytes, content_type="audio/wav")
                json_blob = bucket.blob(self._json_blob_name(cid))
                json_blob.upload_from_string(
                    json.dumps(record, indent=2), content_type="application/json"
                )
                # Update index.json in GCS
                existing = [item for item in self.list_conversations() if item.get("id") != cid]
                existing.insert(0, self._summary_from_record(record))
                existing.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
                bucket.blob(self._index_blob_name()).upload_from_string(
                    json.dumps(existing, indent=2), content_type="application/json"
                )
                print(f"[ConversationsGCS] Saved {json_uri}" + (f" and {audio_uri}" if audio_uri else ""), flush=True)
            except Exception as err:
                print(f"[ConversationsGCS] Upload error ({cid}): {err}", flush=True)

        # Also keep local cache copy
        try:
            with open(os.path.join(self.local_dir, f"{cid}.json"), "w", encoding="utf-8") as f:
                json.dump(record, f, indent=2)
            if wav_bytes:
                with open(os.path.join(self.local_dir, f"{cid}.wav"), "wb") as wf:
                    wf.write(wav_bytes)
        except Exception:
            pass

        return record

    def delete_conversation(self, conv_id: str) -> bool:
        safe_id = _safe_id(conv_id)
        if not safe_id:
            return False
        deleted = False
        bucket = self._get_bucket()
        if bucket is not None:
            try:
                for bname in (self._json_blob_name(safe_id), self._wav_blob_name(safe_id)):
                    blob = bucket.blob(bname)
                    if blob.exists():
                        blob.delete()
                        deleted = True
                existing = [item for item in self.list_conversations() if item.get("id") != safe_id]
                bucket.blob(self._index_blob_name()).upload_from_string(
                    json.dumps(existing, indent=2), content_type="application/json"
                )
            except Exception as err:
                print(f"[ConversationsGCS] delete error ({safe_id}): {err}", flush=True)

        for ext in (".json", ".wav"):
            p = os.path.join(self.local_dir, f"{safe_id}{ext}")
            if os.path.exists(p):
                try:
                    os.remove(p)
                    deleted = True
                except Exception:
                    pass
        return deleted


conversations_store = GCSConversationsStore()
