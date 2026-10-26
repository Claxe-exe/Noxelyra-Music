import { LocalEngine, YouTubeEngine, SpotifyEngine } from './engines.js';
import { squareCover, frameCover } from './cover.js';

const nox = window.nox;
const $ = (id) => document.getElementById(id);
const ROW = 48;

const S = {
  info: null, settings: null,
  source: 'local',          // kenar çubuğundaki sekme
  listKey: '',              // seçili liste
  list: { title: '', sub: '', tracks: [] },
  shown: [],                // arama süzgecinden geçen satırlar
  selected: -1,
  queue: [], index: -1, queueSource: null, queueContext: null,
  current: null, engine: null,
  shuffle: false, repeat: 'off', volume: 0.8, muted: false,
  stageFull: false, offscreen: false, seeking: false,
  library: [], ytSignedIn: false, spSignedIn: false, ytPlaylists: [], spPlaylists: [], ytSaved: [], queueList: null,
};

// ---------- yardımcılar ----------
const clock = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let toastTimer;
function toast(text, ms = 3200) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const coverUrl = (t) => {
  if (!t) return '';
  if (t.source === 'local') return t.hasCover ? `${S.info.origin}/cover/${S.info.secret}/${t.id}` : '';
  return t.cover || '';
};
const mediaUrl = (t) => `${S.info.origin}/media/${S.info.secret}/${t.id}`;
const setRange = (el, v, max) => { el.value = v; el.style.setProperty('--p', `${max ? (v / max) * 100 : 0}%`); };

// ---------- motorlar ----------
let local, youtube, spotify;
function emit(type, data) {
  if (type === 'state') { renderPlayState(); pushPlayback(); }
  else if (type === 'ended') onEnded();
  else if (type === 'error') { toast(data, 5000); if (S.current?.source !== 'spotify' && S.queue.length > 1) setTimeout(() => next(true), 1200); }
  else if (type === 'meta' && S.current?.source === 'youtube') {
    // Bağlantıdan açılan videonun gerçek başlığı oynatıcıdan gelir.
    if (data.title && (S.current.title !== data.title || !S.current.artist)) { S.current.title = data.title; S.current.artist = S.current.artist || data.author || data.artist || ''; onTrackChanged(); renderRows(); }
  } else if (type === 'spotify') onSpotifyState(data);
}

// ---------- sıra ve çalma ----------
async function playQueue(tracks, index, context = null) {
  if (!tracks.length) return;
  S.queueList = tracks === S.queue ? S.queueList : null; // kayıtlı listenin kendi satırından çalınırsa bağ korunur
  S.queue = tracks.slice(); S.queueSource = tracks[index]?.source ?? tracks[0].source; S.queueContext = context;
  if (S.shuffle && S.queueSource !== 'spotify') {
    const first = S.queue.splice(index, 1)[0];
    for (let i = S.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [S.queue[i], S.queue[j]] = [S.queue[j], S.queue[i]]; }
    S.queue.unshift(first); index = 0;
  }
  await playIndex(index);
}

async function playIndex(i) {
  if (i < 0 || i >= S.queue.length) return;
  S.index = i;
  const t = S.queue[i];
  const engine = t.source === 'local' ? local : t.source === 'youtube' ? youtube : spotify;
  if (S.engine && S.engine !== engine) S.engine.stop();
  S.engine = engine;
  S.current = t;
  // Panelde gezinirken sahne köşede küçük kalsın; kullanıcı aramaya devam edebilsin.
  if (t.video && (t.source === 'youtube' || t.source === 'local') && !S.stageWasClosed && !S.browsing) S.stageFull = true;
  updateStage();
  onTrackChanged();
  try {
    if (t.source === 'spotify') {
      const uris = S.queue.map((x) => x.uri);
      await spotify.playList(S.queueContext ? null : uris.slice(0, 100), S.queueContext ? i : Math.min(i, 99), S.queueContext);
    } else {
      await engine.load(t, t.source === 'local' ? mediaUrl(t) : null, true);
    }
  } catch (e) { toast(e.message, 5000); }
  renderRows();
}

function next(auto = false) {
  if (!S.current) return;
  if (S.current.source === 'spotify') { spotify.next(); return; }
  if (auto && S.repeat === 'one') { S.engine.seek(0); S.engine.play(); return; }
  if (S.index + 1 < S.queue.length) playIndex(S.index + 1);
  else if (S.repeat === 'all' || !auto) playIndex(0);
}
function previous() {
  if (!S.current) return;
  if (S.current.source === 'spotify') { spotify.previous(); return; }
  if (S.engine.position > 3000 || S.index === 0) { S.engine.seek(0); pushPlayback(); return; }
  playIndex(S.index - 1);
}
function onEnded() {
  if (S.current?.source === 'spotify') return;
  if (S.repeat === 'one') { S.engine.seek(0); S.engine.play(); return; }
  if (S.index + 1 < S.queue.length || S.repeat === 'all') next(true);
  else { renderPlayState(); pushPlayback(); }
}
function toggle() {
  if (!S.current) { if (S.shown.length) playQueue(S.shown, Math.max(0, S.selected)); return; }
  if (S.engine.playing) S.engine.pause(); else S.engine.play();
}
function seekTo(ms) {
  if (!S.engine || !S.engine.seekable) return;
  S.engine.seek(Math.max(0, Math.min(ms, S.engine.duration)));
  setTimeout(() => { renderTime(); pushPlayback(); }, 150);
}

// Spotify sırayı kendi tutar; şu anki parçayı onun durumundan al.
function onSpotifyState(state) {
  const cur = state?.track_window?.current_track;
  if (!cur) return;
  const known = S.queue.findIndex((x) => x.uri === cur.uri || x.uri === cur.linked_from?.uri || x.id === cur.id);
  const changed = !S.current || S.current.uri !== cur.uri;
  if (known >= 0) { S.index = known; S.current = { ...S.queue[known], uri: cur.uri }; }
  else {
    S.current = { source: 'spotify', id: cur.id, uri: cur.uri, title: cur.name, artist: cur.artists.map((a) => a.name).join(', '), album: cur.album?.name ?? '',
      cover: cur.album?.images?.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? '', duration: cur.duration_ms, link: `https://open.spotify.com/track/${cur.id}` };
  }
  S.engine = spotify;
  if (changed) { onTrackChanged(); renderRows(); }
}

