'use strict';

/*
 * network.js
 * --------------------------------------------------------------------------
 * LAN 채팅의 모든 네트워크 로직을 담당하는 모듈 (메인 프로세스에서만 사용).
 *
 *  - 방장(host) : TCP 서버를 열어 클라이언트를 받고, (공개방이면) UDP 탐색에 응답한다.
 *  - 참가자(client) : TCP 로 방장에게 접속한다. 목록 자동 탐색은 UDP 브로드캐스트로 한다.
 *
 * 메시지는 모두 줄바꿈(\n)으로 구분된 JSON 한 줄(JSON Lines) 형식이다.
 * --------------------------------------------------------------------------
 */

const net = require('net');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DISCOVERY_PORT = 47654;          // UDP 탐색 전용 고정 포트
const TCP_BASE_PORT = 47655;           // TCP 채팅 서버 시작 포트 (사용 중이면 +1 탐색)
const TCP_PORT_TRIES = 50;
const DISCOVERY_MAGIC = 'SECRET_LAN_CHAT_v1';

// 파일 전송 한도. base64 는 원본의 약 4/3 크기이므로 원본 20MB ≒ base64 ~27MB.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_B64 = Math.ceil(MAX_FILE_BYTES * 1.4);

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// 가위바위보(RPS) 설정/유틸
// ---------------------------------------------------------------------------
const RPS_MOVES = ['rock', 'paper', 'scissors'];
const RPS_ROUND_MS = 30000;       // 라운드 제한시간(이후 미선택자는 기권 처리)
const RPS_NEXT_DELAY_MS = 2500;   // 라운드 결과를 보여주고 다음 라운드로 넘어가는 텀

// 서버 역할 등 게임에서 제외할 접속자 이름(소문자 비교). 여기에 이름을 추가하면 됨.
const RPS_EXCLUDED = ['jetson'];
function isRpsExcluded(name) {
  return RPS_EXCLUDED.includes(String(name || '').trim().toLowerCase());
}

// x가 y를 이기는가?
function rpsBeats(x, y) {
  return (x === 'rock' && y === 'scissors')
    || (x === 'scissors' && y === 'paper')
    || (x === 'paper' && y === 'rock');
}

// 답장 인용 정보를 안전한 형태로 정규화 (없으면 null).
function sanitizeReply(r) {
  if (!r || typeof r !== 'object') return null;
  const id = String(r.id || '').slice(0, 32);
  if (!id) return null;
  return {
    id,
    username: String(r.username || '').slice(0, 24),
    preview: String(r.preview || '').slice(0, 80),
  };
}

// 핀(고정) 항목을 안전한 형태로 정규화 (파일 본문 data 는 포함하지 않음).
function sanitizePinItem(it) {
  if (!it || typeof it !== 'object') return null;
  const id = String(it.id || '').slice(0, 32);
  if (!id) return null;
  return {
    id,
    msgType: it.msgType === 'FILE' ? 'FILE' : 'CHAT',
    username: String(it.username || '').slice(0, 24),
    text: String(it.text || '').slice(0, 200),
    filename: String(it.filename || '').slice(0, 255),
    ts: Number(it.ts) || Date.now(),
  };
}

// 들어온 FILE 메시지를 안전한 형태로 정규화한다 (필수 필드/타입/크기 검증).
function normalizeFile(msg, username) {
  const data = String(msg.data || '');
  if (!data || data.length > MAX_FILE_B64) return null;
  return {
    type: 'FILE',
    id: String(msg.id || newId()),
    username,
    filename: String(msg.filename || 'file').slice(0, 255),
    mime: String(msg.mime || 'application/octet-stream').slice(0, 128),
    size: Number(msg.size) || 0,
    data,
    replyTo: sanitizeReply(msg.replyTo),
    ts: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 공용 유틸
// ---------------------------------------------------------------------------

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function getLocalIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name]) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address;
      }
    }
  }
  return '127.0.0.1';
}

// 줄 단위 JSON 파서를 소켓에 부착한다.
function attachLineReader(socket, onMessage) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue; // 깨진/비정상 패킷은 무시
      }
      onMessage(msg);
    }
  });
}

