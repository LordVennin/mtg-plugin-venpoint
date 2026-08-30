/*
 * Thin PeerJS wrapper — star topology.
 *
 * The host's browser owns all state; guests hold a single DataConnection to
 * the host. Signaling goes through PeerJS's free public broker; after the
 * handshake, traffic is direct browser-to-browser WebRTC.
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

  /**
   * Host a room. handlers: {onOpen(code), onConnection(conn), onMessage(conn, msg),
   * onDisconnect(conn), onError(err)}
   * Returns {peer, code, broadcast(conns, msg), close()}
   */
  function host(handlers) {
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
