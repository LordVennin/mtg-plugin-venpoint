/*
 * Transport layer — star topology, two interchangeable backends:
 *
 * 1. WebRTC via PeerJS (default): signaling through the public PeerJS broker
 *    (or a self-hosted one via ?peerhost=...), then direct browser-to-browser
 *    data channels. Zero server load, but needs NAT traversal to succeed.
 *
 * 2. WebSocket relay (?relay=1, used by host-draft.sh / relay-server.mjs):
 *    every client holds one WebSocket to the relay, which forwards JSON
 *    between host and guests. Works under ANY NAT/VPN/CGNAT because it is
 *    ordinary client->server traffic. With ?relay=1 the relay is the server
 *    that served the page; ?relayhost=some.host targets another one.
 *
 * Both backends expose the same host()/join() API, so the app never knows
 * which one it is on.
 */

var Net = (function () {
  'use strict';

  var PREFIX = 'mtgvp-';
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

  function makeCode(len) {
    var s = '';
    for (var i = 0; i < (len || 5); i++) {
      s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return s;
  }

  function normalizeCode(code) {
    return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /**
   * PeerJS connection options. By default the free public PeerJS broker is
   * used for signaling. To use a self-hosted peerjs-server instead, open the
   * app with query params, e.g.:
   *   index.html?peerhost=my.server.com&peerport=9000&peerpath=/myapp
   * Add &peerinsecure=1 for plain ws:// (local testing only).
   */
  function peerOptions() {
    var opts = { debug: 1 };
    try {
      var q = new URLSearchParams(window.location.search);
      var h = q.get('peerhost');
      if (h) {
        opts.host = h;
        opts.port = parseInt(q.get('peerport') || '443', 10);
        opts.path = q.get('peerpath') || '/';
        opts.secure = q.get('peerinsecure') !== '1';
        opts.key = q.get('peerkey') || 'peerjs';
      }
    } catch (e) { /* no URLSearchParams / no location — use defaults */ }
    return opts;
  }

  /* ------------------------- relay backend ------------------------- */

  /** The relay WebSocket URL, or null when the WebRTC backend should be used. */
  function relayUrl() {
    try {
      var q = new URLSearchParams(window.location.search);
      var rh = q.get('relayhost');
      if (rh) return 'wss://' + rh + '/ws';
      if (q.get('relay') === '1') {
        var proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        return proto + window.location.host + '/ws';
      }
    } catch (e) { /* no location — WebRTC default */ }
    return null;
  }

  function relayHost(url, handlers) {
    var conns = Object.create(null); // guest id -> conn handle {id} (survives reconnects)
    var opened = false;
    var code = null;
    var token = null; // proves room ownership to the relay when resuming
    var ws = null;
    var done = false; // deliberately closed, or given up for good
    var retries = 0;

    function connect(resume) {
      ws = new WebSocket(url);
      ws.onopen = function () {
        ws.send(JSON.stringify(resume ? { t: 'host', resume: code, token: token } : { t: 'host' }));
      };
      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        switch (msg.t) {
          case 'hosted':
            retries = 0;
            if (msg.token) token = msg.token;
            if (!opened) {
              opened = true;
              code = msg.code;
              handlers.onOpen(msg.code);
            } else if (handlers.onStatus) {
              handlers.onStatus('Reconnected to the relay — the room is back.');
            }
            break;
          case 'peer-open':
            // On a resume the relay replays every connected guest; the conn
            // objects must stay identical so seats keep matching.
            if (conns[msg.id]) { conns[msg.id].open = true; break; }
            conns[msg.id] = { id: msg.id, open: true };
            handlers.onConnection(conns[msg.id]);
            break;
          case 'from':
            if (conns[msg.id]) handlers.onMessage(conns[msg.id], msg.data);
            break;
          case 'peer-close':
            if (conns[msg.id]) {
              conns[msg.id].open = false;
              handlers.onDisconnect(conns[msg.id]);
              delete conns[msg.id];
            }
            break;
          case 'error':
            done = true;
            handlers.onError(new Error(msg.msg || 'Relay error'));
            try { ws.close(); } catch (e) { /* already closing */ }
            break;
        }
      };
      ws.onerror = function () {
        if (!opened && retries === 0) handlers.onError(new Error('Could not reach the relay server.'));
      };
      ws.onclose = function () {
        if (done) return;
        if (!opened) { handlers.onError(new Error('Could not reach the relay server.')); return; }
        // The host's relay socket dropped (tunnel blip, wifi hiccup): keep
        // the room alive by resuming — the relay holds it for 5 minutes.
        retries++;
        if (retries > 90) {
          done = true;
          handlers.onError(new Error('Lost the relay connection and could not get it back.'));
          return;
        }
        if (retries === 1 && handlers.onStatus) {
          handlers.onStatus('Relay connection lost — reconnecting…');
        }
        setTimeout(function () { connect(true); }, Math.min(5000, 1000 * retries));
      };
    }
    connect(false);
    if (typeof window !== 'undefined') {
      // Test hook: simulate the host's socket dropping mid-game.
      window.__relayHostDropTest = function () { try { ws.close(); } catch (e) {} };
    }

    return {
      code: null,
      send: function (conn, msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'to', id: conn.id, data: msg }));
        }
      },
      close: function () { done = true; try { ws.onclose = null; ws.close(); } catch (e) {} }
    };
  }

  function relayJoin(url, code, handlers) {
    var ws = new WebSocket(url);
    var joined = false;
    var conn = { open: true };

    ws.onopen = function () { ws.send(JSON.stringify({ t: 'join', code: code })); };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      switch (msg.t) {
        case 'joined':
          joined = true;
          handlers.onOpen(conn);
          break;
        case 'rehello':
          // The host resumed after a dropped socket — introduce ourselves
          // again so it re-associates this connection with our seat.
          handlers.onOpen(conn);
          break;
        case 'msg':
          handlers.onMessage(msg.data);
          break;
        case 'error':
          handlers.onError(new Error(msg.msg || 'Relay error'));
          break;
      }
    };
    ws.onerror = function () {
      if (!joined) handlers.onError(new Error('Could not reach the relay server.'));
    };
    ws.onclose = function () {
      if (joined) handlers.onClose();
      else handlers.onError(new Error('Could not reach the relay server.'));
    };

    return {
      send: function (msg) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'msg', data: msg }));
      },
      close: function () { try { ws.onclose = null; ws.close(); } catch (e) {} }
    };
  }

  /* ------------------------- public API ------------------------- */

  /**
   * Host a room. handlers: {onOpen(code), onConnection(conn), onMessage(conn, msg),
   * onDisconnect(conn), onError(err)}
   * Returns {peer, code, broadcast(conns, msg), close()}
   */
  function host(handlers) {
    var relay = relayUrl();
    if (relay) return relayHost(relay, handlers);
    return peerHost(handlers);
  }

  function peerHost(handlers) {
    var code = makeCode(5);
    var peer = new Peer(PREFIX + code, peerOptions());

    peer.on('open', function () { handlers.onOpen(code); });
    peer.on('error', function (err) {
      if (err.type === 'unavailable-id') {
        // Rare collision — the caller can just retry with a new code.
        handlers.onError(new Error('Room code collision, please try again.'));
      } else {
        handlers.onError(err);
      }
    });
    peer.on('connection', function (conn) {
      conn.on('open', function () { handlers.onConnection(conn); });
      conn.on('data', function (data) { handlers.onMessage(conn, data); });
      conn.on('close', function () { handlers.onDisconnect(conn); });
      conn.on('error', function () { handlers.onDisconnect(conn); });
    });

    return {
      peer: peer,
      code: code,
      send: function (conn, msg) { try { conn.send(msg); } catch (e) { /* conn died */ } },
      close: function () { try { peer.destroy(); } catch (e) {} }
    };
  }

  /**
   * Join a room by code. handlers: {onOpen(conn), onMessage(msg), onClose(), onError(err)}
   * Returns {peer, send(msg), close()}
   */
  function join(code, handlers) {
    code = normalizeCode(code);
    var relay = relayUrl();
    if (relay) return relayJoin(relay, code, handlers);
    return peerJoin(code, handlers);
  }

  function peerJoin(code, handlers) {
    var peer = new Peer(peerOptions());
    var conn = null;

    peer.on('open', function () {
      conn = peer.connect(PREFIX + code, { reliable: true });
      conn.on('open', function () { handlers.onOpen(conn); });
      conn.on('data', function (data) { handlers.onMessage(data); });
      conn.on('close', function () { handlers.onClose(); });
      conn.on('error', function (err) { handlers.onError(err); });
    });
    peer.on('error', function (err) {
      if (err.type === 'peer-unavailable') {
        handlers.onError(new Error('Room "' + code + '" not found. Check the code — the host must have the lobby open.'));
      } else {
        handlers.onError(err);
      }
    });

    return {
      peer: peer,
      send: function (msg) { if (conn && conn.open) conn.send(msg); },
      close: function () { try { peer.destroy(); } catch (e) {} }
    };
  }

  return { host: host, join: join, normalizeCode: normalizeCode };
})();
