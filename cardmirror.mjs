/*
 * Local card mirror: a slimmed copy of Scryfall's "Oracle Cards" bulk data
 * so the relay can answer card lookups when Scryfall is unreachable (and
 * spare it the traffic when it isn't).
 *
 * Everything here is pure logic — the relay server owns downloading,
 * persistence, and HTTP. Cards are stored as a SUBSET of Scryfall's card
 * shape (only the fields the client's slim() reads), so the client-side
 * code path is identical whichever server answered.
 */

/** The fields js/scryfall.js slim() consumes, nothing else. */
function slimFace(f) {
  const out = {
    name: f.name || '',
    mana_cost: f.mana_cost || '',
    type_line: f.type_line || '',
    oracle_text: f.oracle_text || ''
  };
  if (f.power !== undefined && f.toughness !== undefined) {
    out.power = f.power;
    out.toughness = f.toughness;
  }
  if (f.image_uris && (f.image_uris.normal || f.image_uris.large)) {
    out.image_uris = { normal: f.image_uris.normal || f.image_uris.large };
  }
  return out;
}

export function slimSource(card) {
  const out = slimFace(card);
  out.name = card.name; // full "Front // Back" name
  if (card.color_identity) out.color_identity = card.color_identity;
  if (card.prices && (card.prices.usd || card.prices.usd_foil || card.prices.usd_etched)) {
    out.prices = {
      usd: card.prices.usd || null,
      usd_foil: card.prices.usd_foil || null,
      usd_etched: card.prices.usd_etched || null
    };
  }
  if (Array.isArray(card.card_faces) && card.card_faces.length > 1) {
    out.card_faces = card.card_faces.map(slimFace);
  }
  if (Array.isArray(card.all_parts)) {
    const toks = card.all_parts
      .filter(p => p.component === 'token')
      .slice(0, 4)
      .map(p => ({ component: 'token', id: p.id, name: p.name }));
    if (toks.length) out.all_parts = toks;
  }
  return out;
}

/**
 * Index cards by lowercased full name AND by each face name, mirroring how
 * Scryfall's collection endpoint matches identifiers. A real standalone
 * card always beats a face-name alias for the same key ("Sign in Blood"
 * must find the sorcery, not a DFC back face).
 */
export function indexCards(cards) {
  const byName = new Map(); // exact full names — never overwritten
  const byFace = new Map(); // face-name aliases — first writer wins
  for (const card of cards) {
    const full = card.name.toLowerCase();
    if (!byName.has(full)) byName.set(full, card);
    for (const part of card.name.split(' // ')) {
      const k = part.trim().toLowerCase();
      if (k && !byFace.has(k)) byFace.set(k, card);
    }
  }
  return { byName, byFace };
}

export function lookupNamed(index, name) {
  const k = String(name || '').trim().toLowerCase();
  return index.byName.get(k) || index.byFace.get(k) || null;
}

/** Answer a Scryfall /cards/collection-shaped request from the index. */
export function lookupCollection(index, identifiers) {
  const data = [];
  const notFound = [];
  const seen = new Set();
  for (const ident of (identifiers || []).slice(0, 75)) {
    const card = ident && ident.name ? lookupNamed(index, ident.name) : null;
    if (!card) { notFound.push(ident || {}); continue; }
    if (!seen.has(card.name)) { seen.add(card.name); data.push(card); }
  }
  return { object: 'list', data, not_found: notFound };
}

/**
 * Incremental extractor for a JSON array of objects, fed as text chunks.
 * Tracks brace depth and string state so it works regardless of how the
 * bulk file is formatted, without ever holding the whole file in memory.
 */
export function createStreamExtractor(onCard) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let buf = '';

  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (depth > 0) buf += ch;
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') {
          depth++;
          if (depth === 1) buf = '{';
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            onCard(JSON.parse(buf));
            buf = '';
          }
        }
      }
    },
    end() {
      if (depth !== 0) throw new Error('Truncated JSON stream (depth ' + depth + ' at end)');
    }
  };
}
