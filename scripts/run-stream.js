'use strict';
// Geliştirme: Spotify sürümünü castLabs Electron (Widevine) ile başlatır.
const { spawn } = require('child_process');
const path = require('path');
const exe = path.join(__dirname, '..', 'node_modules', 'electron-wvcus', 'dist', 'electron.exe');
spawn(exe, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, NOX_EDITION: 'stream' } })
  .on('exit', (code) => process.exit(code ?? 0));
