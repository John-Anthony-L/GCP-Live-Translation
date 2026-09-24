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
let recordedChunks = [];
let vadSpeaking = false;
let vadSilenceStart = 0;
const VAD_ENERGY_THRESHOLD = 0.0035; // Sensitive voice activity threshold
const VAD_SILENCE_TIMEOUT_MS = 800; // 800ms silence automatically dispatches speech turn

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
const langPairSelect = document.getElementById('langPair');
const sttModelSelect = document.getElementById('sttModelSelect');
const sttModelSub = document.getElementById('sttModelSub');
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
  setupTabs();
  setupControls();
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

  langPairSelect.addEventListener('change', () => {
    updateLanguageLabels();
    reconnectWebSocket();
  });

  if (sttModelSelect) {
    sttModelSelect.addEventListener('change', () => {
      const model = sttModelSelect.value;
      const modelText = sttModelSelect.options[sttModelSelect.selectedIndex].text;
      if (sttModelSub) sttModelSub.innerText = model;
      if (terminalSttMeta) terminalSttMeta.innerText = model;
      addTerminalLog(`STT Engine changed to: ${modelText}`, 'system');
    });
  }

  personaVoiceSelect.addEventListener('change', () => {
    reconnectWebSocket();
  });

  clearChatBtn.addEventListener('click', () => {
    chatFeed.innerHTML = `
      <div class="chat-welcome">
        <span class="sparkle-icon">🌐</span>
        <p>Chat cleared. Ready for live translation with Cloud DLP protection.</p>
      </div>
    `;
    currentMessageBubble = null;
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
  
  // Highlight redaction placeholders
  const placeholderRegex = /\[[A-Z0-9_]+_REDACTED\]|\[[A-Z0-9_]+\]/g;
  outputHtml = outputHtml.replace(placeholderRegex, (match) => `<span class="redacted-token">${match}</span>`);

  sandboxOutput.innerHTML = outputHtml;
  if (sandboxLatency) sandboxLatency.innerText = `Inspection Latency: ${data.latency_ms || 0} ms`;
  if (sandboxPiiCount) sandboxPiiCount.innerText = `${data.findings ? data.findings.length : 0} Sensitive Entities Detected`;

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

async function startContinuousStream() {
  isContinuous = true;
  continuousStreamToggle.checked = true;
  streamModeHint.innerText = '🔴 Continuous 2-Way Stream (Live Hands-Free)';
  streamModeHint.classList.add('stream-active');
  castMemberMicBtn.classList.add('ambient-active');
  guestMicBtn.classList.add('ambient-active');
  if (castMemberBtnSubtext) castMemberBtnSubtext.innerText = '🎙️ Live Ambient Mic';
  if (guestBtnSubtext) guestBtnSubtext.innerText = '🎙️ Live Ambient Mic';

  currentSpeakerRole = 'ambient';
  addMessageBubble('ambient', '🎙️ Hands-free continuous 2-way stream active — speak naturally in English or Spanish...');
  await startRecording();
  setLiveStatus('🎙️ Ambient 2-Way Stream Live (Listening...)', true);
}

function getLangPair() {
  const val = langPairSelect.value;
  const idx = val.indexOf('-');
  const src = val.slice(0, idx);
  const tgt = val.slice(idx + 1);
  return [src, tgt];
}

function stopContinuousStream() {
  isContinuous = false;
  continuousStreamToggle.checked = false;
  streamModeHint.innerText = 'Dual Push-to-Talk (Active)';
  streamModeHint.classList.remove('stream-active');
  castMemberMicBtn.classList.remove('ambient-active');
  guestMicBtn.classList.remove('ambient-active');
  if (castMemberBtnSubtext) castMemberBtnSubtext.innerText = 'Hold to speak 🇺🇸';
  updateLanguageLabels();

  stopRecording();
  setLiveStatus('Ready', false);
}

function updateLanguageLabels() {
  const [src, tgt] = getLangPair();
  const langNames = {
    es: { name: 'Spanish (LATAM)', flag: '🇲🇽' },
    'es-ES': { name: 'Spanish (Spain)', flag: '🇪🇸' },
    pt: { name: 'Portuguese', flag: '🇧🇷' },
    fr: { name: 'French', flag: '🇫🇷' },
    ja: { name: 'Japanese', flag: '🇯🇵' },
    zh: { name: 'Mandarin', flag: '🇨🇳' }
  };
  const targetInfo = langNames[tgt] || { name: tgt.toUpperCase(), flag: '🌐' };
  guestSpeakerLabel.innerText = `Guest (${targetInfo.name})`;
  if (!isContinuous) {
    guestBtnSubtext.innerText = `Hold to speak ${targetInfo.flag}`;
  }
}

function setupMicButton(button, role) {
  const startHandler = async (e) => {
    if (e) e.preventDefault();
    if (isContinuous) {
      stopContinuousStream();
    } else {
      currentSpeakerRole = role;
      await startRecording();
    }
  };

  const stopHandler = (e) => {
    if (e) e.preventDefault();
    if (!isContinuous) {
      stopRecording();
    }
  };

  button.addEventListener('mousedown', startHandler);
  button.addEventListener('mouseup', stopHandler);
  button.addEventListener('touchstart', startHandler);
  button.addEventListener('touchend', stopHandler);
}

// Quick Scenario Buttons
function setupQuickScenarios() {
  document.querySelectorAll('.scenario-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const lang = chip.getAttribute('data-lang');
      const text = chip.getAttribute('data-text');
      const role = lang === 'en' ? 'cast-member' : 'guest';
      
      currentSpeakerRole = role;
      addMessageBubble(role, text);

      if (socket && socket.readyState === WebSocket.OPEN) {
        lastSpeechStartTimestamp = Date.now();
        setLiveStatus('Scrubbing PII with Cloud DLP & Translating...', true);
        
        const [src, tgt] = getLangPair();
        const isCastMember = role === 'cast-member';
        
        socket.send(JSON.stringify({
          type: 'text',
          text,
          speakerRole: role,
          sourceLang: isCastMember ? src : tgt,
          targetLang: isCastMember ? tgt : src,
          useGlossary: true,
          useDlp: dlpMasterEnabled,
          dlpInfoTypes: Array.from(activeDlpInfoTypes)
        }));
      }
    });
  });
}

