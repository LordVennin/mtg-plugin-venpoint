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
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { slimSource, indexCards, lookupCollection, lookupNamed, createStreamExtractor } from './cardmirror.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const PORT = parseInt(arg('port', process.env.PORT || '8000'), 10);
const HOST = arg('host', '127.0.0.1');
const NO_MIRROR = process.argv.includes('--no-mirror');
const MIRROR_FILE = arg('mirror-file', null); // local bulk JSON instead of downloading (tests/airgap)

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
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Preset lists the site owner drops into lists/ as .txt files. Each file
 * starts with "@name ..." / "@format ..." metadata lines (see lists/README).
 * The app fetches this index to offer them as one-click defaults.
 */
async function presetIndex() {
  const out = [];
  let files = [];
  try { files = await readdir(join(ROOT, 'lists')); } catch { return out; }
  for (const f of files.sort()) {
    if (!f.endsWith('.txt')) continue;
    try {
      const head = (await readFile(join(ROOT, 'lists', f), 'utf8')).slice(0, 2000);
      const meta = {};
      for (const line of head.split(/\r?\n/)) {
        const m = line.match(/^@(\w+)\s+(.+)$/);
        if (m) meta[m[1].toLowerCase()] = m[2].trim();
        else if (line.trim()) break;
      }
      out.push({
        file: 'lists/' + f,
        name: meta.name || f.replace(/\.txt$/, ''),
        format: (meta.format || 'deck').toLowerCase()
      });
    } catch { /* unreadable file — skip it */ }
  }
  return out;
}

/* --------------------------- local card mirror --------------------------- */
/*
 * A slimmed copy of Scryfall's "Oracle Cards" bulk data (~20MB on disk in
 * data/card-mirror.json, refreshed weekly). The app resolves card lists
 * against Scryfall first and falls back to these endpoints, so game night
 * survives a Scryfall outage. Disable with --no-mirror; feed a local bulk
 * file with --mirror-file <path> (used by the tests).
 */
const MIRROR_DIR = join(ROOT, 'data');
const MIRROR_PATH = join(MIRROR_DIR, 'card-mirror.json');
const MIRROR_META = join(MIRROR_DIR, 'card-mirror-meta.json');
const MIRROR_MAX_AGE = 7 * 24 * 3600 * 1000;
const SCRYFALL_HEADERS = { 'User-Agent': 'mtg-draft-companion/1.0', 'Accept': 'application/json' };

let mirror = null; // {byName, byFace} once an index is loaded

async function loadMirrorFromDisk() {
  try {
    const cards = JSON.parse(await readFile(MIRROR_PATH, 'utf8'));
    mirror = indexCards(cards);
    console.log(`[mirror] loaded ${cards.length} cards from ${MIRROR_PATH}`);
    return true;
  } catch { return false; }
}

/** Stream any readable of JSON text into a slimmed card array. */
async function slimStream(stream) {
  const cards = [];
  const extractor = createStreamExtractor(card => {
    if (card && card.object === 'card' && card.name) cards.push(slimSource(card));
  });
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    extractor.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
  }
  extractor.end();
  return cards;
}

async function refreshMirror() {
  try {
    let cards;
    if (MIRROR_FILE) {
      cards = await slimStream((await import('node:fs')).createReadStream(MIRROR_FILE, 'utf8'));
    } else {
      // Skip the download while the last one is still fresh.
      try {
        const meta = JSON.parse(await readFile(MIRROR_META, 'utf8'));
        if (Date.now() - meta.fetchedAt < MIRROR_MAX_AGE && mirror) return;
      } catch { /* no meta yet */ }
      const list = await fetch('https://api.scryfall.com/bulk-data', { headers: SCRYFALL_HEADERS });
      if (!list.ok) throw new Error('bulk-data HTTP ' + list.status);
      const entry = (await list.json()).data.find(d => d.type === 'oracle_cards');
      if (!entry) throw new Error('no oracle_cards bulk entry');
      console.log(`[mirror] downloading ${entry.download_uri} (~${Math.round(entry.size / 1e6)}MB)…`);
      const dl = await fetch(entry.download_uri, { headers: SCRYFALL_HEADERS });
      if (!dl.ok || !dl.body) throw new Error('bulk download HTTP ' + dl.status);
      cards = await slimStream(dl.body);
    }
    await mkdir(MIRROR_DIR, { recursive: true });
    await writeFile(MIRROR_PATH, JSON.stringify(cards));
    await writeFile(MIRROR_META, JSON.stringify({ fetchedAt: Date.now(), cards: cards.length }));
    mirror = indexCards(cards);
    console.log(`[mirror] refreshed: ${cards.length} cards`);
  } catch (err) {
    // Non-fatal: the app still talks to Scryfall directly.
    console.log('[mirror] refresh failed (will retry): ' + err.message);
  }
}

if (!NO_MIRROR) {
  loadMirrorFromDisk().then(() => refreshMirror());
  setInterval(refreshMirror, 24 * 3600 * 1000);
}

/* ----------------------------- deck storage ----------------------------- */
/*
 * Saved decks live on the RELAY's disk (data/decks/<owner>.json), keyed by
 * player name — quick-tunnel URLs change every session, so browser storage
 * is origin-locked and useless for persistence; the relay is the one stable
 * place the group shares. Honor-system identity, same as seats.
 */
const DECKS_DIR = join(ROOT, 'data', 'decks');
const slugOwner = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

async function readOwnerDecks(owner) {
  try { return JSON.parse(await readFile(join(DECKS_DIR, owner + '.json'), 'utf8')); }
  catch { return {}; }
}

