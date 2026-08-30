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

section('formatDeckList');
{
  const out = Parser.formatDeckList(['Island', 'Forest', 'Island']);
  assert(out === '2 Island\n1 Forest', 'round-trips counts');
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
  try { new Game.Game(['a', 'b', 'c'], {}, {}); } catch (e) { threw = /1v1/.test(e.message); }
  assert(threw, 'three players rejected');
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
  assert(g.active === 'a' && g.turn === 2, 'passTurn flips active player and bumps turn');

  let threw = false;
  try { g.apply('b', { a: 'play', uid: 'not-a-card' }); } catch (e) { threw = /hand/.test(e.message); }
  assert(threw, 'playing a card you do not hold is rejected');
  threw = false;
  try { g.apply('b', { a: 'tap', uid: g.viewFor('a').hand[0].uid }); } catch (e) { threw = true; }
  assert(threw, "touching the opponent's cards is rejected");

  assert(g.viewFor('a').log.length > 0 && g.viewFor('a').log.every(l => typeof l.text === 'string'),
    'actions are logged');
}

console.log('\n' + (failures ? failures + ' TEST(S) FAILED' : 'All tests passed.'));
process.exit(failures ? 1 : 0);