// ---------- Windows medya kontrolleri ----------
let metaToken = 0;
async function onTrackChanged() {
  const t = S.current;
  renderNow();
  document.title = t ? `${t.title}${t.artist ? ' — ' + t.artist : ''} · ${S.info.name}` : S.info.name;
  $('mini-title').textContent = t ? `${t.title}${t.artist ? ' — ' + t.artist : ''}` : S.info.name;
  if (!t) { nox.smtc.playback({ status: 'closed' }); return; }
  const token = ++metaToken;
  const base = { title: t.title, artist: t.artist || (t.source === 'youtube' ? 'YouTube' : ''), album: t.album || '', video: !!t.video };
  // Önce kapaksız gönder ki başlık hemen görünsün, sonra kare kapakla (>= 300 px) güncelle.
  nox.smtc.meta({ ...base, cover: '' });
  setMediaSession(base, coverUrl(t));
  const cover = await squareCover(t, coverUrl(t)).catch(() => '');
  if (token !== metaToken) return;
  nox.smtc.meta({ ...base, cover });
  pushPlayback();
  if (t.source === 'local' && t.video && !t.hasCover) {
    // Kapaksız videoda oynamaya başladıktan kısa süre sonra bir kare yakala.
    setTimeout(async () => {
      if (token !== metaToken) return;
      const frame = frameCover($('video'));
      if (!frame) return;
      nox.smtc.meta({ ...base, cover: frame });
      for (const el of [$('art-small'), $('art-big')]) { el.style.backgroundImage = `url("data:image/jpeg;base64,${frame}")`; el.classList.add('has'); }
    }, 2500);
  }
}

let lastPush = 0;
function pushPlayback() {
  const t = S.current, e = S.engine;
  if (!t || !e) return;
  const playing = e.playing;
  const s = {
    source: t.source, video: !!t.video,
    status: playing ? 'playing' : 'paused',
    position: e.position, duration: e.duration || t.duration || 0, seekable: e.seekable,
    canNext: t.source === 'spotify' || S.queue.length > 1 || S.repeat !== 'off', canPrevious: true,
  };
  lastPush = performance.now();
  nox.smtc.playback(s);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (s.duration > 0) try { navigator.mediaSession.setPositionState({ duration: s.duration / 1000, position: Math.min(s.position, s.duration) / 1000, playbackRate: 1 }); } catch { /* yok say */ }
  }
}

// Köprü yoksa Chromium'un kendi SMTC'si bunu yayınlar; köprü varken zararsızdır.
function setMediaSession(base, art) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: base.title, artist: base.artist, album: base.album, artwork: art ? [{ src: art, sizes: '512x512' }] : [] });
}
function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => S.engine?.play());
  ms.setActionHandler('pause', () => S.engine?.pause());
  ms.setActionHandler('nexttrack', () => next());
  ms.setActionHandler('previoustrack', () => previous());
  ms.setActionHandler('seekto', (d) => seekTo(d.seekTime * 1000));
  ms.setActionHandler('seekforward', (d) => seekTo((S.engine?.position ?? 0) + (d.seekOffset ?? 10) * 1000));
  ms.setActionHandler('seekbackward', (d) => seekTo((S.engine?.position ?? 0) - (d.seekOffset ?? 10) * 1000));
}

function onCommand(cmd) {
  const [name, arg] = cmd.split(' ');
  if (name === 'play') S.engine ? S.engine.play() : toggle();
  else if (name === 'pause') S.engine?.pause();
  else if (name === 'toggle') toggle();
  else if (name === 'stop') S.engine?.pause();
  else if (name === 'next') next();
  else if (name === 'previous') previous();
  else if (name === 'seek') seekTo(Number(arg));
}

// ---------- görünüm: oynatıcı çubuğu ----------
function renderNow() {
  const t = S.current;
  $('now-title').textContent = t?.title || 'Bir şey çalmıyor';
  $('now-artist').textContent = t ? (t.artist || (t.source === 'youtube' ? 'YouTube' : '')) : '';
  const url = coverUrl(t);
  for (const el of [$('art-small'), $('art-big')]) { el.style.backgroundImage = url ? `url("${url}")` : ''; el.classList.toggle('has', !!url); }
  $('stage-title').textContent = t?.title ?? ''; $('stage-artist').textContent = t?.artist ?? '';
  const a = $('attribution');
  a.classList.toggle('hidden', !t || t.source === 'local');
  a.classList.toggle('spotify', t?.source === 'spotify');
  a.textContent = t?.source === 'spotify' ? 'Spotify’da aç' : 'YouTube’da aç';
  const yt = t?.source === 'youtube';
  $('btn-away').disabled = yt;
  $('btn-away').title = yt ? 'YouTube videoları görünür oynatıcıda kalmalı (YouTube API politikası III.I.9)' : 'Arka plana al (pencereyi ekran dışına taşır)';
  renderPlayState();
}

function renderPlayState() {
  const playing = !!S.engine?.playing;
  $('btn-play').innerHTML = `<svg><use href="#i-${playing ? 'pause' : 'play'}"/></svg>`;
  $('btn-play').title = playing ? 'Duraklat (Boşluk)' : 'Oynat (Boşluk)';
  renderTime();
}

function renderTime() {
  const e = S.engine;
  const dur = e?.duration || S.current?.duration || 0;
  const pos = e?.position ?? 0;
  $('dur').textContent = clock(dur);
  $('seek').disabled = !e?.seekable;
  if (!S.seeking) { $('pos').textContent = clock(pos); setRange($('seek'), dur ? Math.round((pos / dur) * 1000) : 0, 1000); }
}

function renderModes() {
  $('btn-shuffle').classList.toggle('on', S.shuffle);
  $('btn-repeat').classList.toggle('on', S.repeat !== 'off');
  $('repeat-one').classList.toggle('hidden', S.repeat !== 'one');
  $('btn-repeat').title = `Tekrar: ${({ off: 'kapalı', all: 'tüm liste', one: 'bu parça' })[S.repeat]}`;
  const v = S.muted ? 0 : S.volume;
  setRange($('volume'), Math.round(v * 100), 100);
  $('btn-mute').innerHTML = `<svg><use href="#i-${v === 0 ? 'mute' : 'vol'}"/></svg>`;
}

function applyVolume() {
  const v = S.muted ? 0 : S.volume;
  local?.setVolume(v); youtube?.setVolume(v); spotify?.setVolume(v);
  renderModes();
}

// ---------- sahne ----------
function updateStage() {
  const t = S.current, st = $('stage');
  const visual = t && (t.source === 'youtube' || (t.source === 'local' && t.video));
  st.className = 'stage';
  if (!t || (!visual && !S.stageFull)) { st.classList.add('idle'); return; }
  st.classList.add(S.stageFull ? 'full' : 'mini');
  if (t.source === 'youtube') st.classList.add('youtube');
  else if (t.source === 'local' && t.video) st.classList.add('local-video');
  else st.classList.add('audio');
  $('btn-stage').classList.toggle('on', S.stageFull);
}
function setStageFull(on) { S.stageFull = on; S.stageWasClosed = !on; updateStage(); }

// ---------- liste (sanal kaydırma) ----------
function setList(key, title, sub, tracks, actions = []) {
  S.listKey = key; S.list = { title, sub, tracks }; S.selected = -1;
  $('list-title').textContent = title; $('list-sub').textContent = sub ?? '';
  const box = $('list-actions'); box.innerHTML = '';
  for (const a of [{ label: 'Tümünü çal', primary: true, run: () => playQueue(S.shown, 0), when: tracks.length > 0 }, ...actions]) {
    if (a.when === false) continue;
    const b = document.createElement('button'); b.className = `btn${a.primary ? ' primary' : ''}`; b.textContent = a.label; b.onclick = a.run; box.appendChild(b);
  }
  applyFilter();
  $('rows').scrollTop = 0;
  showView('list');
}

