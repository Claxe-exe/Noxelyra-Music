'use strict';
// Windows medya kontrolleri (SMTC) kendi işlemimizde, kendi penceremize bağlı yayınlanır (smtc/Bridge.cs).
// Chromium'un yerleşik SMTC'si kapatılır, çünkü YouTube ve Spotify oynatıcıları iframe içinde çalar ve
// Chromium o durumda bizim başlık/kapak bilgimizi değil iframe'inkini (veya hiçbirini) yayınlar.
// .NET 10 çalışma zamanı yoksa köprü yüklenmez; o zaman Chromium'un kendi SMTC'si (navigator.mediaSession) kalır.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let bridge = null;
let loadError = null;

function smtcDir() {
  const packed = path.join(process.resourcesPath ?? '', 'smtc');
  return fs.existsSync(path.join(packed, 'NoxSmtc.dll')) ? packed : path.join(app.getAppPath(), 'build', 'smtc');
}

/** app.whenReady öncesinde çağrılır; sonuç Chromium bayraklarını belirler. */
function load() {
  try {
    const dotnet = require('node-api-dotnet/net10.0');
    const dir = smtcDir();
    dotnet.load(path.join(dir, 'NoxSmtc.dll'));
    bridge = dotnet.NoxSmtc.Bridge;
    return true;
  } catch (e) {
    loadError = String(e?.message ?? e);
    bridge = null;
    return false;
  }
}

function attach(win, onCommand) {
  if (!bridge) return loadError ?? 'yüklenmedi';
  const handle = win.getNativeWindowHandle();
  const hwnd = Number(handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0)));
  const result = bridge.Init(hwnd);
  if (result !== 'ok') { bridge = null; return result; }
  setInterval(() => {
    const text = bridge?.TakeEvents();
    if (text) for (const line of text.split('\n')) onCommand(line);
  }, 120);
  return 'ok';
}

const guard = (fn) => { if (!bridge) return; try { fn(); } catch (e) { console.error('SMTC güncellenemedi:', e?.message ?? e); } };

/** Parça değişince: başlık, sanatçı, albüm, kare kapak (base64 PNG, en az 300 px). */
const setMeta = (m) => guard(() => bridge.SetMetadata(m.title ?? '', m.artist ?? '', m.album ?? '', m.cover ?? ''));

/** Durum ve zaman çizelgesi: oynat/duraklat, sarma, konum değişince ve oynarken her saniye. */
const setPlayback = (s) => guard(() => {
  if (s.status === 'closed') { bridge.Clear(); return; }
  bridge.SetCommands(!!s.canPrevious, !!s.canNext, true);
  bridge.SetStatus(s.status);
  bridge.SetTimeline(s.position ?? 0, s.duration ?? 0, !!s.seekable);
});

/** Mini oynatıcı: pencereyi doğrudan Windows'un 'her zaman üstte' katmanına koyar. Köprü yoksa false. */
function setTopmost(win, on) {
  if (!bridge || !win) return false;
  const handle = win.getNativeWindowHandle();
  const hwnd = Number(handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0)));
  try { if (on && bridge.IsTopmost(hwnd)) return true; return bridge.SetTopmost(hwnd, on); } catch { return false; }
}

module.exports = { load, attach, setMeta, setPlayback, setTopmost, available: () => !!bridge, error: () => loadError };
