// Enterprise 2-Way Live Translation Client (Powered by Chirp 3 GA + Cloud DLP + MT v3 + Chirp 3 HD TTS)
let currentMode = 'translation-pipeline'; // 'translation-pipeline' | 'recorded-upload' | 'past-conversations' | 'dlp' | 'glossary'
let currentSpeakerRole = 'cast-member'; // 'cast-member' | 'guest' | 'ambient'
let isRecording = false;
let isContinuous = false;
let socket = null;
let audioContext = null;
let micStream = null;
let scriptProcessor = null;
let playbackContext = null;
let currentMessageBubble = null;
let lastSpeechStartTimestamp = 0;
let glossaryData = [];
// Utterance boundaries come from server-side endpointing (Chirp 3 / Gemini), not client VAD.

// Conversation History & Audio Persistence State
let liveConversationTurns = [];
let liveSynthesizedPcmChunks = []; // stores base64 PCM chunks of TTS
let currentUploadResult = null;
let savedConversationsList = [];
let selectedUploadFile = null;

// DLP State
let dlpMasterEnabled = true;
let dlpCatalog = [];
let activeDlpInfoTypes = new Set([
  "CREDIT_CARD_NUMBER",
  "PHONE_NUMBER",
  "EMAIL_ADDRESS",
  "US_PASSPORT",
  "RESERVATION_CONFIRMATION_ID",
  "SMART_WRISTBAND_UID",
  "ACCOUNT_SECURITY_PIN"
]);

// DOM Elements
const connectionStatus = document.getElementById('connectionStatus');
const statusLabel = connectionStatus.querySelector('.status-label');
const tabButtons = document.querySelectorAll('.tab-btn');
// Language catalog (mirrors services/translation-pipeline/languages.py)
const LANGUAGE_CATALOG = {
  en:      { label: 'English (US)',        flag: '🇺🇸' },
  es:      { label: 'Spanish (LatAm/US)',  flag: '🇲🇽' },
  'es-ES': { label: 'Spanish (Spain)',     flag: '🇪🇸' },
  pt:      { label: 'Portuguese (Brazil)', flag: '🇧🇷' },
  fr:      { label: 'French',              flag: '🇫🇷' },
  de:      { label: 'German',              flag: '🇩🇪' },
  it:      { label: 'Italian',             flag: '🇮🇹' },
  ja:      { label: 'Japanese',            flag: '🇯🇵' },
  ko:      { label: 'Korean',              flag: '🇰🇷' },
  zh:      { label: 'Chinese (Mandarin)',  flag: '🇨🇳' }
};
const ENGINE_INFO = {
  'chirp_3': { label: 'Chirp 3 (Speech v2)', speechToSpeech: false, pttOnly: false,
    note: 'GCP Model Armor & Cloud DLP screen and redact text before translation and speech.' },
  'gemini-3.5-transcribe': { label: 'Gemini 3.5 Transcribe', speechToSpeech: false, pttOnly: false,
    note: 'Gemini 3.5 Live transcribes; GCP Model Armor & Cloud DLP screen/redact before Translation v3 and Chirp 3 HD TTS.' },
  'gemini-3.5-live-translate': { label: 'Gemini 3.5 Live Translate', speechToSpeech: true, pttOnly: true,
    note: 'Speech-to-speech, push-to-talk only. Model Armor & DLP apply to transcripts only; brand glossary is not supported.' },
  'gemini-3.8-live': { label: 'Gemini 3.8 Live', speechToSpeech: true, pttOnly: false,
    note: 'Speech-to-speech interpreter. DLP + Model Armor rules protect spoken audio via system prompt + screen/redact transcripts via GCP Model Armor & Cloud DLP; brand glossary via system prompt.' }
};

function langMeta(code) {
  if (!code) return { label: 'Unknown', flag: '🌐' };
  return LANGUAGE_CATALOG[code] || { label: code, flag: '🌐' };
}

const castLangSelect = document.getElementById('castLangSelect');
const guestLangSelect = document.getElementById('guestLangSelect');
const smartDetectToggle = document.getElementById('smartDetectToggle');
const smartDetectHint = document.getElementById('smartDetectHint');
const guestLangHint = document.getElementById('guestLangHint');
const detectedGuestBadge = document.getElementById('detectedGuestBadge');
const engineSelect = document.getElementById('engineSelect');
const engineNote = document.getElementById('engineNote');
const castSpeakerLabel = document.getElementById('castSpeakerLabel');
const sttModelSub = document.getElementById('sttModelSub');

// Per-turn bubble tracking (server echoes turnId on every event)
const bubblesByTurn = new Map();
let turnCounter = 0;
let activeStreamTurnId = null;
const personaVoiceSelect = document.getElementById('personaVoice');
const continuousStreamToggle = document.getElementById('continuousStreamToggle');
const streamModeHint = document.getElementById('streamModeHint');
const castMemberMicBtn = document.getElementById('castMemberMicBtn');
const castMemberBtnSubtext = document.getElementById('castMemberBtnSubtext');
const guestMicBtn = document.getElementById('guestMicBtn');
const guestSpeakerLabel = document.getElementById('guestSpeakerLabel');
const guestBtnSubtext = document.getElementById('guestBtnSubtext');
const liveStatusText = document.getElementById('liveStatusText');
const audioPulse = document.getElementById('audioPulse');
const chatFeed = document.getElementById('chatFeed');
const clearChatBtn = document.getElementById('clearChatBtn');
const latencyValue = document.getElementById('latencyValue');
const latencySub = document.getElementById('latencySub');
const sttLatencyVal = document.getElementById('sttLatencyValue');
const dlpLatencyVal = document.getElementById('dlpLatencyValue');
const dlpMetricSub = document.getElementById('dlpMetricSub');
const transLatencyVal = document.getElementById('transLatencyValue');
const ttsLatencyVal = document.getElementById('ttsLatencyValue');
const textInput = document.getElementById('textInput');
const sendTextBtn = document.getElementById('sendTextBtn');
const glossaryGrid = document.getElementById('glossaryGrid');
const glossarySearch = document.getElementById('glossarySearch');

// DLP DOM Elements
const dlpGlobalBadge = document.getElementById('dlpGlobalBadge');
const dlpStatusPill = document.getElementById('dlpStatusPill');
const dlpPillText = document.getElementById('dlpPillText');
const dialogueDlpIndicator = document.getElementById('dialogueDlpIndicator');
const dlpMasterStatusBox = document.getElementById('dlpMasterStatusBox');
const dlpMasterStatusText = document.getElementById('dlpMasterStatusText');
const dlpMasterCountText = document.getElementById('dlpMasterCountText');
const dlpMasterCheckbox = document.getElementById('dlpMasterCheckbox');
const presetKiosk = document.getElementById('presetKiosk');
const presetConcierge = document.getElementById('presetConcierge');
const presetPhone = document.getElementById('presetPhone');
const activeRulesBadge = document.getElementById('activeRulesBadge');
const dlpRulesGrid = document.getElementById('dlpRulesGrid');
const sandboxInput = document.getElementById('sandboxInput');
const runDlpSandboxBtn = document.getElementById('runDlpSandboxBtn');
const sandboxOutput = document.getElementById('sandboxOutput');
const sandboxLatency = document.getElementById('sandboxLatency');
const sandboxPiiCount = document.getElementById('sandboxPiiCount');
const sandboxFindingsWrap = document.getElementById('sandboxFindingsWrap');
const sandboxFindingsList = document.getElementById('sandboxFindingsList');

// Live Pipeline Telemetry Terminal Elements
const terminalMicState = document.getElementById('terminalMicState');
const terminalRmsBar = document.getElementById('terminalRmsBar');
const terminalRmsText = document.getElementById('terminalRmsText');
const terminalSttText = document.getElementById('terminalSttText');
const terminalSttMeta = document.getElementById('terminalSttMeta');
const terminalDlpRow = document.getElementById('terminalDlpRow');
const terminalDlpText = document.getElementById('terminalDlpText');
const terminalDlpMeta = document.getElementById('terminalDlpMeta');
const terminalMtText = document.getElementById('terminalMtText');
const terminalMtMeta = document.getElementById('terminalMtMeta');
const terminalTtsText = document.getElementById('terminalTtsText');
const terminalTtsMeta = document.getElementById('terminalTtsMeta');
const terminalLogStream = document.getElementById('terminalLogStream');