function applyFilter() {
  const q = $('search').value.trim().toLocaleLowerCase('tr');
  const local = S.listKey.startsWith('local');
  S.shown = q && local ? S.list.tracks.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLocaleLowerCase('tr').includes(q)) : S.list.tracks;
  $('rows-spacer').style.height = `${S.shown.length * ROW}px`;
  renderRows();
}

function renderRows() {
  const box = $('rows');
  const from = Math.max(0, Math.floor(box.scrollTop / ROW) - 6), to = Math.min(S.shown.length, from + Math.ceil(box.clientHeight / ROW) + 14);
  const html = [];
  for (let i = from; i < to; i++) {
    const t = S.shown[i];
    const playing = S.current && t.id === S.current.id && t.source === S.current.source;
    const img = coverUrl(t);
    const thumb = img ? `<img loading="lazy" src="${esc(img)}" class="${t.source === 'youtube' ? 'wide' : ''}" alt="">` : `<div class="ph"><svg><use href="#i-${t.video ? 'film' : 'note'}"/></svg></div>`;
    html.push(`<div class="row${playing ? ' playing' : ''}${i === S.selected ? ' sel' : ''}" data-i="${i}" style="top:${i * ROW}px">
      <span class="n">${playing ? '♪' : i + 1}</span>
      <span class="t">${thumb}<span>${esc(t.title)}</span>${t.video && t.source === 'local' ? '<em class="badge">video</em>' : ''}</span>
      <span>${esc(t.artist)}</span><span>${esc(t.album)}</span><span class="r">${t.duration ? clock(t.duration) : ''}</span></div>`);
  }
  box.querySelectorAll('.row').forEach((r) => r.remove());
  box.insertAdjacentHTML('beforeend', html.join(''));
  const empty = $('empty');
  empty.classList.toggle('show', S.shown.length === 0);
  $('rows-head').classList.toggle('hidden', S.shown.length === 0);
}

function showView(v) {
  $('view-list').classList.toggle('hidden', v !== 'list');
  $('view-settings').classList.toggle('hidden', v !== 'settings');
  $('view-browse').classList.toggle('hidden', v !== 'browse');
  S.browsing = v === 'browse';
  document.querySelectorAll('.side-item').forEach((b) => b.classList.toggle('on', v === 'settings' ? b.dataset.view === 'settings' : b.dataset.key === S.listKey));
  if (v === 'settings') { if (S.stageFull) setStageFull(false); renderSettings(); }
  if (v === 'browse') { if (S.stageFull) setStageFull(false); openBrowse(); }
}

// ---------- "YouTube'da ara" paneli ----------
// İlk açılışta rıza metni; onaydan sonra YouTube'un sitesi ayrı oturumda (persist:ytbrowse) yüklenir.
function openBrowse() {
  const consent = $('yb-consent');
  if (!S.settings.ytBrowseConsent) { consent.classList.remove('hidden'); return; }
  consent.classList.add('hidden');
  if ($('yb-host').querySelector('webview')) return;
  const wv = document.createElement('webview');
  wv.setAttribute('partition', 'persist:ytbrowse');
  wv.setAttribute('src', 'https://www.youtube.com/');
  wv.addEventListener('ipc-message', (e) => { if (e.channel === 'nox-play') playFromBrowse(e.args[0]); });
  $('yb-host').appendChild(wv);
}

let lastBrowse = { url: '', at: 0 };
function playFromBrowse(url) {
  // Ön yükleme betiği ve ana işlemdeki yedek yol aynı tıklamayı iki kez bildirebilir.
  if (url === lastBrowse.url && Date.now() - lastBrowse.at < 2000) return;
  lastBrowse = { url, at: Date.now() };
  youtubeFromLink(url, false);
}

function bindBrowse() {
  $('yb-agree').addEventListener('change', (e) => { $('yb-ok').disabled = !e.target.checked; });
  $('yb-ok').addEventListener('click', async () => {
    await nox.settings.set({ ytBrowseConsent: true });
    S.settings = await nox.settings.get();
    openBrowse();
  });
  $('yb-cancel').addEventListener('click', () => openList('yt:link'));
  $('yb-consent').querySelectorAll('[data-ext]').forEach((a) => a.addEventListener('click', () => nox.openExternal(a.dataset.ext)));
  $('yb-back').addEventListener('click', () => { const wv = $('yb-host').querySelector('webview'); if (wv?.canGoBack()) wv.goBack(); });
  $('yb-home').addEventListener('click', () => $('yb-host').querySelector('webview')?.loadURL('https://www.youtube.com/'));
  nox.ytbrowse.onPlay(playFromBrowse);
  nox.ytbrowse.onSignIn(() => toast('Bu panelde hesapla giriş yapılamaz. Arama ve izlemek için giriş gerekmez.', 6000));
}

// ---------- kenar çubuğu ve kaynaklar ----------
function renderNav() {
  const names = { local: 'Kitaplık', youtube: 'YouTube', spotify: 'Spotify' };
  $('nav').innerHTML = S.info.sources.length > 1 ? S.info.sources.map((s) => `<button class="tab${s === S.source ? ' on' : ''}" data-src="${s}">${names[s]}</button>`).join('') : '';
  const items = [];
  if (S.source === 'local') {
    const music = S.library.filter((t) => !t.video).length, video = S.library.length - music;
    items.push(['local:all', 'list', 'Tüm parçalar', S.library.length], ['local:music', 'note', 'Müzik', music], ['local:video', 'film', 'Videolar', video]);
  } else if (S.source === 'youtube') {
    items.push(['yt:browse', 'search', 'YouTube’da ara'], ['yt:link', 'link', 'Bağlantı aç']);
    for (const p of S.ytSaved) items.push([`yt:saved:${p.id}`, 'list', p.title]);
    for (const p of S.ytPlaylists) items.push([`yt:pl:${p.id}`, p.title.startsWith('Beğendiğim') ? 'heart' : 'list', p.title, p.count]);
  } else {
    for (const p of S.spPlaylists) items.push([`sp:pl:${p.id}`, p.id === 'liked' ? 'heart' : 'list', p.title]);
  }
  items.push(['queue', 'list', 'Sıradakiler', S.queue.length || '']);
  $('side-title').textContent = S.source === 'local' ? 'Kitaplık' : 'Listeler';
  $('side-list').innerHTML = items.map(([key, icon, title, count]) =>
    `<button class="side-item${key === S.listKey ? ' on' : ''}" data-key="${esc(key)}"><svg><use href="#i-${icon}"/></svg><span>${esc(title)}</span>${count != null && count !== '' ? `<small>${count}</small>` : ''}${key.startsWith('yt:saved:') ? `<i class="rm" data-unsave="${esc(key.slice(9))}" title="Listeyi kaldır">×</i>` : ''}</button>`).join('');
  $('search').placeholder = S.source === 'local' ? 'Kitaplıkta ara' : S.source === 'youtube' ? (S.ytSignedIn ? 'YouTube’da ara (Enter) veya bağlantı yapıştır' : 'YouTube bağlantısı yapıştır (Enter)') : (S.spSignedIn ? 'Spotify’da ara (Enter)' : 'Önce Ayarlar’dan Spotify’a bağlan');
}

