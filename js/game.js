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
 *   {a:'mulligan'}                   hand -> library, shuffle, draw 7
 *   {a:'life', d:+1|-1|...}          adjust own life
 *   {a:'play', uid}                  hand -> battlefield
 *   {a:'discard', uid}               hand -> graveyard
 *   {a:'tap', uid}                   toggle tapped on own battlefield card
 *   {a:'untapAll'}                   untap all own battlefield cards
 *   {a:'counter', uid, d:+1|-1}      adjust counters on own battlefield card
 *   {a:'move', uid, to}              own battlefield card -> 'graveyard'|'exile'|'hand'|'library'
 *   {a:'recover', uid}               own graveyard card -> hand
 *   {a:'passTurn'}                   pass the turn marker (no auto-untap/draw)
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

  /**
   * playerIds: [id, id]  decks: {id: [card,...]}  names: {id: displayName}
   */
  function Game(playerIds, decks, names, opts) {
    opts = opts || {};
    if (playerIds.length !== 2) throw new Error('The play surface is 1v1 — need exactly 2 players');
    this.players = playerIds.slice();
    this.names = names || {};
    this.rng = opts.rng || Math.random;

    this.life = {};
    this.zones = {};
    this.turn = 1;
    this.active = this.players[0];
    this.log = [];

    this.players.forEach(function (id) {
      var deck = (decks[id] || []).map(function (c) {
        var card = Object.assign({}, c);
        if (!card.uid) card.uid = 'g' + (++uidCounter);
        return card;
      });
      this.life[id] = 20;
      this.zones[id] = {
        library: shuffle(deck, this.rng),
        hand: [],
        battlefield: [], // entries: {card, tapped, counters}
        graveyard: [],
        exile: []
      };
    }, this);

    this.players.forEach(function (id) { this._draw(id, 7); }, this);
    this._log(null, 'Game started — both players draw 7. ' + this.name(this.active) + ' goes first.');
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
        var handSize = z.hand.length;
        z.library = shuffle(z.library.concat(z.hand), this.rng);
        z.hand = [];
        this._draw(pid, 7);
        this._log(pid, me + ' mulligans (' + handSize + ' cards back, draws 7).');
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
        z.battlefield.push({ card: card, tapped: false, counters: 0 });
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
        var cperm = null;
        for (var ci = 0; ci < z.battlefield.length; ci++) {
          if (z.battlefield[ci].card.uid === action.uid) { cperm = z.battlefield[ci]; break; }
        }
        if (!cperm) throw new Error('Card not on your battlefield');
        cperm.counters = Math.max(0, cperm.counters + (action.d | 0));
        this._log(pid, me + ' sets ' + cperm.card.name + ' to ' + cperm.counters + ' counter(s).');
        break;
      }
      case 'move': {
        var to = action.to;
        if (to !== 'graveyard' && to !== 'exile' && to !== 'hand' && to !== 'library') {
          throw new Error('Bad destination');
        }
        var entry = takeByUid(z.battlefield, action.uid, function (e) { return e.card.uid; });
        if (!entry) throw new Error('Card not on your battlefield');
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
        this.active = this.players[(idx + 1) % 2];
        this.turn++;
        this._log(pid, me + ' passes the turn. Turn ' + this.turn + ' — ' + this.name(this.active) + '.');
        break;
      }
      default:
        throw new Error('Unknown action');
    }
  };

  /** Everything one player may know. Own hand in full; opponent hand as a count. */
  Game.prototype.viewFor = function (pid) {
    var view = {
      you: pid,
      names: this.names,
      players: this.players.slice(),
      turn: this.turn,
      active: this.active,
      life: Object.assign({}, this.life),
      hand: this._zonesOf(pid).hand.slice(),
      zones: {},
      log: this.log.slice(-40)
    };
    this.players.forEach(function (id) {
      var z = this.zones[id];
      view.zones[id] = {
        handCount: z.hand.length,
        libraryCount: z.library.length,
        battlefield: z.battlefield.map(function (e) {
          return { card: e.card, tapped: e.tapped, counters: e.counters };
        }),
        graveyard: z.graveyard.slice(),
        exile: z.exile.slice()
      };
    }, this);
    return view;
  };

  return { Game: Game, shuffle: shuffle };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MTGGame;
