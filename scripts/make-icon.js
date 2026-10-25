'use strict';
// Simgeyi SVG'den üretir (build/icon.png ve çok boyutlu build/icon.ico). Electron ile çalıştırılır:
//   npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// Kalıcı veri klasörü bırakmasın.
app.setPath('userData', path.join(require('os').tmpdir(), 'noxelyra-icon'));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b1d4f"/><stop offset="1" stop-color="#0f0b1d"/></linearGradient>
    <linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d7c2ff"/><stop offset="1" stop-color="#8f6bff"/></linearGradient>
  </defs>
  <rect width="256" height="256" rx="58" fill="url(#bg)"/>
  <circle cx="64" cy="66" r="3" fill="#fff" opacity=".7"/><circle cx="196" cy="54" r="2.5" fill="#fff" opacity=".6"/><circle cx="206" cy="150" r="2" fill="#fff" opacity=".5"/>
  <path d="M168 176a64 64 0 1 1-50-108 50 50 0 1 0 50 108Z" fill="url(#m)"/>
  <path d="M150 92v62" stroke="#ece8ff" stroke-width="12" stroke-linecap="round"/>
  <path d="M150 92l34-10v22l-34 10" fill="#ece8ff"/>
  <circle cx="138" cy="158" r="17" fill="#ece8ff"/>
</svg>`;

function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="256" height="256">`);
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, 'icon.png'), image.resize({ width: 256, height: 256 }).toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(sizes.map((size) => ({ size, data: image.resize({ width: size, height: size, quality: 'best' }).toPNG() }))));
  console.log('build/icon.png ve build/icon.ico yazıldı');
  app.quit();
});
