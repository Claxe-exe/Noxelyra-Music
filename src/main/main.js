'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, screen, session } = require('electron');
const edition = require('./edition');

// Ad ve AppUserModelID exe adıyla birebir aynı ("Noxelyra Music.exe" -> "Noxelyra Music").
app.setName(edition.name);
// NOX_DATA: denemeler için ayrı veri klasörü (gerçek ayarlara dokunmaz).
app.setPath('userData', process.env.NOX_DATA || path.join(app.getPath('appData'), edition.name));
app.setAppUserModelId(edition.name);

const smtc = require('./smtc');
const nativeSmtc = smtc.load();

// HardwareMediaKeyHandling: Chromium'un kendi SMTC'si (yerine kendi köprümüz; köprü yoksa açık kalır).
// CalculateNativeWinOcclusion: başka pencerelerin altında kalınca çizim durmasın (Noxelyra videoyu hareketten bulur).
// AudioServiceOutOfProcess: ses ayrı bir yardımcı işlemde değil, ana işlemde çalınsın (WASAPI paylaşımlı oturum).
// SpareRendererForSitePerProcess, MediaRouter: kullanılmayan arka plan işleri ve ağ keşfi kapalı.
const disabled = ['CalculateNativeWinOcclusion', 'AudioServiceOutOfProcess', 'MediaRouter', 'SpareRendererForSitePerProcess', 'GlobalMediaControls'];
if (nativeSmtc) disabled.push('HardwareMediaKeyHandling');
app.commandLine.appendSwitch('disable-features', disabled.join(','));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

if (!app.requestSingleInstanceLock()) app.exit(0);

const store = require('./store');
const library = require('./library');
const auth = require('./auth');
const { youtube, spotify } = require('./services');
const server = require('./server');
const updater = require('./updater');

let win = null;
let tray = null;
let web = null; // { origin, secret }
let offscreen = null; // ekran dışına alınmadan önceki konum
let videoPlaying = false;
let youtubeActive = false;

const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

async function createWindow() {
  const s = store.load();
  win = new BrowserWindow({
    width: s.bounds?.width ?? 1180, height: s.bounds?.height ?? 740, x: s.bounds?.x, y: s.bounds?.y,
    minWidth: 860, minHeight: 560,
    title: edition.name,
    icon: ICON,
    show: false,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e9e4ff', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false, // yazım denetimi sözlük indirmesin
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Ekran ölçüsü kaybolmuş bir konumu (ör. çıkarılmış monitör) geri getir.
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const b = win.getBounds();
  if (b.x + 100 > area.x + area.width || b.y + 40 > area.y + area.height || b.x + b.width < area.x + 100 || b.y < area.y - 10) win.center();

  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    if (mini) store.save({ miniBounds: win.getBounds() });
    const normal = mini ?? (offscreen ? null : win.getBounds());
    if (normal && !win.isMinimized() && !win.isMaximized()) store.save({ bounds: normal });
  });
  win.on('closed', () => { win = null; });

  // Simge durumundaki pencerenin görüntüsünü Windows hiçbir uygulamaya vermez (Noxelyra adası videoyu gösteremez).
  //  - Yerel video: pencere ekran dışına taşınır.
  //  - YouTube: köşede, her zaman üstte duran mini oynatıcıya dönüşür. Ekran dışına taşımak YouTube API politikası
  //    III.I.9'a (görünmeyen oynatıcıdan oynatma yasak) aykırı olurdu; mini oynatıcı görünür kalır.
  //  - Mini oynatıcı hiçbir zaman simge durumunda kalmaz.
  win.on('minimize', () => {
    if (mini) { restoreThen(() => { if (mini) { pinTop(); } }); return; }
    if (youtubeActive && store.load().miniOnMinimize !== false) { restoreThen(enterMini); return; }
    // Geri yüklenen pencere ekran dışına taşınmadan önce bir kez çizilsin; yoksa Chromium çizimi saniyede 1 kareye düşürüyor.
    if (videoPlaying && !youtubeActive) restoreThen(() => setTimeout(moveOffscreen, 350));
  });
  win.on('maximize', () => { if (mini) win.unmaximize(); });
  // Görev çubuğundan tıklanınca ekran dışındaki pencereyi geri getir.
  win.on('focus', () => { if (offscreen) restoreFromOffscreen(); });

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(web.origin)) { e.preventDefault(); openExternal(url); } });

  await win.loadURL(`${web.origin}/`);

  const result = smtc.attach(win, (command) => wc.send('media:command', command));
  if (result !== 'ok') console.warn('SMTC köprüsü yok, Chromium mediaSession kullanılacak:', result);
}