function sendJSON(socket, obj) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch (_) { /* 끊긴 소켓 무시 */ }
}

// ===========================================================================
// HostSession : 방장(서버) 세션
// ===========================================================================
//
//  이벤트:
//    'chat'   {username, text, ts}
//    'system' {text, ts}
//    'users'  [username, ...]
//    'error'  Error
//
class HostSession extends EventEmitter {
  constructor({ username, roomName, password, hidden }) {
    super();
    this.username = username;
    this.roomName = roomName;
    this.passwordHash = hashPassword(password);
    this.hidden = !!hidden;
    this.port = null;
    this.localIP = getLocalIPv4();

    this.clients = new Map(); // socket -> { username }
    this.server = null;
    this.udp = null;
    this.pinned = new Map();   // id -> 핀 항목 (입장 순서 유지)
    this.rps = null;           // 진행 중인 가위바위보 게임 상태 (없으면 null)
  }

  pinnedList() {
    return Array.from(this.pinned.values());
  }

  // 핀 적용 + 전체 동기화 (방장 본인 동작과 클라이언트 요청 둘 다 여기로)
  setPin(action, item) {
    const it = sanitizePinItem(item);
    if (!it) return;
    if (action === 'unpin') {
      this.pinned.delete(it.id);
    } else {
      this.pinned.delete(it.id);     // 중복 제거 후 맨 뒤로
      this.pinned.set(it.id, it);
      const MAX_PINS = 20;
      while (this.pinned.size > MAX_PINS) {
        this.pinned.delete(this.pinned.keys().next().value);
      }
    }
    const payload = { type: 'PIN', action, item: it, pinned: this.pinnedList() };
    this.broadcast(payload);
    this.emit('pin', { action, item: it, pinned: this.pinnedList() });
  }

  // 모든 접속자 이름 목록 (방장 본인 포함, 방장이 맨 앞)
  userList() {
    const names = [this.username];
    for (const info of this.clients.values()) {
      if (info.username) names.push(info.username);
    }
    return names;
  }

  broadcast(obj, exceptSocket = null) {
    for (const sock of this.clients.keys()) {
      if (sock !== exceptSocket) sendJSON(sock, obj);
    }
  }

  pushUsers() {
    const users = this.userList();
    this.broadcast({ type: 'USERS', users });
    this.emit('users', users); // 방장 자신의 UI 갱신
  }

  // 방장 본인이 입력한 메시지 전송
  sendChat(text, replyTo) {
    const msg = {
      type: 'CHAT', id: newId(), username: this.username, text,
      replyTo: sanitizeReply(replyTo), ts: Date.now(),
    };
    this.broadcast(msg);
    this.emit('chat', { ...msg, self: true });
  }

  // 방장 본인이 보낸 파일 전송
  sendFile(file, replyTo) {
    const msg = {
      type: 'FILE', id: newId(), username: this.username,
      filename: file.filename, mime: file.mime, size: file.size,
      data: file.data, replyTo: sanitizeReply(replyTo), ts: Date.now(),
    };
    this.broadcast(msg);
    this.emit('file', { ...msg, self: true });
  }

  // -------------------------------------------------------------------------
  // 가위바위보 (호스트 권위) — 최후의 1인이 남을 때까지 라운드 반복
  // -------------------------------------------------------------------------
  rpsStart() { this._rpsStart(); }

  rpsPick(move, gameId) {
    // 방장 본인의 선택
    this._rpsRecordPick(this.username, move, gameId);
  }

  _rpsReset() {
    if (this.rps && this.rps.timer) { clearTimeout(this.rps.timer); }
    this.rps = null;
  }

  _rpsStart() {
    if (this.rps && this.rps.active) return; // 이미 진행 중이면 무시
    const eligible = this.userList().filter((n) => !isRpsExcluded(n));
    if (eligible.length < 2) {
      const reason = '가위바위보를 시작하려면 참가자가 2명 이상이어야 합니다.';
      this.broadcast({ type: 'RPS_CANCEL', reason });
      this.emit('rps-cancel', { reason });
      return;
    }
    this.rps = {
      active: true, gameId: newId(), round: 0,
      alive: new Set(eligible), picks: new Map(), timer: null,
    };
    this._rpsNewRound();
  }

