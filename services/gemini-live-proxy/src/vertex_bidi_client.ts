import WebSocket, { RawData } from 'ws';
import { GoogleAuth } from 'google-auth-library';
import { config } from './config.js';

export interface VertexBidiCallbacks {
  onSetupComplete?: () => void;
  onAudioData?: (base64Pcm: string, sampleRate: number) => void;
  onTextDelta?: (text: string) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onError?: (err: Error) => void;
  onClose?: (code: number, reason: string) => void;
}

export class VertexBidiClient {
  private ws: WebSocket | null = null;
  private auth: GoogleAuth;
  private isSetupDone = false;

  constructor() {
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
  }

  public async connect(
    systemInstruction: string,
    voiceName: string = config.defaultVoice,
    callbacks: VertexBidiCallbacks,
    modelName: string = config.model
  ): Promise<void> {
    const client = await this.auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse.token;

    if (!token) {
      throw new Error('Failed to obtain Google Cloud access token for Vertex AI Live API');
    }

    const host = `${config.location}-aiplatform.googleapis.com`;
    const wsUrl = `wss://${host}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`;

    console.log(`[VertexBidiClient] Connecting to ${wsUrl} (Project: ${config.projectId}, Model: ${modelName})`);

    this.ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    this.ws.on('open', () => {
      console.log('[VertexBidiClient] WebSocket connected to Vertex AI. Sending BidiGenerateContentSetup...');
      
      const modelPath = modelName.startsWith('projects/')
        ? modelName
        : `projects/${config.projectId}/locations/${config.location}/publishers/google/models/${modelName}`;
      
      const setupMsg = {
        setup: {
          model: modelPath,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voiceName
                }
              }
            }
          },
          systemInstruction: {
            parts: [
              {
                text: systemInstruction
              }
            ]
          }
        }
      };

      this.ws?.send(JSON.stringify(setupMsg));
    });

    this.ws.on('message', (data: RawData) => {
      try {
        const text = data.toString('utf-8');
        const json = JSON.parse(text);

        if (json.setupComplete) {
          console.log('[VertexBidiClient] Live API setup complete and ready for streaming');
          this.isSetupDone = true;
          callbacks.onSetupComplete?.();
          return;
        }

        if (json.serverContent) {
          const serverContent = json.serverContent;
          
          if (serverContent.interrupted) {
            console.log('[VertexBidiClient] Model speech interrupted by user (barge-in)');
            callbacks.onInterrupted?.();
          }

          if (serverContent.modelTurn && serverContent.modelTurn.parts) {
            for (const part of serverContent.modelTurn.parts) {
              if (part.text) {
                callbacks.onTextDelta?.(part.text);
              }
              if (part.inlineData && part.inlineData.data) {
                const sampleRate = part.inlineData.mimeType?.includes('24000') ? 24000 : config.sampleRateOutput;
                callbacks.onAudioData?.(part.inlineData.data, sampleRate);
              }
            }
          }

          if (serverContent.turnComplete) {
            callbacks.onTurnComplete?.();
          }
        }
      } catch (err: any) {
        console.error('[VertexBidiClient] Error parsing message from Vertex AI:', err.message);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[VertexBidiClient] WebSocket error:', err);
      callbacks.onError?.(err);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[VertexBidiClient] Vertex AI WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
      this.isSetupDone = false;
      callbacks.onClose?.(code, reason.toString());
    });
  }

  public sendAudioChunk(base64Pcm: string, sampleRate: number = config.sampleRateInput): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[VertexBidiClient] Cannot send audio chunk: WebSocket is not open');
      return;
    }

    const payload = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: `audio/pcm;rate=${sampleRate}`,
            data: base64Pcm
          }
        ]
      }
    };

    this.ws.send(JSON.stringify(payload));
  }

  public sendTextMessage(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const payload = {
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [{ text }]
          }
        ],
        turnComplete: true
      }
    };

    this.ws.send(JSON.stringify(payload));
  }

  public close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