function moveOffscreen() {
  if (!win || offscreen) return;
  offscreen = win.getBounds();
  // Simge durumuna küçültmek veya gizlemek yerine sanal ekranın sağına taşı: Windows çizmeye devam eder.
  const right = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width));
  win.setBounds({ ...offscreen, x: right + 200 });
  // Simge durumundan dönen pencerede Chromium çizimi yeniden "görünür" saymıyor (saniyede 1 kare); bunu yeniden bildir.
  win.showInactive();
  win.webContents.invalidate();
  win.webContents.send('window:offscreen', true);
  updateTray();
}

function restoreFromOffscreen() {
  if (!win || !offscreen) return;
  win.setBounds(offscreen);
  offscreen = null;
  win.webContents.send('window:offscreen', false);
  win.show(); win.focus();
  updateTray();
}

// ---------- YouTube mini oynatıcı ----------
// Ayrı bir pencere değil, aynı pencerenin küçük hâli: YouTube oynatıcısı yeniden yüklenmez, HWND, başlık,
// AppUserModelID ve SMTC bağı aynı kalır. YouTube IFrame oynatıcısı en az 200x200 görüntü alanı ister;
// 16:9 için bu 356x200 eder. Üstteki ince şerit (taşıma, geri dönme, pencere düğmeleri) oynatıcının üstüne binmez.
const MINI_BAR = 28;
const MINI_MIN = { width: 356, height: 200 + MINI_BAR };
let mini = null; // mini moda geçmeden önceki normal konum/boyut
let miniDrag = null;

function miniStartBounds() {
  const saved = store.load().miniBounds;
  if (saved && screen.getAllDisplays().some((d) => saved.x >= d.workArea.x - 10 && saved.y >= d.workArea.y - 10
    && saved.x + saved.width <= d.workArea.x + d.workArea.width + 10 && saved.y + saved.height <= d.workArea.y + d.workArea.height + 10)) {
    return { ...saved, width: Math.max(saved.width, MINI_MIN.width), height: Math.max(saved.height, MINI_MIN.height) };
  }
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  return { x: area.x + area.width - MINI_MIN.width - 16, y: area.y + area.height - MINI_MIN.height - 16, ...MINI_MIN };
}

// Simge durumundan geri yükleme bitmeden boyut/üstte durma ayarlanırsa Windows bunları geri alabiliyor.
// Geri yükleme de 'minimize' olayının içinde yapılmamalı: Electron kendi "sayfa gizlendi" işlemini olaydan sonra
// yapıyor ve pencere görünür olsa da Chromium saniyede 1 kare çiziyor. Bu yüzden bir sonraki adımda geri yükle.
function restoreThen(fn) {
  let done = false;
  const run = () => { if (done) return; done = true; setTimeout(fn, 60); };
  win.once('restore', run);
  setTimeout(run, 800);
  setTimeout(() => win?.restore(), 0);
}

// Electron üstte durma durumunu önbellekte tutar; Windows bayrağı geri yükleme sırasında silse bile
// setAlwaysOnTop(true) 'zaten açık' sanıp bir şey yapmaz. Önce kapatıp sonra açmak bayrağı gerçekten yeniden koyar.
function pinTop() {
  if (!win || !mini) return;
  if (!smtc.setTopmost(win, true)) { win.setAlwaysOnTop(false); win.setAlwaysOnTop(true, 'floating'); }
  win.webContents.invalidate();
}
let pinTimer = null;