function addTerminalLog(msg, type = '') {
  if (!terminalLogStream) return;
  const now = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line ${type ? 'log-' + type : ''}`;
  line.innerText = `[${now}] ${msg}`;
  terminalLogStream.appendChild(line);
  terminalLogStream.scrollTop = terminalLogStream.scrollHeight;
}

// Initialize
async function init() {
  populateLanguageSelects();
  setupTabs();
  setupControls();
  updateEngineUI();
  updateSmartDetectUI();
  updateLanguageLabels();
  setupRecordedUpload();
  setupPastConversations();
  await setupDLP();
  await setupGlossary();
  setupQuickScenarios();
  await connectWebSocket();
}

// Mode / Tab Switching
function setupTabs() {
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      switchMode(mode);
    });
  });

  if (dlpGlobalBadge) {
    dlpGlobalBadge.addEventListener('click', () => switchMode('dlp'));
  }
  if (dlpStatusPill) {
    dlpStatusPill.addEventListener('click', () => switchMode('dlp'));
  }
}

function switchMode(mode) {
  currentMode = mode;
  tabButtons.forEach(b => {
    if (b.getAttribute('data-mode') === mode) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });

  const sections = ['translationSection', 'recordedUploadSection', 'pastConversationsSection', 'dlpSection', 'glossarySection'];
  sections.forEach(secId => {
    const el = document.getElementById(secId);
    if (el) el.classList.remove('active');
  });

  if (mode === 'glossary') {
    document.getElementById('glossarySection')?.classList.add('active');
  } else if (mode === 'dlp') {
    document.getElementById('dlpSection')?.classList.add('active');
  } else if (mode === 'recorded-upload') {
    document.getElementById('recordedUploadSection')?.classList.add('active');
  } else if (mode === 'past-conversations') {
    document.getElementById('pastConversationsSection')?.classList.add('active');
    loadPastConversations();
  } else {
    document.getElementById('translationSection')?.classList.add('active');
    reconnectWebSocket();
  }
}

// Controls Setup
function setupControls() {
  continuousStreamToggle.addEventListener('change', async (e) => {
    if (e.target.checked) {
      await startContinuousStream();
    } else {
      stopContinuousStream();
    }
  });

  castLangSelect.addEventListener('change', () => {
    if (castLangSelect.value === guestLangSelect.value) {
      // Keep the pair distinct: swap the guest to the previous cast language
      guestLangSelect.value = castLangSelect.dataset.prev || (castLangSelect.value === 'en' ? 'es' : 'en');
    }
    castLangSelect.dataset.prev = castLangSelect.value;
    resetDetectedGuest();
    updateLanguageLabels();
    sendSessionConfig();
  });

  guestLangSelect.addEventListener('change', () => {
    resetDetectedGuest();
    updateLanguageLabels();
    sendSessionConfig();
  });

  smartDetectToggle.addEventListener('change', () => {
    resetDetectedGuest();
    updateSmartDetectUI();
    updateLanguageLabels();
    sendSessionConfig();
  });

  engineSelect.addEventListener('change', () => {
    updateEngineUI();
    const info = ENGINE_INFO[engineSelect.value];
    if (info && info.pttOnly && isContinuous) {
      stopContinuousStream();
      addSystemNote(`${info.label} supports Push-to-Talk only — switched from Continuous 2-Way Stream to Push-to-Talk.`);
    } else if (isContinuous && info) {
      streamModeHint.innerText = `🔴 Continuous 2-Way Stream (${info.label})`;
    }
    addTerminalLog(`Translation engine changed to: ${info ? info.label : engineSelect.value}`, 'system');
    sendSessionConfig();
  });

  personaVoiceSelect.addEventListener('change', () => {
    sendSessionConfig();
  });

  clearChatBtn.addEventListener('click', () => {
    chatFeed.innerHTML = `
      <div class="chat-welcome">
        <span class="sparkle-icon">🌐</span>
        <p>Chat cleared. Ready for live translation with Cloud DLP protection.</p>
      </div>
    `;
    currentMessageBubble = null;
    bubblesByTurn.clear();
    liveConversationTurns = [];
    liveSynthesizedPcmChunks = [];
  });

  // Live Transcript Export & Save Buttons
  const downloadLiveTranscriptBtn = document.getElementById('downloadLiveTranscriptBtn');
  if (downloadLiveTranscriptBtn) {
    downloadLiveTranscriptBtn.addEventListener('click', () => {
      downloadTranscriptFile(liveConversationTurns, 'live_conversation_transcript');
    });
  }

  const downloadLiveAudioBtn = document.getElementById('downloadLiveAudioBtn');
  if (downloadLiveAudioBtn) {
    downloadLiveAudioBtn.addEventListener('click', () => {
      downloadSynthesizedAudio(liveSynthesizedPcmChunks, 'live_translation_speech.wav');
    });
  }

  const saveLiveConversationBtn = document.getElementById('saveLiveConversationBtn');
  if (saveLiveConversationBtn) {
    saveLiveConversationBtn.addEventListener('click', async () => {
      await saveCurrentLiveConversation();
    });
  }

  // Cast Member Push to Talk
  setupMicButton(castMemberMicBtn, 'cast-member');

  // Guest Push to Talk
  setupMicButton(guestMicBtn, 'guest');

  // Text fallback send
  sendTextBtn.addEventListener('click', handleSendText);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendText();
  });
}

// Cloud Data Loss Protection (DLP) Setup
async function setupDLP() {
  try {
    const res = await fetch('/api/dlp/catalog');
    if (res.ok) {
      const data = await res.json();
      dlpCatalog = data.catalog || [];
    }
  } catch (err) {
    console.warn('[DLP] Could not fetch catalog, using defaults');
  }

  if (dlpCatalog.length === 0) {
    dlpCatalog = [
      { name: "CREDIT_CARD_NUMBER", displayName: "Credit Card / PCI-DSS", category: "PCI Compliance", icon: "💳", description: "Visa, MasterCard, Amex, Discover card numbers and CVVs", placeholder: "[CREDIT_CARD_REDACTED]", defaultEnabled: true },
      { name: "PHONE_NUMBER", displayName: "Phone Numbers", category: "Contact Info", icon: "📱", description: "US and International mobile/landline numbers", placeholder: "[PHONE_REDACTED]", defaultEnabled: true },
      { name: "EMAIL_ADDRESS", displayName: "Email Addresses", category: "Contact Info", icon: "📧", description: "Guest and Host personal/work email addresses", placeholder: "[EMAIL_REDACTED]", defaultEnabled: true },
      { name: "PERSON_NAME", displayName: "Guest / Minor Names (COPPA)", category: "Children & PII Privacy", icon: "👶", description: "Full names of guests, minors, and family members", placeholder: "[GUEST_NAME_REDACTED]", defaultEnabled: false },
      { name: "US_PASSPORT", displayName: "Passports & Gov IDs", category: "Government ID", icon: "🛂", description: "Passport numbers, driver licenses, national ID numbers", placeholder: "[PASSPORT_REDACTED]", defaultEnabled: true },
      { name: "RESERVATION_CONFIRMATION_ID", displayName: "Reservation & Booking IDs", category: "Hospitality & Guest Identifiers", icon: "🎫", description: "Resort, hotel, and park booking confirmation numbers (e.g. RES-982341, CONF-83921)", placeholder: "[RESERVATION_ID_REDACTED]", defaultEnabled: true, isCustom: true },
      { name: "SMART_WRISTBAND_UID", displayName: "Smart Wristband / RFID UID", category: "Hospitality & Guest Identifiers", icon: "📡", description: "Smart wearable RFID / NFC serial numbers (e.g. WB-A1B2C3D4)", placeholder: "[WRISTBAND_UID_REDACTED]", defaultEnabled: true, isCustom: true },
      { name: "ACCOUNT_SECURITY_PIN", displayName: "Account & Room Security PINs", category: "Hospitality & Guest Identifiers", icon: "🔑", description: "4-to-6 digit security PINs used for guest verification & room access", placeholder: "[PIN_REDACTED]", defaultEnabled: true, isCustom: true }
    ];
  }

  renderDlpRules();
  updateDlpUI();

  // Master DLP Toggle
  dlpMasterCheckbox.addEventListener('change', (e) => {
    dlpMasterEnabled = e.target.checked;
    updateDlpUI();
    if (!dlpMasterEnabled) {
      setActivePreset('phone');
    } else {
      setActivePreset(activeDlpInfoTypes.has('PERSON_NAME') ? 'kiosk' : 'concierge');
    }
  });

  // Preset Buttons
  presetKiosk.addEventListener('click', () => {
    dlpMasterEnabled = true;
    dlpMasterCheckbox.checked = true;
    activeDlpInfoTypes = new Set(dlpCatalog.map(r => r.name));
    setActivePreset('kiosk');
    renderDlpRules();
    updateDlpUI();
    addTerminalLog('DLP Preset Applied: 🔒 Public Park Kiosk (All 8 detectors active including COPPA Names)', 'dlp');
  });

  presetConcierge.addEventListener('click', () => {
    dlpMasterEnabled = true;
    dlpMasterCheckbox.checked = true;
    activeDlpInfoTypes = new Set(dlpCatalog.filter(r => r.name !== 'PERSON_NAME').map(r => r.name));
    setActivePreset('concierge');
    renderDlpRules();
    updateDlpUI();
    addTerminalLog('DLP Preset Applied: 🏰 Front Desk & Concierge (PCI & Custom masked, Names allowed for greetings)', 'dlp');
  });

  presetPhone.addEventListener('click', () => {
    dlpMasterEnabled = false;
    dlpMasterCheckbox.checked = false;
    setActivePreset('phone');
    renderDlpRules();
    updateDlpUI();
    addTerminalLog('DLP Preset Applied: 📞 Over-The-Phone Booking (DLP Bypassed for agent phone bookings)', 'dlp');
  });

  // Sandbox Setup
  document.querySelectorAll('.sample-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const sampleText = chip.getAttribute('data-sample');
      sandboxInput.value = sampleText;
      runDlpSandbox();
    });
  });

  runDlpSandboxBtn.addEventListener('click', runDlpSandbox);
}

function setActivePreset(name) {
  presetKiosk.classList.remove('active');
  presetConcierge.classList.remove('active');
  presetPhone.classList.remove('active');

  if (name === 'kiosk') presetKiosk.classList.add('active');
  if (name === 'concierge') presetConcierge.classList.add('active');
  if (name === 'phone') presetPhone.classList.add('active');
}

function renderDlpRules() {
  if (!dlpRulesGrid) return;
  dlpRulesGrid.innerHTML = '';

  dlpCatalog.forEach(rule => {
    const isEnabled = dlpMasterEnabled && activeDlpInfoTypes.has(rule.name);
    const card = document.createElement('div');
    card.className = `dlp-rule-card ${isEnabled ? 'enabled' : 'disabled'}`;
    
    card.innerHTML = `
      <div class="dlp-rule-top">
        <div class="dlp-rule-left">
          <span class="dlp-rule-icon">${rule.icon || '🛡️'}</span>
          <span class="dlp-rule-name">${rule.displayName}</span>
        </div>
        <label class="toggle-label">
          <input type="checkbox" class="rule-checkbox" data-rule="${rule.name}" ${activeDlpInfoTypes.has(rule.name) ? 'checked' : ''} ${!dlpMasterEnabled ? 'disabled' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="dlp-rule-meta">
        <span class="dlp-rule-category ${rule.isCustom ? 'custom' : ''}">${rule.category || 'Standard InfoType'}</span>
      </div>
      <p class="dlp-rule-desc">${rule.description}</p>
      <div class="dlp-rule-placeholder">Mask Token: ${rule.placeholder}</div>
    `;

    const cb = card.querySelector('.rule-checkbox');
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        activeDlpInfoTypes.add(rule.name);
      } else {
        activeDlpInfoTypes.delete(rule.name);
      }
      // Check preset state
      if (activeDlpInfoTypes.size === dlpCatalog.length) {
        setActivePreset('kiosk');
      } else if (activeDlpInfoTypes.size === dlpCatalog.length - 1 && !activeDlpInfoTypes.has('PERSON_NAME')) {
        setActivePreset('concierge');
      } else {
        setActivePreset('');
      }
      renderDlpRules();
      updateDlpUI();
    });

    dlpRulesGrid.appendChild(card);
  });
}

function updateDlpUI() {
  sendSessionConfig();
  const activeCount = dlpMasterEnabled ? activeDlpInfoTypes.size : 0;
  const totalCount = dlpCatalog.length;

  if (activeRulesBadge) {
    activeRulesBadge.innerText = `${activeCount} of ${totalCount} Active Detectors`;
  }

  if (dlpMasterStatusBox) {
    if (dlpMasterEnabled) {
      dlpMasterStatusBox.classList.remove('bypassed');
      dlpMasterStatusText.innerText = 'DLP ACTIVE';
      dlpMasterStatusText.style.color = '#2ecc71';
      dlpMasterCountText.innerText = `${activeCount} of ${totalCount} Rules Enabled`;
    } else {
      dlpMasterStatusBox.classList.add('bypassed');
      dlpMasterStatusText.innerText = 'DLP BYPASSED';
      dlpMasterStatusText.style.color = '#e74c3c';
      dlpMasterCountText.innerText = 'Bypass Mode (Phone Booking)';
    }
  }

  // Header & Controls Badges
  if (dlpGlobalBadge) {
    if (dlpMasterEnabled) {
      dlpGlobalBadge.className = 'dlp-header-badge active';
      dlpGlobalBadge.querySelector('.dlp-badge-text').innerText = `🛡️ DLP Active (${activeCount})`;
    } else {
      dlpGlobalBadge.className = 'dlp-header-badge bypassed';
      dlpGlobalBadge.querySelector('.dlp-badge-text').innerText = `⚠️ DLP Bypassed`;
    }
  }

  if (dlpStatusPill && dlpPillText) {
    if (dlpMasterEnabled) {
      dlpStatusPill.className = 'dlp-pill-btn active';
      dlpPillText.innerText = `DLP: Active (${activeCount} Rules)`;
    } else {
      dlpStatusPill.className = 'dlp-pill-btn bypassed';
      dlpPillText.innerText = `DLP: Bypassed (Phone Mode)`;
    }
  }

  if (dialogueDlpIndicator) {
    if (dlpMasterEnabled) {
      dialogueDlpIndicator.className = 'dlp-shield-indicator';
      dialogueDlpIndicator.innerText = `🛡️ DLP Protected (${activeCount} Rules)`;
    } else {
      dialogueDlpIndicator.className = 'dlp-shield-indicator bypassed';
      dialogueDlpIndicator.innerText = `⚠️ DLP Bypassed`;
      dialogueDlpIndicator.style.borderColor = 'rgba(231, 76, 60, 0.4)';
      dialogueDlpIndicator.style.color = '#ff6b6b';
    }
  }

  if (terminalDlpText) {
    if (dlpMasterEnabled) {
      terminalDlpText.innerText = `DLP Engine Active (${activeCount} Rules Monitoring PII/PCI)`;
    } else {
      terminalDlpText.innerText = `DLP Engine BYPASSED (Raw text will pass to LLM & TTS)`;
    }
  }
}

// Interactive DLP Sandbox Runner
async function runDlpSandbox() {
  const text = sandboxInput.value.trim();
  if (!text) {
    sandboxOutput.innerHTML = '<span class="output-placeholder">Please type or select a sample text above first.</span>';
    return;
  }

  sandboxOutput.innerHTML = '<em>Inspecting with Google Cloud DLP...</em>';

  try {
    const res = await fetch('/api/dlp/sanitize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        enabled: dlpMasterEnabled,
        info_types: Array.from(activeDlpInfoTypes)
      })
    });

    if (res.ok) {
      const data = await res.json();
      renderSandboxResult(data);
    } else {
      sandboxOutput.innerText = 'Inspection error. Please retry.';
    }
  } catch (err) {
    console.error('Sandbox error:', err);
    sandboxOutput.innerText = `Error running DLP: ${err.message}`;
  }
}

function renderSandboxResult(data) {
  let outputHtml = data.sanitized_text || '';
  
  // Highlight redaction placeholders and Model Armor block banners
  const placeholderRegex = /\[BLOCKED BY GCP MODEL ARMOR:[^\]]+\]|\[[A-Z0-9_]+_REDACTED\]|\[[A-Z0-9_]+\]/g;
  outputHtml = outputHtml.replace(placeholderRegex, (match) => `<span class="redacted-token">${match}</span>`);

  sandboxOutput.innerHTML = outputHtml;
  const maTag = data.model_armor_enabled
    ? (data.model_armor_blocked ? ' • 🚫 Model Armor BLOCKED' : ' • 🛡️ Model Armor Verified')
    : '';
  if (sandboxLatency) sandboxLatency.innerText = `Inspection Latency: ${data.latency_ms || 0} ms${maTag}`;
  if (sandboxPiiCount) sandboxPiiCount.innerText = `${data.findings ? data.findings.length : 0} Findings (Model Armor + SDP)`;

  if (sandboxFindingsWrap && sandboxFindingsList) {
    if (data.findings && data.findings.length > 0) {
      sandboxFindingsWrap.style.display = 'block';
      sandboxFindingsList.innerHTML = '';
      data.findings.forEach(f => {
        const item = document.createElement('div');
        item.className = 'finding-item';
        item.innerHTML = `
          <div class="finding-item-left">
            <span class="finding-badge">${f.icon || '🛡️'} ${f.displayName || f.infoType}</span>
            <span class="finding-quote">${f.quote ? `"${f.quote}"` : ''}</span>
          </div>
          <span class="finding-replacement">➔ ${f.placeholder || '[REDACTED]'}</span>
        `;
        sandboxFindingsList.appendChild(item);
      });
    } else {
      sandboxFindingsWrap.style.display = 'none';
    }
  }
}

// ----------------------------------------------------
// Languages, engine & session config
// ----------------------------------------------------
let detectedGuestLang = null; // set by Smart Guest Language Detection (sticky until reset)

function populateLanguageSelects() {
  document.querySelectorAll('select.lang-select').forEach(sel => {
    const def = sel.dataset.default || 'en';
    sel.innerHTML = Object.entries(LANGUAGE_CATALOG)
      .map(([key, meta]) => `<option value="${key}">${meta.flag} ${meta.label}</option>`)
      .join('');
    sel.value = def;
    sel.dataset.prev = def;
  });
}

function getCastLang() {
  return castLangSelect.value || 'en';
}

function getGuestLang() {
  return detectedGuestLang || guestLangSelect.value || 'es';
}

function getLangPair() {
  return [getCastLang(), getGuestLang()];
}

function getSessionConfig() {
  return {
    castLang: getCastLang(),
    guestLang: getGuestLang(),
    smartDetect: smartDetectToggle.checked,
    engine: engineSelect.value,
    voice: personaVoiceSelect.value,
    useGlossary: true,
    useDlp: dlpMasterEnabled,
    dlpInfoTypes: Array.from(activeDlpInfoTypes)
  };
}

function sendSessionConfig() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'config', ...getSessionConfig() }));
  }
}

// Per-turn settings. Languages are deliberately omitted: they only change through explicit
// 'config' messages, so a turn cannot overwrite a guest language the server just detected.
function getTurnConfig() {
  const { castLang, guestLang, ...rest } = getSessionConfig();
  return rest;
}

function resetDetectedGuest() {
  detectedGuestLang = null;
  if (detectedGuestBadge) {
    detectedGuestBadge.style.display = 'none';
    detectedGuestBadge.innerText = '';
  }
}

function showDetectedGuest(evt) {
  if (!evt || !evt.lang) return;
  if (!smartDetectToggle.checked) return;
  detectedGuestLang = evt.lang;
  const meta = langMeta(evt.lang);
  if (detectedGuestBadge) {
    detectedGuestBadge.innerText = `Detected: ${evt.flag || meta.flag} ${evt.label || meta.label}`;
    detectedGuestBadge.style.display = 'inline-flex';
  }
  updateLanguageLabels();
  if (evt.changed) {
    addTerminalLog(`Smart Detection: guest language set to ${evt.label || meta.label} (${evt.raw || evt.lang}). Cast replies will be translated into it.`, 'system');
  }
}

function currentEngineInfo() {
  return ENGINE_INFO[engineSelect.value] || ENGINE_INFO['chirp_3'];
}

function updateEngineUI() {
  const info = currentEngineInfo();
  if (engineNote) engineNote.innerText = info.note;
  if (sttModelSub) sttModelSub.innerText = info.speechToSpeech ? `${info.label} (input STT)` : info.label;
  if (terminalSttMeta) terminalSttMeta.innerText = info.label;
  const transModelSub = document.getElementById('transModelSub');
  const ttsVoiceSub = document.getElementById('ttsVoiceSub');
  if (transModelSub) transModelSub.innerText = info.speechToSpeech ? `${info.label} (first audio)` : 'Cloud Translation v3';
  if (ttsVoiceSub) ttsVoiceSub.innerText = info.speechToSpeech ? `${info.label} native audio` : 'Chirp 3 HD Voice';

  // 3.5 Live Translate is push-to-talk only
  if (continuousStreamToggle) {
    continuousStreamToggle.disabled = !!info.pttOnly;
    const toggleLabel = continuousStreamToggle.closest('.toggle-label');
    if (toggleLabel) toggleLabel.classList.toggle('disabled', !!info.pttOnly);
  }
  if (streamModeHint && !isContinuous) {
    streamModeHint.innerText = info.pttOnly ? 'Push-to-talk only for this engine' : 'Dual Push-to-Talk (Active)';
  }
}

function updateSmartDetectUI() {
  const on = smartDetectToggle.checked;
  if (guestLangHint) guestLangHint.innerText = on ? '(starting language)' : '(fixed)';
  if (smartDetectHint) {
    smartDetectHint.innerText = on
      ? "Auto-detects the guest's language"
      : 'Guest always speaks the selected language';
  }
}

function roleLabelFor(role, langKey) {
  if (role === 'cast-member') {
    const m = langMeta(langKey || getCastLang());
    return `${m.flag} Cast Member (${m.label})`;
  }
  if (role === 'guest') {
    const m = langMeta(langKey || getGuestLang());
    return `${m.flag} Guest (${m.label})`;
  }
  return '🎙️ Live 2-Way Ambient';
}

function updateLanguageLabels() {
  const cast = langMeta(getCastLang());
  const guest = langMeta(getGuestLang());

  // A guest language equal to the cast language makes no sense: disable it in the guest list
  Array.from(guestLangSelect.options).forEach(opt => {
    opt.disabled = opt.value === getCastLang();
  });

  if (castSpeakerLabel) castSpeakerLabel.innerText = `Cast Member (${cast.label})`;
  guestSpeakerLabel.innerText = smartDetectToggle.checked && !detectedGuestLang
    ? `Guest (auto-detect, starting ${guest.label})`
    : `Guest (${guest.label})`;
  if (!isContinuous) {
    if (castMemberBtnSubtext) castMemberBtnSubtext.innerText = `Hold to speak ${cast.flag}`;
    if (guestBtnSubtext) guestBtnSubtext.innerText = `Hold to speak ${smartDetectToggle.checked ? '🌐' : guest.flag}`;
  }
}

async function startContinuousStream() {
  const info = currentEngineInfo();
  if (info.pttOnly) {
    continuousStreamToggle.checked = false;
    alert(`${info.label} supports push-to-talk only. Use the Cast Member / Guest buttons, or choose another engine for continuous mode.`);
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    continuousStreamToggle.checked = false;
    alert('Not connected to the translation pipeline yet.');
    return;
  }

  isContinuous = true;
  continuousStreamToggle.checked = true;
  streamModeHint.innerText = '🔴 Continuous 2-Way Stream (Live Hands-Free)';
  streamModeHint.classList.add('stream-active');
  castMemberMicBtn.classList.add('ambient-active');
  guestMicBtn.classList.add('ambient-active');
  if (castMemberBtnSubtext) castMemberBtnSubtext.innerText = '🎙️ Live Ambient Mic';
  if (guestBtnSubtext) guestBtnSubtext.innerText = '🎙️ Live Ambient Mic';

  currentSpeakerRole = 'ambient';
  const cast = langMeta(getCastLang());
  const guestHint = smartDetectToggle.checked ? 'any guest language' : langMeta(getGuestLang()).label;
  addSystemNote(`Hands-free 2-way stream active (${info.label}). Speak naturally in ${cast.label} or ${guestHint}.`);
  await startRecording();
  setLiveStatus('🎙️ Ambient 2-Way Stream Live (Listening...)', true);
}

function stopContinuousStream() {
  isContinuous = false;
  continuousStreamToggle.checked = false;
  streamModeHint.innerText = 'Dual Push-to-Talk (Active)';
  streamModeHint.classList.remove('stream-active');
  castMemberMicBtn.classList.remove('ambient-active');
  guestMicBtn.classList.remove('ambient-active');
  updateLanguageLabels();
  updateEngineUI();

  stopRecording();
  setLiveStatus('Ready', false);
}

function setupMicButton(button, role) {
  const startHandler = async (e) => {
    if (e) e.preventDefault();
    if (isContinuous) {
      stopContinuousStream();
      return;
    }
    if (isRecording || micStarting) return;
    currentSpeakerRole = role;
    pttStopRequested = false;
    await startRecording();
    if (pttStopRequested) {
      // Released while the microphone was still opening
      stopRecording();
    }
  };

  const stopHandler = (e) => {
    if (e) e.preventDefault();
    if (isContinuous) return;
    if (micStarting) {
      pttStopRequested = true;
      return;
    }
    if (isRecording) stopRecording();
  };

  button.addEventListener('mousedown', startHandler);
  button.addEventListener('mouseup', stopHandler);
  button.addEventListener('mouseleave', stopHandler);
  button.addEventListener('touchstart', startHandler);
  button.addEventListener('touchend', stopHandler);
}

// Quick Scenario Buttons
function setupQuickScenarios() {
  document.querySelectorAll('.scenario-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const lang = chip.getAttribute('data-lang');
      const text = chip.getAttribute('data-text');
      // Phrases written in the cast language are cast turns; anything else is a guest turn
      const role = lang.split('-')[0] === getCastLang().split('-')[0] ? 'cast-member' : 'guest';
      sendTextTurn(text, role, lang);
    });
  });
}

function handleSendText() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  sendTextTurn(text, 'cast-member');
}

function sendTextTurn(text, role, langHint = null) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    alert('Not connected to the translation pipeline yet.');
    return;
  }
  const turnId = nextTurnId();
  currentSpeakerRole = role;
  addMessageBubble(role, text, turnId, role === 'guest' ? langHint : null);
  lastSpeechStartTimestamp = Date.now();
  setLiveStatus('Scrubbing PII with Cloud DLP & Translating...', true);
  socket.send(JSON.stringify({
    type: 'text',
    text,
    turnId,
    speakerRole: role,
    ...getTurnConfig()
  }));
}

// WebSocket Connection
async function connectWebSocket() {
  updateStatus('connecting', 'Connecting...');
  
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  let wsUrl = '';

  if (isLocal) {
    wsUrl = `ws://${host}:8092/ws/stream-translate`;
  } else {
    try {
      const configRes = await fetch('/config.json');
      if (configRes.ok) {
        const config = await configRes.json();
        if (config.translationPipelineWsUrl) {
          wsUrl = config.translationPipelineWsUrl;
        }
      }
    } catch (e) {
      console.log('[Config] Using location-based WebSocket routing');
    }

    if (!wsUrl) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${protocol}//${host}/ws/stream-translate`;
    }
  }

  console.log(`[WS] Connecting to ${wsUrl}`);

  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log(`[WS] Connected to Translation Pipeline`);
      updateStatus('connected', 'Live & Ready');
      setLiveStatus('Ready');
      // Push the current Cast / Guest / engine settings to the new session
      sendSessionConfig();
    };

    socket.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.warn('[WS] Non-JSON message ignored');
        return;
      }
      handleServerEvent(data);
    };

    socket.onerror = (err) => {
      console.error('[WS] Error:', err);
      updateStatus('disconnected', 'Connection Error');
      setLiveStatus('Offline');
    };

    socket.onclose = () => {
      console.log('[WS] Closed');
      updateStatus('disconnected', 'Disconnected');
      setLiveStatus('Disconnected');
    };
  } catch (e) {
    console.error('Failed to connect WebSocket:', e);
    updateStatus('disconnected', 'Unavailable');
  }
}