async function openList(key) {
  $('panel').innerHTML = '';
  if (key === 'queue') { setList('queue', 'Sıradakiler', S.queue.length ? `${S.queue.length} parça` : '', S.queue); emptyText('Sıra boş.'); return; }
  if (key.startsWith('local:')) {
    const kind = key.split(':')[1];
    const tracks = S.library.filter((t) => kind === 'all' || (kind === 'video' ? t.video : !t.video));
    setList(key, ({ all: 'Tüm parçalar', music: 'Müzik', video: 'Videolar' })[kind], `${tracks.length} öğe`, tracks,
      [{ label: 'Dosya aç', run: openFiles }, { label: 'Klasör ekle', run: addFolder }]);
    emptyText(S.settings.folders.length ? 'Bu klasörlerde çalınabilir dosya bulunamadı.<br><button class="btn" data-act="folder">Klasör ekle</button>' : 'Henüz klasör yok.<br><button class="btn primary" data-act="folder">Müzik klasörü ekle</button>');
    return;
  }
  if (key === 'yt:browse') { S.listKey = key; renderNav(); showView('browse'); return; }
  if (key === 'yt:link') { openYouTubeLink(); return; }
  if (key.startsWith('yt:saved:')) {
    // Kayıtlı liste: tıklayınca çalar. Video kimlikleri saklanmaz, her seferinde YouTube'dan okunur.
    const id = key.slice(9), p = S.ytSaved.find((x) => x.id === id);
    const tracks = S.queueList === id ? S.queue : [];
    setList(key, p?.title ?? 'YouTube listesi', tracks.length ? `${tracks.length} video` : 'Açılıyor…', tracks);
    renderNav();
    if (S.queueList !== id) youtubeFromLink(`https://www.youtube.com/playlist?list=${id}`, false);
    return;
  }
  if (key.startsWith('yt:pl:')) {
    const id = key.slice(6), p = S.ytPlaylists.find((x) => x.id === id);
    setList(key, p?.title ?? 'Liste', 'Yükleniyor…', []);
    try { const tracks = await nox.yt.items(id); if (S.listKey === key) setList(key, p?.title ?? 'Liste', `${tracks.length} video`, tracks); }
    catch (e) { toast(e.message, 5000); $('list-sub').textContent = e.message; }
    return;
  }
  if (key.startsWith('sp:pl:')) {
    const id = key.slice(6), p = S.spPlaylists.find((x) => x.id === id);
    setList(key, p?.title ?? 'Liste', 'Yükleniyor…', []);
    const playContext = p?.uri ? [{ label: 'Listeyi çal', run: () => playSpotifyContext(p) }] : [];
    try { const tracks = await nox.sp.items(id); if (S.listKey === key) setList(key, p?.title ?? 'Liste', `${tracks.length} şarkı · Spotify`, tracks, playContext); }
    catch (e) { if (S.listKey === key) { setList(key, p?.title ?? 'Liste', e.message, [], playContext); emptyText(esc(e.message)); } }
  }
}

function emptyText(html) {
  $('empty').innerHTML = html;
  $('empty').querySelector('[data-act=folder]')?.addEventListener('click', addFolder);
  $('empty').querySelector('[data-act=settings]')?.addEventListener('click', () => showView('settings'));
  $('empty').querySelector('[data-act=login]')?.addEventListener('click', () => (S.source === 'youtube' ? ytLogin() : spLogin()));
}

async function playSpotifyContext(p) {
  // İçeriği okunamayan listeler de bağlamıyla (context_uri) çalınabilir; sıra Spotify'dadır.
  S.queue = []; S.queueSource = 'spotify'; S.queueContext = p.uri; S.index = 0;
  try { await spotify.playList(null, 0, p.uri); S.engine = spotify; } catch (e) { toast(e.message, 5000); }
}

// YouTube bağlantıları: video (watch, youtu.be, shorts, music.youtube.com) veya oynatma listesi.
function parseYouTube(text) {
  try {
    const u = new URL(text.trim());
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(u.hostname)) return null;
    const list = u.searchParams.get('list');
    let v = u.searchParams.get('v');
    if (!v && u.hostname.endsWith('youtu.be')) v = u.pathname.slice(1);
    if (!v) { const m = /^\/(shorts|embed|live)\/([\w-]{11})/.exec(u.pathname); if (m) v = m[2]; }
    v = v && /^[\w-]{11}$/.test(v) ? v : null;
    // "RD…" YouTube'un otomatik Mix listesidir: gömülü oynatıcıda başka videoyla başlar ve kaydedilmeye değmez.
    // Videoyla birlikte gelirse yalnız video çalınır.
    const keepList = list && /^[\w-]+$/.test(list) && !(v && list.startsWith('RD'));
    return { v, list: keepList ? list : null };
  } catch { return /^[\w-]{11}$/.test(text.trim()) ? { v: text.trim(), list: null } : null; }
}

function openYouTubeLink() {
  setList('yt:link', 'YouTube', S.ytSignedIn ? 'Bağlantı yapıştır, ara ya da soldan bir listeni seç.' : 'YouTube veya YouTube Music’te şarkıyı ya da listeyi aç → Paylaş → Bağlantıyı kopyala → buraya yapıştır.', S.ytLast ?? []);
  $('panel').innerHTML = `<input id="yt-url" class="field" placeholder="https://www.youtube.com/watch?v=…  veya  …&list=…" spellcheck="false"><button class="btn primary" id="yt-go">Çal</button><button class="btn" id="yt-add">Sıraya ekle</button>`;
  $('yt-go').onclick = () => youtubeFromLink($('yt-url').value, false);
  $('yt-add').onclick = () => youtubeFromLink($('yt-url').value, true);
  $('yt-url').onkeydown = (e) => { if (e.key === 'Enter') youtubeFromLink($('yt-url').value, false); };
  emptyText(S.ytSignedIn ? 'Arama sonuçları burada görünür.' : 'YouTube videoları uygulamanın içindeki resmi YouTube oynatıcısında, reklam ve logosuyla birlikte görünür oynar.');
}

