/*
 * Unit tests for the pure-logic modules. Run with:  node tests/run.js
 */
'use strict';

const Parser = require('../js/parser.js');
const Draft = require('../js/draft.js');
const Game = require('../js/game.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok - ' + msg); }
  else { failures++; console.error('  FAIL - ' + msg); }
}
function section(name) { console.log('\n# ' + name); }

/* Deterministic RNG for reproducible shuffles */
function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ---------------- parser ---------------- */
section('parseLine');
{
  const p = Parser.parseLine;
  assert(JSON.stringify(p('4 Lightning Bolt')) === JSON.stringify({ count: 4, name: 'Lightning Bolt', set: null, collectorNumber: null }), 'plain "4 Name"');
  assert(p('4x Lightning Bolt').count === 4 && p('4x Lightning Bolt').name === 'Lightning Bolt', '"4x Name"');
  assert(p('Lightning Bolt').count === 1, 'bare name defaults to 1');
  const withSet = p('1 Lightning Bolt (2X2) 117');
  assert(withSet.name === 'Lightning Bolt' && withSet.set === '2X2' && withSet.collectorNumber === '117', 'set + collector number');
  assert(p('1 Lightning Bolt (2X2) 117 *F*').name === 'Lightning Bolt', 'foil marker stripped');
  assert(p('SB: 2 Duress').count === 2 && p('SB: 2 Duress').name === 'Duress', 'MTGO sideboard prefix');
  assert(p('// a comment') === null, 'comment line');
  assert(p('Sideboard') === null, 'section header');
  assert(p('1 Fire // Ice').name === 'Fire // Ice', 'split card name survives');
  const mox = p('1 Funeral Room / Awakening Hall (PDSK) 100p');
  assert(mox.name === 'Funeral Room / Awakening Hall' && mox.set === 'PDSK' && mox.collectorNumber === '100p',
    'Moxfield single-slash + promo collector number parses');
  assert(p('1 Borrowing 100,000 Arrows').name === 'Borrowing 100,000 Arrows', 'commas in name');
}

section('parseDeckList');
{
  const res = Parser.parseDeckList('Deck\n2 Island\n1 Island\n\n// lands\n3 Forest\n');
  assert(res.entries.length === 2, 'duplicates merged into 2 entries');
  assert(res.entries[0].count === 3 && res.entries[0].name === 'Island', 'Island count merged to 3');
  assert(res.errors.length === 0, 'no parse errors');
  const flat = Parser.expandEntries(res.entries);
  assert(flat.length === 6 && flat.filter(n => n === 'Forest').length === 3, 'expandEntries produces 6 names');
}

section('parseJumpstartPacks');
{
  const text = '# Goblins\n2 Goblin Guide\n7 Mountain\n\n=== Angels ===\n1 Serra Angel\n[Zombies]\n1 Gravecrawler';
  const res = Parser.parseJumpstartPacks(text);
  assert(res.packs.length === 3, 'three packs parsed from three header styles');
  assert(res.packs[0].name === 'Goblins' && res.packs[0].cards.length === 9, 'Goblins has 9 cards (2+7)');
  assert(res.packs[1].name === 'Angels', '=== header ===');
  assert(res.packs[2].name === 'Zombies', '[bracket] header');
  const headerless = Parser.parseJumpstartPacks('1 Island\n1 Forest');
  assert(headerless.packs.length === 1 && headerless.packs[0].name === 'Pack 1', 'headerless text becomes Pack 1');
}

section('parseDeckListWithCommanders');
{
  const r = Parser.parseDeckListWithCommanders('1 Sol Ring\n\nCommander\n1 Krenko, Mob Boss\n\nDeck\n2 Shock');
  assert(r.commanders.length === 1 && r.commanders[0] === 'Krenko, Mob Boss', 'Commander section header recognized');
  assert(r.entries.length === 3, 'commander card is still part of the deck entries');
  const r2 = Parser.parseDeckListWithCommanders("1 Atraxa, Praetors' Voice *CMDR*\n30 Forest");
  assert(r2.commanders[0] === "Atraxa, Praetors' Voice", '*CMDR* marker recognized');
  assert(r2.entries[0].name === "Atraxa, Praetors' Voice", 'marker stripped from the name');
  const r3 = Parser.parseDeckListWithCommanders('2 Island\n1 Shock');
  assert(r3.commanders.length === 0 && r3.entries.length === 2, 'plain lists have no commanders');
}

section('formatDeckList');
{
  const out = Parser.formatDeckList(['Island', 'Forest', 'Island']);
  assert(out === '2 Island\n1 Forest', 'round-trips counts');
}

section('parsePresetFile (lists/ directory format)');
{
  const p = Parser.parsePresetFile(
    '@name My Cube\n@format Cube\n\n1 Lightning Bolt\n1 Counterspell\n');
  assert(p.name === 'My Cube' && p.format === 'cube', 'metadata parsed (format lowercased)');
  assert(p.body === '1 Lightning Bolt\n1 Counterspell\n', 'body excludes metadata and leading blanks');

  const js = Parser.parsePresetFile('@format jumpstart\n# Goblins\n2 Goblin Guide\n@not-meta x');
  assert(js.format === 'jumpstart' && js.name === '', 'name optional');
  assert(/# Goblins/.test(js.body) && /@not-meta x/.test(js.body),
    '@-lines after content stay in the body (only the header is metadata)');

  const bare = Parser.parsePresetFile('1 Island\n1 Forest');
  assert(bare.format === '' && bare.body === '1 Island\n1 Forest', 'plain lists work without a header');
}

/* ---------------- cube draft ---------------- */
section('CubeDraft');
{
  const pool = [];
  for (let i = 0; i < 100; i++) pool.push({ name: 'Card ' + i });
  const players = ['a', 'b', 'c'];
  const d = new Draft.CubeDraft(players, pool, { packSize: 5, packsPerPlayer: 2, rng: seededRng(42) });

  assert(d.currentPack('a').length === 5, 'player a opens a 5-card pack');
  assert(d.currentPack('b').length === 5, 'player b opens a 5-card pack');

  // Everyone picks first card; packs should pass left (round 0).
  const aPack = d.currentPack('a');
  players.forEach(id => d.pick(id, d.currentPack(id)[0].uid));
  assert(d.currentPack('b').length === 4, 'b receives a 4-card pack after pass');
  // b's new pack should be what a opened (minus a's pick)
  assert(d.currentPack('b').every(c => aPack.some(o => o.uid === c.uid)), "b holds a's passed pack in round 0 (pass left)");

  // Drain round 0 fully.
  let guard = 0;
  while (!d.finished && d.round === 0 && guard++ < 100) {
    players.forEach(id => { const p = d.currentPack(id); if (p) d.pick(id, p[0].uid); });
  }
  assert(d.round === 1, 'advanced to round 1');
  players.forEach(id => assert(d.currentPack(id).length === 5, id + ' opens a fresh pack in round 1'));

  // Round 1 passes right.
  const bPack2 = d.currentPack('b');
  players.forEach(id => d.pick(id, d.currentPack(id)[0].uid));
  assert(d.currentPack('a').every(c => bPack2.some(o => o.uid === c.uid)), "a holds b's passed pack in round 1 (pass right)");

  guard = 0;
  while (!d.finished && guard++ < 200) {
    players.forEach(id => { const p = d.currentPack(id); if (p) d.pick(id, p[0].uid); });
  }
  assert(d.finished, 'draft finishes');
  players.forEach(id => assert(d.picks[id].length === 10, id + ' ends with 10 cards (2 packs x 5)'));

  // No duplicated uids across all picks.
  const uids = players.flatMap(id => d.picks[id].map(c => c.uid));
  assert(new Set(uids).size === uids.length, 'no card instance was drafted twice');

  // Error cases
  let threw = false;
  try { d.pick('a', 'nope'); } catch (e) { threw = true; }
  assert(threw, 'picking after finish throws');
  threw = false;
  try { new Draft.CubeDraft(['a', 'b'], pool.slice(0, 10), { packSize: 15, packsPerPlayer: 3 }); }
  catch (e) { threw = /Cube too small/.test(e.message); }
  assert(threw, 'undersized cube rejected with a clear error');
}