function reconnectWebSocket() {
  if (socket) {
    socket.close();
  }
  setTimeout(connectWebSocket, 300);
}

function updateStatus(state, label) {
  connectionStatus.className = `status-indicator ${state}`;
  statusLabel.innerText = label;
}

function setLiveStatus(text, isPulse = false) {
  liveStatusText.innerText = text;
  if (isPulse) {
    audioPulse.classList.add('active');
  } else {
    audioPulse.classList.remove('active');
  }
}

// ----------------------------------------------------
// Server event handling (events carry the turnId of the bubble they belong to)
// ----------------------------------------------------
function engineLabel(key) {
  return (ENGINE_INFO[key] && ENGINE_INFO[key].label) || key || 'engine';
}

function setMetric(el, value) {
  if (!el) return;
  el.innerText = (value === null || value === undefined || Number.isNaN(value)) ? '--' : Math.round(value);
}

function handleServerEvent(data) {
  const turnId = data.turnId || null;

  switch (data.type) {
    case 'ready':
      console.log('[WS] Session ready:', data);
      updateStatus('connected', 'Live & Ready');
      break;

    case 'config_ack':
      console.log('[WS] Config applied:', data);
      break;

    case 'stream_started':
      console.log('[WS] Stream started:', data);
      if (data.hotSwapped) {
        activeStreamTurnId = data.turnId;
        addSystemNote(`🔄 Switched active stream engine to ${engineLabel(data.engine)}`);
      }
      addTerminalLog(`Stream ${data.hotSwapped ? 'hot-swapped' : 'opened'} (${engineLabel(data.engine)}, ${data.speakerRole}, cast=${data.castLang}, guest=${data.guestLang}${data.smartDetect ? ', smart detection' : ''})`, 'system');
      break;

    case 'guest_language_detected':
      showDetectedGuest(data);
      break;

    case 'engine_fallback': {
      const msg = `${engineLabel(data.from)} unavailable, using ${engineLabel(data.to)} for this turn.`;
      addSystemNote(`${msg}${data.reason ? ' ' + data.reason : ''}`);
      addTerminalLog(`Engine fallback: ${msg} ${data.reason || ''}`, 'err');
      break;
    }

    case 'interim_transcript': {
      const bubble = ensureTurnBubble(turnId, data.speakerRole);
      setBubbleInterim(bubble, data.transcript);
      if (terminalSttText && data.transcript) terminalSttText.innerText = `"${data.transcript}..."`;
      break;
    }

    case 'interim_translation': {
      const bubble = ensureTurnBubble(turnId, data.speakerRole);
      updateBubbleTranslation(bubble, data.translated_text, { interim: true });
      break;
    }

    case 'stt_transcript': {
      console.log('[WS] STT Transcript:', data);
      const bubble = ensureTurnBubble(turnId, data.speakerRole);
      updateBubbleOriginal(bubble, {
        transcript: data.sanitized_transcript || data.transcript,
        sttMs: data.stt_ms,
        sttModel: data.stt_model,
        role: data.speakerRole,
        srcLang: data.srcLang,
        tgtLang: data.tgtLang,
        detectedLang: data.detectedLang,
        dlpApplied: data.dlp_applied,
        dlpScope: data.dlp_scope
      });
      setMetric(sttLatencyVal, data.stt_ms);
      if (sttModelSub && data.stt_model) sttModelSub.innerText = data.stt_model;
      const sttMsText = data.stt_ms === null || data.stt_ms === undefined ? 'in-model' : `${Math.round(data.stt_ms)}ms`;
      if (terminalSttText) {
        terminalSttText.innerText = data.transcript ? `"${data.transcript}"` : '(No speech detected)';
        terminalSttMeta.innerText = `${data.stt_model || ''} • ${data.detectedLang || data.srcLang || '?'} • ${sttMsText}`;
      }
      if (data.transcript) {
        addTerminalLog(`STT (${data.stt_model}): "${data.transcript}" [${data.detectedLang || data.srcLang}] ${data.srcLang} → ${data.tgtLang}, ${sttMsText}`, 'stt');
      }
      if (!currentEngineInfo().speechToSpeech) setLiveStatus('Scrubbing PII & Translating...', true);
      break;
    }

    case 'model_armor_block': {
      console.warn('[WS] GCP Model Armor Block:', data);
      audioPlaybackQueue = [];
      addTerminalLog(`[MODEL ARMOR BLOCK] Turn ${turnId || ''} blocked by GCP Model Armor policy (Prompt Injection / Responsible AI)`, 'dlp');
      break;
    }

    case 'dlp_status': {
      console.log('[WS] DLP Status:', data);
      setMetric(dlpLatencyVal, data.dlp_latency_ms);
      if (data.model_armor_blocked) {
        audioPlaybackQueue = [];
      }
      if (turnId && bubblesByTurn.has(turnId)) {
        const b = bubblesByTurn.get(turnId);
        if (b && b._turnData) {
          b._turnData.dlpMs = data.dlp_latency_ms;
          b._turnData.dlpApplied = !!data.pii_detected;
          b._turnData.dlpScope = data.dlp_scope;
          b._turnData.modelArmorBlocked = !!data.model_armor_blocked;
          renderBubbleLatencyRow(b);
        }
      }
      const scope = data.dlp_scope === 'transcript_only'
        ? ' (transcript only)'
        : (data.dlp_scope === 'prompt_and_transcript' ? ' (prompt + transcript)' : '');
      const maPrefix = data.model_armor_enabled ? 'Model Armor + ' : '';
      const findings = data.findings || [];
      if (dlpMetricSub) {
        if (data.model_armor_blocked) {
          dlpMetricSub.innerText = `🚫 Blocked by Model Armor`;
        } else {
          dlpMetricSub.innerText = data.pii_detected
            ? `⚠️ ${findings.length} PII Masked${scope}`
            : (data.dlp_enabled ? `🛡️ ${maPrefix}Clean${scope}` : '⚠️ Bypassed');
        }
      }
      if (terminalDlpText) {
        if (data.model_armor_blocked) {
          terminalDlpText.innerHTML = `🚫 <span style="color:#ff5252">Blocked by GCP Model Armor:</span> "${escapeHtml(data.sanitized_text)}"`;
          terminalDlpMeta.innerText = `Policy Violation • ${Math.round(data.dlp_latency_ms || 0)}ms${scope}`;
          addTerminalLog(`[MODEL ARMOR BLOCKED] ${findings.map(f => f.infoType ? (f.displayName || f.infoType) : f).join(', ')} (${Math.round(data.dlp_latency_ms || 0)}ms)`, 'dlp');
        } else if (data.pii_detected) {
          terminalDlpText.innerHTML = `⚠️ <span style="color:#ff8a80">PII Scrubbed:</span> "${escapeHtml(data.sanitized_text)}"`;
          terminalDlpMeta.innerText = `${findings.length} Findings • ${Math.round(data.dlp_latency_ms || 0)}ms${scope}`;
          const where = data.dlp_scope === 'transcript_only'
            ? 'in transcripts (spoken audio is not redacted)'
            : (data.dlp_scope === 'prompt_and_transcript'
              ? 'via system prompt (spoken audio) + GCP Model Armor / DLP (transcripts)'
              : 'before translation and speech');
          addTerminalLog(`[DLP MASKED] ${findings.map(f => f.infoType ? (f.displayName || f.infoType) : f).join(', ')} redacted ${where} (${Math.round(data.dlp_latency_ms || 0)}ms)`, 'dlp');
        } else {
          terminalDlpText.innerText = data.dlp_enabled ? `🛡️ ${maPrefix}Clean (No PII / Threats)` : `⚠️ DLP Bypassed (Raw)`;
          terminalDlpMeta.innerText = `${Math.round(data.dlp_latency_ms || 0)}ms${scope}`;
        }
      }
      break;
    }

    case 'translation_text': {
      console.log('[WS] Translation Text:', data);
      const bubble = ensureTurnBubble(turnId, data.speakerRole);
      updateBubbleTranslation(bubble, data.translated_text, {
        glossaryApplied: data.glossary_applied,
        glossaryMode: data.glossary_mode,
        transMs: data.translation_ms,
        ttsMs: data.tts_ms,
        totalLatencyMs: data.total_latency_ms,
        tgtLang: data.tgtLang,
        engine: data.engine,
        model: data.model
      });
      setMetric(transLatencyVal, data.translation_ms);
      if (data.tts_ms !== undefined && data.tts_ms !== null) {
        setMetric(ttsLatencyVal, data.tts_ms);
      }
      if (data.total_latency_ms !== undefined && data.total_latency_ms !== null) {
        setMetric(latencyValue, data.total_latency_ms);
        if (latencySub) {
          latencySub.innerText = data.engine
            ? (isContinuous ? 'Speech pause → translated audio + DLP' : 'Release → translated audio + DLP')
            : 'End-to-End Latency';
        }
      }
      let glossaryText;
      if (data.glossary_mode === 'prompt') glossaryText = 'Glossary via system prompt';
      else if (data.glossary_mode === 'none') glossaryText = 'No glossary (not supported by engine)';
      else glossaryText = data.glossary_applied ? '📖 Brand Glossary Enforced' : (data.model || 'Cloud Translation v3');
      if (terminalMtText) {
        terminalMtText.innerText = `"${data.translated_text}"`;
        terminalMtMeta.innerText = `${glossaryText} • ${Math.round(data.translation_ms || 0)}ms`;
      }
      addTerminalLog(`Translation ${data.srcLang || ''} → ${data.tgtLang || ''}: "${data.translated_text}" (${glossaryText}, ${Math.round(data.translation_ms || 0)}ms)`, 'mt');
      if (!currentEngineInfo().speechToSpeech) setLiveStatus('Generating Neural Speech...', true);
      break;
    }

    case 'audio': {
      if (!data.pcm) break;
      const firstChunk = data.total_latency_ms !== undefined;
      if (firstChunk) {
        setMetric(latencyValue, data.total_latency_ms);
        const lb = data.latency_breakdown || {};
        if (lb.first_audio_ms !== undefined) {
          if (latencySub) {
            latencySub.innerText = isContinuous ? 'Speech pause → first translated audio' : 'Release → first translated audio';
          }
          if (lb.stt_ms !== undefined && lb.stt_ms !== null) setMetric(sttLatencyVal, lb.stt_ms);
          setMetric(transLatencyVal, lb.translation_ms !== undefined ? lb.translation_ms : lb.first_audio_ms);
          if (lb.tts_ms !== undefined && lb.tts_ms !== null) setMetric(ttsLatencyVal, lb.tts_ms);
        } else {
          if (latencySub) latencySub.innerText = 'End-to-End Latency';
          setMetric(sttLatencyVal, lb.stt_ms);
          setMetric(dlpLatencyVal, lb.dlp_ms);
          setMetric(transLatencyVal, lb.translation_ms);
          setMetric(ttsLatencyVal, lb.tts_ms);
        }
        if (terminalTtsText) {
          const ttsStageMs = lb.tts_ms !== undefined && lb.tts_ms !== null ? `TTS: ${Math.round(lb.tts_ms)}ms • ` : '';
          terminalTtsText.innerText = data.streaming ? '🔊 Streaming translated audio' : `🔊 Synthesized ${Math.round(data.pcm.length / 1024)} KB audio`;
          terminalTtsMeta.innerText = `${ttsStageMs}Total: ${Math.round(data.total_latency_ms || 0)}ms`;
        }
        addTerminalLog(`Audio ready → playing (${data.streaming ? engineLabel(data.engine) + ' native audio' : data.voice || 'Chirp 3 HD'}, ${Math.round(data.total_latency_ms || 0)}ms)`, 'tts');
      }
      if (terminalMicState && !isRecording) {
        terminalMicState.innerText = '🎙️ Mic Ready';
        terminalMicState.style.color = '#2ecc71';
      }

      // Attach per-turn latency breakdown and PCM chunk to the turn bubble
      const audioBubble = (turnId && bubblesByTurn.has(turnId)) ? bubblesByTurn.get(turnId) : currentMessageBubble;
      if (audioBubble && audioBubble._turnData) {
        const td = audioBubble._turnData;
        if (!td.pcmChunks) td.pcmChunks = [];
        td.pcmChunks.push({ pcmBase64: data.pcm, sampleRate: data.sampleRate || 24000 });
        if (firstChunk) {
          const lb = data.latency_breakdown || {};
          if (data.total_latency_ms !== undefined && data.total_latency_ms !== null) td.totalLatencyMs = data.total_latency_ms;
          if (lb.stt_ms !== undefined && lb.stt_ms !== null) td.sttMs = lb.stt_ms;
          if (lb.dlp_ms !== undefined && lb.dlp_ms !== null) td.dlpMs = lb.dlp_ms;
          if (lb.translation_ms !== undefined && lb.translation_ms !== null) td.transMs = lb.translation_ms;
          else if (lb.first_audio_ms !== undefined && lb.first_audio_ms !== null && (td.transMs === undefined || td.transMs === null)) td.transMs = lb.first_audio_ms;
          if (lb.tts_ms !== undefined && lb.tts_ms !== null) td.ttsMs = lb.tts_ms;
          if (data.engine && !td.engine) td.engine = data.engine;
          renderBubbleLatencyRow(audioBubble);
        }
      }

      // Keep a copy for the audio download / saved conversation
      liveSynthesizedPcmChunks.push({ pcmBase64: data.pcm, sampleRate: data.sampleRate || 24000 });

      setLiveStatus('Playing Translation Speech...', true);
      playPcmChunk(data.pcm, data.sampleRate || 24000);
      break;
    }

    case 'transcript':
      if (data.text) updateBubbleTranslation(ensureTurnBubble(turnId, data.speakerRole), data.text);
      break;

    case 'no_speech': {
      if (!isRecording) setLiveStatus(isContinuous ? '🎙️ Ambient Mic Active (Listening...)' : 'Ready', isContinuous);
      if (terminalSttText) {
        terminalSttText.innerText = '(No audible speech detected - speak closer to mic)';
        terminalSttMeta.innerText = '--';
      }
      addTerminalLog('No audible speech detected in audio turn.', 'err');
      const bubble = turnId ? bubblesByTurn.get(turnId) : currentMessageBubble;
      if (bubble && !(bubble._turnData && bubble._turnData.finalized)) {
        const textEl = bubble.querySelector('.message-text');
        if (textEl) textEl.innerText = '(No clear speech detected - please speak closer to the microphone)';
        const transEl = bubble.querySelector('.message-translated');
        if (transEl) transEl.innerText = '';
        dropTurnData(bubble);
      }
      break;
    }

    case 'turn_complete': {
      const bubble = turnId ? bubblesByTurn.get(turnId) : null;
      if (bubble && bubble._turnData && !bubble._turnData.finalized && !bubble._turnData.dropped) {
        // Nothing came back for this turn (e.g. an engine error): don't leave it stuck on "Translating..."
        const transEl = bubble.querySelector('.message-translated');
        if (transEl && transEl.innerText.includes('Translating')) transEl.innerText = '';
      }
      if (isContinuous) {
        setLiveStatus('🎙️ Ambient Mic Active (Listening...)', true);
      } else if (!isRecording && !isSpeakingSelf) {
        setLiveStatus('Ready', false);
      }
      break;
    }

    case 'interrupted':
      stopPlayback();
      setLiveStatus('Interrupted (Listening...)', true);
      break;

    case 'error': {
      console.error('[WS] Server error:', data.message);
      addTerminalLog(`Pipeline Error: ${data.message}`, 'err');
      setLiveStatus(`Error: ${data.message}`, false);
      const bubble = turnId ? bubblesByTurn.get(turnId) : null;
      if (bubble) {
        const transEl = bubble.querySelector('.message-translated');
        if (transEl) transEl.innerHTML = `<span class="bubble-error">⚠️ ${escapeHtml(data.message)}</span>`;
      }
      if (isContinuous && turnId && turnId === activeStreamTurnId) {
        // The continuous stream itself failed: return to push-to-talk
        stopContinuousStream();
      }
      break;
    }

    default:
      console.log('[WS] Unhandled event:', data.type, data);
  }
}

