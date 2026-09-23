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
  const rootEnterprise = path.resolve(__dirname, '../../glossaries/enterprise_parks_glossary.json');
  if (fs.existsSync(rootEnterprise)) return rootEnterprise;
  const rootGlossary = path.resolve(__dirname, '../../glossaries/disney_parks_glossary.json');
  if (fs.existsSync(rootGlossary)) return rootGlossary;
  const localEnterprise = path.join(__dirname, 'enterprise_parks_glossary.json');
  if (fs.existsSync(localEnterprise)) return localEnterprise;
  return path.join(__dirname, 'disney_parks_glossary.json');
};

// Enterprise Brand Glossary API endpoints
app.get('/api/glossary', (req, res) => {
  try {
    const glossaryPath = getGlossaryPath();
    const raw = fs.readFileSync(glossaryPath, 'utf8');
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load brand glossary', message: err.message });
  }
});

// Add new glossary term (supports multi-language translations)
app.post('/api/glossary/terms', (req, res) => {
  try {
    const { en, es, pt, fr, ja, zh, category, keep_original, notes, translations } = req.body;
    if (!en || (!es && !translations)) {
      return res.status(400).json({ error: 'English term and primary translation are required.' });
    }

    const termId = en.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    
    // Assemble translations dictionary
    const termTranslations = Object.assign({}, translations || {});
    if (es && !termTranslations.es) termTranslations.es = es.trim();
    if (pt && !termTranslations.pt) termTranslations.pt = pt.trim();
    if (fr && !termTranslations.fr) termTranslations.fr = fr.trim();
    if (ja && !termTranslations.ja) termTranslations.ja = ja.trim();
    if (zh && !termTranslations.zh) termTranslations.zh = zh.trim();
    if (!termTranslations.es) {
      termTranslations.es = en.trim();
    }

    const newTerm = {
      term_id: termId,
      en: en.trim(),
      category: category ? category.trim() : 'Custom Term',
      keep_original: Boolean(keep_original),
      translations: termTranslations,
      notes: notes ? notes.trim() : 'Added via Glossary Manager'
    };

    const targetPaths = [
      path.resolve(__dirname, '../../glossaries/enterprise_parks_glossary.json'),
      path.resolve(__dirname, '../../glossaries/disney_parks_glossary.json'),
      path.join(__dirname, 'enterprise_parks_glossary.json'),
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
        syncCsvFromTerms(data.terms);
        saved = true;
      }
    }

    res.json({ success: true, term: newTerm, total: saved });
  } catch (err) {
    console.error('Error adding term:', err);
    res.status(500).json({ error: 'Failed to save new term', message: err.message });
  }
});

// Update existing glossary term
app.put('/api/glossary/terms/:termId', (req, res) => {
  try {
    const { termId } = req.params;
    const { en, category, keep_original, translations, notes, phonetic_en } = req.body;

    const targetPaths = [
      path.resolve(__dirname, '../../glossaries/enterprise_parks_glossary.json'),
      path.resolve(__dirname, '../../glossaries/disney_parks_glossary.json'),
      path.join(__dirname, 'enterprise_parks_glossary.json'),
      path.join(__dirname, 'disney_parks_glossary.json')
    ];

    let updatedTerm = null;
    for (const p of targetPaths) {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const idx = data.terms.findIndex(t => t.term_id === termId);
        if (idx !== -1) {
          const current = data.terms[idx];
          updatedTerm = {
            ...current,
            en: (en && en.trim()) || current.en,
            category: (category && category.trim()) || current.category,
            keep_original: keep_original !== undefined ? Boolean(keep_original) : current.keep_original,
            translations: translations !== undefined ? translations : (current.translations || {}),
            notes: notes !== undefined ? notes.trim() : (current.notes || '')
          };
          if (phonetic_en !== undefined) updatedTerm.phonetic_en = phonetic_en;
          data.terms[idx] = updatedTerm;
          fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
          syncCsvFromTerms(data.terms);
        }
      }
    }

    if (updatedTerm) {
      res.json({ success: true, term: updatedTerm });
    } else {
      res.status(404).json({ error: `Term ${termId} not found.` });
    }
  } catch (err) {
    console.error('Error updating term:', err);
    res.status(500).json({ error: 'Failed to update term', message: err.message });
  }
});

