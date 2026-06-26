'use strict';

// GitHub Releases 기반 자동 업데이트.
// 앱이 켜질 때 새 버전을 확인하고, 백그라운드로 내려받은 뒤 사용자에게 재시작을 묻는다.
// 소스(개발) 실행이나 electron-updater 미설치 환경에서도 앱이 죽지 않도록 전부 방어한다.

const { app, dialog } = require('electron');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {
  autoUpdater = null;
}

function initAutoUpdate(getWindow) {
  // 패키징되지 않은 소스 실행(npm start) 중에는 업데이트 검사를 하지 않는다.
  if (!autoUpdater || !app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    // 네트워크 단절·릴리스 없음 등은 치명적이지 않으므로 로그만 남기고 무시한다.
    console.error('[updater]', err == null ? 'unknown error' : (err.stack || err).toString());
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    const opts = {
      type: 'info',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: '업데이트 준비 완료',
      message: `새 버전 ${info && info.version ? info.version : ''}이(가) 다운로드되었습니다.`,
      detail: '지금 재시작하면 업데이트가 적용됩니다. 나중에 종료할 때 자동 적용됩니다.',
    };
    try {
      const r = win
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts);
      if (r.response === 0) {
        // 트레이 상주 앱이라 일반 quit으로는 안 닫히므로 quitAndInstall이 강제 종료/설치를 처리한다.
        setImmediate(() => autoUpdater.quitAndInstall());
      }
    } catch (_) { /* 다이얼로그 실패는 무시 — 다음 종료 시 자동 설치됨 */ }
  });

  // 켜질 때 1회 확인. 실패해도 조용히 무시한다.
  autoUpdater.checkForUpdates().catch(() => {});
}

module.exports = { initAutoUpdate };
