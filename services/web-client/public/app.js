// Disney Parks 2-Way Live Translation Client
let currentMode = 'gemini-live'; // 'gemini-live' | 'translation-pipeline'
let currentSpeakerRole = 'cast-member'; // 'cast-member' | 'guest'
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

// DOM Elements
const connectionStatus = document.getElementById('connectionStatus');
const statusLabel = connectionStatus.querySelector('.status-label');
const tabButtons = document.querySelectorAll('.tab-btn');
const langPairSelect = document.getElementById('langPair');
const personaVoiceSelect = document.getElementById('personaVoice');
const continuousStreamToggle = document.getElementById('continuousStreamToggle');
const streamModeHint = document.getElementById('streamModeHint');
const castMemberMicBtn = document.getElementById('castMemberMicBtn');
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
const transLatencyVal = document.getElementById('transLatencyValue');
const ttsLatencyVal = document.getElementById('ttsLatencyValue');
const engineBadge = document.getElementById('engineBadge');
const textInput = document.getElementById('textInput');
const sendTextBtn = document.getElementById('sendTextBtn');
const glossaryGrid = document.getElementById('glossaryGrid');
const glossarySearch = document.getElementById('glossarySearch');

// Initialize
async function init() {
  setupTabs();
  setupControls();
  setupGlossary();
  setupQuickScenarios();
  await connectWebSocket();
}

// Mode / Tab Switching
function setupTabs() {
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (mode === 'glossary') {
        document.getElementById('translationSection').classList.remove('active');
        document.getElementById('glossarySection').classList.add('active');
      } else {
        currentMode = mode;
        document.getElementById('glossarySection').classList.remove('active');
        document.getElementById('translationSection').classList.add('active');
        
        if (mode === 'gemini-live') {
          if (sttLatencyVal) sttLatencyVal.innerText = 'N/A';
          if (transLatencyVal) transLatencyVal.innerText = 'Direct';
          if (ttsLatencyVal) ttsLatencyVal.innerText = 'S2S';
          latencySub.innerText = 'Native S2S Latency';
        } else {
          if (sttLatencyVal) sttLatencyVal.innerText = '--';
          if (transLatencyVal) transLatencyVal.innerText = '--';
          if (ttsLatencyVal) ttsLatencyVal.innerText = '--';
          latencySub.innerText = 'Total Pipeline Latency';
        }
        reconnectWebSocket();
      }
    });
  });
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
        <p>Chat cleared. Ready for live Disney translation.</p>
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

async function startContinuousStream() {
  isContinuous = true;
  continuousStreamToggle.checked = true;
  streamModeHint.innerText = '🔴 Continuous 2-Way Stream (Live Hands-Free)';
  streamModeHint.classList.add('stream-active');
  castMemberMicBtn.classList.add('ambient-active');
  guestMicBtn.classList.add('ambient-active');
  castMemberMicBtn.querySelector('.mic-sub').innerText = '🎙️ Live Ambient Mic';
  guestMicBtn.querySelector('.mic-sub').innerText = '🎙️ Live Ambient Mic';

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
  castMemberMicBtn.querySelector('.mic-sub').innerText = 'Hold to speak 🇺🇸';
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
      // If clicked while continuous is active, toggle continuous off
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
        setLiveStatus('Translating scenario...', true);
        
        if (currentMode === 'gemini-live') {
          socket.send(JSON.stringify({ type: 'text', text }));
        } else {
          // Translation pipeline via WebSocket
          const [src, tgt] = langPairSelect.value.split('-');
          socket.send(JSON.stringify({
            type: 'text',
            text,
            sourceLang: lang === 'en' ? src : tgt,
            targetLang: lang === 'en' ? tgt : src
          }));
        }
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
    setLiveStatus('Translating...', true);
    socket.send(JSON.stringify({ type: 'text', text }));
  }
}

