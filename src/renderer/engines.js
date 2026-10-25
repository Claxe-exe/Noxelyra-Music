// Üç oynatma motoru, ortak arayüz: load / play / pause / seek / position / duration / playing / setVolume / stop.
// Olaylar emit(tür, veri) ile denetleyiciye gider: 'state', 'ended', 'error', 'meta', 'spotify'.

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error(`${src} yüklenemedi`));
    document.head.appendChild(s);
  });
}

// ---------- Yerel dosyalar: Chromium <video> öğesi, ses ana işlemin paylaşımlı WASAPI oturumundan çıkar ----------
export class LocalEngine {
  constructor(video, emit) {
    this.v = video; this.emit = emit; this.track = null;
    for (const e of ['play', 'playing', 'pause', 'seeked', 'durationchange', 'waiting']) video.addEventListener(e, () => this.emit('state'));
    video.addEventListener('ended', () => this.emit('ended'));
    video.addEventListener('error', () => { if (this.track) this.emit('error', 'Dosya çalınamadı (biçim veya codec desteklenmiyor olabilir).'); });
  }
  async load(track, url, autoplay = true) {
    this.track = track;
    this.v.src = url;
    if (autoplay) await this.v.play().catch(() => {});
  }
  play() { return this.v.play().catch(() => {}); }
  pause() { this.v.pause(); }
  seek(ms) { if (Number.isFinite(this.v.duration)) this.v.currentTime = Math.max(0, Math.min(ms / 1000, this.v.duration)); }
  get position() { return this.v.currentTime * 1000; }
  get duration() { return Number.isFinite(this.v.duration) ? this.v.duration * 1000 : (this.track?.duration ?? 0); }
  get playing() { return !this.v.paused && !this.v.ended; }
  get seekable() { return Number.isFinite(this.v.duration); }
  setVolume(x) { this.v.volume = x; }
  stop() { this.track = null; this.v.pause(); this.v.removeAttribute('src'); this.v.load(); }
}

// ---------- YouTube: resmi IFrame Player API (oynatıcı görünür kalır, reklamlar ve logo olduğu gibi) ----------
export class YouTubeEngine {
  constructor(hostId, emit) {
    this.hostId = hostId; this.emit = emit; this.player = null; this.ready = null; this.track = null; this.state = -1; this.volume = 80;
  }
  api() {
    this.apiReady ??= new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = resolve;
      loadScript('https://www.youtube.com/iframe_api').catch(reject);
    });
    return this.apiReady;
  }
  /**
   * Yeni bir oynatıcı kurar. Bir video hata verdikten sonra (ör. 150) YouTube oynatıcısı sonraki
   * komutlara tepki vermeyebiliyor; bu yüzden hatadan sonra oynatıcı baştan kurulur.
   */
  async create(vars = {}) {
    await this.api();
    this.player?.destroy?.();
    document.getElementById(this.hostId)?.remove();
    const host = document.getElementById('yt-host');
    host.innerHTML = `<div id="${this.hostId}"></div>`;
    this.broken = false; this.state = -1;
    this.ready = new Promise((resolve) => {
      this.player = new YT.Player(this.hostId, {
        host: 'https://www.youtube-nocookie.com', width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, autoplay: 1, origin: location.origin, enablejsapi: 1, iv_load_policy: 3, ...vars },
        events: {
          onReady: () => { this.player.setVolume(this.volume); resolve(); },
          onStateChange: (e) => this.onState(e.data),
          onError: (e) => {
            this.broken = true;
            if (this.waitList) { this.waitList(e.data); return; }
            this.emit('error', ({ 2: 'Geçersiz video bağlantısı.', 5: 'Video bu oynatıcıda açılamadı.', 100: 'Video bulunamadı veya kaldırılmış.',
              101: 'Bu şarkının sahibi YouTube dışında çalınmasına izin vermiyor, atlanıyor.', 150: 'Bu şarkının sahibi YouTube dışında çalınmasına izin vermiyor, atlanıyor.' })[e.data] ?? `YouTube hatası (${e.data}).`);
          },
        },
      });
    });
    return this.ready;
  }
  init() { return this.ready && !this.broken ? this.ready : this.create(); }
  onState(s) {
    this.state = s;
    if (s === 0) { this.emit('ended'); return; }
    if (s === 1) {
      const d = this.player.getVideoData?.();
      if (d?.title) this.emit('meta', { title: d.title, artist: d.author });
    }
    if (this.waitList && s === 1) this.waitList(true);
    this.emit('state');
  }
  async load(track, _url, autoplay = true) {
    await this.init();
    this.track = track;
    if (autoplay) this.player.loadVideoById(track.id); else this.player.cueVideoById(track.id);
  }
  /**
   * Oynatma listesini doğrudan çalmaya başlar ve video kimliklerini döndürür (giriş gerektirmez).
   * Oynatıcı görünür olmalı: gizli oynatıcıda YouTube listeyi hiç yüklemiyor.
   */
  async loadList(list, videoId) {
    // Sahibinin dış oynatıcılara kapattığı videolar (hata 101/150) atlanır; çalan ilk videodan başlanır.
    for (let index = 0; index < 25; index++) {
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => done('timeout'), 12000);
        const done = (v) => { clearTimeout(timer); this.waitList = null; resolve(v); };
        this.waitList = done;
        this.create({ listType: 'playlist', list, index });
      });
      if (result === true) {
        const ids = this.player.getPlaylist?.() ?? [];
        if (ids.length && videoId && ids.indexOf(videoId) > index) this.player.playVideoAt(ids.indexOf(videoId));
        return ids;
      }
      if (result !== 101 && result !== 150) return [];
    }
    return [];
  }
  play() { this.player?.playVideo(); }
  pause() { this.player?.pauseVideo(); }
  seek(ms) { this.player?.seekTo(ms / 1000, true); }
  get position() { return (this.player?.getCurrentTime?.() ?? 0) * 1000; }
  get duration() { return (this.player?.getDuration?.() ?? 0) * 1000; }
  get playing() { return this.state === 1 || this.state === 3; }
  get seekable() { return this.duration > 0; }
  setVolume(x) { this.volume = Math.round(x * 100); this.player?.setVolume?.(this.volume); }
  stop() { this.track = null; this.player?.stopVideo?.(); this.state = -1; }
}

