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
  msgIndex.clear();
  cancelReply();
  renderPinBar([]);
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
  await api.sendMessage(text, replyingTo);
  t.value = '';
  t.style.height = 'auto';
  cancelReply();
}

// ---------------------------------------------------------------------------
// 답장(Reply) 상태
// ---------------------------------------------------------------------------
let replyingTo = null; // { id, username, preview } | null

function startReply(meta) {
  if (!meta || !meta.id) return;
  const preview = previewOf(meta);
  replyingTo = { id: meta.id, username: meta.username, preview };
  $('replyName').textContent = meta.username;
  $('replyPreview').textContent = preview;
  $('replyBar').classList.remove('hidden');
  $('inpMsg').focus();
}

function cancelReply() {
  replyingTo = null;
  $('replyBar').classList.add('hidden');
}

$('btnCancelReply').addEventListener('click', cancelReply);

// ---------------------------------------------------------------------------
// 우클릭 컨텍스트 메뉴 (답장 / 고정)
// ---------------------------------------------------------------------------
function openContextMenu(e, meta) {
  const menu = $('ctxMenu');
  menu.innerHTML = '';
  const addItem = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => { closeContextMenu(); fn(); });
    menu.appendChild(b);
  };
  addItem('↩ 답장', () => startReply(meta));
  if (meta.id) {
    if (pinnedIds.has(meta.id)) addItem('📌 고정 해제', () => api.setPin('unpin', { id: meta.id }));
    else addItem('📌 고정', () => api.setPin('pin', pinItemOf(meta)));
  }
  menu.classList.remove('hidden');
  // 화면 밖으로 넘치지 않도록 위치 보정
  const rect = menu.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth - rect.width - 6);
  const y = Math.min(e.clientY, window.innerHeight - rect.height - 6);
  menu.style.left = Math.max(6, x) + 'px';
  menu.style.top = Math.max(6, y) + 'px';
}

function closeContextMenu() { $('ctxMenu').classList.add('hidden'); }
document.addEventListener('click', closeContextMenu);
window.addEventListener('blur', closeContextMenu);
$('messages').addEventListener('scroll', closeContextMenu);

function pinItemOf(meta) {
  return {
    id: meta.id,
    msgType: meta.msgType,
    username: meta.username,
    text: meta.msgType === 'CHAT' ? meta.text : '',
    filename: meta.filename || '',
    ts: meta.ts,
  };
}

// ---------------------------------------------------------------------------
// 고정(핀) 바
// ---------------------------------------------------------------------------
let pinnedIds = new Set();

function pinTextOf(p) {
  if (p.msgType === 'FILE') return '📎 ' + (p.filename || '파일');
  return String(p.text || '').replace(/\s+/g, ' ');
}

function renderPinBar(list) {
  const items = list || [];
  pinnedIds = new Set(items.map((p) => p.id));
  const bar = $('pinBar');
  bar.innerHTML = '';
  if (!items.length) { bar.classList.add('hidden'); return; }

  items.forEach((p) => {
    const item = document.createElement('div');
    item.className = 'pin-item';

    const icon = document.createElement('span');
    icon.className = 'pi-icon';
    icon.textContent = '📌';

    const txt = document.createElement('span');
    txt.className = 'pi-text';
    const nm = document.createElement('span');
    nm.className = 'pi-name';
    nm.textContent = p.username;
    txt.appendChild(nm);
    txt.appendChild(document.createTextNode(pinTextOf(p)));

    const unpin = document.createElement('button');
    unpin.className = 'pi-unpin';
    unpin.textContent = '✕';
    unpin.title = '고정 해제';
    unpin.addEventListener('click', (e) => { e.stopPropagation(); api.setPin('unpin', { id: p.id }); });

    item.appendChild(icon);
    item.appendChild(txt);
    item.appendChild(unpin);
    item.addEventListener('click', () => jumpToMessage(p.id));
    bar.appendChild(item);
  });
  bar.classList.remove('hidden');
}

$('btnLeave').addEventListener('click', async () => {
  await api.leaveRoom();
  closeEmoji();
  showView('view-menu');
  toast('방에서 나갔습니다.');
});

