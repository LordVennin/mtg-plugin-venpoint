/*
 * Play surface rendering + interaction. No drag-and-drop: click a card to
 * select it (and preview it large on the left), then use the buttons that
 * appear for its zone. Clicking ANY card — the opponent's included — shows
 * it in the preview pane so it can actually be read.
 *
 * Battlefields are two rows: non-lands on the row nearer the middle of the
 * table, lands on the row nearer their owner. Attached cards (equipment,
 * auras) render tucked behind the permanent they are attached to, even
 * across the table.
 *
 * GameUI.render(view, sendAction) redraws the whole board from a view.
 */

var GameUI = (function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var selected = null;    // {zone:'hand'|'battlefield'|'graveyard', uid}
  var attachMode = null;  // {uid, name} while choosing an attach target
  var previewUid = null;
  var cardIndex = {};     // uid -> {card, tapped?, counters?} for preview lookups
  var lastView = null;
  var lastSend = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function indexCard(card) { cardIndex[card.uid] = card; }

  function cardHtml(card, opts) {
    opts = opts || {};
    indexCard(card);
    var cls = 'gcard' + (opts.tapped ? ' tapped' : '') + (opts.small ? ' small' : '') +
      (opts.attachment ? ' attachment' : '') + (card.token ? ' token' : '');
    if (selected && selected.uid === card.uid && opts.mine) cls += ' selected';
    if (previewUid === card.uid) cls += ' previewed';
    var inner;
    if (card.img) {
      inner = '<img loading="lazy" src="' + escapeHtml(card.img) + '" alt="' + escapeHtml(card.name) + '">';
    } else {
      inner = '<span class="gcard-name">' + escapeHtml(card.name) + '</span>';
    }
    var badge = opts.counters ? '<span class="counter-badge">' + opts.counters + '</span>' : '';
    return '<div class="' + cls + '" data-zone="' + (opts.zone || '') + '" data-uid="' + card.uid +
      '" data-mine="' + (opts.mine ? '1' : '0') + '" title="' + escapeHtml(card.name) + '"' +
      (opts.style ? ' style="' + opts.style + '"' : '') + '>' + inner + badge + '</div>';
  }

  /** A permanent plus everything attached to it, as one visual stack. */
  function stackHtml(entry, attachments, mine) {
    var main = cardHtml(entry.card, {
      zone: mine ? 'battlefield' : null, mine: mine,
      tapped: entry.tapped, counters: entry.counters
    });
    if (!attachments.length) return main;
    var w = 82 + attachments.length * 20;
    var h = Math.round(82 * 7 / 5) + attachments.length * 16;
    var html = '<div class="perm-stack" style="width:' + w + 'px;height:' + h + 'px">';
    attachments.forEach(function (a, i) {
      html += '<div class="stack-slot" style="left:' + ((i + 1) * 20) + 'px;top:' + ((i + 1) * 16) + 'px;z-index:' + (5 - i) + '">' +
        cardHtml(a.entry.card, {
          zone: a.mine ? 'battlefield' : null, mine: a.mine,
          tapped: a.entry.tapped, counters: a.entry.counters, attachment: true
        }) + '</div>';
    });
    html += '<div class="stack-slot" style="left:0;top:0;z-index:9">' + main + '</div></div>';
    return html;
  }

  /**
   * Both rows of one player's battlefield. Attachments (from either side)
   * render inside their target's stack; attached cards whose target sits on
   * the OTHER battlefield are skipped here and drawn over there.
   */
  function battlefieldHtml(view, pid, mine, mirror) {
    // attachment map over both battlefields: target uid -> [{entry, mine}]
    var att = {};
    var targetSide = {};
    view.players.forEach(function (id) {
      view.zones[id].battlefield.forEach(function (e) {
        targetSide[e.card.uid] = id;
      });
    });
    view.players.forEach(function (id) {
      view.zones[id].battlefield.forEach(function (e) {
        if (e.attachedTo && targetSide[e.attachedTo] !== undefined) {
          (att[e.attachedTo] = att[e.attachedTo] || []).push({ entry: e, mine: id === view.you });
        }
      });
    });

    var rows = { main: [], land: [] };
    view.zones[pid].battlefield.forEach(function (e) {
      if (e.attachedTo && targetSide[e.attachedTo] !== undefined) return; // drawn in its target's stack
      rows[e.row === 'land' ? 'land' : 'main'].push(stackHtml(e, att[e.card.uid] || [], mine));
    });

    var rowDiv = function (label, cells) {
      return '<div class="bf-row"><span class="row-label">' + label + '</span>' +
        (cells.length ? cells.join('') : '<span class="zone-empty">—</span>') + '</div>';
    };
    var main = rowDiv('spells', rows.main);
    var lands = rowDiv('lands', rows.land);
    // Own side: spells on top, lands at the bottom (nearest your hand).
    // Opponent: mirrored, so the two spell rows face each other.
    return '<div class="battlefield">' + (mirror ? lands + main : main + lands) + '</div>';
  }

  function zoneStrip(label, cards, zone, mine) {
    var inner = cards.length
      ? cards.map(function (c) { return cardHtml(c, { zone: mine ? zone : null, small: true, mine: mine }); }).join('')
      : '<span class="zone-empty">—</span>';
    return '<div class="zone-strip"><span class="zone-label">' + label + ' (' + cards.length + ')</span>' +
      '<div class="zone-cards">' + inner + '</div></div>';
  }

  function contextButtons(view) {
    if (attachMode) {
      return '<span class="attach-hint">Attaching <strong>' + escapeHtml(attachMode.name) +
        '</strong> — click a card on the battlefield (or empty space to cancel)</span>';
    }
    if (!selected) return '';
    var b = function (act, label) {
      return '<button class="ctx" data-act="' + act + '">' + label + '</button>';
    };
    if (selected.zone === 'hand') return b('play', '▶ Play') + b('discard', 'Discard');
    if (selected.zone === 'battlefield') {
      var entry = null;
      view.zones[view.you].battlefield.forEach(function (e) {
        if (e.card.uid === selected.uid) entry = e;
      });
      return b('tap', 'Tap / Untap') +
        (entry && entry.attachedTo ? b('detach', 'Detach') : b('attach', '🔗 Attach to…')) +
        b('counter+', '+ Counter') + b('counter-', '− Counter') +
        b('row', '⇅ Row') +
        b('to-graveyard', '→ Graveyard') + b('to-exile', '→ Exile') + b('to-hand', '→ Hand') +
        b('to-library', '→ Shuffle in');
    }
    if (selected.zone === 'graveyard') return b('recover', '→ Hand');
    return '';
  }

  function previewHtml() {
    var card = previewUid && cardIndex[previewUid];
    if (!card) {
      return '<div class="preview-empty">Click any card to read it here</div>';
    }
    var body = card.img
      ? '<img src="' + escapeHtml(card.img) + '" alt="' + escapeHtml(card.name) + '">'
      : '<div class="preview-text"><strong>' + escapeHtml(card.name) + '</strong></div>';
    return body +
      '<div class="preview-meta">' +
        '<div class="preview-name">' + escapeHtml(card.name) + '</div>' +
        (card.cost ? '<div class="preview-cost">' + escapeHtml(card.cost) + '</div>' : '') +
        (card.type ? '<div class="preview-type">' + escapeHtml(card.type) + '</div>' : '') +
      '</div>';
  }

  function peekModalHtml(view) {
    if (!view.peek) return '';
    return '<div class="search-inner">' +
      '<h3>Top of your library (' + view.peek.cards.length + ' shown, top first)</h3>' +
      '<p class="hint">Only you can see this. "Top" moves a card to the very top; ' +
      '"Bottom" and card counts are logged, names are not (except to battlefield/graveyard).</p>' +
      '<div class="search-grid">' +
      view.peek.cards.map(function (c, i) {
        indexCard(c);
        return '<div class="search-item">' +
          '<div class="peek-pos">#' + (i + 1) + '</div>' +
          cardHtml(c, { mine: false }) +
          '<div class="search-item-name">' + escapeHtml(c.name) + '</div>' +
          '<div class="search-btns">' +
            '<button class="peek-take" data-uid="' + c.uid + '" data-to="top">Top</button>' +
            '<button class="peek-take" data-uid="' + c.uid + '" data-to="bottom">Bottom</button>' +
          '</div><div class="search-btns">' +
            '<button class="peek-take" data-uid="' + c.uid + '" data-to="hand">Hand</button>' +
            '<button class="peek-take" data-uid="' + c.uid + '" data-to="battlefield">Field</button>' +
            '<button class="peek-take" data-uid="' + c.uid + '" data-to="graveyard">Yard</button>' +
          '</div></div>';
      }).join('') +
      '</div>' +
      '<div class="search-footer"><button id="btn-end-peek" class="primary">Done</button></div>' +
    '</div>';
  }

  function searchModalHtml(view) {
    if (!view.searching || !view.library) return '';
    return '<div class="search-inner">' +
      '<h3>Searching your library (' + view.library.length + ' cards)</h3>' +
      '<p class="hint">Only you can see this. Taking a card to hand is logged without its name.</p>' +
      '<div class="search-grid">' +
      view.library.map(function (c) {
        indexCard(c);
        return '<div class="search-item">' +
          cardHtml(c, { mine: false, small: false }) +
          '<div class="search-item-name">' + escapeHtml(c.name) + '</div>' +
          '<div class="search-btns">' +
            '<button class="take" data-uid="' + c.uid + '" data-to="hand">Hand</button>' +
            '<button class="take" data-uid="' + c.uid + '" data-to="battlefield">Field</button>' +
            '<button class="take" data-uid="' + c.uid + '" data-to="graveyard">Yard</button>' +
          '</div></div>';
      }).join('') +
      '</div>' +
      '<div class="search-footer"><button id="btn-end-search" class="primary">Done — shuffle library</button></div>' +
    '</div>';
  }

  function render(view, sendAction) {
    lastView = view;
    lastSend = sendAction;
    cardIndex = {};
    var me = view.you;
    var opp = view.players[0] === me ? view.players[1] : view.players[0];
    var myName = view.names[me] || 'You';
    var oppName = view.names[opp] || 'Opponent';
    var mz = view.zones[me];
    var oz = view.zones[opp];

    // Drop stale selection / attach mode (card may have changed zones).
    var onMyBf = function (uid) {
      return mz.battlefield.some(function (e) { return e.card.uid === uid; });
    };
    if (selected) {
      var still =
        (selected.zone === 'hand' && view.hand.some(function (c) { return c.uid === selected.uid; })) ||
        (selected.zone === 'battlefield' && onMyBf(selected.uid)) ||
        (selected.zone === 'graveyard' && mz.graveyard.some(function (c) { return c.uid === selected.uid; }));
      if (!still) selected = null;
    }
    if (attachMode && !onMyBf(attachMode.uid)) attachMode = null;

    var turnBadge = function (pid) {
      return view.active === pid ? '<span class="turn-badge">turn</span>' : '';
    };

    $('#game-board').innerHTML =
      '<div class="player-area opp">' +
        '<div class="player-bar">' +
          '<span class="pname">' + escapeHtml(oppName) + '</span>' + turnBadge(opp) +
          '<span class="stat">♥ ' + view.life[opp] + '</span>' +
          '<span class="stat">✋ ' + oz.handCount + '</span>' +
          '<span class="stat">📚 ' + oz.libraryCount + '</span>' +
        '</div>' +
        battlefieldHtml(view, opp, false, true) +
        '<div class="side-zones">' +
          zoneStrip('Graveyard', oz.graveyard, null, false) +
          zoneStrip('Exile', oz.exile, null, false) +
        '</div>' +
      '</div>' +

      '<div class="board-divider">Turn ' + view.turn + '</div>' +

      '<div class="player-area mine">' +
        '<div class="side-zones">' +
          zoneStrip('Graveyard', mz.graveyard, 'graveyard', true) +
          zoneStrip('Exile', mz.exile, null, false) +
        '</div>' +
        battlefieldHtml(view, me, true, false) +
        '<div id="ctx-bar" class="ctx-bar">' + contextButtons(view) + '</div>' +
        '<div class="hand">' +
          view.hand.map(function (c) { return cardHtml(c, { zone: 'hand', mine: true }); }).join('') +
          (view.hand.length ? '' : '<span class="zone-empty">hand empty</span>') +
        '</div>' +
        '<div class="player-bar">' +
          '<span class="pname">' + escapeHtml(myName) + '</span>' + turnBadge(me) +
          '<span class="stat">📚 ' + mz.libraryCount + '</span>' +
          '<button class="gact" data-act="life-">−</button>' +
          '<span class="stat">♥ ' + view.life[me] + '</span>' +
          '<button class="gact" data-act="life+">+</button>' +
          '<button class="gact" data-act="draw">Draw</button>' +
          '<button class="gact" data-act="search">🔍 Search</button>' +
          '<button class="gact" data-act="untapAll">Untap all</button>' +
          '<button class="gact" data-act="shuffle">Shuffle</button>' +
          '<button class="gact" data-act="mulligan">Mulligan</button>' +
          '<button class="gact" data-act="scry">👁 Scry</button>' +
          '<button class="gact" data-act="token">➕ Token</button>' +
          '<button class="gact" data-act="d6">🎲 d6</button>' +
          '<button class="gact" data-act="d20">🎲 d20</button>' +
          '<button class="gact" data-act="coin">🪙 Flip</button>' +
          '<button class="gact primary" data-act="passTurn">Pass turn</button>' +
        '</div>' +
      '</div>';

    $('#card-preview').innerHTML = previewHtml();

    $('#game-log').innerHTML = view.log.map(function (l) {
      return '<div class="log-line' + (l.p === me ? ' me' : '') + '">' + escapeHtml(l.text) + '</div>';
    }).join('');
    $('#game-log').scrollTop = $('#game-log').scrollHeight;

    var modal = $('#search-modal');
    modal.innerHTML = searchModalHtml(view);
    modal.hidden = !(view.searching && view.library);

    var peekModal = $('#peek-modal');
    peekModal.innerHTML = peekModalHtml(view);
    peekModal.hidden = !view.peek;

    wire();
  }

  function act(action) {
    if (lastSend) lastSend(action);
  }

  function rerender() { render(lastView, lastSend); }

  function wire() {
    var board = $('#game-board');

    board.querySelectorAll('.gcard').forEach(function (el) {
      var uid = el.getAttribute('data-uid');
      var zone = el.getAttribute('data-zone');
      var mine = el.getAttribute('data-mine') === '1';

      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (attachMode) {
          if (uid !== attachMode.uid) act({ a: 'attach', uid: attachMode.uid, target: uid });
          attachMode = null;
          rerender();
          return;
        }
        previewUid = uid;
        if (mine && zone) {
          if (selected && selected.uid === uid && selected.zone === zone) selected = null;
          else selected = { zone: zone, uid: uid };
        }
        rerender();
      });
      if (mine && zone) {
        el.addEventListener('dblclick', function (ev) {
          ev.stopPropagation();
          if (zone === 'hand') act({ a: 'play', uid: uid });
          else if (zone === 'battlefield') act({ a: 'tap', uid: uid });
        });
      }
    });

    board.querySelectorAll('button.ctx').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!selected) return;
        var uid = selected.uid;
        var kind = btn.getAttribute('data-act');
        if (kind === 'attach') {
          var card = cardIndex[uid];
          attachMode = { uid: uid, name: card ? card.name : 'card' };
          selected = null;
          rerender();
          return;
        }
        var map = {
          'play': { a: 'play', uid: uid },
          'discard': { a: 'discard', uid: uid },
          'tap': { a: 'tap', uid: uid },
          'detach': { a: 'detach', uid: uid },
          'row': { a: 'row', uid: uid },
          'counter+': { a: 'counter', uid: uid, d: 1 },
          'counter-': { a: 'counter', uid: uid, d: -1 },
          'to-graveyard': { a: 'move', uid: uid, to: 'graveyard' },
          'to-exile': { a: 'move', uid: uid, to: 'exile' },
          'to-hand': { a: 'move', uid: uid, to: 'hand' },
          'to-library': { a: 'move', uid: uid, to: 'library' },
          'recover': { a: 'recover', uid: uid }
        };
        if (map[kind]) act(map[kind]);
      });
    });

    board.querySelectorAll('button.gact').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var kind = btn.getAttribute('data-act');
        if (kind === 'token') {
          var input = window.prompt('Token to create — a name, or a count + name (e.g. "Goblin" or "3 Treasure"):', '');
          if (!input || !input.trim()) return;
          var tm = input.trim().match(/^(\d+)\s*x?\s+(.+)$/i);
          if (tm) act({ a: 'token', name: tm[2], count: parseInt(tm[1], 10) });
          else act({ a: 'token', name: input.trim(), count: 1 });
          return;
        }
        if (kind === 'scry') {
          var sn = parseInt(window.prompt('Look at how many cards from the top of your library?', '3'), 10);
          if (!sn || sn < 1) return;
          act({ a: 'peek', n: Math.min(sn, 20) });
          return;
        }
        var map = {
          'draw': { a: 'draw' },
          'search': { a: 'searchLibrary' },
          'untapAll': { a: 'untapAll' },
          'shuffle': { a: 'shuffle' },
          'mulligan': { a: 'mulligan' },
          'passTurn': { a: 'passTurn' },
          'life+': { a: 'life', d: 1 },
          'life-': { a: 'life', d: -1 },
          'd6': { a: 'roll', sides: 6 },
          'd20': { a: 'roll', sides: 20 },
          'coin': { a: 'coin' }
        };
        var action = map[btn.getAttribute('data-act')];
        if (action) act(action);
      });
    });

    // Click empty board space: cancel attach mode / clear selection.
    board.addEventListener('click', function () {
      if (attachMode || selected) { attachMode = null; selected = null; rerender(); }
    });

    var modal = $('#search-modal');
    modal.querySelectorAll('button.take').forEach(function (btn) {
      btn.addEventListener('click', function () {
        act({ a: 'takeFromLibrary', uid: btn.getAttribute('data-uid'), to: btn.getAttribute('data-to') });
      });
    });
    var endBtn = modal.querySelector('#btn-end-search');
    if (endBtn) endBtn.addEventListener('click', function () { act({ a: 'endSearch' }); });

    var peekModal = $('#peek-modal');
    peekModal.querySelectorAll('button.peek-take').forEach(function (btn) {
      btn.addEventListener('click', function () {
        act({ a: 'peekMove', uid: btn.getAttribute('data-uid'), to: btn.getAttribute('data-to') });
      });
    });
    var endPeek = peekModal.querySelector('#btn-end-peek');
    if (endPeek) endPeek.addEventListener('click', function () { act({ a: 'endPeek' }); });

    // Clicking a card inside either modal previews it.
    [modal, peekModal].forEach(function (m) {
      m.querySelectorAll('.gcard').forEach(function (el) {
        el.addEventListener('click', function (ev) {
          ev.stopPropagation();
          previewUid = el.getAttribute('data-uid');
          $('#card-preview').innerHTML = previewHtml();
        });
      });
    });
  }

  return { render: render };
})();
