/*
 * Scryfall card resolution.
 *
 * Batch-resolves card names via POST /cards/collection (75 identifiers per
 * request, per Scryfall's API). Results are cached in memory and in
 * localStorage so repeat imports of the same cube are instant.
 *
 * Resolved card shape (kept small — these objects travel over the wire to
 * every player): { name, img, cost, type, colors }
 */

var Scryfall = (function () {
  'use strict';

  var API = 'https://api.scryfall.com/cards/collection';
  var LS_KEY = 'mtgdraft.cardcache.v1';
  var mem = Object.create(null);

  function loadCache() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var obj = JSON.parse(raw);
        Object.keys(obj).forEach(function (k) { mem[k] = obj[k]; });
      }
    } catch (e) { /* private mode / disabled storage — fine, memory-only */ }
  }

  function saveCache() {
    try {
      var keys = Object.keys(mem);
      // Guard against unbounded growth: keep at most ~4000 cards cached.
      if (keys.length > 4000) return;
      localStorage.setItem(LS_KEY, JSON.stringify(mem));
    } catch (e) { /* quota exceeded — fine, cache is an optimization */ }
  }

  function slim(card) {
    var img = null;
    if (card.image_uris) img = card.image_uris.normal || card.image_uris.large;
    else if (card.card_faces && card.card_faces[0].image_uris) {
      img = card.card_faces[0].image_uris.normal || card.card_faces[0].image_uris.large;
    }
    return {
      name: card.name,
      img: img,
      cost: card.mana_cost || (card.card_faces ? card.card_faces[0].mana_cost : '') || '',
      type: card.type_line || '',
      colors: card.color_identity || []
    };
  }

  /**
   * Resolve an array of card names.
   * onProgress(done, total) is called between batches.
   * Returns Promise<{cards: {lowerName: cardObj}, notFound: [name]}>.
   */
  function resolve(names, onProgress) {
    loadCache();
    var unique = [];
    var seen = Object.create(null);
    names.forEach(function (n) {
      var k = n.toLowerCase();
      if (!seen[k]) { seen[k] = true; unique.push(n); }
    });

    var toFetch = unique.filter(function (n) { return !mem[n.toLowerCase()]; });
    var notFound = [];
    var total = toFetch.length;
    var done = 0;

    function batch(chunk) {
      return fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: chunk.map(function (n) { return { name: n }; }) })
      }).then(function (res) {
        if (!res.ok) throw new Error('Scryfall error ' + res.status);
        return res.json();
      }).then(function (json) {
        (json.data || []).forEach(function (card) {
          var s = slim(card);
          mem[s.name.toLowerCase()] = s;
        });
        (json.not_found || []).forEach(function (ident) {
          if (ident.name) notFound.push(ident.name);
        });
        // Requested names can differ from canonical names (e.g. split cards,
        // "Fire // Ice" asked as "Fire"). Map request name -> card too.
        chunk.forEach(function (n) {
          var k = n.toLowerCase();
          if (mem[k]) return;
          var hit = (json.data || []).find(function (c) {
            return c.name.toLowerCase().indexOf(k) === 0 ||
              (c.card_faces || []).some(function (f) { return f.name.toLowerCase() === k; });
          });
          if (hit) mem[k] = slim(hit);
        });
        done += chunk.length;
        if (onProgress) onProgress(Math.min(done, total), total);
      });
    }

    var chunks = [];
    for (var i = 0; i < toFetch.length; i += 75) chunks.push(toFetch.slice(i, i + 75));

    // Sequential batches with a polite delay (Scryfall asks for 50-100ms).
    var p = Promise.resolve();
    chunks.forEach(function (chunk, idx) {
      p = p.then(function () { return batch(chunk); }).then(function () {
        if (idx < chunks.length - 1) {
          return new Promise(function (r) { setTimeout(r, 120); });
        }
      });
    });

    return p.then(function () {
      saveCache();
      var out = Object.create(null);
      unique.forEach(function (n) {
        var k = n.toLowerCase();
        if (mem[k]) out[k] = mem[k];
        else if (notFound.indexOf(n) === -1) notFound.push(n);
      });
      return { cards: out, notFound: notFound };
    });
  }

  /**
   * Turn a list of names into card objects, using placeholders for anything
   * Scryfall didn't recognize (so a typo'd card is still draftable).
   */
  function toCardObjects(names, resolved) {
    return names.map(function (n) {
      return resolved[n.toLowerCase()] || { name: n, img: null, cost: '', type: '', colors: [] };
    });
  }

  return { resolve: resolve, toCardObjects: toCardObjects };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Scryfall;