function handleSendText() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';

  currentSpeakerRole = 'cast-member';
  addMessageBubble('cast-member', text);

  if (socket && socket.readyState === WebSocket.OPEN) {
    lastSpeechStartTimestamp = Date.now();
    setLiveStatus('Scrubbing PII with Cloud DLP & Translating...', true);
    const [src, tgt] = getLangPair();
    socket.send(JSON.stringify({
      type: 'text',
      text,
      speakerRole: 'cast-member',
      sourceLang: src,
      targetLang: tgt,
      useGlossary: true,
      useDlp: dlpMasterEnabled,
      dlpInfoTypes: Array.from(activeDlpInfoTypes)
    }));
  }
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
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'ready' || data.type === 'stream_started') {
        console.log('[WS] Session ready:', data);
        setLiveStatus('Ready');
        updateStatus('connected', 'Live & Ready');
      } else if (data.type === 'interim_transcript') {
        const role = data.speakerRole || currentSpeakerRole;
        if (!currentMessageBubble) {
          addMessageBubble(role, data.transcript);
        } else {
          const textEl = currentMessageBubble.querySelector('.message-text');
          if (textEl) {
            textEl.innerHTML = `<span class="interim-text">"${data.transcript}..."</span> <span class="badge-mini">⚡ live</span>`;
          }
        }
      } else if (data.type === 'stt_transcript') {
        console.log('[WS] STT Transcript:', data);
        const role = data.speakerRole || currentSpeakerRole;
        if (!currentMessageBubble) {
          addMessageBubble(role, data.transcript);
        }
        updateSpeakerOriginalText(
          data.sanitized_transcript || data.transcript,
          data.stt_ms,
          data.stt_model,
          role,
          data.dlp_applied
        );
        if (sttLatencyVal && data.stt_ms !== undefined) {
          sttLatencyVal.innerText = Math.round(data.stt_ms);
        }
        if (sttModelSub && data.stt_model) {
          sttModelSub.innerText = data.stt_model;
        }
        if (terminalSttText) {
          terminalSttText.innerText = data.transcript ? `"${data.transcript}"` : '(No speech detected)';
          terminalSttMeta.innerText = `${data.stt_model || 'chirp_3'} • ${data.detectedLang || 'en-US'} • ${Math.round(data.stt_ms || 0)}ms`;
        }
        if (data.transcript) {
          addTerminalLog(`STT Captured (${data.stt_model || 'chirp_3'}): "${data.transcript}" (${data.detectedLang || 'en-US'}, ${Math.round(data.stt_ms || 0)}ms)`, 'stt');
        }
        setLiveStatus('Scrubbing PII & Translating...', true);
      } else if (data.type === 'dlp_status') {
        console.log('[WS] DLP Status:', data);
        if (dlpLatencyVal && data.dlp_latency_ms !== undefined) {
          dlpLatencyVal.innerText = Math.round(data.dlp_latency_ms);
        }
        if (dlpMetricSub) {
          dlpMetricSub.innerText = data.pii_detected 
            ? `⚠️ ${data.findings.length} PII Masked` 
            : (data.dlp_enabled ? '🛡️ PCI & Custom Safe' : '⚠️ Bypassed');
        }
        if (terminalDlpText) {
          if (data.pii_detected) {
            terminalDlpText.innerHTML = `⚠️ <span style="color:#ff8a80">PII Scrubbed:</span> "${data.sanitized_text}"`;
            terminalDlpMeta.innerText = `${data.findings.length} Findings • ${Math.round(data.dlp_latency_ms || 0)}ms`;
            addTerminalLog(`[DLP MASKED] ${data.findings.map(f => f.displayName || f.infoType).join(', ')} -> Redacted before LLM (${Math.round(data.dlp_latency_ms || 0)}ms)`, 'dlp');
          } else {
            terminalDlpText.innerText = data.dlp_enabled ? `🛡️ Clean (No PII Detected)` : `⚠️ DLP Bypassed (Raw)`;
            terminalDlpMeta.innerText = `${Math.round(data.dlp_latency_ms || 0)}ms`;
          }
        }
      } else if (data.type === 'translation_text') {
        console.log('[WS] Translation Text:', data);
        updateMessageTranslation(data.translated_text, data.glossary_applied, data.translation_ms);
        if (transLatencyVal && data.translation_ms !== undefined) {
          transLatencyVal.innerText = Math.round(data.translation_ms);
        }
        if (terminalMtText) {
          terminalMtText.innerText = `"${data.translated_text}"`;
          terminalMtMeta.innerText = `${data.glossary_applied ? '📖 Brand Glossary Enforced' : 'Direct LLM'} • ${Math.round(data.translation_ms || 0)}ms`;
        }
        addTerminalLog(`Translation: "${data.translated_text}" (${data.glossary_applied ? 'Brand Glossary Enforced' : 'Direct LLM'}, ${Math.round(data.translation_ms || 0)}ms)`, 'mt');
        setLiveStatus('Generating Neural Speech...', true);
      } else if (data.type === 'audio' && data.pcm) {
        if (data.total_latency_ms && data.total_latency_ms > 0) {
          latencyValue.innerText = Math.round(data.total_latency_ms);
        } else if (lastSpeechStartTimestamp > 0) {
          latencyValue.innerText = Math.round(Date.now() - lastSpeechStartTimestamp);
        }

        if (data.latency_breakdown) {
          if (sttLatencyVal && data.latency_breakdown.stt_ms !== undefined) {
            sttLatencyVal.innerText = Math.round(data.latency_breakdown.stt_ms);
          }
          if (dlpLatencyVal && data.latency_breakdown.dlp_ms !== undefined) {
            dlpLatencyVal.innerText = Math.round(data.latency_breakdown.dlp_ms);
          }
          if (transLatencyVal && data.latency_breakdown.translation_ms !== undefined) {
            transLatencyVal.innerText = Math.round(data.latency_breakdown.translation_ms);
          }
          if (ttsLatencyVal && data.latency_breakdown.tts_ms !== undefined) {
            ttsLatencyVal.innerText = Math.round(data.latency_breakdown.tts_ms);
          }
        }

        if (terminalTtsText) {
          terminalTtsText.innerText = `🔊 Synthesized ${Math.round(data.pcm.length / 1024)} KB audio`;
          terminalTtsMeta.innerText = `Total: ${Math.round(data.total_latency_ms || 0)}ms`;
        }
        if (terminalMicState) {
          terminalMicState.innerText = isContinuous ? '🎙️ Ambient Live' : '🎙️ Mic Ready';
          terminalMicState.style.color = '#2ecc71';
        }
        addTerminalLog(`TTS Audio ready -> Playing through FIFO Audio Queue (Total E2E: ${Math.round(data.total_latency_ms || 0)}ms)`, 'tts');

        // Store PCM chunk for audio download & persistence
        liveSynthesizedPcmChunks.push({
          pcmBase64: data.pcm,
          sampleRate: data.sampleRate || 24000
        });

        setLiveStatus('Playing Translation Speech...', true);
        playPcmChunk(data.pcm, data.sampleRate || 24000);
        if (isContinuous) {
          currentMessageBubble = null;
        }
      } else if (data.type === 'transcript' && data.text) {
        updateMessageTranslation(data.text);
      } else if (data.type === 'no_speech') {
        setLiveStatus(isContinuous ? '🎙️ Ambient Mic Active (Listening...)' : 'Ready', isContinuous);
        if (terminalSttText) {
          terminalSttText.innerText = '(No audible speech detected - speak closer to mic)';
          terminalSttMeta.innerText = '--';
        }
        if (terminalMicState) {
          terminalMicState.innerText = isContinuous ? '🎙️ Ambient Live' : '🎙️ Mic Ready';
          terminalMicState.style.color = '#2ecc71';
        }
        addTerminalLog('No audible speech detected in audio turn.', 'err');
        if (currentMessageBubble) {
          const textEl = currentMessageBubble.querySelector('.message-text');
          if (textEl && textEl.innerText.includes('Speaking')) {
            textEl.innerText = '(No clear speech detected - please speak closer to microphone)';
          }
          const transEl = currentMessageBubble.querySelector('.message-translated');
          if (transEl) transEl.innerText = '';
        }
      } else if (data.type === 'turn_complete') {
        if (isContinuous) {
          setLiveStatus('🎙️ Ambient Mic Active (Listening for English or Spanish...)', true);
          currentMessageBubble = null;
        } else {
          setLiveStatus('Ready', false);
        }
      } else if (data.type === 'interrupted') {
        setLiveStatus('Interrupted (Listening...)', true);
        currentMessageBubble = null;
      } else if (data.type === 'error') {
        console.error('[WS] Server error:', data.message);
        setLiveStatus(`Error: ${data.message}`, false);
        updateStatus('disconnected', 'Service Error');
        addTerminalLog(`Pipeline Error: ${data.message}`, 'err');
      }
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

