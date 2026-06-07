// Canonical Switchboard app icon: a "switchboard" hub wired to session nodes.
// Black & white + one accent (green = a live/active session). Flat, bold,
// macOS superellipse squircle. Renders build/icon.png (1024, full-bleed squircle);
// scripts/generate-icons.js then insets it and builds icon.icns.
const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');
const S = 1024;
const WHITE = '#f4f5f7';
const ACCENT = '#3ddc84'; // single accent: a live session

function squircle(ctx, size, n = 5) {
  const c = size / 2, a = size / 2; ctx.beginPath();
  for (let i = 0; i <= 720; i++) {
    const t = (i / 720) * 2 * Math.PI, ct = Math.cos(t), st = Math.sin(t);
    const x = c + a * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n);
    const y = c + a * Math.sign(st) * Math.pow(Math.abs(st), 2 / n);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}

const cv = createCanvas(S, S); const ctx = cv.getContext('2d');

// Background: near-black with a subtle top sheen + hairline rim (premium, still mono).
squircle(ctx, S); ctx.save(); ctx.clip();
const g = ctx.createLinearGradient(0, 0, 0, S);
g.addColorStop(0, '#17171d'); g.addColorStop(1, '#0c0c11');
ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
const sh = ctx.createLinearGradient(0, 0, 0, S * 0.5);
sh.addColorStop(0, 'rgba(255,255,255,0.06)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
ctx.fillStyle = sh; ctx.fillRect(0, 0, S, S * 0.5);
ctx.restore();
ctx.save(); squircle(ctx, S); ctx.clip();
ctx.lineWidth = S * 0.018; ctx.strokeStyle = 'rgba(255,255,255,0.10)'; squircle(ctx, S); ctx.stroke();
ctx.restore();

// Switchboard: central hub wired to 3 session nodes (one live = green).
// Sits slightly above the geometric center for optical balance.
const cx = S / 2, cy = S * 0.47, R = S * 0.094, nr = S * 0.078;
const nodes = [
  { x: cx - S * 0.205, y: cy - S * 0.165, r: nr },
  { x: cx + S * 0.215, y: cy - S * 0.1, r: nr },
  // active session: same size as the others, on a slightly longer branch
  { x: cx + S * 0.012, y: cy + S * 0.245, r: nr, active: true },
];
ctx.lineCap = 'round'; ctx.lineWidth = S * 0.044; ctx.strokeStyle = WHITE;
for (const n of nodes) { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(n.x, n.y); ctx.stroke(); }
for (const n of nodes) {
  ctx.fillStyle = n.active ? ACCENT : WHITE;
  ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fill();
}
// hub as a ring (filled white + punched-out center) so it reads as the "board"
ctx.fillStyle = WHITE; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
ctx.fillStyle = '#0c0c11'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.42, 0, 7); ctx.fill();

fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), cv.toBuffer('image/png'));
console.log('Wrote build/icon.png');