section('CubeDraft viewFor');
{
  const pool = [];
  for (let i = 0; i < 60; i++) pool.push({ name: 'C' + i });
  const d = new Draft.CubeDraft(['x', 'y'], pool, { packSize: 3, packsPerPlayer: 1, rng: seededRng(7) });
  const v = d.viewFor('x');
  assert(v.pack.length === 3 && v.pickNumber === 1 && v.round === 0, 'initial view sane');
  assert(v.table.length === 2, 'table shows both players');
  d.pick('x', v.pack[0].uid);
  const v2 = d.viewFor('x');
  assert(v2.pack === null && v2.picks.length === 1, 'after picking, x waits for a pass');
}

/* ---------------- jumpstart draft ---------------- */
section('JumpstartDraft');
{
  const packs = [];
  for (let i = 0; i < 8; i++) {
    const cards = [];
    for (let j = 0; j < 20; j++) cards.push({ name: 'P' + i + '-' + j });
    packs.push({ name: 'Theme ' + i, cards });
  }
  const players = ['a', 'b', 'c'];
  const d = new Draft.JumpstartDraft(players, packs, { choices: 3, packsPerPlayer: 2, rng: seededRng(99) });

  assert(d.currentPlayer() === 'a', 'a picks first');
  assert(d.viewFor('a').offer.length === 3, 'a is offered 3 packs');
  assert(d.viewFor('b').offer === null, 'b cannot see the offer');

  let threw = false;
  try { d.pick('b', 0); } catch (e) { threw = /Not your turn/.test(e.message); }
  assert(threw, 'out-of-turn pick rejected');

  d.pick('a', 0);
  assert(d.picks['a'].length === 1 && d.picks['a'][0].cards.length === 20, 'a got a 20-card pack');
  assert(d.currentPlayer() === 'b', 'turn passes to b');

  d.pick('b', 0);
  d.pick('c', 0);
  assert(d.currentPlayer() === 'c', 'snake order: c picks again first in round 2');
  d.pick('c', 0);
  d.pick('b', 0);
  d.pick('a', 0);
  assert(d.finished, 'jumpstart draft finishes');

  players.forEach(id => {
    const deck = Draft.deckFor(d, id);
    assert(deck.length === 40, id + ' ends with a 40-card deck');
  });

  // Each pack went to exactly one player.
  const takenNames = players.flatMap(id => d.picks[id].map(p => p.name));
  assert(new Set(takenNames).size === 6, 'six distinct packs were taken');
  assert(d.pool.length === 2, 'two packs left in the pool');
}

section('JumpstartDraft offer never starves later players');
{
  // 2 players x 2 packs = 4 needed, exactly 4 in pool: offers must shrink to 1.
  const packs = [];
  for (let i = 0; i < 4; i++) packs.push({ name: 'T' + i, cards: [{ name: 'x' }] });
  const d = new Draft.JumpstartDraft(['a', 'b'], packs, { choices: 3, packsPerPlayer: 2, rng: seededRng(1) });
  assert(d.viewFor('a').offer.length === 1, 'with zero slack, only 1 pack is offered');
  d.pick('a', 0); d.pick('b', 0); d.pick('b', 0); d.pick('a', 0);
  assert(d.finished && d.picks['a'].length === 2 && d.picks['b'].length === 2, 'everyone still got 2 packs');

  let threw = false;
  try { new Draft.JumpstartDraft(['a', 'b', 'c'], packs, {}); }
  catch (e) { threw = /Not enough packs/.test(e.message); }
  assert(threw, 'too few packs rejected with a clear error');
}

/* ---------------- 1v1 game engine ---------------- */
section('Game setup');
{
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i }));
  const g = new Game.Game(['a', 'b'], { a: mkDeck('A', 20), b: mkDeck('B', 20) },
    { a: 'Alice', b: 'Bob' }, { rng: seededRng(5) });

  const va = g.viewFor('a');
  assert(va.hand.length === 7, 'a draws an opening hand of 7');
  assert(va.zones.a.libraryCount === 13, "a's library has 13 left");
  assert(va.zones.b.handCount === 7 && va.zones.b.battlefield.length === 0, "b's hand is a count only");
  assert(va.hand[0].uid !== undefined, 'cards carry uids');
  assert(va.life.a === 20 && va.life.b === 20, 'both start at 20 life');
  assert(g.viewFor('b').hand.every(c => c.name.startsWith('B')), "b's view shows b's own hand");

  let threw = false;
  try { new Game.Game(['a'], {}, {}); } catch (e) { threw = /2-8/.test(e.message); }
  assert(threw, 'one player rejected');
  threw = false;
  try { new Game.Game('abcdefghi'.split(''), {}, {}); } catch (e) { threw = /2-8/.test(e.message); }
  assert(threw, 'nine players rejected');
}

section('Multiplayer, commander zone, spectators');
{
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i, type: 'Sorcery' }));
  const deckA = mkDeck('A', 20);
  deckA.push({ name: 'Krenko, Mob Boss', type: 'Legendary Creature — Goblin Warrior', commander: true });
  const g = new Game.Game(['a', 'b', 'c', 'd'],
    { a: deckA, b: mkDeck('B', 20), c: mkDeck('C', 20), d: mkDeck('D', 20) },
    { a: 'Alice', b: 'Bob', c: 'Cleo', d: 'Dan' },
    { rng: seededRng(77), commander: true });

  // 4-player commander basics
  assert(g.players.length === 4, 'four-player game constructed');
  assert(g.viewFor('a').life.a === 40 && g.viewFor('a').life.d === 40, 'commander games start at 40 life');
  const va = g.viewFor('a');
  assert(va.zones.a.command.length === 1 && va.zones.a.command[0].name === 'Krenko, Mob Boss',
    'commander starts in the command zone, not the library');
  assert(va.zones.a.libraryCount === 13, 'commander is not shuffled into the 20-card library (20 - 7 drawn)');
  assert(g.viewFor('c').zones.a.command[0].name === 'Krenko, Mob Boss', 'command zone is public');

  // Turn order cycles through all four players
  g.apply('a', { a: 'passTurn' });
  assert(g.active === 'b', 'turn passes a -> b');
  g.apply('b', { a: 'passTurn' });
  g.apply('c', { a: 'passTurn' });
  g.apply('d', { a: 'passTurn' });
  assert(g.active === 'a' && g.turn === 5, 'turn order wraps around the table');

  // Cast commander, kill it, return it, recast with tax logged
  const kUid = va.zones.a.command[0].uid;
  g.apply('a', { a: 'castCommander', uid: kUid });
  assert(g.viewFor('b').zones.a.battlefield.some(e => e.card.uid === kUid), 'commander cast to battlefield');
  g.apply('a', { a: 'move', uid: kUid, to: 'graveyard' });
  g.apply('a', { a: 'zoneMove', from: 'graveyard', uid: kUid, to: 'battlefield' });
  g.apply('a', { a: 'move', uid: kUid, to: 'graveyard' });
  g.apply('a', { a: 'toCommand', uid: kUid, from: 'graveyard' });
  assert(g.viewFor('a').zones.a.command.length === 1, 'commander returned to the command zone from the graveyard');
  g.apply('a', { a: 'castCommander', uid: kUid });
  assert(/cast #2 — commander tax \{2\}/.test(g.viewFor('b').log.map(l => l.text).join(' ')),
    'recast logs the commander tax');

  // Non-commanders cannot enter the command zone
  g.apply('b', { a: 'play', uid: g.viewFor('b').hand[0].uid });
  const bPerm = g.viewFor('b').zones.b.battlefield[0];
  let threw = false;
  try { g.apply('b', { a: 'toCommand', uid: bPerm.card.uid, from: 'battlefield' }); }
  catch (e) { threw = /Only a commander/.test(e.message); }
  assert(threw, 'non-commander rejected from the command zone');
  assert(g.viewFor('b').zones.b.battlefield.length === 1, 'rejected card stays on the battlefield');

  // Spectator view: public info only
  const spec = g.viewFor(null);
  assert(spec.you === null, 'spectator has no seat');
  assert(spec.hand.length === 0 && spec.library === null && spec.peek === null, 'spectator sees no hidden zones');
  assert(spec.zones.a.battlefield !== undefined && spec.zones.a.handCount === g.viewFor('a').hand.length,
    'spectator sees battlefields and hand counts');
  // a's hand cards (A0..A19 minus public-zone cards) exist ONLY in the hand,
  // so none of their names may appear anywhere in the spectator's JSON.
  const specJson = JSON.stringify(spec);
  const aHandNames = g.viewFor('a').hand.map(c => c.name);
  assert(aHandNames.length > 0 && aHandNames.every(n => !specJson.includes('"' + n + '"')),
    "spectator JSON contains none of a player's hand cards");
}

