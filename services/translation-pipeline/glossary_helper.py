import os
import json
from google.cloud import translate_v3 as translate
from google.cloud import storage

PROJECT_ID = os.getenv("PROJECT_ID", "disney-parks-live-translation")
LOCATION = os.getenv("LOCATION", "us-central1")
GLOSSARY_ID = os.getenv("GLOSSARY_ID", "disney-parks-glossary-en-es")
BUCKET_NAME = os.getenv("GLOSSARY_BUCKET", f"{PROJECT_ID}-glossary")

def create_or_update_gcs_glossary(csv_path: str) -> str:
    """Uploads the local CSV glossary file to Google Cloud Storage."""
    storage_client = storage.Client(project=PROJECT_ID)
    try:
        bucket = storage_client.get_bucket(BUCKET_NAME)
    except Exception:
        bucket = storage_client.create_bucket(BUCKET_NAME, location=LOCATION)

    blob = bucket.blob("disney_glossary_en_es.csv")
    blob.upload_from_filename(csv_path)
    gcs_uri = f"gs://{BUCKET_NAME}/disney_glossary_en_es.csv"
    print(f"[GlossaryHelper] Uploaded glossary to {gcs_uri}")
    return gcs_uri

def create_translation_api_glossary(gcs_uri: str, source_lang="en", target_lang="es"):
    """Registers a Glossary resource in Cloud Translation API Advanced v3."""
    client = translate.TranslationServiceClient()
    parent = f"projects/{PROJECT_ID}/locations/{LOCATION}"
    glossary_name = f"{parent}/glossaries/{GLOSSARY_ID}"

    # Check if glossary already exists
    try:
        existing = client.get_glossary(name=glossary_name)
        print(f"[GlossaryHelper] Glossary {GLOSSARY_ID} already exists ({existing.name})")
        return existing
    except Exception:
        pass

    print(f"[GlossaryHelper] Creating Cloud Translation API Glossary: {GLOSSARY_ID}")
    
    gcs_source = translate.GcsSource(input_uri=gcs_uri)
    input_config = translate.GlossaryInputConfig(gcs_source=gcs_source)

    language_pair = translate.Glossary.LanguageCodePair(
        source_language_code=source_lang,
        target_language_code=target_lang,
    )

    glossary = translate.Glossary(
        name=glossary_name,
        language_pair=language_pair,
        input_config=input_config,
    )

    operation = client.create_glossary(parent=parent, glossary=glossary)
    print("[GlossaryHelper] Waiting for glossary creation operation to complete...")
    result = operation.result(timeout=180)
    print(f"[GlossaryHelper] Created glossary: {result.name}")
    return result

def get_glossary_config(source_lang="en", target_lang="es"):
    """Returns the translate_v3.TranslateTextGlossaryConfig if available."""
    glossary_name = f"projects/{PROJECT_ID}/locations/{LOCATION}/glossaries/{GLOSSARY_ID}"
    return translate.TranslateTextGlossaryConfig(
        glossary=glossary_name,
        ignore_case=True
    )