// ---------------------------------------------------------------------------
// 점심 메뉴 추첨
// ---------------------------------------------------------------------------
// ▼▼▼ 여기에 점심 메뉴를 채워 넣으세요 (따옴표로 감싸고 쉼표로 구분) ▼▼▼
// 예: const LUNCH_MENUS = ['김치찌개', '돈까스', '제육볶음', '국밥', '햄버거'];
const LUNCH_MENUS = [
  '맘스터치','롯데리아','버거킹','프랭크버거','기좋뷔','건강짬뽕','기름짬뽕','순대국밥','롤링파스타','돼지국밥','꼬마김밥','김밥천국','청국장','김찌','리틀탭(수제버거)','비싼 점특','돈까스','초밥'
];
// ▲▲▲ 여기까지 ▲▲▲

$('btnLunch').addEventListener('click', () => {
  if (!LUNCH_MENUS.length) {
    toast('점심 메뉴가 비어 있어요. renderer.js의 LUNCH_MENUS에 메뉴를 채워주세요.');
    return;
  }
  const pick = LUNCH_MENUS[Math.floor(Math.random() * LUNCH_MENUS.length)];
  // 추첨 결과를 방 전체에 채팅 메시지로 전송 (모두가 볼 수 있게)
  api.sendMessage(`🍽️ 오늘 점심 추첨 결과: ${pick}!`);
});

// ---------------------------------------------------------------------------
// 이모티콘 picker
// ---------------------------------------------------------------------------
const EMOJI = {
  '😊': ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥳','🤩','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🫢','🤭','🤫','😶','😐','😑','😬','🙄','😯','😴','🤤','😪','🤢','🤮','🤧','😷','🤒','🤕','🥱'],
  '👍': ['👍','👎','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👋','🤚','🖐️','✋','🖖','🫶','👏','🙌','🤝','🙏','✊','👊','🤛','🤜','💪','🫵','🤲','👐','🤦','🤷','💁','🙆','🙅','🙋','🧏','💆','💇','🚶','🏃','🕺','💃'],
  '❤️': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💯','✨','⭐','🌟','💫','⚡','🔥','💥','💢','💦','💨','🎉','🎊','🎈','🎁','🏆','🥇','🌈','☀️','⛅','☁️','❄️','🌙','✅','❌','⭕','❗','❓','💤'],
  '🐶': ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐢','🐙','🦑','🦀','🐠','🐟','🐬','🐳','🐋','🌸','🌹','🌻','🌷','🌲','🌳','🍀','🍁'],
  '🍔': ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🌽','🥕','🍞','🥐','🧀','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🍜','🍝','🍣','🍱','🍙','🍚','🍰','🎂','🧁','🍪','🍫','🍬','🍭','🍩','🍦','☕','🍺','🍻','🥂','🍷'],
  '⚽': ['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥅','⛳','🏹','🎣','🥊','🥋','🛹','🛼','🎿','⛸️','🎽','🏆','🏅','🎮','🕹️','🎲','🎯','🎰','🎸','🎹','🎺','🎷','🥁','🎤','🎧','🎬','📱','💻','⌨️','🖥️','📷','💡','🔦','📚','✏️','📌','📎','💰','💳','🔑','🚗','✈️','🚀'],
};
const EMOJI_TABS = Object.keys(EMOJI);
let emojiBuilt = false;

function buildEmojiPanel() {
  if (emojiBuilt) return;
  const tabs = $('emojiTabs');
  EMOJI_TABS.forEach((key, i) => {
    const b = document.createElement('button');
    b.className = 'emoji-tab' + (i === 0 ? ' active' : '');
    b.textContent = key;
    b.addEventListener('click', () => selectEmojiTab(key, b));
    tabs.appendChild(b);
  });
  renderEmojiGrid(EMOJI_TABS[0]);
  emojiBuilt = true;
}

