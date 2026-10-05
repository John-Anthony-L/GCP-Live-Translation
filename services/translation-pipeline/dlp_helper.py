import os
import re
import time
from typing import Dict, Any, List, Optional
import requests

try:
    import google.auth
    from google.auth.transport.requests import Request as GoogleAuthRequest
except Exception:
    google = None
    GoogleAuthRequest = None

try:
    from google.cloud import dlp_v2
except Exception:
    dlp_v2 = None

PROJECT_ID = os.getenv("PROJECT_ID", "your-gcp-project-id")
LOCATION = os.getenv("LOCATION", "us-central1")
MODEL_ARMOR_LOCATION = os.getenv("MODEL_ARMOR_LOCATION", LOCATION)
MODEL_ARMOR_TEMPLATE_ID = os.getenv("MODEL_ARMOR_TEMPLATE_ID", "live-translation-armor")
MODEL_ARMOR_COPPA_TEMPLATE_ID = os.getenv("MODEL_ARMOR_COPPA_TEMPLATE_ID", "live-translation-armor-coppa")
USE_MODEL_ARMOR = os.getenv("USE_MODEL_ARMOR", "true").lower() in ("1", "true", "yes")

# Standard Enterprise & Privacy InfoType Catalog
DLP_INFO_TYPE_CATALOG = {
    "CREDIT_CARD_NUMBER": {
        "name": "CREDIT_CARD_NUMBER",
        "displayName": "Credit Card / PCI-DSS",
        "category": "PCI Compliance",
        "icon": "💳",
        "description": "Visa, MasterCard, Amex, Discover card numbers and security codes",
        "placeholder": "[CREDIT_CARD_REDACTED]",
        "defaultEnabled": True
    },
    "PHONE_NUMBER": {
        "name": "PHONE_NUMBER",
        "displayName": "Phone Numbers",
        "category": "Contact Info",
        "icon": "📱",
        "description": "US and International telephone / mobile numbers",
        "placeholder": "[PHONE_REDACTED]",
        "defaultEnabled": True
    },
    "EMAIL_ADDRESS": {
        "name": "EMAIL_ADDRESS",
        "displayName": "Email Addresses",
        "category": "Contact Info",
        "icon": "📧",
        "description": "Guest and Cast Member personal/work email addresses",
        "placeholder": "[EMAIL_REDACTED]",
        "defaultEnabled": True
    },
    "PERSON_NAME": {
        "name": "PERSON_NAME",
        "displayName": "Guest / Minor Names (COPPA)",
        "category": "Children & PII Privacy",
        "icon": "👶",
        "description": "Full names of guests, minors, and family members",
        "placeholder": "[GUEST_NAME_REDACTED]",
        "defaultEnabled": False  # Disabled by default for natural booking/greeting conversations, enabled for full kiosk privacy
    },
    "US_PASSPORT": {
        "name": "US_PASSPORT",
        "displayName": "Passports & Gov IDs",
        "category": "Government ID",
        "icon": "🛂",
        "description": "Passport numbers, driver licenses, national ID numbers",
        "placeholder": "[PASSPORT_REDACTED]",
        "defaultEnabled": True
    },
    "RESERVATION_CONFIRMATION_ID": {
        "name": "RESERVATION_CONFIRMATION_ID",
        "displayName": "Reservation & Booking IDs",
        "category": "Hospitality & Guest Identifiers",
        "icon": "🎫",
        "description": "Resort, hotel, and park booking confirmation numbers (e.g. RES-982341, CONF-83921)",
        "placeholder": "[RESERVATION_ID_REDACTED]",
        "defaultEnabled": True,
        "isCustom": True,
        "regex": r"(?:RES|RESV|BKG|CONF|BOOKING|WDW|DLR)[-#\s]?\d{5,10}"
    },
    "SMART_WRISTBAND_UID": {
        "name": "SMART_WRISTBAND_UID",
        "displayName": "Smart Wristband / RFID UID",
        "category": "Hospitality & Guest Identifiers",
        "icon": "📡",
        "description": "Smart wearable RFID / NFC serial numbers and hardware identifiers (e.g. WB-A1B2C3D4)",
        "placeholder": "[WRISTBAND_UID_REDACTED]",
        "defaultEnabled": True,
        "isCustom": True,
        "regex": r"(?:WB|BAND|RFID|MB|MAGICBAND)[-#\s]?[A-Fa-f0-9]{8,12}"
    },
    "ACCOUNT_SECURITY_PIN": {
        "name": "ACCOUNT_SECURITY_PIN",
        "displayName": "Account & Room Security PINs",
        "category": "Hospitality & Guest Identifiers",
        "icon": "🔑",
        "description": "4-to-6 digit security PINs used for guest verification, room door access, and payment authorizations",
        "placeholder": "[PIN_REDACTED]",
        "defaultEnabled": True,
        "isCustom": True,
        "regex": r"(?:pin|passcode|code|security pin)\s*(?:is|:)?\s*(\b\d{4,6}\b)"
    }
}