function enterMini() {
  if (!win || mini) return;
  if (offscreen) restoreFromOffscreen();
  if (win.isMaximized()) win.unmaximize();
  if (win.isFullScreen()) win.setFullScreen(false);
  mini = win.getBounds();
  win.webContents.send('window:mini', true);
  win.setMinimumSize(MINI_MIN.width, MINI_MIN.height);
  win.setAspectRatio(16 / 9, { width: 0, height: MINI_BAR });
  win.setTitleBarOverlay({ color: '#00000000', symbolColor: '#e9e4ff', height: MINI_BAR });
  win.setBounds(miniStartBounds());
  win.setAlwaysOnTop(true, 'floating');
  win.showInactive();
  // Boyut değişiminden sonra yeni kare çizdir ve üstte durmayı bir kez daha uygula.
  // Windows'un geri yükleme animasyonu geç biterse üstte durma bayrağını sıfırlayabiliyor; iki kez yeniden uygula.
  for (const ms of [250, 1000]) setTimeout(pinTop, ms);
  // Başka bir program bayrağı kaldırırsa geri koy (bayrak zaten varsa hiçbir şey yapmaz).
  clearInterval(pinTimer); pinTimer = setInterval(pinTop, 2000);
  updateTray();
}

function exitMini(focus = true) {
  if (!win || !mini) return;
  store.save({ miniBounds: win.getBounds() });
  const normal = mini;
  mini = null;
  clearInterval(pinTimer); pinTimer = null;
  win.setAlwaysOnTop(false);
  smtc.setTopmost(win, false);
  win.setAspectRatio(0);
  win.setMinimumSize(860, 560);
  win.setTitleBarOverlay({ color: '#00000000', symbolColor: '#e9e4ff', height: 40 });
  win.setBounds(normal);
  win.webContents.send('window:mini', false);
  if (focus) { win.show(); win.focus(); }
  updateTray();
}

const EXTERNAL =/^https:\/\/([a-z0-9-]+\.)*(spotify\.com|youtube\.com|youtu\.be|google\.com|developer\.spotify\.com|console\.cloud\.google\.com|github\.com)(\/|$)/i;
function openExternal(url) { if (EXTERNAL.test(url)) shell.openExternal(url); }

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: offscreen || mini ? 'Pencereyi geri getir' : 'Göster', click: () => { if (mini) exitMini(); else if (offscreen) restoreFromOffscreen(); else { win?.show(); win?.focus(); } } },
    { label: 'Oynat / Duraklat', click: () => win?.webContents.send('media:command', 'toggle') },
    { label: 'Sonraki', click: () => win?.webContents.send('media:command', 'next') },
    { label: 'Önceki', click: () => win?.webContents.send('media:command', 'previous') },
    { type: 'separator' },
    { label: 'Çıkış', click: () => app.quit() },
  ]));
}

function createTray() {
  const image = nativeImage.createFromPath(ICON);
  if (image.isEmpty()) return;
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip(edition.name);
  tray.on('click', () => { if (mini) exitMini(); else if (offscreen) restoreFromOffscreen(); else { win?.show(); win?.focus(); } });
  updateTray();
}