function selectEmojiTab(key, btn) {
  document.querySelectorAll('.emoji-tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  renderEmojiGrid(key);
}

function renderEmojiGrid(key) {
  const grid = $('emojiGrid');
  grid.innerHTML = '';
  EMOJI[key].forEach((emo) => {
    const b = document.createElement('button');
    b.textContent = emo;
    b.addEventListener('click', () => insertEmoji(emo));
    grid.appendChild(b);
  });
  grid.scrollTop = 0;
}

function insertEmoji(emo) {
  const t = $('inpMsg');
  const start = t.selectionStart ?? t.value.length;
  const end = t.selectionEnd ?? t.value.length;
  t.value = t.value.slice(0, start) + emo + t.value.slice(end);
  const pos = start + emo.length;
  t.selectionStart = t.selectionEnd = pos;
  t.focus();
  t.dispatchEvent(new Event('input')); // 높이 자동조절 반영
}

function openEmoji() {
  buildEmojiPanel();
  $('emojiPanel').classList.remove('hidden');
  $('btnEmoji').classList.add('on');
}
function closeEmoji() {
  $('emojiPanel').classList.add('hidden');
  $('btnEmoji').classList.remove('on');
}

$('btnEmoji').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('emojiPanel').classList.contains('hidden')) openEmoji();
  else closeEmoji();
});
// 패널 바깥 클릭 시 닫기
document.addEventListener('click', (e) => {
  const panel = $('emojiPanel');
  if (panel.classList.contains('hidden')) return;
  if (panel.contains(e.target) || e.target === $('btnEmoji')) return;
  closeEmoji();
});

// ---------------------------------------------------------------------------
// 파일 전송 (첨부 버튼 + 드래그&드롭)
// ---------------------------------------------------------------------------
$('btnAttach').addEventListener('click', async () => {
  const res = await api.openFileDialog();
  if (!res || !res.ok || !res.paths.length) return;
  await sendFilePaths(res.paths);
});

async function sendFilePaths(paths) {
  const reply = replyingTo;       // 첨부 전송에도 현재 답장 인용을 적용
  cancelReply();
  const res = await api.sendFiles(paths, reply);
  if (!res || !res.ok) { toast('파일 전송 실패: ' + ((res && res.error) || '')); return; }
  const failed = (res.results || []).filter((r) => !r.ok);
  if (failed.length) toast(failed[0].error || '일부 파일을 보내지 못했습니다.');
}

// 드래그&드롭 — Electron 은 File.path 로 실제 경로 제공
const chatMain = document.querySelector('.chat-main');
let dragDepth = 0;
chatMain.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  if ($('view-chat').classList.contains('active')) $('dropHint').classList.add('show');
});
chatMain.addEventListener('dragover', (e) => e.preventDefault());
chatMain.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('dropHint').classList.remove('show');
});
chatMain.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').classList.remove('show');
  if (!$('view-chat').classList.contains('active')) return;
  const paths = Array.from(e.dataTransfer.files || [])
    .map((f) => f.path)
    .filter(Boolean);
  if (paths.length) await sendFilePaths(paths);
});

// ---------------------------------------------------------------------------
// 메시지 렌더링
// ---------------------------------------------------------------------------
// id -> 메시지 메타 (답장 인용/고정/점프에 사용). el 로 실제 DOM 참조.
const msgIndex = new Map();

// 답장/고정에 쓰일 한 줄 미리보기 문자열
function previewOf(meta) {
  if (meta.msgType === 'FILE') {
    if (meta.mime && meta.mime.startsWith('image/')) return '📷 사진';
    return '📎 ' + (meta.filename || '파일');
  }
  return String(meta.text || '').replace(/\s+/g, ' ').slice(0, 60);
}

function buildReplyQuote(replyTo) {
  const q = document.createElement('div');
  q.className = 'reply-quote';
  const nm = document.createElement('span');
  nm.className = 'rq-name';
  nm.textContent = replyTo.username || '';
  const tx = document.createElement('span');
  tx.className = 'rq-text';
  tx.textContent = replyTo.preview || '';
  q.appendChild(nm);
  q.appendChild(tx);
  q.title = '원본 메시지로 이동';
  q.addEventListener('click', (e) => { e.stopPropagation(); jumpToMessage(replyTo.id); });
  return q;
}

