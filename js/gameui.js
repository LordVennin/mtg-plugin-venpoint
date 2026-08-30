/*
 * Play surface rendering + interaction. No drag-and-drop: click a card to
 * select it, then use the buttons that appear for its zone. Double-click
 * shortcuts: hand = play, own battlefield = tap/untap.
 *
 * GameUI.render(view, sendAction) redraws the whole board from a view
 * (the host's engine view or the one received over the wire).
 */

var GameUI = (function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var selected = null; // {zone:'hand'|'battlefield'|'graveyard', uid}
  var lastView = null;
  var lastSend = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cardHtml(card, opts) {
    opts = opts || {};
    var cls = 'gcard' + (opts.tapped ? ' tapped' : '') + (opts.small ? ' small' : '');
    if (selected && selected.uid === card.uid && selected.zone === opts.zone) cls += ' selected';
    var inner;
    if (card.img) {
      inner = '<img loading="lazy" src="' + escapeHtml(card.img) + '" alt="' + escapeHtml(card.name) + '">';
    } else {
      inner = '<span class="gcard-name">' + escapeHtml(card.name) + '</span>';
    }
    var badge = opts.counters ? '<span class="counter-badge">' + opts.counters + '</span>' : '';
    return '<div class="' + cls + '" data-zone="' + (opts.zone || '') + '" data-uid="' + card.uid +
      '" data-mine="' + (opts.mine ? '1' : '0') + '" title="' + escapeHtml(card.name) + '">' +
      inner + badge + '</div>';
  }

  function zoneStrip(label, cards, zone, mine) {
    var inner = cards.length
      ? cards.map(function (c) { return cardHtml(c, { zone: mine ? zone : null, small: true, mine: mine }); }).join('')
      : '<span class="zone-empty">—</span>';
    return '<div class="zone-strip"><span class="zone-label">' + label + ' (' + cards.length + ')</span>' +
      '<div class="zone-cards">' + inner + '</div></div>';
  }

  function contextButtons() {
    if (!selected) return '';
    var b = function (act, label) {
      return '<button class="ctx" data-act="' + act + '">' + label + '</button>';
    };
    if (selected.zone === 'hand') {
      return b('play', '▶ Play') + b('discard', 'Discard');
    }
    if (selected.zone === 'battlefield') {
      return b('tap', 'Tap / Untap') + b('counter+', '+ Counter') + b('counter-', '− Counter') +
        b('to-graveyard', '→ Graveyard') + b('to-exile', '→ Exile') + b('to-hand', '→ Hand') +
        b('to-library', '→ Shuffle in');
    }
    if (selected.zone === 'graveyard') {
      return b('recover', '→ Hand');
    }
    return '';
  }

  function render(view, sendAction) {
    lastView = view;
    lastSend = sendAction;
    var me = view.you;
    var opp = view.players[0] === me ? view.players[1] : view.players[0];
    var myName = view.names[me] || 'You';
    var oppName = view.names[opp] || 'Opponent';
    var mz = view.zones[me];
    var oz = view.zones[opp];

    // Drop a selection that no longer exists (card moved zones).
    if (selected) {
      var still =
        (selected.zone === 'hand' && view.hand.some(function (c) { return c.uid === selected.uid; })) ||
        (selected.zone === 'battlefield' && mz.battlefield.some(function (e) { return e.card.uid === selected.uid; })) ||
        (selected.zone === 'graveyard' && mz.graveyard.some(function (c) { return c.uid === selected.uid; }));
      if (!still) selected = null;
    }

    var turnBadge = function (pid) {
      return view.active === pid ? '<span class="turn-badge">turn</span>' : '';
    };

    $('#game-board').innerHTML =
      // ---- opponent ----
      '<div class="player-area opp">' +
        '<div class="player-bar">' +
          '<span class="pname">' + escapeHtml(oppName) + '</span>' + turnBadge(opp) +
          '<span class="stat">♥ ' + view.life[opp] + '</span>' +
          '<span class="stat">✋ ' + oz.handCount + '</span>' +
          '<span class="stat">📚 ' + oz.libraryCount + '</span>' +
        '</div>' +
        '<div class="battlefield">' +
          (oz.battlefield.length
            ? oz.battlefield.map(function (e) {
                return cardHtml(e.card, { tapped: e.tapped, counters: e.counters, mine: false });
              }).join('')
            : '<span class="zone-empty">battlefield empty</span>') +
        '</div>' +
        '<div class="side-zones">' +
          zoneStrip('Graveyard', oz.graveyard, null, false) +
          zoneStrip('Exile', oz.exile, null, false) +
        '</div>' +
      '</div>' +

      '<div class="board-divider">Turn ' + view.turn + '</div>' +

      // ---- me ----
      '<div class="player-area mine">' +
        '<div class="side-zones">' +
          zoneStrip('Graveyard', mz.graveyard, 'graveyard', true) +
          zoneStrip('Exile', mz.exile, null, false) +
        '</div>' +
        '<div class="battlefield">' +
          (mz.battlefield.length
            ? mz.battlefield.map(function (e) {
                return cardHtml(e.card, { zone: 'battlefield', tapped: e.tapped, counters: e.counters, mine: true });
              }).join('')
            : '<span class="zone-empty">battlefield empty — play cards from your hand</span>') +
        '</div>' +
        '<div id="ctx-bar" class="ctx-bar">' + contextButtons() + '</div>' +
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
          '<button class="gact" data-act="untapAll">Untap all</button>' +
          '<button class="gact" data-act="shuffle">Shuffle</button>' +
          '<button class="gact" data-act="mulligan">Mulligan</button>' +
          '<button class="gact primary" data-act="passTurn">Pass turn</button>' +
        '</div>' +
      '</div>';

    $('#game-log').innerHTML = view.log.map(function (l) {
      return '<div class="log-line' + (l.p === me ? ' me' : '') + '">' + escapeHtml(l.text) + '</div>';
    }).join('');
    $('#game-log').scrollTop = $('#game-log').scrollHeight;

    wire();
  }

  function act(action) {
    if (lastSend) lastSend(action);
  }

  function wire() {
    var board = $('#game-board');

    board.querySelectorAll('.gcard[data-mine="1"]').forEach(function (el) {
      var zone = el.getAttribute('data-zone');
      if (!zone) return;
      var uid = el.getAttribute('data-uid');
      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (selected && selected.uid === uid && selected.zone === zone) selected = null;
        else selected = { zone: zone, uid: uid };
        render(lastView, lastSend);
      });
      el.addEventListener('dblclick', function (ev) {
        ev.stopPropagation();
        if (zone === 'hand') act({ a: 'play', uid: uid });
        else if (zone === 'battlefield') act({ a: 'tap', uid: uid });
      });
    });

    board.querySelectorAll('button.ctx').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!selected) return;
        var uid = selected.uid;
        var map = {
          'play': { a: 'play', uid: uid },
          'discard': { a: 'discard', uid: uid },
          'tap': { a: 'tap', uid: uid },
          'counter+': { a: 'counter', uid: uid, d: 1 },
          'counter-': { a: 'counter', uid: uid, d: -1 },
          'to-graveyard': { a: 'move', uid: uid, to: 'graveyard' },
          'to-exile': { a: 'move', uid: uid, to: 'exile' },
          'to-hand': { a: 'move', uid: uid, to: 'hand' },
          'to-library': { a: 'move', uid: uid, to: 'library' },
          'recover': { a: 'recover', uid: uid }
        };
        var action = map[btn.getAttribute('data-act')];
        if (action) act(action);
      });
    });

    board.querySelectorAll('button.gact').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var map = {
          'draw': { a: 'draw' },
          'untapAll': { a: 'untapAll' },
          'shuffle': { a: 'shuffle' },
          'mulligan': { a: 'mulligan' },
          'passTurn': { a: 'passTurn' },
          'life+': { a: 'life', d: 1 },
          'life-': { a: 'life', d: -1 }
        };
        var action = map[btn.getAttribute('data-act')];
        if (action) act(action);
      });
    });

    // Click empty board space clears the selection.
    board.addEventListener('click', function () {
      if (selected) { selected = null; render(lastView, lastSend); }
    });
  }

  return { render: render };
})();