// ----------------------------------------------------
// Audio capture: 16 kHz LINEAR16 streamed to the server in ~256 ms chunks
// ----------------------------------------------------
let micStarting = false;
let pttStopRequested = false;
let pttStopTimer = null;
const PTT_TAIL_MS = 250; // keep streaming briefly after release so the last word isn't clipped

function nextTurnId() {
  turnCounter += 1;
  return `c${Date.now().toString(36)}-${turnCounter}`;
}

function sendAudioChunk(pcm16) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'audio_chunk', pcm: arrayBufferToBase64(pcm16.buffer) }));
  }
}

async function startRecording() {
  if (isRecording || micStarting) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    alert('Not connected to the translation pipeline yet. Please wait for "Live & Ready".');
    return;
  }
  micStarting = true;

  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    console.log('[Mic] Microphone opened successfully. AudioContext state:', audioContext.state);

    const role = isContinuous ? 'ambient' : currentSpeakerRole;
    if (!isContinuous) {
      // Barge-in: a new push-to-talk turn cuts off any translation still playing
      stopPlayback();
    }

    const turnId = nextTurnId();
    activeStreamTurnId = turnId;
    socket.send(JSON.stringify({ type: 'audio_stream_start', turnId, speakerRole: role, ...getTurnConfig() }));

    const source = audioContext.createMediaStreamSource(micStream);
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

    scriptProcessor.onaudioprocess = (e) => {
      if (!isRecording) return;
      const inputData = e.inputBuffer.getChannelData(0);

      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sum / inputData.length);

      // In continuous mode, send silence while our own translation is playing so the
      // speaker output is not transcribed again (the server keeps its stream timing).
      const muted = isContinuous && isSpeakingSelf;
      const pcm16 = muted ? new Int16Array(inputData.length) : convertFloat32ToInt16(inputData);
      sendAudioChunk(pcm16);

      if (terminalRmsBar) {
        terminalRmsBar.style.width = `${muted ? 0 : Math.min(100, Math.round(rms * 2500))}%`;
      }
      if (terminalRmsText) {
        terminalRmsText.innerText = muted ? 'muted during playback' : `${rms.toFixed(4)} RMS (streaming)`;
      }
      if (!muted && rms > 0.002) {
        audioPulse.classList.add('active');
      } else if (!isSpeakingSelf) {
        audioPulse.classList.remove('active');
      }
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    isRecording = true;
    if (terminalMicState) {
      terminalMicState.innerText = isContinuous ? '🎙️ Ambient Live (streaming)' : '🔴 Streaming Turn...';
      terminalMicState.style.color = isContinuous ? '#2ecc71' : '#e74c3c';
    }

    if (!isContinuous) {
      const activeBtn = role === 'cast-member' ? castMemberMicBtn : guestMicBtn;
      activeBtn.classList.add('recording');
      lastSpeechStartTimestamp = Date.now();
      const who = role === 'cast-member'
        ? `Cast Member (${langMeta(getCastLang()).label})`
        : (smartDetectToggle.checked ? 'Guest (auto-detect)' : `Guest (${langMeta(getGuestLang()).label})`);
      setLiveStatus(`Listening to ${who}...`, true);
      addMessageBubble(role, '🎤 Speaking...', turnId);
    }
  } catch (err) {
    console.error('Microphone error:', err);
    teardownMic();
    if (activeStreamTurnId && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'audio_stream_end', turnId: activeStreamTurnId }));
    }
    activeStreamTurnId = null;
    alert('Please allow microphone access to test live speech translation.');
  } finally {
    micStarting = false;
  }
}

