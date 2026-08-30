/*
 * App: screens, host/guest protocol, and glue between Net, the draft
 * engines, the parser, and Scryfall.
 *
 * Protocol (all messages are plain JSON objects with a `t` field):
 *   guest -> host : {t:'hello', name}
 *                   {t:'pick', uid}          (cube: pick card by uid)
 *                   {t:'pickJs', index}      (jumpstart: pick offered pack)
 *   host  -> guest: {t:'welcome', id}
 *                   {t:'lobby', lobby}       (players + settings summary)
 *                   {t:'view', view, deck?}  (per-player draft view)
 *                   {t:'err', msg}
 *                   {t:'ended'}
 */

(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var LS_SETUP = 'mtgdraft.setup.v1';
  var LS_NAME = 'mtgdraft.name.v1';

  var App = {
    role: null,          // 'host' | 'guest'
    myName: '',
    // host
    net: null,
    players: [],         // [{id, name, conn|null, connected}]  (host is players[0], conn=null)
    engine: null,
    setup: { mode: 'cube', cubeCards: null, jsPacks: null,
             packSize: 15, packsPerPlayer: 3, jsChoices: 3, jsPacksPerPlayer: 2 },
    // guest
    conn: null,
    myId: null,
    lastView: null,
    lastDeck: null,
    selectedUid: null
  };

  /* ---------------- screen switching ---------------- */

  function show(screen) {
    ['home', 'lobby', 'draft', 'done'].forEach(function (s) {
      $('#screen-' + s).hidden = (s !== screen);
    });
  }

  function toast(msg, isError) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = isError ? 'toast error show' : 'toast show';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.className = 'toast'; }, 4000);
  }

  /* ---------------- home screen ---------------- */

  function initHome() {
    var saved = localStorage.getItem(LS_NAME);
    if (saved) $('#name-input').value = saved;

    $('#btn-host').addEventListener('click', function () {
      var name = $('#name-input').value.trim();
      if (!name) return toast('Enter your name first.', true);
      localStorage.setItem(LS_NAME, name);
      startHosting(name);
    });

    $('#btn-join').addEventListener('click', function () {
      var name = $('#name-input').value.trim();
      var code = $('#code-input').value;
      if (!name) return toast('Enter your name first.', true);
      if (!Net.normalizeCode(code)) return toast('Enter a room code.', true);
      localStorage.setItem(LS_NAME, name);
      startJoining(name, code);
    });
  }

  /* ---------------- hosting ---------------- */

  function startHosting(name) {
    App.role = 'host';
    App.myName = name;
    App.myId = 'p0';
    App.players = [{ id: 'p0', name: name, conn: null, connected: true }];

    $('#btn-host').disabled = true;
    App.net = Net.host({
      onOpen: function (code) {
        $('#btn-host').disabled = false;
        $('#room-code').textContent = code;
        show('lobby');
        $('#host-panel').hidden = false;
        $('#guest-panel').hidden = true;
        loadSavedSetup();
        renderLobby();
      },
      onConnection: function (conn) { /* wait for hello */ },
      onMessage: function (conn, msg) { hostHandleMessage(conn, msg); },
      onDisconnect: function (conn) {
        var p = App.players.find(function (pl) { return pl.conn === conn; });
        if (p) {
          p.connected = false;
          p.conn = null;
          if (!App.engine) {
            // Lobby: drop them entirely so seats stay clean.
            App.players = App.players.filter(function (pl) { return pl !== p; });
          }
          broadcastLobby();
          renderLobby();
          renderTableStatus();
          toast(p.name + ' disconnected.');
        }
      },
      onError: function (err) {
        $('#btn-host').disabled = false;
        toast(err.message || 'Connection error', true);
      }
    });
  }

  function hostHandleMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': {
        var name = String(msg.name || 'Player').slice(0, 24);
        if (App.engine) {
          // Draft in progress: only allow reclaiming a disconnected seat by name.
          var ghost = App.players.find(function (p) {
            return !p.connected && p.name.toLowerCase() === name.toLowerCase();
          });
          if (!ghost) {
            App.net.send(conn, { t: 'err', msg: 'Draft already in progress.' });
            return;
          }
          ghost.conn = conn;
          ghost.connected = true;
          App.net.send(conn, { t: 'welcome', id: ghost.id });
          broadcastLobby();
          sendViewTo(ghost);
          toast(ghost.name + ' reconnected.');
          renderTableStatus();
          return;
        }
        // Avoid duplicate display names in the lobby.
        var finalName = name;
        var n = 2;
        while (App.players.some(function (p) { return p.name.toLowerCase() === finalName.toLowerCase(); })) {
          finalName = name + ' ' + (n++);
        }
        var id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
        App.players.push({ id: id, name: finalName, conn: conn, connected: true });
        App.net.send(conn, { t: 'welcome', id: id });
        broadcastLobby();
        renderLobby();
        toast(finalName + ' joined.');
        break;
      }
      case 'pick':
      case 'pickJs': {
        var player = App.players.find(function (p) { return p.conn === conn; });
        if (player) hostApplyPick(player, msg);
        break;
      }
    }
  }

  function lobbySnapshot() {
    return {
      players: App.players.map(function (p) { return { id: p.id, name: p.name, connected: p.connected }; }),
      mode: App.setup.mode,
      poolInfo: poolInfoText(),
      started: !!App.engine
    };
  }

  function broadcastLobby() {
    var snap = lobbySnapshot();
    App.players.forEach(function (p) {
      if (p.conn) App.net.send(p.conn, { t: 'lobby', lobby: snap });
    });
  }

  function poolInfoText() {
    var s = App.setup;
    if (s.mode === 'cube') {
      return s.cubeCards
        ? 'Cube: ' + s.cubeCards.length + ' cards · ' + s.packsPerPlayer + ' packs of ' + s.packSize
        : 'Cube: not loaded yet';
    }
    return s.jsPacks
      ? 'Jumpstart: ' + s.jsPacks.length + ' packs · everyone picks ' + s.jsPacksPerPlayer
      : 'Jumpstart: no packs loaded yet';
  }

  /* ---------------- host setup panel ---------------- */

  function loadSavedSetup() {
    try {
      var raw = localStorage.getItem(LS_SETUP);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s.mode) $('#mode-' + s.mode).checked = true;
      if (s.cubeText) $('#cube-text').value = s.cubeText;
      if (s.jsText) $('#js-text').value = s.jsText;
      if (s.packSize) $('#opt-packsize').value = s.packSize;
      if (s.packsPerPlayer) $('#opt-packs').value = s.packsPerPlayer;
      if (s.jsChoices) $('#opt-choices').value = s.jsChoices;
      onModeChange();
    } catch (e) { /* corrupted save — ignore */ }
  }

  function saveSetup() {
    try {
      localStorage.setItem(LS_SETUP, JSON.stringify({
        mode: App.setup.mode,
        cubeText: $('#cube-text').value,
        jsText: $('#js-text').value,
        packSize: $('#opt-packsize').value,
        packsPerPlayer: $('#opt-packs').value,
        jsChoices: $('#opt-choices').value
      }));
    } catch (e) { /* storage full — non-fatal */ }
  }

  function onModeChange() {
    var mode = $('#mode-cube').checked ? 'cube' : 'jumpstart';
    App.setup.mode = mode;
    $('#cube-setup').hidden = (mode !== 'cube');
    $('#js-setup').hidden = (mode !== 'jumpstart');
    broadcastLobby();
    renderLobby();
  }

  function initHostPanel() {
    $('#mode-cube').addEventListener('change', onModeChange);
    $('#mode-jumpstart').addEventListener('change', onModeChange);

    $('#btn-load-pool').addEventListener('click', function () {
      saveSetup();
      var btn = $('#btn-load-pool');
      btn.disabled = true;
      btn.textContent = 'Loading cards…';
      var done = function () { btn.disabled = false; btn.textContent = 'Load & validate'; };

      App.setup.packSize = clampInt($('#opt-packsize').value, 5, 30, 15);
      App.setup.packsPerPlayer = clampInt($('#opt-packs').value, 1, 6, 3);
      App.setup.jsChoices = clampInt($('#opt-choices').value, 1, 6, 3);

      if (App.setup.mode === 'cube') {
        var parsed = MTGParser.parseDeckList($('#cube-text').value);
        var names = MTGParser.expandEntries(parsed.entries);
        if (!names.length) { done(); return toast('Cube list is empty or unparseable.', true); }
        Scryfall.resolve(names, function (d, t) { btn.textContent = 'Loading cards… ' + d + '/' + t; })
          .then(function (res) {
            App.setup.cubeCards = Scryfall.toCardObjects(names, res.cards);
            App.setup.jsPacks = null;
            done();
            reportPool(parsed.errors, res.notFound);
          })
          .catch(function (err) {
            // Scryfall unreachable — draft with text-only cards rather than block.
            App.setup.cubeCards = Scryfall.toCardObjects(names, {});
            done();
            toast('Scryfall unreachable (' + err.message + ') — drafting without card images.', true);
            reportPool(parsed.errors, []);
          });
      } else {
        var jp = MTGParser.parseJumpstartPacks($('#js-text').value);
        if (!jp.packs.length) { done(); return toast('No packs found. Use "# Pack Name" headers.', true); }
        var allNames = [];
        jp.packs.forEach(function (p) { allNames = allNames.concat(p.cards); });
        Scryfall.resolve(allNames, function (d, t) { btn.textContent = 'Loading cards… ' + d + '/' + t; })
          .then(function (res) {
            App.setup.jsPacks = jp.packs.map(function (p) {
              return { name: p.name, cards: Scryfall.toCardObjects(p.cards, res.cards) };
            });
            App.setup.cubeCards = null;
            done();
            reportPool(jp.errors, res.notFound);
          })
          .catch(function (err) {
            App.setup.jsPacks = jp.packs.map(function (p) {
              return { name: p.name, cards: Scryfall.toCardObjects(p.cards, {}) };
            });
            done();
            toast('Scryfall unreachable (' + err.message + ') — drafting without card images.', true);
            reportPool(jp.errors, []);
          });
      }
    });

    $('#btn-start').addEventListener('click', hostStartDraft);
  }

  function reportPool(parseErrors, notFound) {
    var problems = [];
    if (parseErrors.length) problems.push(parseErrors.length + ' unparseable line(s): ' + parseErrors.slice(0, 3).join('; '));
    if (notFound.length) problems.push('Not found on Scryfall (kept as text-only): ' + notFound.slice(0, 8).join(', '));
    $('#pool-report').textContent = poolInfoText() + (problems.length ? ' — ' + problems.join(' — ') : ' ✓');
    $('#pool-report').className = problems.length ? 'pool-report warn' : 'pool-report ok';
    broadcastLobby();
    renderLobby();
  }

  function clampInt(v, min, max, dflt) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  }

  /* ---------------- starting & running the draft (host) ---------------- */

  function hostStartDraft() {
    var s = App.setup;
    var ids = App.players.map(function (p) { return p.id; });
    try {
      if (s.mode === 'cube') {
        if (!s.cubeCards) return toast('Load & validate the cube first.', true);
        App.engine = new MTGDraft.CubeDraft(ids, s.cubeCards,
          { packSize: s.packSize, packsPerPlayer: s.packsPerPlayer });
      } else {
        if (!s.jsPacks) return toast('Load & validate the packs first.', true);
        App.engine = new MTGDraft.JumpstartDraft(ids, s.jsPacks,
          { choices: s.jsChoices, packsPerPlayer: s.jsPacksPerPlayer });
      }
    } catch (err) {
      return toast(err.message, true);
    }
    broadcastLobby();
    broadcastViews();
  }

  function hostApplyPick(player, msg) {
    if (!App.engine) return;
    try {
      if (msg.t === 'pick') App.engine.pick(player.id, msg.uid);
      else App.engine.pick(player.id, msg.index | 0);
    } catch (err) {
      if (player.conn) App.net.send(player.conn, { t: 'err', msg: err.message });
      else toast(err.message, true);
      return;
    }
    broadcastViews();
  }

  function sendViewTo(player) {
    var view = App.engine.viewFor(player.id);
    var payload = { t: 'view', view: view };
    if (view.finished) payload.deck = MTGDraft.deckFor(App.engine, player.id);
    if (player.conn) App.net.send(player.conn, payload);
    else applyView(payload); // the host player
  }

  function broadcastViews() {
    App.players.forEach(sendViewTo);
  }

  /* ---------------- joining (guest) ---------------- */

  function startJoining(name, code) {
    App.role = 'guest';
    App.myName = name;
    $('#btn-join').disabled = true;

    App.conn = Net.join(code, {
      onOpen: function () {
        App.conn.send({ t: 'hello', name: name });
      },
      onMessage: function (msg) { guestHandleMessage(msg); },
      onClose: function () {
        toast('Lost connection to the host.', true);
        $('#btn-join').disabled = false;
        show('home');
      },
      onError: function (err) {
        $('#btn-join').disabled = false;
        toast(err.message || 'Connection failed', true);
      }
    });
  }

  function guestHandleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'welcome':
        App.myId = msg.id;
        $('#btn-join').disabled = false;
        $('#room-code').textContent = Net.normalizeCode($('#code-input').value);
        $('#host-panel').hidden = true;
        $('#guest-panel').hidden = false;
        show('lobby');
        break;
      case 'lobby':
        App.lobby = msg.lobby;
        renderLobby();
        break;
      case 'view':
        applyView(msg);
        break;
      case 'err':
        toast(msg.msg, true);
        break;
      case 'ended':
        toast('The host ended the draft.', true);
        show('home');
        break;
    }
  }

  /* ---------------- lobby rendering ---------------- */

  function renderLobby() {
    var players, info;
    if (App.role === 'host') {
      players = App.players.map(function (p) { return { name: p.name, connected: p.connected, isHost: p.id === 'p0' }; });
      info = poolInfoText();
      var ready = (App.setup.mode === 'cube' && App.setup.cubeCards) ||
                  (App.setup.mode === 'jumpstart' && App.setup.jsPacks);
      $('#btn-start').disabled = !ready;
    } else {
      if (!App.lobby) return;
      players = App.lobby.players.map(function (p) { return { name: p.name, connected: p.connected, isHost: p.id === 'p0' }; });
      info = App.lobby.poolInfo;
    }
    $('#lobby-players').innerHTML = players.map(function (p) {
      return '<li class="' + (p.connected ? '' : 'gone') + '">' +
        escapeHtml(p.name) + (p.isHost ? ' <span class="tag">host</span>' : '') +
        (p.connected ? '' : ' (disconnected)') + '</li>';
    }).join('');
    $('#lobby-info').textContent = info || '';
  }

  /* ---------------- draft rendering (both roles) ---------------- */

  function applyView(payload) {
    App.lastView = payload.view;
    if (payload.view.finished) {
      App.lastDeck = payload.deck ||
        (App.role === 'host' ? MTGDraft.deckFor(App.engine, 'p0') : App.lastDeck);
      renderDone();
      show('done');
      return;
    }
    show('draft');
    if (payload.view.mode === 'cube') renderCubeView(payload.view);
    else renderJumpstartView(payload.view);
    renderPicks(payload.view);
    renderTableStatus();
  }

  function playerName(id) {
    if (App.role === 'host') {
      var p = App.players.find(function (pl) { return pl.id === id; });
      return p ? p.name : id;
    }
    if (App.lobby) {
      var q = App.lobby.players.find(function (pl) { return pl.id === id; });
      if (q) return q.name;
    }
    return id === App.myId ? App.myName : 'Player';
  }

  function renderCubeView(v) {
    $('#draft-status').textContent =
      'Pack ' + (v.round + 1) + ' of ' + v.packsPerPlayer +
      ' · Pick ' + v.pickNumber +
      (v.queued ? ' · ' + v.queued + ' pack(s) waiting' : '');
    var area = $('#draft-area');
    if (!v.pack) {
      area.innerHTML = '<p class="waiting">Waiting for the next pack to be passed to you…</p>';
      return;
    }
    App.selectedUid = null;
    area.innerHTML =
      '<div class="card-grid">' +
      v.pack.map(function (c) {
        return '<div class="card" data-uid="' + c.uid + '" title="' + escapeHtml(c.name) + '">' +
          cardFace(c) + '</div>';
      }).join('') +
      '</div>' +
      '<div class="pick-bar"><button id="btn-confirm-pick" disabled>Pick a card</button></div>';

    area.querySelectorAll('.card').forEach(function (el) {
      el.addEventListener('click', function () {
        area.querySelectorAll('.card.selected').forEach(function (s) { s.classList.remove('selected'); });
        el.classList.add('selected');
        App.selectedUid = el.getAttribute('data-uid');
        var btn = $('#btn-confirm-pick');
        btn.disabled = false;
        btn.textContent = 'Pick ' + el.getAttribute('title');
      });
      el.addEventListener('dblclick', function () {
        sendPick(el.getAttribute('data-uid'));
      });
    });
    $('#btn-confirm-pick').addEventListener('click', function () {
      if (App.selectedUid) sendPick(App.selectedUid);
    });
  }

  function sendPick(uid) {
    $('#btn-confirm-pick') && ($('#btn-confirm-pick').disabled = true);
    if (App.role === 'host') hostApplyPick(App.players[0], { t: 'pick', uid: uid });
    else App.conn.send({ t: 'pick', uid: uid });
  }

  function renderJumpstartView(v) {
    var area = $('#draft-area');
    var mine = v.picks.length;
    $('#draft-status').textContent =
      'Jumpstart · you have picked ' + mine + ' of ' + v.packsPerPlayer + ' packs';
    if (v.myTurn && v.offer) {
      area.innerHTML =
        '<p class="prompt">Your turn — choose a pack:</p>' +
        '<div class="js-offer">' +
        v.offer.map(function (name, i) {
          return '<button class="js-pack" data-i="' + i + '">' + escapeHtml(name) + '</button>';
        }).join('') +
        '</div>';
      area.querySelectorAll('.js-pack').forEach(function (btn) {
        btn.addEventListener('click', function () {
          area.querySelectorAll('.js-pack').forEach(function (b) { b.disabled = true; });
          var index = parseInt(btn.getAttribute('data-i'), 10);
          if (App.role === 'host') hostApplyPick(App.players[0], { t: 'pickJs', index: index });
          else App.conn.send({ t: 'pickJs', index: index });
        });
      });
    } else {
      area.innerHTML = '<p class="waiting">' +
        escapeHtml(playerName(v.currentPlayer)) + ' is choosing a pack…</p>';
    }
  }

  function renderPicks(v) {
    var side = $('#picks-list');
    if (v.mode === 'cube') {
      $('#picks-title').textContent = 'Your picks (' + v.picks.length + ')';
      side.innerHTML = v.picks.slice().reverse().map(function (c) {
        return '<li title="' + escapeHtml(c.type || '') + '">' + escapeHtml(c.name) +
          (c.cost ? ' <span class="cost">' + escapeHtml(c.cost) + '</span>' : '') + '</li>';
      }).join('');
    } else {
      $('#picks-title').textContent = 'Your packs (' + v.picks.length + ')';
      side.innerHTML = v.picks.map(function (p) {
        return '<li class="js-picked"><strong>' + escapeHtml(p.name) + '</strong><ul>' +
          p.cards.map(function (c) { return '<li>' + escapeHtml(c.name) + '</li>'; }).join('') +
          '</ul></li>';
      }).join('');
    }
  }

  function renderTableStatus() {
    var v = App.lastView;
    var el = $('#table-status');
    if (!v || !v.table) { el.innerHTML = ''; return; }
    el.innerHTML = v.table.map(function (row) {
      var label;
      if (v.mode === 'cube') label = row.picks + ' picks' + (row.waitingPacks ? ' · thinking' : ' · waiting');
      else label = row.packs.length + ' pack(s)';
      var me = row.id === App.myId ? ' me' : '';
      return '<span class="seat' + me + '">' + escapeHtml(playerName(row.id)) + ': ' + label + '</span>';
    }).join('');
  }

  /* ---------------- finished screen ---------------- */

  function renderDone() {
    var deck = App.lastDeck || [];
    var names = deck.map(function (c) { return c.name; });
    var text = MTGParser.formatDeckList(names);
    $('#deck-count').textContent = deck.length + ' cards';
    $('#deck-text').value = text;
    $('#deck-grid').innerHTML = deck.map(function (c) {
      return '<div class="card small" title="' + escapeHtml(c.name) + '">' + cardFace(c) + '</div>';
    }).join('');
  }

  function initDone() {
    $('#btn-copy-deck').addEventListener('click', function () {
      var ta = $('#deck-text');
      ta.select();
      var copied = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ta.value).then(function () { toast('Deck copied — paste it into Moxfield.'); });
        copied = true;
      }
      if (!copied) {
        document.execCommand('copy');
        toast('Deck copied — paste it into Moxfield.');
      }
    });
    $('#btn-back-home').addEventListener('click', function () {
      window.location.reload();
    });
  }

  /* ---------------- helpers ---------------- */

  function cardFace(c) {
    if (c.img) {
      return '<img loading="lazy" src="' + escapeHtml(c.img) + '" alt="' + escapeHtml(c.name) + '">';
    }
    return '<div class="card-text"><span class="card-name">' + escapeHtml(c.name) + '</span>' +
      (c.cost ? '<span class="card-cost">' + escapeHtml(c.cost) + '</span>' : '') +
      (c.type ? '<span class="card-type">' + escapeHtml(c.type) + '</span>' : '') + '</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- boot ---------------- */

  document.addEventListener('DOMContentLoaded', function () {
    initHome();
    initHostPanel();
    initDone();
    $('#btn-copy-code').addEventListener('click', function () {
      var code = $('#room-code').textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () { toast('Room code copied.'); });
      }
    });
    show('home');
  });
})();