# Compatibility aliases
DLP_INFO_TYPE_CATALOG["DISNEY_RESERVATION_ID"] = DLP_INFO_TYPE_CATALOG["RESERVATION_CONFIRMATION_ID"]
DLP_INFO_TYPE_CATALOG["MAGICBAND_UID"] = DLP_INFO_TYPE_CATALOG["SMART_WRISTBAND_UID"]
DLP_INFO_TYPE_CATALOG["DISNEY_PIN"] = DLP_INFO_TYPE_CATALOG["ACCOUNT_SECURITY_PIN"]
DLP_INFO_TYPE_CATALOG["RESERVATION_ID"] = DLP_INFO_TYPE_CATALOG["RESERVATION_CONFIRMATION_ID"]
DLP_INFO_TYPE_CATALOG["PIN_CODE"] = DLP_INFO_TYPE_CATALOG["ACCOUNT_SECURITY_PIN"]

DEFAULT_STD_TYPES = {"CREDIT_CARD_NUMBER", "PHONE_NUMBER", "EMAIL_ADDRESS", "US_PASSPORT"}
COPPA_STD_TYPES = {"CREDIT_CARD_NUMBER", "PHONE_NUMBER", "EMAIL_ADDRESS", "US_PASSPORT", "PERSON_NAME"}


