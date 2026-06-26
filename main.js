'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, dialog,
} = require('electron');

const {
  HostSession, ClientSession, discoverRooms, getLocalIPv4, MAX_FILE_BYTES,
} = require('./network');

const { initAutoUpdate } = require('./updater');

// Windows 토스트 알림에 앱 이름이 제대로 뜨도록 AppUserModelID 지정
app.setAppUserModelId('com.local.secretlanchat');

let mainWindow = null;
let tray = null;
let session = null;       // HostSession | ClientSession | null
let isQuitting = false;
let currentRoomName = '';

// ---------------------------------------------------------------------------
// 윈도우 / 트레이
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 480,
    minHeight: 400,
    title: 'Secret LAN Chat',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#1e1f26',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // REQ-009: 닫기(X) 시 종료하지 않고 트레이로 숨김
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // 최소화 버튼 → 트레이로 숨김
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  tray = new Tray(getTrayImage());
  rebuildTrayMenu();
  tray.setToolTip('Secret LAN Chat');
  // 더블 클릭 시 복구 (REQ-009)
  tray.on('double-click', showWindow);
}

function rebuildTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: currentRoomName ? `방: ${currentRoomName}` : 'Secret LAN Chat', enabled: false },
    { type: 'separator' },
    { label: '열기', click: showWindow },
    {
      label: '종료', click: () => {
        isQuitting = true;
        if (session) { try { session.stop(); } catch (_) {} }
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function getTrayImage() {
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  const img = nativeImage.createFromPath(icoPath);
  if (!img.isEmpty()) return img;
  // 아이콘 파일이 없을 때를 대비한 1x1 대체 이미지
  return nativeImage.createEmpty();
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

// 창이 숨겨져 있거나 포커스를 잃었을 때만 토스트 알림 (REQ-009)
function notifyIfBackground(title, body) {
  if (!mainWindow) return;
  const inBackground = !mainWindow.isVisible() || !mainWindow.isFocused();
  if (!inBackground) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: getTrayImage(), silent: false });
  n.on('click', showWindow);
  n.show();
}

// ---------------------------------------------------------------------------
// 세션 이벤트 → 렌더러 전달 + 백그라운드 알림
// ---------------------------------------------------------------------------

function wireSession(s) {
  s.on('chat', (m) => {
    send('chat-message', m);
    if (!m.self) notifyIfBackground(`${m.username} (${currentRoomName})`, m.text);
  });
  s.on('file', (m) => {
    send('file-message', m);
    if (!m.self) notifyIfBackground(`${m.username} (${currentRoomName})`, `📎 ${m.filename}`);
  });
  s.on('pin', (m) => send('pin-update', m));
  s.on('system', (m) => send('system-message', m));
  s.on('users', (users) => send('users-update', users));
  s.on('error', (err) => send('net-error', String(err.message || err)));
  if (s instanceof ClientSession) {
    s.on('closed', (info) => {
      send('disconnected', info);
      notifyIfBackground('연결 종료', info.reason || '방과의 연결이 끊어졌습니다.');
    });
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function teardownSession() {
  if (session) { try { session.stop(); } catch (_) {} }
  session = null;
  currentRoomName = '';
  if (tray) rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// IPC 핸들러
// ---------------------------------------------------------------------------

ipcMain.handle('discover-rooms', async () => {
  try {
    return { ok: true, rooms: await discoverRooms() };
  } catch (err) {
    return { ok: false, error: String(err.message || err), rooms: [] };
  }
});

ipcMain.handle('create-room', async (_e, opts) => {
  teardownSession();
  try {
    const host = new HostSession(opts);
    wireSession(host);
    const info = await host.start();
    session = host;
    currentRoomName = info.roomName;
    rebuildTrayMenu();
    return { ok: true, ...info, hidden: !!opts.hidden };
  } catch (err) {
    teardownSession();
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('join-room', async (_e, opts) => {
  teardownSession();
  try {
    const client = new ClientSession(opts);
    wireSession(client);
    const info = await client.connect();
    session = client;
    currentRoomName = info.roomName;
    rebuildTrayMenu();
    return { ok: true, ...info };
  } catch (err) {
    teardownSession();
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('send-message', (_e, payload) => {
  if (!session) return { ok: false, error: '세션이 없습니다.' };
  const { text, replyTo } = (payload && typeof payload === 'object') ? payload : { text: payload };
  const t = String(text || '').slice(0, 4000);
  if (!t.trim()) return { ok: false };
  session.sendChat(t, replyTo || null);
  return { ok: true };
});

ipcMain.handle('set-pin', (_e, { action, item }) => {
  if (!session) return { ok: false, error: '세션이 없습니다.' };
  session.setPin(action === 'unpin' ? 'unpin' : 'pin', item);
  return { ok: true };
});

// 파일 첨부 다이얼로그 — 선택된 파일 경로 목록을 반환
ipcMain.handle('open-file-dialog', async () => {
  if (!mainWindow) return { ok: false, paths: [] };
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '보낼 파일 선택',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
      { name: '문서', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'hwp', 'csv'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  if (r.canceled) return { ok: true, paths: [] };
  return { ok: true, paths: r.filePaths };
});

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

function mimeFromName(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// 파일 경로 목록을 읽어 세션으로 전송. (다이얼로그 선택 또는 드래그&드롭에서 사용)
ipcMain.handle('send-files', async (_e, payload) => {
  if (!session) return { ok: false, error: '세션이 없습니다.' };
  const { paths, replyTo } = (payload && typeof payload === 'object' && !Array.isArray(payload))
    ? payload : { paths: payload, replyTo: null };
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  const results = [];
  let firstSent = false;
  for (const p of list) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) { results.push({ path: p, ok: false, error: '파일이 아닙니다.' }); continue; }
      if (stat.size > MAX_FILE_BYTES) {
        results.push({ path: p, ok: false, error: '파일이 너무 큽니다 (최대 20MB).' });
        continue;
      }
      const buf = fs.readFileSync(p);
      const filename = path.basename(p);
      // 답장 인용은 첫 파일에만 붙인다 (여러 장 보낼 때 인용 중복 방지)
      session.sendFile({
        filename, mime: mimeFromName(filename), size: stat.size,
        data: buf.toString('base64'),
      }, firstSent ? null : (replyTo || null));
      firstSent = true;
      results.push({ path: p, ok: true });
    } catch (err) {
      results.push({ path: p, ok: false, error: String(err.message || err) });
    }
  }
  return { ok: true, results };
});

// 수신한 파일을 디스크에 저장 (저장 위치 다이얼로그)
ipcMain.handle('save-file', async (_e, { filename, data }) => {
  if (!mainWindow) return { ok: false, error: '창이 없습니다.' };
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: filename || 'download' });
  if (r.canceled || !r.filePath) return { ok: true, canceled: true };
  try {
    fs.writeFileSync(r.filePath, Buffer.from(String(data || ''), 'base64'));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('leave-room', () => {
  teardownSession();
  return { ok: true };
});

ipcMain.handle('get-local-ip', () => getLocalIPv4());

// 창 제어 (REQ-007, REQ-008)
ipcMain.handle('set-always-on-top', (_e, value) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(!!value, 'screen-saver');
  return { ok: true, value: !!value };
});

ipcMain.handle('set-opacity', (_e, value) => {
  let v = Number(value);
  if (Number.isNaN(v)) v = 1;
  v = Math.min(1, Math.max(0.2, v)); // 20% ~ 100%
  if (mainWindow) mainWindow.setOpacity(v);
  return { ok: true, value: v };
});

ipcMain.handle('minimize-to-tray', () => {
  if (mainWindow) mainWindow.hide();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// 앱 라이프사이클
// ---------------------------------------------------------------------------

// 단일 인스턴스 보장 (트레이 충돌 방지)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    createWindow();
    createTray();
    initAutoUpdate(() => mainWindow);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // 트레이 상주 앱이므로 모든 창이 닫혀도 종료하지 않음 (명시적 종료만)
  });

  app.on('before-quit', () => {
    isQuitting = true;
    teardownSession();
  });
}
