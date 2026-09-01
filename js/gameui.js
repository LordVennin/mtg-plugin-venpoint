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
  var lastClick = { uid: null, t: 0 }; // manual double-click detection
  var searchFilter = ''; // library-search filter text, kept across re-renders
  var wasSearching = false;
  var cardIndex = {};     // uid -> {card, tapped?, counters?} for preview lookups
  var lastView = null;
  var lastSend = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function indexCard(card) { cardIndex[card.uid] = card; }

  /** What a battlefield entry should look like right now (face-down / flipped). */
  function displayFor(e) {
    var c = e.card;
    if (e.faceDown) {
      if (c.facedown) return c; // opponent's stub — identity truly absent
      // Own face-down card: rendered as a back, but we know what it is.
      return { uid: c.uid, name: c.name, facedown: true, peek: true, real: c };
    }
    if (e.flipped && c.back) {
      var b = c.back;
      return {
        uid: c.uid, name: b.name, img: b.img, cost: b.cost, type: b.type,
        text: b.text, pt: b.pt, token: c.token,
        other: { name: c.name, type: c.type, text: c.text, pt: c.pt }
      };
    }
    return c;
  }

  function cardHtml(card, opts) {
    opts = opts || {};
    indexCard(card);
    var cls = 'gcard' + (opts.tapped ? ' tapped' : '') + (opts.small ? ' small' : '') +
      (opts.attachment ? ' attachment' : '') + (card.token ? ' token' : '') +
      (card.facedown ? ' facedown' : '');
    if (selected && selected.uid === card.uid && opts.mine) cls += ' selected';
    if (previewUid === card.uid) cls += ' previewed';
    var inner;
    if (card.facedown) {
      inner = '<div class="fd-back">🂠</div>' +
        (card.peek ? '<span class="fd-peek">' + escapeHtml(card.name) + '</span>' : '');
    } else if (card.img) {
      inner = '<img loading="lazy" src="' + escapeHtml(card.img) + '" alt="' + escapeHtml(card.name) + '">';
    } else {
      inner = '<span class="gcard-name">' + escapeHtml(card.name) + '</span>';
    }
    var badge = opts.counters ? '<span class="counter-badge">' + opts.counters + '</span>' : '';
    if (opts.counters2) badge += '<span class="counter-badge c2">' + opts.counters2 + '</span>';
    if (opts.counters3) badge += '<span class="counter-badge c3">' + opts.counters3 + '</span>';
    if (card.pt && !card.facedown) badge += '<span class="pt-badge">' + escapeHtml(card.pt) + '</span>';
    if (opts.note) {
      badge += '<span class="card-note" title="' + escapeHtml(opts.note) + '">' + escapeHtml(opts.note) + '</span>';
    }
    var title = card.facedown && !card.peek ? 'Face-down card' : card.name;
    return '<div class="' + cls + '" data-zone="' + (opts.zone || '') + '" data-uid="' + card.uid +
      '" data-mine="' + (opts.mine ? '1' : '0') + '" title="' + escapeHtml(title) + '"' +
      (opts.drag ? ' draggable="true"' : '') +
      (opts.style ? ' style="' + opts.style + '"' : '') + '>' + inner + badge + '</div>';
  }

  /** A permanent plus everything attached to it, as one visual stack. */
  function stackHtml(entry, attachments, mine) {
    var main = cardHtml(displayFor(entry), {
      zone: mine ? 'battlefield' : null, mine: mine, drag: mine,
      tapped: entry.tapped, counters: entry.counters,
      counters2: entry.counters2, counters3: entry.counters3, note: entry.note
    });
    if (!attachments.length) return main;
    var w = 82 + attachments.length * 20;
    var h = Math.round(82 * 7 / 5) + attachments.length * 16;
    var html = '<div class="perm-stack" style="width:' + w + 'px;height:' + h + 'px">';
    attachments.forEach(function (a, i) {
      html += '<div class="stack-slot" style="left:' + ((i + 1) * 20) + 'px;top:' + ((i + 1) * 16) + 'px;z-index:' + (5 - i) + '">' +
        cardHtml(displayFor(a.entry), {
          zone: a.mine ? 'battlefield' : null, mine: a.mine,
          tapped: a.entry.tapped, counters: a.entry.counters,
          counters2: a.entry.counters2, counters3: a.entry.counters3,
          note: a.entry.note, attachment: true
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

    var rowDiv = function (label, cells, rowKey) {
      return '<div class="bf-row"' + (mine ? ' data-row="' + rowKey + '"' : '') + '>' +
        '<span class="row-label">' + label + '</span>' +
        (cells.length ? cells.join('') : '<span class="zone-empty">—</span>') + '</div>';
    };
    var main = rowDiv('spells', rows.main, 'main');
    var lands = rowDiv('lands', rows.land, 'land');
    // Own side: spells on top, lands at the bottom (nearest your hand).
    // Opponent: mirrored, so the two spell rows face each other.
    return '<div class="battlefield">' + (mirror ? lands + main : main + lands) + '</div>';
  }

  var openPile = null; // {pid, zone} while a graveyard/exile browser is open

  /** Collapsed graveyard/exile: the top card + a count; click to browse. */
  function pileStrip(view, pid, zone) {
    var cards = view.zones[pid][zone];
    var top = cards.length ? cards[cards.length - 1] : null;
    var label = zone === 'graveyard' ? 'Graveyard' : 'Exile';
    var inner = top
      ? cardHtml(top, { small: true, mine: false })
      : '<span class="zone-empty">—</span>';
    return '<div class="zone-strip pile" data-pile="' + pid + ':' + zone +
      '" title="Click to browse the ' + label.toLowerCase() + '">' +
      '<span class="zone-label">' + label + ' (' + cards.length + ')</span>' +
      '<div class="zone-cards">' + inner + '</div></div>';
  }

  function pileModalHtml(view) {
    if (!openPile) return '';
    var pid = openPile.pid, zone = openPile.zone;
    if (!view.zones[pid]) { openPile = null; return ''; }
    var cards = view.zones[pid][zone];
    var mine = pid === view.you;
    var who = mine ? 'Your' : escapeHtml(view.names[pid] || pid) + '’s';
    return '<div class="search-inner">' +
      '<h3>' + who + ' ' + zone + ' (' + cards.length + ')</h3>' +
      '<p class="hint">Newest on top' + (mine ? '' : ' — public information') + '. Click a card to read it.</p>' +
      '<div class="search-grid">' +
      cards.slice().reverse().map(function (c) {
        indexCard(c);
        var btns = '';
        if (mine) {
          btns = '<div class="search-btns">' +
            '<button class="pile-act" data-uid="' + c.uid + '" data-op="hand">Hand</button>' +
            '<button class="pile-act" data-uid="' + c.uid + '" data-op="field">Field</button>' +
            '<button class="pile-act" data-uid="' + c.uid + '" data-op="cross">' +
              (zone === 'graveyard' ? 'Exile' : 'Yard') + '</button>' +
          '</div><div class="search-btns">' +
            '<button class="pile-act" data-uid="' + c.uid + '" data-op="top">Top</button>' +
            '<button class="pile-act" data-uid="' + c.uid + '" data-op="bottom">Bottom</button>' +
            '<button class="pile-act" data-uid="' + c.uid + '" data-op="shuffle">Shuffle</button>' +
            (c.commander ? '<button class="pile-act" data-uid="' + c.uid + '" data-op="cmd">Command</button>' : '') +
          '</div>';
        }
        return '<div class="search-item">' + cardHtml(c, { mine: false }) +
          '<div class="search-item-name">' + escapeHtml(c.name) + '</div>' + btns + '</div>';
      }).join('') +
      '</div>' +
      '<div class="search-footer"><button id="btn-close-pile" class="primary">Close</button></div>' +
    '</div>';
  }

  function zoneStrip(label, cards, zone, mine) {
    var inner = cards.length
      ? cards.map(function (c) { return cardHtml(c, { zone: mine ? zone : null, small: true, mine: mine }); }).join('')
      : '<span class="zone-empty">—</span>';
    return '<div class="zone-strip"><span class="zone-label">' + label + ' (' + cards.length + ')</span>' +
      '<div class="zone-cards">' + inner + '</div></div>';
  }

  function contextButtons(view, full) {
    if (attachMode) {
      return '<span class="attach-hint">Attaching <strong>' + escapeHtml(attachMode.name) +
        '</strong> — click a card on the battlefield (or empty space to cancel)</span>';
    }
    if (!selected) return '';
    var b = function (act, label) {
      return '<button class="ctx" data-act="' + act + '">' + label + '</button>';
    };
    if (selected.zone === 'hand') {
      return b('play', '▶ Play') + b('playfd', '🂠 Play face down') + b('discard', 'Discard') +
        b('hand-top', '⤒ Library top') + b('hand-bot', '⤓ Library bottom') +
        (view.bottoming > 0 ? b('bottom', '⤓ Bottom (mulligan)') : '') +
        (isCommanderCard(view, 'hand', selected.uid) ? b('hand-cmd', '→ Command zone') : '');
    }
    if (selected.zone === 'battlefield') {
      if (!full) {
        return '<span class="ctx-hint">Right-click the card for actions · double-click taps</span>';
      }
      var entry = null;
      view.zones[view.you].battlefield.forEach(function (e) {
        if (e.card.uid === selected.uid) entry = e;
      });
      var fdBtn = entry && entry.faceDown ? b('facedown', '⤴ Turn face up') : b('facedown', '🂠 Face down');
      var trBtn = (entry && entry.card.back && !entry.faceDown)
        ? b('transform', entry.flipped ? '⟳ Transform back' : '⟳ Transform')
        : '';
      return b('tap', 'Tap / Untap') + trBtn + fdBtn +
        (entry && entry.attachedTo ? b('detach', 'Detach') : b('attach', '🔗 Attach to…')) +
        b('note', '📝 Note') + b('clone', '⧉ Copy') +
        b('counter+', '+ ⬤') + b('counter-', '− ⬤') +
        b('counter2+', '+ 🔴') + b('counter2-', '− 🔴') +
        b('counter3+', '+ 🔵') + b('counter3-', '− 🔵') +
        b('row', '⇅ Row') +
        (entry && entry.card.tokens && entry.card.tokens.length ? b('make-token', '✨ Create its token') : '') +
        b('to-graveyard', '→ Graveyard') + b('to-exile', '→ Exile') + b('to-hand', '→ Hand') +
        b('to-library', '→ Shuffle in') +
        b('bf-top', '⤒ Library top') + b('bf-bot', '⤓ Library bottom') +
        (entry && entry.card.commander ? b('bf-cmd', '→ Command zone') : '');
    }
    if (selected.zone === 'graveyard') {
      return b('gy-hand', '→ Hand') + b('gy-field', '→ Battlefield') +
        b('gy-exile', '→ Exile') + b('gy-lib', '→ Shuffle in') +
        (isCommanderCard(view, 'graveyard', selected.uid) ? b('gy-cmd', '→ Command zone') : '');
    }
    if (selected.zone === 'exile') {
      return b('ex-hand', '→ Hand') + b('ex-field', '→ Battlefield') +
        b('ex-gy', '→ Graveyard') + b('ex-lib', '→ Shuffle in') +
        (isCommanderCard(view, 'exile', selected.uid) ? b('ex-cmd', '→ Command zone') : '');
    }
    if (selected.zone === 'command') {
      return b('cast-cmd', '⚔ Cast');
    }
    return '';
  }

  /** Is the selected card in the given own zone flagged as a commander? */
  function isCommanderCard(view, zone, uid) {
    if (!view.you) return false;
    var z = view.zones[view.you];
    var list = zone === 'hand' ? view.hand
      : zone === 'battlefield' ? z.battlefield.map(function (e) { return e.card; })
      : z[zone];
    var card = (list || []).find(function (c) { return c.uid === uid; });
    return !!(card && card.commander);
  }

  function faceSection(label, f) {
    return '<div class="preview-otherface"><div class="preview-name">' + label +
      ': ' + escapeHtml(f.name) +
      (f.pt ? ' <span class="preview-pt">' + escapeHtml(f.pt) + '</span>' : '') + '</div>' +
      (f.type ? '<div class="preview-type">' + escapeHtml(f.type) + '</div>' : '') +
      (f.text ? '<div class="preview-oracle">' + escapeHtml(f.text).replace(/\n/g, '<br>') + '</div>' : '') +
      '</div>';
  }

  function previewHtml() {
    var card = previewUid && cardIndex[previewUid];
    if (!card) {
      return '<div class="preview-empty">Click any card to read it here</div>';
    }
    if (card.facedown && !card.real) {
      return '<div class="preview-text preview-fd">🂠</div>' +
        '<div class="preview-meta"><div class="preview-name">Face-down card</div>' +
        '<div class="preview-type">Only its owner knows what this is.</div></div>';
    }
    var note = '';
    if (card.facedown && card.real) {
      note = '<div class="preview-fdnote">Face down — only you can see this.</div>';
      card = card.real;
    }
    var body = card.img
      ? '<img src="' + escapeHtml(card.img) + '" alt="' + escapeHtml(card.name) + '">'
      : '<div class="preview-text"><strong>' + escapeHtml(card.name) + '</strong></div>';
    return body + note +
      '<div class="preview-meta">' +
        '<div class="preview-name">' + escapeHtml(card.name) +
          (card.pt ? ' <span class="preview-pt">' + escapeHtml(card.pt) + '</span>' : '') + '</div>' +
        (card.cost ? '<div class="preview-cost">' + escapeHtml(card.cost) + '</div>' : '') +
        (card.type ? '<div class="preview-type">' + escapeHtml(card.type) + '</div>' : '') +
        (card.text ? '<div class="preview-oracle">' + escapeHtml(card.text).replace(/\n/g, '<br>') + '</div>' : '') +
        (card.back ? faceSection('Back face', card.back) : '') +
        (card.other ? faceSection('Front face', card.other) : '') +
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
            '<button class="peek-take" data-uid="' + c.uid + '" data-to="manifest" title="battlefield, face down">Manifest</button>' +
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
      '<input id="search-filter" class="search-filter" placeholder="🔍 Filter by name, type, or text…" autocomplete="off">' +
      '<div class="search-grid">' +
      view.library.map(function (c) {
        indexCard(c);
        var hay = (c.name + ' ' + (c.type || '') + ' ' + (c.text || '')).toLowerCase();
        return '<div class="search-item" data-hay="' + escapeHtml(hay) + '">' +
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

  /** Chips showing a player's named counters (poison, energy, ...). */
  function pcounterChips(view, pid, mine) {
    var pcs = (view.pcounters && view.pcounters[pid]) || {};
    return Object.keys(pcs).map(function (n) {
      return '<span class="pchip">☠ ' + escapeHtml(n) + ' ' + pcs[n] +
        (mine
          ? ' <button class="pchip-btn" data-pc="' + escapeHtml(n) + '" data-d="-1">−</button>' +
            '<button class="pchip-btn" data-pc="' + escapeHtml(n) + '" data-d="1">+</button>'
          : '') +
        '</span>';
    }).join('');
  }

  /** One non-me player's area (also used for every player when spectating). */
  function otherAreaHtml(view, pid, compact) {
    var z = view.zones[pid];
    var activeCls = view.active === pid ? ' active-turn' : '';
    var badge = view.active === pid ? '<span class="turn-badge">turn</span>' : '';
    var showCmd = view.commander || z.command.length > 0;
    return '<div class="player-area opp' + activeCls + (compact ? ' compact' : '') + '">' +
      '<div class="player-bar">' +
        '<span class="pname">' + escapeHtml(view.names[pid] || pid) + '</span>' + badge +
        '<span class="stat">♥ ' + view.life[pid] + '</span>' +
        '<span class="stat">✋ ' + z.handCount + '</span>' +
        '<span class="stat">📚 ' + z.libraryCount + '</span>' +
        pcounterChips(view, pid, false) +
      '</div>' +
      battlefieldHtml(view, pid, false, true) +
      '<div class="side-zones">' +
        (showCmd ? zoneStrip('Command', z.command, null, false) : '') +
        pileStrip(view, pid, 'graveyard') +
        pileStrip(view, pid, 'exile') +
      '</div>' +
    '</div>';
  }

  function render(view, sendAction) {
    lastView = view;
    lastSend = sendAction;
    cardIndex = {};
    closeCardMenu();
    installHotkeys();
    var me = view.you; // null when spectating
    var others = view.players.filter(function (id) { return id !== me; });
    var mz = me ? view.zones[me] : null;

    // Drop stale selection / attach mode (card may have changed zones).
    var onMyBf = function (uid) {
      return !!mz && mz.battlefield.some(function (e) { return e.card.uid === uid; });
    };
    if (selected && me) {
      var still =
        (selected.zone === 'hand' && view.hand.some(function (c) { return c.uid === selected.uid; })) ||
        (selected.zone === 'battlefield' && onMyBf(selected.uid)) ||
        (selected.zone === 'graveyard' && mz.graveyard.some(function (c) { return c.uid === selected.uid; })) ||
        (selected.zone === 'exile' && mz.exile.some(function (c) { return c.uid === selected.uid; })) ||
        (selected.zone === 'command' && mz.command.some(function (c) { return c.uid === selected.uid; }));
      if (!still) selected = null;
    } else {
      selected = null;
    }
    if (attachMode && !onMyBf(attachMode.uid)) attachMode = null;

    var turnBadge = function (pid) {
      return view.active === pid ? '<span class="turn-badge">turn</span>' : '';
    };
    var activeCls = function (pid) { return view.active === pid ? ' active-turn' : ''; };
    // 3+ people on screen -> 2-column table grid (2 top / rest below,
    // your own board bottom-right); 1v1 keeps the classic stacked layout.
    var gridMode = others.length >= (me ? 2 : 3);

    var myCell = '';
    var myBench = '';
    if (me) {
      var showCmd = view.commander || mz.command.length > 0;
      var zonesHtml =
        '<div class="side-zones">' +
          (showCmd ? zoneStrip('Command', mz.command, 'command', true) : '') +
          pileStrip(view, me, 'graveyard') +
          pileStrip(view, me, 'exile') +
        '</div>';
      var benchInner =
        '<div id="ctx-bar" class="ctx-bar">' + contextButtons(view) + '</div>' +
        (view.bottoming > 0
          ? '<div class="bottoming-banner">Mulligan: put ' + view.bottoming + ' card' +
            (view.bottoming === 1 ? '' : 's') + ' on the bottom — select a hand card, then "⤓ Bottom of library".</div>'
          : '') +
        '<div class="hand">' +
          view.hand.map(function (c) { return cardHtml(c, { zone: 'hand', mine: true, drag: true }); }).join('') +
          (view.hand.length ? '' : '<span class="zone-empty">hand empty</span>') +
        '</div>' +
        '<div class="player-bar">' +
          '<span class="pname">' + escapeHtml(view.names[me] || 'You') + '</span>' + turnBadge(me) +
          '<span class="stat">📚 ' + mz.libraryCount + '</span>' +
          '<button class="gact" data-act="life-">−</button>' +
          '<span class="stat">♥ ' + view.life[me] + '</span>' +
          '<button class="gact" data-act="life+">+</button>' +
          pcounterChips(view, me, true) +
          '<button class="gact" data-act="draw" title="hotkey: d">Draw</button>' +
          '<button class="gact" data-act="search" title="hotkey: s">🔍 Search</button>' +
          '<button class="gact" data-act="untapAll" title="hotkey: u">Untap all</button>' +
          '<button class="gact" data-act="shuffle">Shuffle</button>' +
          '<button class="gact" data-act="mulligan">Mulligan</button>' +
          '<button class="gact" data-act="scry" title="hotkey: e">👁 Scry</button>' +
          '<button class="gact" data-act="token" title="hotkey: k">➕ Token</button>' +
          '<button class="gact" data-act="pcounter" title="poison, energy, …">☠ Counter</button>' +
          '<button class="gact" data-act="d6">🎲 d6</button>' +
          '<button class="gact" data-act="d20">🎲 d20</button>' +
          '<button class="gact" data-act="coin">🪙 Flip</button>' +
          '<button class="gact primary" data-act="passTurn">Pass turn</button>' +
        '</div>';
      if (gridMode) {
        myCell =
          '<div class="player-area mine' + activeCls(me) + '">' +
            '<div class="player-bar"><span class="pname">' + escapeHtml(view.names[me] || 'You') + '</span>' +
              turnBadge(me) +
              '<span class="stat">♥ ' + view.life[me] + '</span>' +
              '<span class="stat">📚 ' + mz.libraryCount + '</span>' +
              pcounterChips(view, me, true) + '</div>' +
            battlefieldHtml(view, me, true, false) +
            zonesHtml +
          '</div>';
        myBench = '<div class="my-bench">' + benchInner + '</div>';
      } else {
        myCell =
          '<div class="player-area mine' + activeCls(me) + '">' +
            zonesHtml + battlefieldHtml(view, me, true, false) + benchInner +
          '</div>';
      }
    }

    var othersHtml = others.map(function (pid) { return otherAreaHtml(view, pid, gridMode); }).join('');
    var html;
    if (gridMode) {
      html = '<div class="board-divider">Turn ' + view.turn + '</div>' +
        '<div class="board-grid">' + othersHtml + myCell + '</div>' + myBench;
    } else {
      html = othersHtml + '<div class="board-divider">Turn ' + view.turn + '</div>' + myCell;
    }
    $('#game-board').innerHTML = html;

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

    var zoneModal = $('#zone-modal');
    zoneModal.innerHTML = pileModalHtml(view);
    zoneModal.hidden = !openPile;

    wire();
  }

  function act(action) {
    if (lastSend) lastSend(action);
  }

  function rerender() { render(lastView, lastSend); }

  /* -------- shared card-action dispatch (inline bar + right-click menu) -------- */

  function performCtxAction(kind) {
    if (!selected) return;
    var uid = selected.uid;
    if (kind === 'attach') {
      var card = cardIndex[uid];
      attachMode = { uid: uid, name: card ? card.name : 'card' };
      selected = null;
      rerender();
      return;
    }
    if (kind === 'note') {
      var entry = null;
      if (lastView && lastView.you) {
        lastView.zones[lastView.you].battlefield.forEach(function (e) {
          if (e.card.uid === uid) entry = e;
        });
      }
      var text = window.prompt('Note for this card (empty clears it):', entry ? entry.note || '' : '');
      if (text === null) return;
      act({ a: 'note', uid: uid, text: text });
      return;
    }
    if (kind === 'make-token') {
      var tEntry = null;
      if (lastView && lastView.you) {
        lastView.zones[lastView.you].battlefield.forEach(function (e) {
          if (e.card.uid === uid) tEntry = e;
        });
      }
      var toks = (tEntry && tEntry.card.tokens) || [];
      if (!toks.length) return;
      var chosen = toks[0];
      if (toks.length > 1) {
        var listing = toks.map(function (t, i) { return (i + 1) + ': ' + t.name; }).join('\n');
        var pick = parseInt(window.prompt('Which token?\n' + listing, '1'), 10);
        if (!pick || pick < 1 || pick > toks.length) return;
        chosen = toks[pick - 1];
      }
      Scryfall.fetchToken(chosen.id)
        .then(function (tok) { act({ a: 'tokenFrom', card: tok }); })
        .catch(function () { act({ a: 'tokenFrom', card: { name: chosen.name } }); });
      return;
    }
    var map = {
      'play': { a: 'play', uid: uid },
      'discard': { a: 'discard', uid: uid },
      'hand-top': { a: 'toLib', from: 'hand', uid: uid, pos: 'top' },
      'hand-bot': { a: 'toLib', from: 'hand', uid: uid, pos: 'bottom' },
      'bf-top': { a: 'toLib', from: 'battlefield', uid: uid, pos: 'top' },
      'bf-bot': { a: 'toLib', from: 'battlefield', uid: uid, pos: 'bottom' },
      'tap': { a: 'tap', uid: uid },
      'detach': { a: 'detach', uid: uid },
      'row': { a: 'row', uid: uid },
      'clone': { a: 'clone', uid: uid },
      'counter+': { a: 'counter', uid: uid, d: 1, kind: 1 },
      'counter-': { a: 'counter', uid: uid, d: -1, kind: 1 },
      'counter2+': { a: 'counter', uid: uid, d: 1, kind: 2 },
      'counter2-': { a: 'counter', uid: uid, d: -1, kind: 2 },
      'counter3+': { a: 'counter', uid: uid, d: 1, kind: 3 },
      'counter3-': { a: 'counter', uid: uid, d: -1, kind: 3 },
      'to-graveyard': { a: 'move', uid: uid, to: 'graveyard' },
      'to-exile': { a: 'move', uid: uid, to: 'exile' },
      'to-hand': { a: 'move', uid: uid, to: 'hand' },
      'to-library': { a: 'move', uid: uid, to: 'library' },
      'playfd': { a: 'playFaceDown', uid: uid },
      'facedown': { a: 'faceDown', uid: uid },
      'transform': { a: 'transform', uid: uid },
      'bottom': { a: 'bottomCard', uid: uid },
      'gy-hand': { a: 'zoneMove', from: 'graveyard', uid: uid, to: 'hand' },
      'gy-field': { a: 'zoneMove', from: 'graveyard', uid: uid, to: 'battlefield' },
      'gy-exile': { a: 'zoneMove', from: 'graveyard', uid: uid, to: 'exile' },
      'gy-lib': { a: 'zoneMove', from: 'graveyard', uid: uid, to: 'library' },
      'ex-hand': { a: 'zoneMove', from: 'exile', uid: uid, to: 'hand' },
      'ex-field': { a: 'zoneMove', from: 'exile', uid: uid, to: 'battlefield' },
      'ex-gy': { a: 'zoneMove', from: 'exile', uid: uid, to: 'graveyard' },
      'ex-lib': { a: 'zoneMove', from: 'exile', uid: uid, to: 'library' },
      'cast-cmd': { a: 'castCommander', uid: uid },
      'bf-cmd': { a: 'toCommand', uid: uid, from: 'battlefield' },
      'hand-cmd': { a: 'toCommand', uid: uid, from: 'hand' },
      'gy-cmd': { a: 'toCommand', uid: uid, from: 'graveyard' },
      'ex-cmd': { a: 'toCommand', uid: uid, from: 'exile' }
    };
    if (map[kind]) act(map[kind]);
  }

  /* -------- floating right-click menu -------- */

  var menuEl = null;
  function closeCardMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }

  function openCardMenu(x, y) {
    closeCardMenu();
    if (!lastView || !selected) return;
    menuEl = document.createElement('div');
    menuEl.className = 'card-menu';
    menuEl.innerHTML = contextButtons(lastView, true);
    document.body.appendChild(menuEl);
    var mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 8)) + 'px';
    menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 8)) + 'px';
    menuEl.addEventListener('click', function (ev) { ev.stopPropagation(); });
    menuEl.querySelectorAll('button.ctx').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-act');
        closeCardMenu();
        performCtxAction(kind);
      });
    });
  }
  document.addEventListener('click', closeCardMenu);

  /* -------- shared prompt flows + hotkeys -------- */

  function promptScry() {
    var sn = parseInt(window.prompt('Look at how many cards from the top of your library?', '3'), 10);
    if (!sn || sn < 1) return;
    act({ a: 'peek', n: Math.min(sn, 20) });
  }

  function promptToken() {
    var input = window.prompt('Token to create — a name, or a count + name (e.g. "Goblin" or "3 Treasure"):', '');
    if (!input || !input.trim()) return;
    var tm = input.trim().match(/^(\d+)\s*x?\s+(.+)$/i);
    if (tm) act({ a: 'token', name: tm[2], count: parseInt(tm[1], 10) });
    else act({ a: 'token', name: input.trim(), count: 1 });
  }

  function promptPlayerCounter() {
    var name = window.prompt('Player counter to add (poison, energy, experience…):', 'poison');
    if (!name || !name.trim()) return;
    act({ a: 'pcounter', name: name.trim(), d: 1 });
  }

  var hotkeysInstalled = false;
  function installHotkeys() {
    if (hotkeysInstalled) return;
    hotkeysInstalled = true;
    document.addEventListener('keydown', function (ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      var screen = document.getElementById('screen-game');
      if (!screen || screen.hidden) return;
      if (!lastView || !lastView.you) return; // spectators have no hotkeys
      var k = ev.key.toLowerCase();
      if (k === 'escape') {
        selected = null; attachMode = null; openPile = null; closeCardMenu(); rerender();
        return;
      }
      if (k === 't' && selected && selected.zone === 'battlefield') {
        act({ a: 'tap', uid: selected.uid });
        return;
      }
      var simple = {
        u: { a: 'untapAll' },
        d: { a: 'draw' },
        s: { a: 'searchLibrary' },
        c: { a: 'coin' },
        r: { a: 'roll', sides: 20 }
      };
      if (simple[k]) { act(simple[k]); return; }
      if (k === 'e') promptScry();
      else if (k === 'k') promptToken();
    });
  }

  function wire() {
    var board = $('#game-board');

    board.querySelectorAll('.gcard').forEach(function (el) {
      var uid = el.getAttribute('data-uid');
      var zone = el.getAttribute('data-zone');
      var mine = el.getAttribute('data-mine') === '1';

      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeCardMenu();
        if (attachMode) {
          if (uid !== attachMode.uid) act({ a: 'attach', uid: attachMode.uid, target: uid });
          attachMode = null;
          rerender();
          return;
        }
        // Manual double-click detection: native dblclick is unreliable on
        // draggable elements in Firefox (the drag machinery eats it).
        var now = Date.now();
        var isDouble = lastClick.uid === uid && (now - lastClick.t) < 400;
        lastClick = { uid: uid, t: now };
        if (isDouble && mine && zone === 'hand') { act({ a: 'play', uid: uid }); return; }
        if (isDouble && mine && zone === 'battlefield') { act({ a: 'tap', uid: uid }); return; }
        previewUid = uid;
        if (mine && zone) {
          if (selected && selected.uid === uid && selected.zone === zone) selected = null;
          else selected = { zone: zone, uid: uid };
        }
        rerender();
      });
      if (mine && zone) {
        el.addEventListener('contextmenu', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          attachMode = null;
          selected = { zone: zone, uid: uid };
          previewUid = uid;
          rerender();
          openCardMenu(ev.clientX, ev.clientY);
        });
      }
    });

    board.querySelectorAll('button.ctx').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        performCtxAction(btn.getAttribute('data-act'));
      });
    });

    board.querySelectorAll('button.gact').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var kind = btn.getAttribute('data-act');
        if (kind === 'token') { promptToken(); return; }
        if (kind === 'scry') { promptScry(); return; }
        if (kind === 'pcounter') { promptPlayerCounter(); return; }
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

    // Drag to rearrange your own battlefield (reorder within a row, or move
    // between the spells/lands rows) and your hand. Drops before the card
    // you land on.
    var dragUid = null;
    var dragZone = null;
    board.querySelectorAll('.gcard[data-mine="1"][draggable="true"]').forEach(function (el) {
      el.addEventListener('dragstart', function (ev) {
        dragUid = el.getAttribute('data-uid');
        dragZone = el.getAttribute('data-zone');
        try {
          ev.dataTransfer.setData('text/plain', dragUid);
          ev.dataTransfer.effectAllowed = 'move';
        } catch (e) { /* some browsers are picky mid-testing */ }
      });
    });
    function dropTargetBefore(ev, uid) {
      var targetCard = ev.target && ev.target.closest ? ev.target.closest('.gcard') : null;
      return (targetCard && targetCard.getAttribute('data-uid') !== uid)
        ? targetCard.getAttribute('data-uid')
        : null;
    }
    board.querySelectorAll('.player-area.mine .bf-row[data-row]').forEach(function (row) {
      row.addEventListener('dragover', function (ev) {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      });
      row.addEventListener('drop', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var uid = dragUid || (ev.dataTransfer && ev.dataTransfer.getData('text/plain'));
        if (!uid || dragZone !== 'battlefield') { dragUid = null; return; }
        dragUid = null;
        act({ a: 'reorder', uid: uid, row: row.getAttribute('data-row'), before: dropTargetBefore(ev, uid) });
      });
    });
    var handEl = board.querySelector('.hand');
    if (handEl) {
      handEl.addEventListener('dragover', function (ev) {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      });
      handEl.addEventListener('drop', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var uid = dragUid || (ev.dataTransfer && ev.dataTransfer.getData('text/plain'));
        if (!uid || dragZone !== 'hand') { dragUid = null; return; }
        dragUid = null;
        act({ a: 'handOrder', uid: uid, before: dropTargetBefore(ev, uid) });
      });
    }

    // Graveyard/exile piles: click opens the zone browser.
    board.querySelectorAll('.zone-strip.pile').forEach(function (strip) {
      strip.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var parts = strip.getAttribute('data-pile').split(':');
        openPile = { pid: parts[0], zone: parts[1] };
        rerender();
      });
    });

    // Player-counter chips (own bar has ± buttons)
    board.querySelectorAll('button.pchip-btn').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        act({ a: 'pcounter', name: btn.getAttribute('data-pc'), d: parseInt(btn.getAttribute('data-d'), 10) });
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
    var filter = modal.querySelector('#search-filter');
    if (filter) {
      var applyFilter = function () {
        var q = searchFilter.trim().toLowerCase();
        modal.querySelectorAll('.search-item').forEach(function (item) {
          item.style.display = (!q || item.getAttribute('data-hay').indexOf(q) !== -1) ? '' : 'none';
        });
      };
      filter.value = searchFilter;
      applyFilter();
      filter.addEventListener('input', function () {
        searchFilter = filter.value;
        applyFilter();
      });
      if (!wasSearching) { searchFilter = ''; filter.value = ''; filter.focus(); }
      wasSearching = true;
    } else {
      wasSearching = false;
      searchFilter = '';
    }

    var peekModal = $('#peek-modal');
    peekModal.querySelectorAll('button.peek-take').forEach(function (btn) {
      btn.addEventListener('click', function () {
        act({ a: 'peekMove', uid: btn.getAttribute('data-uid'), to: btn.getAttribute('data-to') });
      });
    });
    var endPeek = peekModal.querySelector('#btn-end-peek');
    if (endPeek) endPeek.addEventListener('click', function () { act({ a: 'endPeek' }); });

    var zoneModal = $('#zone-modal');
    zoneModal.querySelectorAll('button.pile-act').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!openPile) return;
        var uid = btn.getAttribute('data-uid');
        var zone = openPile.zone;
        var other = zone === 'graveyard' ? 'exile' : 'graveyard';
        var ops = {
          hand: { a: 'zoneMove', from: zone, uid: uid, to: 'hand' },
          field: { a: 'zoneMove', from: zone, uid: uid, to: 'battlefield' },
          cross: { a: 'zoneMove', from: zone, uid: uid, to: other },
          shuffle: { a: 'zoneMove', from: zone, uid: uid, to: 'library' },
          top: { a: 'toLib', from: zone, uid: uid, pos: 'top' },
          bottom: { a: 'toLib', from: zone, uid: uid, pos: 'bottom' },
          cmd: { a: 'toCommand', uid: uid, from: zone }
        };
        var op = ops[btn.getAttribute('data-op')];
        if (op) act(op);
      });
    });
    var closePile = zoneModal.querySelector('#btn-close-pile');
    if (closePile) closePile.addEventListener('click', function () { openPile = null; rerender(); });

    // Clicking a card inside any modal previews it.
    [modal, peekModal, zoneModal].forEach(function (m) {
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