// Audio Recording (Capture 16kHz PCM)
async function startRecording() {
  if (isRecording) return;
  recordedChunks = [];
  vadSpeaking = false;
  vadSilenceStart = 0;
  
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

    const source = audioContext.createMediaStreamSource(micStream);
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

    scriptProcessor.onaudioprocess = (e) => {
      if (!isRecording) return;
      if (isSpeakingSelf) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = convertFloat32ToInt16(inputData);

      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sum / inputData.length);

      if (terminalRmsBar) {
        const pct = Math.min(100, Math.round(rms * 2500));
        terminalRmsBar.style.width = `${pct}%`;
      }
      if (terminalRmsText) {
        terminalRmsText.innerText = `${rms.toFixed(4)} RMS ${vadSpeaking ? '🎙️ (Speaking)' : '(Listening)'}`;
      }
      if (rms > 0.002) {
        audioPulse.classList.add('active');
      } else if (!vadSpeaking) {
        audioPulse.classList.remove('active');
      }

      if (isContinuous) {
        if (rms > VAD_ENERGY_THRESHOLD) {
          if (!vadSpeaking) {
            vadSpeaking = true;
            vadSilenceStart = 0;
            recordedChunks = [];
            lastSpeechStartTimestamp = Date.now();
            console.log('[VAD] Speech started! RMS:', rms.toFixed(4));
            setLiveStatus('🎙️ Voice detected (Listening...)', true);
            if (terminalMicState) {
              terminalMicState.innerText = '🔴 Recording Turn...';
              terminalMicState.style.color = '#e74c3c';
            }
            addTerminalLog(`Speech detected (RMS: ${rms.toFixed(4)}) - Buffering turn...`, 'stt');
            addMessageBubble('ambient', '🎤 Listening...');
          } else {
            vadSilenceStart = 0;
          }
          recordedChunks.push(pcm16);
        } else if (vadSpeaking) {
          recordedChunks.push(pcm16);
          if (vadSilenceStart === 0) {
            vadSilenceStart = Date.now();
          } else if (Date.now() - vadSilenceStart > VAD_SILENCE_TIMEOUT_MS) {
            console.log('[VAD] Speech pause detected');
            vadSpeaking = false;
            vadSilenceStart = 0;
            if (terminalMicState) {
              terminalMicState.innerText = '⚡ Processing Turn...';
              terminalMicState.style.color = '#f1c40f';
            }
            addTerminalLog('Speech pause detected -> Dispatched audio turn to STT & Translation Pipeline', 'stt');
            dispatchContinuousUtterance('ambient');
          }
        }
      } else {
        recordedChunks.push(pcm16);
      }
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    isRecording = true;
    if (terminalMicState) {
      terminalMicState.innerText = isContinuous ? '🎙️ Ambient Live' : '🎙️ Mic Active';
      terminalMicState.style.color = '#2ecc71';
    }

    if (!isContinuous) {
      const activeBtn = currentSpeakerRole === 'cast-member' ? castMemberMicBtn : guestMicBtn;
      activeBtn.classList.add('recording');
      lastSpeechStartTimestamp = Date.now();
      const isCastMember = currentSpeakerRole === 'cast-member';
      setLiveStatus(`Listening to ${isCastMember ? 'Cast Member (English)' : 'Guest (Spanish)'}...`, true);
      addMessageBubble(currentSpeakerRole, "🎤 Speaking...");
    }
  } catch (err) {
    console.error('Microphone error:', err);
    alert('Please allow microphone access to test live speech translation.');
  }
}

