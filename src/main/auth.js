'use strict';
// Hesap girişi: OAuth 2.0 yetkilendirme kodu + PKCE, sistem tarayıcısında. Uygulama parolayı hiç görmez
// (YouTube Geliştirici Politikası III.D.2, Spotify Geliştirici Şartları). Belirteçler DPAPI ile şifreli saklanır.
const crypto = require('crypto');
const { shell } = require('electron');
const store = require('./store');

// Uygulamayı dağıtan kişi kendi Google OAuth istemcisini config/google.json ile pakete koyabilir
// ({ "clientId": "...", "clientSecret": "..." }); o zaman son kullanıcı yalnız "Google ile giriş yap"a basar.
// Bu dosya kaynak koduna konmaz (.gitignore), çünkü YouTube politikası III.D.1 açık kaynakta kimlik bilgisini yasaklar.
const bundled = (() => {
  const path = require('path');
  for (const dir of [process.resourcesPath ?? '', path.join(__dirname, '..', '..')]) {
    try { return JSON.parse(require('fs').readFileSync(path.join(dir, 'config', 'google.json'), 'utf8')); } catch { /* yok */ }
  }
  return null;
})();

const b64url =(buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const providers = {
  spotify: {
    authorize: 'https://accounts.spotify.com/authorize',
    token: 'https://accounts.spotify.com/api/token',
    scope: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read',
    clientId: () => store.load().spotifyClientId,
    clientSecret: () => '',
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    clientId: () => store.load().googleClientId || bundled?.clientId || '',
    // Google "Masaüstü uygulaması" istemcileri için bu değer gizli sayılmaz; yine de kodda değil, ayarda veya paket dosyasındadır.
    clientSecret: () => (store.load().googleClientId ? store.load().googleClientSecret : bundled?.clientSecret) || '',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
};

const pending = new Map(); // state -> { name, verifier, redirect, resolve, reject, timer }

function begin(name, origin) {
  const p = providers[name];
  const clientId = p.clientId();
  if (!clientId) return Promise.reject(new Error('İstemci kimliği (Client ID) ayarlarda girilmemiş.'));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const redirect = `${origin}/oauth/${name}`;
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: p.scope,
    code_challenge_method: 'S256', code_challenge: challenge, state, ...(p.extra ?? {}),
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(state); reject(new Error('Giriş zaman aşımına uğradı.')); }, 5 * 60 * 1000);
    pending.set(state, { name, verifier, redirect, resolve, reject, timer });
    shell.openExternal(`${p.authorize}?${params}`);
  });
}

/** Sunucunun /oauth/<ad> dönüşü. */
async function complete(name, query) {
  const entry = pending.get(query.get('state') ?? '');
  if (!entry || entry.name !== name) return false;
  pending.delete(query.get('state')); clearTimeout(entry.timer);
  if (query.get('error') || !query.get('code')) { entry.reject(new Error(query.get('error') || 'İzin verilmedi.')); return false; }
  try {
    const tokens = await exchange(name, { grant_type: 'authorization_code', code: query.get('code'), redirect_uri: entry.redirect, code_verifier: entry.verifier });
    entry.resolve(tokens);
    return true;
  } catch (e) { entry.reject(e); return false; }
}

async function exchange(name, body) {
  const p = providers[name];
  const form = new URLSearchParams({ client_id: p.clientId(), ...body });
  if (p.clientSecret()) form.set('client_secret', p.clientSecret());
  const r = await fetch(p.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `Belirteç alınamadı (${r.status}).`);
  const old = store.readSecret(name) ?? {};
  const tokens = { access: j.access_token, refresh: j.refresh_token || old.refresh, expires: Date.now() + (j.expires_in ?? 3600) * 1000 - 60000 };
  store.writeSecret(name, tokens);
  return tokens;
}

/** Geçerli erişim belirteci; süresi dolmuşsa yeniler. Giriş yoksa null. */
async function accessToken(name) {
  const t = store.readSecret(name);
  if (!t) return null;
  if (Date.now() < t.expires) return t.access;
  if (!t.refresh) return null;
  try { return (await exchange(name, { grant_type: 'refresh_token', refresh_token: t.refresh })).access; }
  catch { return null; }
}

async function logout(name) {
  const t = store.readSecret(name);
  store.writeSecret(name, null);
  // Google'da izni hemen geri al (YouTube politikası III.D.2). Spotify'da geri alma spotify.com/account/apps üzerinden yapılır.
  if (name === 'google' && t) {
    await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.refresh || t.access }) }).catch(() => {});
  }
}

const signedIn = (name) => !!store.readSecret(name);

module.exports = { begin, complete, accessToken, logout, signedIn, googleBuiltIn: () => !!bundled?.clientId };