// Kapakları yalnız bilinen kaynak alan adlarından al; SMTC için kare kapak hazırlanırken tuval kirlenmesin.
const IMAGE_HOSTS = /^https:\/\/(i\.ytimg\.com|i[0-9]?\.ytimg\.com|yt3\.ggpht\.com|i\.scdn\.co|mosaic\.scdn\.co|image-cdn-[a-z]+\.spotifycdn\.com|[a-z0-9-]+\.spotifycdn\.com)\//i;

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  });

  handle('info', () => ({ edition: edition.id, name: edition.name, sources: edition.sources, origin: web.origin, secret: web.secret,
    smtc: smtc.available() ? 'yerel köprü' : `Chromium (${smtc.error() ?? 'köprü yok'})`, version: app.getVersion() }));
  handle('settings:get', () => { const { googleClientSecret: _s, bounds: _b, ...rest } = store.load(); return { ...rest, hasGoogleSecret: !!store.load().googleClientSecret, googleBuiltIn: auth.googleBuiltIn() }; });
  handle('settings:set', (patch) => {
    const allowed = ['volume', 'shuffle', 'repeat', 'spotifyClientId', 'googleClientId', 'googleClientSecret', 'view', 'miniOnMinimize'];
    store.save(Object.fromEntries(Object.entries(patch ?? {}).filter(([k]) => allowed.includes(k))));
    return true;
  });

  // Yerel kitaplık
  handle('lib:list', () => ({ folders: store.load().folders, tracks: library.list() }));
  handle('lib:scan', () => library.scan(store.load().folders, (done, total) => win?.webContents.send('lib:progress', { done, total })));
  handle('lib:addFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Müzik klasörü ekle', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled) return null;
    const folders = [...new Set([...store.load().folders, ...r.filePaths])];
    store.save({ folders });
    return folders;
  });
  handle('lib:removeFolder', (folder) => { const folders = store.load().folders.filter((f) => f !== folder); store.save({ folders }); return folders; });
  handle('lib:openFiles', async () => {
    const exts = [...library.AUDIO, ...library.VIDEO].map((e) => e.slice(1));
    const r = await dialog.showOpenDialog(win, { title: 'Dosya aç', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Müzik ve video', extensions: exts }] });
    return r.canceled ? [] : library.addFiles(r.filePaths);
  });
  handle('lib:addFiles', (paths) => library.addFiles(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []));

  // YouTube (yalnız Noxelyra Music sürümü)
  if (edition.sources.includes('youtube')) {
    handle('yt:status', () => ({ signedIn: auth.signedIn('google'), configured: !!store.load().googleClientId || auth.googleBuiltIn() }));
    handle('yt:login', async () => { await auth.begin('google', web.origin); win?.focus(); return true; });
    handle('yt:logout', () => auth.logout('google'));
    handle('yt:playlists', () => youtube.playlists());
    handle('yt:items', (id) => youtube.playlistItems(String(id)));
    handle('yt:search', (q) => youtube.search(String(q)));
    handle('yt:oembed', (id) => youtube.oembed(String(id)));
    // Kullanıcının eklediği listeler: yalnız liste kimliği ve adı saklanır (video verisi saklanmaz).
    // Ad her açılışta YouTube'dan yenilenir (YouTube API politikası III.E.4: güncel veri).
    handle('yt:saved', () => store.load().ytSaved ?? []);
    handle('yt:save', async (id, title) => {
      id = String(id);
      if (!/^[\w-]+$/.test(id)) return store.load().ytSaved ?? [];
      const list = (store.load().ytSaved ?? []).filter((x) => x.id !== id);
      list.unshift({ id, title: String(title || '') || (await youtube.listTitle(id).catch(() => null)) || 'YouTube listesi' });
      return store.save({ ytSaved: list.slice(0, 100) }).ytSaved;
    });
    handle('yt:unsave', (id) => store.save({ ytSaved: (store.load().ytSaved ?? []).filter((x) => x.id !== String(id)) }).ytSaved);
    handle('yt:refreshSaved', async () => {
      const list = store.load().ytSaved ?? [];
      await Promise.all(list.map(async (x) => { const t = await youtube.listTitle(x.id).catch(() => null); if (t) x.title = t; }));
      return store.save({ ytSaved: list }).ytSaved;
    });
  }

  // Spotify (yalnız Noxelyra Stream sürümü)
  if (edition.sources.includes('spotify')) {
    handle('sp:status', () => ({ signedIn: auth.signedIn('spotify'), configured: !!store.load().spotifyClientId, redirect: `${web.origin}/oauth/spotify` }));
    handle('sp:login', async () => { await auth.begin('spotify', web.origin); win?.focus(); return true; });
    handle('sp:logout', () => auth.logout('spotify'));
    handle('sp:token', () => auth.accessToken('spotify'));
    handle('sp:playlists', () => spotify.playlists());
    handle('sp:items', (id) => spotify.playlistItems(String(id)));
    handle('sp:search', (q) => spotify.search(String(q)));
    handle('sp:play', (deviceId, payload) => spotify.play(String(deviceId), payload));
    handle('sp:transfer', (deviceId) => spotify.transfer(String(deviceId)));
    handle('sp:shuffle', (deviceId, on) => spotify.shuffle(String(deviceId), !!on));
    handle('sp:repeat', (deviceId, mode) => spotify.repeat(String(deviceId), ['off', 'context', 'track'].includes(mode) ? mode : 'off'));
  }

  handle('img:fetch', async (url) => {
    if (typeof url !== 'string' || !IMAGE_HOSTS.test(url)) return null;
    const r = await fetch(url);
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || 'image/jpeg';
    return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  });

  handle('open:external', (url) => openExternal(String(url)));
  handle('update:check', () => { updater.checkAndInstall((s) => win?.webContents.send('update:status', s)); return true; });
  handle('win:offscreen', () => { if (!youtubeActive) moveOffscreen(); return !!offscreen; });
  handle('win:restore', () => { restoreFromOffscreen(); return true; });
  handle('mini:exit', () => { exitMini(); return true; });
  // Mini oynatıcının şeridi pencereyi sürükler; şerit, oynatıcının üstüne binmeyen ayrı bir alandır.
  ipcMain.on('mini:drag', (_e, phase, dx, dy) => {
    if (!win || !mini) return;
    if (phase === 'start') miniDrag = win.getPosition();
    else if (phase === 'move' && miniDrag && Number.isFinite(dx) && Number.isFinite(dy)) win.setPosition(Math.round(miniDrag[0] + dx), Math.round(miniDrag[1] + dy));
    else if (phase === 'end') { miniDrag = null; store.save({ miniBounds: win.getBounds() }); }
  });

  ipcMain.on('smtc:meta', (_e, meta) => smtc.setMeta(meta ?? {}));
  ipcMain.on('smtc:playback', (_e, s) => {
    s ??= {};
    videoPlaying = !!s.video && s.status === 'playing';
    youtubeActive = s.source === 'youtube';
    // YouTube çalarken pencere ekran dışındaysa geri getir (görünmeyen oynatıcı yasak).
    if (youtubeActive && offscreen && s.status === 'playing') restoreFromOffscreen();
    // Küçültülmüş pencerede YouTube başlarsa (ör. medya tuşuyla) mini oynatıcıya geç; görünmeyen oynatıcı yasak.
    if (youtubeActive && s.status === 'playing' && win?.isMinimized() && store.load().miniOnMinimize !== false) restoreThen(enterMini);
    // YouTube dışı bir parçaya geçilince mini oynatıcıdan çık (mini görünüm yalnız YouTube oynatıcısını gösterir).
    if (mini && !youtubeActive && s.status !== 'closed') exitMini(false);
    smtc.setPlayback(s);
  });
}

// Windows medya kartı uygulamanın adını ve simgesini, aynı AppUserModelID'yi taşıyan Başlat menüsü kısayolundan okur;
// kısayol yoksa "Bilinmeyen uygulama" yazar. Kurulum betiği bunu oluşturur; taşınabilir kullanımda burada oluşturulur.
function ensureStartMenuShortcut() {
  if (!app.isPackaged || process.env.NOX_DATA) return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${edition.name}.lnk`);
  const options = { target: process.execPath, appUserModelId: edition.name, icon: process.execPath, iconIndex: 0, description: edition.name };
  try {
    const existing = require('fs').existsSync(lnk) ? shell.readShortcutLink(lnk) : null;
    if (!existing) shell.writeShortcutLink(lnk, 'create', options);
    else if (existing.appUserModelId !== edition.name) shell.writeShortcutLink(lnk, 'update', { appUserModelId: edition.name });
  } catch (e) { console.warn('Başlat menüsü kısayolu yazılamadı:', e?.message ?? e); }
}

app.on('second-instance', () => { if (mini) exitMini(); if (offscreen) restoreFromOffscreen(); if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  // Spotify sürümü: castLabs Electron'un Widevine CDM bileşeni hazır olsun (Spotify şifreli akış kullanır).
  const electron = require('electron');
  if (edition.id === 'stream' && electron.components) {
    try { await electron.components.whenReady(); }
    catch (e) { console.warn('Widevine bileşeni hazırlanamadı:', e?.message ?? e); }
  }

  // İzinler: yalnız DRM (Spotify) ve tam ekran; kamera, mikrofon, konum, bildirim vb. reddedilir.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['mediaKeySystem', 'fullscreen'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['mediaKeySystem', 'fullscreen'].includes(permission));

  if (!store.load().initialized) store.save({ initialized: true, folders: edition.sources.includes('local') ? [app.getPath('music')] : [] });
  library.loadIndex();
  const rendererDir = path.normalize(path.join(__dirname, '..', 'renderer') + path.sep);
  try {
    web = await server.start({ port: edition.port, edition: edition.id, rendererDir, library, onOAuth: (name, q) => auth.complete(name, q) });
  } catch (e) {
    dialog.showErrorBox(edition.name, `Yerel bağlantı noktası ${edition.port} kullanılamıyor (${e.code ?? e.message}). Başka bir program bu portu kullanıyor olabilir.`);
    app.exit(1);
    return;
  }
  registerIpc();
  ensureStartMenuShortcut();
  await createWindow();
  createTray();
});