async function youtubeFromLink(text, append) {
  const p = parseYouTube(text);
  if (!p || (!p.v && !p.list)) { toast('Bu bir YouTube bağlantısı değil. YouTube’da videoyu ya da listeyi açıp adres çubuğundaki bağlantıyı kopyala.', 6000); return; }
  const make = (ids) => ids.map((id) => ({ source: 'youtube', id, title: 'YouTube videosu', artist: '', album: 'YouTube', cover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, video: true, duration: 0 }));
  let tracks;
  if (p.list && !append) {
    // Listeyi doğrudan görünür oynatıcıda başlat; YouTube gizli oynatıcıya liste yüklemiyor.
    toast('Liste açılıyor…', 15000);
    if (S.engine && S.engine !== youtube) S.engine.stop();
    S.stageFull = !S.browsing; S.stageWasClosed = false;
    $('stage').className = `stage ${S.stageFull ? 'full' : 'mini'} youtube`;
    const ids = await youtube.loadList(p.list, p.v).catch(() => []);
    if (ids.length) {
      tracks = make(ids);
      const at = Math.max(0, youtube.player.getPlaylistIndex?.() ?? 0);
      S.queue = tracks; S.queueSource = 'youtube'; S.queueContext = null; S.index = at;
      S.engine = youtube; S.current = tracks[at]; youtube.track = S.current;
      updateStage(); onTrackChanged();
      S.queueList = p.list;
      // Listeyi sol menüye kaydet; uygulama kapanıp açılınca da orada kalır.
      const isNew = !S.ytSaved.some((x) => x.id === p.list);
      S.ytSaved = await nox.yt.save(p.list).catch(() => S.ytSaved);
      if (S.listKey === 'yt:link') S.listKey = `yt:saved:${p.list}`;
      renderNav();
      toast(isNew ? `${ids.length} video yüklendi, liste sol menüye kaydedildi.` : `${ids.length} video yüklendi.`);
    } else if (p.v) {
      toast('Liste açılamadı, yalnız bu video çalıyor.', 5000);
      tracks = make([p.v]);
      await playQueue(tracks, 0);
    } else {
      updateStage();
      toast('Bu liste açılamadı. Liste gizli (özel) olabilir ya da YouTube’un otomatik “Mix” listesi olabilir. YouTube’da listeyi “Herkese açık” veya “Liste dışı” yapıp tekrar dene.', 9000);
      return;
    }
  } else {
    if (p.list && !p.v) { toast('Listeyi sıraya eklemek yerine “Çal” ile aç.', 5000); return; }
    tracks = make([p.v]);
    if (append && S.queue.length && S.queueSource === 'youtube') { S.queue.push(...tracks); toast('Sıraya eklendi.'); }
    else await playQueue(tracks, 0);
  }
  S.ytLast = tracks;
  if (S.listKey === 'yt:link') setList('yt:link', 'YouTube', `${tracks.length} video`, tracks);
  else if (p.list && S.listKey === `yt:saved:${p.list}`) setList(S.listKey, S.ytSaved.find((x) => x.id === p.list)?.title ?? 'YouTube listesi', `${tracks.length} video`, tracks);
  // Başlıkları resmi oEmbed uç noktasından doldur (giriş gerektirmez).
  for (let i = 0; i < tracks.length; i += 4) {
    await Promise.all(tracks.slice(i, i + 4).map(async (t) => {
      const info = await nox.yt.oembed(t.id).catch(() => null);
      if (info) { t.title = info.title; t.artist = info.artist; if (S.current === t) onTrackChanged(); }
    }));
    renderRows();
  }
}

async function runSearch() {
  const q = $('search').value.trim();
  if (!q) return;
  if (S.source === 'youtube') {
    if (parseYouTube(q)?.v || parseYouTube(q)?.list) { $('search').value = ''; youtubeFromLink(q, false); return; }
    if (!S.ytSignedIn) {
      toast(S.settings.googleBuiltIn || S.settings.googleClientId
        ? 'Arama için Ayarlar’dan “Google ile giriş yap”a bas. Bağlantı yapıştırmak girişsiz çalışır.'
        : 'Arama için Google girişi gerekiyor. Şimdilik YouTube’dan şarkının ya da listenin bağlantısını kopyalayıp buraya yapıştır.', 6000);
      return;
    }
    setList('yt:search', `“${q}”`, 'Aranıyor…', []);
    try { const r = await nox.yt.search(q); S.ytLast = r; setList('yt:search', `“${q}”`, `${r.length} sonuç · YouTube`, r); } catch (e) { toast(e.message, 5000); }
  } else if (S.source === 'spotify') {
    if (!S.spSignedIn) { showView('settings'); return; }
    setList('sp:search', `“${q}”`, 'Aranıyor…', []);
    try { const r = await nox.sp.search(q); setList('sp:search', `“${q}”`, `${r.length} sonuç · Spotify`, r); } catch (e) { toast(e.message, 5000); }
  }
}

// ---------- yerel kitaplık ----------
async function refreshLibrary(scan = false) {
  if (!S.info.sources.includes('local')) return;
  const r = await nox.lib.list();
  S.settings.folders = r.folders; S.library = r.tracks;
  if (scan) {
    $('list-sub').textContent = 'Klasörler taranıyor…';
    S.library = await nox.lib.scan().catch(() => S.library);
  }
  if (S.source === 'local') { renderNav(); if (S.listKey.startsWith('local')) openList(S.listKey); }
}
async function addFolder() { const f = await nox.lib.addFolder(); if (f) { S.settings.folders = f; await refreshLibrary(true); if (!$('view-settings').classList.contains('hidden')) renderSettings(); } }
async function openFiles() { const t = await nox.lib.openFiles(); if (t.length) playQueue(t, 0); }

// ---------- hesaplar ----------
async function ytLogin() {
  if (!S.settings.googleClientId && !S.settings.googleBuiltIn) { showView('settings'); toast('Google girişi bu sürümde ayarlanmamış. Bağlantı yapıştırarak çalabilirsin.', 6000); return; }
  toast('Tarayıcında Google girişi açıldı…', 6000);
  try { await nox.yt.login(); S.ytSignedIn = true; toast('YouTube hesabı bağlandı.'); await loadYouTubeLists(); } catch (e) { toast(e.message, 6000); }
  renderSettings();
}
async function loadYouTubeLists() {
  if (!S.ytSignedIn) { S.ytPlaylists = []; return; }
  try { S.ytPlaylists = await nox.yt.playlists(); } catch (e) { toast(e.message, 5000); }
  if (S.source === 'youtube') renderNav();
}
async function spLogin() {
  if (!S.settings.spotifyClientId) { showView('settings'); toast('Önce Spotify Client ID gir.'); return; }
  toast('Tarayıcında Spotify girişi açıldı…', 6000);
  try { await nox.sp.login(); S.spSignedIn = true; toast('Spotify bağlandı.'); await afterSpotifyLogin(); } catch (e) { toast(e.message, 6000); }
  renderSettings();
}
async function afterSpotifyLogin() {
  try { S.spPlaylists = await nox.sp.playlists(); } catch (e) { toast(e.message, 5000); }
  renderNav();
  spotify.init().catch((e) => toast(e.message, 7000));
  if (!S.listKey.startsWith('sp:') && S.spPlaylists[0]) openList(`sp:pl:${S.spPlaylists[0].id}`);
}