section('Free multiplayer mulligan, control, reveal, resign');
{
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i }));
  const g = new Game.Game(['a', 'b', 'c'],
    { a: mkDeck('A', 20), b: mkDeck('B', 20), c: mkDeck('C', 20) },
    { a: 'Alice', b: 'Bob', c: 'Cleo' }, { rng: seededRng(42) });

  // First mulligan is free with 3+ players; the second one bottoms 1.
  g.apply('a', { a: 'mulligan' });
  let v = g.viewFor('a');
  assert(v.hand.length === 7 && v.bottoming === 0, 'first mulligan in multiplayer is free (no bottoming)');
  g.apply('a', { a: 'mulligan' });
  v = g.viewFor('a');
  assert(v.bottoming === 1, 'second multiplayer mulligan owes 1 card to the bottom');
  g.apply('a', { a: 'bottomCard', uid: v.hand[0].uid });
  assert(g.viewFor('a').hand.length === 6, 'after bottoming, hand is 6');

  // Mulligans are turn-1 only.
  g.apply('a', { a: 'passTurn' });
  assert(g.active === 'b' && g.turn === 2, 'pass follows turn order from the active player');
  let threw = false;
  try { g.apply('b', { a: 'mulligan' }); } catch (e) { threw = /first turn/.test(e.message); }
  assert(threw, 'mulligan after turn 1 is rejected');

  // Give control: a's permanent lands on b's battlefield.
  const pUid = g.viewFor('a').hand[0].uid;
  g.apply('a', { a: 'play', uid: pUid });
  threw = false;
  try { g.apply('a', { a: 'giveControl', uid: pUid, to: 'a' }); } catch (e) { threw = true; }
  assert(threw, 'giving a card to yourself is rejected');
  g.apply('a', { a: 'giveControl', uid: pUid, to: 'b' });
  v = g.viewFor('c');
  assert(v.zones.a.battlefield.length === 0 && v.zones.b.battlefield.some(e => e.card.uid === pUid),
    'giveControl moves the permanent to the target battlefield, visibly to everyone');
  assert(/gives control of/.test(v.log.map(l => l.text).join(' ')), 'giveControl is logged');

  // detachAll frees another player's aura stuck on your permanent.
  const auraUid = g.viewFor('a').hand[0].uid;
  g.apply('a', { a: 'play', uid: auraUid });
  g.apply('a', { a: 'attach', uid: auraUid, target: pUid }); // a's card onto b's permanent
  assert(g.viewFor('a').zones.a.battlefield.find(e => e.card.uid === auraUid).attachedTo === pUid,
    'attach across players works');
  g.apply('b', { a: 'detachAll', uid: pUid }); // b clears their own permanent
  assert(g.viewFor('a').zones.a.battlefield.find(e => e.card.uid === auraUid).attachedTo === null,
    "detachAll frees other players' cards from your permanent");

  // Reveal top X: public in every view, live as the library changes.
  g.apply('b', { a: 'reveal', n: 2 });
  const topTwo = g.zones.b.library.slice(0, 2).map(c => c.name);
  v = g.viewFor('a');
  assert(v.reveals.b && v.reveals.b.length === 2 && v.reveals.b[0].name === topTwo[0],
    'revealed top cards are visible to opponents');
  g.apply('b', { a: 'draw' });
  assert(g.viewFor('a').reveals.b[0].name === topTwo[1], 'the reveal window slides as cards leave the top');
  g.apply('b', { a: 'endReveal' });
  assert(!g.viewFor('a').reveals.b, 'endReveal hides the library top again');

  // Resign: battlefield cleared, seat becomes a spectator, turn skips them.
  g.apply('b', { a: 'resign' });
  v = g.viewFor('c');
  assert(v.zones.b.battlefield.length === 0, "resigner's permanents leave the battlefield");
  assert(v.resigned.indexOf('b') !== -1, 'view lists the resigned player');
  assert(g.active === 'c', 'active seat moved off the resigner');
  const rv = g.viewFor('b');
  assert(rv.you === null && rv.hand.length === 0, 'resigned player gets the spectator view');
  threw = false;
  try { g.apply('b', { a: 'draw' }); } catch (e) { threw = /resigned/.test(e.message); }
  assert(threw, 'resigned players cannot act');
  g.apply('c', { a: 'passTurn' });
  assert(g.active === 'a', 'turn order skips resigned players');
  threw = false;
  try { g.apply('a', { a: 'giveControl', uid: 'whatever', to: 'b' }); } catch (e) { threw = true; }
  assert(threw, 'cannot give control to a resigned player');

  // clone / tokenFrom respect a count.
  const cUid = g.viewFor('c').hand[0].uid;
  g.apply('c', { a: 'play', uid: cUid });
  g.apply('c', { a: 'clone', uid: cUid, count: 3 });
  assert(g.viewFor('c').zones.c.battlefield.length === 4, 'clone with count 3 makes three copies');
  g.apply('c', { a: 'tokenFrom', card: { name: 'Goblin', pt: '1/1' }, count: 4 });
  assert(g.viewFor('c').zones.c.battlefield.filter(e => e.card.name === 'Goblin').length === 4,
    'tokenFrom with count 4 makes four tokens');
}

section('Reveal hand + discard at random');
{
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i }));
  const g = new Game.Game(['a', 'b'], { a: mkDeck('A', 20), b: mkDeck('B', 20) },
    { a: 'Alice', b: 'Bob' }, { rng: seededRng(11) });

  // Hidden by default: b's view has no openHands entry for a.
  assert(!g.viewFor('b').openHands.a, 'hands start hidden');
  g.apply('a', { a: 'revealHand' });
  let v = g.viewFor('b');
  assert(v.openHands.a && v.openHands.a.length === 7, "revealHand shows a's 7 cards to the opponent");
  assert(v.openHands.a[0].name === g.viewFor('a').hand[0].name, 'revealed cards are the real hand');
  assert(/reveals their hand: /.test(v.log.map(l => l.text).join(' ')), 'reveal is logged with names');
  const spec = g.viewFor(null);
  assert(spec.openHands.a && spec.openHands.a.length === 7, 'spectators see the revealed hand too');

  // Live: a draw while revealed shows up.
  g.apply('a', { a: 'draw' });
  assert(g.viewFor('b').openHands.a.length === 8, 'the revealed hand follows draws live');

  // Toggle off hides it again.
  g.apply('a', { a: 'revealHand' });
  v = g.viewFor('b');
  assert(!v.openHands.a && v.zones.a.handCount === 8, 'toggling again hides the hand (count only)');
  assert(/stops revealing their hand/.test(v.log.map(l => l.text).join(' ')), 'un-reveal is logged');

  // Discard at random: hand shrinks, graveyard grows, choice is engine-side.
  g.apply('b', { a: 'discardRandom' });
  v = g.viewFor('a');
  assert(v.zones.b.handCount === 6 && v.zones.b.graveyard.length === 1, 'discardRandom hand -> graveyard');
  assert(/discards B\d+ at random/.test(v.log.map(l => l.text).join(' ')), 'random discard logs the card');
  for (let i = 0; i < 6; i++) g.apply('b', { a: 'discardRandom' });
  let threw = false;
  try { g.apply('b', { a: 'discardRandom' }); } catch (e) { threw = /empty/.test(e.message); }
  assert(threw, 'random discard from an empty hand is rejected');

  // Resigning while revealing stops the reveal.
  g.apply('a', { a: 'revealHand' });
  g.apply('a', { a: 'resign' });
  assert(!g.viewFor('b').openHands.a, 'resigning clears an open hand reveal');
}

