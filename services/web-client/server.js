const express = require('express');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const TRANSLATION_PIPELINE_URL = process.env.TRANSLATION_PIPELINE_URL || 'http://localhost:8081';

app.use(express.json());

// Config endpoint exposing proxy URLs
app.get('/config.json', (req, res) => {
  res.json({
    geminiLiveProxyUrl: process.env.GEMINI_LIVE_PROXY_URL || 'ws://localhost:8080/live-translate',
    translationPipelineUrl: TRANSLATION_PIPELINE_URL,
    translationPipelineWsUrl: process.env.TRANSLATION_PIPELINE_WS_URL || 'ws://localhost:8081/ws/stream-translate',
  });
});

// Disney Glossary API endpoint
app.get('/api/glossary', (req, res) => {
  try {
    const glossaryPath = path.join(__dirname, 'disney_parks_glossary.json');
    const glossary = require(glossaryPath);
    res.json(glossary);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load Disney glossary', message: err.message });
  }
});

// Fallback catalog in case backend pipeline is starting
const DEFAULT_DLP_CATALOG = [
  {
    name: "CREDIT_CARD_NUMBER",
    displayName: "Credit Card / PCI-DSS",
    category: "PCI Compliance",
    icon: "💳",
    description: "Visa, MasterCard, Amex, Discover card numbers and security codes",
    placeholder: "[CREDIT_CARD_REDACTED]",
    defaultEnabled: true
  },
  {
    name: "PHONE_NUMBER",
    displayName: "Phone Numbers",
    category: "Contact Info",
    icon: "📱",
    description: "US and International telephone / mobile numbers",
    placeholder: "[PHONE_REDACTED]",
    defaultEnabled: true
  },
  {
    name: "EMAIL_ADDRESS",
    displayName: "Email Addresses",
    category: "Contact Info",
    icon: "📧",
    description: "Guest and Cast Member personal/work email addresses",
    placeholder: "[EMAIL_REDACTED]",
    defaultEnabled: true
  },
  {
    name: "PERSON_NAME",
    displayName: "Guest / Minor Names (COPPA)",
    category: "Children & PII Privacy",
    icon: "👶",
    description: "Full names of guests, minors, and family members",
    placeholder: "[GUEST_NAME_REDACTED]",
    defaultEnabled: false
  },
  {
    name: "US_PASSPORT",
    displayName: "Passports & Gov IDs",
    category: "Government ID",
    icon: "🛂",
    description: "Passport numbers, driver licenses, national ID numbers",
    placeholder: "[PASSPORT_REDACTED]",
    defaultEnabled: true
  },
  {
    name: "DISNEY_RESERVATION_ID",
    displayName: "Disney Reservation IDs",
    category: "Disney Brand Custom",
    icon: "🏰",
    description: "Walt Disney World, Disneyland, and Disney Cruise Line reservation numbers (e.g. WDW-982341, DLR-83921)",
    placeholder: "[DISNEY_RESERVATION_REDACTED]",
    defaultEnabled: true,
    isCustom: true
  },
  {
    name: "MAGICBAND_UID",
    displayName: "MagicBand+ Hardware UID",
    category: "Disney Brand Custom",
    icon: "🪄",
    description: "MagicBand+ RFID / NFC serial numbers and hardware identifiers (e.g. MB-A1B2C3D4)",
    placeholder: "[MAGICBAND_UID_REDACTED]",
    defaultEnabled: true,
    isCustom: true
  },
  {
    name: "DISNEY_PIN",
    displayName: "Disney Account & Resort PINs",
    category: "Disney Brand Custom",
    icon: "🔑",
    description: "4-to-6 digit security PINs used for MyDisneyExperience, hotel room door unlock, and park charging",
    placeholder: "[PIN_REDACTED]",
    defaultEnabled: true,
    isCustom: true
  }
];

// DLP Catalog API
app.get('/api/dlp/catalog', async (req, res) => {
  try {
    const pipelineHost = TRANSLATION_PIPELINE_URL.replace(/\/$/, '');
    const fetchRes = await fetch(`${pipelineHost}/api/dlp/catalog`, { signal: AbortSignal.timeout(2000) });
    if (fetchRes.ok) {
      const data = await fetchRes.json();
      return res.json(data);
    }
  } catch (err) {
    // fallback to local catalog
  }
  res.json({ status: "ok", catalog: DEFAULT_DLP_CATALOG });
});

// DLP Sanitize API Proxy
app.post('/api/dlp/sanitize', async (req, res) => {
  try {
    const pipelineHost = TRANSLATION_PIPELINE_URL.replace(/\/$/, '');
    const fetchRes = await fetch(`${pipelineHost}/api/dlp/sanitize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(3500)
    });
    if (fetchRes.ok) {
      const data = await fetchRes.json();
      return res.json(data);
    }
  } catch (err) {
    // Local fallback sanitizer
  }

  const { text = '', enabled = true, info_types = [] } = req.body || {};
  let sanitized = text;
  const findings = [];
  if (enabled && text) {
    if (info_types.includes("CREDIT_CARD_NUMBER") || info_types.length === 0) {
      const cc = /\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{15,16}\b/g;
      if (cc.test(sanitized)) {
        findings.push({ infoType: "CREDIT_CARD_NUMBER", displayName: "Credit Card / PCI-DSS", icon: "💳" });
        sanitized = sanitized.replace(cc, "[CREDIT_CARD_REDACTED]");
      }
    }
    if (info_types.includes("DISNEY_RESERVATION_ID") || info_types.length === 0) {
      const resPat = /(?:WDW|DLR|DISNEY|RES|CONF)[-#\s]?\d{5,10}/gi;
      if (resPat.test(sanitized)) {
        findings.push({ infoType: "DISNEY_RESERVATION_ID", displayName: "Disney Reservation IDs", icon: "🏰" });
        sanitized = sanitized.replace(resPat, "[DISNEY_RESERVATION_REDACTED]");
      }
    }
    if (info_types.includes("MAGICBAND_UID") || info_types.length === 0) {
      const mbPat = /(?:MB|MAGICBAND)[-#\s]?[A-Fa-f0-9]{8,12}/gi;
      if (mbPat.test(sanitized)) {
        findings.push({ infoType: "MAGICBAND_UID", displayName: "MagicBand+ Hardware UID", icon: "🪄" });
        sanitized = sanitized.replace(mbPat, "[MAGICBAND_UID_REDACTED]");
      }
    }
    if (info_types.includes("PHONE_NUMBER") || info_types.length === 0) {
      const phonePat = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
      if (phonePat.test(sanitized)) {
        findings.push({ infoType: "PHONE_NUMBER", displayName: "Phone Numbers", icon: "📱" });
        sanitized = sanitized.replace(phonePat, "[PHONE_REDACTED]");
      }
    }
    if (info_types.includes("EMAIL_ADDRESS") || info_types.length === 0) {
      const emailPat = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g;
      if (emailPat.test(sanitized)) {
        findings.push({ infoType: "EMAIL_ADDRESS", displayName: "Email Addresses", icon: "📧" });
        sanitized = sanitized.replace(emailPat, "[EMAIL_REDACTED]");
      }
    }
  }

  res.json({
    original_text: text,
    sanitized_text: sanitized,
    pii_detected: findings.length > 0 || sanitized !== text,
    findings,
    active_info_types: info_types,
    dlp_enabled: enabled,
    latency_ms: 5.0
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🏰 Disney Live Translation Web Testbed running on port ${PORT}`);
});
