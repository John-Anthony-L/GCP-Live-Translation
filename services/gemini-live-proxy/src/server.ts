import express from 'express';
import { createServer } from 'http';
import WebSocket, { WebSocketServer, RawData } from 'ws';
import { config } from './config.js';
import { loadGlossary, buildSystemInstruction } from './glossary.js';
import { VertexBidiClient } from './vertex_bidi_client.js';

const app = express();
app.use(express.json());

// Enable CORS for local and web client access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check endpoint for Cloud Run
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'gemini-live-proxy',
    projectId: config.projectId,
    location: config.location,
    model: config.model
  });
});

// Glossary API endpoint
app.get('/api/glossary', (req, res) => {
  const glossary = loadGlossary();
  res.json(glossary);
});

// Supported languages endpoint
app.get('/api/languages', (req, res) => {
  res.json({
    supported: [
      { code: 'en', name: 'English (US)' },
      { code: 'es', name: 'Spanish (Latin America)' },
      { code: 'pt', name: 'Portuguese (Brazil)' },
      { code: 'fr', name: 'French' },
      { code: 'ja', name: 'Japanese' },
      { code: 'zh', name: 'Mandarin Chinese' },
      { code: 'de', name: 'German' },
      { code: 'it', name: 'Italian' }
    ]
  });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', async (clientWs: WebSocket, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const sourceLang = url.searchParams.get('sourceLang') || 'en';
  const targetLang = url.searchParams.get('targetLang') || 'es';
  const voice = url.searchParams.get('voice') || config.defaultVoice;
  const modelName = url.searchParams.get('model') || config.model;
  const mode = (url.searchParams.get('mode') || 'interpreter') as 'interpreter';

  const sessionId = Math.random().toString(36).substring(2, 12);
  console.log(`[Proxy] Client connected [${sessionId}]. Pair: ${sourceLang} <-> ${targetLang}, Voice: ${voice}, Model: ${modelName}`);

  const vertexClient = new VertexBidiClient();
  const systemInstruction = buildSystemInstruction(sourceLang, targetLang, mode);

  let lastAudioSentTimestamp = 0;

  let isFallbackMode = false;
  const PIPELINE_URL = process.env.TRANSLATION_PIPELINE_URL || 'http://localhost:8092';

  try {
    await vertexClient.connect(systemInstruction, voice, {
      onSetupComplete: () => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'ready',
            sessionId,
            sourceLang,
            targetLang,
            model: modelName
          }));
        }
      },
      onAudioData: (base64Pcm, sampleRate) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          const now = Date.now();
          const latencyMs = lastAudioSentTimestamp > 0 ? now - lastAudioSentTimestamp : 0;
          clientWs.send(JSON.stringify({
            type: 'audio',
            pcm: base64Pcm,
            sampleRate,
            latencyMs
          }));
        }
      },
      onTextDelta: (text) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'transcript',
            text,
            isDelta: true
          }));
        }
      },
      onTurnComplete: () => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'turn_complete'
          }));
        }
      },
      onInterrupted: () => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'interrupted'
          }));
        }
      },
      onError: (err) => {
        console.warn(`[Proxy] Vertex AI error:`, err.message);
      },
      onClose: (code, reason) => {
        console.warn(`[Proxy] Vertex AI closed (${code}: ${reason}). Enabling Translation Pipeline Bridge...`);
        isFallbackMode = true;
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'ready',
            sessionId,
            sourceLang,
            targetLang,
            model: 'Translation Pipeline (Live Fallback)'
          }));
        }
      }
    }, modelName);
  } catch (err: any) {
    console.warn(`[Proxy] Vertex Live unavailable (${err.message}), enabling Pipeline Bridge`);
    isFallbackMode = true;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'ready',
        sessionId,
        sourceLang,
        targetLang,
        model: 'Translation Pipeline (Live Fallback)'
      }));
    }
  }

  // Handle incoming messages from iOS / Web Client
  clientWs.on('message', async (message: RawData, isBinary: boolean) => {
    lastAudioSentTimestamp = Date.now();

    let pcmBase64 = '';
    let textMessage = '';
    let clientSpeakerRole = 'cast-member';
    let clientSourceLang = sourceLang;
    let clientTargetLang = targetLang;

    if (isBinary) {
      pcmBase64 = (message as Buffer).toString('base64');
    } else {
      try {
        const msgStr = message.toString('utf-8');
        const json = JSON.parse(msgStr);
        if (json.type === 'audio' && json.pcm) {
          pcmBase64 = json.pcm;
          if (json.speakerRole) clientSpeakerRole = json.speakerRole;
          if (json.sourceLang) clientSourceLang = json.sourceLang;
          if (json.targetLang) clientTargetLang = json.targetLang;
        } else if (json.type === 'text' && json.text) {
          textMessage = json.text;
          if (json.speakerRole) clientSpeakerRole = json.speakerRole;
          if (json.sourceLang) clientSourceLang = json.sourceLang;
          if (json.targetLang) clientTargetLang = json.targetLang;
        } else if (json.type === 'ping') {
          clientWs.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          return;
        }
      } catch (e: any) {
        console.warn(`[Proxy] Invalid client message format:`, e.message);
        return;
      }
    }

    if (!isFallbackMode && vertexClient.isOpen()) {
      if (pcmBase64) {
        vertexClient.sendAudioChunk(pcmBase64, config.sampleRateInput);
      } else if (textMessage) {
        vertexClient.sendTextMessage(textMessage);
      }
      return;
    }

    // Fallback Bridge: Translate via Translation Pipeline
    try {
      if (pcmBase64) {
        const fetchRes = await fetch(`${PIPELINE_URL}/api/translate-speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pcm_base64: pcmBase64,
            sample_rate: 16000,
            source_lang: clientSourceLang,
            target_lang: clientTargetLang,
            use_glossary: true
          })
        });

        if (fetchRes.ok) {
          const resJson: any = await fetchRes.json();
          if (clientWs.readyState === WebSocket.OPEN) {
            if (resJson.source_transcript) {
              clientWs.send(JSON.stringify({
                type: 'stt_transcript',
                transcript: resJson.source_transcript,
                stt_ms: resJson.latency_breakdown?.stt_ms || 120,
                speakerRole: clientSpeakerRole
              }));
            }
            if (resJson.translated_text) {
              clientWs.send(JSON.stringify({
                type: 'translation_text',
                translated_text: resJson.translated_text,
                glossary_applied: resJson.glossary_applied,
                translation_ms: resJson.latency_breakdown?.translation_ms || 180
              }));
              clientWs.send(JSON.stringify({
                type: 'transcript',
                text: resJson.translated_text
              }));
            }
            if (resJson.audio_base64) {
              clientWs.send(JSON.stringify({
                type: 'audio',
                pcm: resJson.audio_base64,
                sampleRate: 24000,
                total_latency_ms: resJson.total_latency_ms,
                latency_breakdown: resJson.latency_breakdown
              }));
            }
            clientWs.send(JSON.stringify({ type: 'turn_complete' }));
          }
        }
      } else if (textMessage) {
        const fetchRes = await fetch(`${PIPELINE_URL}/api/translate-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: textMessage,
            source_lang: clientSourceLang,
            target_lang: clientTargetLang,
            use_glossary: true
          })
        });
        if (fetchRes.ok) {
          const resJson: any = await fetchRes.json();
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'stt_transcript',
              transcript: textMessage,
              stt_ms: 0,
              speakerRole: clientSpeakerRole
            }));
            clientWs.send(JSON.stringify({
              type: 'translation_text',
              translated_text: resJson.translated_text,
              glossary_applied: resJson.glossary_applied,
              translation_ms: resJson.latency_breakdown?.translation_ms || 150
            }));
            clientWs.send(JSON.stringify({
              type: 'transcript',
              text: resJson.translated_text
            }));
            if (resJson.audio_base64) {
              clientWs.send(JSON.stringify({
                type: 'audio',
                pcm: resJson.audio_base64,
                sampleRate: 24000,
                total_latency_ms: resJson.total_latency_ms,
                latency_breakdown: resJson.latency_breakdown
              }));
            }
            clientWs.send(JSON.stringify({ type: 'turn_complete' }));
          }
        }
      }
    } catch (bridgeErr: any) {
      console.error('[Proxy] Fallback bridge request error:', bridgeErr.message);
    }
  });

  clientWs.on('close', () => {
    console.log(`[Proxy] Client disconnected [${sessionId}]`);
    vertexClient.close();
  });

  clientWs.on('error', (err) => {
    console.error(`[Proxy] Client WebSocket error [${sessionId}]:`, err);
    vertexClient.close();
  });
});

httpServer.listen(config.port, () => {
  console.log(`=======================================================`);
  console.log(`✨ Enterprise Live Translation - Gemini Live Proxy Started ✨`);
  console.log(`Port: ${config.port}`);
  console.log(`GCP Project: ${config.projectId}`);
  console.log(`Region: ${config.location}`);
  console.log(`Model: ${config.model}`);
  console.log(`=======================================================`);
});