section('Game actions');
{
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i }));
  const g = new Game.Game(['a', 'b'], { a: mkDeck('A', 20), b: mkDeck('B', 20) },
    { a: 'Alice', b: 'Bob' }, { rng: seededRng(9) });

  g.apply('a', { a: 'draw' });
  assert(g.viewFor('a').hand.length === 8, 'draw adds a card');

  const uid = g.viewFor('a').hand[0].uid;
  g.apply('a', { a: 'play', uid });
  let v = g.viewFor('a');
  assert(v.hand.length === 7 && v.zones.a.battlefield.length === 1, 'play moves hand -> battlefield');
  assert(g.viewFor('b').zones.a.battlefield.length === 1, 'opponent sees the permanent');

  g.apply('a', { a: 'tap', uid });
  assert(g.viewFor('b').zones.a.battlefield[0].tapped === true, 'tap is public');
  g.apply('a', { a: 'untapAll' });
  assert(g.viewFor('a').zones.a.battlefield[0].tapped === false, 'untapAll works');

  g.apply('a', { a: 'counter', uid, d: 2 });
  g.apply('a', { a: 'counter', uid, d: -1 });
  assert(g.viewFor('a').zones.a.battlefield[0].counters === 1, 'counters adjust and floor at 0');

  g.apply('a', { a: 'move', uid, to: 'graveyard' });
  v = g.viewFor('a');
  assert(v.zones.a.battlefield.length === 0 && v.zones.a.graveyard.length === 1, 'move -> graveyard');
  g.apply('a', { a: 'recover', uid });
  assert(g.viewFor('a').hand.length === 8, 'recover returns it to hand');

  g.apply('a', { a: 'life', d: -3 });
  assert(g.viewFor('b').life.a === 17, 'life change is public');

  g.apply('a', { a: 'mulligan' });
  v = g.viewFor('a');
  // Before the mulligan: hand 8 + library 12 = 20. All 8 go back (-> 20), 7 drawn (-> 13).
  assert(v.hand.length === 7 && v.zones.a.libraryCount === 13, 'mulligan reshuffles and draws 7');

  assert(g.active === 'a', 'a starts active');
  g.apply('b', { a: 'passTurn' });
  assert(g.active === 'b' && g.turn === 2,
    'passTurn advances from the ACTIVE player in turn order, no matter who pressed it');

  let threw = false;
  try { g.apply('b', { a: 'play', uid: 'not-a-card' }); } catch (e) { threw = /hand/.test(e.message); }
  assert(threw, 'playing a card you do not hold is rejected');
  threw = false;
  try { g.apply('b', { a: 'tap', uid: g.viewFor('a').hand[0].uid }); } catch (e) { threw = true; }
  assert(threw, "touching the opponent's cards is rejected");

  assert(g.viewFor('a').log.length > 0 && g.viewFor('a').log.every(l => typeof l.text === 'string'),
    'actions are logged');
}

section('Game rows, dice, attach, search');
{
  const deckA = [
    { name: 'Mountain' }, { name: 'Mountain' }, { name: 'Forest' },
    { name: 'Grizzly Bears', type: 'Creature — Bear' },
    { name: 'Bonesplitter', type: 'Artifact — Equipment' },
    { name: 'Pacifism', type: 'Enchantment — Aura' },
    { name: 'Weird Terrain', type: 'Land — Weird' }
  ];
  while (deckA.length < 15) deckA.push({ name: 'Filler' + deckA.length, type: 'Sorcery' });
  const deckB = Array.from({ length: 15 }, (_, i) => ({ name: 'B' + i, type: 'Creature' }));
  const g = new Game.Game(['a', 'b'], { a: deckA, b: deckB }, { a: 'Alice', b: 'Bob' }, { rng: seededRng(3) });

  // Row routing: draw the whole deck, play everything, check rows by type/name.
  const hand = () => g.viewFor('a').hand;
  while (g.viewFor('a').zones.a.libraryCount) g.apply('a', { a: 'draw' });
  while (hand().length) g.apply('a', { a: 'play', uid: hand()[0].uid });
  const bf = () => g.viewFor('a').zones.a.battlefield;
  assert(bf().every(e => e.row === (( /\bLand\b/i.test(e.card.type || '') || /^(Mountain|Forest)$/.test(e.card.name)) ? 'land' : 'main')),
    'lands (typed or basic-by-name) route to the land row, spells to main');

  // Row toggle
  const anyMain = bf().find(e => e.row === 'main');
  g.apply('a', { a: 'row', uid: anyMain.card.uid });
  assert(bf().find(e => e.card.uid === anyMain.card.uid).row === 'land', 'row toggle works');
  g.apply('a', { a: 'row', uid: anyMain.card.uid });

  // Dice + coin are logged deterministically under seeded rng
  g.apply('a', { a: 'roll', sides: 20 });
  g.apply('b', { a: 'coin' });
  const log = g.viewFor('b').log.map(l => l.text).join(' | ');
  assert(/Alice rolls a d20: \d+\./.test(log), 'die roll is logged with a result');
  assert(/Bob flips a coin: (HEADS|TAILS)\./.test(log), 'coin flip is logged');
  let threw = false;
  try { g.apply('a', { a: 'roll', sides: 1 }); } catch (e) { threw = true; }
  assert(threw, 'nonsense die rejected');

  // Attach: equipment onto a creature; aura onto opponent's creature.
  const eq = bf().find(e => e.card.name === 'Bonesplitter');
  const bear = bf().find(e => e.card.name === 'Grizzly Bears');
  g.apply('a', { a: 'attach', uid: eq.card.uid, target: bear.card.uid });
  assert(bf().find(e => e.card.name === 'Bonesplitter').attachedTo === bear.card.uid, 'equipment attaches');

  g.apply('b', { a: 'play', uid: g.viewFor('b').hand[0].uid });
  const oppCreature = g.viewFor('a').zones.b.battlefield[0];
  const aura = bf().find(e => e.card.name === 'Pacifism');
  g.apply('a', { a: 'attach', uid: aura.card.uid, target: oppCreature.card.uid });
  assert(bf().find(e => e.card.name === 'Pacifism').attachedTo === oppCreature.card.uid,
    "aura attaches across the table to the opponent's creature");

  threw = false;
  try { g.apply('a', { a: 'attach', uid: bear.card.uid, target: eq.card.uid }); }
  catch (e) { threw = /itself attached/.test(e.message); }
  assert(threw, 'cannot attach onto an attached card');

  // Target leaves -> auto-detach
  g.apply('b', { a: 'move', uid: oppCreature.card.uid, to: 'graveyard' });
  assert(bf().find(e => e.card.name === 'Pacifism').attachedTo === null, 'attachment auto-detaches when target leaves');
  g.apply('a', { a: 'detach', uid: eq.card.uid });
  assert(bf().find(e => e.card.name === 'Bonesplitter').attachedTo === null, 'manual detach works');

  // Library search: hidden until searching, revealed only to owner.
  assert(g.viewFor('a').library === null, 'library hidden while not searching');
  threw = false;
  try { g.apply('a', { a: 'takeFromLibrary', uid: 'x', to: 'hand' }); } catch (e) { threw = /Search/.test(e.message); }
  assert(threw, 'cannot take from library without searching');

  // Shuffle a few permanents back in so there is something to search for.
  bf().filter(e => !e.attachedTo).slice(0, 4)
    .forEach(e => g.apply('a', { a: 'move', uid: e.card.uid, to: 'library' }));

  g.apply('a', { a: 'searchLibrary' });
  const va = g.viewFor('a');
  assert(Array.isArray(va.library) && va.library.length === va.zones.a.libraryCount, 'searcher sees full library');
  assert(g.viewFor('b').library === null, "opponent still can't see it");

  const libBefore = va.library.length;
  const handBefore = va.hand.length;
  g.apply('a', { a: 'takeFromLibrary', uid: va.library[0].uid, to: 'hand' });
  g.apply('a', { a: 'takeFromLibrary', uid: va.library[1].uid, to: 'battlefield' });
  const va2 = g.viewFor('a');
  assert(va2.hand.length === handBefore + 1 && va2.library.length === libBefore - 2, 'tutored to hand and battlefield');
  const toHandLog = g.viewFor('b').log.map(l => l.text).join(' | ');
  assert(/puts a card from their library into their hand/.test(toHandLog) &&
         !new RegExp('puts ' + va2.hand[va2.hand.length - 1].name + " from").test(toHandLog),
    'tutor-to-hand is logged without naming the card');

  g.apply('a', { a: 'endSearch' });
  assert(g.viewFor('a').library === null && g.viewFor('a').searching === false, 'endSearch hides the library again');
}