  _rpsNewRound() {
    const g = this.rps;
    if (!g || !g.active) return;
    g.round += 1;
    g.picks = new Map();
    if (g.timer) clearTimeout(g.timer);
    const payload = {
      type: 'RPS_INVITE', gameId: g.gameId, round: g.round, players: [...g.alive],
    };
    this.broadcast(payload);
    this.emit('rps-invite', payload);
    g.timer = setTimeout(() => this._rpsResolve(), RPS_ROUND_MS);
  }

  _rpsRecordPick(username, move, gameId) {
    const g = this.rps;
    if (!g || !g.active) return;
    if (gameId && gameId !== g.gameId) return; // 지난 게임의 늦은 선택 무시
    if (!g.alive.has(username)) return;        // 탈락/제외자
    if (!RPS_MOVES.includes(move)) return;
    if (g.picks.has(username)) return;         // 이미 냈음
    g.picks.set(username, move);

    // 진행상황 알림(누가 냈는지만, 무엇을 냈는지는 비공개)
    const prog = {
      type: 'RPS_PROGRESS', gameId: g.gameId, round: g.round,
      picked: [...g.picks.keys()], total: g.alive.size,
    };
    this.broadcast(prog);
    this.emit('rps-progress', prog);

    // 살아있는 전원이 제출하면 즉시 판정
    let all = true;
    for (const p of g.alive) { if (!g.picks.has(p)) { all = false; break; } }
    if (all) this._rpsResolve();
  }

  _rpsResolve() {
    const g = this.rps;
    if (!g || !g.active) return;
    if (g.timer) { clearTimeout(g.timer); g.timer = null; }

    const aliveArr = [...g.alive];
    const picked = aliveArr.filter((p) => g.picks.has(p));
    const abstained = aliveArr.filter((p) => !g.picks.has(p)); // 미선택 → 기권(탈락)

    if (picked.length === 0) {
      const reason = '아무도 내지 않아 가위바위보가 취소되었습니다.';
      this.broadcast({ type: 'RPS_CANCEL', reason });
      this.emit('rps-cancel', { reason });
      this._rpsReset();
      return;
    }

    const picksObj = {};
    for (const p of picked) picksObj[p] = g.picks.get(p);

    let advancing;
    let eliminated = [...abstained];
    let draw = false;
    const moves = new Set(picked.map((p) => g.picks.get(p)));
    if (moves.size === 2) {
      const [a, b] = [...moves];
      const winMove = rpsBeats(a, b) ? a : b;
      advancing = picked.filter((p) => g.picks.get(p) === winMove);
      eliminated = eliminated.concat(picked.filter((p) => g.picks.get(p) !== winMove));
    } else {
      // 1종(전원 동일) 또는 3종(가위·바위·보 모두) → 무승부: 제출자 전원 생존
      advancing = picked;
      draw = true;
    }
    g.alive = new Set(advancing);

    const result = {
      type: 'RPS_ROUND', gameId: g.gameId, round: g.round,
      picks: picksObj, advancing, eliminated, abstained, draw,
    };
    this.broadcast(result);
    this.emit('rps-round', result);

    if (g.alive.size <= 1) {
      const over = { type: 'RPS_OVER', gameId: g.gameId, winner: advancing[0] || null };
      this.broadcast(over);
      this.emit('rps-over', over);
      this._rpsReset();
    } else {
      const gid = g.gameId;
      setTimeout(() => {
        if (this.rps && this.rps.active && this.rps.gameId === gid) this._rpsNewRound();
      }, RPS_NEXT_DELAY_MS);
    }
  }

