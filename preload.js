'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 렌더러(웹)에서 안전하게 호출할 수 있는 API만 노출한다.
contextBridge.exposeInMainWorld('chatAPI', {
  // 방 관리
  discoverRooms: () => ipcRenderer.invoke('discover-rooms'),
  createRoom: (opts) => ipcRenderer.invoke('create-room', opts),
  joinRoom: (opts) => ipcRenderer.invoke('join-room', opts),
  leaveRoom: () => ipcRenderer.invoke('leave-room'),
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),

  // 메시지
  sendMessage: (text, replyTo) => ipcRenderer.invoke('send-message', { text, replyTo }),

  // 파일
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  sendFiles: (paths, replyTo) => ipcRenderer.invoke('send-files', { paths, replyTo }),
  saveFile: (file) => ipcRenderer.invoke('save-file', file),

  // 고정(핀)
  setPin: (action, item) => ipcRenderer.invoke('set-pin', { action, item }),

  // 창 제어
  setAlwaysOnTop: (v) => ipcRenderer.invoke('set-always-on-top', v),
  setOpacity: (v) => ipcRenderer.invoke('set-opacity', v),
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),

  // 메인 → 렌더러 이벤트 구독
  onChat: (cb) => ipcRenderer.on('chat-message', (_e, m) => cb(m)),
  onFile: (cb) => ipcRenderer.on('file-message', (_e, m) => cb(m)),
  onPin: (cb) => ipcRenderer.on('pin-update', (_e, m) => cb(m)),
  onSystem: (cb) => ipcRenderer.on('system-message', (_e, m) => cb(m)),
  onUsers: (cb) => ipcRenderer.on('users-update', (_e, u) => cb(u)),
  onDisconnected: (cb) => ipcRenderer.on('disconnected', (_e, m) => cb(m)),
  onNetError: (cb) => ipcRenderer.on('net-error', (_e, m) => cb(m)),
});