section('Battlefield drag-reorder');
{
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i, type: 'Sorcery' }));
  const g = new Game.Game(['a', 'b'], { a: mkDeck('A', 20), b: mkDeck('B', 20) },
    { a: 'Alice', b: 'Bob' }, { rng: seededRng(55) });
  // Play three cards: order A?, A?, A? in the main row.
  for (let i = 0; i < 3; i++) g.apply('a', { a: 'play', uid: g.viewFor('a').hand[0].uid });
  const bf = () => g.viewFor('a').zones.a.battlefield;
  const [c1, c2, c3] = bf().map(e => e.card.uid);

  g.apply('a', { a: 'reorder', uid: c3, row: 'main', before: c1 });
  assert(bf().map(e => e.card.uid).join() === [c3, c1, c2].join(), 'reorder before a target card');

  g.apply('a', { a: 'reorder', uid: c1, row: 'main', before: null });
  assert(bf().map(e => e.card.uid).join() === [c3, c2, c1].join(), 'reorder to the end');

  g.apply('a', { a: 'reorder', uid: c2, row: 'land', before: null });
  assert(bf().find(e => e.card.uid === c2).row === 'land', 'drag between rows changes the row');

  const logLen = g.viewFor('a').log.length;
  g.apply('a', { a: 'reorder', uid: c2, row: 'main', before: c3 });
  assert(g.viewFor('a').log.length === logLen, 'reordering is not logged (cosmetic)');

  assert((() => { try { g.apply('a', { a: 'reorder', uid: 'nope', row: 'main', before: null }); return false; }
    catch (e) { return /battlefield/.test(e.message); } })(), 'unknown card rejected');
}

section('Notes, clones, counter kinds, hand order, player counters, manifest');
{
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i, type: 'Sorcery', pt: '' }));
  const g = new Game.Game(['a', 'b'], { a: mkDeck('A', 20), b: mkDeck('B', 20) },
    { a: 'Alice', b: 'Bob' }, { rng: seededRng(66) });
  const bf = () => g.viewFor('a').zones.a.battlefield;

  g.apply('a', { a: 'play', uid: g.viewFor('a').hand[0].uid });
  const uid = bf()[0].card.uid;

  // Notes
  g.apply('a', { a: 'note', uid, text: 'blocked by 2/2' });
  assert(bf()[0].note === 'blocked by 2/2', 'note set');
  assert(g.viewFor('b').zones.a.battlefield[0].note === 'blocked by 2/2', 'note is public');
  g.apply('a', { a: 'note', uid, text: '' });
  assert(bf()[0].note === '', 'empty note clears');

  // Three counter kinds
  g.apply('a', { a: 'counter', uid, d: 2, kind: 1 });
  g.apply('a', { a: 'counter', uid, d: 3, kind: 2 });
  g.apply('a', { a: 'counter', uid, d: 1, kind: 3 });
  let e = bf()[0];
  assert(e.counters === 2 && e.counters2 === 3 && e.counters3 === 1, 'three independent counter pools');
  g.apply('a', { a: 'counter', uid, d: -5, kind: 2 });
  assert(bf()[0].counters2 === 0 && bf()[0].counters === 2, 'kinds clamp independently');
  assert(/red counter/.test(g.viewFor('b').log.map(l => l.text).join(' ')), 'kind label logged');

  // Clone
  g.apply('a', { a: 'clone', uid });
  assert(bf().length === 2, 'copy created');
  const copy = bf().find(en => en.card.uid !== uid);
  assert(copy.card.name === bf()[0].card.name && copy.card.token === true && copy.counters === 0,
    'copy shares the name, is a token, and starts clean');
  g.apply('a', { a: 'move', uid: copy.card.uid, to: 'graveyard' });
  assert(bf().length === 1 && g.viewFor('a').zones.a.graveyard.length === 0, 'copy ceases to exist');

  // Hand reorder (silent, private)
  const handBefore = g.viewFor('a').hand.map(c => c.uid);
  const logLen = g.viewFor('a').log.length;
  g.apply('a', { a: 'handOrder', uid: handBefore[2], before: handBefore[0] });
  const handAfter = g.viewFor('a').hand.map(c => c.uid);
  assert(handAfter.join() === [handBefore[2], handBefore[0], handBefore[1]].concat(handBefore.slice(3)).join(),
    'hand card moved before target');
  assert(g.viewFor('a').log.length === logLen, 'hand reorder is silent');

  // Player counters
  g.apply('a', { a: 'pcounter', name: 'Poison', d: 1 });
  g.apply('a', { a: 'pcounter', name: 'poison', d: 2 });
  assert(g.viewFor('b').pcounters.a.poison === 3, 'poison accumulates (case-insensitive) and is public');
  assert(/3 poison counter/.test(g.viewFor('b').log.map(l => l.text).join(' ')), 'player counter logged');
  g.apply('a', { a: 'pcounter', name: 'poison', d: -5 });
  assert(g.viewFor('a').pcounters.a.poison === undefined, 'zeroed counters disappear');

  // Manifest from the scry window
  g.apply('a', { a: 'peek', n: 2 });
  const topUid = g.viewFor('a').peek.cards[0].uid;
  const topName = g.viewFor('a').peek.cards[0].name;
  g.apply('a', { a: 'peekMove', uid: topUid, to: 'manifest' });
  const man = bf().find(en => en.card.uid === topUid);
  assert(man && man.faceDown === true, 'manifested card is face down on the battlefield');
  assert(g.viewFor('a').peek.cards.length === 1, 'peek window shrank');
  const blog = g.viewFor('b').log.map(l => l.text).join(' ');
  assert(/manifests a card from the top of their library face down/.test(blog) && blog.indexOf(topName) === -1,
    'manifest is logged without the card name');
  assert(JSON.stringify(g.viewFor('b')).indexOf('"' + topName + '"') === -1,
    "manifested card's identity absent from opponent's view");
  g.apply('a', { a: 'endPeek' });
}

