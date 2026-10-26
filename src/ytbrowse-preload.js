'use strict';
// "YouTube'da ara" panelinin (webview) ön yükleme betiği. YouTube'un sitesi olduğu gibi gösterilir; yalnız bir
// videoya, Shorts'a veya oynatma listesine tıklanınca o sayfada açılmaz, uygulamanın resmi IFrame oynatıcısına gider.
// Sayfadan veri okunmaz, hiçbir şey indirilmez.
const { ipcRenderer } = require('electron');

function playable(href) {
  try {
    const u = new URL(href, location.href);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    if (u.pathname === '/watch' && /^[\w-]{11}$/.test(u.searchParams.get('v') ?? '')) return u.href;
    if (/^\/shorts\/[\w-]{11}/.test(u.pathname)) return u.href;
    if (u.pathname === '/playlist' && u.searchParams.get('list')) return u.href;
  } catch { /* geçersiz bağlantı */ }
  return null;
}

// Pencere düzeyinde, yakalama aşamasında: YouTube'un kendi tıklama işleyicilerinden önce çalışır.
addEventListener('click', (e) => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const a = e.target?.closest?.('a[href]');
  const url = a && playable(a.href);
  if (!url) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  ipcRenderer.sendToHost('nox-play', url);
}, true);