// Delete glossary term
app.delete('/api/glossary/terms/:termId', (req, res) => {
  try {
    const { termId } = req.params;
    const targetPaths = [
      path.resolve(__dirname, '../../glossaries/enterprise_parks_glossary.json'),
      path.resolve(__dirname, '../../glossaries/disney_parks_glossary.json'),
      path.join(__dirname, 'enterprise_parks_glossary.json'),
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
          syncCsvFromTerms(data.terms);
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

function syncCsvFromTerms(terms) {
  try {
    const csvPaths = [
      path.resolve(__dirname, '../../glossaries/brand_glossary_en_es.csv'),
      path.resolve(__dirname, '../../glossaries/disney_glossary_en_es.csv')
    ];
    const lines = terms.map(t => `${t.en},${(t.translations && t.translations.es) || t.en}`);
    const csvContent = lines.join('\n');
    for (const cp of csvPaths) {
      if (fs.existsSync(cp)) {
        fs.writeFileSync(cp, csvContent, 'utf8');
      }
    }
  } catch (e) {
    console.warn('Warning: Failed to sync CSV files:', e.message);
  }
}

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
    name: "RESERVATION_CONFIRMATION_ID",
    displayName: "Reservation & Booking IDs",
    category: "Hospitality & Guest Identifiers",
    icon: "🎫",
    description: "Resort, hotel, and attraction booking confirmation numbers (e.g. RES-982341, CONF-83921)",
    placeholder: "[RESERVATION_ID_REDACTED]",
    defaultEnabled: true,
    isCustom: true
  },
  {
    name: "SMART_WRISTBAND_UID",
    displayName: "Smart Wristband / RFID UID",
    category: "Hospitality & Guest Identifiers",
    icon: "📡",
    description: "Smart wearable RFID/NFC serial numbers and hardware identifiers (e.g. WB-A1B2C3D4)",
    placeholder: "[WRISTBAND_UID_REDACTED]",
    defaultEnabled: true,
    isCustom: true
  },
  {
    name: "ACCOUNT_SECURITY_PIN",
    displayName: "Account & Room Security PINs",
    category: "Hospitality & Guest Identifiers",
    icon: "🔑",
    description: "4-to-6 digit security PINs used for guest verification, room door access, and payment authorizations",
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
    if (info_types.includes("RESERVATION_CONFIRMATION_ID") || info_types.includes("DISNEY_RESERVATION_ID") || info_types.length === 0) {
      const resPat = /(?:RES|RESV|BKG|CONF|BOOKING|WDW|DLR)[-#\s]?\d{5,10}/gi;
      if (resPat.test(sanitized)) {
        findings.push({ infoType: "RESERVATION_CONFIRMATION_ID", displayName: "Reservation & Booking IDs", icon: "🎫" });
        sanitized = sanitized.replace(resPat, "[RESERVATION_ID_REDACTED]");
      }
    }
    if (info_types.includes("SMART_WRISTBAND_UID") || info_types.includes("MAGICBAND_UID") || info_types.length === 0) {
      const mbPat = /(?:WB|BAND|RFID|MB|MAGICBAND)[-#\s]?[A-Fa-f0-9]{8,12}/gi;
      if (mbPat.test(sanitized)) {
        findings.push({ infoType: "SMART_WRISTBAND_UID", displayName: "Smart Wristband / RFID UID", icon: "📡" });
        sanitized = sanitized.replace(mbPat, "[WRISTBAND_UID_REDACTED]");
      }
    }
    if (info_types.includes("ACCOUNT_SECURITY_PIN") || info_types.includes("DISNEY_PIN") || info_types.length === 0) {
      const pinPat = /(?:pin|passcode|code|security pin)\s*(?:is|:)?\s*(\b\d{4,6}\b)/gi;
      if (pinPat.test(sanitized)) {
        findings.push({ infoType: "ACCOUNT_SECURITY_PIN", displayName: "Account & Room Security PINs", icon: "🔑" });
        sanitized = sanitized.replace(pinPat, (match, p1) => match.replace(p1, "[PIN_REDACTED]"));
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
  console.log(`🌐 Enterprise Live Translation Web Client running on port ${PORT}`);
});