class LiveTranslationDLPManager:
    """
    Google Cloud Model Armor + Sensitive Data Protection (Cloud DLP) Service for Enterprise Live Translation.
    Provides real-time prompt injection / jailbreak screening, Responsible AI safety filtering,
    malicious URI detection, and Sensitive Data Protection (SDP) PII de-identification.
    """
    def __init__(self, project_id: str = PROJECT_ID, location: str = LOCATION):
        self.project_id = project_id
        self.location = location
        self.model_armor_location = MODEL_ARMOR_LOCATION or location
        self.parent = f"projects/{project_id}/locations/{location}"
        self.use_model_armor = USE_MODEL_ARMOR
        self.dlp_client = None
        self._creds = None
        self._http = requests.Session()
        try:
            if dlp_v2 is not None:
                self.dlp_client = dlp_v2.DlpServiceClient()
        except Exception as e:
            print(f"[LiveTranslationDLP] Could not initialize DlpServiceClient ({e}). Using local regex engine.", flush=True)

    def _get_auth_token(self) -> Optional[str]:
        if google is None or GoogleAuthRequest is None:
            return None
        try:
            if self._creds is None:
                self._creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
            if not self._creds.valid or self._creds.expired or not self._creds.token:
                self._creds.refresh(GoogleAuthRequest())
            return self._creds.token
        except Exception as e:
            print(f"[ModelArmor] Auth token error: {e}", flush=True)
            return None

    def get_catalog(self) -> List[Dict[str, Any]]:
        seen = set()
        unique_catalog = []
        for key in [
            "CREDIT_CARD_NUMBER",
            "EMAIL_ADDRESS",
            "PHONE_NUMBER",
            "PERSON_NAME",
            "US_PASSPORT",
            "RESERVATION_CONFIRMATION_ID",
            "SMART_WRISTBAND_UID",
            "ACCOUNT_SECURITY_PIN",
        ]:
            if key in DLP_INFO_TYPE_CATALOG and key not in seen:
                seen.add(key)
                unique_catalog.append(DLP_INFO_TYPE_CATALOG[key])
        return unique_catalog

    def _call_model_armor(
        self,
        text: str,
        template_id: str,
        is_response: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """
        Calls Google Cloud Model Armor regional endpoint (:sanitizeUserPrompt or :sanitizeModelResponse).
        Screens for Prompt Injection/Jailbreak, Responsible AI (Hate, Harassment, Dangerous, Sexually Explicit),
        CSAM, Malicious URLs, and Advanced Sensitive Data Protection (SDP de-identification).
        """
        if not self.use_model_armor or not self.project_id or self.project_id == "your-gcp-project-id":
            return None
        token = self._get_auth_token()
        if not token:
            return None

        method = "sanitizeModelResponse" if is_response else "sanitizeUserPrompt"
        payload_key = "modelResponseData" if is_response else "userPromptData"
        loc = self.model_armor_location
        url = (
            f"https://modelarmor.{loc}.rep.googleapis.com/v1/"
            f"projects/{self.project_id}/locations/{loc}/templates/{template_id}:{method}"
        )
        try:
            resp = self._http.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json={payload_key: {"text": text}},
                timeout=4.0,
            )
            if resp.status_code == 200:
                return resp.json()
            print(f"[ModelArmor] HTTP {resp.status_code} from {method}: {resp.text[:200]}", flush=True)
            return None
        except Exception as err:
            print(f"[ModelArmor] Request error ({err}), falling back to Cloud DLP", flush=True)
            return None

    def _apply_local_std_regex(self, sanitized: str, std_types: List[str], findings: List[Dict[str, Any]]) -> str:
        if "CREDIT_CARD_NUMBER" in std_types:
            cc_pat = re.compile(r"\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{15,16}\b")
            if cc_pat.search(sanitized):
                findings.append({
                    "infoType": "CREDIT_CARD_NUMBER",
                    "displayName": "Credit Card / PCI-DSS",
                    "icon": "💳",
                    "placeholder": "[CREDIT_CARD_REDACTED]",
                })
                sanitized = cc_pat.sub("[CREDIT_CARD_REDACTED]", sanitized)

        if "PHONE_NUMBER" in std_types:
            phone_pat = re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
            if phone_pat.search(sanitized):
                findings.append({
                    "infoType": "PHONE_NUMBER",
                    "displayName": "Phone Numbers",
                    "icon": "📱",
                    "placeholder": "[PHONE_REDACTED]",
                })
                sanitized = phone_pat.sub("[PHONE_REDACTED]", sanitized)

        if "EMAIL_ADDRESS" in std_types:
            email_pat = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b")
            if email_pat.search(sanitized):
                findings.append({
                    "infoType": "EMAIL_ADDRESS",
                    "displayName": "Email Addresses",
                    "icon": "📧",
                    "placeholder": "[EMAIL_REDACTED]",
                })
                sanitized = email_pat.sub("[EMAIL_REDACTED]", sanitized)
        return sanitized

    def sanitize_text(
        self,
        text: str,
        enabled: bool = True,
        active_info_types: Optional[List[str]] = None,
        is_response: bool = False,
    ) -> Dict[str, Any]:
        """
        Sanitizes text using GCP Model Armor (Prompt Injection/Jailbreak, Responsible AI, Malicious URI,
        and Advanced Sensitive Data Protection) + Custom Enterprise Regex InfoTypes + Cloud DLP fallback.
        """
        start_time = time.time()
        default_verdict = {
            "enabled": False,
            "blocked": False,
            "filter_match_state": "NO_MATCH_FOUND",
            "pi_and_jailbreak": "NO_MATCH_FOUND",
            "rai": "NO_MATCH_FOUND",
            "rai_categories": [],
            "malicious_uris": "NO_MATCH_FOUND",
            "csam": "NO_MATCH_FOUND",
            "sdp": "NO_MATCH_FOUND",
            "template": None,
        }
        if not text or not text.strip():
            return {
                "original_text": text,
                "sanitized_text": text,
                "pii_detected": False,
                "findings": [],
                "active_info_types": active_info_types or [],
                "dlp_enabled": enabled,
                "model_armor_enabled": False,
                "model_armor_blocked": False,
                "model_armor_verdict": default_verdict,
                "latency_ms": 0.0,
            }

        if not enabled:
            return {
                "original_text": text,
                "sanitized_text": text,
                "pii_detected": False,
                "findings": [],
                "active_info_types": active_info_types or [],
                "dlp_enabled": False,
                "model_armor_enabled": False,
                "model_armor_blocked": False,
                "model_armor_verdict": default_verdict,
                "latency_ms": round((time.time() - start_time) * 1000, 2),
            }

        # Determine active info types (default to catalog defaults if not specified)
        if active_info_types is None:
            active_info_types = [
                k for k in [
                    "CREDIT_CARD_NUMBER",
                    "EMAIL_ADDRESS",
                    "PHONE_NUMBER",
                    "US_PASSPORT",
                    "RESERVATION_CONFIRMATION_ID",
                    "SMART_WRISTBAND_UID",
                    "ACCOUNT_SECURITY_PIN",
                ]
                if DLP_INFO_TYPE_CATALOG.get(k, {}).get("defaultEnabled", True)
            ]

        # Normalize legacy alias names
        normalized_types: List[str] = []
        for t in active_info_types:
            meta = DLP_INFO_TYPE_CATALOG.get(t)
            if meta and meta["name"] not in normalized_types:
                normalized_types.append(meta["name"])
            elif t not in normalized_types:
                normalized_types.append(t)
        active_info_types = normalized_types

        # 1. Run fast local custom hospitality regex detectors first
        sanitized = text
        findings: List[Dict[str, Any]] = []

        for info_type in active_info_types:
            meta = DLP_INFO_TYPE_CATALOG.get(info_type)
            if not meta:
                continue
            if meta.get("isCustom") and "regex" in meta:
                pattern = re.compile(meta["regex"], re.IGNORECASE)
                matches = pattern.findall(sanitized)
                if matches:
                    for m in matches:
                        match_str = m if isinstance(m, str) else m[0]
                        if match_str:
                            findings.append({
                                "infoType": info_type,
                                "displayName": meta["displayName"],
                                "icon": meta["icon"],
                                "quote": match_str,
                                "placeholder": meta["placeholder"],
                            })
                    sanitized = pattern.sub(meta["placeholder"], sanitized)

        # 2. Standard Google Cloud InfoTypes & GCP Model Armor Screening
        std_types = [t for t in active_info_types if not DLP_INFO_TYPE_CATALOG.get(t, {}).get("isCustom", False)]
        std_set = set(std_types)

        template_id = MODEL_ARMOR_COPPA_TEMPLATE_ID if "PERSON_NAME" in std_set else MODEL_ARMOR_TEMPLATE_ID
        template_std_set = COPPA_STD_TYPES if "PERSON_NAME" in std_set else DEFAULT_STD_TYPES

        ma_resp = self._call_model_armor(sanitized, template_id=template_id, is_response=is_response)
        ma_verdict = dict(default_verdict)
        ma_sdp_handled = False

        if ma_resp and "sanitizationResult" in ma_resp:
            sr = ma_resp["sanitizationResult"]
            fr = sr.get("filterResults", {})
            pi_state = fr.get("pi_and_jailbreak", {}).get("piAndJailbreakFilterResult", {}).get("matchState", "NO_MATCH_FOUND")
            rai_res = fr.get("rai", {}).get("raiFilterResult", {})
            rai_state = rai_res.get("matchState", "NO_MATCH_FOUND")
            rai_cats = [
                cat for cat, detail in (rai_res.get("raiFilterTypeResults") or {}).items()
                if detail.get("matchState") == "MATCH_FOUND"
            ]
            uri_state = fr.get("malicious_uris", {}).get("maliciousUriFilterResult", {}).get("matchState", "NO_MATCH_FOUND")
            csam_state = fr.get("csam", {}).get("csamFilterFilterResult", {}).get("matchState", "NO_MATCH_FOUND")

            sdp_res = fr.get("sdp", {}).get("sdpFilterResult", {})
            deid_res = sdp_res.get("deidentifyResult") or {}
            insp_res = sdp_res.get("inspectResult") or {}
            sdp_state = deid_res.get("matchState") or insp_res.get("matchState") or "NO_MATCH_FOUND"

            blocked = any(s == "MATCH_FOUND" for s in (pi_state, rai_state, uri_state, csam_state))
            ma_verdict = {
                "enabled": True,
                "blocked": blocked,
                "filter_match_state": sr.get("filterMatchState", "NO_MATCH_FOUND"),
                "pi_and_jailbreak": pi_state,
                "rai": rai_state,
                "rai_categories": rai_cats,
                "malicious_uris": uri_state,
                "csam": csam_state,
                "sdp": sdp_state,
                "template": template_id,
            }

            if pi_state == "MATCH_FOUND":
                findings.append({
                    "infoType": "MODEL_ARMOR_PI_JAILBREAK",
                    "displayName": "Model Armor: Prompt Injection / Jailbreak",
                    "icon": "🛡️",
                    "placeholder": "[BLOCKED_PROMPT_INJECTION]",
                })
            if rai_state == "MATCH_FOUND":
                cats_label = ", ".join(c.replace("_", " ").title() for c in rai_cats) or "Safety Policy"
                findings.append({
                    "infoType": "MODEL_ARMOR_RAI",
                    "displayName": f"Model Armor RAI ({cats_label})",
                    "icon": "🚫",
                    "placeholder": "[BLOCKED_RAI_POLICY]",
                })
            if uri_state == "MATCH_FOUND":
                findings.append({
                    "infoType": "MODEL_ARMOR_MALICIOUS_URI",
                    "displayName": "Model Armor: Malicious URL",
                    "icon": "🔗",
                    "placeholder": "[BLOCKED_MALICIOUS_URL]",
                })

            # If Model Armor Advanced SDP matches the active standard InfoType set, use its de-identified text directly!
            if std_set == template_std_set and deid_res.get("executionState") == "EXECUTION_SUCCESS":
                ma_sdp_handled = True
                if deid_res.get("matchState") == "MATCH_FOUND":
                    sanitized = deid_res.get("data", {}).get("text", sanitized)
                    for t_name in deid_res.get("infoTypes", []):
                        meta = DLP_INFO_TYPE_CATALOG.get(t_name, {})
                        findings.append({
                            "infoType": t_name,
                            "displayName": meta.get("displayName", t_name),
                            "icon": meta.get("icon", "🛡️"),
                            "placeholder": meta.get("placeholder", f"[{t_name}]"),
                        })

        # 3. Fallback or custom standard InfoType subset via Cloud DLP client
        if std_types and not ma_sdp_handled:
            if self.dlp_client:
                try:
                    gcp_info_types = [{"name": t} for t in std_types]
                    inspect_config = {
                        "info_types": gcp_info_types,
                        "min_likelihood": dlp_v2.Likelihood.POSSIBLE,
                        "include_quote": True,
                    }
                    transformations = []
                    for t in std_types:
                        ph = DLP_INFO_TYPE_CATALOG.get(t, {}).get("placeholder", f"[{t}]")
                        transformations.append({
                            "info_types": [{"name": t}],
                            "primitive_transformation": {
                                "replace_config": {
                                    "new_value": {"string_value": ph}
                                }
                            },
                        })
                    deidentify_config = {
                        "info_type_transformations": {
                            "transformations": transformations
                        }
                    }
                    req = {
                        "parent": self.parent,
                        "deidentify_config": deidentify_config,
                        "inspect_config": inspect_config,
                        "item": {"value": sanitized},
                    }
                    resp = self.dlp_client.deidentify_content(request=req)
                    sanitized = resp.item.value
                    if resp.overview and resp.overview.transformation_summaries:
                        for s in resp.overview.transformation_summaries:
                            t_name = s.info_type.name if hasattr(s, "info_type") and s.info_type else "SENSITIVE_DATA"
                            meta = DLP_INFO_TYPE_CATALOG.get(t_name, {})
                            findings.append({
                                "infoType": t_name,
                                "displayName": meta.get("displayName", t_name),
                                "icon": meta.get("icon", "🛡️"),
                                "placeholder": meta.get("placeholder", f"[{t_name}]"),
                            })
                except Exception as dlp_err:
                    print(f"[LiveDLP] Cloud DLP API error ({dlp_err}), applying local regex fallback...", flush=True)
                    sanitized = self._apply_local_std_regex(sanitized, std_types, findings)
            else:
                sanitized = self._apply_local_std_regex(sanitized, std_types, findings)

        if ma_verdict.get("blocked"):
            reasons = []
            if ma_verdict.get("pi_and_jailbreak") == "MATCH_FOUND":
                reasons.append("Prompt Injection / Jailbreak")
            if ma_verdict.get("rai") == "MATCH_FOUND":
                cats = ", ".join(c.replace("_", " ").title() for c in ma_verdict.get("rai_categories", []))
                reasons.append(f"Responsible AI ({cats})" if cats else "Responsible AI Policy")
            if ma_verdict.get("malicious_uris") == "MATCH_FOUND":
                reasons.append("Malicious URI")
            if ma_verdict.get("csam") == "MATCH_FOUND":
                reasons.append("CSAM Filter")
            sanitized = f"[BLOCKED BY GCP MODEL ARMOR: {', '.join(reasons)}] {sanitized}"

        duration_ms = (time.time() - start_time) * 1000
        pii_detected = len(findings) > 0 or sanitized != text

        return {
            "original_text": text,
            "sanitized_text": sanitized,
            "pii_detected": pii_detected,
            "findings": findings,
            "active_info_types": active_info_types,
            "dlp_enabled": enabled,
            "model_armor_enabled": ma_verdict["enabled"],
            "model_armor_blocked": ma_verdict["blocked"],
            "model_armor_verdict": ma_verdict,
            "latency_ms": round(duration_ms, 2),
        }


DisneyDLPManager = LiveTranslationDLPManager
dlp_manager = LiveTranslationDLPManager()
