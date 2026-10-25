// Windows medya kontrolleri ve Noxelyra için kare kapak (512 x 512, JPEG, base64).
// Yerel kapaklar ortadan kırpılır; YouTube küçük resimleri kırpılmaz, koyu zemine sığdırılır (içerik değiştirilmez);
// Spotify kapakları zaten karedir ve olduğu gibi ölçeklenir.
const SIZE = 512;

function canvas() {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  return [c, c.getContext('2d')];
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

const encode = (c) => c.toDataURL('image/jpeg', 0.9).split(',')[1];

function generated(track) {
  // Kapaksız parça: başlığa göre renk alan, Noxelyra paletinde bir kapak.
  const [c, g] = canvas();
  let h = 0; for (const ch of `${track.title}${track.artist}`) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hue = 250 + (h % 70);
  const grad = g.createLinearGradient(0, 0, SIZE, SIZE);
  grad.addColorStop(0, `hsl(${hue} 60% 38%)`); grad.addColorStop(1, `hsl(${(hue + 40) % 360} 55% 16%)`);
  g.fillStyle = grad; g.fillRect(0, 0, SIZE, SIZE);
  g.fillStyle = 'rgba(255,255,255,.88)';
  g.font = '600 220px "Segoe UI Variable Display", "Segoe UI", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText((track.title || '?').trim().charAt(0).toLocaleUpperCase('tr'), SIZE / 2, SIZE / 2 + 8);
  return encode(c);
}

function draw(img, fit) {
  const [c, g] = canvas();
  const w = img.naturalWidth, h = img.naturalHeight;
  if (fit === 'contain') {
    g.fillStyle = '#0d0b14'; g.fillRect(0, 0, SIZE, SIZE);
    const s = Math.min(SIZE / w, SIZE / h);
    g.drawImage(img, (SIZE - w * s) / 2, (SIZE - h * s) / 2, w * s, h * s);
  } else {
    const s = Math.max(SIZE / w, SIZE / h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (SIZE - w * s) / 2, (SIZE - h * s) / 2, w * s, h * s);
  }
  return encode(c);
}

export async function squareCover(track, url) {
  if (!url) return generated(track);
  try {
    // Uzak resimler ana işlemden data: URL olarak gelir; tuval "kirlenmez", toDataURL çalışır.
    let src = url;
    if (track.source === 'youtube') {
      src = await window.nox.image(url.replace('/hqdefault.', '/maxresdefault.')) ?? await window.nox.image(url);
      // maxresdefault yoksa YouTube 120x90 gri bir yer tutucu döndürür; o durumda hqdefault kullan.
      if (src) { const probe = await loadImage(src); if (probe.naturalWidth < 300) src = await window.nox.image(url); }
    } else if (track.source === 'spotify') src = await window.nox.image(url);
    if (!src) return generated(track);
    const img = await loadImage(src);
    return draw(img, track.source === 'youtube' ? 'contain' : 'cover');
  } catch {
    return generated(track);
  }
}

/** Kapaksız yerel video için o anki kareden kapak. */
export function frameCover(video) {
  if (!video.videoWidth) return '';
  const [c, g] = canvas();
  g.fillStyle = '#0d0b14'; g.fillRect(0, 0, SIZE, SIZE);
  const s = Math.max(SIZE / video.videoWidth, SIZE / video.videoHeight);
  g.drawImage(video, (SIZE - video.videoWidth * s) / 2, (SIZE - video.videoHeight * s) / 2, video.videoWidth * s, video.videoHeight * s);
  try { return encode(c); } catch { return ''; }
}
