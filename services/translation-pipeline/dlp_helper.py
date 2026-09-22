import os
import re
import time
from typing import Dict, Any, List, Optional
try:
    from google.cloud import dlp_v2
except Exception:
    dlp_v2 = None

PROJECT_ID = os.getenv("PROJECT_ID", "your-gcp-project-id")
LOCATION = os.getenv("LOCATION", "us-central1")

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
        "defaultEnabled": False # Disabled by default for natural booking/greeting conversations, enabled for full kiosk privacy
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

class LiveTranslationDLPManager:
    """
    Cloud Sensitive Data Protection (DLP) Service for Enterprise Live Translation.
    Provides real-time inspection, tokenization, and redaction with customizable InfoType rules.
    """
    def __init__(self, project_id: str = PROJECT_ID, location: str = LOCATION):
        self.project_id = project_id
        self.location = location
        self.parent = f"projects/{project_id}/locations/{location}"
        self.dlp_client = None
        try:
            self.dlp_client = dlp_v2.DlpServiceClient()
        except Exception as e:
            print(f"[LiveTranslationDLP] Could not initialize DlpServiceClient ({e}). Using local regex engine.", flush=True)

    def get_catalog(self) -> List[Dict[str, Any]]:
        # Return unique entries (avoiding duplicate aliases in catalog list)
        seen = set()
        unique_catalog = []
        for key in ["CREDIT_CARD_NUMBER", "EMAIL_ADDRESS", "PHONE_NUMBER", "PERSON_NAME", "US_PASSPORT", "RESERVATION_CONFIRMATION_ID", "SMART_WRISTBAND_UID", "ACCOUNT_SECURITY_PIN"]:
            if key in DLP_INFO_TYPE_CATALOG and key not in seen:
                seen.add(key)
                unique_catalog.append(DLP_INFO_TYPE_CATALOG[key])
        return unique_catalog

    def sanitize_text(
        self,
        text: str,
        enabled: bool = True,
        active_info_types: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Sanitize text using active DLP infoTypes.
        If enabled is False, returns the raw text untouched (e.g. for Over-the-Phone booking mode).
        """
        start_time = time.time()
        if not text or not text.strip():
            return {
                "original_text": text,
                "sanitized_text": text,
                "pii_detected": False,
                "findings": [],
                "active_info_types": active_info_types or [],
                "dlp_enabled": enabled,
                "latency_ms": 0.0
            }

        if not enabled:
            return {
                "original_text": text,
                "sanitized_text": text,
                "pii_detected": False,
                "findings": [],
                "active_info_types": active_info_types or [],
                "dlp_enabled": False,
                "latency_ms": round((time.time() - start_time) * 1000, 2)
            }

        # Determine active info types (default to catalog defaults if not specified)
        if active_info_types is None:
            active_info_types = [k for k, v in DLP_INFO_TYPE_CATALOG.items() if v.get("defaultEnabled", True)]

        # 1. First run fast local custom enterprise regex detectors
        sanitized = text
        findings = []

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
                                "placeholder": meta["placeholder"]
                            })
                    sanitized = pattern.sub(meta["placeholder"], sanitized)

        # 2. Standard Google Cloud DLP inspection for standard InfoTypes
        std_types = [t for t in active_info_types if not DLP_INFO_TYPE_CATALOG.get(t, {}).get("isCustom", False)]

        if std_types and self.dlp_client:
            try:
                gcp_info_types = [{"name": t} for t in std_types]
                inspect_config = {
                    "info_types": gcp_info_types,
                    "min_likelihood": dlp_v2.Likelihood.POSSIBLE,
                    "include_quote": True
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
                        }
                    })

                deidentify_config = {
                    "info_type_transformations": {
                        "transformations": transformations
                    }
                }

                item = {"value": sanitized}
                req = {
                    "parent": self.parent,
                    "deidentify_config": deidentify_config,
                    "inspect_config": inspect_config,
                    "item": item
                }
                
                resp = self.dlp_client.deidentify_content(request=req)
                sanitized = resp.item.value
                
                # Collect findings summary
                if resp.overview and resp.overview.transformation_summaries:
                    for s in resp.overview.transformation_summaries:
                        t_name = s.info_type.name if hasattr(s, "info_type") and s.info_type else "SENSITIVE_DATA"
                        meta = DLP_INFO_TYPE_CATALOG.get(t_name, {})
                        findings.append({
                            "infoType": t_name,
                            "displayName": meta.get("displayName", t_name),
                            "icon": meta.get("icon", "🛡️"),
                            "placeholder": meta.get("placeholder", f"[{t_name}]")
                        })
            except Exception as dlp_err:
                print(f"[LiveDLP] Cloud DLP API error ({dlp_err}), applying local regex fallback...", flush=True)
                # Local fallback regexes for standard types
                if "CREDIT_CARD_NUMBER" in std_types:
                    cc_pat = re.compile(r"\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{15,16}\b")
                    if cc_pat.search(sanitized):
                        findings.append({"infoType": "CREDIT_CARD_NUMBER", "displayName": "Credit Card / PCI-DSS", "icon": "💳"})
                        sanitized = cc_pat.sub("[CREDIT_CARD_REDACTED]", sanitized)

                if "PHONE_NUMBER" in std_types:
                    phone_pat = re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
                    if phone_pat.search(sanitized):
                        findings.append({"infoType": "PHONE_NUMBER", "displayName": "Phone Numbers", "icon": "📱"})
                        sanitized = phone_pat.sub("[PHONE_REDACTED]", sanitized)

                if "EMAIL_ADDRESS" in std_types:
                    email_pat = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b")
                    if email_pat.search(sanitized):
                        findings.append({"infoType": "EMAIL_ADDRESS", "displayName": "Email Addresses", "icon": "📧"})
                        sanitized = email_pat.sub("[EMAIL_REDACTED]", sanitized)
        elif std_types:
            # Local regex fallback when client is not initialized
            if "CREDIT_CARD_NUMBER" in std_types:
                cc_pat = re.compile(r"\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{15,16}\b")
                if cc_pat.search(sanitized):
                    findings.append({"infoType": "CREDIT_CARD_NUMBER", "displayName": "Credit Card / PCI-DSS", "icon": "💳"})
                    sanitized = cc_pat.sub("[CREDIT_CARD_REDACTED]", sanitized)

            if "PHONE_NUMBER" in std_types:
                phone_pat = re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
                if phone_pat.search(sanitized):
                    findings.append({"infoType": "PHONE_NUMBER", "displayName": "Phone Numbers", "icon": "📱"})
                    sanitized = phone_pat.sub("[PHONE_REDACTED]", sanitized)

            if "EMAIL_ADDRESS" in std_types:
                email_pat = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b")
                if email_pat.search(sanitized):
                    findings.append({"infoType": "EMAIL_ADDRESS", "displayName": "Email Addresses", "icon": "📧"})
                    sanitized = email_pat.sub("[EMAIL_REDACTED]", sanitized)

        duration_ms = (time.time() - start_time) * 1000
        pii_detected = len(findings) > 0 or sanitized != text

        return {
            "original_text": text,
            "sanitized_text": sanitized,
            "pii_detected": pii_detected,
            "findings": findings,
            "active_info_types": active_info_types,
            "dlp_enabled": enabled,
            "latency_ms": round(duration_ms, 2)
        }

DisneyDLPManager = LiveTranslationDLPManager
dlp_manager = LiveTranslationDLPManager()