section('toLib (library top/bottom) + tokenFrom');
{
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i, type: 'Sorcery' }));
  const g = new Game.Game(['a', 'b'], { a: mkDeck('A', 20), b: mkDeck('B', 20) },
    { a: 'Alice', b: 'Bob' }, { rng: seededRng(88) });
  const lib = () => g.zones.a.library;

  // Hand -> top (nameless log)
  const handCard = g.viewFor('a').hand[0];
  g.apply('a', { a: 'toLib', from: 'hand', uid: handCard.uid, pos: 'top' });
  assert(lib()[0].uid === handCard.uid, 'hand card went to the top of the library');
  const log1 = g.viewFor('b').log.map(l => l.text).join(' | ');
  assert(/puts a card from their hand on top of their library/.test(log1) && log1.indexOf(handCard.name) === -1,
    'hand-to-library is logged without the name');

  // Hand -> bottom
  const handCard2 = g.viewFor('a').hand[0];
  g.apply('a', { a: 'toLib', from: 'hand', uid: handCard2.uid, pos: 'bottom' });
  assert(lib()[lib().length - 1].uid === handCard2.uid, 'hand card went to the bottom');

  // Battlefield -> top (named), token ceases
  g.apply('a', { a: 'play', uid: g.viewFor('a').hand[0].uid });
  const perm = g.viewFor('a').zones.a.battlefield[0];
  g.apply('a', { a: 'toLib', from: 'battlefield', uid: perm.card.uid, pos: 'top' });
  assert(lib()[0].uid === perm.card.uid, 'battlefield card went to the top');
  assert(new RegExp('puts ' + perm.card.name + ' on top').test(g.viewFor('b').log.map(l => l.text).join(' ')),
    'battlefield-to-library is logged by name');
  g.apply('a', { a: 'token', name: 'Treasure', count: 1 });
  const tok = g.viewFor('a').zones.a.battlefield.find(e => e.card.token);
  const libLen = lib().length;
  g.apply('a', { a: 'toLib', from: 'battlefield', uid: tok.card.uid, pos: 'top' });
  assert(lib().length === libLen, 'a token sent to the library ceases to exist instead');

  // Graveyard -> bottom
  g.apply('a', { a: 'discard', uid: g.viewFor('a').hand[0].uid });
  const gyCard = g.viewFor('a').zones.a.graveyard[0];
  g.apply('a', { a: 'toLib', from: 'graveyard', uid: gyCard.uid, pos: 'bottom' });
  assert(lib()[lib().length - 1].uid === gyCard.uid, 'graveyard card went to the bottom');

  // tokenFrom with resolved data
  g.apply('a', { a: 'tokenFrom', card: { name: 'Goblin', img: 'https://x/goblin.jpg', type: 'Token Creature — Goblin', text: 'Haste?', pt: '1/1' } });
  const gob = g.viewFor('b').zones.a.battlefield.find(e => e.card.name === 'Goblin');
  assert(gob && gob.card.token === true && gob.card.img === 'https://x/goblin.jpg' && gob.card.pt === '1/1',
    'tokenFrom creates a token with art and p/t, visible to the opponent');
  assert(/creates a Goblin token/.test(g.viewFor('b').log.map(l => l.text).join(' ')), 'tokenFrom logged');
  assert((() => { try { g.apply('a', { a: 'tokenFrom', card: {} }); return false; } catch (e) { return true; } })(),
    'nameless tokenFrom rejected');
}

section('Game tokens + peek (scry)');
{
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i, type: 'Sorcery' }));
  const g = new Game.Game(['a', 'b'], { a: mkDeck('A', 20), b: mkDeck('B', 20) },
    { a: 'Alice', b: 'Bob' }, { rng: seededRng(11) });
  const bf = () => g.viewFor('a').zones.a.battlefield;

  // Tokens
  g.apply('a', { a: 'token', name: 'Goblin', count: 3 });
  assert(bf().length === 3 && bf().every(e => e.card.token && e.card.name === 'Goblin'), '3 Goblin tokens created');
  assert(bf().every(e => e.row === 'main'), 'tokens land in the main row');
  assert(g.viewFor('b').zones.a.battlefield.length === 3, 'opponent sees the tokens');

  g.apply('a', { a: 'tap', uid: bf()[0].card.uid });
  assert(bf()[0].tapped, 'tokens can tap');

  const gyBefore = g.viewFor('a').zones.a.graveyard.length;
  g.apply('a', { a: 'move', uid: bf()[0].card.uid, to: 'graveyard' });
  const va = g.viewFor('a');
  assert(va.zones.a.battlefield.length === 2 && va.zones.a.graveyard.length === gyBefore,
    'a token sent to the graveyard ceases to exist instead');
  assert(/token ceases to exist/.test(g.viewFor('b').log.map(l => l.text).join(' ')), 'token death is logged');

  assert((() => { try { g.apply('a', { a: 'token', name: '   ' }); return false; } catch (e) { return true; } })(),
    'blank token name rejected');
  g.apply('a', { a: 'token', name: 'Rat', count: 99 });
  assert(bf().filter(e => e.card.name === 'Rat').length === 10, 'token count clamps at 10');

  // Peek / scry
  assert(g.viewFor('a').peek === null, 'no peek window by default');
  assert((() => { try { g.apply('a', { a: 'peekMove', uid: 'x', to: 'top' }); return false; } catch (e) { return /Look at/.test(e.message); } })(),
    'peekMove requires peeking');

  g.apply('a', { a: 'peek', n: 3 });
  let pk = g.viewFor('a').peek;
  assert(pk && pk.cards.length === 3, 'peek reveals exactly 3 cards');
  assert(g.viewFor('b').peek === null, 'opponent sees no peek window');
  const libCount = g.viewFor('a').zones.a.libraryCount;

  // Card #4 (outside the window) must be untouchable.
  const hidden4 = g.zones.a.library[3];
  assert((() => { try { g.apply('a', { a: 'peekMove', uid: hidden4.uid, to: 'hand' }); return false; } catch (e) { return /among the viewed/.test(e.message); } })(),
    'cannot touch a card below the peek window');

  const [c1, c2, c3] = pk.cards;
  g.apply('a', { a: 'peekMove', uid: c3.uid, to: 'bottom' });
  pk = g.viewFor('a').peek;
  assert(pk.cards.length === 2 && g.zones.a.library[g.zones.a.library.length - 1].uid === c3.uid,
    'bottom: window shrinks and card is on the bottom');

  g.apply('a', { a: 'peekMove', uid: c2.uid, to: 'top' });
  pk = g.viewFor('a').peek;
  assert(pk.cards[0].uid === c2.uid && pk.cards[1].uid === c1.uid && pk.cards.length === 2,
    'top: reorders within the window');

  const handBefore = g.viewFor('a').hand.length;
  g.apply('a', { a: 'peekMove', uid: c2.uid, to: 'hand' });
  assert(g.viewFor('a').hand.length === handBefore + 1, 'peek card to hand');
  const blog = g.viewFor('b').log.map(l => l.text).join(' | ');
  assert(/puts a card from the top of their library into their hand/.test(blog) &&
         blog.indexOf(c2.name + ' from the top') === -1,
    'to-hand from peek is logged without the card name');

  g.apply('a', { a: 'endPeek' });
  assert(g.viewFor('a').peek === null, 'endPeek closes the window');
  assert(g.viewFor('a').zones.a.libraryCount === libCount - 1 && g.zones.a.library[0].uid === c1.uid,
    'library order preserved after peeking (no shuffle)');
}