function teardownMic() {
  if (scriptProcessor) {
    scriptProcessor.onaudioprocess = null;
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function stopRecording() {
  if (!isRecording) return;
  castMemberMicBtn.classList.remove('recording');
  guestMicBtn.classList.remove('recording');

  const finish = () => {
    pttStopTimer = null;
    isRecording = false;
    teardownMic();
    if (socket && socket.readyState === WebSocket.OPEN && activeStreamTurnId) {
      socket.send(JSON.stringify({ type: 'audio_stream_end', turnId: activeStreamTurnId }));
    }
    activeStreamTurnId = null;
    if (terminalMicState) {
      terminalMicState.innerText = '⚡ Processing Turn...';
      terminalMicState.style.color = '#f1c40f';
    }
    if (!isContinuous) setLiveStatus('Transcribing & Translating...', true);
  };

  if (isContinuous || pttStopTimer) {
    if (pttStopTimer) clearTimeout(pttStopTimer);
    finish();
  } else {
    pttStopTimer = setTimeout(finish, PTT_TAIL_MS);
  }
}

// Convert Float32 to Int16 PCM
function convertFloat32ToInt16(buffer) {
  let l = buffer.length;
  const buf = new Int16Array(l);
  while (l--) {
    const s = Math.max(-1, Math.min(1, buffer[l]));
    buf[l] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return buf;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Gapless playback scheduler: chunks (whole TTS clips or streamed Gemini audio) are queued
// back-to-back on one AudioContext so streamed audio plays without gaps or overlap.
let playbackQueueEnd = 0;
const activePlaybackSources = new Set();
let isSpeakingSelf = false;
let speakingSelfTimer = null;

function decodePcm16Base64(base64Data) {
  const binaryString = window.atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const int16Array = new Int16Array(bytes.buffer, 0, Math.floor(len / 2));
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }
  return float32Array;
}

function playPcmChunk(base64Data, sampleRate = 24000) {
  try {
    if (!playbackContext) {
      playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    }
    if (playbackContext.state === 'suspended') {
      playbackContext.resume();
    }

    const samples = decodePcm16Base64(base64Data);
    if (samples.length === 0) return;
    const audioBuffer = playbackContext.createBuffer(1, samples.length, sampleRate);
    audioBuffer.getChannelData(0).set(samples);

    const sourceNode = playbackContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(playbackContext.destination);

    const startAt = Math.max(playbackContext.currentTime + 0.02, playbackQueueEnd);
    playbackQueueEnd = startAt + audioBuffer.duration;
    activePlaybackSources.add(sourceNode);
    isSpeakingSelf = true;
    if (speakingSelfTimer) {
      clearTimeout(speakingSelfTimer);
      speakingSelfTimer = null;
    }

    sourceNode.onended = () => {
      activePlaybackSources.delete(sourceNode);
      if (activePlaybackSources.size === 0) {
        // Short grace period so the room echo of the last word is not picked up
        speakingSelfTimer = setTimeout(() => {
          isSpeakingSelf = false;
          if (isContinuous) {
            setLiveStatus('🎙️ Ambient Mic Active (Listening...)', true);
          } else if (!isRecording) {
            setLiveStatus('Ready', false);
          }
        }, 350);
      }
    };
    sourceNode.start(startAt);
  } catch (err) {
    console.error('[Audio] Playback error:', err);
  }
}

function stopPlayback() {
  activePlaybackSources.forEach(src => {
    try {
      src.onended = null;
      src.stop();
    } catch (e) { /* already stopped */ }
  });
  activePlaybackSources.clear();
  playbackQueueEnd = 0;
  if (speakingSelfTimer) {
    clearTimeout(speakingSelfTimer);
    speakingSelfTimer = null;
  }
  isSpeakingSelf = false;
}

// ----------------------------------------------------
// Dialogue UI Feed (one bubble per turn / streamed segment)
// ----------------------------------------------------
function addSystemNote(text) {
  const welcome = chatFeed.querySelector('.chat-welcome');
  if (welcome) welcome.remove();
  const note = document.createElement('div');
  note.className = 'chat-system-note';
  note.innerText = text;
  chatFeed.appendChild(note);
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

function formatSec(sec) {
  if (sec === undefined || sec === null || isNaN(sec) || sec < 0) return '0:00';
  const totalSec = Math.floor(sec);
  const mins = Math.floor(totalSec / 60);
  const rem = totalSec % 60;
  return `${mins}:${rem < 10 ? '0' : ''}${rem}`;
}

function formatTurnLatencyBadges(turn) {
  if (!turn) return '';
  const pills = [];
  const total = turn.totalLatencyMs !== undefined ? turn.totalLatencyMs : turn.total_latency_ms;
  const stt = turn.sttMs !== undefined ? turn.sttMs : turn.stt_ms;
  const dlp = turn.dlpMs !== undefined ? turn.dlpMs : turn.dlp_ms;
  const mt = turn.transMs !== undefined ? turn.transMs : turn.translation_ms;
  const tts = turn.ttsMs !== undefined ? turn.ttsMs : turn.tts_ms;
  const engine = turn.engine;

  if (total !== undefined && total !== null && total > 0) {
    pills.push(`<span class="turn-latency-pill total-pill" title="Total End-to-End Turn Latency">⚡ Total: ${Math.round(total)}ms</span>`);
  }
  if (stt !== undefined && stt !== null && stt > 0) {
    pills.push(`<span class="turn-latency-pill stt-pill" title="Speech-to-Text Latency">🎙️ STT: ${Math.round(stt)}ms</span>`);
  } else if (stt === null && (engine === 'gemini-3.8-live' || engine === 'gemini-3.5-live-translate')) {
    pills.push(`<span class="turn-latency-pill stt-pill" title="Native Multimodal Speech Input">🎙️ STT: Native</span>`);
  }
  if (dlp !== undefined && dlp !== null && dlp > 0) {
    pills.push(`<span class="turn-latency-pill dlp-pill" title="Cloud DLP PII Scrubbing Latency">🛡️ DLP: ${Math.round(dlp)}ms</span>`);
  }
  if (mt !== undefined && mt !== null && mt > 0) {
    pills.push(`<span class="turn-latency-pill mt-pill" title="Translation Latency">🌐 Translate: ${Math.round(mt)}ms</span>`);
  }
  if (tts !== undefined && tts !== null && tts > 0) {
    pills.push(`<span class="turn-latency-pill tts-pill" title="Text-to-Speech Synthesis Latency">🔊 TTS: ${Math.round(tts)}ms</span>`);
  }
  if (engine) {
    pills.push(`<span class="turn-latency-pill">${escapeHtml(engineLabel(engine))}</span>`);
  }
  return pills.join('');
}

function renderBubbleLatencyRow(bubble) {
  if (!bubble || !bubble._turnData) return;
  let row = bubble.querySelector('.turn-latency-row');
  if (!row) {
    row = document.createElement('div');
    row.className = 'turn-latency-row';
    bubble.appendChild(row);
  }
  const html = formatTurnLatencyBadges(bubble._turnData);
  row.innerHTML = html;
  row.style.display = html ? 'flex' : 'none';
}

function addMessageBubble(role, originalText, turnId = null, langKey = null) {
  const welcome = chatFeed.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${role}`;

  const roleLabel = roleLabelFor(role, langKey);
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  bubble.innerHTML = `
    <div class="message-meta">
      <span class="bubble-role"></span>
      <span class="bubble-time">${timeStr}</span>
    </div>
    <div class="message-text"></div>
    <div class="message-translated">🔄 Translating...</div>
    <div class="turn-latency-row" style="display:none;"></div>
  `;
  bubble.querySelector('.bubble-role').innerText = roleLabel;
  bubble.querySelector('.message-text').innerText = originalText;

  chatFeed.appendChild(bubble);
  chatFeed.scrollTop = chatFeed.scrollHeight;
  currentMessageBubble = bubble;
  if (turnId) {
    bubble.dataset.turnId = turnId;
    bubblesByTurn.set(turnId, bubble);
  }

  // Add turn entry into conversation tracking
  bubble._turnData = {
    turnId,
    role,
    roleLabel,
    originalText,
    translatedText: '',
    srcLang: langKey || (role === 'cast-member' ? getCastLang() : null),
    tgtLang: null,
    engine: engineSelect ? engineSelect.value : null,
    time: timeStr,
    timestamp: Date.now(),
    pcmChunks: []
  };
  liveConversationTurns.push(bubble._turnData);
  return bubble;
}

function ensureTurnBubble(turnId, role) {
  if (turnId && bubblesByTurn.has(turnId)) return bubblesByTurn.get(turnId);
  if (!turnId && currentMessageBubble) return currentMessageBubble;
  return addMessageBubble(role || currentSpeakerRole, '🎤 Listening...', turnId);
}

function dropTurnData(bubble) {
  if (!bubble || !bubble._turnData) return;
  bubble._turnData.dropped = true;
  liveConversationTurns = liveConversationTurns.filter(t => t !== bubble._turnData);
}

function setBubbleInterim(bubble, transcript) {
  if (!bubble || !transcript) return;
  if (bubble._turnData && bubble._turnData.finalized) return;
  const textEl = bubble.querySelector('.message-text');
  if (textEl) {
    textEl.innerHTML = `<span class="interim-text">"${escapeHtml(transcript)}..."</span> <span class="badge-mini">⚡ live</span>`;
  }
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

function updateBubbleOriginal(bubble, opts) {
  if (!bubble) return;
  const { transcript, sttMs, sttModel, role, srcLang, tgtLang, detectedLang, dlpApplied, dlpScope } = opts;
  const textEl = bubble.querySelector('.message-text');
  const metaEl = bubble.querySelector('.bubble-role');

  if (role) {
    const label = roleLabelFor(role, srcLang);
    if (metaEl) metaEl.innerText = label;
    bubble.className = `message-bubble ${role}`;
    if (bubble._turnData) bubble._turnData.roleLabel = label;
  }

  if (textEl) {
    const latencyBadge = (sttMs !== null && sttMs !== undefined && sttMs > 0)
      ? ` <span class="badge-mini">⚡ STT: ${Math.round(sttMs)}ms</span>` : '';
    const dlpBadge = dlpApplied
      ? ` <span class="badge-mini badge-dlp">🛡️ DLP Redacted${dlpScope === 'transcript_only' ? ' (transcript)' : ''}</span>` : '';
    textEl.innerHTML = `"${escapeHtml(transcript)}"${latencyBadge}${dlpBadge}`;
  }

  if (bubble._turnData) {
    Object.assign(bubble._turnData, {
      originalText: transcript,
      role: role || bubble._turnData.role,
      srcLang: srcLang || bubble._turnData.srcLang,
      tgtLang: tgtLang || bubble._turnData.tgtLang,
      detectedLang,
      sttMs,
      sttModel,
      dlpApplied,
      dlpScope,
      finalized: true
    });
    renderBubbleLatencyRow(bubble);
  }
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

function updateBubbleTranslation(bubble, translatedText, opts = {}) {
  if (!bubble || translatedText === undefined || translatedText === null) return;
  const { glossaryApplied, glossaryMode, transMs, ttsMs, totalLatencyMs, tgtLang, interim, engine, model } = opts;
  if (interim && bubble._turnData && bubble._turnData.translationFinal) return;
  const transEl = bubble.querySelector('.message-translated');
  if (transEl) {
    const flag = tgtLang ? `${langMeta(tgtLang).flag} ` : '✨ ';
    let badges = '';
    if (interim) {
      badges = ' <span class="badge-mini">⚡ live</span>';
    } else {
      if (glossaryMode === 'prompt') badges += ' <span class="badge-mini badge-glossary">🔒 Glossary (prompt)</span>';
      else if (glossaryApplied) badges += ' <span class="badge-mini badge-glossary">🔒 Brand Glossary Applied</span>';
      if (engine) badges += ` <span class="badge-mini">${escapeHtml(engineLabel(engine))}</span>`;
      if (transMs) badges += ` <span class="badge-mini">⏱️ ${Math.round(transMs)}ms${engine ? ' to audio' : ''}</span>`;
    }
    transEl.innerHTML = `${flag}${escapeHtml(translatedText)}${badges}`;
  }

  if (bubble._turnData && !interim) {
    Object.assign(bubble._turnData, {
      translatedText,
      tgtLang: tgtLang || bubble._turnData.tgtLang,
      glossaryApplied,
      transMs: transMs !== undefined ? transMs : bubble._turnData.transMs,
      ttsMs: ttsMs !== undefined && ttsMs !== null ? ttsMs : bubble._turnData.ttsMs,
      totalLatencyMs: totalLatencyMs !== undefined && totalLatencyMs !== null ? totalLatencyMs : bubble._turnData.totalLatencyMs,
      engine: engine || bubble._turnData.engine || null,
      translationModel: model || bubble._turnData.translationModel || null,
      translationFinal: true
    });
    renderBubbleLatencyRow(bubble);
  } else if (bubble._turnData && interim) {
    bubble._turnData.translatedText = translatedText;
  }
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

// Enterprise Protected Brand Glossary & Language Management
const GLOSSARY_LANG_MAP = {
  es: { name: 'Spanish', flag: '🇪🇸' },
  pt: { name: 'Portuguese', flag: '🇧🇷' },
  fr: { name: 'French', flag: '🇫🇷' },
  ja: { name: 'Japanese', flag: '🇯🇵' },
  zh: { name: 'Mandarin Chinese', flag: '🇨🇳' },
  de: { name: 'German', flag: '🇩🇪' },
  it: { name: 'Italian', flag: '🇮🇹' },
  ko: { name: 'Korean', flag: '🇰🇷' },
  nl: { name: 'Dutch', flag: '🇳🇱' },
  ar: { name: 'Arabic', flag: '🇦🇪' },
  ru: { name: 'Russian', flag: '🇷🇺' }
};

let currentGlossaryLang = 'all';
let currentEditingTerm = null;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function setupGlossary() {
  const fallbackTerms = [
    { term_id: "lightning_lane", en: "Lightning Lane", category: "Service", keep_original: true, translations: { es: "Lightning Lane", pt: "Lightning Lane", fr: "Lightning Lane", ja: "ライトニング・レーン", zh: "闪电通道 (Lightning Lane)" }, notes: "Express priority queue service. Do not translate literally." },
    { term_id: "smart_band_plus", en: "Smart Band+", category: "Merchandise/Service", keep_original: true, translations: { es: "Smart Band+", pt: "Smart Band+", fr: "Smart Band+", ja: "スマートバンド+", zh: "智能手环+" }, notes: "Wearable RFID/Bluetooth park device." },
    { term_id: "guest_ambassador", en: "Guest Ambassador", category: "Personnel", keep_original: false, translations: { es: "Embajador de Servicio", pt: "Embaixador de Atendimento", fr: "Ambassadeur de Service", ja: "サービスアンバサダー", zh: "服务大使" }, notes: "Theme park hospitality staff member." },
    { term_id: "space_mountain", en: "Space Mountain", category: "Attraction", keep_original: true, translations: { es: "Space Mountain", pt: "Space Mountain", fr: "Space Mountain", ja: "スペース・マウンテン", zh: "飞越太空山" }, notes: "Futuristic indoor roller coaster." },
    { term_id: "rise_of_the_resistance", en: "Star Wars: Rise of the Resistance", category: "Attraction", keep_original: true, translations: { es: "Star Wars: Rise of the Resistance", pt: "Star Wars: Rise of the Resistance", fr: "Star Wars: Rise of the Resistance", ja: "スター・ウォーズ：ライズ・オブ・ザ・レジスタンス", zh: "星球大战：抵抗组织崛起" }, notes: "Flagship trackless dark ride." },
    { term_id: "haunted_mansion", en: "Haunted Mansion", category: "Attraction", keep_original: true, translations: { es: "Haunted Mansion (Mansión Embrujada)", pt: "Haunted Mansion (Mansão Assombrada)", fr: "Haunted Mansion / Phantom Manor", ja: "ホーンテッドマンション", zh: "幽灵公馆" }, notes: "Classic haunted dark ride attraction." },
    { term_id: "rope_drop", en: "Rope Drop", category: "Park Concept", keep_original: false, translations: { es: "Apertura del parque / Entrada a primera hora", pt: "Abertura dos portões", fr: "Ouverture des portes du parc", ja: "開園（ロープドロップ）", zh: "开园时刻 (Rope Drop)" }, notes: "Arriving at park opening time." },
    { term_id: "photopass", en: "PhotoPass", category: "Service", keep_original: true, translations: { es: "PhotoPass", pt: "PhotoPass", fr: "PhotoPass", ja: "フォトパス", zh: "乐拍通 (PhotoPass)" }, notes: "Professional in-park photography service." },
    { term_id: "rider_switch", en: "Rider Switch", category: "Service", keep_original: false, translations: { es: "Cambio de Acompañante (Rider Switch)", pt: "Troca de Passageiro", fr: "Service d'échange d'enfants", ja: "ライダー・スイッチ", zh: "乘客轮换 (Rider Switch)" }, notes: "Parent swap service for attractions." },
    { term_id: "single_rider", en: "Single Rider Line", category: "Queue Concept", keep_original: false, translations: { es: "Fila para Pasajero Solitario", pt: "Fila de Single Rider", fr: "File Single Rider (Passager seul)", ja: "シングルライダー", zh: "单人通道 (Single Rider)" }, notes: "Dedicated queue for solo riders." },
    { term_id: "park_hopper", en: "Park Hopper", category: "Ticket", keep_original: true, translations: { es: "Boleto Park Hopper", pt: "Ingresso Park Hopper", fr: "Billet Park Hopper", ja: "パークホッパー", zh: "跨园门票 (Park Hopper)" }, notes: "Multi-park admission ticket." },
    { term_id: "virtual_queue", en: "Virtual Queue", category: "Service", keep_original: false, translations: { es: "Fila Virtual", pt: "Fila Virtual", fr: "File d'attente virtuelle", ja: "スタンバイパス / バーチャルキュー", zh: "虚拟排队 (Virtual Queue)" }, notes: "In-app digital queue allocation system." }
  ];

  // UI Elements for Glossary Management
  const addTermModal = document.getElementById('addTermModal');
  const openAddTermModalBtn = document.getElementById('openAddTermModalBtn');
  const closeAddTermModalBtn = document.getElementById('closeAddTermModalBtn');
  const cancelAddTermBtn = document.getElementById('cancelAddTermBtn');
  const addTermForm = document.getElementById('addTermForm');
  const glossarySearch = document.getElementById('glossarySearch');
  const glossaryLangFilter = document.getElementById('glossaryLangFilter');

  // Edit Term Modal Elements
  const editTermModal = document.getElementById('editTermModal');
  const closeEditTermModalBtn = document.getElementById('closeEditTermModalBtn');
  const cancelEditTermBtn = document.getElementById('cancelEditTermBtn');
  const editTermForm = document.getElementById('editTermForm');
  const addPairLangSelect = document.getElementById('addPairLangSelect');
  const addPairCustomCode = document.getElementById('addPairCustomCode');
  const customCodeGroup = document.getElementById('customCodeGroup');
  const addPairTextInput = document.getElementById('addPairTextInput');
  const addPairBtn = document.getElementById('addPairBtn');
  const deleteTermFromModalBtn = document.getElementById('deleteTermFromModalBtn');

  if (openAddTermModalBtn && addTermModal) {
    openAddTermModalBtn.addEventListener('click', () => {
      addTermModal.style.display = 'flex';
      document.getElementById('newTermEn')?.focus();
    });
  }

  const closeAddModal = () => {
    if (addTermModal) addTermModal.style.display = 'none';
    if (addTermForm) addTermForm.reset();
  };

  const closeEditModal = () => {
    if (editTermModal) editTermModal.style.display = 'none';
    if (editTermForm) editTermForm.reset();
    currentEditingTerm = null;
  };

  if (closeAddTermModalBtn) closeAddTermModalBtn.addEventListener('click', closeAddModal);
  if (cancelAddTermBtn) cancelAddTermBtn.addEventListener('click', closeAddModal);

  if (closeEditTermModalBtn) closeEditTermModalBtn.addEventListener('click', closeEditModal);
  if (cancelEditTermBtn) cancelEditTermBtn.addEventListener('click', closeEditModal);

  // Close modals when clicking overlay background
  window.addEventListener('click', (e) => {
    if (e.target === addTermModal) closeAddModal();
    if (e.target === editTermModal) closeEditModal();
  });

  // Toggle custom language code input
  if (addPairLangSelect) {
    addPairLangSelect.addEventListener('change', () => {
      if (addPairLangSelect.value === 'custom') {
        if (customCodeGroup) customCodeGroup.style.display = 'flex';
        if (addPairCustomCode) addPairCustomCode.focus();
      } else {
        if (customCodeGroup) customCodeGroup.style.display = 'none';
      }
    });
  }

  // Add new language pair inside edit modal
  if (addPairBtn) {
    addPairBtn.addEventListener('click', () => {
      let langCode = addPairLangSelect ? addPairLangSelect.value : 'es';
      if (langCode === 'custom') {
        langCode = (addPairCustomCode?.value || '').trim().toLowerCase();
        if (!langCode || langCode.length < 2) {
          alert('Please enter a valid 2-letter language code (e.g. "de", "it", "nl").');
          addPairCustomCode?.focus();
          return;
        }
      }

      const transText = (addPairTextInput?.value || '').trim();
      if (!transText) {
        alert('Please enter a translation for this language pair.');
        addPairTextInput?.focus();
        return;
      }

      const container = document.getElementById('editTranslationsContainer');
      if (!container) return;

      // Check if this language already exists in container
      const existingRow = container.querySelector(`.pair-editor-row[data-lang="${langCode}"]`);
      if (existingRow) {
        const inp = existingRow.querySelector('.pair-trans-input');
        if (inp) {
          inp.value = transText;
          inp.focus();
          inp.style.outline = '2px solid #38bdf8';
          setTimeout(() => { inp.style.outline = 'none'; }, 1000);
        }
      } else {
        const emptyNotice = container.querySelector('.empty-translations-hint');
        if (emptyNotice) emptyNotice.remove();

        const meta = GLOSSARY_LANG_MAP[langCode] || { name: langCode.toUpperCase(), flag: '🌐' };
        const row = document.createElement('div');
        row.className = 'pair-editor-row';
        row.dataset.lang = langCode;
        row.innerHTML = `
          <div class="pair-lang-badge">
            <span>${meta.flag}</span>
            <span>${meta.name} (${langCode.toUpperCase()})</span>
          </div>
          <input type="text" class="pair-trans-input" value="${escapeHtml(transText)}" placeholder="Translation in ${meta.name}" required>
          <button type="button" class="btn-remove-pair" title="Remove this translation">❌ Remove</button>
        `;

        row.querySelector('.btn-remove-pair').addEventListener('click', () => {
          row.remove();
          if (container.querySelectorAll('.pair-editor-row').length === 0) {
            container.innerHTML = `<div class="empty-translations-hint" style="color: #64748b; font-size: 0.8rem; padding: 10px;">No language translations configured yet. Add one below.</div>`;
          }
        });

        container.appendChild(row);
      }

      // Reset add pair input
      if (addPairTextInput) addPairTextInput.value = '';
    });
  }

  // Handle Edit Term form submission
  if (editTermForm) {
    editTermForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const termId = document.getElementById('editTermId')?.value;
      const en = document.getElementById('editTermEn')?.value.trim();
      const category = document.getElementById('editTermCategory')?.value;
      const keep_original = document.getElementById('editTermKeepOriginal')?.checked;
      const notes = document.getElementById('editTermNotes')?.value.trim() || '';

      if (!termId || !en) return;

      const container = document.getElementById('editTranslationsContainer');
      const rows = container ? container.querySelectorAll('.pair-editor-row') : [];
      const translations = {};
      rows.forEach(r => {
        const l = r.dataset.lang;
        const v = r.querySelector('.pair-trans-input')?.value.trim();
        if (l && v) {
          translations[l] = v;
        }
      });

      if (Object.keys(translations).length === 0) {
        alert('Please keep or add at least one language translation pair.');
        return;
      }

      const payload = {
        en,
        category,
        keep_original,
        translations,
        notes
      };

      try {
        const res = await fetch(`/api/glossary/terms/${encodeURIComponent(termId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          const resData = await res.json();
          const updatedTerm = resData.term || { ...payload, term_id: termId };

          // Update local glossaryData
          const idx = glossaryData.findIndex(t => t.term_id === termId);
          if (idx !== -1) {
            glossaryData[idx] = updatedTerm;
          } else {
            glossaryData.push(updatedTerm);
          }

          closeEditModal();
          applyGlossaryFilters();
          addTerminalLog(`Updated glossary term "${en}" across ${Object.keys(translations).length} languages.`, 'system');
        } else {
          // Fallback to POST if needed
          const postRes = await fetch('/api/glossary/terms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, es: translations.es || en })
          });
          if (postRes.ok) {
            const idx = glossaryData.findIndex(t => t.term_id === termId);
            const updated = { ...payload, term_id: termId };
            if (idx !== -1) glossaryData[idx] = updated;
            else glossaryData.push(updated);
            closeEditModal();
            applyGlossaryFilters();
            addTerminalLog(`Updated glossary term "${en}".`, 'system');
          } else {
            alert('Could not update term on server.');
          }
        }
      } catch (err) {
        console.error('Error updating term:', err);
        alert('Network error updating term.');
      }
    });
  }

  // Delete term from inside edit modal
  if (deleteTermFromModalBtn) {
    deleteTermFromModalBtn.addEventListener('click', () => {
      const termId = document.getElementById('editTermId')?.value;
      const termEn = document.getElementById('editTermEn')?.value;
      if (termId && termEn) {
        closeEditModal();
        deleteGlossaryTerm(termId, termEn);
      }
    });
  }

  if (addTermForm) {
    addTermForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const en = document.getElementById('newTermEn').value.trim();
      const es = document.getElementById('newTermEs').value.trim();
      const pt = document.getElementById('newTermPt')?.value.trim() || '';
      const fr = document.getElementById('newTermFr')?.value.trim() || '';
      const ja = document.getElementById('newTermJa')?.value.trim() || '';
      const zh = document.getElementById('newTermZh')?.value.trim() || '';
      const category = document.getElementById('newTermCategory').value;
      const keep_original = document.getElementById('newTermKeepOriginal').checked;
      const notes = document.getElementById('newTermNotes')?.value.trim() || '';

      if (!en || !es) return;

      const translations = { es };
      if (pt) translations.pt = pt;
      if (fr) translations.fr = fr;
      if (ja) translations.ja = ja;
      if (zh) translations.zh = zh;

      if (keep_original) {
        if (!translations.pt) translations.pt = en;
        if (!translations.fr) translations.fr = en;
      }

      try {
        const res = await fetch('/api/glossary/terms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ en, es, pt, fr, ja, zh, translations, category, keep_original, notes })
        });

        if (res.ok) {
          const result = await res.json();
          const termId = result.term.term_id;
          glossaryData = glossaryData.filter(t => t.term_id !== termId && t.en.toLowerCase() !== en.toLowerCase());
          glossaryData.push(result.term);
          applyGlossaryFilters();
          closeModal();
          const langCount = Object.keys(result.term.translations || {}).length;
          addTerminalLog(`Added protected brand term: "${en}" across ${langCount} languages`, 'system');
        } else {
          alert('Failed to save term. Please try again.');
        }
      } catch (err) {
        console.error('Error saving term:', err);
        alert('Could not save term to server.');
      }
    });
  }

  try {
    const res = await fetch('/api/glossary');
    if (res.ok) {
      const data = await res.json();
      glossaryData = (data.terms && data.terms.length > 0) ? data.terms : fallbackTerms;
    } else {
      glossaryData = fallbackTerms;
    }
  } catch (e) {
    console.warn('Could not fetch glossary from API, using default list');
    glossaryData = fallbackTerms;
  }

  function applyGlossaryFilters() {
    const query = (glossarySearch?.value || '').trim().toLowerCase();
    const selectedLang = glossaryLangFilter ? glossaryLangFilter.value : 'all';
    currentGlossaryLang = selectedLang;

    let filtered = glossaryData.filter(t => {
      const matchesQuery = !query || 
        t.en.toLowerCase().includes(query) ||
        (t.category && t.category.toLowerCase().includes(query)) ||
        (t.notes && t.notes.toLowerCase().includes(query)) ||
        (t.translations && Object.values(t.translations).some(v => String(v).toLowerCase().includes(query)));

      if (selectedLang !== 'all') {
        const hasLang = Boolean(t.translations && t.translations[selectedLang]);
        return matchesQuery && hasLang;
      }
      return matchesQuery;
    });

    renderGlossary(filtered, selectedLang);
  }

  if (glossarySearch) {
    glossarySearch.addEventListener('input', applyGlossaryFilters);
  }

  if (glossaryLangFilter) {
    glossaryLangFilter.addEventListener('change', applyGlossaryFilters);
  }

  applyGlossaryFilters();
}

