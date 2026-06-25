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

function fileId() {
  return crypto.randomBytes(8).toString('hex');
}

// 들어온 FILE 메시지를 안전한 형태로 정규화한다 (필수 필드/타입/크기 검증).
function normalizeFile(msg, username) {
  const data = String(msg.data || '');
  if (!data || data.length > MAX_FILE_B64) return null;
  return {
    type: 'FILE',
    id: String(msg.id || fileId()),
    username,
    filename: String(msg.filename || 'file').slice(0, 255),
    mime: String(msg.mime || 'application/octet-stream').slice(0, 128),
    size: Number(msg.size) || 0,
    data,
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
  sendChat(text) {
    const msg = { type: 'CHAT', username: this.username, text, ts: Date.now() };
    this.broadcast(msg);
    this.emit('chat', { username: this.username, text: msg.text, ts: msg.ts, self: true });
  }

  // 방장 본인이 보낸 파일 전송
  sendFile(file) {
    const msg = {
      type: 'FILE', id: fileId(), username: this.username,
      filename: file.filename, mime: file.mime, size: file.size,
      data: file.data, ts: Date.now(),
    };
    this.broadcast(msg);
    this.emit('file', { ...msg, self: true });
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
        const out = { type: 'CHAT', username: info.username, text, ts: Date.now() };
        this.broadcast(out, socket);              // 다른 클라이언트들에게
        this.emit('chat', { username: info.username, text, ts: out.ts, self: false }); // 방장 UI
        return;
      }

      if (msg.type === 'FILE') {
        const out = normalizeFile(msg, info.username);
        if (!out) return;
        this.broadcast(out, socket);              // 다른 클라이언트들에게 중계
        this.emit('file', { ...out, self: false }); // 방장 UI
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
          username: msg.username,
          text: msg.text,
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
          ts: msg.ts,
          self: msg.username === this.assignedName,
        });
        break;
    }
  }

  sendChat(text) {
    sendJSON(this.socket, { type: 'CHAT', text });
    // 본인 메시지는 즉시 화면에 반영 (서버는 발신자에게 echo 하지 않음)
    this.emit('chat', { username: this.assignedName, text, ts: Date.now(), self: true });
  }

  sendFile(file) {
    sendJSON(this.socket, {
      type: 'FILE', filename: file.filename, mime: file.mime,
      size: file.size, data: file.data,
    });
    // 본인이 보낸 파일은 즉시 화면에 반영 (서버 echo 없음)
    this.emit('file', {
      username: this.assignedName, filename: file.filename, mime: file.mime,
      size: file.size, data: file.data, ts: Date.now(), self: true,
    });
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
