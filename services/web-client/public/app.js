// Disney Parks 2-Way Live Translation Client (Powered by Translation LLM Advanced v3)
let currentMode = 'translation-pipeline'; // 'translation-pipeline' | 'glossary'
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
const VAD_ENERGY_THRESHOLD = 0.0035; // Sensitive voice activity threshold (responsive to normal conversational speech)
const VAD_SILENCE_TIMEOUT_MS = 800; // 800ms silence automatically dispatches speech turn

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
  await setupGlossary();
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
        currentMode = 'translation-pipeline';
        document.getElementById('glossarySection').classList.remove('active');
        document.getElementById('translationSection').classList.add('active');
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
        setLiveStatus('Translating scenario with Translation LLM...', true);
        
        const [src, tgt] = langPairSelect.value.split('-');
        const isCastMember = role === 'cast-member';
        
        socket.send(JSON.stringify({
          type: 'text',
          text,
          speakerRole: role,
          sourceLang: isCastMember ? src : tgt,
          targetLang: isCastMember ? tgt : src,
          useGlossary: true
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
    setLiveStatus('Translating with Translation LLM...', true);
    const [src, tgt] = langPairSelect.value.split('-');
    socket.send(JSON.stringify({
      type: 'text',
      text,
      speakerRole: 'cast-member',
      sourceLang: src,
      targetLang: tgt,
      useGlossary: true
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
    // In local development, use authenticated local proxy on port 8092
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
        // Real-time progressive interim STT as user speaks
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
        console.log('[WS] STT Transcript (Sentence boundary):', data);
        const role = data.speakerRole || currentSpeakerRole;
        if (!currentMessageBubble) {
          addMessageBubble(role, data.transcript);
        }
        updateSpeakerOriginalText(data.transcript, data.stt_ms, data.stt_model, role);
        if (sttLatencyVal && data.stt_ms !== undefined) {
          sttLatencyVal.innerText = Math.round(data.stt_ms);
        }
        setLiveStatus('Translating sentence...', true);
      } else if (data.type === 'translation_text') {
        console.log('[WS] Translation Text:', data);
        updateMessageTranslation(data.translated_text, data.glossary_applied, data.translation_ms);
        if (transLatencyVal && data.translation_ms !== undefined) {
          transLatencyVal.innerText = Math.round(data.translation_ms);
        }
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
          if (transLatencyVal && data.latency_breakdown.translation_ms !== undefined) {
            transLatencyVal.innerText = Math.round(data.latency_breakdown.translation_ms);
          }
          if (ttsLatencyVal && data.latency_breakdown.tts_ms !== undefined) {
            ttsLatencyVal.innerText = Math.round(data.latency_breakdown.tts_ms);
          }
        }

        setLiveStatus('Playing Translation Speech...', true);
        playPcmChunk(data.pcm, data.sampleRate || 24000);
        // In continuous mode, prepare next bubble for subsequent sentences
        if (isContinuous) {
          currentMessageBubble = null;
        }
      } else if (data.type === 'transcript' && data.text) {
        updateMessageTranslation(data.text);
      } else if (data.type === 'no_speech') {
        setLiveStatus(isContinuous ? '🎙️ Ambient Mic Active (Listening...)' : 'Ready', isContinuous);
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
      // If speaker is currently outputting synthesized translation, suppress VAD to avoid acoustic loop
      if (isSpeakingSelf) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = convertFloat32ToInt16(inputData);

      // Compute RMS energy for voice activity detection
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sum / inputData.length);

      if (isContinuous) {
        if (rms > VAD_ENERGY_THRESHOLD) {
          if (!vadSpeaking) {
            vadSpeaking = true;
            vadSilenceStart = 0;
            console.log('[VAD] Speech started! RMS:', rms.toFixed(4));
            setLiveStatus('🎙️ Voice detected (Listening...)', true);
            lastSpeechStartTimestamp = Date.now();
            addMessageBubble('ambient', '🎤 Listening...');
            if (socket && socket.readyState === WebSocket.OPEN) {
              const [srcLang, tgtLang] = langPairSelect.value.split('-');
              socket.send(JSON.stringify({
                type: 'audio_stream_start',
                speakerRole: 'ambient',
                sourceLang: srcLang,
                targetLang: tgtLang,
                useGlossary: true
              }));
            }
          } else {
            vadSilenceStart = 0;
          }
        } else if (vadSpeaking) {
          if (vadSilenceStart === 0) {
            vadSilenceStart = Date.now();
          } else if (Date.now() - vadSilenceStart > VAD_SILENCE_TIMEOUT_MS) {
            console.log('[VAD] Speech pause detected');
            vadSpeaking = false;
            vadSilenceStart = 0;
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                type: 'audio_stream_end'
              }));
            }
          }
        }

        // Stream audio chunk continuously while voice is active (including inter-word pauses)
        if (vadSpeaking && socket && socket.readyState === WebSocket.OPEN) {
          const base64Chunk = arrayBufferToBase64(pcm16.buffer);
          socket.send(JSON.stringify({
            type: 'audio_chunk',
            pcm: base64Chunk,
            speakerRole: 'ambient'
          }));
        }
      } else {
        // Push to talk buffering
        recordedChunks.push(pcm16);
      }
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    isRecording = true;
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
    const isGuest = role === 'guest';
    
    socket.send(JSON.stringify({
      type: 'audio',
      pcm: base64Pcm,
      sampleRate: 16000,
      speakerRole: role,
      sourceLang: isGuest ? tgtLang : srcLang,
      targetLang: isGuest ? srcLang : tgtLang,
      useGlossary: true
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
    // Allow 350ms cooldown before un-muting mic VAD to prevent speaker echo re-triggering
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

function updateSpeakerOriginalText(transcript, sttMs, sttModel, role = 'cast-member') {
  if (!currentMessageBubble) return;
  const textEl = currentMessageBubble.querySelector('.message-text');
  const metaEl = currentMessageBubble.querySelector('.message-meta span:first-child');
  
  if (metaEl && role) {
    metaEl.innerText = role === 'cast-member' ? '🇺🇸 Cast Member (English)' : '🌐 Guest (Spanish)';
    currentMessageBubble.className = `message-bubble ${role}`;
  }

  if (textEl) {
    const latencyBadge = sttMs ? ` <span class="badge-mini">⚡ STT: ${Math.round(sttMs)}ms</span>` : '';
    textEl.innerHTML = `"${transcript}"${latencyBadge}`;
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
