/*
 * 1v1 play surface engine — pure state machine, no DOM, no network.
 *
 * Cockatrice-style honor-system simulation: the engine enforces zone
 * mechanics (what moves where, whose cards you can touch, hidden hands),
 * not the rules of Magic. The host runs it; players see views.
 *
 * Zones per player: library (hidden, count only), hand (owner only),
 * battlefield / graveyard / exile (public).
 *
 * Actions (via apply(playerId, action)):
 *   {a:'draw'}                       top of library -> hand
 *   {a:'shuffle'}                    shuffle library
 *   {a:'mulligan'}                   London mulligan: hand -> library, shuffle,
 *                                    draw 7, then owe (mulligan count) cards to
 *                                    the bottom via bottomCard
 *   {a:'bottomCard', uid}            put a hand card on the bottom (owed after mulligan)
 *   {a:'zoneMove', from, uid, to}    graveyard/exile card -> 'hand'|'battlefield'|
 *                                    'graveyard'|'exile'|'library' (shuffled in)
 *   {a:'life', d:+1|-1|...}          adjust own life
 *   {a:'play', uid}                  hand -> battlefield
 *   {a:'discard', uid}               hand -> graveyard
 *   {a:'tap', uid}                   toggle tapped on own battlefield card
 *   {a:'untapAll'}                   untap all own battlefield cards
 *   {a:'counter', uid, d:+1|-1, kind:1|2|3}  adjust one of three counter types
 *   {a:'note', uid, text}            annotate own battlefield card ('' clears)
 *   {a:'clone', uid}                 copy own battlefield card (copies are tokens)
 *   {a:'handOrder', uid, before}     rearrange own hand (cosmetic, silent)
 *   {a:'pcounter', name, d}          adjust own named player counter (poison, energy...)
 *   {a:'toLib', from, uid, pos}      put a card on 'top'|'bottom' of the library from
 *                                    'hand' (nameless) | 'battlefield'|'graveyard'|'exile'
 *   {a:'tokenFrom', card}            create a token from resolved card data (art, p/t)
 *   {a:'move', uid, to}              own battlefield card -> 'graveyard'|'exile'|'hand'|'library'
 *   {a:'recover', uid}               own graveyard card -> hand
 *   {a:'passTurn'}                   pass the turn marker (no auto-untap/draw)
 *   {a:'roll', sides}                roll a die (host RNG, publicly logged)
 *   {a:'coin'}                       flip a coin (host RNG, publicly logged)
 *   {a:'row', uid}                   toggle a permanent between the land/main rows
 *   {a:'reorder', uid, row, before}  drag-arrange: move a permanent to `row`
 *                                    ('main'|'land'), before card `before`
 *                                    (or to the end when before is null)
 *   {a:'attach', uid, target}        attach own permanent to any unattached permanent
 *   {a:'detach', uid}                detach own permanent
 *   {a:'searchLibrary'}              start searching (library revealed to owner only)
 *   {a:'takeFromLibrary', uid, to}   while searching: -> 'hand'|'battlefield'|'graveyard'
 *   {a:'endSearch'}                  stop searching; library is shuffled
 *   {a:'token', name, count}         create token permanent(s); tokens cease to
 *                                    exist when they leave the battlefield
 *   {a:'playFaceDown', uid}          play a hand card face down (morph/manifest);
 *                                    the opponent's view never receives its identity
 *   {a:'faceDown', uid}              turn a battlefield card face down / face up
 *   {a:'transform', uid}             flip a double-faced card to its other face
 *   {a:'peek', n}                    scry-style look at the top n cards (owner only)
 *   {a:'peekMove', uid, to}          while peeking: -> 'top'|'bottom'|'hand'|
 *                                    'battlefield'|'graveyard'
 *   {a:'endPeek'}                    stop looking (library is NOT shuffled)
 */