function updateGlossaryCount(count, totalUniqueLangs = 5) {
  const badge = document.getElementById('glossaryCountBadge');
  if (badge) {
    badge.innerText = `${count} Terms Active`;
  }
  const langsBadge = document.getElementById('glossaryLangsBadge');
  if (langsBadge) {
    langsBadge.innerText = `${totalUniqueLangs} Languages (ES, PT, FR, JA, ZH)`;
  }
}

async function deleteGlossaryTerm(termId, termEn) {
  if (!confirm(`Are you sure you want to remove "${termEn}" from the protected glossary?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/glossary/terms/${encodeURIComponent(termId)}`, {
      method: 'DELETE'
    });

    if (res.ok) {
      glossaryData = glossaryData.filter(t => t.term_id !== termId);
      const query = (document.getElementById('glossarySearch')?.value || '').trim().toLowerCase();
      const selectedLang = document.getElementById('glossaryLangFilter')?.value || 'all';
      let filtered = glossaryData.filter(t => {
        const matchesQuery = !query || 
          t.en.toLowerCase().includes(query) ||
          (t.translations && Object.values(t.translations).some(v => String(v).toLowerCase().includes(query)));
        if (selectedLang !== 'all') {
          return matchesQuery && Boolean(t.translations && t.translations[selectedLang]);
        }
        return matchesQuery;
      });
      renderGlossary(filtered, selectedLang);
      addTerminalLog(`Removed brand term: "${termEn}"`, 'system');
    } else {
      alert('Could not delete term.');
    }
  } catch (err) {
    console.error('Error deleting term:', err);
    alert('Error connecting to glossary server.');
  }
}

function openEditTermModal(term) {
  currentEditingTerm = term;
  const editTermModal = document.getElementById('editTermModal');
  if (!editTermModal) return;

  const editTermId = document.getElementById('editTermId');
  const editTermEn = document.getElementById('editTermEn');
  const editTermCategory = document.getElementById('editTermCategory');
  const editTermKeepOriginal = document.getElementById('editTermKeepOriginal');
  const editTermNotes = document.getElementById('editTermNotes');
  const subtitle = document.getElementById('editTermModalSubtitle');

  if (editTermId) editTermId.value = term.term_id || '';
  if (editTermEn) editTermEn.value = term.en || '';
  if (editTermCategory) editTermCategory.value = term.category || 'Custom';
  if (editTermKeepOriginal) editTermKeepOriginal.checked = Boolean(term.keep_original);
  if (editTermNotes) editTermNotes.value = term.notes || '';

  if (subtitle) {
    subtitle.innerText = `Viewing "${term.en}" • ${term.category || 'Brand Term'} • Click into any translation to edit, remove, or add new pairs`;
  }

  // Populate translations container
  const container = document.getElementById('editTranslationsContainer');
  if (container) {
    container.innerHTML = '';
    const translations = term.translations || {};
    const entries = Object.entries(translations);

    if (entries.length === 0) {
      container.innerHTML = `<div class="empty-translations-hint" style="color: #64748b; font-size: 0.8rem; padding: 10px;">No language translations configured yet. Add one below.</div>`;
    } else {
      entries.forEach(([lang, val]) => {
        const meta = GLOSSARY_LANG_MAP[lang.toLowerCase()] || { name: lang.toUpperCase(), flag: '🌐' };
        const row = document.createElement('div');
        row.className = 'pair-editor-row';
        row.dataset.lang = lang.toLowerCase();
        row.innerHTML = `
          <div class="pair-lang-badge">
            <span>${meta.flag}</span>
            <span>${meta.name} (${lang.toUpperCase()})</span>
          </div>
          <input type="text" class="pair-trans-input" value="${escapeHtml(val)}" placeholder="Translation in ${meta.name}" required>
          <button type="button" class="btn-remove-pair" title="Remove this translation">❌ Remove</button>
        `;

        row.querySelector('.btn-remove-pair').addEventListener('click', () => {
          row.remove();
          if (container.querySelectorAll('.pair-editor-row').length === 0) {
            container.innerHTML = `<div class="empty-translations-hint" style="color: #64748b; font-size: 0.8rem; padding: 10px;">No language translations configured yet. Add one below.</div>`;
          }
        });

        container.appendChild(row);
      });
    }
  }

  // Reset add pair fields
  const addPairTextInput = document.getElementById('addPairTextInput');
  if (addPairTextInput) addPairTextInput.value = '';

  editTermModal.style.display = 'flex';
}

