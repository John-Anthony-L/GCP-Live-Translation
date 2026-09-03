// Disney Parks 2-Way Live Translation Client (Powered by Gemini 3.5 Transcribe + Cloud DLP + MT v3 + TTS)
let currentMode = 'translation-pipeline'; // 'translation-pipeline' | 'dlp' | 'glossary'
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

// DLP State
let dlpMasterEnabled = true;
let dlpCatalog = [];
let activeDlpInfoTypes = new Set([
  "CREDIT_CARD_NUMBER",
  "PHONE_NUMBER",
  "EMAIL_ADDRESS",
  "US_PASSPORT",
  "DISNEY_RESERVATION_ID",
  "MAGICBAND_UID",
  "DISNEY_PIN"
]);

// DOM Elements
const connectionStatus = document.getElementById('connectionStatus');
const statusLabel = connectionStatus.querySelector('.status-label');
const tabButtons = document.querySelectorAll('.tab-btn');
const langPairSelect = document.getElementById('langPair');
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

  document.getElementById('translationSection').classList.remove('active');
  document.getElementById('dlpSection').classList.remove('active');
  document.getElementById('glossarySection').classList.remove('active');

  if (mode === 'glossary') {
    document.getElementById('glossarySection').classList.add('active');
  } else if (mode === 'dlp') {
    document.getElementById('dlpSection').classList.add('active');
  } else {
    document.getElementById('translationSection').classList.add('active');
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

  personaVoiceSelect.addEventListener('change', () => {
    reconnectWebSocket();
  });

  clearChatBtn.addEventListener('click', () => {
    chatFeed.innerHTML = `
      <div class="chat-welcome">
        <span class="sparkle-icon">✨</span>
        <p>Chat cleared. Ready for live Disney translation with Cloud DLP protection.</p>
      </div>
    `;
    currentMessageBubble = null;
  });

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
      { name: "EMAIL_ADDRESS", displayName: "Email Addresses", category: "Contact Info", icon: "📧", description: "Guest and Cast Member personal/work email addresses", placeholder: "[EMAIL_REDACTED]", defaultEnabled: true },
      { name: "PERSON_NAME", displayName: "Guest / Minor Names (COPPA)", category: "Children & PII Privacy", icon: "👶", description: "Full names of guests, minors, and family members", placeholder: "[GUEST_NAME_REDACTED]", defaultEnabled: false },
      { name: "US_PASSPORT", displayName: "Passports & Gov IDs", category: "Government ID", icon: "🛂", description: "Passport numbers, driver licenses, national ID numbers", placeholder: "[PASSPORT_REDACTED]", defaultEnabled: true },
      { name: "DISNEY_RESERVATION_ID", displayName: "Disney Reservation IDs", category: "Disney Brand Custom", icon: "🏰", description: "WDW/DLR hotel, dining, and park reservation numbers (e.g. WDW-982341)", placeholder: "[DISNEY_RESERVATION_REDACTED]", defaultEnabled: true, isCustom: true },
      { name: "MAGICBAND_UID", displayName: "MagicBand+ Hardware UID", category: "Disney Brand Custom", icon: "🪄", description: "MagicBand+ RFID / NFC serial numbers (e.g. MB-A1B2C3D4)", placeholder: "[MAGICBAND_UID_REDACTED]", defaultEnabled: true, isCustom: true },
      { name: "DISNEY_PIN", displayName: "Disney Account & Resort PINs", category: "Disney Brand Custom", icon: "🔑", description: "4-to-6 digit security PINs used for MyDisneyExperience & room charging", placeholder: "[PIN_REDACTED]", defaultEnabled: true, isCustom: true }
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
  const [src, tgt] = langPairSelect.value.split('-');
  const langNames = {
    es: { name: 'Spanish', flag: '🇪🇸' },
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
        
        const [src, tgt] = langPairSelect.value.split('-');
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
    const [src, tgt] = langPairSelect.value.split('-');
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
        if (terminalSttText) {
          terminalSttText.innerText = data.transcript ? `"${data.transcript}"` : '(No speech detected)';
          terminalSttMeta.innerText = `${data.detectedLang || 'en-US'} • ${Math.round(data.stt_ms || 0)}ms`;
        }
        if (data.transcript) {
          addTerminalLog(`STT Captured: "${data.transcript}" (${data.detectedLang || 'en-US'}, ${Math.round(data.stt_ms || 0)}ms)`, 'stt');
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
          terminalMtMeta.innerText = `${data.glossary_applied ? '🏰 Glossary Enforced' : 'Direct LLM'} • ${Math.round(data.translation_ms || 0)}ms`;
        }
        addTerminalLog(`Translation: "${data.translated_text}" (${data.glossary_applied ? 'Disney Glossary Enforced' : 'Direct LLM'}, ${Math.round(data.translation_ms || 0)}ms)`, 'mt');
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
  if (terminalSttText) {
    terminalSttText.innerText = '⏳ Transcribing audio turn...';
    terminalSttMeta.innerText = 'gemini-3.5-transcribe';
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    const [srcLang, tgtLang] = langPairSelect.value.split('-');
    const isGuest = role === 'guest';
    
    socket.send(JSON.stringify({
      type: 'audio',
      pcm: base64Pcm,
      sampleRate: 16000,
      speakerRole: role,
      sourceLang: isGuest ? tgtLang : srcLang,
      targetLang: isGuest ? srcLang : tgtLang,
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
  bubble.innerHTML = `
    <div class="message-meta">
      <span>${roleLabel}</span>
      <span class="bubble-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
    </div>
    <div class="message-text">${originalText}</div>
    <div class="message-translated">🔄 Translating...</div>
  `;

  chatFeed.appendChild(bubble);
  chatFeed.scrollTop = chatFeed.scrollHeight;
  currentMessageBubble = bubble;
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
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

function updateMessageTranslation(translatedText, glossaryApplied, transMs) {
  if (!currentMessageBubble) return;
  const transEl = currentMessageBubble.querySelector('.message-translated');
  if (transEl) {
    const glossaryBadge = glossaryApplied ? ' <span class="badge-mini badge-glossary">🔒 Disney Glossary Applied</span>' : '';
    const latencyBadge = transMs ? ` <span class="badge-mini">⏱️ ${Math.round(transMs)}ms</span>` : '';
    transEl.innerHTML = `✨ ${translatedText}${glossaryBadge}${latencyBadge}`;
  }
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

// Disney Protected Brand Glossary Setup
async function setupGlossary() {
  const fallbackTerms = [
    { term_id: "lightning_lane", en: "Lightning Lane", category: "Service", keep_original: true, translations: { es: "Lightning Lane", pt: "Lightning Lane", fr: "Lightning Lane" }, notes: "Disney express queue service. Do not translate literally." },
    { term_id: "magicband_plus", en: "MagicBand+", category: "Merchandise/Service", keep_original: true, translations: { es: "MagicBand+", pt: "MagicBand+", fr: "MagicBand+" }, notes: "Wearable RFID/Bluetooth park device." },
    { term_id: "cast_member", en: "Cast Member", category: "Personnel", keep_original: false, translations: { es: "Miembro del Elenco", pt: "Membro do Elenco", fr: "Cast Member / Membre de l'équipe" }, notes: "Disney employee title." },
    { term_id: "space_mountain", en: "Space Mountain", category: "Attraction", keep_original: true, translations: { es: "Space Mountain", pt: "Space Mountain" }, notes: "Tomorrowland indoor roller coaster." },
    { term_id: "rise_of_the_resistance", en: "Star Wars: Rise of the Resistance", category: "Attraction", keep_original: true, translations: { es: "Star Wars: Rise of the Resistance" }, notes: "Galaxy's Edge dark ride." },
    { term_id: "haunted_mansion", en: "Haunted Mansion", category: "Attraction", keep_original: true, translations: { es: "Haunted Mansion" }, notes: "Liberty Square / New Orleans Square attraction." },
    { term_id: "rope_drop", en: "Rope Drop", category: "Park Concept", keep_original: false, translations: { es: "Apertura del parque / Entrada a primera hora" }, notes: "Park opening ceremony." },
    { term_id: "photopass", en: "Disney PhotoPass", category: "Service", keep_original: true, translations: { es: "Disney PhotoPass" }, notes: "Professional in-park photography service." },
    { term_id: "rider_switch", en: "Rider Switch", category: "Service", keep_original: false, translations: { es: "Intercambio de Pasajeros / Rider Switch" }, notes: "Child swap service for attractions." },
    { term_id: "single_rider", en: "Single Rider", category: "Queue Concept", keep_original: false, translations: { es: "Fila de Pasajero Individual / Single Rider" }, notes: "Dedicated queue for solo riders." },
    { term_id: "tianas_bayou_adventure", en: "Tiana's Bayou Adventure", category: "Attraction", keep_original: true, translations: { es: "Tiana's Bayou Adventure" }, notes: "Critter Country attraction." },
    { term_id: "big_thunder_mountain", en: "Big Thunder Mountain Railroad", category: "Attraction", keep_original: true, translations: { es: "Big Thunder Mountain Railroad" }, notes: "Frontierland coaster." }
  ];

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

  renderGlossary(glossaryData);

  glossarySearch.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const filtered = glossaryData.filter(t => 
      t.en.toLowerCase().includes(query) || 
      (t.category && t.category.toLowerCase().includes(query)) ||
      (t.translations && Object.values(t.translations).some(v => v.toLowerCase().includes(query)))
    );
    renderGlossary(filtered);
  });
}

function renderGlossary(terms) {
  glossaryGrid.innerHTML = '';
  terms.forEach(t => {
    const card = document.createElement('div');
    card.className = 'glossary-card';
    const es = (t.translations && t.translations.es) || t.en;
    card.innerHTML = `
      <div class="glossary-card-header">
        <span class="term-en">${t.en}</span>
        <span class="term-category">${t.category || 'Disney Term'}</span>
      </div>
      <div class="term-target">➔ ${es}</div>
      <div class="term-notes">${t.keep_original ? '🔒 Preserve English Brand' : '🔄 Contextual Translation'} • ${t.notes || ''}</div>
    `;
    glossaryGrid.appendChild(card);
  });
}

window.addEventListener('DOMContentLoaded', init);
