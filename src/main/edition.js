'use strict';
// İki sürüm aynı koddan derlenir. Spotify Geliştirici Politikası (III.5) Spotify içeriğinin başka bir
// servisin akışlarıyla aynı üründe birleşmesini yasakladığı için Spotify ayrı bir uygulamadır.
//   music  : "Noxelyra Music.exe"  -> yerel dosyalar + YouTube (resmi IFrame Player API)
//   stream : "Noxelyra Stream.exe" -> yalnız Spotify (resmi Web Playback SDK)
// AppUserModelID her zaman exe adıyla birebir aynıdır; Noxelyra ses barını ve pencereyi bu addan bulur.
const fs = require('fs');
const path = require('path');

function readEdition() {
  if (process.env.NOX_EDITION) return process.env.NOX_EDITION;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'edition.json'), 'utf8')).edition; }
  catch { return 'music'; }
}

const id = readEdition() === 'stream' ? 'stream' : 'music';
const editions = {
  music: { id: 'music', name: 'Noxelyra Music', port: 47862, sources: ['local', 'youtube'] },
  stream: { id: 'stream', name: 'Noxelyra Stream', port: 47863, sources: ['spotify'] },
};

// NOX_PORT: denemelerde açık olan asıl uygulamayla çakışmasın diye.
if (process.env.NOX_PORT) editions[id].port = Number(process.env.NOX_PORT);

module.exports = editions[id];