section('London mulligan + zone moves');
{
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i, type: 'Sorcery' }));
  const g = new Game.Game(['a', 'b'], { a: mkDeck('A', 20), b: mkDeck('B', 20) },
    { a: 'Alice', b: 'Bob' }, { rng: seededRng(21) });
  const va = () => g.viewFor('a');

  assert(va().bottoming === 0, 'no bottoming owed at game start');
  assert((() => { try { g.apply('a', { a: 'bottomCard', uid: va().hand[0].uid }); return false; } catch (e) { return /do not owe/.test(e.message); } })(),
    'bottomCard rejected when nothing is owed');

  // Mulligan 1: draw 7, owe 1.
  g.apply('a', { a: 'mulligan' });
  assert(va().hand.length === 7 && va().bottoming === 1, 'first mulligan: 7 cards, 1 owed to the bottom');
  const owed = va().hand[2];
  g.apply('a', { a: 'bottomCard', uid: owed.uid });
  assert(va().hand.length === 6 && va().bottoming === 0, 'bottoming clears: 6-card hand');
  assert(g.zones.a.library[g.zones.a.library.length - 1].uid === owed.uid, 'the card went to the actual bottom');

  // Mulligan 2: draw 7 again, owe 2.
  g.apply('a', { a: 'mulligan' });
  assert(va().hand.length === 7 && va().bottoming === 2, 'second mulligan: 7 cards, 2 owed');
  g.apply('a', { a: 'bottomCard', uid: va().hand[0].uid });
  g.apply('a', { a: 'bottomCard', uid: va().hand[0].uid });
  assert(va().hand.length === 5 && va().bottoming === 0, 'after bottoming 2: 5-card hand');
  assert(/mulligan #2/.test(g.viewFor('b').log.map(l => l.text).join(' ')), 'mulligan count is logged');

  // Zone moves: graveyard/exile -> anywhere.
  g.apply('a', { a: 'discard', uid: va().hand[0].uid });
  g.apply('a', { a: 'discard', uid: va().hand[0].uid });
  const [gy1, gy2] = va().zones.a.graveyard;
  g.apply('a', { a: 'zoneMove', from: 'graveyard', uid: gy1.uid, to: 'battlefield' });
  assert(va().zones.a.battlefield.some(e => e.card.uid === gy1.uid), 'graveyard -> battlefield (reanimation)');
  g.apply('a', { a: 'zoneMove', from: 'graveyard', uid: gy2.uid, to: 'exile' });
  assert(va().zones.a.exile.some(c => c.uid === gy2.uid), 'graveyard -> exile');
  g.apply('a', { a: 'zoneMove', from: 'exile', uid: gy2.uid, to: 'hand' });
  assert(va().hand.some(c => c.uid === gy2.uid), 'exile -> hand (impulse retrieval)');
  const libBefore = va().zones.a.libraryCount;
  g.apply('a', { a: 'discard', uid: gy2.uid });
  g.apply('a', { a: 'zoneMove', from: 'graveyard', uid: gy2.uid, to: 'library' });
  assert(va().zones.a.libraryCount === libBefore + 1, 'graveyard -> shuffled into library');

  assert((() => { try { g.apply('a', { a: 'zoneMove', from: 'hand', uid: 'x', to: 'exile' }); return false; } catch (e) { return /Bad source/.test(e.message); } })(),
    'zoneMove only serves graveyard/exile');
  assert((() => { try { g.apply('a', { a: 'zoneMove', from: 'graveyard', uid: 'nope', to: 'hand' }); return false; } catch (e) { return /not in your graveyard/.test(e.message); } })(),
    'missing card rejected');
}

section('Face-down cards + transform');
{
  const delver = {
    name: 'Delver of Secrets // Insectile Aberration',
    img: 'front.jpg', cost: '{U}', type: 'Creature — Human Wizard',
    text: 'At the beginning of your upkeep...', pt: '1/1',
    back: { name: 'Insectile Aberration', img: 'back.jpg', cost: '', type: 'Creature — Human Insect', text: 'Flying', pt: '3/2' }
  };
  const mkDeck = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: prefix + i, type: 'Sorcery' }));
  const deckA = [Object.assign({}, delver)].concat(mkDeck('A', 14));
  const g = new Game.Game(['a', 'b'], { a: deckA, b: mkDeck('B', 15) },
    { a: 'Alice', b: 'Bob' }, { rng: seededRng(31) });

  // Draw everything so we definitely hold the Delver.
  while (g.viewFor('a').zones.a.libraryCount) g.apply('a', { a: 'draw' });

  // Play a normal card face down; opponent must learn nothing.
  const secret = g.viewFor('a').hand.find(c => !c.back);
  g.apply('a', { a: 'playFaceDown', uid: secret.uid });
  const ownEntry = g.viewFor('a').zones.a.battlefield[0];
  assert(ownEntry.faceDown && ownEntry.card.name === secret.name, 'owner still sees the real card');
  assert(ownEntry.row === 'main', 'face-down cards go to the main row even if lands');
  const oppSees = g.viewFor('b').zones.a.battlefield[0];
  assert(oppSees.faceDown && oppSees.card.facedown && oppSees.card.name === 'Face-down card',
    'opponent gets a stub');
  assert(JSON.stringify(g.viewFor('b')).indexOf(secret.name) === -1,
    "the card's name appears NOWHERE in the opponent's entire view");
  assert(!/plays a card face down\./.test(g.viewFor('b').log.map(l => l.text).join(' ')) === false,
    'face-down play is logged namelessly');

  // Turn it face up: revealed and logged by name.
  g.apply('a', { a: 'faceDown', uid: secret.uid });
  assert(g.viewFor('b').zones.a.battlefield[0].card.name === secret.name, 'face up: opponent now sees it');
  assert(new RegExp('face up: it is ' + secret.name).test(g.viewFor('b').log.map(l => l.text).join(' ')),
    'reveal is logged with the name');

  // Transform.
  const dv = g.viewFor('a').hand.find(c => c.back);
  g.apply('a', { a: 'play', uid: dv.uid });
  assert((() => { try { g.apply('a', { a: 'transform', uid: secret.uid }); return false; } catch (e) { return /no other face/.test(e.message); } })(),
    'single-faced cards cannot transform');
  g.apply('a', { a: 'transform', uid: dv.uid });
  const flippedEntry = g.viewFor('b').zones.a.battlefield.find(e => e.card.uid === dv.uid);
  assert(flippedEntry.flipped === true && flippedEntry.card.back.name === 'Insectile Aberration',
    'transform is visible to the opponent');
  assert(/transforms .+ into Insectile Aberration/.test(g.viewFor('b').log.map(l => l.text).join(' ')),
    'transform is logged');
  g.apply('a', { a: 'transform', uid: dv.uid });
  assert(g.viewFor('a').zones.a.battlefield.find(e => e.card.uid === dv.uid).flipped === false,
    'transform back works');

  // Face down forbids transform; turning face down un-flips.
  g.apply('a', { a: 'transform', uid: dv.uid });
  g.apply('a', { a: 'faceDown', uid: dv.uid });
  const fdDv = g.viewFor('a').zones.a.battlefield.find(e => e.card.uid === dv.uid);
  assert(fdDv.faceDown && fdDv.flipped === false, 'turning face down resets the flip');
  assert((() => { try { g.apply('a', { a: 'transform', uid: dv.uid }); return false; } catch (e) { return /face up first/.test(e.message); } })(),
    'cannot transform while face down');
}

