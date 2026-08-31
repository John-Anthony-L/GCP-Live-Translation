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
    service: 'disney-gemini-live-proxy',
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
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'error',
            message: err.message
          }));
        }
      },
      onClose: (code, reason) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'closed',
            code,
            reason
          }));
          clientWs.close();
        }
      }
    }, modelName);
  } catch (err: any) {
    console.error(`[Proxy] Failed to connect to Vertex AI for session ${sessionId}:`, err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'error',
        message: `Vertex AI Connection Failed: ${err.message}`
      }));
      clientWs.close();
    }
    return;
  }

  // Handle incoming messages from iOS / Web Client
  clientWs.on('message', (message: RawData, isBinary: boolean) => {
    lastAudioSentTimestamp = Date.now();

    if (isBinary) {
      // Direct raw PCM binary buffer
      const base64Pcm = (message as Buffer).toString('base64');
      vertexClient.sendAudioChunk(base64Pcm, config.sampleRateInput);
      return;
    }

    try {
      const msgStr = message.toString('utf-8');
      const json = JSON.parse(msgStr);

      if (json.type === 'audio' && json.pcm) {
        vertexClient.sendAudioChunk(json.pcm, json.sampleRate || config.sampleRateInput);
      } else if (json.type === 'text' && json.text) {
        vertexClient.sendTextMessage(json.text);
      } else if (json.type === 'ping') {
        clientWs.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch (e: any) {
      console.warn(`[Proxy] Invalid client message format:`, e.message);
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
  console.log(`✨ Disney Live Translation - Gemini Live Proxy Started ✨`);
  console.log(`Port: ${config.port}`);
  console.log(`GCP Project: ${config.projectId}`);
  console.log(`Region: ${config.location}`);
  console.log(`Model: ${config.model}`);
  console.log(`=======================================================`);
});
