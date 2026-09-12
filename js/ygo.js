/*
 * Yu-Gi-Oh! card resolution via the YGOPRODeck API (db.ygoprodeck.com,
 * CORS-open, no key). Exposes the same interface as the Scryfall module so
 * callers pick a source by game:
 *   resolve(names, onProgress[, hints]) -> Promise<{cards, notFound}>
 *   toCardObjects(names, resolved)      -> [card, ...]
 *   searchCards(query, maxPages, onProgress) -> Promise<{cards, total}>
 *
 * Slim card shape matches MTG's ({name, img, cost, type, text, pt, colors,
 * price}) plus YGO extras: `level` (level/rank/link) and `extra: true` on
 * Fusion / Synchro / XYZ / Link cards — those belong in the extra deck.
 */

var YGO = (function () {
  'use strict';

  var API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
  var LS_KEY = 'mtgdraft.ygocache.v1';
  var mem = Object.create(null);

  function loadCache() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var obj = JSON.parse(raw);
        Object.keys(obj).forEach(function (k) { mem[k] = obj[k]; });
      }
    } catch (e) { /* private mode / node — memory-only */ }
  }

  function saveCache() {
    try {
      if (Object.keys(mem).length > 4000) return;
      localStorage.setItem(LS_KEY, JSON.stringify(mem));
    } catch (e) {
      try {
        localStorage.removeItem(LS_KEY);
        localStorage.setItem(LS_KEY, JSON.stringify(mem));
      } catch (e2) { /* storage disabled — memory-only is fine */ }
    }
  }
  loadCache();

  /** Fusion/Synchro/XYZ/Link (plain or pendulum) live in the extra deck. */
  function isExtra(frameType) {
    return /^(fusion|synchro|xyz|link)/.test(String(frameType || ''));
  }

  function slim(card) {
    var img = (card.card_images && card.card_images[0] && card.card_images[0].image_url) || null;
    var prices = (card.card_prices && card.card_prices[0]) || {};
    var lvl = 0;
    var lvlBit = '';
    if (card.linkval) { lvl = card.linkval; lvlBit = 'Link-' + card.linkval; }
    else if (card.level) {
      lvl = card.level;
      lvlBit = (/xyz/.test(String(card.frameType || '')) ? 'Rank ' : 'Level ') + card.level;
    }
    return {
      name: card.name,
      img: img,
      cost: '',
      type: (card.humanReadableCardType || card.type || '') +
        (card.race ? ' — ' + card.race : '') +
        (card.attribute ? ' / ' + card.attribute : '') +
        (lvlBit ? ' / ' + lvlBit : ''),
      text: card.desc || '',
      pt: (card.atk !== undefined && card.atk !== null)
        ? card.atk + '/' + (card.def === undefined || card.def === null ? '—' : card.def)
        : '',
      colors: [],
      price: prices.tcgplayer_price || prices.cardmarket_price || null,
      level: lvl,
      extra: isExtra(card.frameType)
    };
  }

  function getJson(url) {
    return fetch(url).then(function (res) {
      // YGOPRODeck answers 400 with {error} when nothing matches — for a
      // lookup that just means "no such card", not a failure.
      if (res.status === 400) return { data: [] };
      if (!res.ok) throw new Error('YGOPRODeck error ' + res.status);
      return res.json();
    });
  }

  /**
   * Batch-resolve exact names (the `name` param takes |-separated names).
   * A batch with one unknown name can 400 as a whole, so batches that come
   * back empty are retried one name at a time before giving up.
   */
  function resolve(names, onProgress) {
    var unique = [];
    var seen = Object.create(null);
    names.forEach(function (n) {
      var k = String(n).trim();
      if (k && !seen[k.toLowerCase()]) { seen[k.toLowerCase()] = true; unique.push(k); }
    });
    var missing = unique.filter(function (n) { return !mem[n.toLowerCase()]; });
    var done = unique.length - missing.length;
    var total = unique.length;
    if (onProgress) onProgress(done, total);

    var chunks = [];
    for (var i = 0; i < missing.length; i += 10) chunks.push(missing.slice(i, i + 10));

    function absorb(data) {
      (data || []).forEach(function (card) {
        mem[card.name.toLowerCase()] = slim(card);
      });
    }
    function fetchChunk(chunk) {
      return getJson(API + '?name=' + encodeURIComponent(chunk.join('|')))
        .then(function (json) {
          if ((!json.data || !json.data.length) && chunk.length > 1) {
            // One bad name can sink the whole batch — retry singly.
            return chunk.reduce(function (p, one) {
              return p.then(function () {
                return getJson(API + '?name=' + encodeURIComponent(one))
                  .then(function (j2) { absorb(j2.data); });
              });
            }, Promise.resolve());
          }
          absorb(json.data);
        })
        .then(function () {
          done += chunk.length;
          if (onProgress) onProgress(Math.min(done, total), total);
        });
    }

    return chunks.reduce(function (p, chunk) {
      return p.then(function () { return fetchChunk(chunk); });
    }, Promise.resolve()).then(function () {
      saveCache();
      var out = {};
      var notFound = [];
      unique.forEach(function (n) {
        var hit = mem[n.toLowerCase()];
        if (hit) out[n.toLowerCase()] = hit;
        else notFound.push(n);
      });
      return { cards: out, notFound: notFound };
    });
  }

  /** Placeholders keep typo'd cards playable, same as the MTG side. */
  function toCardObjects(names, resolved) {
    return names.map(function (n) {
      return resolved[n.toLowerCase()] || { name: n, img: null, cost: '', type: '', colors: [] };
    });
  }

  /** Substring search (the workshop box). fname matches partial names. */
  function searchCards(query, maxPages, onProgress) {
    var num = 60;
    return getJson(API + '?fname=' + encodeURIComponent(query) + '&num=' + num + '&offset=0')
      .then(function (json) {
        var data = json.data || [];
        var cards = data.map(slim);
        cards.forEach(function (c) { mem[c.name.toLowerCase()] = c; });
        saveCache();
        var total = (json.meta && json.meta.total_rows) || cards.length;
        if (onProgress) onProgress(cards.length, total);
        return { cards: cards, total: total };
      });
  }

  return {
    resolve: resolve,
    toCardObjects: toCardObjects,
    searchCards: searchCards
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = YGO;
