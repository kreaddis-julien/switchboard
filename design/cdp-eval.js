// Evalue l'expression SB_JS dans le renderer via CDP et imprime le resultat.
const http = require('http'); const WebSocket = require('ws');
const PORT = process.env.SB_PORT || '9222';
const EXPR = process.env.SB_JS || '1+1';
http.get('http://127.0.0.1:' + PORT + '/json/list', r => {
  let d = ''; r.on('data', c => d += c); r.on('end', () => {
    const t = JSON.parse(d).find(x => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: EXPR } })));
    ws.on('message', m => { const r = JSON.parse(m); if (r.id === 1) { console.log(JSON.stringify(r.result && r.result.result && r.result.result.value, null, 1)); ws.close(); process.exit(0); } });
    ws.on('error', e => { console.error(e.message); process.exit(1); });
  });
}).on('error', e => { console.error(e.message); process.exit(1); });
