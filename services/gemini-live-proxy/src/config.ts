import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  port: number;
  projectId: string;
  location: string;
  model: string;
  defaultVoice: string;
  sampleRateInput: number;
  sampleRateOutput: number;
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '8080', 10),
  projectId: process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'disney-parks-live-translation',
  location: process.env.LOCATION || 'us-central1',
  model: process.env.GEMINI_LIVE_MODEL || 'gemini-2.0-flash-exp',
  defaultVoice: process.env.DEFAULT_VOICE || 'Aoede', // Options: Aoede, Puck, Charon, Kore, Fenrir
  sampleRateInput: parseInt(process.env.SAMPLE_RATE_INPUT || '16000', 10),
  sampleRateOutput: parseInt(process.env.SAMPLE_RATE_OUTPUT || '24000', 10),
};