  // 게임 도중 접속자가 나갔을 때 정리
  _rpsHandleLeave(name) {
    const g = this.rps;
    if (!g || !g.active || !name || !g.alive.has(name)) return;
    g.alive.delete(name);
    g.picks.delete(name);
    if (g.alive.size === 1) {
      const over = { type: 'RPS_OVER', gameId: g.gameId, winner: [...g.alive][0], reason: '상대 퇴장' };
      this.broadcast(over);
      this.emit('rps-over', over);
      this._rpsReset();
      return;
    }
    if (g.alive.size === 0) {
      const reason = '참가자가 모두 나가 가위바위보가 취소되었습니다.';
      this.broadcast({ type: 'RPS_CANCEL', reason });
      this.emit('rps-cancel', { reason });
      this._rpsReset();
      return;
    }
    let all = true;
    for (const p of g.alive) { if (!g.picks.has(p)) { all = false; break; } }
    if (all) this._rpsResolve();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._onConnection(socket));
      this.server.on('error', (err) => {
        this.emit('error', err);
      });

      const tryListen = (port, attemptsLeft) => {
        this.server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
            tryListen(port + 1, attemptsLeft - 1);
          } else {
            reject(err);
          }
        });
        this.server.listen(port, () => {
          this.port = port;
          this._startDiscoveryResponder();
          resolve({ ip: this.localIP, port: this.port, roomName: this.roomName });
        });
      };

      tryListen(TCP_BASE_PORT, TCP_PORT_TRIES);
    });
  }

  _onConnection(socket) {
    socket.setKeepAlive(true, 15000);
    let joined = false;
    const info = { username: null };

    const handleMessage = (msg) => {
      if (!joined) {
        if (msg.type !== 'JOIN') return;
        if (msg.passwordHash !== this.passwordHash) {
          sendJSON(socket, { type: 'JOIN_FAIL', reason: '비밀번호가 일치하지 않습니다.' });
          socket.end();
          return;
        }
        let name = String(msg.username || '익명').slice(0, 24);
        // 이름 중복 처리
        const existing = new Set(this.userList());
        if (existing.has(name)) {
          let n = 2;
          while (existing.has(`${name}(${n})`)) n++;
          name = `${name}(${n})`;
        }
        info.username = name;
        joined = true;
        this.clients.set(socket, info);

        sendJSON(socket, {
          type: 'JOIN_OK',
          roomName: this.roomName,
          username: name,
          users: this.userList(),
          pinned: this.pinnedList(),
        });
        const sysText = `${name} 님이 입장했습니다.`;
        this.broadcast({ type: 'SYSTEM', text: sysText, ts: Date.now() }, socket);
        this.emit('system', { text: sysText, ts: Date.now() });
        this.pushUsers();
        return;
      }

      if (msg.type === 'CHAT') {
        const text = String(msg.text || '');
        if (!text) return;
        const out = {
          type: 'CHAT', id: String(msg.id || newId()), username: info.username,
          text, replyTo: sanitizeReply(msg.replyTo), ts: Date.now(),
        };
        this.broadcast(out, socket);              // 다른 클라이언트들에게
        this.emit('chat', { ...out, self: false }); // 방장 UI
        return;
      }

      if (msg.type === 'FILE') {
        const out = normalizeFile(msg, info.username);
        if (!out) return;
        this.broadcast(out, socket);              // 다른 클라이언트들에게 중계
        this.emit('file', { ...out, self: false }); // 방장 UI
        return;
      }

      if (msg.type === 'PIN') {
        this.setPin(msg.action, msg.item); // 권위적 적용 + 전체 동기화
        return;
      }

      if (msg.type === 'RPS_START') {
        this._rpsStart();
        return;
      }

      if (msg.type === 'RPS_PICK') {
        this._rpsRecordPick(info.username, msg.move, msg.gameId);
      }
    };

    attachLineReader(socket, handleMessage);

    const cleanup = () => {
      if (this.clients.has(socket)) {
        const name = info.username;
        this.clients.delete(socket);
        if (name) {
          const sysText = `${name} 님이 퇴장했습니다.`;
          this.broadcast({ type: 'SYSTEM', text: sysText, ts: Date.now() });
          this.emit('system', { text: sysText, ts: Date.now() });
          this.pushUsers();
          this._rpsHandleLeave(name); // 게임 중 퇴장 처리
        }
      }
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  _startDiscoveryResponder() {
    if (this.hidden) return; // 비공개방은 탐색에 절대 응답하지 않음
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = udp;

    udp.on('error', (err) => {
      // 같은 PC 에서 다른 인스턴스가 이미 바인딩한 경우 등 — 탐색 응답만 비활성화
      this.emit('error', new Error('탐색 응답 비활성화: ' + err.message));
      try { udp.close(); } catch (_) {}
      this.udp = null;
    });

    udp.on('message', (data, rinfo) => {
      let req;
      try { req = JSON.parse(data.toString('utf8')); } catch (_) { return; }
      if (req.magic !== DISCOVERY_MAGIC || req.type !== 'DISCOVER') return;
      const reply = Buffer.from(JSON.stringify({
        magic: DISCOVERY_MAGIC,
        type: 'ROOM_INFO',
        roomName: this.roomName,
        ip: this.localIP,
        port: this.port,
        userCount: this.userList().length,
      }));
      udp.send(reply, rinfo.port, rinfo.address);
    });

    udp.bind(DISCOVERY_PORT, () => {
      try { udp.setBroadcast(true); } catch (_) {}
    });
  }

  stop() {
    this._rpsReset();
    for (const sock of this.clients.keys()) {
      try { sock.destroy(); } catch (_) {}
    }
    this.clients.clear();
    if (this.udp) { try { this.udp.close(); } catch (_) {} this.udp = null; }
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; }
  }
}

