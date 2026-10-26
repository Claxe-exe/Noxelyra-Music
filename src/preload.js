'use strict';
// Arayüze yalnız bu dar köprü açılır; Node.js'e doğrudan erişim yoktur.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const on = (channel) => (cb) => { const fn = (_e, v) => cb(v); ipcRenderer.on(channel, fn); return () => ipcRenderer.off(channel, fn); };

contextBridge.exposeInMainWorld('nox', {
  info: () => call('info'),
  settings: { get: () => call('settings:get'), set: (patch) => call('settings:set', patch) },
  lib: {
    list: () => call('lib:list'), scan: () => call('lib:scan'), addFolder: () => call('lib:addFolder'),
    removeFolder: (f) => call('lib:removeFolder', f), openFiles: () => call('lib:openFiles'), addFiles: (paths) => call('lib:addFiles', paths),
    onProgress: on('lib:progress'),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  yt: {
    status: () => call('yt:status'), login: () => call('yt:login'), logout: () => call('yt:logout'),
    playlists: () => call('yt:playlists'), items: (id) => call('yt:items', id), search: (q) => call('yt:search', q), oembed: (id) => call('yt:oembed', id),
    saved: () => call('yt:saved'), save: (id, title) => call('yt:save', id, title), unsave: (id) => call('yt:unsave', id), refreshSaved: () => call('yt:refreshSaved'),
  },
  sp: {
    status: () => call('sp:status'), login: () => call('sp:login'), logout: () => call('sp:logout'), token: () => call('sp:token'),
    playlists: () => call('sp:playlists'), items: (id) => call('sp:items', id), search: (q) => call('sp:search', q),
    play: (device, payload) => call('sp:play', device, payload), transfer: (device) => call('sp:transfer', device),
    shuffle: (device, on) => call('sp:shuffle', device, on), repeat: (device, mode) => call('sp:repeat', device, mode),
  },
  image: (url) => call('img:fetch', url),
  update: { check: () => call('update:check'), onStatus: on('update:status') },
  relaunch: () => call('app:relaunch'),
  ytbrowse: { onPlay: on('ytbrowse:play'), onSignIn: on('ytbrowse:signin') },
  openExternal: (url) => call('open:external', url),
  win: {
    offscreen: () => call('win:offscreen'), restore: () => call('win:restore'), onOffscreen: on('window:offscreen'),
    exitMini: () => call('mini:exit'), miniDrag: (phase, dx, dy) => ipcRenderer.send('mini:drag', phase, dx, dy), onMini: on('window:mini'),
  },
  smtc: {
    meta: (m) => ipcRenderer.send('smtc:meta', m),
    playback: (s) => ipcRenderer.send('smtc:playback', s),
    onCommand: on('media:command'),
  },
});
