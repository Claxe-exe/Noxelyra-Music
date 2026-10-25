'use strict';
// Ayarlar düz JSON; oturum belirteçleri Windows DPAPI (safeStorage) ile şifrelenir. Hiçbir şey dışarı gönderilmez.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const file = () => path.join(app.getPath('userData'), 'settings.json');
const secretFile = (name) => path.join(app.getPath('userData'), `${name}.token`);

let cache = null;
const defaults = { folders: [], volume: 0.8, shuffle: false, repeat: 'off', spotifyClientId: '', googleClientId: '', googleClientSecret: '' };

function load() {
  if (cache) return cache;
  try { cache = { ...defaults, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; }
  catch { cache = { ...defaults }; }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  return cache;
}

function readSecret(name) {
  try {
    const data = fs.readFileSync(secretFile(name));
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : data.toString('utf8'));
  } catch { return null; }
}

function writeSecret(name, value) {
  if (value == null) { fs.rmSync(secretFile(name), { force: true }); return; }
  const text = JSON.stringify(value);
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(secretFile(name), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : text);
}

module.exports = { load, save, readSecret, writeSecret };
