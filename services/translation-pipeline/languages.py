"""Language catalog shared by the Chirp 3 cascade and the Gemini Live engines.

Each entry carries the locale codes each Google Cloud service expects:
  - stt:    Chirp 3 (Speech-to-Text V2) BCP-47 locale
  - mt:     Cloud Translation v3 language code
  - tts:    Cloud Text-to-Speech locale (Chirp 3 HD voices)
  - gemini: Gemini 3.5 Live Translate target_language_code
"""
from typing import Dict, Optional

LANGUAGES: Dict[str, Dict[str, str]] = {
    "en":    {"label": "English (US)",        "flag": "🇺🇸", "stt": "en-US",       "mt": "en",    "tts": "en-US",  "gemini": "en"},
    "es":    {"label": "Spanish (LatAm/US)",  "flag": "🇲🇽", "stt": "es-US",       "mt": "es",    "tts": "es-US",  "gemini": "es"},
    "es-ES": {"label": "Spanish (Spain)",     "flag": "🇪🇸", "stt": "es-ES",       "mt": "es",    "tts": "es-ES",  "gemini": "es"},
    "pt":    {"label": "Portuguese (Brazil)", "flag": "🇧🇷", "stt": "pt-BR",       "mt": "pt",    "tts": "pt-BR",  "gemini": "pt-BR"},
    "fr":    {"label": "French",              "flag": "🇫🇷", "stt": "fr-FR",       "mt": "fr",    "tts": "fr-FR",  "gemini": "fr"},
    "de":    {"label": "German",              "flag": "🇩🇪", "stt": "de-DE",       "mt": "de",    "tts": "de-DE",  "gemini": "de"},
    "it":    {"label": "Italian",             "flag": "🇮🇹", "stt": "it-IT",       "mt": "it",    "tts": "it-IT",  "gemini": "it"},
    "ja":    {"label": "Japanese",            "flag": "🇯🇵", "stt": "ja-JP",       "mt": "ja",    "tts": "ja-JP",  "gemini": "ja"},
    "ko":    {"label": "Korean",              "flag": "🇰🇷", "stt": "ko-KR",       "mt": "ko",    "tts": "ko-KR",  "gemini": "ko"},
    "zh":    {"label": "Chinese (Mandarin)",  "flag": "🇨🇳", "stt": "cmn-Hans-CN", "mt": "zh-CN", "tts": "cmn-CN", "gemini": "zh-Hans"},
}

# Base-language aliases for codes returned by auto-detection (Chirp 3 / Gemini / Translation API)
_BASE_ALIASES = {
    "en": "en", "es": "es", "pt": "pt", "fr": "fr", "de": "de", "it": "it",
    "ja": "ja", "ko": "ko", "zh": "zh", "cmn": "zh", "yue": "zh",
}


def resolve_language(code: Optional[str]) -> Optional[str]:
    """Normalize any locale/language code (e.g. 'es-us', 'fr-FR', 'cmn-Hans-CN') to a catalog key.

    Unknown languages are returned as-is so they can still be transcribed and translated.
    """
    if not code:
        return None
    raw = code.strip()
    low = raw.lower()

    for key, info in LANGUAGES.items():
        if low == key.lower():
            return key
    for key, info in LANGUAGES.items():
        if low in (info["stt"].lower(), info["tts"].lower(), info["gemini"].lower()):
            return key

    if low in ("es-es", "es-spain"):
        return "es-ES"
    base = low.split("-")[0]
    if base in _BASE_ALIASES:
        return _BASE_ALIASES[base]
    return raw


def lang_info(key: Optional[str]) -> Dict[str, str]:
    """Return the catalog entry for a key, synthesizing one for languages outside the catalog."""
    resolved = resolve_language(key) or "en"
    if resolved in LANGUAGES:
        return {"key": resolved, **LANGUAGES[resolved]}
    parts = resolved.split("-")
    base = parts[0].lower()
    locale = f"{base}-{parts[1].upper()}" if len(parts) > 1 else resolved
    return {
        "key": resolved,
        "label": resolved,
        "flag": "🌐",
        "stt": locale,
        "mt": base,
        "tts": locale,
        "gemini": base,
    }


def same_language(a: Optional[str], b: Optional[str]) -> bool:
    """True when two codes refer to the same base language (e.g. es-US vs es-ES)."""
    if not a or not b:
        return False
    return lang_info(a)["mt"].split("-")[0].lower() == lang_info(b)["mt"].split("-")[0].lower()


def public_catalog():
    """Catalog payload served to the web client."""
    return [{"code": k, **v} for k, v in LANGUAGES.items()]
