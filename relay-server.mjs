/*
 * Draft relay server: serves the static app AND relays draft messages over
 * WebSockets, so no player needs WebRTC to work (VPNs, CGNAT, strict NATs
 * are all fine — everything is ordinary HTTP/WS traffic).
 *
 *   npm install
 *   node relay-server.mjs [--port 8000] [--host 127.0.0.1]
 *
 * Open the app with ?relay=1 and it uses this server instead of WebRTC.
 * The relay is a dumb star: it knows rooms and forwards JSON between the
 * host and each guest. It never inspects draft messages — the same role
 * Venpoint's mailbox will play when this becomes a Venpoint plugin.
 *
 * WS protocol (all JSON):
 *   client -> server: {t:'host'}                    claim a new room
 *                     {t:'join', code}              join an existing room
 *                     {t:'to', id, data}            host -> one guest
 *                     {t:'msg', data}               guest -> host
 *   server -> client: {t:'hosted', code}
 *                     {t:'joined'}
 *                     {t:'peer-open', id}           new guest (to host)
 *                     {t:'peer-close', id}          guest left (to host)
 *                     {t:'from', id, data}          guest message (to host)
 *                     {t:'msg', data}               host message (to guest)
 *                     {t:'error', msg}
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = dirname(fileURLToPath(import.meta.url));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const PORT = parseInt(arg('port', process.env.PORT || '8000'), 10);
const HOST = arg('host', '127.0.0.1');

/* ------------------------- static file serving ------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url || '/').split('?')[0]);
    if (path === '/') path = '/index.html';
    const clean = normalize(path).replace(/^(\.\.[/\\])+/, '');
    if (clean.includes('..')) { res.writeHead(400); res.end(); return; }
    const file = join(ROOT, clean);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

/* ------------------------------ relaying ------------------------------ */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rooms = new Map(); // code -> {host: ws, guests: Map<id, ws>}
let guestSeq = 0;

function genCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Per-connection role state
  let role = null;      // 'host' | 'guest'
  let room = null;      // room object
  let code = null;      // room code
  let guestId = null;   // for guests

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'host': {
        if (role) return;
        role = 'host';
        code = genCode();
        room = { host: ws, guests: new Map() };
        rooms.set(code, room);
        send(ws, { t: 'hosted', code });
        console.log(`[relay] room ${code} opened (${rooms.size} active)`);
        break;
      }
      case 'join': {
        if (role) return;
        const c = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const r = rooms.get(c);
        if (!r) { send(ws, { t: 'error', msg: 'Room "' + c + '" not found. Check the code — the host must have the lobby open.' }); return; }
        role = 'guest';
        room = r;
        code = c;
        guestId = 'g' + (++guestSeq);
        r.guests.set(guestId, ws);
        send(ws, { t: 'joined' });
        send(r.host, { t: 'peer-open', id: guestId });
        break;
      }
      case 'to': { // host -> one guest
        if (role !== 'host' || !room) return;
        const guest = room.guests.get(msg.id);
        if (guest) send(guest, { t: 'msg', data: msg.data });
        break;
      }
      case 'msg': { // guest -> host
        if (role !== 'guest' || !room) return;
        send(room.host, { t: 'from', id: guestId, data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (role === 'host' && room) {
      for (const guest of room.guests.values()) {
        send(guest, { t: 'error', msg: 'The host disconnected.' });
        guest.close();
      }
      rooms.delete(code);
      console.log(`[relay] room ${code} closed (${rooms.size} active)`);
    } else if (role === 'guest' && room) {
      room.guests.delete(guestId);
      send(room.host, { t: 'peer-close', id: guestId });
    }
  });
  ws.on('error', () => { /* handled by close */ });
});

// Keepalive: also keeps tunnel/proxy idle timeouts from cutting connections.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`[relay] serving app + relay on http://${HOST}:${PORT} (ws path /ws)`);
});
