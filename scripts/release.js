'use strict';
// Yeni sürüm yayınlar: node scripts/release.js [patch|minor|major]
// 1) package.json sürümünü artırır ve commit'ler  2) iki kurulum dosyasını derler
// 3) kodu GitHub'a iter  4) GitHub Release oluşturup Setup dosyalarını yükler.
// README'deki ".../releases/latest/download/Noxelyra-Music-Setup.exe" bağlantısı böylece hep en son sürümü indirir.
const { execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const level = ['patch', 'minor', 'major'].includes(process.argv[2]) ? process.argv[2] : 'patch';

if (execSync('git status --porcelain', { cwd: root }).toString().trim()) {
  console.error('Önce değişiklikleri commit\'le; çalışma alanı temiz olmalı.');
  process.exit(1);
}

run(`npm version ${level} -m "Sürüm %s"`);
const version = require(path.join(root, 'package.json')).version;
run('npm run dist');
run('git push --follow-tags');
run(`gh release create v${version} "dist/music/Noxelyra-Music-Setup.exe" "dist/stream/Noxelyra-Stream-Setup.exe" --title "Noxelyra Music ${version}" --generate-notes`);
console.log(`v${version} yayınlandı.`);
