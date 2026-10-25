'use strict';
// Yerel kitaplık: seçilen klasörleri tarar, etiketleri (başlık, sanatçı, albüm, süre) music-metadata ile okur.
// Dizin önbelleği userData/library.json içindedir; değişmeyen dosyalar yeniden okunmaz.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const AUDIO = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav']);
const VIDEO = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov']);
const MAX_FILES = 30000;

let mm = null;
const metadata = async () => (mm ??= await import('music-metadata'));
const indexFile = () => path.join(app.getPath('userData'), 'library.json');

let tracks = new Map(); // id -> track
let byPath = new Map(); // path -> id (yalnız kitaplık dışından eklenen dosyalar için de)

const idFor = (file) => crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 16);

function loadIndex() {
  try {
    for (const t of JSON.parse(fs.readFileSync(indexFile(), 'utf8'))) { tracks.set(t.id, t); byPath.set(t.path, t.id); }
  } catch { /* ilk açılış */ }
}

function saveIndex() {
  fs.mkdirSync(path.dirname(indexFile()), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify([...tracks.values()].filter((t) => t.inLibrary)));
}

function walk(dir, out, depth = 0) {
  if (depth > 12 || out.length >= MAX_FILES) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else {
      const ext = path.extname(e.name).toLowerCase();
      if (AUDIO.has(ext) || VIDEO.has(ext)) out.push(full);
    }
  }
}

async function describe(file, inLibrary) {
  const stat = fs.statSync(file);
  const id = idFor(file);
  const old = tracks.get(id);
  if (old && old.mtime === stat.mtimeMs && old.size === stat.size) { old.inLibrary ||= inLibrary; return old; }
  const ext = path.extname(file).toLowerCase();
  const video = VIDEO.has(ext);
  const base = path.basename(file, ext);
  // "Sanatçı - Başlık" biçimli dosya adları etiket yoksa ayrıştırılır.
  const dash = base.split(' - ');
  const track = {
    id, path: file, source: 'local', video, mtime: stat.mtimeMs, size: stat.size, inLibrary,
    title: dash.length > 1 ? dash.slice(1).join(' - ') : base, artist: dash.length > 1 ? dash[0] : '', album: path.basename(path.dirname(file)),
    duration: 0, hasCover: false,
  };
  try {
    const { parseFile } = await metadata();
    const info = await parseFile(file, { duration: false, skipCovers: false, skipPostHeaders: true });
    const c = info.common;
    if (c.title) track.title = c.title;
    if (c.artist || c.artists?.length) track.artist = c.artist || c.artists.join(', ');
    if (c.album) track.album = c.album;
    if (info.format.duration) track.duration = Math.round(info.format.duration * 1000);
    track.hasCover = !!c.picture?.length;
  } catch { /* etiketsiz dosya: dosya adı kullanılır */ }
  if (!track.hasCover && !video) track.hasCover = !!folderCover(file);
  tracks.set(id, track); byPath.set(file, id);
  return track;
}

function folderCover(file) {
  const dir = path.dirname(file);
  for (const name of ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'album.jpg']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function scan(folders, onProgress) {
  const files = [];
  for (const f of folders) walk(f, files);
  const keep = new Set(files.map(idFor));
  for (const [id, t] of tracks) if (t.inLibrary && !keep.has(id)) { tracks.delete(id); byPath.delete(t.path); }
  let done = 0;
  for (const file of files) {
    try { await describe(file, true); } catch { /* okunamayan dosya atlanır */ }
    if (++done % 50 === 0) onProgress?.(done, files.length);
  }
  saveIndex();
  return list();
}

const strip = ({ path: _p, mtime: _m, size: _s, inLibrary: _i, ...t }) => t;
const list = () => [...tracks.values()].filter((t) => t.inLibrary).map(strip);

/** Sürükle-bırak veya "Dosya aç" ile gelen dosyalar (kitaplığa yazılmaz). */
async function addFiles(paths) {
  const out = [];
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) { const files = []; walk(p, files); for (const f of files) out.push(strip(await describe(f, false))); }
      else {
        const ext = path.extname(p).toLowerCase();
        if (AUDIO.has(ext) || VIDEO.has(ext)) out.push(strip(await describe(p, false)));
      }
    } catch { /* yok say */ }
  }
  return out;
}

const pathOf = (id) => tracks.get(id)?.path ?? null;

async function cover(id) {
  const t = tracks.get(id);
  if (!t) return null;
  try {
    const { parseFile } = await metadata();
    const info = await parseFile(t.path, { duration: false, skipPostHeaders: true });
    const pic = info.common.picture?.find((p) => /front/i.test(p.type ?? '')) ?? info.common.picture?.[0];
    if (pic) return { data: Buffer.from(pic.data), type: pic.format || 'image/jpeg' };
  } catch { /* kapak yok */ }
  const fc = folderCover(t.path);
  if (fc) return { data: fs.readFileSync(fc), type: fc.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  return null;
}

module.exports = { loadIndex, scan, list, addFiles, pathOf, cover, AUDIO, VIDEO };