// 메시지 공통 뼈대(이름·인용·hover 답장버튼·우클릭 메뉴·인덱싱)를 만들고 row 반환.
// 호출 측에서 본문(bubble)·시간을 이어 붙인다.
function makeMsgRow(meta, self) {
  const row = document.createElement('div');
  row.className = 'msg-row ' + (self ? 'me' : 'other');
  if (meta.id) row.dataset.id = meta.id;

  if (!self) {
    const name = document.createElement('div');
    name.className = 'msg-name';
    name.textContent = meta.username;
    row.appendChild(name);
  }

  if (meta.replyTo && meta.replyTo.id) {
    row.appendChild(buildReplyQuote(meta.replyTo));
  }

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const rbtn = document.createElement('button');
  rbtn.textContent = '↩';
  rbtn.title = '답장';
  rbtn.addEventListener('click', (e) => { e.stopPropagation(); startReply(meta); });
  actions.appendChild(rbtn);
  row.appendChild(actions);

  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(e, meta); });

  if (meta.id) { meta.el = row; msgIndex.set(meta.id, meta); }
  return row;
}

function addChat(m) {
  const meta = {
    id: m.id, msgType: 'CHAT', username: m.username,
    text: m.text, replyTo: m.replyTo || null, ts: m.ts,
  };
  const row = makeMsgRow(meta, m.self);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = m.text;
  row.appendChild(bubble);

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(m.ts);
  row.appendChild(time);

  appendRow(row);
}

// 인용/고정에서 원본 메시지로 스크롤 + 잠깐 강조
function jumpToMessage(id) {
  const entry = msgIndex.get(id);
  if (!entry || !entry.el) { toast('원본 메시지를 찾을 수 없습니다.'); return; }
  entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  entry.el.classList.remove('flash');
  void entry.el.offsetWidth; // 애니메이션 재시작용 reflow
  entry.el.classList.add('flash');
  setTimeout(() => entry.el && entry.el.classList.remove('flash'), 1300);
}

function addFile(m) {
  const { username, filename, mime, size, data, ts, self } = m;
  const meta = {
    id: m.id, msgType: 'FILE', username, filename, mime,
    replyTo: m.replyTo || null, ts,
  };
  const row = makeMsgRow(meta, self);

  const bubble = document.createElement('div');
  bubble.className = 'bubble file-bubble';

  if (mime && mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.className = 'img-attach';
    img.src = `data:${mime};base64,${data}`;
    img.title = `${filename} (${formatSize(size)}) — 클릭하여 저장`;
    img.addEventListener('click', () => downloadFile(filename, data));
    bubble.appendChild(img);
  } else {
    const card = document.createElement('div');
    card.className = 'file-card';

    const icon = document.createElement('div');
    icon.className = 'fc-icon';
    icon.textContent = fileIcon(mime, filename);
    card.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'fc-info';
    const nm = document.createElement('div');
    nm.className = 'fc-name';
    nm.textContent = filename;
    const sz = document.createElement('div');
    sz.className = 'fc-size';
    sz.textContent = formatSize(size);
    info.appendChild(nm);
    info.appendChild(sz);

    const dl = document.createElement('button');
    dl.className = 'file-dl';
    dl.textContent = '⤓ 저장';
    dl.addEventListener('click', () => downloadFile(filename, data));
    info.appendChild(dl);

    card.appendChild(info);
    bubble.appendChild(card);
  }

  row.appendChild(bubble);

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(ts);
  row.appendChild(time);

  appendRow(row);
}

async function downloadFile(filename, data) {
  const res = await api.saveFile({ filename, data });
  if (res && res.ok && !res.canceled) toast('저장됨: ' + res.path);
  else if (res && !res.ok) toast('저장 실패: ' + (res.error || ''));
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
api.onFile((m) => addFile(m));
api.onPin((m) => renderPinBar(m.pinned || []));
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

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function fileIcon(mime, filename) {
  const m = String(mime || '');
  const ext = String(filename || '').split('.').pop().toLowerCase();
  if (m === 'application/pdf' || ext === 'pdf') return '📕';
  if (m.startsWith('video/')) return '🎬';
  if (m.startsWith('audio/')) return '🎵';
  if (m.startsWith('text/') || ext === 'txt') return '📄';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  return '📎';
}

// 시작 시 이름 입력란 포커스
window.addEventListener('DOMContentLoaded', () => $('inpName').focus());
