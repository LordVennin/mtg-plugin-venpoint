/*
 * Draft engines — pure state machines, no DOM, no network.
 *
 * The host runs one of these and is the single source of truth. Players are
 * identified by stable string ids (seat order = array order). Cards are
 * objects (at minimum {name}); the engine tags each dealt copy with a unique
 * `uid` so two copies of the same card are distinguishable.
 *
 * Also loadable from Node for tests.
 */

var MTGDraft = (function () {
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
  function tag(card) {
    var c = Object.assign({}, card);
    c.uid = 'c' + (++uidCounter);
    return c;
  }

  /* ------------------------------------------------------------------ *
   * Cube (booster) draft
   *
   * packsPerPlayer rounds; each round every player opens a pack of packSize
   * cards dealt from the shuffled cube. Picks are simultaneous; packs pass
   * left in even rounds (0, 2, ...) and right in odd rounds.
   * ------------------------------------------------------------------ */
  function CubeDraft(playerIds, cardPool, opts) {
    opts = opts || {};
    this.players = playerIds.slice();
    this.packSize = opts.packSize || 15;
    this.packsPerPlayer = opts.packsPerPlayer || 3;
    this.rng = opts.rng || Math.random;

    var needed = this.players.length * this.packSize * this.packsPerPlayer;
    if (cardPool.length < needed) {
      throw new Error('Cube too small: need ' + needed + ' cards (' +
        this.players.length + ' players x ' + this.packsPerPlayer + ' packs x ' +
        this.packSize + ' cards), have ' + cardPool.length);
    }

    var deck = shuffle(cardPool, this.rng).map(tag);
    // this.rounds[r][seat] = pack (array of cards) opened by seat at round r
    this.rounds = [];
    for (var r = 0; r < this.packsPerPlayer; r++) {
      var roundPacks = [];
      for (var p = 0; p < this.players.length; p++) {
        roundPacks.push(deck.splice(0, this.packSize));
      }
      this.rounds.push(roundPacks);
    }

    this.picks = {};
    this.players.forEach(function (id) { this.picks[id] = []; }, this);

    this.round = 0;
    // queues[seat] = FIFO of packs waiting at that seat this round
    this.queues = this.players.map(function (_, seat) {
      return [this.rounds[0][seat]];
    }, this);
    this.finished = false;
  }

  CubeDraft.prototype._seat = function (playerId) {
    var s = this.players.indexOf(playerId);
    if (s === -1) throw new Error('Unknown player ' + playerId);
    return s;
  };

  /** The pack a player is currently looking at, or null if waiting. */
  CubeDraft.prototype.currentPack = function (playerId) {
    if (this.finished) return null;
    var q = this.queues[this._seat(playerId)];
    return q.length ? q[0] : null;
  };

  CubeDraft.prototype.pick = function (playerId, cardUid) {
    if (this.finished) throw new Error('Draft is finished');
    var seat = this._seat(playerId);
    var q = this.queues[seat];
    if (!q.length) throw new Error('No pack to pick from');
    var pack = q[0];
    var idx = -1;
    for (var i = 0; i < pack.length; i++) if (pack[i].uid === cardUid) { idx = i; break; }
    if (idx === -1) throw new Error('Card not in current pack');

    var card = pack.splice(idx, 1)[0];
    this.picks[playerId].push(card);
    q.shift();

    if (pack.length > 0) {
      // Pass: left (seat+1) on even rounds, right (seat-1) on odd rounds.
      var dir = (this.round % 2 === 0) ? 1 : -1;
      var next = (seat + dir + this.players.length) % this.players.length;
      this.queues[next].push(pack);
    }

    this._maybeAdvance();
    return card;
  };

  CubeDraft.prototype._maybeAdvance = function () {
    var anyInFlight = this.queues.some(function (q) { return q.length > 0; });
    if (anyInFlight) return;
    this.round++;
    if (this.round >= this.packsPerPlayer) {
      this.finished = true;
      return;
    }
    this.queues = this.players.map(function (_, seat) {
      return [this.rounds[this.round][seat]];
    }, this);
  };

  /** Everything one player is allowed to know. */
  CubeDraft.prototype.viewFor = function (playerId) {
    var seat = this._seat(playerId);
    var pack = this.currentPack(playerId);
    return {
      mode: 'cube',
      finished: this.finished,
      round: this.round,
      packsPerPlayer: this.packsPerPlayer,
      packSize: this.packSize,
      pack: pack,
      queued: Math.max(0, this.queues[seat].length - (pack ? 1 : 0)),
      picks: this.picks[playerId],
      pickNumber: this.picks[playerId].length + 1,
      // How many picks each player has made (public info at a paper table).
      table: this.players.map(function (id) {
        return { id: id, picks: this.picks[id].length, waitingPacks: this.queues[this._seat(id)].length };
      }, this)
    };
  };

  /* ------------------------------------------------------------------ *
   * Jumpstart draft
   *
   * Snake order. On your turn you are offered up to `choices` random packs
   * (names only); you keep one, the rest go back in the pool. Everyone picks
   * `packsPerPlayer` packs (default 2 -> 40-card deck with 20-card packs).
   * ------------------------------------------------------------------ */
  function JumpstartDraft(playerIds, packs, opts) {
    opts = opts || {};
    this.players = playerIds.slice();
    this.packsPerPlayer = opts.packsPerPlayer || 2;
    this.choices = opts.choices || 3;
    this.rng = opts.rng || Math.random;

    var needed = this.players.length * this.packsPerPlayer;
    if (packs.length < needed) {
      throw new Error('Not enough packs: need ' + needed + ' (' + this.players.length +
        ' players x ' + this.packsPerPlayer + '), have ' + packs.length);
    }

    this.pool = shuffle(packs, this.rng).map(function (p) {
      return { name: p.name, cards: p.cards.map(tag) };
    });

    this.picks = {}; // playerId -> [pack, ...]
    this.players.forEach(function (id) { this.picks[id] = []; }, this);

    // Build snake turn order: 0..n-1, n-1..0, 0..n-1, ...
    this.turnOrder = [];
    for (var r = 0; r < this.packsPerPlayer; r++) {
      var seats = this.players.map(function (_, i) { return i; });
      if (r % 2 === 1) seats.reverse();
      this.turnOrder = this.turnOrder.concat(seats);
    }
    this.turn = 0;
    this.finished = false;
    this.offer = null;
    this._makeOffer();
  }

  JumpstartDraft.prototype.currentPlayer = function () {
    if (this.finished) return null;
    return this.players[this.turnOrder[this.turn]];
  };

  JumpstartDraft.prototype._makeOffer = function () {
    if (this.turn >= this.turnOrder.length) {
      this.finished = true;
      this.offer = null;
      return;
    }
    // Never offer more packs than would leave later players short.
    var picksAfterThis = this.turnOrder.length - this.turn - 1;
    var maxOffer = this.pool.length - picksAfterThis;
    var n = Math.max(1, Math.min(this.choices, maxOffer));
    this.pool = shuffle(this.pool, this.rng);
    this.offer = this.pool.slice(0, n);
  };

  JumpstartDraft.prototype.pick = function (playerId, offerIndex) {
    if (this.finished) throw new Error('Draft is finished');
    if (playerId !== this.currentPlayer()) throw new Error('Not your turn');
    if (offerIndex < 0 || offerIndex >= this.offer.length) throw new Error('Bad choice');
    var chosen = this.offer[offerIndex];
    this.pool = this.pool.filter(function (p) { return p !== chosen; });
    this.picks[playerId].push(chosen);
    this.turn++;
    this._makeOffer();
    return chosen;
  };

  JumpstartDraft.prototype.viewFor = function (playerId) {
    var isMyTurn = this.currentPlayer() === playerId;
    return {
      mode: 'jumpstart',
      finished: this.finished,
      packsPerPlayer: this.packsPerPlayer,
      currentPlayer: this.currentPlayer(),
      myTurn: isMyTurn,
      // Offered pack names are only revealed to the player choosing.
      offer: isMyTurn && this.offer ? this.offer.map(function (p) { return p.name; }) : null,
      picks: this.picks[playerId],
      table: this.players.map(function (id) {
        return {
          id: id,
          packs: this.picks[id].map(function (p) { return p.name; })
        };
      }, this)
    };
  };

  /* ------------------------------------------------------------------ *
   * Sealed pools
   *
   * Not a draft: every player just opens `packs` boosters generated from a
   * real set's card list (cards carry {rarity}). Collation follows classic
   * booster rules: 1 rare (upgraded to mythic 1 time in 8 when the set has
   * mythics), 3 uncommons, 10 commons. Unlike a cube, the same card can
   * show up in several packs — only within one pack are cards distinct.
   * ------------------------------------------------------------------ */
  var PACK_SLOTS = [
    { rarities: ['rare', 'mythic'], count: 1 },
    { rarities: ['uncommon'], count: 3 },
    { rarities: ['common'], count: 10 }
  ];

  function generateSealedPools(playerIds, cards, opts) {
    opts = opts || {};
    var packs = opts.packs || 6;
    var rng = opts.rng || Math.random;

    var byRarity = { mythic: [], rare: [], uncommon: [], common: [], other: [] };
    cards.forEach(function (c) {
      var r = String(c.rarity || '').toLowerCase();
      (byRarity[r] || byRarity.other).push(c);
    });
    // Old/odd sets ("special", bonus sheets) fold into the rare slot pool.
    byRarity.rare = byRarity.rare.concat(byRarity.other);
    if (!byRarity.rare.length && !byRarity.uncommon.length && !byRarity.common.length) {
      throw new Error('This set has no rarity data to build boosters from');
    }
    var hasMythics = byRarity.mythic.length > 0;

    function drawFrom(pool, taken) {
      // Up to a few tries to avoid duplicating a card within the same pack;
      // tiny sets may simply not have enough variety, and that's fine.
      for (var t = 0; t < 8; t++) {
        var card = pool[Math.floor(rng() * pool.length)];
        if (!taken[card.name] || t === 7) return card;
      }
    }

    function onePack() {
      var pack = [];
      var taken = Object.create(null);
      PACK_SLOTS.forEach(function (slot) {
        for (var i = 0; i < slot.count; i++) {
          var pool = null;
          if (slot.rarities[0] === 'rare') {
            pool = (hasMythics && rng() < 1 / 8) ? byRarity.mythic : byRarity.rare;
          } else {
            pool = byRarity[slot.rarities[0]];
          }
          // Rarity missing from this set entirely -> borrow downward/upward
          // so packs stay full (old sets, funny sets).
          if (!pool || !pool.length) pool = byRarity.common;
          if (!pool.length) pool = byRarity.uncommon;
          if (!pool.length) pool = byRarity.rare;
          var card = drawFrom(pool, taken);
          taken[card.name] = true;
          pack.push(tag(card));
        }
      });
      return pack;
    }

    var pools = {};
    playerIds.forEach(function (pid) {
      var pool = [];
      for (var p = 0; p < packs; p++) pool = pool.concat(onePack());
      pools[pid] = pool;
    });
    return pools;
  }

  /** Flat card list of everything a player drafted (both modes). */
  function deckFor(engine, playerId) {
    var picks = engine.picks[playerId] || [];
    if (engine instanceof JumpstartDraft) {
      var cards = [];
      picks.forEach(function (p) { cards = cards.concat(p.cards); });
      return cards;
    }
    return picks.slice();
  }

  return {
    CubeDraft: CubeDraft,
    JumpstartDraft: JumpstartDraft,
    generateSealedPools: generateSealedPools,
    deckFor: deckFor,
    shuffle: shuffle
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MTGDraft;