// ===========================================================================
// ClientSession : 참가자(클라이언트) 세션
// ===========================================================================
//
//  이벤트:
//    'chat'   {username, text, ts, self}
//    'system' {text, ts}
//    'users'  [username, ...]
//    'closed' {reason}
//
class ClientSession extends EventEmitter {
  constructor({ username, host, port, password }) {
    super();
    this.username = username;
    this.host = host;
    this.port = port;
    this.passwordHash = hashPassword(password);
    this.socket = null;
    this.roomName = null;
    this.assignedName = username;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setKeepAlive(true, 15000);

      const failOnce = (err) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_) {}
        reject(err);
      };

      socket.once('error', (err) => failOnce(new Error('접속 실패: ' + err.message)));
      const connectTimer = setTimeout(() => failOnce(new Error('접속 시간 초과 (IP/포트 확인)')), 6000);

      socket.on('connect', () => {
        sendJSON(socket, {
          type: 'JOIN',
          username: this.username,
          passwordHash: this.passwordHash,
        });
      });

      attachLineReader(socket, (msg) => {
        if (!settled) {
          if (msg.type === 'JOIN_OK') {
            settled = true;
            clearTimeout(connectTimer);
            this.roomName = msg.roomName;
            this.assignedName = msg.username || this.username;
            this.emit('users', msg.users || []);
            this.emit('pin', { pinned: msg.pinned || [] }); // 입장 시 현재 고정 목록 반영
            resolve({ roomName: this.roomName, username: this.assignedName, users: msg.users || [] });
            return;
          }
          if (msg.type === 'JOIN_FAIL') {
            clearTimeout(connectTimer);
            failOnce(new Error(msg.reason || '입장이 거부되었습니다.'));
            return;
          }
          return;
        }
        this._handleMessage(msg);
      });

      socket.on('close', () => {
        clearTimeout(connectTimer);
        if (settled) this.emit('closed', { reason: '방장과의 연결이 종료되었습니다.' });
      });
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'CHAT':
        this.emit('chat', {
          id: msg.id,
          username: msg.username,
          text: msg.text,
          replyTo: msg.replyTo || null,
          ts: msg.ts,
          self: msg.username === this.assignedName,
        });
        break;
      case 'SYSTEM':
        this.emit('system', { text: msg.text, ts: msg.ts });
        break;
      case 'USERS':
        this.emit('users', msg.users || []);
        break;
      case 'FILE':
        this.emit('file', {
          id: msg.id,
          username: msg.username,
          filename: msg.filename,
          mime: msg.mime,
          size: msg.size,
          data: msg.data,
          replyTo: msg.replyTo || null,
          ts: msg.ts,
          self: msg.username === this.assignedName,
        });
        break;
      case 'PIN':
        this.emit('pin', { action: msg.action, item: msg.item, pinned: msg.pinned || [] });
        break;
      case 'RPS_INVITE':
        this.emit('rps-invite', msg);
        break;
      case 'RPS_PROGRESS':
        this.emit('rps-progress', msg);
        break;
      case 'RPS_ROUND':
        this.emit('rps-round', msg);
        break;
      case 'RPS_OVER':
        this.emit('rps-over', msg);
        break;
      case 'RPS_CANCEL':
        this.emit('rps-cancel', msg);
        break;
    }
  }

  // 가위바위보: 요청/선택을 방장에게 전달 (판정은 방장이 권위적으로 수행)
  rpsStart() {
    sendJSON(this.socket, { type: 'RPS_START' });
  }

  rpsPick(move, gameId) {
    sendJSON(this.socket, { type: 'RPS_PICK', move, gameId });
  }

  sendChat(text, replyTo) {
    // 발신자가 id 를 만들어 자신·다른 피어가 같은 id 를 공유하게 한다 (답장/고정용).
    const id = newId();
    const reply = sanitizeReply(replyTo);
    sendJSON(this.socket, { type: 'CHAT', id, text, replyTo: reply });
    // 본인 메시지는 즉시 화면에 반영 (서버는 발신자에게 echo 하지 않음)
    this.emit('chat', { id, username: this.assignedName, text, replyTo: reply, ts: Date.now(), self: true });
  }

  sendFile(file, replyTo) {
    const id = newId();
    const reply = sanitizeReply(replyTo);
    sendJSON(this.socket, {
      type: 'FILE', id, filename: file.filename, mime: file.mime,
      size: file.size, data: file.data, replyTo: reply,
    });
    // 본인이 보낸 파일은 즉시 화면에 반영 (서버 echo 없음)
    this.emit('file', {
      id, username: this.assignedName, filename: file.filename, mime: file.mime,
      size: file.size, data: file.data, replyTo: reply, ts: Date.now(), self: true,
    });
  }

  // 핀 요청은 호스트로 보내고, 화면 반영은 호스트의 PIN 브로드캐스트를 기다린다 (권위 일원화).
  setPin(action, item) {
    sendJSON(this.socket, { type: 'PIN', action, item });
  }

  stop() {
    if (this.socket) { try { this.socket.destroy(); } catch (_) {} this.socket = null; }
  }
}