// ---------- ayarlar ----------
// Güncelleme durumunu Ayarlar'daki satıra ve gerektiğinde bildirime yaz.
function showUpdate(s) {
  const text = ({
    checking: 'Denetleniyor…',
    latest: `En son sürümü kullanıyorsun (${s.version}).`,
    downloading: `Yeni sürüm ${s.version ?? ''} indiriliyor… %${s.percent ?? 0}`,
    installing: `Sürüm ${s.version} kuruluyor; uygulama birazdan kapanıp yeniden açılacak.`,
    error: s.message,
  })[s.state] ?? '';
  if (s.state === 'downloading' && !s.version) S.updateText = (S.updateText ?? '').replace(/%\d+$/, `%${s.percent ?? 0}`);
  else S.updateText = text;
  const el = $('upd-status');
  if (el) { el.textContent = S.updateText; el.className = s.state === 'error' ? 'warn' : s.state === 'latest' ? 'ok' : 'muted'; }
  const btn = $('upd-check');
  if (btn) btn.disabled = ['checking', 'downloading', 'installing'].includes(s.state);
  if (['latest', 'installing', 'error'].includes(s.state)) toast(S.updateText, 6000);
}

function renderSettings() {
  const v = $('view-settings');
  const parts = [`<div class="set"><h1>Ayarlar</h1><p class="muted">${esc(S.info.name)} ${esc(S.info.version)} · Windows medya kontrolleri: ${esc(S.info.smtc)}</p>`];
  if (S.info.sources.includes('local')) {
    parts.push(`<div class="card"><h2>Müzik klasörleri</h2><p>Bu klasörler (alt klasörleriyle) taranır. Dosyalar yerinde kalır, hiçbir yere yüklenmez.</p>
      ${S.settings.folders.map((f) => `<div class="folder"><svg><use href="#i-folder"/></svg><span>${esc(f)}</span><button class="btn" data-rm="${esc(f)}">Kaldır</button></div>`).join('') || '<p class="warn">Klasör yok.</p>'}
      <div class="rowline"><button class="btn primary" id="set-add">Klasör ekle</button><button class="btn" id="set-scan">Yeniden tara</button></div></div>`);
  }
  if (S.info.sources.includes('youtube')) {
    const ready = S.settings.googleBuiltIn || !!S.settings.googleClientId;
    const account = S.ytSignedIn
      ? '<span class="ok">Google hesabın bağlı</span><button class="btn" id="g-out">Çıkış yap</button>'
      : ready ? '<button class="btn primary" id="g-in">Google ile giriş yap</button>' : '';
    parts.push(`<div class="card"><h2>YouTube</h2>
      <p><b>Giriş yapmadan kullanabilirsin.</b> YouTube veya YouTube Music’te bir şarkıyı ya da listeyi aç, <b>Paylaş → Bağlantıyı kopyala</b> de, sonra soldaki <b>Bağlantı aç</b>’a (veya üstteki kutuya) yapıştır.</p>
      <p>Bazı şarkıları sahipleri (genelde plak şirketleri) YouTube dışında çaldırmıyor; uygulama onları otomatik atlar. Gizli (özel) listeler ve YouTube’un otomatik “Mix” listeleri açılmaz; listeyi “Herkese açık” ya da “Liste dışı” yap.</p>
      <div class="rowline"><label class="switch"><input type="checkbox" id="mini-toggle"${S.settings.miniOnMinimize !== false ? ' checked' : ''}><span>Küçültünce mini oynatıcıya geç</span></label></div>
      <p id="mini-note" class="${S.settings.miniOnMinimize !== false ? 'muted' : 'warn'}">${S.settings.miniOnMinimize !== false
        ? 'YouTube çalarken pencereyi küçültürsen köşede her zaman üstte duran küçük bir oynatıcıya dönüşür; video Noxelyra adasında görünmeye devam eder. Üstteki şeride tıklayınca pencere geri gelir.'
        : 'Kapalı: pencere normal şekilde küçülür. Küçültülmüş pencerenin videosu Noxelyra adasında görünmez (yalnız kapak çıkar).'}</p>
      ${account ? `<p>Arama yapmak ve kendi listelerini görmek için Google hesabınla giriş yapabilirsin (isteğe bağlı). Giriş Google’ın kendi sayfasında yapılır; parolan bu uygulamaya gelmez.</p><div class="rowline">${account}</div>` : ''}
      <details class="adv"><summary>Gelişmiş: arama ve hesap listeleri için Google projesi</summary>
      <p>Arama ve hesap listeleri Google’ın resmi API’siyle çalışır; Google bunun için ücretsiz bir proje ister. Bunu bir kez uygulamayı dağıtan kişi yapar: bilgileri <code>config/google.json</code> ile pakete koyarsa kullanıcılar yalnız “Google ile giriş yap” düğmesini görür.</p>
      <ol><li><a data-ext="https://console.cloud.google.com/apis/library/youtube.googleapis.com">Google Cloud Console</a>’da bir proje aç, <b>YouTube Data API v3</b>’ü etkinleştir.</li>
      <li>OAuth izin ekranını “Harici / Test” olarak oluştur, kendi Google hesabını test kullanıcısı ekle.</li>
      <li>Kimlik bilgileri → OAuth istemci kimliği → tür <b>Masaüstü uygulaması</b>. Client ID ve Client secret’ı buraya yapıştır.</li></ol>
      <div class="rowline"><input id="g-id" class="field" placeholder="Client ID (….apps.googleusercontent.com)" value="${esc(S.settings.googleClientId)}" spellcheck="false"></div>
      <div class="rowline"><input id="g-secret" class="field" type="password" placeholder="${S.settings.hasGoogleSecret ? 'Client secret kayıtlı (değiştirmek için yaz)' : 'Client secret'}" spellcheck="false"><button class="btn" id="g-save">Kaydet</button></div></details>
      <p class="small">Kurallar gereği videolar her zaman görünür YouTube oynatıcısında oynar; indirilmez, reklamlar engellenmez, YouTube çalarken “arka plana al” kapalıdır. Kullanarak <a data-ext="https://www.youtube.com/t/terms">YouTube Hizmet Şartları</a>’nı kabul etmiş olursun (<a data-ext="https://policies.google.com/privacy">Google Gizlilik Politikası</a>). Google izinlerini <a data-ext="https://myaccount.google.com/permissions">hesabından</a> kaldırabilirsin.</p></div>`);
  }
  if (S.info.sources.includes('spotify')) {
    parts.push(`<div class="card"><h2>Spotify</h2>
      <p>Spotify şarkıları resmi <b>Web Playback SDK</b> ile bu uygulamanın içinde çalar. Spotify bunun için <b>Premium</b> hesap ve kendi geliştirici uygulamanı ister (geliştirme modunda en çok 5 kullanıcı).</p>
      <ol><li><a data-ext="https://developer.spotify.com/dashboard">developer.spotify.com/dashboard</a>’da “Create app”. API olarak <b>Web API</b> ve <b>Web Playback SDK</b> seç.</li>
      <li>Redirect URI olarak tam olarak şunu ekle: <code>${esc(S.info.origin)}/oauth/spotify</code></li>
      <li>Client ID’yi aşağıya yapıştır. (Client secret gerekmez; giriş PKCE ile yapılır.)</li></ol>
      <div class="rowline"><input id="s-id" class="field" placeholder="Spotify Client ID" value="${esc(S.settings.spotifyClientId)}" spellcheck="false"><button class="btn" id="s-save">Kaydet</button></div>
      <div class="rowline">${S.spSignedIn ? '<span class="ok">Bağlı</span><button class="btn" id="s-out">Bağlantıyı kes</button> <a data-ext="https://www.spotify.com/account/apps/">Spotify’da izni kaldır</a>' : '<button class="btn primary" id="s-in">Spotify ile giriş yap</button>'}</div>
      <p>İçerik ve kapaklar Spotify’dan gelir; çalan parça “Spotify’da aç” bağlantısıyla Spotify’a bağlanır. Şarkılar indirilmez, kaydedilmez, başka seslerle karıştırılmaz. Spotify içeriği <a data-ext="https://www.spotify.com/legal/end-user-agreement/">Spotify Kullanım Koşulları</a>’na tabidir.</p></div>`);
  }
  parts.push(`<div class="card"><h2>Güncellemeler</h2>
    <p>Sürüm <b>${esc(S.info.version)}</b>. Düğmeye basınca GitHub’daki son sürüme bakılır; yeni sürüm varsa indirilir, doğrulanır, kendiliğinden kurulur ve uygulama yeniden açılır. Ayarların ve listelerin korunur.</p>
    <div class="rowline"><button class="btn primary" id="upd-check">Güncellemeleri denetle</button><span id="upd-status" class="muted">${esc(S.updateText ?? '')}</span></div></div>`);
  parts.push(`<div class="card"><h2>Gizlilik</h2>
    <p>Telemetri, analiz veya gizli istek yok. Uygulamanın yaptığı ağ istekleri yalnız şunlardır: ${S.info.sources.includes('youtube') ? 'YouTube oynatıcısı ve (girişliysen) YouTube Data API; Google girişi' : ''}${S.info.sources.includes('spotify') ? 'Spotify girişi, Spotify Web API ve Web Playback SDK; Spotify’ın şifreli akışı için Widevine bileşeni (Google’ın güncelleme sunucusundan, castLabs Electron üzerinden)' : ''}; yalnız “Güncellemeleri denetle”ye basınca GitHub. Yerel dosyalar bilgisayarından çıkmaz.</p>
    <p>Giriş belirteçleri Windows’un şifreleme hizmetiyle (DPAPI) bu bilgisayarda saklanır. Hesap verilerin (listeler, arama sonuçları) diske yazılmaz.</p></div>
    <div class="card"><h2>Noxelyra uyumu</h2>
    <p>Uygulama kimliği (AppUserModelID): <code>${esc(S.info.name)}</code> — exe adıyla aynı. Ses bu uygulamanın kendi işleminden, Windows’un paylaşımlı ses oturumuyla çalınır. Pencere başlığı çalan parçanın adını içerir; video başka pencerelerin altında da çizilmeye devam eder.</p></div></div>`);
  v.innerHTML = parts.join('');

  v.querySelectorAll('[data-ext]').forEach((a) => a.addEventListener('click', () => nox.openExternal(a.dataset.ext)));
  v.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => { S.settings.folders = await nox.lib.removeFolder(b.dataset.rm); renderSettings(); refreshLibrary(true); }));
  $('set-add')?.addEventListener('click', addFolder);
  $('set-scan')?.addEventListener('click', () => { toast('Taranıyor…'); refreshLibrary(true).then(() => toast(`${S.library.length} öğe bulundu.`)); });
  $('g-save')?.addEventListener('click', async () => {
    const patch = { googleClientId: $('g-id').value.trim() };
    if ($('g-secret').value.trim()) patch.googleClientSecret = $('g-secret').value.trim();
    await nox.settings.set(patch); S.settings = await nox.settings.get(); toast('Kaydedildi.'); renderSettings();
  });
  $('g-in')?.addEventListener('click', ytLogin);
  $('upd-check')?.addEventListener('click', () => { $('upd-check').disabled = true; nox.update.check().catch((e) => showUpdate({ state: 'error', message: e.message })); });
  $('mini-toggle')?.addEventListener('change', async (e) => {
    await nox.settings.set({ miniOnMinimize: e.target.checked });
    S.settings = await nox.settings.get();
    renderSettings();
  });
  $('g-out')?.addEventListener('click', async () => { await nox.yt.logout(); S.ytSignedIn = false; S.ytPlaylists = []; renderNav(); renderSettings(); toast('Çıkış yapıldı, izin geri alındı.'); });
  $('s-save')?.addEventListener('click', async () => { await nox.settings.set({ spotifyClientId: $('s-id').value.trim() }); S.settings = await nox.settings.get(); toast('Kaydedildi.'); renderSettings(); });
  $('s-in')?.addEventListener('click', spLogin);
  $('s-out')?.addEventListener('click', async () => { spotify.pause(); await nox.sp.logout(); S.spSignedIn = false; S.spPlaylists = []; renderNav(); renderSettings(); toast('Spotify bağlantısı kesildi.'); });
}