function renderGlossary(terms, selectedLang = 'all') {
  glossaryGrid.innerHTML = '';
  
  // Calculate unique languages present across terms
  const allLangs = new Set();
  terms.forEach(t => {
    if (t.translations) {
      Object.keys(t.translations).forEach(k => allLangs.add(k));
    }
  });
  updateGlossaryCount(terms.length, Math.max(allLangs.size, 1));

  if (terms.length === 0) {
    glossaryGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: #94a3b8; padding: 40px 0;">
        <p style="font-size: 1.1rem; margin-bottom: 6px;">No matching terms found.</p>
        <span style="font-size: 0.85rem; color: #64748b;">Try adjusting your search query or language filter.</span>
      </div>
    `;
    return;
  }

  terms.forEach(t => {
    const card = document.createElement('div');
    card.className = 'glossary-card';
    card.title = `Click to view or edit all language pairs for "${t.en}"`;
    
    const availableLangs = t.translations ? Object.keys(t.translations) : [];

    // Language pills bar (shows at a glance which languages this term has)
    const pillsHtml = ['es', 'pt', 'fr', 'ja', 'zh'].map(code => {
      const meta = GLOSSARY_LANG_MAP[code] || { name: code.toUpperCase(), flag: '🌐' };
      const has = availableLangs.includes(code);
      return `<span class="lang-pill ${has ? 'present' : 'missing'}" title="${meta.name}: ${has ? t.translations[code] : 'Not specified'}">${meta.flag} ${code.toUpperCase()}</span>`;
    }).join('');

    let transDisplayHtml = '';
    if (selectedLang === 'all') {
      const rows = Object.entries(t.translations || {}).map(([lang, val]) => {
        const meta = GLOSSARY_LANG_MAP[lang] || { name: lang.toUpperCase(), flag: '🌐' };
        return `
          <div class="translation-row">
            <span class="trans-lang-tag">${meta.flag} ${lang.toUpperCase()}</span>
            <span class="trans-text">${val}</span>
          </div>
        `;
      }).join('');
      transDisplayHtml = `<div class="term-translations-list">${rows || '<span style="color:#64748b">No translations</span>'}</div>`;
    } else {
      const meta = GLOSSARY_LANG_MAP[selectedLang] || { name: selectedLang.toUpperCase(), flag: '🌐' };
      const val = (t.translations && t.translations[selectedLang]) || t.en;
      const otherLangs = availableLangs.filter(l => l !== selectedLang).map(l => l.toUpperCase());
      transDisplayHtml = `
        <div class="term-target-focus">
          <span class="trans-lang-tag active">${meta.flag} ${selectedLang.toUpperCase()}</span>
          <span class="term-target-value">${val}</span>
        </div>
        <div class="other-translations-hint">Also in: ${otherLangs.length > 0 ? otherLangs.join(', ') : 'None'}</div>
      `;
    }

    card.innerHTML = `
      <div class="glossary-card-header">
        <span class="term-en">${t.en}</span>
        <span class="term-category">${t.category || 'Brand Term'}</span>
      </div>
      <div class="term-lang-badges">${pillsHtml}</div>
      ${transDisplayHtml}
      <div class="term-notes">${t.keep_original ? '🔒 Preserve Brand Name' : '🔄 Contextual Translation'} • ${t.notes || ''}</div>
      <div class="glossary-card-footer">
        <div class="card-click-hint"><span>✏️ Click to view/edit language pairs</span></div>
        <button class="btn-delete-term" title="Delete term" data-term-id="${t.term_id}" data-term-en="${t.en}">🗑️ Remove</button>
      </div>
    `;

    // Click on card opens edit modal with all language pairs
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete-term')) return;
      openEditTermModal(t);
    });

    const delBtn = card.querySelector('.btn-delete-term');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteGlossaryTerm(t.term_id, t.en);
      });
    }

    glossaryGrid.appendChild(card);
  });
}

// ----------------------------------------------------
// Recorded Audio Upload & Translation Implementation
// ----------------------------------------------------
function setupRecordedUpload() {
  const uploadDropzone = document.getElementById('uploadDropzone');
  const audioFileInput = document.getElementById('audioFileInput');
  const browseAudioBtn = document.getElementById('browseAudioBtn');
  const selectedFileInfo = document.getElementById('selectedFileInfo');
  const selectedFileName = document.getElementById('selectedFileName');
  const selectedFileSize = document.getElementById('selectedFileSize');
  const removeSelectedFileBtn = document.getElementById('removeSelectedFileBtn');
  const processUploadBtn = document.getElementById('processUploadBtn');
  const uploadStatusBox = document.getElementById('uploadStatusBox');
  const uploadStatusText = document.getElementById('uploadStatusText');
  const uploadResultsCard = document.getElementById('uploadResultsCard');
  const downloadUploadTranscriptBtn = document.getElementById('downloadUploadTranscriptBtn');
  const downloadUploadAudioBtn = document.getElementById('downloadUploadAudioBtn');
  const saveUploadConvBtn = document.getElementById('saveUploadConvBtn');

  if (!uploadDropzone || !audioFileInput) return;

  browseAudioBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    audioFileInput.click();
  });

  uploadDropzone.addEventListener('click', () => {
    audioFileInput.click();
  });

  uploadDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadDropzone.classList.add('dragover');
  });

  uploadDropzone.addEventListener('dragleave', () => {
    uploadDropzone.classList.remove('dragover');
  });

  uploadDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadDropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });

  audioFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  });

  const uploadEngineSelect = document.getElementById('uploadEngineSelect');
  const uploadEngineBadge = document.getElementById('uploadEngineBadge');
  const uploadEngineNote = document.getElementById('uploadEngineNote');

  function updateUploadEngineUI() {
    const eng = uploadEngineSelect ? uploadEngineSelect.value : 'chirp_3';
    if (uploadEngineBadge) {
      if (eng === 'gemini-3.8-live') {
        uploadEngineBadge.innerText = 'Gemini 3.8 Live (Speech-to-Speech) + DLP';
      } else if (eng === 'gemini-3.5-transcribe') {
        uploadEngineBadge.innerText = 'Gemini 3.5 Transcribe + DLP + MT v3 + TTS';
      } else {
        uploadEngineBadge.innerText = 'Cloud Chirp 3 + DLP + MT v3 + TTS';
      }
    }
    if (uploadEngineNote) {
      if (eng === 'gemini-3.8-live') {
        uploadEngineNote.style.display = 'block';
        uploadEngineNote.innerText = 'Gemini 3.8 Live translates speech-to-speech directly; Cloud DLP redacts transcripts only and Brand Glossary is enforced via system prompt.';
      } else {
        uploadEngineNote.style.display = 'none';
        uploadEngineNote.innerText = '';
      }
    }
  }

  if (uploadEngineSelect) {
    uploadEngineSelect.addEventListener('change', updateUploadEngineUI);
    updateUploadEngineUI();
  }

  if (removeSelectedFileBtn) {
    removeSelectedFileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedUploadFile = null;
      audioFileInput.value = '';
      selectedFileInfo.style.display = 'none';
      processUploadBtn.disabled = true;
      if (uploadResultsCard) uploadResultsCard.style.display = 'none';
    });
  }

  function handleFileSelected(file) {
    selectedUploadFile = file;
    selectedFileName.innerText = file.name;
    const kb = Math.round(file.size / 1024);
    selectedFileSize.innerText = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
    selectedFileInfo.style.display = 'inline-flex';
    processUploadBtn.disabled = false;
  }

  processUploadBtn.addEventListener('click', async () => {
    if (!selectedUploadFile) return;

    const uploadEngine = uploadEngineSelect ? uploadEngineSelect.value : 'chirp_3';
    const engineLabel = uploadEngine === 'gemini-3.8-live'
      ? 'Gemini 3.8 Live'
      : (uploadEngine === 'gemini-3.5-transcribe' ? 'Gemini 3.5 Transcribe' : 'Chirp 3 (Speech v2)');

    uploadStatusBox.style.display = 'flex';
    uploadStatusText.innerText = 'Decoding audio file and converting to 16kHz PCM...';
    processUploadBtn.disabled = true;
    if (uploadResultsCard) uploadResultsCard.style.display = 'none';

    try {
      // 1. Decode audio in browser to 16kHz Mono Int16 PCM
      const arrayBuf = await selectedUploadFile.arrayBuffer();
      const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuf = await tempCtx.decodeAudioData(arrayBuf);
      
      uploadStatusText.innerText = `Resampling to 16kHz mono PCM for ${engineLabel}...`;
      const pcm16 = resampleAudioBufferTo16kPcm(audioBuf);
      const base64Audio = arrayBufferToBase64(pcm16.buffer);

      uploadStatusText.innerText = `Processing with ${engineLabel}: detecting languages, redacting PII and translating each utterance...`;

      const castLang = document.getElementById('uploadCastLang').value;
      const guestLang = document.getElementById('uploadGuestLang').value;
      const smartDetect = document.getElementById('uploadSmartDetect').checked;
      const useGlossary = document.getElementById('uploadUseGlossary').checked;
      const useDlp = document.getElementById('uploadUseDlp').checked;

      const payload = {
        audio_base64: base64Audio,
        engine: uploadEngine,
        stt_model: uploadEngine,
        cast_lang: castLang,
        guest_lang: guestLang,
        smart_detect: smartDetect,
        voice: personaVoiceSelect ? personaVoiceSelect.value : 'Aoede',
        use_glossary: useGlossary,
        use_dlp: useDlp,
        dlp_info_types: Array.from(activeDlpInfoTypes)
      };

      const res = await fetch('/api/translate-audio-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        let detail = '';
        try {
          const errBody = await res.json();
          detail = errBody.message || (typeof errBody.detail === 'string' ? errBody.detail : '') || errBody.error || '';
        } catch (e) { /* not JSON */ }
        throw new Error(`Pipeline returned HTTP ${res.status}${detail ? ': ' + detail : ''}`);
      }

      const data = await res.json();
      currentUploadResult = {
        file_name: selectedUploadFile.name,
        engine: data.engine || uploadEngine,
        source_lang: data.cast_lang || castLang,
        target_lang: data.guest_lang || guestLang,
        cast_lang: data.cast_lang || castLang,
        guest_lang: data.guest_lang || guestLang,
        detected_guest_lang: data.detected_guest_lang || null,
        detected_guest_label: data.detected_guest_label || null,
        segments: data.segments || [],
        original_transcript: (data.stt && data.stt.transcript) || '',
        sanitized_transcript: (data.dlp && data.dlp.sanitized_text) || (data.stt && data.stt.transcript) || '',
        translated_text: (data.translation && data.translation.translated_text) || '',
        audio_base64: (data.tts && data.tts.audio_base64) || '',
        stt_ms: data.stt ? data.stt.latency_ms : 0,
        stt_model: data.stt ? data.stt.stt_model : engineLabel,
        dlp_ms: data.dlp ? data.dlp.latency_ms : 0,
        dlp_scope: (data.dlp && data.dlp.dlp_scope) || 'full',
        translation_ms: data.translation ? data.translation.latency_ms : 0,
        tts_ms: data.tts ? data.tts.latency_ms : 0,
        total_latency_ms: data.total_latency_ms || 0,
        dlp_findings: (data.dlp && data.dlp.findings) || []
      };

      // Display results
      renderUploadResults(currentUploadResult);
      uploadStatusBox.style.display = 'none';
      processUploadBtn.disabled = false;
      addTerminalLog(`[Recorded Upload | ${currentUploadResult.stt_model}] Processed "${selectedUploadFile.name}": ${currentUploadResult.segments.length} segment(s)${currentUploadResult.detected_guest_label ? ', guest language detected: ' + currentUploadResult.detected_guest_label : ''}`, 'mt');
    } catch (err) {
      console.error('Error processing audio upload:', err);
      uploadStatusBox.style.display = 'none';
      processUploadBtn.disabled = false;
      alert(`Error translating audio file: ${err.message}`);
    }
  });

  if (downloadUploadTranscriptBtn) {
    downloadUploadTranscriptBtn.addEventListener('click', () => {
      if (!currentUploadResult) return;
      const turns = uploadResultTurns(currentUploadResult);
      downloadTranscriptFile(turns, `upload_${currentUploadResult.file_name}_transcript`);
    });
  }

  if (downloadUploadAudioBtn) {
    downloadUploadAudioBtn.addEventListener('click', () => {
      if (!currentUploadResult || !currentUploadResult.audio_base64) {
        alert('No synthesized audio available for this upload.');
        return;
      }
      downloadSynthesizedAudio([{ pcmBase64: currentUploadResult.audio_base64, sampleRate: 24000 }], `upload_${currentUploadResult.file_name}_translated.wav`);
    });
  }

  if (saveUploadConvBtn) {
    saveUploadConvBtn.addEventListener('click', async () => {
      if (!currentUploadResult) return;
      await saveCurrentUploadConversation();
    });
  }
}

function renderUploadResults(result) {
  const card = document.getElementById('uploadResultsCard');
  if (!card) return;
  card.style.display = 'flex';

  const origEl = document.getElementById('uploadOriginalText');
  const transEl = document.getElementById('uploadTranslatedText');
  const sttLat = document.getElementById('uploadSttLatency');
  const mtLat = document.getElementById('uploadMtLatency');
  const dlpMeta = document.getElementById('uploadDlpMeta');
  const player = document.getElementById('uploadAudioPlayer');

  if (origEl) origEl.innerText = result.original_transcript || '(No speech detected)';
  if (transEl) transEl.innerText = result.translated_text || '(Translation pending)';
  if (sttLat) sttLat.innerText = `${result.stt_model ? result.stt_model + ' • ' : ''}${Math.round(result.stt_ms)} ms`;
  if (mtLat) mtLat.innerText = `${Math.round(result.translation_ms + result.tts_ms)} ms`;

  if (dlpMeta) {
    const scopeNote = result.dlp_scope === 'transcript_only' ? ' (transcript only)' : '';
    if (result.dlp_findings && result.dlp_findings.length > 0) {
      dlpMeta.innerHTML = `<span style="color:#ff8a80">⚠️ Cloud DLP Redacted${scopeNote}:</span> ${result.dlp_findings.map(f => f.displayName || f.infoType).join(', ')}`;
    } else {
      dlpMeta.innerText = `🛡️ Cloud DLP${scopeNote}: Clean (No PII detected)`;
    }
  }

  if (player && result.audio_base64) {
    const wavBlob = pcm16Base64ToWavBlob(result.audio_base64, 24000);
    player.src = URL.createObjectURL(wavBlob);
    player.load();
  }

  // Detected guest language badge
  const detectedEl = document.getElementById('uploadDetectedGuest');
  if (detectedEl) {
    if (result.detected_guest_label) {
      detectedEl.innerText = `Guest detected: ${result.detected_guest_label}`;
      detectedEl.style.display = 'inline-flex';
    } else {
      detectedEl.style.display = 'none';
    }
  }

  // Per-utterance breakdown with per-turn latency pills and click-to-seek playback
  const list = document.getElementById('uploadSegmentsList');
  if (list) {
    const segments = result.segments || [];
    if (segments.length === 0) {
      list.innerHTML = '<div class="upload-segment-empty">No utterances detected.</div>';
    } else {
      list.innerHTML = '';
      const segmentCards = [];
      segments.forEach((seg, idx) => {
        const src = langMeta(seg.src_lang);
        const tgt = langMeta(seg.tgt_lang);
        const hasAudioSpan = seg.audio_start_s !== undefined && seg.audio_end_s !== undefined && seg.audio_end_s > seg.audio_start_s;
        const card = document.createElement('div');
        card.className = `upload-segment ${seg.role}${hasAudioSpan ? ' clickable-turn' : ''}`;
        const playBadgeHtml = hasAudioSpan
          ? `<span class="turn-play-badge" title="Click turn to play this segment">▶ ${formatSec(seg.audio_start_s)} – ${formatSec(seg.audio_end_s)}</span>`
          : '';
        const latencyHtml = formatTurnLatencyBadges(seg);
        card.innerHTML = `
          <div class="upload-segment-meta">
            <span class="upload-segment-role"></span>
            <div style="display:flex; align-items:center; gap:8px;">
              ${playBadgeHtml}
              <span class="upload-segment-dir">${src.flag} ${escapeHtml(src.label)} → ${tgt.flag} ${escapeHtml(tgt.label)}</span>
            </div>
          </div>
          <div class="upload-segment-original"></div>
          <div class="upload-segment-translated"></div>
          ${latencyHtml ? `<div class="turn-latency-row">${latencyHtml}</div>` : ''}
        `;
        card.querySelector('.upload-segment-role').innerText =
          `${idx + 1}. ${seg.role === 'cast-member' ? 'Cast Member' : 'Guest'}${seg.dlp_applied ? ' • DLP redacted' : ''}${seg.glossary_applied ? ' • Glossary' : ''}`;
        card.querySelector('.upload-segment-original').innerText = seg.sanitized_transcript || seg.transcript || '';
        card.querySelector('.upload-segment-translated').innerText = seg.translated_text || '';

        if (hasAudioSpan && player) {
          card.addEventListener('click', () => {
            segmentCards.forEach(c => c.classList.remove('active-playing-turn'));
            card.classList.add('active-playing-turn');
            player.currentTime = seg.audio_start_s;
            player.play().catch(() => {});
          });
        }
        segmentCards.push(card);
        list.appendChild(card);
      });

      if (player) {
        player.ontimeupdate = () => {
          const t = player.currentTime;
          segments.forEach((seg, idx) => {
            const c = segmentCards[idx];
            if (!c) return;
            const active = !player.paused && seg.audio_start_s !== undefined && seg.audio_end_s !== undefined &&
              t >= seg.audio_start_s && t <= seg.audio_end_s + 0.08;
            c.classList.toggle('active-playing-turn', active);
          });
        };
        player.onended = () => {
          segmentCards.forEach(c => c.classList.remove('active-playing-turn'));
        };
      }
    }
  }
}

// Build transcript turns (one per utterance) from an upload result
function uploadResultTurns(result) {
  const now = new Date().toLocaleTimeString();
  const segments = result.segments || [];
  if (segments.length === 0) {
    return [{
      role: 'recorded-file',
      roleLabel: `Uploaded Audio (${result.file_name})`,
      originalText: result.original_transcript,
      translatedText: result.translated_text,
      sttMs: result.stt_ms,
      dlpMs: result.dlp_ms,
      transMs: result.translation_ms,
      ttsMs: result.tts_ms,
      totalLatencyMs: result.total_latency_ms,
      sttModel: result.stt_model,
      time: now,
      timestamp: Date.now()
    }];
  }
  return segments.map(seg => ({
    role: seg.role,
    roleLabel: `${roleLabelFor(seg.role, seg.src_lang)} → ${langMeta(seg.tgt_lang).label}`,
    originalText: seg.sanitized_transcript || seg.transcript,
    translatedText: seg.translated_text,
    srcLang: seg.src_lang,
    tgtLang: seg.tgt_lang,
    detectedLang: seg.detected_lang,
    dlpApplied: seg.dlp_applied,
    glossaryApplied: seg.glossary_applied,
    sttMs: seg.stt_ms,
    dlpMs: seg.dlp_ms,
    transMs: seg.translation_ms,
    ttsMs: seg.tts_ms,
    totalLatencyMs: seg.total_latency_ms,
    sttModel: seg.stt_model || result.stt_model,
    engine: seg.engine || (engineSelect ? engineSelect.value : null),
    translationModel: seg.model || null,
    audioStartSec: seg.audio_start_s,
    audioEndSec: seg.audio_end_s,
    time: now,
    timestamp: Date.now()
  }));
}

// Convert AudioBuffer to 16kHz Mono Int16Array PCM
function resampleAudioBufferTo16kPcm(audioBuffer) {
  const targetSampleRate = 16000;
  const numChannels = audioBuffer.numberOfChannels;
  const length = Math.round(audioBuffer.duration * targetSampleRate);
  
  // Merge channels to mono
  const monoChannel = new Float32Array(audioBuffer.length);
  for (let c = 0; c < numChannels; c++) {
    const channelData = audioBuffer.getChannelData(c);
    for (let i = 0; i < audioBuffer.length; i++) {
      monoChannel[i] += channelData[i] / numChannels;
    }
  }

  // Linear interpolation resampling to 16kHz
  const ratio = audioBuffer.sampleRate / targetSampleRate;
  const result = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const origIndex = i * ratio;
    const indexFloor = Math.floor(origIndex);
    const frac = origIndex - indexFloor;
    const sample1 = monoChannel[indexFloor] || 0;
    const sample2 = monoChannel[Math.min(indexFloor + 1, monoChannel.length - 1)] || 0;
    const interp = sample1 + (sample2 - sample1) * frac;
    const clamped = Math.max(-1, Math.min(1, interp));
    result[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }
  return result;
}

// ----------------------------------------------------
// Past Conversations & Saved Transcripts
// ----------------------------------------------------
function stopModalAudioPlayer() {
  const audioEl = document.getElementById('modalAudioElement');
  const playBtn = document.getElementById('modalPlayPauseBtn');
  if (audioEl) {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
  }
  if (playBtn) playBtn.innerText = '▶';
}

function setupPastConversations() {
  const refreshBtn = document.getElementById('refreshConversationsBtn');
  const searchInput = document.getElementById('conversationsSearchInput');
  const filterPills = document.querySelectorAll('.filter-pill');
  const closeBtn = document.getElementById('closeConversationModalBtn');
  const modal = document.getElementById('conversationModal');

  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadPastConversations);
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      filterAndRenderConversations();
    });
  }

  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      filterAndRenderConversations();
    });
  });

  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => {
      stopModalAudioPlayer();
      modal.style.display = 'none';
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        stopModalAudioPlayer();
        modal.style.display = 'none';
      }
    });
  }
}

async function loadPastConversations() {
  try {
    const res = await fetch('/api/conversations');
    if (res.ok) {
      savedConversationsList = await res.json();
      filterAndRenderConversations();
    }
  } catch (err) {
    console.warn('Failed to load past conversations:', err.message);
  }
}

function filterAndRenderConversations() {
  const container = document.getElementById('conversationsContainer');
  const searchInput = document.getElementById('conversationsSearchInput');
  const activePill = document.querySelector('.filter-pill.active');
  if (!container) return;

  const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
  const filterMode = activePill ? activePill.getAttribute('data-filter') : 'all';

  let list = savedConversationsList;
  if (filterMode !== 'all') {
    list = list.filter(c => c.mode === filterMode);
  }

  if (query) {
    list = list.filter(c => {
      return (c.title && c.title.toLowerCase().includes(query)) ||
             (c.sourceLang && c.sourceLang.toLowerCase().includes(query)) ||
             (c.targetLang && c.targetLang.toLowerCase().includes(query));
    });
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-conversations-state">
        <span class="empty-icon">📭</span>
        <p>No conversations found.</p>
        <span class="empty-sub">Translate in Live mode or upload an audio file and click <strong>"Save"</strong>.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  list.forEach(conv => {
    const card = document.createElement('div');
    card.className = 'conversation-card';
    const dateFormatted = new Date(conv.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const isLive = conv.mode === 'live';
    const srcMeta = langMeta(conv.sourceLang);
    const tgtMeta = langMeta(conv.targetLang);

    card.innerHTML = `
      <div class="conv-card-left">
        <div class="conv-card-title-row">
          <span class="conv-title">${escapeHtml(conv.title)}</span>
          <span class="conv-mode-badge ${conv.mode}">${isLive ? 'Live Stream' : 'Recorded Upload'}</span>
        </div>
        <div class="conv-meta">
          <span>📅 ${dateFormatted}</span>
          <span>💬 ${conv.turnCount || 1} Turn(s)</span>
          <span>${srcMeta.flag} ${escapeHtml(srcMeta.label)} ⇄ ${tgtMeta.flag} ${escapeHtml(tgtMeta.label)}</span>
          ${conv.hasAudio ? '<span>🔊 Audio Saved</span>' : ''}
        </div>
      </div>
      <div class="conv-card-right">
        <button class="action-pill-btn btn-view-conv" title="Open Conversation">
          <span>View Transcript ➔</span>
        </button>
      </div>
    `;

    card.addEventListener('click', () => {
      openConversationDetails(conv.id);
    });

    container.appendChild(card);
  });
}

function pcmChunksListToWavBlob(pcmChunksList) {
  if (!pcmChunksList || pcmChunksList.length === 0) return null;
  const sampleRate = pcmChunksList[0].sampleRate || 24000;
  const arrays = [];
  let totalLength = 0;

  for (const item of pcmChunksList) {
    const b64 = item.pcmBase64 || item;
    if (!b64) continue;
    const binary = window.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);
    arrays.push(int16);
    totalLength += int16.length;
  }
  if (totalLength === 0) return null;

  const mergedInt16 = new Int16Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    mergedInt16.set(arr, offset);
    offset += arr.length;
  }
  return int16ToWavBlob(mergedInt16, sampleRate);
}

async function openConversationDetails(convId) {
  const modal = document.getElementById('conversationModal');
  const titleEl = document.getElementById('modalConvTitle');
  const dateEl = document.getElementById('modalConvDate');
  const container = document.getElementById('modalTurnsContainer');
  const downloadTransBtn = document.getElementById('modalDownloadTranscriptBtn');
  const downloadAudioBtn = document.getElementById('modalDownloadAudioBtn');
  const deleteBtn = document.getElementById('modalDeleteConvBtn');
  const playerBar = document.getElementById('modalAudioPlayerBar');
  const playPauseBtn = document.getElementById('modalPlayPauseBtn');
  const scrubber = document.getElementById('modalTimelineScrubber');
  const markersEl = document.getElementById('modalTimelineMarkers');
  const timeDisplay = document.getElementById('modalTimeDisplay');
  const activeTurnLabel = document.getElementById('modalActiveTurnLabel');
  const audioEl = document.getElementById('modalAudioElement');

  if (!modal) return;
  stopModalAudioPlayer();
  if (playerBar) playerBar.style.display = 'none';
  modal.style.display = 'flex';
  container.innerHTML = '<div style="padding:20px; text-align:center; color:#94a3b8;">Loading conversation...</div>';

  try {
    const res = await fetch(`/api/conversations/${convId}`);
    if (!res.ok) throw new Error('Not found');
    const conv = await res.json();

    titleEl.innerText = conv.title || 'Conversation Details';
    dateEl.innerText = `Recorded: ${new Date(conv.createdAt).toLocaleString()}`;

    const turns = conv.turns || [];
    // Gather audio chunks
    const pcmList = [];
    if (conv.metadata && conv.metadata.synthesizedPcmChunks) {
      pcmList.push(...conv.metadata.synthesizedPcmChunks);
    }
    turns.forEach(t => {
      if (t.audioBase64) pcmList.push({ pcmBase64: t.audioBase64, sampleRate: 24000 });
    });

    const wavBlob = pcmChunksListToWavBlob(pcmList);
    const hasAudio = !!wavBlob;

    // Render turns with per-turn latency metrics & click-to-seek badges
    container.innerHTML = '';
    const turnCards = [];
    if (turns.length === 0) {
      container.innerHTML = '<div style="color:#94a3b8; padding: 10px;">No dialogue turns saved.</div>';
    } else {
      turns.forEach((turn, idx) => {
        const turnCard = document.createElement('div');
        turnCard.className = `modal-turn-card${hasAudio ? ' clickable-turn' : ''}`;
        turnCard.dataset.turnIdx = String(idx);
        const startS = turn.audioStartSec !== undefined ? turn.audioStartSec : turn.audio_start_s;
        const endS = turn.audioEndSec !== undefined ? turn.audioEndSec : turn.audio_end_s;
        const hasSpan = startS !== undefined && endS !== undefined && endS > startS;
        const playBadgeText = hasSpan
          ? `▶ ${formatSec(startS)} – ${formatSec(endS)}`
          : (hasAudio ? `▶ Play Turn ${idx + 1}` : '');
        const playBadgeHtml = playBadgeText
          ? `<span class="turn-play-badge" data-badge-idx="${idx}" title="Click to jump to Turn ${idx + 1} in the audio">${playBadgeText}</span>`
          : '';
        const latencyHtml = formatTurnLatencyBadges(turn);

        turnCard.innerHTML = `
          <div class="modal-turn-header">
            <span><strong>Turn ${idx + 1}</strong> • ${escapeHtml(turn.roleLabel || turn.role || 'Speaker')}</span>
            <div style="display:flex; align-items:center; gap:8px;">
              ${playBadgeHtml}
              <span>${turn.time || ''}</span>
            </div>
          </div>
          <div class="modal-turn-original">
            <strong>Original:</strong> "${escapeHtml(turn.originalText || '')}"
          </div>
          <div class="modal-turn-translated">
            <strong>Translated:</strong> "${escapeHtml(turn.translatedText || '')}"
          </div>
          ${latencyHtml ? `<div class="turn-latency-row">${latencyHtml}</div>` : ''}
        `;
        turnCards.push(turnCard);
        container.appendChild(turnCard);
      });
    }

    // Configure interactive timeline scrubber + turn sync if audio is present
    if (hasAudio && playerBar && audioEl && scrubber && playPauseBtn) {
      playerBar.style.display = 'flex';
      const audioUrl = URL.createObjectURL(wavBlob);
      audioEl.src = audioUrl;
      audioEl.load();
      playPauseBtn.innerText = '▶';
      scrubber.value = '0';
      if (activeTurnLabel) activeTurnLabel.innerText = 'Click any turn card or press Play';

      const getTurnBounds = (turn) => {
        const s = turn.audioStartSec !== undefined ? turn.audioStartSec : turn.audio_start_s;
        const e = turn.audioEndSec !== undefined ? turn.audioEndSec : turn.audio_end_s;
        return { start: s, end: e };
      };

      const seekToTurn = (idx, autoPlay = true) => {
        const turn = turns[idx];
        if (!turn) return;
        const { start } = getTurnBounds(turn);
        if (start !== undefined && !isNaN(start)) {
          audioEl.currentTime = start;
          scrubber.value = String(start);
        }
        highlightActiveTurn(idx, true);
        if (autoPlay) {
          audioEl.play().catch(() => {});
        }
      };

      const highlightActiveTurn = (activeIdx, scrollIntoView = false) => {
        turnCards.forEach((card, i) => {
          const isMatch = i === activeIdx;
          card.classList.toggle('active-playing-turn', isMatch);
          if (isMatch && scrollIntoView) {
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        });
        if (markersEl) {
          const markerDots = markersEl.querySelectorAll('.modal-timeline-marker');
          markerDots.forEach((m, i) => m.classList.toggle('active', i === activeIdx));
        }
        if (activeTurnLabel) {
          if (activeIdx >= 0 && turns[activeIdx]) {
            const t = turns[activeIdx];
            activeTurnLabel.innerText = `Playing Turn ${activeIdx + 1}/${turns.length} • ${t.roleLabel || t.role || 'Speaker'}`;
          } else if (audioEl.paused) {
            activeTurnLabel.innerText = 'Paused • Click any turn or scrub timeline';
          }
        }
      };

      turnCards.forEach((card, idx) => {
        card.addEventListener('click', () => seekToTurn(idx, true));
      });

      audioEl.onloadedmetadata = () => {
        const dur = audioEl.duration || 0;
        scrubber.max = String(dur > 0 ? dur : 1);
        if (timeDisplay) timeDisplay.innerText = `0:00 / ${formatSec(dur)}`;

        // If turns don't have saved audioStartSec/audioEndSec (e.g. older saved conversations),
        // estimate proportional spans across the audio duration so scrubbing & click-to-seek work.
        const anyHasSpan = turns.some(t => {
          const { start, end } = getTurnBounds(t);
          return start !== undefined && end !== undefined && end > start;
        });
        if (!anyHasSpan && dur > 0 && turns.length > 0) {
          const weights = turns.map(t => Math.max(8, (t.translatedText || t.originalText || '').length));
          const totalWeight = weights.reduce((a, b) => a + b, 0);
          let cursor = 0;
          turns.forEach((t, idx) => {
            const span = (weights[idx] / totalWeight) * dur;
            t.audioStartSec = Number(cursor.toFixed(2));
            t.audioEndSec = Number(Math.min(dur, cursor + span).toFixed(2));
            cursor += span;
            const badge = turnCards[idx] && turnCards[idx].querySelector('.turn-play-badge');
            if (badge) {
              badge.innerText = `▶ ${formatSec(t.audioStartSec)} – ${formatSec(t.audioEndSec)}`;
            }
          });
        }

        // Render turn markers along the timeline scrubber
        if (markersEl && dur > 0) {
          markersEl.innerHTML = '';
          turns.forEach((t, idx) => {
            const { start, end } = getTurnBounds(t);
            if (start === undefined || end === undefined || end <= start) return;
            const leftPct = Math.max(0, Math.min(100, (start / dur) * 100));
            const widthPct = Math.max(1.5, Math.min(100 - leftPct, ((end - start) / dur) * 100));
            const marker = document.createElement('div');
            marker.className = `modal-timeline-marker ${t.role === 'cast-member' ? 'cast-member' : 'guest'}`;
            marker.style.left = `${leftPct}%`;
            marker.style.width = `${widthPct}%`;
            marker.title = `Turn ${idx + 1}: ${t.roleLabel || t.role} (${formatSec(start)} – ${formatSec(end)})`;
            marker.addEventListener('click', (e) => {
              e.stopPropagation();
              seekToTurn(idx, true);
            });
            markersEl.appendChild(marker);
          });
        }
      };

      playPauseBtn.onclick = () => {
        if (audioEl.paused) {
          audioEl.play().catch(() => {});
        } else {
          audioEl.pause();
        }
      };

      audioEl.onplay = () => {
        playPauseBtn.innerText = '⏸';
      };

      audioEl.onpause = () => {
        playPauseBtn.innerText = '▶';
      };

      audioEl.ontimeupdate = () => {
        const cur = audioEl.currentTime || 0;
        const dur = audioEl.duration || 0;
        scrubber.value = String(cur);
        if (timeDisplay) timeDisplay.innerText = `${formatSec(cur)} / ${formatSec(dur)}`;

        let activeIdx = -1;
        for (let i = 0; i < turns.length; i++) {
          const { start, end } = getTurnBounds(turns[i]);
          if (start !== undefined && end !== undefined && cur >= start && cur <= end + 0.15) {
            activeIdx = i;
            break;
          }
        }
        highlightActiveTurn(activeIdx, !audioEl.paused);
      };

      scrubber.oninput = () => {
        const targetTime = parseFloat(scrubber.value) || 0;
        audioEl.currentTime = targetTime;
        const dur = audioEl.duration || 0;
        if (timeDisplay) timeDisplay.innerText = `${formatSec(targetTime)} / ${formatSec(dur)}`;
        let activeIdx = -1;
        for (let i = 0; i < turns.length; i++) {
          const { start, end } = getTurnBounds(turns[i]);
          if (start !== undefined && end !== undefined && targetTime >= start && targetTime <= end + 0.15) {
            activeIdx = i;
            break;
          }
        }
        highlightActiveTurn(activeIdx, true);
      };

      audioEl.onended = () => {
        playPauseBtn.innerText = '▶';
        highlightActiveTurn(-1, false);
        if (activeTurnLabel) activeTurnLabel.innerText = 'Playback finished • Click any turn to replay';
      };
    }

    // Modal action buttons
    downloadTransBtn.onclick = () => {
      downloadTranscriptFile(turns, `${conv.title.replace(/[^a-z0-9_-]/gi, '_')}_transcript`);
    };

    downloadAudioBtn.onclick = () => {
      if (pcmList.length === 0) {
        alert('No synthesized audio chunks were saved with this conversation.');
        return;
      }
      downloadSynthesizedAudio(pcmList, `${conv.title.replace(/[^a-z0-9_-]/gi, '_')}_audio.wav`);
    };

    deleteBtn.onclick = async () => {
      if (confirm(`Are you sure you want to delete "${conv.title}"?`)) {
        stopModalAudioPlayer();
        await fetch(`/api/conversations/${convId}`, { method: 'DELETE' });
        modal.style.display = 'none';
        await loadPastConversations();
        addTerminalLog(`Deleted conversation "${conv.title}".`, 'system');
      }
    };
  } catch (err) {
    console.error('Error fetching conversation details:', err);
    container.innerHTML = `<div style="color:#f87171; padding: 16px;">Failed to load conversation: ${err.message}</div>`;
  }
}

// ----------------------------------------------------
// Save Conversation Handlers
// ----------------------------------------------------
async function saveCurrentLiveConversation() {
  if (liveConversationTurns.length === 0) {
    alert('No dialogue turns recorded yet. Speak into the microphone or use a test scenario first!');
    return;
  }

  const [src, tgt] = getLangPair();
  const title = prompt('Enter a title for this conversation:', `Live Dialogue (${new Date().toLocaleTimeString()})`);
  if (!title) return;

  // Build combined PCM audio with 0.30s inter-turn silence and compute exact per-turn audioStartSec / audioEndSec
  const combinedPcmChunks = [];
  const silenceSamples = new Int16Array(Math.floor(24000 * 0.30));
  const silenceBytes = new Uint8Array(silenceSamples.buffer);
  let silenceBinary = '';
  for (let i = 0; i < silenceBytes.length; i++) {
    silenceBinary += String.fromCharCode(silenceBytes[i]);
  }
  const silenceBase64 = window.btoa(silenceBinary);

  let audioCursorSec = 0.0;
  const serializedTurns = liveConversationTurns.map((t) => {
    const turnCopy = Object.assign({}, t);
    delete turnCopy.pcmChunks;
    const chunks = t.pcmChunks || [];
    if (chunks.length > 0) {
      let turnSamples = 0;
      const sr = chunks[0].sampleRate || 24000;
      chunks.forEach(c => {
        const b64 = c.pcmBase64 || '';
        const byteLen = Math.floor((b64.length * 3) / 4);
        turnSamples += Math.floor(byteLen / 2);
        combinedPcmChunks.push({ pcmBase64: b64, sampleRate: sr });
      });
      const turnDurSec = turnSamples / sr;
      turnCopy.audioStartSec = Number(audioCursorSec.toFixed(2));
      turnCopy.audioEndSec = Number((audioCursorSec + turnDurSec).toFixed(2));
      audioCursorSec += turnDurSec;
      // Add a 0.30s pause between turns
      combinedPcmChunks.push({ pcmBase64: silenceBase64, sampleRate: sr });
      audioCursorSec += 0.30;
    }
    return turnCopy;
  });

  const finalPcmChunks = combinedPcmChunks.length > 0 ? combinedPcmChunks : liveSynthesizedPcmChunks;

  const payload = {
    title: title.trim(),
    sourceLang: src,
    targetLang: tgt,
    mode: 'live',
    turns: serializedTurns,
    metadata: {
      totalTurns: serializedTurns.length,
      castLang: src,
      guestLang: tgt,
      guestLangDetected: !!detectedGuestLang,
      smartDetect: smartDetectToggle.checked,
      engine: engineSelect.value,
      synthesizedPcmChunks: finalPcmChunks
    }
  };

  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      alert('Conversation and transcript successfully saved to "Past Conversations" tab!');
      addTerminalLog(`Saved live conversation: "${title}" (${serializedTurns.length} turns).`, 'system');
    } else {
      alert('Failed to save conversation.');
    }
  } catch (err) {
    console.error('Error saving live conversation:', err);
    alert('Network error saving conversation.');
  }
}

async function saveCurrentUploadConversation() {
  if (!currentUploadResult) return;
  const title = prompt('Enter a title for this recorded conversation:', `Upload: ${currentUploadResult.file_name}`);
  if (!title) return;

  const turns = uploadResultTurns(currentUploadResult);

  const payload = {
    title: title.trim(),
    sourceLang: currentUploadResult.cast_lang || currentUploadResult.source_lang,
    targetLang: currentUploadResult.guest_lang || currentUploadResult.target_lang,
    mode: 'recorded-upload',
    turns,
    metadata: {
      fileName: currentUploadResult.file_name,
      totalLatencyMs: currentUploadResult.total_latency_ms,
      detectedGuestLang: currentUploadResult.detected_guest_lang,
      synthesizedPcmChunks: currentUploadResult.audio_base64
        ? [{ pcmBase64: currentUploadResult.audio_base64, sampleRate: 24000 }]
        : []
    }
  };

  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      alert('Recorded conversation successfully saved to "Past Conversations" tab!');
      addTerminalLog(`Saved upload conversation: "${title}".`, 'system');
    } else {
      alert('Failed to save conversation.');
    }
  } catch (err) {
    console.error('Error saving upload conversation:', err);
    alert('Network error saving conversation.');
  }
}

// ----------------------------------------------------
// Transcript & Audio File Download Utilities
// ----------------------------------------------------
function downloadTranscriptFile(turns, baseFilename = 'conversation_transcript') {
  if (!turns || turns.length === 0) {
    alert('No conversation transcript to download.');
    return;
  }

  let textContent = `# 2-Way Translation Conversation Transcript\n`;
  textContent += `Generated: ${new Date().toLocaleString()}\n`;
  textContent += `Total Turns: ${turns.length}\n`;
  textContent += `====================================================\n\n`;

  turns.forEach((turn, idx) => {
    textContent += `[Turn ${idx + 1}] ${turn.time || ''} - ${turn.roleLabel || turn.role || 'Speaker'}\n`;
    textContent += `Original:   ${turn.originalText || ''}\n`;
    textContent += `Translated: ${turn.translatedText || ''}\n`;
    const total = turn.totalLatencyMs !== undefined ? turn.totalLatencyMs : turn.total_latency_ms;
    const stt = turn.sttMs !== undefined ? turn.sttMs : turn.stt_ms;
    const dlp = turn.dlpMs !== undefined ? turn.dlpMs : turn.dlp_ms;
    const mt = turn.transMs !== undefined ? turn.transMs : turn.translation_ms;
    const tts = turn.ttsMs !== undefined ? turn.ttsMs : turn.tts_ms;
    const latParts = [];
    if (total !== undefined && total !== null) latParts.push(`Total: ${Math.round(total)}ms`);
    if (stt !== undefined && stt !== null) latParts.push(`STT: ${Math.round(stt)}ms`);
    if (dlp !== undefined && dlp !== null) latParts.push(`DLP: ${Math.round(dlp)}ms`);
    if (mt !== undefined && mt !== null) latParts.push(`Translate: ${Math.round(mt)}ms`);
    if (tts !== undefined && tts !== null) latParts.push(`TTS: ${Math.round(tts)}ms`);
    if (latParts.length > 0) textContent += `Latency:    ${latParts.join(' | ')}\n`;
    if (turn.sttModel) textContent += `STT Model:  ${turn.sttModel}\n`;
    if (turn.dlpApplied) textContent += `Cloud DLP:  Sanitized / Masked\n`;
    textContent += `----------------------------------------------------\n\n`;
  });

  const blob = new Blob([textContent], { type: 'text/markdown;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseFilename}_${Date.now()}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadSynthesizedAudio(pcmChunksList, filename = 'translation_audio.wav') {
  if (!pcmChunksList || pcmChunksList.length === 0) {
    alert('No audio recorded or synthesized for this conversation.');
    return;
  }

  // Concatenate all Int16 PCM samples
  const sampleRate = pcmChunksList[0].sampleRate || 24000;
  const arrays = [];
  let totalLength = 0;

  for (const item of pcmChunksList) {
    const b64 = item.pcmBase64 || item;
    const binary = window.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);
    arrays.push(int16);
    totalLength += int16.length;
  }

  const mergedInt16 = new Int16Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    mergedInt16.set(arr, offset);
    offset += arr.length;
  }

  const wavBlob = int16ToWavBlob(mergedInt16, sampleRate);
  const url = URL.createObjectURL(wavBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Convert Base64 LINEAR16 PCM to WAV Blob
function pcm16Base64ToWavBlob(base64Pcm, sampleRate = 24000) {
  const binary = window.atob(base64Pcm);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  return int16ToWavBlob(int16, sampleRate);
}

// Write Standard 44-byte RIFF/WAVE header
function int16ToWavBlob(int16Samples, sampleRate = 24000) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = int16Samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF identifier
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);  // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // BitsPerSample

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write PCM audio samples
  let sampleOffset = 44;
  for (let i = 0; i < int16Samples.length; i++) {
    view.setInt16(sampleOffset, int16Samples[i], true);
    sampleOffset += 2;
  }

  return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

window.addEventListener('DOMContentLoaded', init);
