// Capture un screenshot du renderer Electron via Chrome DevTools Protocol.
// Usage: node cdp-shot.js <out.png> [width] [height]
// Pas de permission Screen Recording requise : CDP rend la page directement.
const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');

const out = process.argv[2] || '/tmp/sb-cdp.png';
const W = parseInt(process.argv[3] || '1600', 10);
const H = parseInt(process.argv[4] || '1000', 10);

function getTargets() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:'+(process.env.SB_PORT||'9222')+'/json/list', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

(async () => {
  const targets = await getTargets();
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) { console.error('no page target'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  let id = 0; const pending = {};
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; }
  });
  ws.on('open', async () => {
    await send('Page.enable');
    await send('Runtime.enable');
    // forcer une taille de fenetre coherente pour la capture
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    // pilotage optionnel du DOM avant capture (ex: forcer le theme, selectionner une session)
    if (process.env.SB_EVAL) {
      await send('Runtime.evaluate', { expression: process.env.SB_EVAL, awaitPromise: true });
      await new Promise(r => setTimeout(r, parseInt(process.env.SB_WAIT || '400', 10)));
    }
    const shotParams = { format: 'png', captureBeyondViewport: false };
    if (process.env.SB_CLIP) {
      const [x, y, w, h] = process.env.SB_CLIP.split(',').map(Number);
      shotParams.clip = { x, y, width: w, height: h, scale: 2 };
    }
    const r = await send('Page.captureScreenshot', shotParams);
    if (!r || !r.data) { console.error('no screenshot data'); process.exit(1); }
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    await send('Emulation.clearDeviceMetricsOverride');
    console.log('saved', out, fs.statSync(out).size, 'bytes');
    ws.close(); process.exit(0);
  });
  ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
})();
