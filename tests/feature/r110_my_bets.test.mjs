/* R110 (R99 E2) S2–S9 — MY BETS: the store, the money, the guard, the ledger.
 *
 * Owner, 2026-10-04: "I bet this" on every card + a manual builder; stored on
 * the device with export / import; an exposure warning before the same player is
 * staked twice. Backlog: docs/backlog/epics/R110-my-bets-ledger.md. Grading
 * parity with the pipeline is pinned in r110_bet_facts.test.mjs; this file pins
 * everything else the pure core (app/bets.js) promises.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import * as B from '../../app/bets.js';
import { builderRefusal } from '../../app/views/mybets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE = JSON.parse(readFileSync(join(ROOT, 'docs/backlog/evidence/2026_owner_fanduel_slips.json'), 'utf8'));

/** A Storage double: a Map, or one that throws (Safari private mode). */
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };

const leg = (over = {}) => ({ market: 'qb_pass_yds', selection: 'J. Allen 225+ pass yds', gsis_id: 'espn-1',
  line: 224.5, game_id: 'G1', team: 'BUF', side: 'home', model_prob: 0.55, implied_prob: 0.57, ...over });
const bet = (over = {}) => B.makeBet({ source: 'my', legs: [leg()], stake: 10, odds: 260, week: 4,
  placed_utc: '2026-10-04T16:00:00Z', ...over });

/* ---------------------------------------------------------------- S2 store */

test('S2 AC1: add / list / delete round-trip through storage', () => {
  const st = mem();
  let { doc } = B.loadStore(st);
  assert.deepEqual(doc.bets, []);
  const b = bet({ id: 'x1' });
  doc = B.addBet(doc, b).doc;
  assert.ok(B.saveStore(st, doc));
  const again = B.loadStore(st).doc;
  assert.equal(again.bets.length, 1);
  assert.equal(again.bets[0].id, 'x1');
  assert.equal(B.removeBet(again, 'x1').bets.length, 0);
});

test('S2 AC2: storage that throws falls back to memory with a note, never a crash', () => {
  const r = B.loadStore(broken);
  assert.equal(r.persistent, false);
  assert.match(r.note, /export/);
  assert.equal(B.saveStore(broken, r.doc), false);
  const junk = mem();
  junk.setItem(B.STORE_KEY, '{"kind":"nope"}');
  const j = B.loadStore(junk);
  assert.deepEqual(j.doc.bets, []);
  assert.match(j.note, /unreadable/);
});

test('S2 AC3: export -> import into an empty ledger is byte-identical', () => {
  let doc = B.emptyDoc();
  doc = B.addBet(doc, bet({ id: 'a' })).doc;
  doc = B.addBet(doc, bet({ id: 'b', legs: [leg({ selection: 'BUF ML', market: 'moneyline', gsis_id: undefined })] })).doc;
  const text = B.exportText(doc);
  const r = B.importText(B.emptyDoc(), text);
  assert.equal(r.error, null);
  assert.equal(B.exportText(r.doc), text);
});

test('S2 AC4: a malformed import changes nothing and says why; a valid one merges by id', () => {
  const doc = B.addBet(B.emptyDoc(), bet({ id: 'a', stake: 10 })).doc;
  for (const [text, why] of [['not json', /not JSON/], ['{"kind":"my_bets","version":9,"bets":[]}', /version/],
    ['{"kind":"my_bets","version":1,"bets":[{"id":"z","legs":[],"stake":1,"week":1}]}', /no legs/]]) {
    const r = B.importText(doc, text);
    assert.match(r.error, why);
    assert.equal(r.doc, doc, 'nothing changed');
  }
  const incoming = B.addBet(B.addBet(B.emptyDoc(), bet({ id: 'a', stake: 99 })).doc, bet({ id: 'c' })).doc;
  const r = B.importText(doc, B.exportText(incoming));
  assert.deepEqual([r.added, r.kept], [1, 1]);
  assert.equal(r.doc.bets.find((b) => b.id === 'a').stake, 10, 'the bet on this device is never overwritten');
});