// WebSocket Connection
async function connectWebSocket() {
  updateStatus('connecting', 'Connecting...');
  
  const [srcLang, tgtLang] = langPairSelect.value.split('-');
  const voice = personaVoiceSelect.value;
  
  let wsUrl = '';
  const host = window.location.hostname;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  
  if (currentMode === 'gemini-live') {
    // If port is 3000 in local dev, proxy is on 8090. On Cloud Run, URL is same host.
    const port = window.location.port === '3000' ? '8090' : window.location.port;
    wsUrl = `${protocol}//${host}${port ? ':' + port : ''}/live-translate?sourceLang=${srcLang}&targetLang=${tgtLang}&voice=${voice}`;
  } else {
    const port = window.location.port === '3000' ? '8092' : window.location.port;
    wsUrl = `${protocol}//${host}${port ? ':' + port : ''}/ws/stream-translate`;
  }

  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log(`[WS] Connected to ${currentMode}`);
      updateStatus('connected', 'Live & Ready');
      setLiveStatus('Ready');
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'ready') {
        console.log('[WS] Session ready:', data);
        setLiveStatus('Interpreter Ready');
        updateStatus('connected', 'Live & Ready');
      } else if (data.type === 'stt_transcript') {
        // Live STT Captured Output from Gemini 3.5 Transcribe
        console.log('[WS] Live STT Transcript:', data);
        updateSpeakerOriginalText(data.transcript, data.stt_ms, data.stt_model);
        if (sttLatencyVal && data.stt_ms !== undefined) {
          sttLatencyVal.innerText = Math.round(data.stt_ms);
        }
        setLiveStatus('Translating with Translation LLM...', true);
      } else if (data.type === 'translation_text') {
        // Live Translation Text from general/translation-llm
        console.log('[WS] Live Translation Text:', data);
        updateMessageTranslation(data.translated_text, data.glossary_applied, data.translation_ms);
        if (transLatencyVal && data.translation_ms !== undefined) {
          transLatencyVal.innerText = Math.round(data.translation_ms);
        }
        setLiveStatus('Generating Neural Speech...', true);
      } else if (data.type === 'audio' && data.pcm) {
        if (data.total_latency_ms && data.total_latency_ms > 0) {
          latencyValue.innerText = Math.round(data.total_latency_ms);
        } else if (data.latencyMs && data.latencyMs > 0) {
          latencyValue.innerText = Math.round(data.latencyMs);
        } else if (lastSpeechStartTimestamp > 0) {
          latencyValue.innerText = Math.round(Date.now() - lastSpeechStartTimestamp);
        }

        if (data.latency_breakdown) {
          if (sttLatencyVal && data.latency_breakdown.stt_ms !== undefined) {
            sttLatencyVal.innerText = Math.round(data.latency_breakdown.stt_ms);
          }
          if (transLatencyVal && data.latency_breakdown.translation_ms !== undefined) {
            transLatencyVal.innerText = Math.round(data.latency_breakdown.translation_ms);
          }
          if (ttsLatencyVal && data.latency_breakdown.tts_ms !== undefined) {
            ttsLatencyVal.innerText = Math.round(data.latency_breakdown.tts_ms);
          }
        }

        setLiveStatus('Playing Translation...', true);
        playPcmChunk(data.pcm, data.sampleRate || 24000);
      } else if (data.type === 'transcript' && data.text) {
        updateMessageTranslation(data.text);
      } else if (data.type === 'no_speech') {
        setLiveStatus('Ready', false);
        if (currentMessageBubble) {
          const textEl = currentMessageBubble.querySelector('.message-text');
          if (textEl && textEl.innerText.includes('Speaking')) {
            textEl.innerText = '(No speech captured - please try speaking closer to mic)';
          }
          const transEl = currentMessageBubble.querySelector('.message-translated');
          if (transEl) transEl.innerText = '';
        }
      } else if (data.type === 'turn_complete') {
        if (isContinuous) {
          setLiveStatus('🎙️ Ambient Mic Active (Listening...)', true);
          currentMessageBubble = null;
        } else {
          setLiveStatus('Ready', false);
        }
      } else if (data.type === 'interrupted') {
        console.log('[WS] Interrupted by speaker');
        setLiveStatus('Interrupted (Listening...)', true);
        currentMessageBubble = null;
      } else if (data.type === 'error') {
        console.error('[WS] Server error:', data.message);
        setLiveStatus(`Error: ${data.message}`, false);
        updateStatus('disconnected', 'Service Error');
      } else if (data.success && data.translated_text) {
        // Translation Pipeline Full Response
        latencyValue.innerText = Math.round(data.total_latency_ms || 0);
        if (data.source_transcript) {
          updateSpeakerOriginalText(data.source_transcript, data.latency_breakdown?.stt_ms);
        }
        updateMessageTranslation(data.translated_text, data.glossary_applied, data.latency_breakdown?.translation_ms);

        if (data.latency_breakdown) {
          if (sttLatencyVal) sttLatencyVal.innerText = Math.round(data.latency_breakdown.stt_ms || 0);
          if (transLatencyVal) transLatencyVal.innerText = Math.round(data.latency_breakdown.translation_ms || 0);
          if (ttsLatencyVal) ttsLatencyVal.innerText = Math.round(data.latency_breakdown.tts_ms || 0);
        }

        if (data.audio_base64) {
          setLiveStatus('Playing Speech...', true);
          playPcmChunk(data.audio_base64, 24000);
        }
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

let recordedChunks = [];

// Audio Recording (Capture 16kHz PCM)
async function startRecording() {
  if (isRecording) return;
  recordedChunks = [];
  
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const source = audioContext.createMediaStreamSource(micStream);
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

    scriptProcessor.onaudioprocess = (e) => {
      if (!isRecording) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = convertFloat32ToInt16(inputData);

      if (currentMode === 'gemini-live') {
        const base64Pcm = arrayBufferToBase64(pcm16.buffer);
        if (socket && socket.readyState === WebSocket.OPEN) {
          const [srcLang, tgtLang] = langPairSelect.value.split('-');
          socket.send(JSON.stringify({
            type: 'audio',
            pcm: base64Pcm,
            sampleRate: 16000,
            speakerRole: currentSpeakerRole,
            sourceLang: currentSpeakerRole === 'cast-member' ? srcLang : tgtLang,
            targetLang: currentSpeakerRole === 'cast-member' ? tgtLang : srcLang
          }));
        }
      } else {
        // Buffer audio for Gemini 3.5 Transcribe STT
        recordedChunks.push(pcm16);
      }
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    isRecording = true;
    const activeBtn = currentSpeakerRole === 'cast-member' ? castMemberMicBtn : guestMicBtn;
    activeBtn.classList.add('recording');
    
    lastSpeechStartTimestamp = Date.now();
    setLiveStatus(`Listening to ${currentSpeakerRole === 'cast-member' ? 'Cast Member' : 'Guest'}...`, true);
    addMessageBubble(currentSpeakerRole, "🎤 Speaking...");
  } catch (err) {
    console.error('Microphone error:', err);
    alert('Please allow microphone access to test live speech translation.');
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

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

  if (currentMode === 'translation-pipeline' && recordedChunks.length > 0) {
    setLiveStatus('Transcribing with Gemini 3.5 Transcribe...', true);
    let totalLength = 0;
    for (const chunk of recordedChunks) totalLength += chunk.length;
    const mergedPcm = new Int16Array(totalLength);
    let offset = 0;
    for (const chunk of recordedChunks) {
      mergedPcm.set(chunk, offset);
      offset += chunk.length;
    }
    recordedChunks = [];

    const base64Pcm = arrayBufferToBase64(mergedPcm.buffer);
    if (socket && socket.readyState === WebSocket.OPEN) {
      const [srcLang, tgtLang] = langPairSelect.value.split('-');
      socket.send(JSON.stringify({
        type: 'audio',
        pcm: base64Pcm,
        sampleRate: 16000,
        speakerRole: currentSpeakerRole,
        sourceLang: currentSpeakerRole === 'cast-member' ? srcLang : tgtLang,
        targetLang: currentSpeakerRole === 'cast-member' ? tgtLang : srcLang,
        useGlossary: true
      }));
    }
  } else {
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

// Audio Playback (PCM 24kHz)
function playPcmChunk(base64Data, sampleRate = 24000) {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
  }

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
  sourceNode.start();
}

// Dialogue UI Feed
function addMessageBubble(role, originalText) {
  const welcome = chatFeed.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${role}`;
  
  const roleLabel = role === 'cast-member' ? '🇺🇸 Cast Member' : '🌐 Guest';
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

function updateSpeakerOriginalText(transcript, sttMs, sttModel) {
  if (!currentMessageBubble) return;
  const textEl = currentMessageBubble.querySelector('.message-text');
  if (textEl) {
    const modelBadge = sttModel ? ` <span class="badge-mini">⚡ ${sttModel} (${Math.round(sttMs || 0)}ms)</span>` : (sttMs ? ` <span class="badge-mini">⚡ STT: ${Math.round(sttMs)}ms</span>` : '');
    textEl.innerHTML = `"${transcript}"${modelBadge}`;
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

// Glossary Setup
async function setupGlossary() {
  try {
    const res = await fetch('/api/glossary');
    const data = await res.json();
    glossaryData = data.terms || [];
    renderGlossary(glossaryData);
  } catch (e) {
    console.warn('Could not fetch glossary from API, using defaults');
  }

  glossarySearch.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const filtered = glossaryData.filter(t => 
      t.en.toLowerCase().includes(query) || 
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
        <span class="term-category">${t.category}</span>
      </div>
      <div class="term-target">➔ ${es}</div>
      <div class="term-notes">${t.keep_original ? '🔒 Preserve English Brand' : '🔄 Standard Translation'} • ${t.notes || ''}</div>
    `;
    glossaryGrid.appendChild(card);
  });
}

window.addEventListener('DOMContentLoaded', init);
