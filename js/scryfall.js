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
  var LS_KEY = 'mtgdraft.cardcache.v7'; // v7: added rarity (sealed boosters)
  var mem = Object.create(null);

  /**
   * The name to send to the API. Scryfall's collection endpoint matches
   * multi-face cards ONLY by a face name — the full "A // B" fails, and so
   * does Moxfield's single-slash "A / B" export. So for any slashed name we
   * request the front face and map the result back to the requested name.
   */
  function apiName(n) {
    var front = String(n).split(/\s*\/\/?\s*/)[0].trim();
    return front || n;
  }

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
    } catch (e) {
      // Quota hit: drop the old cache so future saves work again — losing
      // the cache only costs a re-fetch, a permanently stuck one costs the
      // offline resilience.
      try {
        localStorage.removeItem(LS_KEY);
        localStorage.setItem(LS_KEY, JSON.stringify(mem));
      } catch (e2) { /* storage disabled entirely — memory-only is fine */ }
    }
  }

  function faceData(f) {
    return {
      name: f.name || '',
      img: f.image_uris ? (f.image_uris.normal || f.image_uris.large) : null,
      cost: f.mana_cost || '',
      type: f.type_line || '',
      text: f.oracle_text || '',
      pt: (f.power !== undefined && f.toughness !== undefined) ? f.power + '/' + f.toughness : ''
    };
  }

  /** Token cards this card creates, from Scryfall's all_parts relations. */
  function tokenParts(card) {
    if (!card.all_parts) return undefined;
    var parts = card.all_parts
      .filter(function (p) { return p.component === 'token'; })
      .slice(0, 4)
      .map(function (p) { return { name: p.name, id: p.id }; });
    return parts.length ? parts : undefined;
  }

  /** TCGplayer market price (Scryfall relays it as prices.usd). */
  function priceOf(card) {
    var p = card.prices || {};
    return p.usd || p.usd_foil || p.usd_etched || null;
  }

  function slim(card) {
    // True double-faced cards (transform/MDFC) have a separate image per
    // face; the front face becomes the card, the back rides along as .back.
    if (card.card_faces && card.card_faces.length > 1 && card.card_faces[0].image_uris) {
      var front = faceData(card.card_faces[0]);
      return {
        name: card.name, // full "Front // Back" name, importable everywhere
        img: front.img,
        cost: front.cost,
        type: front.type,
        text: front.text,
        pt: front.pt,
        colors: card.color_identity || [],
        price: priceOf(card),
        rarity: card.rarity || null,
        tokens: tokenParts(card),
        back: faceData(card.card_faces[1])
      };
    }
    // Single-faced cards, plus split/adventure cards that share one image.
    var img = card.image_uris ? (card.image_uris.normal || card.image_uris.large) : null;
    var text = card.oracle_text ||
      (card.card_faces
        ? card.card_faces.map(function (f) { return f.oracle_text || ''; }).filter(Boolean).join('\n//\n')
        : '') || '';
    var pt = (card.power !== undefined && card.toughness !== undefined)
      ? card.power + '/' + card.toughness
      : (card.card_faces && card.card_faces[0].power !== undefined
        ? card.card_faces[0].power + '/' + card.card_faces[0].toughness
        : '');
    return {
      name: card.name,
      img: img,
      cost: card.mana_cost || (card.card_faces ? card.card_faces[0].mana_cost : '') || '',
      type: card.type_line || '',
      text: text,
      pt: pt,
      colors: card.color_identity || [],
      price: priceOf(card),
      rarity: card.rarity || null,
      tokens: tokenParts(card)
    };
  }

  /* ---------------- sealed: sets catalog + full-set card fetch ---------------- */

  var BOOSTER_SET_TYPES = { core: 1, expansion: 1, masters: 1, draft_innovation: 1, remaster: 1 };

  /** All sets you could crack boosters of, newest first: [{code,name,year,type}]. */
  function fetchSets() {
    return fetch('https://api.scryfall.com/sets')
      .then(function (res) {
        if (!res.ok) throw new Error('Scryfall error ' + res.status);
        return res.json();
      })
      .then(function (json) {
        return (json.data || [])
          .filter(function (s) {
            return BOOSTER_SET_TYPES[s.set_type] && !s.digital && s.card_count > 0;
          })
          .map(function (s) {
            return {
              code: s.code.toUpperCase(),
              name: s.name,
              year: (s.released_at || '').slice(0, 4),
              type: s.set_type
            };
          });
      });
  }

  /**
   * Every booster card of one set, with rarity, as slim cards.
   * onProgress(pageCount) between pages.
   */
  function fetchSetCards(code, onProgress) {
    var out = [];
    var pages = 0;
    function page(url) {
      return fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('Scryfall error ' + res.status);
          return res.json();
        })
        .then(function (json) {
          (json.data || []).forEach(function (card) { out.push(slim(card)); });
          pages++;
          if (onProgress) onProgress(out.length);
          if (json.has_more && json.next_page && pages < 20) {
            return new Promise(function (r) { setTimeout(r, 120); })
              .then(function () { return page(json.next_page); });
          }
          return out;
        });
    }
    var base = 'https://api.scryfall.com/cards/search?unique=cards&order=name&q=';
    // is:booster keeps promo/boxtopper printings out; some very old or odd
    // sets have no booster flags at all, so fall back to the whole set.
    return page(base + encodeURIComponent('e:' + code + ' is:booster -t:basic'))
      .catch(function () {
        out.length = 0;
        pages = 0;
        return page(base + encodeURIComponent('e:' + code + ' -t:basic'));
      });
  }

  /** Fetch one token card by Scryfall id (for "create its token"). */
  var tokenCache = Object.create(null);
  function fetchToken(id) {
    if (tokenCache[id]) return Promise.resolve(tokenCache[id]);
    return fetch('https://api.scryfall.com/cards/' + encodeURIComponent(id))
      .then(function (res) {
        if (!res.ok) throw new Error('Scryfall error ' + res.status);
        return res.json();
      })
      .then(function (card) {
        var s = slim(card);
        tokenCache[id] = s;
        return s;
      });
  }

  /**
   * Resolve an array of card names.
   * onProgress(done, total) is called between batches.
   * setHints (optional): lowercased name -> set code, pinning that name to a
   * specific printing ("(SET)" suffixes in lists) — pinned printings cache
   * under a separate key so old-art and current-art copies coexist.
   * Returns Promise<{cards: {lowerName: cardObj}, notFound: [name]}>.
   */
  function resolve(names, onProgress, setHints) {
    loadCache();
    var hints = setHints || {};
    var keyOf = function (n) {
      var k = n.toLowerCase();
      return hints[k] ? k + '@' + hints[k] : k;
    };
    var unique = [];
    var seen = Object.create(null);
    names.forEach(function (n) {
      var k = n.toLowerCase();
      if (!seen[k]) { seen[k] = true; unique.push(n); }
    });

    var toFetch = unique.filter(function (n) { return !mem[keyOf(n)]; });
    var notFound = [];
    var total = toFetch.length;
    var done = 0;

    // Scryfall first; if it is down (or rate-limiting), fall back to the
    // relay's local card mirror at the same-origin /api/cards/collection.
    // On hosts without the mirror the fallback just 404s and the caller's
    // existing text-only degradation kicks in, same as before.
    function postCollection(chunk) {
      var body = JSON.stringify({
        identifiers: chunk.map(function (n) {
          var id = { name: apiName(n) };
          var s = hints[n.toLowerCase()];
          if (s) id.set = s; // pin the printing
          return id;
        })
      });
      var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body };
      var check = function (res) {
        if (!res.ok) throw new Error('Scryfall error ' + res.status);
        return res.json();
      };
      return fetch(API, opts).then(check).catch(function (err) {
        return fetch('api/cards/collection', opts).then(check).catch(function () { throw err; });
      });
    }

    function batch(chunk) {
      return postCollection(chunk).then(function (json) {
        (json.data || []).forEach(function (card) {
          var s = slim(card);
          mem[s.name.toLowerCase()] = s;
        });
        (json.not_found || []).forEach(function (ident) {
          if (ident.name) notFound.push(ident.name);
        });
        // Requested names can differ from canonical names: Moxfield's
        // "A / B", the full "A // B", or a front-face name — map each
        // requested spelling to the card its front face resolved to.
        // NEVER match by back face here: Scryfall's collection endpoint
        // returns a DFC even for an identifier that exactly names a real
        // standalone card ("Sign in Blood" -> the Scheming Silvertongue
        // DFC), so back-face candidates go to the named?exact rescue pass,
        // where exact full names win.
        chunk.forEach(function (n) {
          var k = n.toLowerCase();
          if (mem[k]) return;
          var fk = apiName(n).toLowerCase();
          var hit = (json.data || []).find(function (c) {
            var cn = c.name.toLowerCase();
            return cn === fk || cn.indexOf(fk + ' //') === 0;
          });
          if (hit) mem[k] = slim(hit);
        });
        // Pinned printings also cache under their name@set key, so a later
        // un-pinned request can fetch current art without clashing.
        chunk.forEach(function (n) {
          var k = n.toLowerCase();
          var key = keyOf(n);
          if (key !== k && mem[k]) mem[key] = mem[k];
        });
        done += chunk.length;
        if (onProgress) onProgress(Math.min(done, total), total);
      });
    }

    var chunks = [];
    for (var i = 0; i < toFetch.length; i += 75) chunks.push(toFetch.slice(i, i + 75));

    // Rescue pass for names the batch could not place unambiguously (e.g. a
    // standalone card that shares its name with some DFC's back face).
    // named?exact prioritizes exact full names; fuzzy is the last resort.
    function rescue(name) {
      var enc = encodeURIComponent(name);
      var setQ = hints[name.toLowerCase()] ? '&set=' + encodeURIComponent(hints[name.toLowerCase()]) : '';
      var okJson = function (res) { return res.ok ? res.json() : Promise.reject(); };
      return fetch('https://api.scryfall.com/cards/named?exact=' + enc + setQ)
        .then(okJson)
        .catch(function () {
          // The pinned set may lack this exact spelling — any printing beats none.
          if (!setQ) return Promise.reject();
          return fetch('https://api.scryfall.com/cards/named?exact=' + enc).then(okJson);
        })
        .catch(function () {
          return fetch('https://api.scryfall.com/cards/named?fuzzy=' + enc).then(okJson);
        })
        .catch(function () {
          // Scryfall itself unreachable — the relay's mirror, if present.
          return fetch('api/cards/named?exact=' + enc).then(okJson);
        })
        .then(function (card) {
          var s = slim(card);
          mem[s.name.toLowerCase()] = s;
          mem[name.toLowerCase()] = s;
          mem[keyOf(name)] = s;
        })
        .catch(function () { /* genuinely unknown — stays a text card */ });
    }

    // Sequential batches with a polite delay (Scryfall asks for 50-100ms).
    var p = Promise.resolve();
    chunks.forEach(function (chunk, idx) {
      p = p.then(function () { return batch(chunk); }).then(function () {
        if (idx < chunks.length - 1) {
          return new Promise(function (r) { setTimeout(r, 120); });
        }
      });
    });

    p = p.then(function () {
      var missing = unique.filter(function (n) { return !mem[n.toLowerCase()]; }).slice(0, 30);
      var q = Promise.resolve();
      missing.forEach(function (n) {
        q = q.then(function () { return rescue(n); })
          .then(function () { return new Promise(function (r) { setTimeout(r, 120); }); });
      });
      return q;
    });

    return p.then(function () {
      saveCache();
      var out = Object.create(null);
      unique.forEach(function (n) {
        var k = n.toLowerCase();
        var hit = mem[keyOf(n)] || mem[k]; // pinned printing first
        if (hit) out[k] = hit;
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

  return {
    resolve: resolve,
    toCardObjects: toCardObjects,
    fetchToken: fetchToken,
    fetchSets: fetchSets,
    fetchSetCards: fetchSetCards
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Scryfall;
