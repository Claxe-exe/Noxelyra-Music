'use strict';
// Güncelleme: yalnız kullanıcı "Güncellemeleri denetle"ye basınca GitHub'daki son sürüme bakılır (arka planda
// kendiliğinden denetim yok). Yeni sürüm varsa indirilir, SHA-512 ile doğrulanır, sessizce kurulur ve uygulama
// yeniden açılır. Her sürüm kendi kanal dosyasını okur (music.yml / stream.yml), iki uygulama karışmaz.
const { app } = require('electron');

let updater = null;
let busy = false;

function get() {
  if (updater) return updater;
  updater = require('electron-updater').autoUpdater;
  // music.yml / stream.yml (kanal atamak eski sürüme dönmeye izin verir; bunu geri kapat).
  updater.channel = require('./edition').id;
  updater.allowDowngrade = false;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.logger = null;
  return updater;
}

/**
 * Denetler; yeni sürüm varsa indirip kurar. send(durum) arayüze ilerleme bildirir:
 *   { state: 'checking' | 'latest' | 'downloading' | 'installing' | 'error', version?, percent?, message? }
 */
async function checkAndInstall(send) {
  if (!app.isPackaged) { send({ state: 'error', message: 'Geliştirme sürümünde güncelleme yok; kurulu uygulamada çalışır.' }); return; }
  if (busy) return;
  busy = true;
  const u = get();
  const onProgress = (p) => send({ state: 'downloading', percent: Math.round(p.percent ?? 0) });
  u.on('download-progress', onProgress);
  try {
    send({ state: 'checking' });
    const result = await u.checkForUpdates();
    const latest = result?.updateInfo?.version;
    if (!result?.isUpdateAvailable || !latest) { send({ state: 'latest', version: app.getVersion() }); return; }
    send({ state: 'downloading', version: latest, percent: 0 });
    await u.downloadUpdate();
    send({ state: 'installing', version: latest });
    // Denemelerde kurulumu atlamak için (gerçek kurulu uygulamaya dokunmasın).
    if (process.env.NOX_UPDATE_DRYRUN) return;
    // Sessiz kurulum (/S), bitince uygulamayı yeniden aç.
    setTimeout(() => u.quitAndInstall(true, true), 800);
  } catch (e) {
    send({ state: 'error', message: friendly(e) });
  } finally {
    u.off('download-progress', onProgress);
    busy = false;
  }
}

function friendly(e) {
  const m = String(e?.message ?? e);
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNRESET|getaddrinfo/i.test(m)) return 'İnternete bağlanılamadı. Bağlantını kontrol edip tekrar dene.';
  if (/404|Cannot find/i.test(m)) return 'GitHub’da bu uygulama için güncelleme bilgisi bulunamadı.';
  if (/sha512|checksum/i.test(m)) return 'İndirilen dosya doğrulanamadı; güvenlik için kurulmadı. Tekrar dene.';
  return `Güncelleme yapılamadı: ${m.split('\n')[0].slice(0, 160)}`;
}

module.exports = { checkAndInstall };