/* --------------------------------------------------------- S3 / S4 cards */

test('S3 AC2: a card becomes a bet with its legs verbatim (ids kept, so every leg auto-grades)', () => {
  const myLeg = { owner: 'espn-9', label: 'B. Robinson', market: 'rb_rush_yds', selection: 'B. Robinson 80+ rush yds',
    model_prob: 0.5, implied_prob: 0.52, line: 79.5, game_id: 'G2', team: 'ATL', side: 'away', position: 'RB', corr_tag: 'x' };
  const l = B.betLeg(myLeg);
  assert.equal(l.gsis_id, 'espn-9', "MY's owner becomes the player id");
  assert.equal(l.player, 'B. Robinson');
  assert.equal(l.corr_tag, undefined, 'only what grading and display need');
  const team = B.betLeg({ owner: 'team:ATL', market: 'moneyline', selection: 'ATL ML', team: 'ATL', side: 'away' }, 'G2');
  assert.equal(team.gsis_id, undefined, 'a team leg has no player id');
  assert.equal(team.game_id, 'G2', 'a week card leg takes the card\'s game when it has one');
  const b = B.makeBet({ source: 'my', legs: [l, team], stake: 5, odds: -110, week: 4, placed_utc: 't' });
  assert.equal(b.legs.length, 2);
  assert.equal(B.validateDoc({ ...B.emptyDoc(), bets: [b] }), null);
});

test('S3 AC2: the sheet pre-fills the card\'s own fair price', () => {
  assert.equal(B.fairAmerican([{ implied_prob: 0.5 }, { implied_prob: 0.5 }]), 300);
  assert.equal(B.fairAmerican([{ implied_prob: 0.8 }]), -400);
  assert.equal(B.fairAmerican([{ implied_prob: null, model_prob: 0.5 }]), 100);
  assert.equal(B.fairAmerican([{}]), null);
});

test('S3 AC3: the same card twice in a week is flagged a duplicate (the sheet asks first)', () => {
  const doc = B.addBet(B.emptyDoc(), bet({ id: 'a' })).doc;
  assert.equal(B.addBet(doc, bet({ id: 'b' })).duplicate, true);
  assert.equal(B.addBet(doc, bet({ id: 'c', week: 5 })).duplicate, false, 'another week is another bet');
});

test('S4 AC2: the builder keeps MY\'s rules — one line per player-market, one leg per game side, 10 legs', () => {
  const a = { owner: 'p1', market: 'qb_pass_yds', selection: 'A 225+' };
  assert.equal(builderRefusal([a], { owner: 'p1', market: 'qb_pass_yds', selection: 'A 250+' }), 'one line per player and market');
  assert.equal(builderRefusal([a], { owner: 'p1', market: 'anytime_td', selection: 'A ATD' }), null);
  const ml = { owner: 'team:KC', market: 'moneyline', selection: 'KC ML', game_id: 'G', team: 'KC' };
  assert.match(builderRefusal([ml], { owner: 'team:KC', market: 'spread', selection: 'KC -3.5', game_id: 'G', team: 'KC' }), /R74/);
  const ten = Array.from({ length: 10 }, (_, i) => ({ owner: `p${i}`, market: 'm', selection: `s${i}` }));
  assert.match(builderRefusal(ten, { owner: 'q', market: 'm', selection: 'new' }), /at most 10/);
});

/* -------------------------------------------------------------- S5 money */

const facts = {
  excluded: ['GX'],
  weeks: { 4: {
    games: { G1: { h: 'BUF', a: 'NO', k: '2026-10-04T17:00Z', hs: 27, as: 20 },
      G2: { h: 'ATL', a: 'WAS', k: '2026-10-04T20:25Z' }, GX: { h: 'IND', a: 'WAS', k: null, hs: 10, as: 3 } },
    players: { 'espn-1': { y: [301, 12, 0], td: 1 }, 'espn-2': { y: 'dnp', td: 'dnp' } } } },
};