// ---------- olaylar ----------
function bind() {
  $('nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]'); if (!b) return;
    S.source = b.dataset.src; $('search').value = ''; renderNav();
    openList(S.source === 'local' ? 'local:all' : S.source === 'youtube' ? 'yt:browse' : (S.spPlaylists[0] ? `sp:pl:${S.spPlaylists[0].id}` : 'queue'));
  });
  $('side-list').addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-unsave]');
    if (rm) {
      e.stopPropagation();
      S.ytSaved = await nox.yt.unsave(rm.dataset.unsave);
      if (S.listKey === `yt:saved:${rm.dataset.unsave}`) S.listKey = 'yt:link';
      renderNav(); toast('Liste kaldırıldı.');
      return;
    }
    const b = e.target.closest('[data-key]'); if (b) { $('search').value = ''; openList(b.dataset.key); }
  });
  document.querySelector('.settings-link').addEventListener('click', () => showView('settings'));

  const rows = $('rows');
  rows.addEventListener('scroll', () => requestAnimationFrame(renderRows), { passive: true });
  new ResizeObserver(() => renderRows()).observe(rows);
  rows.addEventListener('click', (e) => { const r = e.target.closest('.row'); if (r) { S.selected = Number(r.dataset.i); renderRows(); } });
  rows.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.row'); if (!r) return;
    const i = Number(r.dataset.i);
    if (S.listKey === 'queue') playIndex(S.queue.indexOf(S.shown[i]));
    else playQueue(S.shown, i, null);
  });
  rows.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); S.selected = Math.max(0, Math.min(S.shown.length - 1, S.selected + (e.key === 'ArrowDown' ? 1 : -1))); renderRows(); }
    if (e.key === 'Enter' && S.selected >= 0) playQueue(S.shown, S.selected);
  });

  $('search').addEventListener('input', () => { if (S.listKey.startsWith('local')) applyFilter(); });
  $('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); if (e.key === 'Escape') { $('search').value = ''; applyFilter(); $('search').blur(); } });

  $('btn-play').onclick = toggle;
  $('btn-next').onclick = () => next();
  $('btn-prev').onclick = previous;
  $('btn-shuffle').onclick = () => {
    S.shuffle = !S.shuffle; renderModes(); nox.settings.set({ shuffle: S.shuffle });
    if (S.current?.source === 'spotify' && spotify.device) nox.sp.shuffle(spotify.device, S.shuffle).catch((e) => toast(e.message));
  };
  $('btn-repeat').onclick = () => {
    S.repeat = ({ off: 'all', all: 'one', one: 'off' })[S.repeat]; renderModes(); nox.settings.set({ repeat: S.repeat }); pushPlayback();
    if (S.current?.source === 'spotify' && spotify.device) nox.sp.repeat(spotify.device, ({ off: 'off', all: 'context', one: 'track' })[S.repeat]).catch((e) => toast(e.message));
  };
  const seek = $('seek');
  seek.addEventListener('input', () => { S.seeking = true; const d = S.engine?.duration ?? 0; $('pos').textContent = clock((seek.value / 1000) * d); seek.style.setProperty('--p', `${seek.value / 10}%`); });
  seek.addEventListener('change', () => { S.seeking = false; seekTo((seek.value / 1000) * (S.engine?.duration ?? 0)); });
  let volSave;
  $('volume').addEventListener('input', (e) => { S.volume = e.target.value / 100; S.muted = false; applyVolume(); clearTimeout(volSave); volSave = setTimeout(() => nox.settings.set({ volume: S.volume }), 400); });
  $('btn-mute').onclick = () => { S.muted = !S.muted; applyVolume(); };
  $('btn-stage').onclick = () => setStageFull(!S.stageFull);
  $('stage-close').onclick = () => setStageFull(false);
  $('art-small').onclick = () => { if (S.current) setStageFull(true); };
  $('btn-away').onclick = async () => { if (S.current?.source === 'youtube') return; await nox.win.offscreen(); };
  $('attribution').onclick = () => {
    const t = S.current; if (!t) return;
    nox.openExternal(t.source === 'spotify' ? (t.link || `https://open.spotify.com/track/${t.id}`) : `https://www.youtube.com/watch?v=${t.id}`);
  };
  nox.win.onOffscreen((on) => { S.offscreen = on; });
  nox.win.onMini((on) => { S.mini = on; document.body.classList.toggle('mini', on); updateStage(); });
  // Mini şerit: sürükleyince pencereyi taşır, sürüklemeden bırakınca normal pencereye döner.
  const bar = $('minibar');
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    bar.setPointerCapture(e.pointerId);
    drag = { x: e.screenX, y: e.screenY, moved: false };
    nox.win.miniDrag('start');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    nox.win.miniDrag('move', dx, dy);
  });
  const release = () => {
    if (!drag) return;
    const moved = drag.moved; drag = null;
    nox.win.miniDrag('end');
    if (!moved) nox.win.exitMini();
  };
  bar.addEventListener('pointerup', release);
  bar.addEventListener('pointercancel', () => { drag = null; nox.win.miniDrag('end'); });
  nox.smtc.onCommand(onCommand);
  nox.update.onStatus(showUpdate);
  nox.lib.onProgress(({ done, total }) => { if (S.listKey.startsWith('local')) $('list-sub').textContent = `Taranıyor… ${done}/${total}`; });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight' && !e.target.closest('.rows')) seekTo((S.engine?.position ?? 0) + 10000);
    else if (e.key === 'ArrowLeft' && !e.target.closest('.rows')) seekTo((S.engine?.position ?? 0) - 10000);
    else if (e.key === 'Escape' && S.stageFull) setStageFull(false);
    else if (e.key === 'f' && e.ctrlKey) { e.preventDefault(); $('search').focus(); }
    else if (e.key === 'MediaTrackNext') next();
  });

  // Sürükle-bırak: dosya veya klasör bırakılınca çalar (yalnız yerel sürüm).
  if (S.info.sources.includes('local')) {
    let depth = 0;
    document.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; $('drop').classList.remove('hidden'); } });
    document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('drop').classList.add('hidden'); } });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; $('drop').classList.add('hidden');
      const paths = [...e.dataTransfer.files].map((f) => nox.pathForFile(f)).filter(Boolean);
      const tracks = await nox.lib.addFiles(paths);
      if (tracks.length) { S.source = 'local'; renderNav(); playQueue(tracks, 0); } else toast('Çalınabilir dosya yok.');
    });
  }

  // Oynarken zaman çizelgesini her saniye yenile (SMTC konumu ve çubuk).
  setInterval(() => {
    if (!S.engine?.playing) return;
    renderTime();
    if (performance.now() - lastPush > 950) pushPlayback();
  }, 250);
}

