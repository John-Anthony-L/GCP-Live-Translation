const express = require('express');
const path = require('path');
const http = require('http');
const fs = require('fs');

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

// Helper to get glossary path
const getGlossaryPath = () => {
  const rootGlossary = path.resolve(__dirname, '../../glossaries/disney_parks_glossary.json');
  if (fs.existsSync(rootGlossary)) return rootGlossary;
  return path.join(__dirname, 'disney_parks_glossary.json');
};

// Disney Glossary API endpoints
app.get('/api/glossary', (req, res) => {
  try {
    const glossaryPath = getGlossaryPath();
    const raw = fs.readFileSync(glossaryPath, 'utf8');
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load Disney glossary', message: err.message });
  }
});

// Add new glossary term
app.post('/api/glossary/terms', (req, res) => {
  try {
    const { en, es, category, keep_original, notes } = req.body;
    if (!en || !es) {
      return res.status(400).json({ error: 'English term and Spanish translation are required.' });
    }

    const termId = en.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const newTerm = {
      term_id: termId,
      en: en.trim(),
      category: category ? category.trim() : 'Custom Term',
      keep_original: Boolean(keep_original),
      translations: {
        es: es.trim()
      },
      notes: notes ? notes.trim() : 'Added via Glossary Manager'
    };

    const targetPaths = [
      path.resolve(__dirname, '../../glossaries/disney_parks_glossary.json'),
      path.join(__dirname, 'disney_parks_glossary.json')
    ];

    let saved = false;
    for (const p of targetPaths) {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        // Remove existing if duplicate
        data.terms = data.terms.filter(t => t.term_id !== termId && t.en.toLowerCase() !== en.trim().toLowerCase());
        data.terms.push(newTerm);
        fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
        saved = true;
      }
    }

    // Also update CSV file if it exists
    const csvPaths = [
      path.resolve(__dirname, '../../glossaries/disney_glossary_en_es.csv')
    ];
    for (const cp of csvPaths) {
      if (fs.existsSync(cp)) {
        fs.appendFileSync(cp, `\n${newTerm.en},${newTerm.translations.es}`);
      }
    }

    res.json({ success: true, term: newTerm, total: saved });
  } catch (err) {
    console.error('Error adding term:', err);
    res.status(500).json({ error: 'Failed to save new term', message: err.message });
  }
});

// Delete glossary term
app.delete('/api/glossary/terms/:termId', (req, res) => {
  try {
    const { termId } = req.params;
    const targetPaths = [
      path.resolve(__dirname, '../../glossaries/disney_parks_glossary.json'),
      path.join(__dirname, 'disney_parks_glossary.json')
    ];

    let deleted = false;
    for (const p of targetPaths) {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const initCount = data.terms.length;
        data.terms = data.terms.filter(t => t.term_id !== termId);
        if (data.terms.length < initCount) {
          fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
          deleted = true;
        }
      }
    }

    if (deleted) {
      res.json({ success: true, message: `Term ${termId} removed.` });
    } else {
      res.status(404).json({ error: `Term ${termId} not found.` });
    }
  } catch (err) {
    console.error('Error deleting term:', err);
    res.status(500).json({ error: 'Failed to delete term', message: err.message });
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
