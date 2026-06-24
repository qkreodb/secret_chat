'use strict';

const $ = (id) => document.getElementById(id);
const api = window.chatAPI;

let myName = '';
let isHost = false;

// ---------------------------------------------------------------------------
// 뷰 전환
// ---------------------------------------------------------------------------
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(id).classList.add('active');
}

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.back));
});

// 앱 내부 안내 토스트
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------------------------------------------------------------------------
// 1) 이름 입력
// ---------------------------------------------------------------------------
$('btnNameNext').addEventListener('click', goFromName);
$('inpName').addEventListener('keydown', (e) => { if (e.key === 'Enter') goFromName(); });

function goFromName() {
  const name = $('inpName').value.trim();
  if (!name) { toast('이름을 입력하세요.'); return; }
  myName = name;
  $('helloName').textContent = name;
  showView('view-menu');
}

// ---------------------------------------------------------------------------
// 2) 메뉴
// ---------------------------------------------------------------------------
$('btnGoCreate').addEventListener('click', () => {
  $('createErr').textContent = '';
  showView('view-create');
});
$('btnGoJoin').addEventListener('click', () => {
  $('joinErr').textContent = '';
  showView('view-join');
  populateLocalPortHint();
  scanRooms();
});

async function populateLocalPortHint() {
  try {
    const ip = await api.getLocalIP();
    $('inpHostIp').placeholder = `예: ${ip}`;
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// 3) 방 개설
// ---------------------------------------------------------------------------
$('btnCreate').addEventListener('click', async () => {
  const roomName = $('inpRoomName').value.trim();
  const password = $('inpRoomPw').value;
  const hidden = $('inpHidden').checked;
  if (!roomName) { $('createErr').textContent = '방 이름을 입력하세요.'; return; }
  if (!password) { $('createErr').textContent = '비밀번호를 입력하세요.'; return; }

  $('btnCreate').disabled = true;
  const res = await api.createRoom({ username: myName, roomName, password, hidden });
  $('btnCreate').disabled = false;

  if (!res.ok) { $('createErr').textContent = res.error || '방 개설 실패'; return; }

  isHost = true;
  enterChat(res.roomName, {
    ip: res.ip, port: res.port, hidden: res.hidden, host: true,
  });
});

// ---------------------------------------------------------------------------
// 4) 방 참가
// ---------------------------------------------------------------------------
$('btnRescan').addEventListener('click', scanRooms);

async function scanRooms() {
  const list = $('roomList');
  list.innerHTML = '<li class="empty">탐색 중...</li>';
  const res = await api.discoverRooms();
  const rooms = (res && res.rooms) || [];
  if (!rooms.length) {
    list.innerHTML = '<li class="empty">공개방을 찾지 못했습니다. 직접 입장을 이용하세요.</li>';
    return;
  }
  list.innerHTML = '';
  rooms.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="rn">${escapeHtml(r.roomName)}</span>
                    <span class="ra">${r.ip}:${r.port} · ${r.userCount}명</span>`;
    li.addEventListener('click', () => promptJoinPublic(r));
    list.appendChild(li);
  });
}

function promptJoinPublic(room) {
  // 공개방 선택 시: IP/포트는 채워두고 비밀번호 입력란으로 유도
  $('inpHostIp').value = room.ip;
  $('inpHostPort').value = room.port;
  $('inpJoinPw').focus();
  toast(`"${room.roomName}" 선택됨 — 비밀번호를 입력하세요.`);
}

$('btnManualJoin').addEventListener('click', doJoin);
$('inpJoinPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

async function doJoin() {
  const host = $('inpHostIp').value.trim();
  const port = parseInt($('inpHostPort').value.trim() || '47655', 10);
  const password = $('inpJoinPw').value;
  if (!host) { $('joinErr').textContent = 'IP 주소를 입력하세요.'; return; }
  if (!port) { $('joinErr').textContent = '포트가 올바르지 않습니다.'; return; }

  $('btnManualJoin').disabled = true;
  $('joinErr').textContent = '접속 중...';
  const res = await api.joinRoom({ username: myName, host, port, password });
  $('btnManualJoin').disabled = false;

  if (!res.ok) { $('joinErr').textContent = res.error || '입장 실패'; return; }
  $('joinErr').textContent = '';
  isHost = false;
  myName = res.username || myName; // 서버가 이름 중복 처리했을 수 있음
  enterChat(res.roomName, { host: false });
  renderUsers(res.users || []);
}

// ---------------------------------------------------------------------------
// 5) 채팅
// ---------------------------------------------------------------------------
function enterChat(roomName, meta) {
  $('chatRoomName').textContent = roomName;
  if (meta.host) {
    const vis = meta.hidden ? '비공개' : '공개';
    $('chatRoomMeta').textContent = `방장 · ${vis} · 내 IP ${meta.ip}:${meta.port}`;
  } else {
    $('chatRoomMeta').textContent = '참가자';
  }
  $('messages').innerHTML = '';
  showView('view-chat');
  $('inpMsg').focus();
  addSystem(meta.host ? '방을 개설했습니다. 친구에게 IP·포트·비밀번호를 알려주세요.' : '방에 입장했습니다.');
}

$('btnSend').addEventListener('click', sendMsg);
$('inpMsg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMsg();
  }
});
// 입력창 높이 자동 조절
$('inpMsg').addEventListener('input', () => {
  const t = $('inpMsg');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 120) + 'px';
});

async function sendMsg() {
  const t = $('inpMsg');
  const text = t.value;
  if (!text.trim()) return;
  await api.sendMessage(text);
  t.value = '';
  t.style.height = 'auto';
}

$('btnLeave').addEventListener('click', async () => {
  await api.leaveRoom();
  showView('view-menu');
  toast('방에서 나갔습니다.');
});

// ---------------------------------------------------------------------------
// 메시지 렌더링
// ---------------------------------------------------------------------------
function addChat({ username, text, ts, self }) {
  const row = document.createElement('div');
  row.className = 'msg-row ' + (self ? 'me' : 'other');
  if (!self) {
    const name = document.createElement('div');
    name.className = 'msg-name';
    name.textContent = username;
    row.appendChild(name);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.appendChild(bubble);

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(ts);
  row.appendChild(time);

  appendRow(row);
}

function addSystem(text) {
  const row = document.createElement('div');
  row.className = 'sys-row';
  row.textContent = text;
  appendRow(row);
}

function appendRow(row) {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.appendChild(row);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderUsers(users) {
  const ul = $('userList');
  ul.innerHTML = '';
  users.forEach((name, i) => {
    const li = document.createElement('li');
    li.textContent = name;
    if (i === 0) li.classList.add('host'); // 첫 번째가 방장
    if (name === myName) li.classList.add('me-user');
    ul.appendChild(li);
  });
  $('userCount').textContent = users.length;
}

// ---------------------------------------------------------------------------
// 메인 프로세스 이벤트 구독
// ---------------------------------------------------------------------------
api.onChat((m) => addChat(m));
api.onSystem((m) => addSystem(m.text));
api.onUsers((users) => renderUsers(users));
api.onDisconnected((info) => {
  addSystem(info.reason || '연결이 종료되었습니다.');
  toast('연결이 종료되었습니다.');
});
api.onNetError((msg) => toast('네트워크: ' + msg));

// ---------------------------------------------------------------------------
// 창 제어 (REQ-007, REQ-008, REQ-009)
// ---------------------------------------------------------------------------
let pinned = false;
$('btnPin').addEventListener('click', async () => {
  pinned = !pinned;
  await api.setAlwaysOnTop(pinned);
  $('btnPin').classList.toggle('on', pinned);
  $('btnPin').title = pinned ? '항상 위 켜짐' : '항상 위에 표시';
  toast(pinned ? '항상 위에 표시: 켜짐' : '항상 위에 표시: 꺼짐');
});

$('opacity').addEventListener('input', async (e) => {
  const pct = parseInt(e.target.value, 10);
  $('opacityVal').textContent = pct + '%';
  await api.setOpacity(pct / 100);
});

$('btnTray').addEventListener('click', () => api.minimizeToTray());

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
function formatTime(ts) {
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 시작 시 이름 입력란 포커스
window.addEventListener('DOMContentLoaded', () => $('inpName').focus());
