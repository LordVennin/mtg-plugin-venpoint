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
    game: null,          // MTGGame.Game once a post-draft game starts (host only)
    decks: {},           // host only: playerId -> submitted deck (built or uploaded)
    builder: null,       // this client's deck-building state
    buildVariant: 'standard', // cube variant the builder is building for
    vanguardDeals: {},   // host only: playerId -> vanguard cards dealt pre-draft
    presets: null,       // site-owner preset lists (lists/ directory), once loaded
    postGame: 'lobby',   // which screen a finished match returns to: lobby|build|done
    setup: { mode: 'cube', cubeVariant: 'standard', cubeCards: null, jsPacks: null,
             vanguardCards: null, vgDeal: 1,
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
    ['home', 'lobby', 'draft', 'done', 'build', 'game'].forEach(function (s) {
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
          if (!App.engine && !App.game) {
            // Lobby: keep the empty seat for a grace period so flaky
            // connections can reclaim it by name; drop it if they stay gone.
            var pid = p.id;
            setTimeout(function () {
              var still = App.players.find(function (pl) { return pl.id === pid; });
              if (still && !still.connected && !App.engine && !App.game) {
                App.players = App.players.filter(function (pl) { return pl.id !== pid; });
                delete App.decks[pid];
                broadcastLobby();
                renderLobby();
              }
            }, 90000);
          }
          broadcastLobby();
          renderLobby();
          renderTableStatus();
          toast(p.name + ' disconnected — their seat is saved.');
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
        // Anyone with a disconnected seat of the same name reclaims it —
        // in the lobby, mid-draft, or mid-game.
        var ghost = App.players.find(function (p) {
          return !p.connected && p.name.toLowerCase() === name.toLowerCase();
        });
        if (ghost) {
          ghost.conn = conn;
          ghost.connected = true;
          App.net.send(conn, { t: 'welcome', id: ghost.id });
          broadcastLobby();
          if (App.game) sendGameViewTo(ghost);
          else if (App.engine) sendViewTo(ghost);
          else renderLobby();
          toast(ghost.name + ' reconnected.');
          renderTableStatus();
          return;
        }
        if (App.engine || App.game) {
          App.net.send(conn, { t: 'err', msg: 'A game is already in progress.' });
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
      case 'act': {
        var actor = App.players.find(function (p) { return p.conn === conn; });
        if (actor) hostApplyAction(actor, msg.action);
        break;
      }
      case 'deck': {
        var builderP = App.players.find(function (p) { return p.conn === conn; });
        if (builderP && Array.isArray(msg.cards) && !App.game) {
          App.decks[builderP.id] = msg.cards.slice(0, 500);
          if (isDeckMode(App.setup.mode)) {
            broadcastLobby();
            renderLobby();
          } else {
            hostBroadcastReady();
            hostMaybeStartCubeGame();
          }
        }
        break;
      }
      case 'undeck': {
        var unreadyP = App.players.find(function (p) { return p.conn === conn; });
        if (unreadyP && !App.game) {
          delete App.decks[unreadyP.id];
          if (isDeckMode(App.setup.mode)) { broadcastLobby(); renderLobby(); }
          else hostBroadcastReady();
        }
        break;
      }
    }
  }

  function lobbySnapshot() {
    return {
      players: App.players.map(function (p) { return { id: p.id, name: p.name, connected: p.connected }; }),
      mode: App.setup.mode,
      poolInfo: poolInfoText(),
      deckReady: Object.keys(App.decks),
      started: !!App.engine || !!App.game
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
      var vLabel = s.cubeVariant === 'commander' ? 'Commander cube'
        : s.cubeVariant === 'vanguard' ? 'Vanguard cube'
        : 'Cube';
      if (!s.cubeCards) return vLabel + ': not loaded yet';
      var extra = s.cubeVariant === 'vanguard'
        ? (s.vanguardCards
            ? ' · vanguard pool ' + s.vanguardCards.length + ' (deal ' + s.vgDeal + ')'
            : ' · vanguard pool NOT loaded')
        : '';
      return vLabel + ': ' + s.cubeCards.length + ' cards · ' + s.packsPerPlayer +
        ' packs of ' + s.packSize + extra;
    }
    if (s.mode === 'jumpstart') {
      return s.jsPacks
        ? 'Jumpstart: ' + s.jsPacks.length + ' packs · everyone picks ' + s.jsPacksPerPlayer
        : 'Jumpstart: no packs loaded yet';
    }
    var label = s.mode === 'commander' ? 'Commander' : 'Constructed';
    return label + ': ' + Object.keys(App.decks).length + '/' + App.players.length + ' decks submitted';
  }

  /* ---------------- host setup panel ---------------- */

  function loadSavedSetup() {
    try {
      var raw = localStorage.getItem(LS_SETUP);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s.mode) $('#mode-' + s.mode).checked = true;
      if (s.cubeVariant) $('#cv-' + s.cubeVariant).checked = true;
      if (s.cubeText) $('#cube-text').value = s.cubeText;
      if (s.jsText) $('#js-text').value = s.jsText;
      if (s.vgText) $('#vg-text').value = s.vgText;
      if (s.vgDeal) $('#opt-vgdeal').value = s.vgDeal;
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
        cubeVariant: App.setup.cubeVariant,
        cubeText: $('#cube-text').value,
        jsText: $('#js-text').value,
        vgText: $('#vg-text').value,
        vgDeal: $('#opt-vgdeal').value,
        packSize: $('#opt-packsize').value,
        packsPerPlayer: $('#opt-packs').value,
        jsChoices: $('#opt-choices').value
      }));
    } catch (e) { /* storage full — non-fatal */ }
  }

  function currentMode() {
    if (App.role === 'host') return App.setup.mode;
    return App.lobby ? App.lobby.mode : 'cube';
  }

  function isDeckMode(mode) { return mode === 'constructed' || mode === 'commander'; }

  function onModeChange() {
    var mode = $('#mode-cube').checked ? 'cube'
      : $('#mode-jumpstart').checked ? 'jumpstart'
      : $('#mode-constructed').checked ? 'constructed'
      : 'commander';
    App.setup.mode = mode;
    App.setup.cubeVariant = $('#cv-commander').checked ? 'commander'
      : $('#cv-vanguard').checked ? 'vanguard'
      : 'standard';
    $('#cube-setup').hidden = (mode !== 'cube');
    $('#js-setup').hidden = (mode !== 'jumpstart');
    $('#vanguard-setup').hidden = (App.setup.cubeVariant !== 'vanguard');
    $('#btn-load-pool').hidden = isDeckMode(mode);
    broadcastLobby();
    renderLobby();
  }

  function initHostPanel() {
    ['cube', 'jumpstart', 'constructed', 'commander'].forEach(function (m) {
      $('#mode-' + m).addEventListener('change', onModeChange);
    });
    ['standard', 'commander', 'vanguard'].forEach(function (v) {
      $('#cv-' + v).addEventListener('change', onModeChange);
    });

    $('#btn-load-pool').addEventListener('click', function () {
      saveSetup();
      var btn = $('#btn-load-pool');
      btn.disabled = true;
      btn.textContent = 'Loading cards…';
      var done = function () { btn.disabled = false; btn.textContent = 'Load & validate'; };

      App.setup.packSize = clampInt($('#opt-packsize').value, 5, 30, 15);
      App.setup.packsPerPlayer = clampInt($('#opt-packs').value, 1, 6, 3);
      App.setup.jsChoices = clampInt($('#opt-choices').value, 1, 6, 3);
      App.setup.vgDeal = clampInt($('#opt-vgdeal').value, 1, 10, 1);

      if (App.setup.mode === 'cube') {
        var parsed = MTGParser.parseDeckList($('#cube-text').value);
        var names = MTGParser.expandEntries(parsed.entries);
        if (!names.length) { done(); return toast('Cube list is empty or unparseable.', true); }
        var isVanguard = App.setup.cubeVariant === 'vanguard';
        var vgParsed = isVanguard ? MTGParser.parseDeckList($('#vg-text').value) : { entries: [], errors: [] };
        var vgNames = MTGParser.expandEntries(vgParsed.entries);
        if (isVanguard && !vgNames.length) {
          done();
          return toast('Vanguard needs a side pool — fill in the vanguard list.', true);
        }
        Scryfall.resolve(names.concat(vgNames), function (d, t) { btn.textContent = 'Loading cards… ' + d + '/' + t; })
          .then(function (res) {
            App.setup.cubeCards = Scryfall.toCardObjects(names, res.cards);
            App.setup.vanguardCards = isVanguard ? Scryfall.toCardObjects(vgNames, res.cards) : null;
            App.setup.jsPacks = null;
            done();
            reportPool(parsed.errors.concat(vgParsed.errors), res.notFound);
          })
          .catch(function (err) {
            // Scryfall unreachable — draft with text-only cards rather than block.
            App.setup.cubeCards = Scryfall.toCardObjects(names, {});
            App.setup.vanguardCards = isVanguard ? Scryfall.toCardObjects(vgNames, {}) : null;
            done();
            toast('Scryfall unreachable (' + err.message + ') — drafting without card images.', true);
            reportPool(parsed.errors.concat(vgParsed.errors), []);
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
    if (isDeckMode(s.mode)) {
      // Constructed / Commander: no draft — straight into a game with
      // everyone's uploaded deck (2-8 players, all of them in the game).
      var missing = App.players.filter(function (p) { return !App.decks[p.id]; });
      if (missing.length) {
        return toast('Waiting for decks from: ' + missing.map(function (p) { return p.name; }).join(', '), true);
      }
      var names = {};
      App.players.forEach(function (p) { names[p.id] = p.name; });
      try {
        App.game = new MTGGame.Game(ids, App.decks, names, { commander: s.mode === 'commander' });
      } catch (err) {
        return toast(err.message, true);
      }
      App.postGame = 'lobby';
      broadcastLobby();
      broadcastGameViews();
      return;
    }
    try {
      if (s.mode === 'cube') {
        if (!s.cubeCards) return toast('Load & validate the cube first.', true);
        App.vanguardDeals = {};
        if (s.cubeVariant === 'vanguard') {
          if (!s.vanguardCards) return toast('Load & validate the vanguard pool first.', true);
          if (s.vanguardCards.length < ids.length * s.vgDeal) {
            return toast('The vanguard pool has ' + s.vanguardCards.length + ' cards but ' +
              (ids.length * s.vgDeal) + ' are needed (' + ids.length + ' players × ' + s.vgDeal + ').', true);
          }
          // Deal everyone their random vanguard cards before the draft.
          var vgShuffled = MTGGame.shuffle(s.vanguardCards.slice(), Math.random);
          var vgN = 0;
          ids.forEach(function (pid) {
            App.vanguardDeals[pid] = vgShuffled.splice(0, s.vgDeal).map(function (c) {
              return Object.assign({}, c, { uid: 'vg' + (++vgN) });
            });
          });
        }
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

  /** A cube player's full pool: vanguard cards dealt pre-draft + their picks. */
  function hostDeckFor(pid) {
    return (App.vanguardDeals[pid] || []).concat(MTGDraft.deckFor(App.engine, pid));
  }

  function sendViewTo(player) {
    var view = App.engine.viewFor(player.id);
    var payload = { t: 'view', view: view };
    if (view.finished) {
      payload.deck = hostDeckFor(player.id);
      if (view.mode === 'cube') payload.variant = App.setup.cubeVariant;
    }
    if (player.id === App.myId) applyView(payload); // the host player
    else if (player.conn) App.net.send(player.conn, payload);
    // else: disconnected — never render someone else's private view locally
  }

  function broadcastViews() {
    App.players.forEach(sendViewTo);
  }

  /* ---------------- own-deck upload (constructed / commander) ---------------- */

  function initDeckSubmit() {
    $('#ds-load').addEventListener('click', function () {
      var mode = currentMode();
      var btn = $('#ds-load');
      var parsed = MTGParser.parseDeckListWithCommanders($('#ds-text').value);
      var names = MTGParser.expandEntries(parsed.entries);
      if (!names.length) return toast('Deck list is empty or unparseable.', true);
      if (mode === 'commander' && !parsed.commanders.length) {
        return toast('Mark your commander: put it under a "Commander" header or add *CMDR* to its line.', true);
      }
      btn.disabled = true;
      btn.textContent = 'Loading cards…';
      var finish = function () { btn.disabled = false; btn.textContent = 'Load & submit deck'; };
      var submit = function (resolved) {
        var cards = Scryfall.toCardObjects(names, resolved);
        var cmdrSet = {};
        parsed.commanders.forEach(function (n) { cmdrSet[n.toLowerCase()] = true; });
        cards.forEach(function (c) { if (cmdrSet[c.name.toLowerCase()]) c.commander = true; });
        if (App.role === 'host') {
          App.decks[App.myId] = cards;
          broadcastLobby();
          renderLobby();
        } else {
          App.conn.send({ t: 'deck', cards: cards });
        }
        $('#ds-status').textContent = '✓ ' + cards.length + ' cards submitted' +
          (parsed.commanders.length ? ' · commander: ' + parsed.commanders.join(', ') : '');
        $('#ds-status').className = 'pool-report ok';
        finish();
      };
      Scryfall.resolve(names, function (d, t) { btn.textContent = 'Loading cards… ' + d + '/' + t; })
        .then(function (res) { submit(res.cards); })
        .catch(function () {
          toast('Scryfall unreachable — submitting without card images.', true);
          submit({});
        });
    });
  }

  /* ---------------- preset lists (site owner drops files in lists/) ---------------- */

  // Which preset formats each picker offers.
  var PRESET_FORMATS = {
    cube: ['cube'],
    vanguard: ['vanguard', 'cube'],
    jumpstart: ['jumpstart'],
    deck: ['deck', 'commander']
  };

  function loadPresets() {
    var apply = function (list) {
      App.presets = Array.isArray(list) ? list : [];
      renderPresetRows();
    };
    // The relay server indexes lists/ itself; static hosting falls back to
    // a hand-maintained lists/manifest.json. No presets is not an error.
    fetch('api/lists')
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(apply)
      .catch(function () {
        fetch('lists/manifest.json')
          .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
          .then(function (files) {
            return Promise.all((files || []).map(function (f) {
              return fetch('lists/' + f)
                .then(function (r) { if (!r.ok) throw new Error(); return r.text(); })
                .then(function (text) {
                  var p = MTGParser.parsePresetFile(text);
                  return { file: 'lists/' + f, name: p.name || f, format: p.format || 'deck' };
                })
                .catch(function () { return null; });
            }));
          })
          .then(function (rows) { apply(rows.filter(Boolean)); })
          .catch(function () { apply([]); });
      });
  }

  function renderPresetRows() {
    document.querySelectorAll('.preset-row').forEach(function (row) {
      var formats = PRESET_FORMATS[row.getAttribute('data-preset-for')] || [];
      var matches = (App.presets || []).filter(function (p) {
        return formats.indexOf(p.format) !== -1;
      });
      if (!matches.length) { row.hidden = true; row.innerHTML = ''; return; }
      row.hidden = false;
      row.innerHTML = '<select class="preset-select"><option value="">📚 Preset lists…</option>' +
        matches.map(function (p) {
          return '<option value="' + escapeHtml(p.file) + '">' + escapeHtml(p.name) + '</option>';
        }).join('') + '</select>';
      var sel = row.querySelector('select');
      sel.addEventListener('change', function () {
        var file = sel.value;
        if (!file) return;
        fetch(file)
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
          .then(function (text) {
            var p = MTGParser.parsePresetFile(text);
            $('#' + row.getAttribute('data-target')).value = p.body;
            toast('Loaded preset: ' + (p.name || file));
            sel.value = '';
          })
          .catch(function () { toast('Could not load that preset.', true); });
      });
    });
  }

  /* ---------------- match panel (host picks who plays; rest spectate) ---------------- */

  function renderMatchPanel(containerId, eligibleIds) {
    var el = $('#' + containerId);
    if (App.role !== 'host' || App.game || App.players.length < 3 || eligibleIds.length < 2) {
      el.innerHTML = App.role === 'host' && App.players.length >= 3 && !App.game
        ? '<p class="hint">Start a match once at least 2 players are ready (' + eligibleIds.length + ' ready).</p>'
        : '';
      return;
    }
    el.innerHTML =
      '<h3>Start a match</h3>' +
      '<p class="hint">Pick who plays — everyone else spectates live. End the match to set up the next one.</p>' +
      eligibleIds.map(function (id) {
        var p = App.players.find(function (x) { return x.id === id; });
        return '<label class="radio"><input type="checkbox" class="match-p" value="' + id + '"> ' +
          escapeHtml(p ? p.name : id) + '</label>';
      }).join('') +
      '<div class="actions"><button id="btn-start-match" class="primary">⚔ Start match</button></div>';
    $('#btn-start-match').addEventListener('click', function () {
      var sel = [];
      el.querySelectorAll('.match-p:checked').forEach(function (cb) { sel.push(cb.value); });
      if (sel.length < 2) return toast('Pick at least 2 players.', true);
      hostStartMatch(sel);
    });
  }

  /** Game options for a post-draft cube match (commander cube = 40 life). */
  function cubeGameOpts() {
    return App.setup.cubeVariant === 'commander' ? { commander: true } : {};
  }

  function hostStartMatch(ids) {
    var decks = {};
    var names = {};
    var mode = App.setup.mode;
    for (var i = 0; i < ids.length; i++) {
      var p = App.players.find(function (x) { return x.id === ids[i]; });
      names[ids[i]] = p ? p.name : ids[i];
      decks[ids[i]] = mode === 'jumpstart' ? MTGDraft.deckFor(App.engine, ids[i]) : App.decks[ids[i]];
      if (!decks[ids[i]] || !decks[ids[i]].length) {
        return toast((names[ids[i]]) + ' has no deck ready.', true);
      }
    }
    try {
      App.game = new MTGGame.Game(ids, decks, names, mode === 'cube' ? cubeGameOpts() : {});
    } catch (err) {
      return toast(err.message, true);
    }
    App.postGame = mode === 'cube' ? 'build' : 'done';
    broadcastGameViews();
  }

  function hostEndMatch() {
    if (!App.game) return;
    App.game = null;
    var back = App.postGame || 'lobby';
    App.players.forEach(function (p) {
      if (p.conn) App.net.send(p.conn, { t: 'gameEnd', back: back });
    });
    returnFromGame(back);
    broadcastLobby();
  }

  function returnFromGame(back) {
    if (back === 'build' && App.builder) {
      show('build');
      renderBuilder();
    } else if (back === 'done') {
      renderDone();
      show('done');
    } else {
      show('lobby');
      renderLobby();
    }
  }

  /* ---------------- deck builder (after cube drafts) ---------------- */

  var BASICS = [
    { name: 'Plains', type: 'Basic Land — Plains', text: '({T}: Add {W}.)' },
    { name: 'Island', type: 'Basic Land — Island', text: '({T}: Add {U}.)' },
    { name: 'Swamp', type: 'Basic Land — Swamp', text: '({T}: Add {B}.)' },
    { name: 'Mountain', type: 'Basic Land — Mountain', text: '({T}: Add {R}.)' },
    { name: 'Forest', type: 'Basic Land — Forest', text: '({T}: Add {G}.)' }
  ];

  function openBuilder(deck) {
    App.builder = {
      pool: deck.slice(),
      main: [],
      commander: null, // one card (commander cube / vanguard variants)
      lands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
      landCards: null,
      ready: false,
      readyList: []
    };
    show('build');
    renderBuilder();
    // Basic land art (cached after the first draft; text-only if unreachable).
    Scryfall.resolve(BASICS.map(function (b) { return b.name; }))
      .then(function (res) {
        if (!App.builder) return;
        App.builder.landCards = {};
        BASICS.forEach(function (b) {
          var hit = res.cards[b.name.toLowerCase()];
          App.builder.landCards[b.name] = hit ? Object.assign({}, hit) : null;
        });
        renderBuilder();
      })
      .catch(function () { /* text-only lands are fine */ });
  }

  function playerCount() {
    if (App.role === 'host') return App.players.length;
    return App.lobby ? App.lobby.players.length : 0;
  }

  /** Does this build variant use the commander slot? */
  function builderUsesCommander() {
    return App.buildVariant === 'commander' || App.buildVariant === 'vanguard';
  }

  /** The full built deck as fresh card objects (commander + main + basics). */
  function builderDeck() {
    var b = App.builder;
    var cards = b.main.map(function (c) { return Object.assign({}, c); });
    if (b.commander) cards.push(Object.assign({}, b.commander, { commander: true }));
    BASICS.forEach(function (basic) {
      var proto = (b.landCards && b.landCards[basic.name]) || basic;
      for (var i = 0; i < b.lands[basic.name]; i++) {
        var copy = Object.assign({}, proto);
        delete copy.uid; // every land copy is its own card
        cards.push(copy);
      }
    });
    return cards;
  }

  function builderCardTile(c, from) {
    var cmdBtn = (builderUsesCommander() && from !== 'cmd' && !App.builder.ready)
      ? '<button class="cmd-btn" data-uid="' + c.uid + '" title="Make this your commander">★</button>'
      : '';
    return '<div class="card bcard" data-from="' + from + '" data-uid="' + c.uid +
      '" title="' + escapeHtml(c.name) + '">' + cardFace(c) + cmdBtn + '</div>';
  }

  function renderBuilder() {
    var b = App.builder;
    if (!b) return;
    var landTotal = BASICS.reduce(function (s, x) { return s + b.lands[x.name]; }, 0);
    var total = b.main.length + landTotal + (b.commander ? 1 : 0);
    $('#build-count').textContent = total + ' cards (' + b.main.length + ' spells + ' + landTotal + ' lands' +
      (b.commander ? ' + commander' : '') + ')' + (total < 40 ? ' — need 40+' : '');
    $('#main-count').textContent = b.main.length + (landTotal ? ' + ' + landTotal + ' lands' : '');
    $('#pool-count').textContent = b.pool.length;

    $('#build-commander').hidden = !builderUsesCommander();
    if (builderUsesCommander()) {
      $('#build-cmd-slot').innerHTML = b.commander
        ? builderCardTile(b.commander, 'cmd')
        : '<span class="zone-empty">' +
          (App.buildVariant === 'commander'
            ? 'required — hit ★ on a card below'
            : 'optional — hit ★ on a card below (any card works)') +
          '</span>';
    }

    $('#build-lands').innerHTML = BASICS.map(function (basic) {
      return '<div class="land-ctl"><span class="land-name">' + basic.name + '</span>' +
        '<button class="land-btn" data-l="' + basic.name + '" data-d="-1"' + (b.ready ? ' disabled' : '') + '>−</button>' +
        '<b>' + b.lands[basic.name] + '</b>' +
        '<button class="land-btn" data-l="' + basic.name + '" data-d="1"' + (b.ready ? ' disabled' : '') + '>+</button></div>';
    }).join('');

    $('#build-main-grid').innerHTML =
      b.main.map(function (c) { return builderCardTile(c, 'main'); }).join('') ||
      '<span class="zone-empty">click cards in your pool to add them</span>';
    $('#build-pool-grid').innerHTML =
      b.pool.map(function (c) { return builderCardTile(c, 'pool'); }).join('') ||
      '<span class="zone-empty">empty</span>';

    var count = playerCount();
    var readyBtn = $('#btn-build-ready');
    readyBtn.hidden = count < 2;
    readyBtn.textContent = b.ready ? '↺ Unready (edit deck)' : '✓ Ready — submit deck';
    var othersReady = b.readyList.filter(function (id) { return id !== App.myId; }).length;
    if (count === 2) {
      $('#build-status').textContent = b.ready
        ? (othersReady ? 'Starting…' : 'Waiting for your opponent to finish their deck…')
        : (othersReady ? 'Your opponent is ready.' : '');
    } else if (count > 2) {
      $('#build-status').textContent = b.ready
        ? 'Deck in — the host picks the next match (' + b.readyList.length + ' ready).'
        : b.readyList.length + ' player(s) ready.';
    } else {
      $('#build-status').textContent = 'Copy your deck list when done.';
    }
    if (App.role === 'host') {
      renderMatchPanel('match-panel-build', Object.keys(App.decks));
    }

    wireBuilder();
  }

  function wireBuilder() {
    document.querySelectorAll('#build-main-grid .bcard, #build-pool-grid .bcard').forEach(function (el) {
      el.addEventListener('click', function () {
        if (App.builder.ready) return;
        var uid = el.getAttribute('data-uid');
        var from = el.getAttribute('data-from') === 'main' ? 'main' : 'pool';
        var to = from === 'main' ? 'pool' : 'main';
        var b = App.builder;
        for (var i = 0; i < b[from].length; i++) {
          if (b[from][i].uid === uid) {
            b[to].push(b[from].splice(i, 1)[0]);
            break;
          }
        }
        renderBuilder();
      });
      el.addEventListener('mouseenter', function () {
        var uid = el.getAttribute('data-uid');
        var b = App.builder;
        var card = b.main.concat(b.pool).concat(b.commander ? [b.commander] : [])
          .find(function (c) { return c.uid === uid; });
        if (card) $('#build-preview').innerHTML = buildPreviewHtml(card);
      });
    });
    // ★ on any card claims the commander slot (any card is allowed — vanguard
    // cards, legends, whatever the table agrees on).
    document.querySelectorAll('.cmd-btn').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (App.builder.ready) return;
        var uid = btn.getAttribute('data-uid');
        var b = App.builder;
        ['main', 'pool'].forEach(function (zone) {
          for (var i = 0; i < b[zone].length; i++) {
            if (b[zone][i].uid === uid) {
              if (b.commander) b.pool.push(b.commander);
              b.commander = b[zone].splice(i, 1)[0];
              break;
            }
          }
        });
        renderBuilder();
      });
    });
    // Clicking the commander tile sends it back to the pool.
    document.querySelectorAll('#build-cmd-slot .bcard').forEach(function (el) {
      el.addEventListener('click', function () {
        if (App.builder.ready || !App.builder.commander) return;
        App.builder.pool.push(App.builder.commander);
        App.builder.commander = null;
        renderBuilder();
      });
      el.addEventListener('mouseenter', function () {
        if (App.builder.commander) $('#build-preview').innerHTML = buildPreviewHtml(App.builder.commander);
      });
    });
    document.querySelectorAll('#build-lands .land-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (App.builder.ready) return;
        var l = btn.getAttribute('data-l');
        var d = parseInt(btn.getAttribute('data-d'), 10);
        App.builder.lands[l] = Math.max(0, Math.min(30, App.builder.lands[l] + d));
        renderBuilder();
      });
    });
  }

  function buildPreviewHtml(card) {
    var body = card.img
      ? '<img src="' + escapeHtml(card.img) + '" alt="' + escapeHtml(card.name) +
        '" onerror="this.style.display=\'none\'">'
      : '<div class="preview-text"><strong>' + escapeHtml(card.name) + '</strong></div>';
    return body + '<div class="preview-meta">' +
      '<div class="preview-name">' + escapeHtml(card.name) +
        (card.pt ? ' <span class="preview-pt">' + escapeHtml(card.pt) + '</span>' : '') + '</div>' +
      (card.cost ? '<div class="preview-cost">' + escapeHtml(card.cost) + '</div>' : '') +
      (card.type ? '<div class="preview-type">' + escapeHtml(card.type) + '</div>' : '') +
      '<div class="preview-price">TCG: ' + (card.price ? '$' + escapeHtml(card.price) : '??') + '</div>' +
      (card.text ? '<div class="preview-oracle">' + escapeHtml(card.text).replace(/\n/g, '<br>') + '</div>' : '') +
      '</div>';
  }

  function initBuilder() {
    $('#btn-build-copy').addEventListener('click', function () {
      var text = MTGParser.formatDeckList(builderDeck().map(function (c) { return c.name; }));
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('Deck copied — paste it into Moxfield.'); });
      }
    });
    $('#btn-build-ready').addEventListener('click', function () {
      var b = App.builder;
      if (!b.ready) {
        var landTotal = BASICS.reduce(function (s, x) { return s + b.lands[x.name]; }, 0);
        var total = b.main.length + landTotal + (b.commander ? 1 : 0);
        if (total < 40) {
          return toast('Your deck needs at least 40 cards — it has ' + total +
            '. Add cards or basic lands.', true);
        }
        if (App.buildVariant === 'commander' && !b.commander) {
          return toast('Commander cube needs a commander — hit ★ on a card.', true);
        }
      }
      b.ready = !b.ready;
      if (App.role === 'host') {
        if (b.ready) App.decks[App.myId] = builderDeck();
        else delete App.decks[App.myId];
        hostBroadcastReady();
        renderBuilder();
        hostMaybeStartCubeGame();
      } else {
        if (b.ready) App.conn.send({ t: 'deck', cards: builderDeck() });
        else App.conn.send({ t: 'undeck' });
        renderBuilder();
      }
    });
  }

  function hostBroadcastReady() {
    var ready = Object.keys(App.decks);
    if (App.builder) { App.builder.readyList = ready; renderBuilder(); }
    App.players.forEach(function (p) {
      if (p.conn) App.net.send(p.conn, { t: 'ready', ready: ready });
    });
  }

  function hostMaybeStartCubeGame() {
    if (App.players.length !== 2) return;
    var haveAll = App.players.every(function (p) { return App.decks[p.id]; });
    if (!haveAll || App.game) return;
    var names = {};
    App.players.forEach(function (p) { names[p.id] = p.name; });
    try {
      App.game = new MTGGame.Game(App.players.map(function (p) { return p.id; }),
        App.decks, names, cubeGameOpts());
    } catch (err) {
      return toast(err.message, true);
    }
    App.postGame = 'build';
    broadcastGameViews();
  }

  /* ---------------- post-draft 1v1 game (host authority) ---------------- */

  function hostStartGame() {
    if (App.players.length !== 2) return toast('Use the match panel to pick who plays.', true);
    var decks = {};
    var names = {};
    App.players.forEach(function (p) {
      decks[p.id] = MTGDraft.deckFor(App.engine, p.id);
      names[p.id] = p.name;
    });
    try {
      App.game = new MTGGame.Game(App.players.map(function (p) { return p.id; }), decks, names);
    } catch (err) {
      return toast(err.message, true);
    }
    App.postGame = 'done';
    broadcastGameViews();
  }

  function hostApplyAction(player, action) {
    if (!App.game) return;
    try {
      App.game.apply(player.id, action);
    } catch (err) {
      if (player.conn) App.net.send(player.conn, { t: 'err', msg: err.message });
      else toast(err.message, true);
      return;
    }
    broadcastGameViews();
  }

  function sendGameViewTo(player) {
    // Participants get their own view; everyone else spectates (public info).
    var isParticipant = App.game.players.indexOf(player.id) !== -1;
    var payload = { t: 'game', view: App.game.viewFor(isParticipant ? player.id : null) };
    if (player.id === App.myId) applyGameView(payload); // the host player
    else if (player.conn) App.net.send(player.conn, payload);
    // else: disconnected — never render someone else's private view locally
  }

  function broadcastGameViews() {
    App.players.forEach(sendGameViewTo);
  }

  function gameSend(action) {
    if (App.role === 'host') hostApplyAction(App.players[0], action);
    else App.conn.send({ t: 'act', action: action });
  }

  function applyGameView(payload) {
    show('game');
    $('#spectate-note').hidden = !!payload.view.you;
    $('#btn-end-match').hidden = App.role !== 'host';
    GameUI.render(payload.view, gameSend);
  }

  /* ---------------- joining (guest) ---------------- */

  function startJoining(name, code) {
    App.role = 'guest';
    App.myName = name;
    App.joinInfo = { name: name, code: code };
    $('#btn-join').disabled = true;

    App.conn = Net.join(code, {
      onOpen: function () {
        App.conn.send({ t: 'hello', name: name });
      },
      onMessage: function (msg) { guestHandleMessage(msg); },
      onClose: function () { guestConnectionLost(); },
      onError: function (err) {
        if (App.reconnectTries > 0) { guestConnectionLost(); return; }
        $('#btn-join').disabled = false;
        toast(err.message || 'Connection failed', true);
      }
    });
  }

  /**
   * Flaky-internet tolerance: once a guest has ever joined, a dropped
   * connection quietly retries every few seconds (~2 minutes total). The
   * host keeps the seat, so a successful retry lands right back in place.
   */
  function guestConnectionLost() {
    if (!App.joinInfo || !App.myId) {
      $('#btn-join').disabled = false;
      toast('Connection failed.', true);
      show('home');
      return;
    }
    App.reconnectTries = (App.reconnectTries || 0) + 1;
    if (App.reconnectTries === 1) toast('Connection lost — reconnecting…', true);
    if (App.reconnectTries > 45) {
      App.reconnectTries = 0;
      toast('Could not reconnect. Rejoin with the same name to get your seat back.', true);
      $('#btn-join').disabled = false;
      show('home');
      return;
    }
    try { App.conn.close(); } catch (e) { /* already gone */ }
    setTimeout(function () {
      startJoining(App.joinInfo.name, App.joinInfo.code);
    }, 2500);
  }

  function guestHandleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'welcome':
        App.myId = msg.id;
        if (App.reconnectTries) toast('Reconnected!');
        App.reconnectTries = 0;
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
      case 'game':
        applyGameView(msg);
        break;
      case 'ready':
        if (App.builder) {
          App.builder.readyList = msg.ready || [];
          renderBuilder();
        }
        break;
      case 'gameEnd':
        returnFromGame(msg.back || 'lobby');
        toast('The match has ended.');
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
    var players, info, mode, deckReady;
    if (App.role === 'host') {
      mode = App.setup.mode;
      deckReady = Object.keys(App.decks);
      players = App.players.map(function (p) {
        return { id: p.id, name: p.name, connected: p.connected, isHost: p.id === 'p0' };
      });
      info = poolInfoText();
      var ready;
      if (isDeckMode(mode)) {
        ready = App.players.length >= 2 &&
          App.players.every(function (p) { return App.decks[p.id]; });
        $('#btn-start').textContent = 'Start game';
      } else {
        ready = (mode === 'cube' && App.setup.cubeCards &&
                  (App.setup.cubeVariant !== 'vanguard' || App.setup.vanguardCards)) ||
                (mode === 'jumpstart' && App.setup.jsPacks);
        $('#btn-start').textContent = 'Start draft';
      }
      $('#btn-start').disabled = !ready;
    } else {
      if (!App.lobby) return;
      mode = App.lobby.mode;
      deckReady = App.lobby.deckReady || [];
      players = App.lobby.players.map(function (p) {
        return { id: p.id, name: p.name, connected: p.connected, isHost: p.id === 'p0' };
      });
      info = App.lobby.poolInfo;
    }
    $('#lobby-players').innerHTML = players.map(function (p) {
      return '<li class="' + (p.connected ? '' : 'gone') + '">' +
        escapeHtml(p.name) + (p.isHost ? ' <span class="tag">host</span>' : '') +
        (isDeckMode(mode) && deckReady.indexOf(p.id) !== -1 ? ' <span class="tag ok-tag">deck ✓</span>' : '') +
        (p.connected ? '' : ' (disconnected)') + '</li>';
    }).join('');
    $('#lobby-info').textContent = info || '';
    $('#deck-submit-panel').hidden = !isDeckMode(mode);
  }

  /* ---------------- draft rendering (both roles) ---------------- */

  function applyView(payload) {
    App.lastView = payload.view;
    if (payload.view.finished) {
      App.lastDeck = payload.deck ||
        (App.role === 'host' ? hostDeckFor('p0') : App.lastDeck);
      if (payload.view.mode === 'cube') {
        App.buildVariant = payload.variant ||
          (App.role === 'host' ? App.setup.cubeVariant : App.buildVariant) || 'standard';
        openBuilder(App.lastDeck || []);
        return;
      }
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

  function setDraftPreview(card) {
    if (card) $('#draft-preview').innerHTML = buildPreviewHtml(card);
  }

  function renderCubeView(v) {
    $('#draft-status').textContent =
      'Pack ' + (v.round + 1) + ' of ' + v.packsPerPlayer +
      ' · Pick ' + v.pickNumber +
      (v.queued ? ' · ' + v.queued + ' pack(s) waiting' : '');
    var area = $('#draft-area');
    if (!v.pack) {
      App.selectedUid = null;
      area.innerHTML = '<p class="waiting">Waiting for the next pack to be passed to you…</p>';
      return;
    }
    // Re-renders arrive whenever ANY player picks; keep this player's
    // selection alive as long as the selected card is still in their pack.
    var prevSelected = App.selectedUid;
    App.selectedUid = null;
    area.innerHTML =
      '<div class="card-grid">' +
      v.pack.map(function (c) {
        return '<div class="card" data-uid="' + c.uid + '" title="' + escapeHtml(c.name) + '">' +
          cardFace(c) + '</div>';
      }).join('') +
      '</div>' +
      '<div class="pick-bar"><button id="btn-confirm-pick" disabled>Pick a card</button></div>';

    var cardByUid = Object.create(null);
    v.pack.forEach(function (c) { cardByUid[c.uid] = c; });
    area.querySelectorAll('.card').forEach(function (el) {
      var uid = el.getAttribute('data-uid');
      el.addEventListener('click', function () {
        area.querySelectorAll('.card.selected').forEach(function (s) { s.classList.remove('selected'); });
        el.classList.add('selected');
        App.selectedUid = uid;
        setDraftPreview(cardByUid[uid]);
        var btn = $('#btn-confirm-pick');
        btn.disabled = false;
        btn.textContent = 'Pick ' + el.getAttribute('title');
      });
      el.addEventListener('mouseenter', function () { setDraftPreview(cardByUid[uid]); });
      el.addEventListener('dblclick', function () {
        sendPick(uid);
      });
    });
    $('#btn-confirm-pick').addEventListener('click', function () {
      if (App.selectedUid) sendPick(App.selectedUid);
    });

    if (prevSelected && cardByUid[prevSelected]) {
      App.selectedUid = prevSelected;
      var keep = area.querySelector('.card[data-uid="' + prevSelected + '"]');
      if (keep) keep.classList.add('selected');
      var pickBtn = $('#btn-confirm-pick');
      pickBtn.disabled = false;
      pickBtn.textContent = 'Pick ' + cardByUid[prevSelected].name;
    }
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
    var byUid = Object.create(null);
    if (v.mode === 'cube') {
      $('#picks-title').textContent = 'Your picks (' + v.picks.length + ')';
      side.innerHTML = v.picks.slice().reverse().map(function (c) {
        byUid[c.uid] = c;
        return '<li data-uid="' + c.uid + '" title="' + escapeHtml(c.type || '') + '">' + escapeHtml(c.name) +
          (c.cost ? ' <span class="cost">' + escapeHtml(c.cost) + '</span>' : '') + '</li>';
      }).join('');
    } else {
      $('#picks-title').textContent = 'Your packs (' + v.picks.length + ')';
      side.innerHTML = v.picks.map(function (p) {
        return '<li class="js-picked"><strong>' + escapeHtml(p.name) + '</strong><ul>' +
          p.cards.map(function (c) {
            byUid[c.uid] = c;
            return '<li data-uid="' + c.uid + '">' + escapeHtml(c.name) + '</li>';
          }).join('') +
          '</ul></li>';
      }).join('');
    }
    side.querySelectorAll('li[data-uid]').forEach(function (el) {
      el.addEventListener('mouseenter', function () {
        setDraftPreview(byUid[el.getAttribute('data-uid')]);
      });
    });
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

    // After a jumpstart draft: 2 players go straight to the board; with more,
    // the host gets the match panel (winners stay, spectators watch, etc.).
    var isJs = App.lastView && App.lastView.mode === 'jumpstart';
    var count = App.role === 'host' ? App.players.length : (App.lobby ? App.lobby.players.length : 0);
    $('#btn-start-game').hidden = !(isJs && count === 2 && App.role === 'host');
    $('#game-hint').hidden = !(isJs && count >= 2 && App.role !== 'host');
    if (isJs && App.role === 'host') {
      renderMatchPanel('match-panel-done', App.players.map(function (p) { return p.id; }));
    }
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
    $('#btn-start-game').addEventListener('click', function () {
      if (App.role === 'host') hostStartGame();
    });
  }

  /* ---------------- helpers ---------------- */

  function cardFace(c) {
    var text = function (extra) {
      return '<div class="card-text' + extra + '"><span class="card-name">' + escapeHtml(c.name) + '</span>' +
        (c.cost ? '<span class="card-cost">' + escapeHtml(c.cost) + '</span>' : '') +
        (c.type ? '<span class="card-type">' + escapeHtml(c.type) + '</span>' : '') + '</div>';
    };
    if (c.img) {
      // If the art can't load (image CDN down), fall back to the text face.
      return '<img loading="lazy" src="' + escapeHtml(c.img) + '" alt="' + escapeHtml(c.name) +
        '" onerror="this.parentNode.classList.add(\'img-dead\')">' + text(' img-fallback');
    }
    return text('');
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
    loadPresets();
    initDone();
    initBuilder();
    initDeckSubmit();
    $('#btn-end-match').addEventListener('click', function () {
      if (App.role === 'host') hostEndMatch();
    });
    $('#btn-copy-code').addEventListener('click', function () {
      var code = $('#room-code').textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () { toast('Room code copied.'); });
      }
    });
    show('home');
  });
})();