// ---------- başlangıç ----------
async function start() {
  S.info = await nox.info();
  S.settings = await nox.settings.get();
  S.shuffle = !!S.settings.shuffle; S.repeat = S.settings.repeat || 'off'; S.volume = S.settings.volume ?? 0.8;
  // Sıfırda kaydedilmiş ses düzeyiyle sessiz açılma (ses 0'ken Windows ses oturumu da açılmaz).
  if (!(S.volume >= 0.02)) S.volume = 0.5;
  document.body.classList.add(`edition-${S.info.edition}`);
  $('app-name').textContent = S.info.name;
  document.title = S.info.name;
  S.source = S.info.sources[0];

  local = new LocalEngine($('video'), emit);
  youtube = new YouTubeEngine('yt-player', emit);
  spotify = new SpotifyEngine(S.info.name, emit);
  bind(); if (S.info.sources.includes('youtube')) bindBrowse(); bindMediaSession(); applyVolume(); renderModes(); renderNow();

  if (S.info.sources.includes('local')) {
    const r = await nox.lib.list(); S.library = r.tracks; S.settings.folders = r.folders;
    renderNav(); openList('local:all');
    refreshLibrary(true);
  }
  if (S.info.sources.includes('youtube')) {
    S.ytSaved = await nox.yt.saved().catch(() => []);
    nox.yt.refreshSaved().then((l) => { S.ytSaved = l; if (S.source === 'youtube') renderNav(); }).catch(() => {});
    S.ytSignedIn = (await nox.yt.status()).signedIn;
    if (S.ytSignedIn) loadYouTubeLists();
  }
  if (S.info.sources.includes('spotify')) {
    S.spSignedIn = (await nox.sp.status()).signedIn;
    renderNav();
    if (S.spSignedIn) afterSpotifyLogin();
    else { setList('queue', 'Spotify', 'Başlamak için Spotify hesabını bağla.', []); emptyText('Spotify’a henüz bağlı değilsin.<br><button class="btn primary" data-act="settings">Ayarlar’a git</button>'); }
  }
}

start().catch((e) => toast(`Başlatılamadı: ${e.message}`, 10000));
