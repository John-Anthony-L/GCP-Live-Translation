// Disney Live Translation Client Application
let currentMode = 'gemini-live'; // 'gemini-live' | 'translation-pipeline'
let isRecording = false;
let isContinuous = false;
let socket = null;
let audioContext = null;
let micStream = null;
let scriptProcessor = null;
let audioQueue = [];
let isPlayingAudio = false;
let lastSpeechStartTimestamp = 0;
let glossaryData = [];

// DOM Elements
const connectionStatus = document.getElementById('connectionStatus');
const statusLabel = connectionStatus.querySelector('.status-label');
const tabButtons = document.querySelectorAll('.tab-btn');
const viewSections = document.querySelectorAll('.view-section');
const langPairSelect = document.getElementById('langPair');
const personaVoiceSelect = document.getElementById('personaVoice');
const continuousStreamToggle = document.getElementById('continuousStreamToggle');
const streamModeHint = document.getElementById('streamModeHint');
const micButton = document.getElementById('micButton');
const micInstruction = document.getElementById('micInstruction');
const speakerTranscript = document.getElementById('speakerTranscript');
const translatedTranscript = document.getElementById('translatedTranscript');
const latencyValue = document.getElementById('latencyValue');
const latencySub = document.getElementById('latencySub');
const glossaryGrid = document.getElementById('glossaryGrid');
const glossarySearch = document.getElementById('glossarySearch');

// Initialize
async function init() {
  setupTabs();
  setupControls();
  setupGlossary();
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
          latencySub.innerText = 'End-to-End Speech Latency';
          document.getElementById('audioFormat').innerText = '16kHz ➔ 24kHz';
        } else {
          latencySub.innerText = 'STT + MT + TTS Pipeline Latency';
          document.getElementById('audioFormat').innerText = 'STT ➔ TTS Neural2';
        }
        reconnectWebSocket();
      }
    });
  });
}

// Controls
function setupControls() {
  continuousStreamToggle.addEventListener('change', (e) => {
    isContinuous = e.target.checked;
    streamModeHint.innerText = isContinuous ? 'Continuous Streaming (Active)' : 'Push-to-Talk (Hold)';
    micInstruction.innerText = isContinuous ? 'Click to Start / Stop Streaming' : 'Hold to Speak or Click to Start';
  });

  langPairSelect.addEventListener('change', () => {
    reconnectWebSocket();
  });

  personaVoiceSelect.addEventListener('change', () => {
    reconnectWebSocket();
  });

  // Push to talk / Click events
  micButton.addEventListener('mousedown', startSpeaking);
  micButton.addEventListener('mouseup', stopSpeaking);
  micButton.addEventListener('touchstart', (e) => { e.preventDefault(); startSpeaking(); });
  micButton.addEventListener('touchend', (e) => { e.preventDefault(); stopSpeaking(); });

  micButton.addEventListener('click', () => {
    if (isContinuous) {
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    }
  });
}

function startSpeaking() {
  if (isContinuous) return;
  startRecording();
}

function stopSpeaking() {
  if (isContinuous) return;
  stopRecording();
}

// WebSocket Connection
async function connectWebSocket() {
  updateStatus('connecting', 'Connecting...');
  
  const [srcLang, tgtLang] = langPairSelect.value.split('-');
  const voice = personaVoiceSelect.value;
  
  // Default ports based on local or container environment
  let wsUrl = '';
  if (currentMode === 'gemini-live') {
    const host = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // If running on port 3000, proxy is on 8080. In production on Cloud Run, use the configured proxy URL.
    const port = window.location.port === '3000' ? '8080' : window.location.port;
    wsUrl = `${protocol}//${host}${port ? ':' + port : ''}/live-translate?sourceLang=${srcLang}&targetLang=${tgtLang}&voice=${voice}`;
  } else {
    const host = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = window.location.port === '3000' ? '8081' : window.location.port;
    wsUrl = `${protocol}//${host}${port ? ':' + port : ''}/ws/stream-translate`;
  }

  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log(`[WS] Connected to ${currentMode}`);
      updateStatus('connected', 'Live & Ready');
    };

    socket.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'ready') {
        console.log('[WS] Session ready:', data);
      } else if (data.type === 'audio' && data.pcm) {
        if (data.latencyMs && data.latencyMs > 0) {
          latencyValue.innerText = data.latencyMs;
        }
        playPcmChunk(data.pcm, data.sampleRate || 24000);
      } else if (data.type === 'transcript' && data.text) {
        appendTranslation(data.text);
      } else if (data.type === 'turn_complete') {
        console.log('[WS] Turn complete');
      } else if (data.type === 'interrupted') {
        console.log('[WS] Barge-in interrupted');
        clearAudioQueue();
      } else if (data.success && data.translated_text) {
        // Translation Pipeline response format
        latencyValue.innerText = data.total_latency_ms;
        speakerTranscript.innerText = data.source_transcript;
        translatedTranscript.innerText = data.translated_text;
        if (data.audio_base64) {
          playPcmChunk(data.audio_base64, 24000);
        }
      }
    };

    socket.onerror = (err) => {
      console.error('[WS] Error:', err);
      updateStatus('disconnected', 'Connection Error');
    };

    socket.onclose = () => {
      console.log('[WS] Closed');
      updateStatus('disconnected', 'Disconnected');
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

// Audio Recording (Capture 16kHz PCM)
async function startRecording() {
  if (isRecording) return;
  
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
      const base64Pcm = arrayBufferToBase64(pcm16.buffer);

      if (socket && socket.readyState === WebSocket.OPEN) {
        const [srcLang, tgtLang] = langPairSelect.value.split('-');
        socket.send(JSON.stringify({
          type: 'audio',
          pcm: base64Pcm,
          sampleRate: 16000,
          sourceLang: srcLang,
          targetLang: tgtLang
        }));
      }
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    isRecording = true;
    micButton.classList.add('recording');
    lastSpeechStartTimestamp = Date.now();
    speakerTranscript.innerText = "Listening...";
    translatedTranscript.innerText = "...";
  } catch (err) {
    console.error('Microphone access denied or error:', err);
    alert('Please grant microphone access to test live translation.');
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  micButton.classList.remove('recording');

  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
}

// Float32 to Int16 PCM converter
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
let playbackContext = null;

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

function clearAudioQueue() {
  audioQueue = [];
}

function appendTranslation(text) {
  if (translatedTranscript.innerText === '...' || translatedTranscript.innerText.startsWith('Live translation')) {
    translatedTranscript.innerText = text;
  } else {
    translatedTranscript.innerText += text;
  }
}

// Glossary Display
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
