'use strict';
// Seçilen kaynağın resmi API'leri. Yanıtlar diske yazılmaz (YouTube III.E.4: saklanan veri yok).
const auth = require('./auth');

// ---------- YouTube ----------
const YT = 'https://www.googleapis.com/youtube/v3/';

async function yt(pathname, params) {
  const token = await auth.accessToken('google');
  if (!token) throw new Error('YouTube için giriş yapılmamış.');
  const r = await fetch(`${YT}${pathname}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `YouTube API hatası (${r.status}).`);
  return j;
}

const ytThumb = (s) => s?.maxres?.url || s?.standard?.url || s?.high?.url || s?.medium?.url || s?.default?.url || '';
const ytTrack = (id, sn) => ({ source: 'youtube', id, title: sn.title, artist: sn.videoOwnerChannelTitle || sn.channelTitle || '', album: 'YouTube', cover: ytThumb(sn.thumbnails), video: true, duration: 0 });

const youtube = {
  async playlists() {
    const out = [];
    const ch = await yt('channels', { part: 'contentDetails', mine: 'true' });
    const likes = ch.items?.[0]?.contentDetails?.relatedPlaylists?.likes;
    if (likes) out.push({ id: likes, title: 'Beğendiğim videolar', count: null });
    let page = '';
    do {
      const j = await yt('playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...(page ? { pageToken: page } : {}) });
      for (const p of j.items ?? []) out.push({ id: p.id, title: p.snippet.title, count: p.contentDetails?.itemCount ?? null, cover: ytThumb(p.snippet.thumbnails) });
      page = j.nextPageToken;
    } while (page && out.length < 200);
    return out;
  },
  async playlistItems(id) {
    const out = [];
    let page = '';
    do {
      const j = await yt('playlistItems', { part: 'snippet,contentDetails', playlistId: id, maxResults: '50', ...(page ? { pageToken: page } : {}) });
      for (const it of j.items ?? []) {
        const vid = it.contentDetails?.videoId;
        if (vid && it.snippet.title !== 'Private video' && it.snippet.title !== 'Deleted video') out.push(ytTrack(vid, it.snippet));
      }
      page = j.nextPageToken;
    } while (page && out.length < 500);
    return out;
  },
  async search(q) {
    const j = await yt('search', { part: 'snippet', q, type: 'video', videoEmbeddable: 'true', maxResults: '25' });
    return (j.items ?? []).map((it) => ytTrack(it.id.videoId, it.snippet));
  },
  /** Giriş gerektirmeyen başlık bilgisi (resmi oEmbed uç noktası). */
  /** Oynatma listesinin adı (resmi oEmbed, giriş gerektirmez). */
  async listTitle(listId) {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/playlist?list=${listId}`)}`);
    if (!r.ok) return null;
    return (await r.json()).title ?? null;
  },
  async oembed(videoId) {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return { source: 'youtube', id: videoId, title: j.title, artist: j.author_name, album: 'YouTube', cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, video: true, duration: 0 };
  },
};

// ---------- Spotify ----------
const SP = 'https://api.spotify.com/v1/';

async function sp(method, pathname, body) {
  const token = await auth.accessToken('spotify');
  if (!token) throw new Error('Spotify için giriş yapılmamış.');
  const r = await fetch(SP + pathname, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error?.message || `Spotify API hatası (${r.status}).`);
  return j;
}

const spTrack = (t) => t && t.type === 'track' && ({
  source: 'spotify', id: t.id, uri: t.uri, title: t.name, artist: (t.artists ?? []).map((a) => a.name).join(', '),
  album: t.album?.name ?? '', cover: t.album?.images?.[0]?.url ?? '', duration: t.duration_ms ?? 0, video: false,
  link: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
});

const spotify = {
  async playlists() {
    const out = [{ id: 'liked', title: 'Beğenilen Şarkılar', uri: null }];
    let next = 'me/playlists?limit=50';
    while (next && out.length < 200) {
      const j = await sp('GET', next.replace(SP, ''));
      for (const p of j.items ?? []) out.push({ id: p.id, title: p.name, uri: p.uri, cover: p.images?.[0]?.url ?? '', owner: p.owner?.display_name ?? '' });
      next = j.next;
    }
    return out;
  },
  async playlistItems(id) {
    const out = [];
    let next = id === 'liked' ? 'me/tracks?limit=50' : `playlists/${id}/items?limit=50`;
    while (next && out.length < 500) {
      let j;
      try { j = await sp('GET', next.replace(SP, '')); }
      catch (e) {
        // Geliştirme modunda yalnız sahibi/ortak olunan listelerin içeriği okunabilir (Şubat 2026 değişikliği).
        if (!out.length) throw new Error('Bu listenin içeriği okunamıyor (Spotify yalnız kendi listelerini gösteriyor). "Listeyi çal" ile yine de çalabilirsin.');
        throw e;
      }
      for (const it of j.items ?? []) { const t = spTrack(it.item ?? it.track); if (t) out.push(t); }
      next = j.next;
    }
    return out;
  },
  async search(q) {
    const j = await sp('GET', `search?${new URLSearchParams({ q, type: 'track', limit: '10' })}`);
    return (j.tracks?.items ?? []).map(spTrack).filter(Boolean);
  },
  async play(deviceId, payload) { return sp('PUT', `me/player/play?device_id=${encodeURIComponent(deviceId)}`, payload); },
  async transfer(deviceId) { return sp('PUT', 'me/player', { device_ids: [deviceId], play: false }); },
  async shuffle(deviceId, on) { return sp('PUT', `me/player/shuffle?state=${on}&device_id=${encodeURIComponent(deviceId)}`); },
  async repeat(deviceId, mode) { return sp('PUT', `me/player/repeat?state=${mode}&device_id=${encodeURIComponent(deviceId)}`); },
};

module.exports = { youtube, spotify };