var MTGGame = (function () {
  'use strict';

  function shuffle(arr, rng) {
    rng = rng || Math.random;
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  var uidCounter = 0;

  var BASIC_LAND = /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/i;
  function isLand(card) {
    if (card.type) return /\bLand\b/i.test(card.type);
    return BASIC_LAND.test(card.name); // unresolved cards: recognize basics by name
  }

  function permanent(card) {
    return {
      card: card, tapped: false, counters: 0, counters2: 0, counters3: 0,
      row: isLand(card) ? 'land' : 'main',
      attachedTo: null, faceDown: false, flipped: false, note: ''
    };
  }

  var COUNTER_LABEL = { 1: '', 2: 'red ', 3: 'blue ' };

  /**
   * playerIds: [id, ...] (2-8)  decks: {id: [card,...]}  names: {id: displayName}
   * opts.commander: command zone + 40 life; cards flagged {commander:true}
   * start in their owner's command zone instead of the library.
   */
  function Game(playerIds, decks, names, opts) {
    opts = opts || {};
    if (playerIds.length < 2 || playerIds.length > 8) {
      throw new Error('The play surface needs 2-8 players');
    }
    this.players = playerIds.slice();
    this.names = names || {};
    this.rng = opts.rng || Math.random;
    this.commander = !!opts.commander;

    this.life = {};
    this.zones = {};
    this.turn = 1;
    this.active = this.players[0];
    this.log = [];
    this.searching = {};
    this.peeking = {}; // pid -> how many top-of-library cards are revealed to them
    this.mulligans = {}; // pid -> mulligans taken
    this.bottoming = {}; // pid -> cards still owed to the bottom after a mulligan
    this.commanderCasts = {}; // card uid -> times cast from the command zone
    this.pcounters = {}; // pid -> {counterName: count} (poison, energy, ...)

    var startLife = opts.startLife || (this.commander ? 40 : 20);
    this.players.forEach(function (id) {
      var command = [];
      var deck = [];
      ((decks[id]) || []).forEach(function (c) {
        var card = Object.assign({}, c);
        if (!card.uid) card.uid = 'g' + (++uidCounter);
        if (card.commander) command.push(card);
        else deck.push(card);
      });
      this.life[id] = startLife;
      this.zones[id] = {
        library: shuffle(deck, this.rng),
        hand: [],
        battlefield: [], // entries: {card, tapped, counters, row, attachedTo, faceDown, flipped}
        graveyard: [],
        exile: [],
        command: command
      };
    }, this);

    this.players.forEach(function (id) { this._draw(id, 7); }, this);
    this._log(null, 'Game started at ' + startLife + ' life — everyone draws 7. ' +
      this.name(this.active) + ' goes first.');
  }

  Game.prototype.name = function (id) { return this.names[id] || id; };

  Game.prototype._log = function (pid, text) {
    this.log.push({ p: pid, text: text });
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
  };

  Game.prototype._zonesOf = function (pid) {
    var z = this.zones[pid];
    if (!z) throw new Error('Unknown player');
    return z;
  };

  Game.prototype._draw = function (pid, n) {
    var z = this._zonesOf(pid);
    var drawn = 0;
    while (drawn < n && z.library.length) {
      z.hand.push(z.library.shift());
      drawn++;
    }
    return drawn;
  };

  function takeByUid(arr, uid, getUid) {
    for (var i = 0; i < arr.length; i++) {
      if (getUid(arr[i]) === uid) return arr.splice(i, 1)[0];
    }
    return null;
  }

  Game.prototype.apply = function (pid, action) {
    var z = this._zonesOf(pid);
    var me = this.name(pid);
    switch (action && action.a) {
      case 'draw': {
        var got = this._draw(pid, 1);
        this._log(pid, got ? me + ' draws a card.' : me + ' tries to draw from an empty library!');
        break;
      }
      case 'shuffle': {
        z.library = shuffle(z.library, this.rng);
        this._log(pid, me + ' shuffles their library.');
        break;
      }
      case 'mulligan': {
        // London mulligan: always draw 7, then bottom as many cards as
        // mulligans taken. Any bottoming still owed carries over.
        var mullCount = (this.mulligans[pid] = (this.mulligans[pid] | 0) + 1);
        z.library = shuffle(z.library.concat(z.hand), this.rng);
        z.hand = [];
        this._draw(pid, 7);
        this.bottoming[pid] = Math.min(mullCount, z.hand.length);
        this._log(pid, me + ' takes mulligan #' + mullCount + ' — draws 7 and must put ' +
          this.bottoming[pid] + ' card' + (this.bottoming[pid] === 1 ? '' : 's') + ' on the bottom.');
        break;
      }
      case 'bottomCard': {
        if (!(this.bottoming[pid] | 0)) throw new Error('You do not owe any cards to the bottom');
        var bc = takeByUid(z.hand, action.uid, function (c) { return c.uid; });
        if (!bc) throw new Error('Card not in your hand');
        z.library.push(bc);
        this.bottoming[pid]--;
        this._log(pid, me + ' puts a card on the bottom of their library (' +
          this.bottoming[pid] + ' to go).');
        break;
      }
      case 'zoneMove': {
        var from = action.from;
        if (from !== 'graveyard' && from !== 'exile') throw new Error('Bad source zone');
        var dest = action.to;
        if (['hand', 'battlefield', 'graveyard', 'exile', 'library'].indexOf(dest) === -1 || dest === from) {
          throw new Error('Bad destination');
        }
        var zc = takeByUid(z[from], action.uid, function (c) { return c.uid; });
        if (!zc) throw new Error('Card not in your ' + from);
        var fromLabel = 'their ' + from;
        if (dest === 'library') {
          z.library = shuffle(z.library.concat([zc]), this.rng);
          this._log(pid, me + ' shuffles ' + zc.name + ' from ' + fromLabel + ' into their library.');
        } else if (dest === 'battlefield') {
          z.battlefield.push(permanent(zc));
          this._log(pid, me + ' returns ' + zc.name + ' from ' + fromLabel + ' to the battlefield.');
        } else if (dest === 'hand') {
          z.hand.push(zc);
          this._log(pid, me + ' returns ' + zc.name + ' from ' + fromLabel + ' to their hand.');
        } else {
          z[dest].push(zc);
          this._log(pid, me + "'s " + zc.name + ' goes from ' + fromLabel + ' to ' +
            (dest === 'graveyard' ? 'the graveyard' : 'exile') + '.');
        }
        break;
      }
      case 'life': {
        var d = action.d | 0;
        if (!d) throw new Error('Bad life delta');
        this.life[pid] += d;
        this._log(pid, me + (d > 0 ? ' gains ' : ' loses ') + Math.abs(d) + ' life (' + this.life[pid] + ').');
        break;
      }
      case 'play': {
        var card = takeByUid(z.hand, action.uid, function (c) { return c.uid; });
        if (!card) throw new Error('Card not in your hand');
        z.battlefield.push(permanent(card));
        this._log(pid, me + ' plays ' + card.name + '.');
        break;
      }
      case 'discard': {
        var dc = takeByUid(z.hand, action.uid, function (c) { return c.uid; });
        if (!dc) throw new Error('Card not in your hand');
        z.graveyard.push(dc);
        this._log(pid, me + ' discards ' + dc.name + '.');
        break;
      }
      case 'tap': {
        var perm = null;
        for (var i = 0; i < z.battlefield.length; i++) {
          if (z.battlefield[i].card.uid === action.uid) { perm = z.battlefield[i]; break; }
        }
        if (!perm) throw new Error('Card not on your battlefield');
        perm.tapped = !perm.tapped;
        this._log(pid, me + (perm.tapped ? ' taps ' : ' untaps ') + perm.card.name + '.');
        break;
      }
      case 'untapAll': {
        var n = 0;
        z.battlefield.forEach(function (p) { if (p.tapped) { p.tapped = false; n++; } });
        this._log(pid, me + ' untaps everything (' + n + ' cards).');
        break;
      }
      case 'counter': {
        var cperm = this._findPerm(pid, action.uid);
        if (!cperm) throw new Error('Card not on your battlefield');
        var kind = action.kind === 2 ? 2 : action.kind === 3 ? 3 : 1;
        var field = kind === 1 ? 'counters' : 'counters' + kind;
        cperm[field] = Math.max(0, cperm[field] + (action.d | 0));
        this._log(pid, me + ' sets ' + cperm.card.name + ' to ' + cperm[field] + ' ' +
          COUNTER_LABEL[kind] + 'counter(s).');
        break;
      }
      case 'note': {
        var nperm = this._findPerm(pid, action.uid);
        if (!nperm) throw new Error('Card not on your battlefield');
        nperm.note = String(action.text || '').slice(0, 40);
        break; // visible on the card itself — not logged
      }
      case 'clone': {
        var operm = this._findPerm(pid, action.uid);
        if (!operm) throw new Error('Card not on your battlefield');
        if (operm.faceDown) throw new Error('Turn it face up first');
        var copyCard = Object.assign({}, operm.card, {
          uid: 'g' + (++uidCounter),
          token: true // copies vanish when they leave the battlefield
        });
        var copyEntry = permanent(copyCard);
        copyEntry.row = operm.row;
        z.battlefield.push(copyEntry);
        this._log(pid, me + ' creates a copy of ' + operm.card.name + '.');
        break;
      }
      case 'handOrder': {
        var hIdx = -1;
        for (var hi = 0; hi < z.hand.length; hi++) {
          if (z.hand[hi].uid === action.uid) { hIdx = hi; break; }
        }
        if (hIdx === -1) throw new Error('Card not in your hand');
        var hCard = z.hand.splice(hIdx, 1)[0];
        var hAt = z.hand.length;
        if (action.before) {
          for (var hj = 0; hj < z.hand.length; hj++) {
            if (z.hand[hj].uid === action.before) { hAt = hj; break; }
          }
        }
        z.hand.splice(hAt, 0, hCard);
        break; // private arrangement — silent
      }
      case 'toLib': {
        var lpos = action.pos === 'top' ? 'top' : 'bottom';
        var lsrc = action.from;
        var lcard = null;
        if (lsrc === 'hand') {
          lcard = takeByUid(z.hand, action.uid, function (c) { return c.uid; });
          if (!lcard) throw new Error('Card not in your hand');
          this._log(pid, me + ' puts a card from their hand on ' +
            (lpos === 'top' ? 'top' : 'the bottom') + ' of their library.');
        } else if (lsrc === 'battlefield') {
          var lentry = takeByUid(z.battlefield, action.uid, function (e) { return e.card.uid; });
          if (!lentry) throw new Error('Card not on your battlefield');
          this._detachDependents(action.uid);
          if (lentry.card.token) {
            this._log(pid, me + "'s " + lentry.card.name + ' token ceases to exist.');
            break;
          }
          lcard = lentry.card;
          this._log(pid, me + ' puts ' + lcard.name + ' on ' +
            (lpos === 'top' ? 'top' : 'the bottom') + ' of their library.');
        } else if (lsrc === 'graveyard' || lsrc === 'exile') {
          lcard = takeByUid(z[lsrc], action.uid, function (c) { return c.uid; });
          if (!lcard) throw new Error('Card not in your ' + lsrc);
          this._log(pid, me + ' puts ' + lcard.name + ' from their ' + lsrc + ' on ' +
            (lpos === 'top' ? 'top' : 'the bottom') + ' of their library.');
        } else {
          throw new Error('Bad source zone');
        }
        if (lpos === 'top') z.library.unshift(lcard);
        else z.library.push(lcard);
        break;
      }
      case 'tokenFrom': {
        var tf = action.card || {};
        var tfName = String(tf.name || '').trim().slice(0, 60);
        if (!tfName) throw new Error('Token needs a name');
        z.battlefield.push(permanent({
          uid: 'g' + (++uidCounter),
          name: tfName,
          token: true,
          img: typeof tf.img === 'string' ? tf.img.slice(0, 300) : null,
          cost: '',
          type: String(tf.type || 'Token').slice(0, 80),
          text: String(tf.text || '').slice(0, 500),
          pt: String(tf.pt || '').slice(0, 10),
          colors: []
        }));
        this._log(pid, me + ' creates a ' + tfName + ' token.');
        break;
      }
      case 'pcounter': {
        var pname = String(action.name || '').trim().toLowerCase().slice(0, 20);
        if (!pname) throw new Error('Counter needs a name');
        var mine = (this.pcounters[pid] = this.pcounters[pid] || {});
        var next = Math.max(0, (mine[pname] | 0) + (action.d | 0));
        if (next === 0) delete mine[pname];
        else mine[pname] = next;
        this._log(pid, me + ' now has ' + next + ' ' + pname + ' counter(s).');
        break;
      }
      case 'move': {
        var to = action.to;
        if (to !== 'graveyard' && to !== 'exile' && to !== 'hand' && to !== 'library') {
          throw new Error('Bad destination');
        }
        var entry = takeByUid(z.battlefield, action.uid, function (e) { return e.card.uid; });
        if (!entry) throw new Error('Card not on your battlefield');
        this._detachDependents(action.uid);
        if (entry.card.token) {
          // Tokens are not real cards: leaving the battlefield, they vanish.
          this._log(pid, me + "'s " + entry.card.name + ' token ceases to exist.');
          break;
        }
        if (to === 'library') {
          z.library = shuffle(z.library.concat([entry.card]), this.rng);
          this._log(pid, me + ' shuffles ' + entry.card.name + ' into their library.');
        } else {
          z[to].push(entry.card);
          this._log(pid, me + "'s " + entry.card.name + ' goes to ' + (to === 'hand' ? 'their hand' : 'the ' + to) + '.');
        }
        break;
      }
      case 'recover': {
        var rc = takeByUid(z.graveyard, action.uid, function (c) { return c.uid; });
        if (!rc) throw new Error('Card not in your graveyard');
        z.hand.push(rc);
        this._log(pid, me + ' returns ' + rc.name + ' from the graveyard to their hand.');
        break;
      }
      case 'passTurn': {
        var idx = this.players.indexOf(pid);
        this.active = this.players[(idx + 1) % this.players.length];
        this.turn++;
        this._log(pid, me + ' passes the turn. Turn ' + this.turn + ' — ' + this.name(this.active) + '.');
        break;
      }
      case 'castCommander': {
        var cc = takeByUid(z.command, action.uid, function (c) { return c.uid; });
        if (!cc) throw new Error('Card not in your command zone');
        z.battlefield.push(permanent(cc));
        var casts = (this.commanderCasts[cc.uid] = (this.commanderCasts[cc.uid] | 0) + 1);
        this._log(pid, me + ' casts ' + cc.name + ' from the command zone' +
          (casts > 1 ? ' (cast #' + casts + ' — commander tax {' + (2 * (casts - 1)) + '})' : '') + '.');
        break;
      }
      case 'toCommand': {
        var src = action.from;
        var moved = null;
        if (src === 'battlefield') {
          var bentry = takeByUid(z.battlefield, action.uid, function (e) { return e.card.uid; });
          if (bentry) { this._detachDependents(action.uid); moved = bentry.card; }
        } else if (src === 'graveyard' || src === 'exile' || src === 'hand') {
          moved = takeByUid(z[src], action.uid, function (c) { return c.uid; });
        } else {
          throw new Error('Bad source zone');
        }
        if (!moved) throw new Error('Card not in your ' + src);
        if (!moved.commander) {
          // Put it back where it came from — only commanders live there.
          if (src === 'battlefield') z.battlefield.push(permanent(moved));
          else z[src].push(moved);
          throw new Error('Only a commander can go to the command zone');
        }
        z.command.push(moved);
        this._log(pid, me + ' returns ' + moved.name + ' to the command zone.');
        break;
      }
      case 'roll': {
        var sides = action.sides | 0;
        if (sides < 2 || sides > 1000) throw new Error('Bad die');
        var roll = 1 + Math.floor(this.rng() * sides);
        this._log(pid, me + ' rolls a d' + sides + ': ' + roll + '.');
        break;
      }
      case 'coin': {
        this._log(pid, me + ' flips a coin: ' + (this.rng() < 0.5 ? 'HEADS' : 'TAILS') + '.');
        break;
      }
      case 'row': {
        var rperm = this._findPerm(pid, action.uid);
        if (!rperm) throw new Error('Card not on your battlefield');
        rperm.row = rperm.row === 'land' ? 'main' : 'land';
        break;
      }
      case 'reorder': {
        // Cosmetic arrangement of one's own battlefield — synced, not logged.
        var bf2 = z.battlefield;
        var rIdx = -1;
        for (var qi = 0; qi < bf2.length; qi++) {
          if (bf2[qi].card.uid === action.uid) { rIdx = qi; break; }
        }
        if (rIdx === -1) throw new Error('Card not on your battlefield');
        var rEntry = bf2.splice(rIdx, 1)[0];
        if (action.row === 'land' || action.row === 'main') rEntry.row = action.row;
        var insertAt = bf2.length;
        if (action.before) {
          for (var qj = 0; qj < bf2.length; qj++) {
            if (bf2[qj].card.uid === action.before) { insertAt = qj; break; }
          }
        }
        bf2.splice(insertAt, 0, rEntry);
        break;
      }
      case 'attach': {
        var aperm = this._findPerm(pid, action.uid);
        if (!aperm) throw new Error('Card not on your battlefield');
        if (action.target === action.uid) throw new Error('Cannot attach a card to itself');
        var target = null;
        this.players.forEach(function (id) {
          target = target || this._findPerm(id, action.target);
        }, this);
        if (!target) throw new Error('Target is not on the battlefield');
        if (target.attachedTo) throw new Error('Cannot attach to a card that is itself attached');
        this._detachDependents(action.uid); // nothing may hang off an attachment
        aperm.attachedTo = action.target;
        this._log(pid, me + ' attaches ' + aperm.card.name + ' to ' + target.card.name + '.');
        break;
      }
      case 'detach': {
        var dperm = this._findPerm(pid, action.uid);
        if (!dperm) throw new Error('Card not on your battlefield');
        dperm.attachedTo = null;
        this._log(pid, me + ' unattaches ' + dperm.card.name + '.');
        break;
      }
      case 'playFaceDown': {
        var fdc = takeByUid(z.hand, action.uid, function (c) { return c.uid; });
        if (!fdc) throw new Error('Card not in your hand');
        var fdp = permanent(fdc);
        fdp.faceDown = true;
        fdp.row = 'main'; // a face-down card gives away nothing, lands included
        z.battlefield.push(fdp);
        this._log(pid, me + ' plays a card face down.');
        break;
      }
      case 'faceDown': {
        var fperm = this._findPerm(pid, action.uid);
        if (!fperm) throw new Error('Card not on your battlefield');
        fperm.faceDown = !fperm.faceDown;
        if (fperm.faceDown) {
          fperm.flipped = false;
          this._log(pid, me + ' turns ' + fperm.card.name + ' face down.');
        } else {
          this._log(pid, me + ' turns a face-down card face up: it is ' + fperm.card.name + '.');
        }
        break;
      }
      case 'transform': {
        var tperm = this._findPerm(pid, action.uid);
        if (!tperm) throw new Error('Card not on your battlefield');
        if (!tperm.card.back) throw new Error('This card has no other face');
        if (tperm.faceDown) throw new Error('Turn it face up first');
        tperm.flipped = !tperm.flipped;
        this._log(pid, tperm.flipped
          ? me + ' transforms ' + tperm.card.name + ' into ' + tperm.card.back.name + '.'
          : me + ' transforms ' + tperm.card.back.name + ' back into ' + tperm.card.name + '.');
        break;
      }
      case 'searchLibrary': {
        this.searching[pid] = true;
        this._log(pid, me + ' is searching their library…');
        break;
      }
      case 'takeFromLibrary': {
        if (!this.searching[pid]) throw new Error('Search your library first');
        var lc = takeByUid(z.library, action.uid, function (c) { return c.uid; });
        if (!lc) throw new Error('Card not in your library');
        if (action.to === 'hand') {
          z.hand.push(lc);
          this._log(pid, me + ' puts a card from their library into their hand.');
        } else if (action.to === 'battlefield') {
          z.battlefield.push(permanent(lc));
          this._log(pid, me + ' puts ' + lc.name + ' onto the battlefield from their library.');
        } else if (action.to === 'graveyard') {
          z.graveyard.push(lc);
          this._log(pid, me + ' puts ' + lc.name + ' into their graveyard from their library.');
        } else {
          z.library.unshift(lc);
          throw new Error('Bad destination');
        }
        break;
      }
      case 'endSearch': {
        this.searching[pid] = false;
        z.library = shuffle(z.library, this.rng);
        this._log(pid, me + ' finishes searching and shuffles their library.');
        break;
      }
      case 'token': {
        var tname = String(action.name || '').trim().slice(0, 60);
        if (!tname) throw new Error('Token needs a name');
        var tcount = Math.max(1, Math.min(10, (action.count | 0) || 1));
        for (var ti = 0; ti < tcount; ti++) {
          z.battlefield.push(permanent({
            uid: 'g' + (++uidCounter),
            name: tname,
            token: true,
            img: null,
            cost: '',
            type: 'Token'
          }));
        }
        this._log(pid, me + ' creates ' + (tcount > 1 ? tcount + ' ' : 'a ') + tname +
          ' token' + (tcount > 1 ? 's' : '') + '.');
        break;
      }
      case 'peek': {
        var pn = action.n | 0;
        if (pn < 1 || pn > 20) throw new Error('Bad count');
        if (!z.library.length) throw new Error('Your library is empty');
        pn = Math.min(pn, z.library.length);
        this.peeking[pid] = pn;
        this._log(pid, me + ' looks at the top ' + pn + ' card' + (pn > 1 ? 's' : '') + ' of their library…');
        break;
      }
      case 'peekMove': {
        var win = this.peeking[pid] | 0;
        if (!win) throw new Error('Look at your library first');
        var pidx = -1;
        for (var li = 0; li < win && li < z.library.length; li++) {
          if (z.library[li].uid === action.uid) { pidx = li; break; }
        }
        if (pidx === -1) throw new Error('Card is not among the viewed cards');
        var pc = z.library.splice(pidx, 1)[0];
        switch (action.to) {
          case 'top':
            z.library.unshift(pc); // stays in the window; last "Top" ends up on top
            break;
          case 'bottom':
            z.library.push(pc);
            this.peeking[pid] = win - 1;
            this._log(pid, me + ' puts a card on the bottom of their library.');
            break;
          case 'hand':
            z.hand.push(pc);
            this.peeking[pid] = win - 1;
            this._log(pid, me + ' puts a card from the top of their library into their hand.');
            break;
          case 'battlefield':
            z.battlefield.push(permanent(pc));
            this.peeking[pid] = win - 1;
            this._log(pid, me + ' puts ' + pc.name + ' onto the battlefield from the top of their library.');
            break;
          case 'manifest': {
            // Face down from the top of the library — the name stays hidden.
            var mperm = permanent(pc);
            mperm.faceDown = true;
            mperm.row = 'main';
            z.battlefield.push(mperm);
            this.peeking[pid] = win - 1;
            this._log(pid, me + ' manifests a card from the top of their library face down.');
            break;
          }
          case 'graveyard':
            z.graveyard.push(pc);
            this.peeking[pid] = win - 1;
            this._log(pid, me + ' puts ' + pc.name + ' into their graveyard from the top of their library.');
            break;
          default:
            z.library.splice(pidx, 0, pc); // put it back where it was
            throw new Error('Bad destination');
        }
        break;
      }
      case 'endPeek': {
        this.peeking[pid] = 0;
        this._log(pid, me + ' is done looking at their library.');
        break;
      }
      default:
        throw new Error('Unknown action');
    }
  };

  Game.prototype._findPerm = function (pid, uid) {
    var bf = this._zonesOf(pid).battlefield;
    for (var i = 0; i < bf.length; i++) if (bf[i].card.uid === uid) return bf[i];
    return null;
  };

  /** Clear attachedTo on anything attached to `uid` (its host is leaving/changing). */
  Game.prototype._detachDependents = function (uid) {
    this.players.forEach(function (id) {
      this.zones[id].battlefield.forEach(function (e) {
        if (e.attachedTo === uid) e.attachedTo = null;
      });
    }, this);
  };

  /**
   * Everything one player may know. Own hand in full; other hands as counts.
   * Pass pid = null for a SPECTATOR view: public zones only, no hand, no
   * hidden windows, no actions expected.
   */
  Game.prototype.viewFor = function (pid) {
    var self = pid ? this._zonesOf(pid) : null;
    var view = {
      you: pid || null,
      commander: this.commander,
      names: this.names,
      players: this.players.slice(),
      turn: this.turn,
      active: this.active,
      life: Object.assign({}, this.life),
      hand: self ? self.hand.slice() : [],
      searching: !!(pid && this.searching[pid]),
      bottoming: pid ? (this.bottoming[pid] | 0) : 0,
      // Library contents are revealed only to their owner, only mid-search.
      library: (pid && this.searching[pid]) ? self.library.slice() : null,
      // Scry window: top n cards, owner only, in order (index 0 = top).
      peek: (pid && (this.peeking[pid] | 0) > 0)
        ? { n: this.peeking[pid], cards: self.library.slice(0, this.peeking[pid]) }
        : null,
      zones: {},
      pcounters: {},
      log: this.log.slice(-40)
    };
    this.players.forEach(function (id) {
      view.pcounters[id] = Object.assign({}, this.pcounters[id] || {});
    }, this);
    this.players.forEach(function (id) {
      var z = this.zones[id];
      view.zones[id] = {
        handCount: z.hand.length,
        libraryCount: z.library.length,
        battlefield: z.battlefield.map(function (e) {
          // A face-down card's identity never leaves the host except to its
          // owner — other players get a stub with only the uid.
          var card = (e.faceDown && id !== pid)
            ? { uid: e.card.uid, name: 'Face-down card', facedown: true }
            : e.card;
          return {
            card: card, tapped: e.tapped, row: e.row,
            counters: e.counters, counters2: e.counters2 | 0, counters3: e.counters3 | 0,
            note: e.note || '',
            attachedTo: e.attachedTo, faceDown: e.faceDown, flipped: e.flipped
          };
        }),
        graveyard: z.graveyard.slice(),
        exile: z.exile.slice(),
        command: z.command.slice() // command zone is public
      };
    }, this);
    return view;
  };

  return { Game: Game, shuffle: shuffle };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MTGGame;
