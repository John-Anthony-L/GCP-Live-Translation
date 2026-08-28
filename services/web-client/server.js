const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Config endpoint exposing proxy URLs
app.get('/config.json', (req, res) => {
  res.json({
    geminiLiveProxyUrl: process.env.GEMINI_LIVE_PROXY_URL || 'ws://localhost:8080/live-translate',
    translationPipelineUrl: process.env.TRANSLATION_PIPELINE_URL || 'http://localhost:8081',
    translationPipelineWsUrl: process.env.TRANSLATION_PIPELINE_WS_URL || 'ws://localhost:8081/ws/stream-translate',
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🏰 Disney Live Translation Web Testbed running on port ${PORT}`);
});
