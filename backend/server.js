const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;

// ── Paths ──────────────────────────────────────────────────────────────
const PRESENTATION_PATH = path.join(
  __dirname, '..', 'Frameworks_ Conceitos, Tipos e Aplicações.html'
);
const NOTES_FILE = path.join(__dirname, 'notes.json');

// ── Load and parse presentation ────────────────────────────────────────
let presentationHTML = '';
try {
  presentationHTML = fs.readFileSync(PRESENTATION_PATH, 'utf-8');
} catch (err) {
  console.error('Não foi possível ler o arquivo da apresentação:', err.message);
  process.exit(1);
}

const $ = cheerio.load(presentationHTML);
const slideElements = $('section.s').toArray();
const totalSlides = slideElements.length;
console.log(`Encontrados ${totalSlides} slides.`);

// Extract info from each slide
const slidesInfo = slideElements.map((el, i) => {
  const $el = $(el);
  const heading =
    $el.find('h1').first().text().trim() ||
    $el.find('h2').first().text().trim() ||
    $el.find('h3').first().text().trim() ||
    `Slide ${i + 1}`;
  const innerHtml = $el.html();
  return { index: i, title: heading, html: innerHtml };
});

// ── Notes persistence ──────────────────────────────────────────────────
let notes = {};
if (fs.existsSync(NOTES_FILE)) {
  try { notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8')); } catch (_) { notes = {}; }
}
function saveNotes() {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

// ── Global state ───────────────────────────────────────────────────────
let currentSlide = 0;

// ── WebSocket ──────────────────────────────────────────────────────────
function broadcast(data, excludeWs) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', ws => {
  console.log('WebSocket client connected. Total:', wss.clients.size);

  // Send current state on connect
  ws.send(JSON.stringify({ type: 'sync', slide: currentSlide, total: totalSlides }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    let newSlide = currentSlide;

    switch (msg.type) {
      case 'goto':
        newSlide = Math.max(0, Math.min(totalSlides - 1, parseInt(msg.slide, 10)));
        break;
      case 'next':
        newSlide = Math.min(totalSlides - 1, currentSlide + 1);
        break;
      case 'prev':
        newSlide = Math.max(0, currentSlide - 1);
        break;
      default:
        return;
    }

    // Only broadcast if slide actually changed
    if (newSlide !== currentSlide) {
      currentSlide = newSlide;
      // Send to ALL clients including the sender so everyone is in sync
      broadcast({ type: 'sync', slide: currentSlide, total: totalSlides });
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected. Total:', wss.clients.size);
  });
});

// ── REST API ───────────────────────────────────────────────────────────
app.use(express.json());
app.use('/panel', express.static(path.join(__dirname, 'public')));

// Slide metadata
app.get('/api/slides', (_req, res) => {
  res.json(slidesInfo.map(s => ({ index: s.index, title: s.title })));
});

// Full slide HTML for preview (wrapped with presentation styles)
app.get('/api/slide/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  if (idx < 0 || idx >= totalSlides) return res.status(404).send('Not found');

  // Extract styles from the original presentation
  const styles = $('style').toArray().map(el => $(el).html()).join('\n');
  const linkTags = $('link[rel="preconnect"], link[href*="fonts"]')
    .toArray()
    .map(el => $.html(el))
    .join('\n');

  const previewHtml = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
${linkTags}
<style>
${styles}
body { overflow: auto !important; height: auto !important; }
.s { position: relative !important; display: flex !important; min-height: 100vh; }
nav { display: none !important; }
</style>
</head><body>
<section class="s on">${slidesInfo[idx].html}</section>
</body></html>`;
  res.type('html').send(previewHtml);
});

// Notes CRUD
app.get('/api/notes', (_req, res) => res.json(notes));

app.get('/api/note/:index', (req, res) => {
  res.json({ note: notes[req.params.index] || '' });
});

app.post('/api/note/:index', (req, res) => {
  notes[req.params.index] = req.body.note || '';
  saveNotes();
  res.json({ ok: true });
});

// ── Serve presentation with WS remote-control injected ─────────────────
app.get('/', (_req, res) => {
  // Inject a script that connects to WS and receives slide-change commands
  // Key: the presentation ONLY LISTENS. It never sends messages back.
  // Navigation from the presentation's own buttons also notifies the server.
  const wsScript = `
<script>
(function(){
  var _ws = new WebSocket('ws://' + location.host);
  var _remote = false;

  _ws.onopen = function(){ console.log('[Remote] Conectado ao painel de controle'); };
  _ws.onclose = function(){ console.log('[Remote] Desconectado. Recarregue a página.'); };

  _ws.onmessage = function(e){
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'sync') {
        _remote = true;
        go(msg.slide);
        _remote = false;
      }
    } catch(err){ console.error('[Remote]', err); }
  };

  // Wrap the original go() so local navigation also tells the server
  var _origGo = go;
  go = function(k) {
    _origGo(k);
    // Only notify server if this was a LOCAL action (button click, keyboard, touch)
    if (!_remote && _ws.readyState === 1) {
      _ws.send(JSON.stringify({ type: 'goto', slide: i }));
    }
  };
})();
</script>`;

  const modified = presentationHTML.replace('</body>', wsScript + '\n</body>');
  res.type('html').send(modified);
});

// ── Start ──────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  // Get local IP for iPad access
  const nets = require('os').networkInterfaces();
  let localIp = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIp = net.address;
        break;
      }
    }
  }

  console.log('');
  console.log('  ┌───────────────────────────────────────────────────────┐');
  console.log(`  │  🎞  Apresentação:  http://localhost:${PORT}/              │`);
  console.log(`  │  🎛  Painel:        http://localhost:${PORT}/panel         │`);
  console.log('  │                                                       │');
  console.log(`  │  📱  iPad/celular:  http://${localIp}:${PORT}/        │`);
  console.log(`  │  📱  Painel iPad:   http://${localIp}:${PORT}/panel   │`);
  console.log('  └───────────────────────────────────────────────────────┘');
  console.log('');
});