async function writeOwnerDecks(owner, decks) {
  await mkdir(DECKS_DIR, { recursive: true });
  await writeFile(join(DECKS_DIR, owner + '.json'), JSON.stringify(decks, null, 1));
}

async function handleDecks(req, res, path) {
  const params = new URLSearchParams((req.url || '').split('?')[1] || '');
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (path === '/api/decks' && req.method === 'GET') {
    const owner = slugOwner(params.get('owner'));
    if (!owner) return json(400, { error: 'owner required' });
    const decks = await readOwnerDecks(owner);
    return json(200, {
      decks: Object.keys(decks).sort().map(n => ({ name: n, updated: decks[n].updated }))
    });
  }
  if (path === '/api/decks/get' && req.method === 'GET') {
    const owner = slugOwner(params.get('owner'));
    const decks = await readOwnerDecks(owner);
    const d = decks[String(params.get('name') || '')];
    return d ? json(200, { text: d.text }) : json(404, { error: 'not found' });
  }
  if (path === '/api/decks/save' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 256 * 1024)); } catch { return json(400, { error: 'bad body' }); }
    const owner = slugOwner(body.owner);
    const name = String(body.name || '').trim().slice(0, 60);
    const text = String(body.text || '').slice(0, 100 * 1024);
    if (!owner || !name || !text) return json(400, { error: 'owner, name, text required' });
    const decks = await readOwnerDecks(owner);
    if (!decks[name] && Object.keys(decks).length >= 100) return json(400, { error: 'deck limit reached' });
    decks[name] = { text, updated: Date.now() };
    await writeOwnerDecks(owner, decks);
    return json(200, { ok: true });
  }
  if (path === '/api/decks/delete' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 4096)); } catch { return json(400, { error: 'bad body' }); }
    const owner = slugOwner(body.owner);
    const decks = await readOwnerDecks(owner);
    delete decks[String(body.name || '')];
    await writeOwnerDecks(owner, decks);
    return json(200, { ok: true });
  }
  json(404, { error: 'unknown decks endpoint' });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url || '/').split('?')[0]);
    if (path === '/') path = '/index.html';
    if (path === '/api/lists') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await presetIndex()));
      return;
    }
    if (path.startsWith('/api/decks')) {
      await handleDecks(req, res, path);
      return;
    }
    if (path === '/api/cards/collection' && req.method === 'POST') {
      if (!mirror) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"mirror not ready"}'); return; }
      let body;
      try { body = JSON.parse(await readBody(req, 256 * 1024)); } catch { body = {}; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lookupCollection(mirror, Array.isArray(body.identifiers) ? body.identifiers : [])));
      return;
    }
    if (path === '/api/cards/named') {
      if (!mirror) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"mirror not ready"}'); return; }
      const params = new URLSearchParams((req.url || '').split('?')[1] || '');
      const card = lookupNamed(mirror, params.get('exact') || params.get('fuzzy') || '');
      if (card) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(card)); }
      else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"object":"error"}'); }
      return;
    }
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
// code -> {host: ws|null, token, guests: Map<id, ws>, graceTimer}
// host===null means the host's socket dropped and the room is waiting for
// it to resume (the token proves it's the same host coming back).
const rooms = new Map();
const HOST_GRACE_MS = 5 * 60 * 1000;
let guestSeq = 0;

function genCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

function genToken() {
  let t = '';
  for (let i = 0; i < 32; i++) t += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return t;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
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
        // Resume: the host's old socket died (tunnel blip, wifi hiccup) and
        // it is coming back for its room; the token proves it's the same host.
        if (msg.resume) {
          const rcode = String(msg.resume).toUpperCase();
          const r = rooms.get(rcode);
          if (!r || !msg.token || r.token !== msg.token) {
            send(ws, { t: 'error', msg: 'Room "' + rcode + '" is gone — start a new room.' });
            break;
          }
          role = 'host';
          code = rcode;
          room = r;
          if (r.host && r.host !== ws) { try { r.host.terminate(); } catch { /* already dead */ } }
          r.host = ws;
          if (r.graceTimer) { clearTimeout(r.graceTimer); r.graceTimer = null; }
          send(ws, { t: 'hosted', code: rcode, token: r.token, resumed: true });
          for (const [gid, gws] of r.guests) {
            send(ws, { t: 'peer-open', id: gid });
            send(gws, { t: 'rehello' }); // ask each guest to re-introduce itself
          }
          console.log(`[relay] room ${rcode} resumed by its host (${r.guests.size} guests waiting)`);
          break;
        }
        role = 'host';
        code = genCode();
        room = { host: ws, token: genToken(), guests: new Map(), graceTimer: null };
        rooms.set(code, room);
        send(ws, { t: 'hosted', code, token: room.token });
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
      case 'msg': { // guest -> host (dropped while the host is resuming)
        if (role !== 'guest' || !room) return;
        send(room.host, { t: 'from', id: guestId, data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (role === 'host' && room) {
      if (room.host !== ws) return; // an already-replaced socket dying late
      // Don't kill the room: give the host a grace window to resume — a
      // dropped host socket (tunnel re-handshake, wifi blip) used to
      // destroy the room and end everyone's game permanently.
      room.host = null;
      if (room.guests.size === 0) {
        rooms.delete(code);
        console.log(`[relay] room ${code} closed — empty (${rooms.size} active)`);
        return;
      }
      console.log(`[relay] room ${code} host dropped — holding for resume (${room.guests.size} guests)`);
      room.graceTimer = setTimeout(() => {
        for (const guest of room.guests.values()) {
          send(guest, { t: 'error', msg: 'The host disconnected.' });
          guest.close();
        }
        rooms.delete(code);
        console.log(`[relay] room ${code} closed — host never resumed (${rooms.size} active)`);
      }, HOST_GRACE_MS);
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