// ---------- Spotify: resmi Web Playback SDK (Premium gerekir, Widevine ile castLabs Electron'da çalışır) ----------
export class SpotifyEngine {
  constructor(name, emit) {
    this.name = name; this.emit = emit; this.player = null; this.device = null; this.ready = null; this.s = null; this.at = 0; this.volume = 0.8;
  }
  init() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => {
        const p = this.player = new Spotify.Player({
          name: this.name, volume: this.volume,
          getOAuthToken: (cb) => window.nox.sp.token().then((t) => cb(t ?? '')).catch(() => cb('')),
        });
        p.addListener('ready', async ({ device_id }) => {
          this.device = device_id;
          try { await window.nox.sp.transfer(device_id); } catch { /* başka cihaz çalıyorsa da olur */ }
          resolve();
        });
        p.addListener('not_ready', () => { this.device = null; });
        p.addListener('initialization_error', ({ message }) => { reject(new Error(`Spotify başlatılamadı: ${message} (DRM/Widevine hazır değil olabilir).`)); this.emit('error', `Spotify başlatılamadı: ${message}`); });
        p.addListener('authentication_error', ({ message }) => { reject(new Error(message)); this.emit('error', 'Spotify girişi geçersiz; Ayarlar’dan yeniden giriş yap.'); });
        p.addListener('account_error', () => { reject(new Error('Premium')); this.emit('error', 'Spotify oynatma için Premium hesap gerekiyor.'); });
        p.addListener('playback_error', ({ message }) => this.emit('error', `Spotify çalamadı: ${message}`));
        p.addListener('player_state_changed', (state) => {
          this.s = state; this.at = performance.now();
          this.emit('spotify', state);
          this.emit('state');
        });
        p.connect().then((ok) => { if (!ok) reject(new Error('Spotify bağlanamadı.')); });
      };
      loadScript('https://sdk.scdn.co/spotify-player.js').catch(reject);
    });
    return this.ready;
  }
  /** Spotify sırayı kendisi yönetir: listedeki URI'ler ve başlangıç konumu gönderilir. */
  async playList(uris, index, contextUri) {
    await this.init();
    this.player.activateElement?.();
    const payload = contextUri ? { context_uri: contextUri, offset: { position: index } } : { uris, offset: { position: index } };
    await window.nox.sp.play(this.device, payload);
  }
  play() { this.player?.resume(); }
  pause() { this.player?.pause(); }
  next() { this.player?.nextTrack(); }
  previous() { this.player?.previousTrack(); }
  seek(ms) { this.player?.seek(Math.max(0, Math.round(ms))); if (this.s) { this.s.position = ms; this.at = performance.now(); } }
  get position() { if (!this.s) return 0; return Math.min(this.duration, this.s.position + (this.s.paused ? 0 : performance.now() - this.at)); }
  get duration() { return this.s?.duration ?? 0; }
  get playing() { return !!this.s && !this.s.paused; }
  get seekable() { return this.duration > 0; }
  setVolume(x) { this.volume = x; this.player?.setVolume(x); }
  stop() { this.player?.pause(); }
}