test('S5 AC4: a win pays stake x decimal; a loss is -stake; all-void is the stake back', () => {
  const won = B.gradeBet(bet({ legs: [leg()] }), facts);
  assert.equal(won.status, 'won');
  assert.equal(won.ret, 36);
  assert.equal(won.net, 26);
  const lost = B.gradeBet(bet({ legs: [leg({ line: 324.5, selection: 'J. Allen 325+ pass yds' })] }), facts);
  assert.deepEqual([lost.status, lost.ret, lost.net], ['lost', 0, -10]);
  const allVoid = B.gradeBet(bet({ legs: [leg({ gsis_id: 'espn-2', selection: 'X 60+' })] }), facts);
  assert.deepEqual([allVoid.status, allVoid.net], ['void', 0]);
});

test('S5 AC2/AC3: an excluded game is void (the bet settles on the rest); a live game stays open', () => {
  const g = B.gradeBet(bet({ odds: 300, legs: [leg(), { market: 'moneyline', selection: 'IND ML', game_id: 'GX', side: 'home', implied_prob: 0.5 }] }), facts);
  assert.equal(g.status, 'won');
  assert.equal(g.legs[1].reason, 'excluded_game');
  assert.equal(g.ret, 20, 'the void leg is divided out at its own price: 10 x 4.0 x 0.5');
  const open = B.gradeBet(bet({ legs: [leg(), { market: 'moneyline', selection: 'ATL ML', game_id: 'G2', side: 'home' }] }), facts);
  assert.equal(open.status, 'open', 'no FINAL score yet: pending, never a result');
  const miss = B.gradeBet(bet({ legs: [leg({ line: 324.5 }), { market: 'moneyline', selection: 'ATL ML', game_id: 'G2', side: 'home' }] }), facts);
  assert.equal(miss.status, 'lost', 'R106: one miss loses even with a leg pending');
});

test('S5: the book\'s settled amount always wins; a void leg with no price marks the return an estimate', () => {
  const g = B.gradeBet({ ...bet({ odds: 300, legs: [leg(), { market: 'moneyline', selection: 'IND ML', game_id: 'GX', side: 'home' }] }) }, facts);
  assert.equal(g.estimate, true);
  const s = B.gradeBet({ ...bet(), settled_return: 31.5 }, facts);
  assert.deepEqual([s.ret, s.estimate], [31.5, false]);
});

test('odds: American <-> decimal both ways, and a non-price is refused', () => {
  assert.equal(B.americanToDecimal(260), 3.6);
  assert.equal(B.americanToDecimal(-150), 1 + 100 / 150);
  assert.equal(B.americanToDecimal(50), null);
  assert.equal(B.decimalToAmerican(3.6), 260);
  assert.equal(B.decimalToAmerican(1.5), -200);
  assert.equal(B.fmtAmerican(260), '+260');
});

/* ------------------------------------------------------ S6 ledger + S8 slips */

const weekOf = (d) => {
  if (/^W\d+$/.test(d)) return Number(d.slice(1));
  const [m, dd] = d.split('/').map(Number);
  return Math.floor((Date.UTC(2026, m - 1, dd) - Date.UTC(2026, 8, 8)) / 864e5 / 7) + 1;
};

test('S8 AC1: the 19 FanDuel slips import as bets, every leg kept with the slip\'s own result', () => {
  const bets = B.slipsToBets(EVIDENCE, weekOf);
  assert.equal(bets.length, 19);
  assert.equal(bets.reduce((n, b) => n + b.legs.length, 0), 113, 'all 113 legs, none dropped');
  assert.ok(bets.every((b) => b.legs.every((l) => l.slip_result)), 'ungradable legs keep the slip result');
  assert.equal(B.validateDoc({ ...B.emptyDoc(), bets }), null);
});

