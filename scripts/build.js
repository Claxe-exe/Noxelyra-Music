'use strict';
// Paketleme: node scripts/build.js music|stream
//   music  -> dist/music/  "Noxelyra Music.exe"  (normal Electron)
//   stream -> dist/stream/ "Noxelyra Stream.exe" (castLabs Electron, Widevine)
// Exe adı, AppUserModelID ve kısayol kimliği aynı addır; Noxelyra uygulamayı bu addan bulur.
const fs = require('fs');
const path = require('path');
const builder = require('electron-builder');

const root = path.join(__dirname, '..');
const edition = process.argv[2] === 'stream' ? 'stream' : 'music';
const name = edition === 'stream' ? 'Noxelyra Stream' : 'Noxelyra Music';
const editionFile = path.join(root, 'edition.json');
const pkg = require(path.join(root, 'package.json'));

fs.writeFileSync(editionFile, JSON.stringify({ edition }) + '\n');

const config = {
  appId: name,
  productName: name,
  executableName: name,
  copyright: 'MIT',
  directories: { output: path.join('dist', edition), buildResources: 'build' },
  // node-api-dotnet .NET derlemelerini dosya yolundan yükler; .NET asar içini okuyamadığı için asar kapalı.
  asar: false,
  files: ['src/**', 'edition.json', 'build/icon.png', 'package.json', 'LICENSE', '!**/*.map', '!node_modules/node-api-dotnet/{linux-*,osx-*,win-arm64,net472*,net8.0*,net9.0*}/**'],
  extraResources: [{ from: 'build/smtc', to: 'smtc', filter: ['*.dll', '*.json'] },
    // İsteğe bağlı: dağıtanın Google OAuth istemcisi (bkz. src/main/auth.js).
    ...(fs.existsSync(path.join(root, 'config', 'google.json')) ? [{ from: 'config/google.json', to: 'config/google.json' }] : [])],
  electronDist: path.join(root, 'node_modules', edition === 'stream' ? 'electron-wvcus' : 'electron', 'dist'),
  electronVersion: pkg.devDependencies.electron,
  extraMetadata: { productName: name, name: edition === 'stream' ? 'noxelyra-stream' : 'noxelyra-music' },
  win: { target: ['nsis'], icon: 'build/icon.ico', signAndEditExecutable: true },
  nsis: {
    oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
    shortcutName: name, uninstallDisplayName: name, artifactName: `${name.replace(' ', '-')}-Setup.exe`,
    createDesktopShortcut: true, createStartMenuShortcut: true, installerIcon: 'build/icon.ico', uninstallerIcon: 'build/icon.ico',
  },
  publish: null,
};

builder.build({ targets: builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64), config })
  .then((files) => { console.log(files.join('\n')); })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.writeFileSync(editionFile, JSON.stringify({ edition: 'music' }) + '\n'));