function dispatchContinuousUtterance(role = currentSpeakerRole) {
  if (recordedChunks.length === 0) return;
  setLiveStatus('⚡ Transcribing & Translating...', true);
  
  let totalLength = 0;
  for (const chunk of recordedChunks) totalLength += chunk.length;
  if (totalLength < 2400) {
    recordedChunks = [];
    return;
  }

  const mergedPcm = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of recordedChunks) {
    mergedPcm.set(chunk, offset);
    offset += chunk.length;
  }
  recordedChunks = [];

  const base64Pcm = arrayBufferToBase64(mergedPcm.buffer);
  const selectedModel = sttModelSelect ? sttModelSelect.value : 'chirp_3';
  if (terminalSttText) {
    terminalSttText.innerText = '⏳ Transcribing audio turn...';
    terminalSttMeta.innerText = selectedModel;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    const [srcLang, tgtLang] = getLangPair();
    const isGuest = role === 'guest';
    
    socket.send(JSON.stringify({
      type: 'audio',
      pcm: base64Pcm,
      sampleRate: 16000,
      speakerRole: role,
      sourceLang: isGuest ? tgtLang : srcLang,
      targetLang: isGuest ? srcLang : tgtLang,
      sttModel: selectedModel,
      useGlossary: true,
      useDlp: dlpMasterEnabled,
      dlpInfoTypes: Array.from(activeDlpInfoTypes)
    }));
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  vadSpeaking = false;
  vadSilenceStart = 0;

  castMemberMicBtn.classList.remove('recording');
  guestMicBtn.classList.remove('recording');

  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }

  if (!isContinuous && recordedChunks.length > 0) {
    setLiveStatus('Transcribing...', true);
    dispatchContinuousUtterance(currentSpeakerRole);
  } else if (!isContinuous) {
    setLiveStatus('Processing...', true);
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

// Sequential FIFO Audio Playback Queue to prevent speech overlap
let audioPlaybackQueue = [];
let isPlayingAudio = false;
let isSpeakingSelf = false;

function playPcmChunk(base64Data, sampleRate = 24000) {
  audioPlaybackQueue.push({ base64Data, sampleRate });
  if (!isPlayingAudio) {
    processNextAudioInQueue();
  }
}

function processNextAudioInQueue() {
  if (audioPlaybackQueue.length === 0) {
    isPlayingAudio = false;
    setTimeout(() => {
      isSpeakingSelf = false;
      if (isContinuous) {
        setLiveStatus('🎙️ Ambient Mic Active (Listening...)', true);
      }
    }, 350);
    return;
  }

  isPlayingAudio = true;
  isSpeakingSelf = true;
  const { base64Data, sampleRate } = audioPlaybackQueue.shift();

  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
  }
  if (playbackContext.state === 'suspended') {
    playbackContext.resume();
  }

  try {
    const binaryString = window.atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    const audioBuffer = playbackContext.createBuffer(1, float32Array.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32Array);

    const sourceNode = playbackContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(playbackContext.destination);

    sourceNode.onended = () => {
      processNextAudioInQueue();
    };

    sourceNode.start();
  } catch (err) {
    console.error('[Audio Queue] Playback error:', err);
    processNextAudioInQueue();
  }
}