section('Scryfall slim() back faces');
{
  const fixture = {
    object: 'list', not_found: [],
    data: [{
      object: 'card', name: 'Delver of Secrets // Insectile Aberration',
      color_identity: ['U'],
      card_faces: [
        { name: 'Delver of Secrets', mana_cost: '{U}', type_line: 'Creature — Human Wizard',
          oracle_text: 'At the beginning of your upkeep, look at the top card...', power: '1', toughness: '1',
          image_uris: { normal: 'https://x/front.jpg' } },
        { name: 'Insectile Aberration', mana_cost: '', type_line: 'Creature — Human Insect',
          oracle_text: 'Flying', power: '3', toughness: '2',
          image_uris: { normal: 'https://x/back.jpg' } }
      ]
    }, {
      object: 'card', name: 'Fire // Ice', type_line: 'Instant // Instant', color_identity: ['U', 'R'],
      prices: { usd: '12.34' },
      image_uris: { normal: 'https://x/fireice.jpg' }, mana_cost: '',
      card_faces: [
        { name: 'Fire', mana_cost: '{1}{R}', oracle_text: 'Fire deals 2 damage...' },
        { name: 'Ice', mana_cost: '{1}{U}', oracle_text: 'Tap target permanent...' }
      ]
    }]
  };
  global.fetch = async () => ({ ok: true, json: async () => fixture });
  const Scryfall = require('../js/scryfall.js');
  Scryfall.resolve(['Delver of Secrets // Insectile Aberration', 'Fire // Ice']).then(r => {
    const dv = r.cards['delver of secrets // insectile aberration'];
    assert(dv.img === 'https://x/front.jpg' && dv.pt === '1/1', 'DFC front face is the card');
    assert(dv.back && dv.back.name === 'Insectile Aberration' && dv.back.img === 'https://x/back.jpg' &&
      dv.back.pt === '3/2' && dv.back.text === 'Flying', 'DFC back face captured');
    const fi = r.cards['fire // ice'];
    assert(!fi.back && fi.img === 'https://x/fireice.jpg' && /Fire deals[\s\S]*Tap target/.test(fi.text),
      'split cards stay single-faced with joined text');
    assert(fi.price === '12.34', 'TCGplayer (usd) price rides along on the slim card');
    assert(dv.price === null, 'no price data -> null (the UI shows ??)');

    // ---- Moxfield single-slash names resolve without manual edits ----
    section('Scryfall slash-name resolution');
    let requestedIdentifiers = null;
    const roomFixture = {
      object: 'list', not_found: [],
      data: [{
        object: 'card', name: 'Funeral Room // Awakening Hall',
        type_line: 'Enchantment — Room // Enchantment — Room', color_identity: ['B'],
        image_uris: { normal: 'https://x/room.jpg' }, mana_cost: '',
        card_faces: [
          { name: 'Funeral Room', mana_cost: '{1}{B}', oracle_text: 'Whenever a creature dies...' },
          { name: 'Awakening Hall', mana_cost: '{5}{B}{B}', oracle_text: 'When you unlock this door...' }
        ]
      }, {
        object: 'card', name: 'Delver of Secrets // Insectile Aberration', color_identity: ['U'],
        card_faces: [
          { name: 'Delver of Secrets', mana_cost: '{U}', type_line: 'Creature — Human Wizard',
            oracle_text: 'At the beginning...', power: '1', toughness: '1',
            image_uris: { normal: 'https://x/front.jpg' } },
          { name: 'Insectile Aberration', type_line: 'Creature — Human Insect',
            oracle_text: 'Flying', power: '3', toughness: '2',
            image_uris: { normal: 'https://x/back.jpg' } }
        ]
      }]
    };
    global.fetch = async (url, opts) => {
      requestedIdentifiers = JSON.parse(opts.body).identifiers.map(i => i.name);
      return { ok: true, json: async () => roomFixture };
    };
    return Scryfall.resolve([
      'Funeral Room / Awakening Hall',   // Moxfield single slash
      'Delver of Secrets / Insectile Aberration'
    ]).then(r2 => {
      assert(requestedIdentifiers.every(n => !n.includes('/')),
        'API is queried by front-face name (no slashes sent): ' + JSON.stringify(requestedIdentifiers));
      const room = r2.cards['funeral room / awakening hall'];
      assert(!!room && room.name === 'Funeral Room // Awakening Hall' && room.img === 'https://x/room.jpg',
        'single-slash room card resolves to the canonical card');
      const dv = r2.cards['delver of secrets / insectile aberration'];
      assert(!!dv && dv.back && dv.back.name === 'Insectile Aberration',
        'single-slash DFC resolves with its back face');
      assert(r2.notFound.length === 0, 'nothing reported missing');

      // ---- back-face name collisions: standalone card must win ----
      section('Scryfall back-face collision (Sign in Blood)');
      const dfcCard = {
        object: 'card', name: 'Scheming Silvertongue // Sign in Blood', layout: 'prepare',
        color_identity: ['B'], image_uris: { normal: 'https://x/dfc.jpg' }, mana_cost: '',
        card_faces: [
          { name: 'Scheming Silvertongue', mana_cost: '{1}{B}', oracle_text: 'Prepare...' },
          { name: 'Sign in Blood', mana_cost: '{B}{B}', oracle_text: 'Target player draws two cards...' }
        ]
      };
      const standalone = {
        object: 'card', name: 'Sign in Blood', layout: 'normal', color_identity: ['B'],
        mana_cost: '{B}{B}', type_line: 'Sorcery', power: undefined,
        oracle_text: 'Target player draws two cards and loses 2 life.',
        image_uris: { normal: 'https://x/standalone.jpg' }
      };
      // The collection endpoint (as observed live) returns the DFC for BOTH
      // identifiers; only named?exact serves the standalone card.
      const fetchLog = [];
      global.fetch = async (url, opts) => {
        fetchLog.push(url);
        if (String(url).includes('/cards/named')) {
          return { ok: true, json: async () => standalone };
        }
        return { ok: true, json: async () => ({ object: 'list', not_found: [], data: [dfcCard, dfcCard] }) };
      };
      return Scryfall.resolve(['Scheming Silvertongue / Sign in Blood', 'Sign in Blood']).then(r3 => {
        const dfc = r3.cards['scheming silvertongue / sign in blood'];
        assert(!!dfc && dfc.name === 'Scheming Silvertongue // Sign in Blood',
          'slashed request still resolves to the DFC');
        const solo = r3.cards['sign in blood'];
        assert(!!solo && solo.name === 'Sign in Blood' && solo.img === 'https://x/standalone.jpg',
          'standalone card resolves to ITSELF, not the DFC back face');
        assert(fetchLog.some(u => String(u).includes('named?exact=Sign%20in%20Blood')),
          'ambiguous name was rescued via named?exact');

        // ---- token parts from all_parts ----
        section('Scryfall token parts');
        const krenko = {
          object: 'card', name: 'Krenko, Mob Boss', type_line: 'Legendary Creature — Goblin Warrior',
          mana_cost: '{2}{R}{R}', oracle_text: '{T}: Create X 1/1 red Goblin creature tokens...',
          power: '3', toughness: '3', color_identity: ['R'],
          image_uris: { normal: 'https://x/krenko.jpg' },
          all_parts: [
            { component: 'combo_piece', id: 'self', name: 'Krenko, Mob Boss' },
            { component: 'token', id: 'tok-goblin', name: 'Goblin' }
          ]
        };
        const goblinToken = {
          object: 'card', name: 'Goblin', type_line: 'Token Creature — Goblin', layout: 'token',
          power: '1', toughness: '1', oracle_text: '', color_identity: ['R'],
          image_uris: { normal: 'https://x/goblin-token.jpg' }
        };
        global.fetch = async (url) => {
          if (String(url).includes('/cards/tok-goblin')) return { ok: true, json: async () => goblinToken };
          return { ok: true, json: async () => ({ object: 'list', not_found: [], data: [krenko] }) };
        };
        return Scryfall.resolve(['Krenko, Mob Boss']).then(r4 => {
          const k = r4.cards['krenko, mob boss'];
          assert(k.tokens && k.tokens.length === 1 && k.tokens[0].name === 'Goblin' && k.tokens[0].id === 'tok-goblin',
            'token parts extracted from all_parts (combo pieces excluded)');
          return Scryfall.fetchToken('tok-goblin');
        }).then(tok => {
          assert(tok.name === 'Goblin' && tok.img === 'https://x/goblin-token.jpg' && tok.pt === '1/1',
            'fetchToken returns the slim token with art and p/t');
          console.log('\n' + (failures ? failures + ' TEST(S) FAILED' : 'All tests passed.'));
          process.exit(failures ? 1 : 0);
        });
      });
    });
  });
}