test('S6 AC2: the ledger reproduces the slips\' money exactly (R99 §2: $186 staked, $608.33 back)', () => {
  const graded = B.slipsToBets(EVIDENCE, weekOf).map((b) => B.gradeBet(b, null));
  const s = B.summarize(graded);
  assert.equal(s.all.staked, 186);
  assert.equal(s.all.returned, 608.33);
  assert.equal(s.all.net, 422.33);
  assert.ok(s.by_legs['4'] && s.by_source.import, 'by leg count and by source');
});

test('S7 AC1/AC2: the 9/20 slate shows who rode on 2+ tickets; nothing crosses weeks', () => {
  const bets = B.slipsToBets(EVIDENCE, weekOf);
  const on920 = bets.filter((b) => EVIDENCE.tickets.find((t) => `slip-${t.id}` === b.id).placed === '9/20');
  const w = B.exposure(on920).map((r) => [r.label, r.count]);
  // R99 §2 named six (Bijan, Irving x3; Swift, Jeanty, Metcalf, Loveland x2); the
  // ledger finds three more the summary left out (Lamb, Watson, McBride x2).
  assert.deepEqual(w.slice(0, 2), [['Bijan Robinson', 3], ['Bucky Irving', 3]]);
  for (const name of ["D'Andre Swift", 'Ashton Jeanty', 'DK Metcalf', 'Colston Loveland']) {
    assert.ok(w.some(([n, c]) => n === name && c === 2), name);
  }
  assert.equal(w.length, 9);
  const wk1 = bets.filter((b) => b.week === 1);
  const one = wk1.find((b) => b.legs.some((l) => l.player === 'Bijan Robinson'));
  const cross = B.exposure([...on920.filter((b) => !b.legs.some((l) => l.player === 'Bijan Robinson')), one]);
  assert.ok(!cross.some((r) => r.label === 'Bijan Robinson'), 'a week-1 and a week-2 ticket are not exposure');
});

test('S7 AC3: the guard sees the bet being saved before it is saved', () => {
  const held = [bet({ id: 'a' })];
  const draft = bet({ id: 'draft', legs: [leg({ market: 'anytime_td', selection: 'J. Allen ATD' })] });
  const w = B.exposure(held, draft);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].bets, ['a', 'draft']);
});

test('slip dates map to NFL weeks off the facts\' kickoffs (EDT and EST alike)', () => {
  const f = { weeks: { 2: { games: { a: { k: '2026-09-21T00:20Z' }, b: { k: '2026-09-22T00:15Z' } } },
    10: { games: { c: { k: '2026-11-16T01:20Z' } } } } };
  const wk = B.weekOfDate(f);
  assert.equal(wk('9/20'), 2, 'Sunday night: 00:20Z is the 20th in New York');
  assert.equal(wk('9/21'), 2, 'Monday night');
  assert.equal(wk('11/15'), 10, 'EST');
  assert.equal(wk('W1'), 1);
  assert.equal(wk('12/25'), undefined);
});

test('the chip counts bets not known to be settled', () => {
  const doc = { ...B.emptyDoc(), bets: [bet({ id: 'a' }), { ...bet({ id: 'b' }), status: 'won' }, { ...bet({ id: 'c' }), status: 'open' }] };
  assert.equal(B.openCount(doc), 2);
});

/* ----------------------------------------------------------- S9 isolation */

test('S9 AC1: nothing under scripts/ can read the bets (device-only; never a training input)', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__pycache__') walk(p); continue; }
      if (!/\.(py|mjs|js|sh)$/.test(e.name)) continue;
      const src = readFileSync(p, 'utf8');
      if (src.includes(B.STORE_KEY) || /my[-_]bets/i.test(src)) offenders.push(p);
    }
  };
  walk(join(ROOT, 'scripts'));
  assert.deepEqual(offenders, []);
});