// Dialogue UI Feed
function addMessageBubble(role, originalText) {
  const welcome = chatFeed.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${role}`;
  
  const roleLabel = role === 'cast-member' 
    ? '🇺🇸 Cast Member (English)' 
    : (role === 'guest' 
        ? '🌐 Guest (Spanish)' 
        : '🎙️ Live 2-Way Ambient');
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  bubble.innerHTML = `
    <div class="message-meta">
      <span>${roleLabel}</span>
      <span class="bubble-time">${timeStr}</span>
    </div>
    <div class="message-text">${originalText}</div>
    <div class="message-translated">🔄 Translating...</div>
  `;

  chatFeed.appendChild(bubble);
  chatFeed.scrollTop = chatFeed.scrollHeight;
  currentMessageBubble = bubble;

  // Add turn entry into conversation tracking
  bubble._turnData = {
    role,
    roleLabel,
    originalText,
    translatedText: '',
    time: timeStr,
    timestamp: Date.now()
  };
  liveConversationTurns.push(bubble._turnData);
}

function updateSpeakerOriginalText(transcript, sttMs, sttModel, role = 'cast-member', dlpApplied = false) {
  if (!currentMessageBubble) return;
  const textEl = currentMessageBubble.querySelector('.message-text');
  const metaEl = currentMessageBubble.querySelector('.message-meta span:first-child');
  
  if (metaEl && role) {
    metaEl.innerText = role === 'cast-member' ? '🇺🇸 Cast Member (English)' : '🌐 Guest (Spanish)';
    currentMessageBubble.className = `message-bubble ${role}`;
  }

  if (textEl) {
    const latencyBadge = sttMs ? ` <span class="badge-mini">⚡ STT: ${Math.round(sttMs)}ms</span>` : '';
    const dlpBadge = dlpApplied ? ` <span class="badge-mini badge-dlp">🛡️ DLP Redacted</span>` : '';
    textEl.innerHTML = `"${transcript}"${latencyBadge}${dlpBadge}`;
  }

  if (currentMessageBubble._turnData) {
    currentMessageBubble._turnData.originalText = transcript;
    currentMessageBubble._turnData.role = role;
    currentMessageBubble._turnData.sttMs = sttMs;
    currentMessageBubble._turnData.sttModel = sttModel;
    currentMessageBubble._turnData.dlpApplied = dlpApplied;
  }

  chatFeed.scrollTop = chatFeed.scrollHeight;
}

function updateMessageTranslation(translatedText, glossaryApplied, transMs) {
  if (!currentMessageBubble) return;
  const transEl = currentMessageBubble.querySelector('.message-translated');
  if (transEl) {
    const glossaryBadge = glossaryApplied ? ' <span class="badge-mini badge-glossary">🔒 Brand Glossary Applied</span>' : '';
    const latencyBadge = transMs ? ` <span class="badge-mini">⏱️ ${Math.round(transMs)}ms</span>` : '';
    transEl.innerHTML = `✨ ${translatedText}${glossaryBadge}${latencyBadge}`;
  }

  if (currentMessageBubble._turnData) {
    currentMessageBubble._turnData.translatedText = translatedText;
    currentMessageBubble._turnData.glossaryApplied = glossaryApplied;
    currentMessageBubble._turnData.transMs = transMs;
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

    uploadStatusBox.style.display = 'flex';
    uploadStatusText.innerText = 'Decoding audio file and converting to 16kHz PCM...';
    processUploadBtn.disabled = true;
    if (uploadResultsCard) uploadResultsCard.style.display = 'none';

    try {
      // 1. Decode audio in browser to 16kHz Mono Int16 PCM
      const arrayBuf = await selectedUploadFile.arrayBuffer();
      const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuf = await tempCtx.decodeAudioData(arrayBuf);
      
      uploadStatusText.innerText = 'Resampling to 16kHz mono PCM for Chirp 3 STT...';
      const pcm16 = resampleAudioBufferTo16kPcm(audioBuf);
      const base64Audio = arrayBufferToBase64(pcm16.buffer);

      uploadStatusText.innerText = 'Sending to Speech-to-Text (Chirp 3) & Translation Pipeline...';

      const langPair = document.getElementById('uploadLangPair').value;
      const [sourceLang, targetLang] = langPair.split('-');
      const sttModel = document.getElementById('uploadSttModel').value;
      const useGlossary = document.getElementById('uploadUseGlossary').checked;
      const useDlp = document.getElementById('uploadUseDlp').checked;

      const payload = {
        audio_base64: base64Audio,
        source_lang: sourceLang,
        target_lang: targetLang,
        stt_model: sttModel,
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
        throw new Error(`Pipeline returned HTTP ${res.status}`);
      }

      const data = await res.json();
      currentUploadResult = {
        file_name: selectedUploadFile.name,
        source_lang: sourceLang,
        target_lang: targetLang,
        original_transcript: (data.stt && data.stt.transcript) || '',
        sanitized_transcript: (data.dlp && data.dlp.sanitized_text) || (data.stt && data.stt.transcript) || '',
        translated_text: (data.translation && data.translation.translated_text) || '',
        audio_base64: (data.tts && data.tts.audio_base64) || '',
        stt_ms: data.stt ? data.stt.latency_ms : 0,
        dlp_ms: data.dlp ? data.dlp.latency_ms : 0,
        translation_ms: data.translation ? data.translation.latency_ms : 0,
        tts_ms: data.tts ? data.tts.latency_ms : 0,
        total_latency_ms: data.total_latency_ms || 0,
        dlp_findings: (data.dlp && data.dlp.findings) || []
      };

      // Display results
      renderUploadResults(currentUploadResult);
      uploadStatusBox.style.display = 'none';
      processUploadBtn.disabled = false;
      addTerminalLog(`[Recorded Upload] Processed "${selectedUploadFile.name}": "${currentUploadResult.original_transcript}" ➔ "${currentUploadResult.translated_text}"`, 'mt');
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
      const turns = [{
        role: 'speaker',
        roleLabel: `Original Audio (${currentUploadResult.source_lang.toUpperCase()})`,
        originalText: currentUploadResult.original_transcript,
        translatedText: currentUploadResult.translated_text,
        time: new Date().toLocaleTimeString(),
        timestamp: Date.now()
      }];
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
  if (sttLat) sttLat.innerText = `${Math.round(result.stt_ms)} ms`;
  if (mtLat) mtLat.innerText = `${Math.round(result.translation_ms + result.tts_ms)} ms`;

  if (dlpMeta) {
    if (result.dlp_findings && result.dlp_findings.length > 0) {
      dlpMeta.innerHTML = `<span style="color:#ff8a80">⚠️ Cloud DLP Redacted:</span> ${result.dlp_findings.map(f => f.displayName || f.infoType).join(', ')}`;
    } else {
      dlpMeta.innerText = '🛡️ Cloud DLP: Clean (No PII detected)';
    }
  }

  if (player && result.audio_base64) {
    const wavBlob = pcm16Base64ToWavBlob(result.audio_base64, 24000);
    player.src = URL.createObjectURL(wavBlob);
    player.load();
  }
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
      modal.style.display = 'none';
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
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
    const langFlag = conv.targetLang === 'es' ? '🇲🇽' : '🌐';

    card.innerHTML = `
      <div class="conv-card-left">
        <div class="conv-card-title-row">
          <span class="conv-title">${escapeHtml(conv.title)}</span>
          <span class="conv-mode-badge ${conv.mode}">${isLive ? 'Live Stream' : 'Recorded Upload'}</span>
        </div>
        <div class="conv-meta">
          <span>📅 ${dateFormatted}</span>
          <span>💬 ${conv.turnCount || 1} Turn(s)</span>
          <span>${conv.sourceLang.toUpperCase()} ➔ ${langFlag} ${conv.targetLang.toUpperCase()}</span>
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

async function openConversationDetails(convId) {
  const modal = document.getElementById('conversationModal');
  const titleEl = document.getElementById('modalConvTitle');
  const dateEl = document.getElementById('modalConvDate');
  const container = document.getElementById('modalTurnsContainer');
  const downloadTransBtn = document.getElementById('modalDownloadTranscriptBtn');
  const downloadAudioBtn = document.getElementById('modalDownloadAudioBtn');
  const deleteBtn = document.getElementById('modalDeleteConvBtn');

  if (!modal) return;
  modal.style.display = 'flex';
  container.innerHTML = '<div style="padding:20px; text-align:center; color:#94a3b8;">Loading conversation...</div>';

  try {
    const res = await fetch(`/api/conversations/${convId}`);
    if (!res.ok) throw new Error('Not found');
    const conv = await res.json();

    titleEl.innerText = conv.title || 'Conversation Details';
    dateEl.innerText = `Recorded: ${new Date(conv.createdAt).toLocaleString()}`;

    // Render turns
    container.innerHTML = '';
    const turns = conv.turns || [];
    if (turns.length === 0) {
      container.innerHTML = '<div style="color:#94a3b8; padding: 10px;">No dialogue turns saved.</div>';
    } else {
      turns.forEach((turn, idx) => {
        const turnCard = document.createElement('div');
        turnCard.className = 'modal-turn-card';
        turnCard.innerHTML = `
          <div class="modal-turn-header">
            <span><strong>Turn ${idx + 1}</strong> • ${escapeHtml(turn.roleLabel || turn.role || 'Speaker')}</span>
            <span>${turn.time || ''}</span>
          </div>
          <div class="modal-turn-original">
            <strong>Original:</strong> "${escapeHtml(turn.originalText || '')}"
          </div>
          <div class="modal-turn-translated">
            <strong>Translated:</strong> "${escapeHtml(turn.translatedText || '')}"
          </div>
        `;
        container.appendChild(turnCard);
      });
    }

    // Modal action buttons
    downloadTransBtn.onclick = () => {
      downloadTranscriptFile(turns, `${conv.title.replace(/[^a-z0-9_-]/gi, '_')}_transcript`);
    };

    downloadAudioBtn.onclick = () => {
      // Gather audio chunks
      const pcmList = [];
      if (conv.metadata && conv.metadata.synthesizedPcmChunks) {
        pcmList.push(...conv.metadata.synthesizedPcmChunks);
      }
      turns.forEach(t => {
        if (t.audioBase64) pcmList.push({ pcmBase64: t.audioBase64, sampleRate: 24000 });
      });

      if (pcmList.length === 0) {
        alert('No synthesized audio chunks were saved with this conversation.');
        return;
      }
      downloadSynthesizedAudio(pcmList, `${conv.title.replace(/[^a-z0-9_-]/gi, '_')}_audio.wav`);
    };

    deleteBtn.onclick = async () => {
      if (confirm(`Are you sure you want to delete "${conv.title}"?`)) {
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

  const payload = {
    title: title.trim(),
    sourceLang: src,
    targetLang: tgt,
    mode: 'live',
    turns: liveConversationTurns,
    metadata: {
      totalTurns: liveConversationTurns.length,
      synthesizedPcmChunks: liveSynthesizedPcmChunks
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
      addTerminalLog(`Saved live conversation: "${title}" (${liveConversationTurns.length} turns).`, 'system');
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

  const turns = [{
    role: 'recorded-file',
    roleLabel: `Uploaded Audio (${currentUploadResult.file_name})`,
    originalText: currentUploadResult.original_transcript,
    translatedText: currentUploadResult.translated_text,
    audioBase64: currentUploadResult.audio_base64,
    time: new Date().toLocaleTimeString(),
    timestamp: Date.now()
  }];

  const payload = {
    title: title.trim(),
    sourceLang: currentUploadResult.source_lang,
    targetLang: currentUploadResult.target_lang,
    mode: 'recorded-upload',
    turns,
    metadata: {
      fileName: currentUploadResult.file_name,
      totalLatencyMs: currentUploadResult.total_latency_ms
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
