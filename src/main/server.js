'use strict';
// Yalnız 127.0.0.1'e bağlanan küçük sunucu. Neden var:
//  - YouTube IFrame oynatıcısı geçerli bir http(s) kaynağı (Referer) ister; file:// sayfada "Hata 153" verir.
//  - Spotify ve Google OAuth dönüş adresi loopback olmalıdır (http://127.0.0.1:<port>/...).
//  - Yerel dosyalar Range desteğiyle akıtılır (video sarma için).
// Medya ve kapak adresleri her açılışta üretilen gizli bir anahtar içerir; başka yerel programlar dosya okuyamaz.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/webm', '.mov': 'video/mp4',
};

function csp(edition) {
  const common = ["default-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self'", "media-src 'self' blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'"];
  if (edition === 'stream') {
    return [...common, "script-src 'self' https://sdk.scdn.co", 'frame-src https://sdk.scdn.co', "img-src 'self' data: blob: https://*.scdn.co https://*.spotifycdn.com"].join('; ');
  }
  return [...common, "script-src 'self' https://www.youtube.com", 'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
    "img-src 'self' data: blob: https://i.ytimg.com https://*.ggpht.com"].join('; ');
}

function start({ port, edition, rendererDir, library, onOAuth }) {
  const secret = crypto.randomBytes(16).toString('hex');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const parts = url.pathname.split('/').filter(Boolean);

      if (parts[0] === 'oauth' && parts[1]) {
        const ok = await onOAuth(parts[1], url.searchParams);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Noxelyra</title><body style="font:16px Segoe UI;background:#14111f;color:#e9e4ff;display:grid;place-items:center;height:100vh;margin:0">
          <div>${ok ? 'Giriş tamamlandı. Bu sekmeyi kapatıp uygulamaya dönebilirsin.' : 'Giriş tamamlanamadı. Uygulamaya dönüp yeniden dene.'}</div>`);
        return;
      }

      if ((parts[0] === 'media' || parts[0] === 'cover') && parts[1] === secret && parts[2]) {
        if (parts[0] === 'cover') {
          const c = await library.cover(parts[2]);
          if (!c) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'max-age=3600' });
          res.end(c.data);
          return;
        }
        const file = library.pathOf(parts[2]);
        if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
        streamFile(req, res, file);
        return;
      }

      // Arayüz dosyaları
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const full = path.normalize(path.join(rendererDir, rel));
      if (!full.startsWith(rendererDir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end(); return; }
      const headers = { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' };
      if (full.endsWith('.html')) { headers['Content-Security-Policy'] = csp(edition); headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'; }
      res.writeHead(200, headers);
      fs.createReadStream(full).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, secret, origin: `http://127.0.0.1:${port}` }));
  });
}

function streamFile(req, res, file) {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (!range) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  let start = range[1] ? Number(range[1]) : size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  if (!range[1]) end = size - 1;
  if (start >= size || start < 0 || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
  end = Math.min(end, size - 1);
  res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file, { start, end }).pipe(res);
}

module.exports = { start };