// ===========================================================================
// discoverRooms : LAN 안의 공개방 목록을 UDP 브로드캐스트로 수집
// ===========================================================================
function discoverRooms(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const rooms = new Map(); // "ip:port" -> roomInfo
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const finish = () => {
      try { udp.close(); } catch (_) {}
      resolve(Array.from(rooms.values()));
    };

    udp.on('error', () => finish());

    udp.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch (_) { return; }
      if (msg.magic !== DISCOVERY_MAGIC || msg.type !== 'ROOM_INFO') return;
      rooms.set(`${msg.ip}:${msg.port}`, {
        roomName: msg.roomName,
        ip: msg.ip,
        port: msg.port,
        userCount: msg.userCount,
      });
    });

    udp.bind(() => {
      try { udp.setBroadcast(true); } catch (_) {}
      const payload = Buffer.from(JSON.stringify({ magic: DISCOVERY_MAGIC, type: 'DISCOVER' }));
      // 일반 브로드캐스트 주소로 탐색 요청 전송
      udp.send(payload, DISCOVERY_PORT, '255.255.255.255', () => {});
      setTimeout(finish, timeoutMs);
    });
  });
}

module.exports = {
  HostSession,
  ClientSession,
  discoverRooms,
  getLocalIPv4,
  DISCOVERY_PORT,
  TCP_BASE_PORT,
  MAX_FILE_BYTES,
};
