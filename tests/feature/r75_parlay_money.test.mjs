/* tests/feature/r75_parlay_money.test.mjs — R75 per-parlay $100 money, tier
 * filter and sort control, locked.
 *
 * The defect this file exists to prevent is a card and the week footer quoting
 * DIFFERENT money for the same parlays. R73 shipped a footer that sums the
 * as-made ledger prices; R75 puts a figure on each card. If the card priced
 * itself from the feed while the footer priced from the ledger, the page would
 * contradict itself and nothing would say which number was wrong. So both come
 * from scripts/build_review.parlay_money and this file proves the sum:
 *
 *   1. scripts/build_review: parlay_money settles ONE parlay, potential_return
 *      quotes one, stamp_parlay_money stamps every row; a pending parlay is
 *      quoted (net_vig2 null) and never settled.
 *   2. The COMMITTED data/review.json: every parlay row carries `money`; the
 *      settled rows of a scope sum to summary.parlays.stake_100[scope]; a
 *      settled row's sign agrees with its bucket; a quote is always positive.
 *   3. app/review.js: parlayMoneyMap reads rows, never prices; renderPay labels
 *      a quote and a result differently and names the assumed legs.
 *   4. app/views/parlays.js: tierSeg offers only the tiers present (never an
 *      empty bucket), sortSeg hides the $100 chip until the money is readable.
 *   5. The committed data/parlays.json: every parlay carries a confidence_tier
 *      the chips can render and a numeric model_ev the sort can order.
 *
 * Node built-ins only; the Python core is driven through `python3 -`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { parlayMoneyMap, renderPay, payAssumedText, fmtMoney } from '../../app/review.js';
import { tierSeg, sortSeg } from '../../app/views/parlays.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const REVIEW = readJson('data/review.json');
const PARLAYS = readJson('data/parlays.json');
const TIERS = ['high', 'medium', 'low'];
const KINDS = ['settled', 'potential'];

/** Run a Python snippet against the repo root (the r51/r58 pattern). */
function py(src) {
  const r = spawnSync('python3', ['-'], { input: src, cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `python exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

/* 1 — the Python core -------------------------------------------------------- */

test('parlay_money settles one parlay and potential_return quotes one', () => {
  const out = py(`
import json
from scripts.build_review import (parlay_money, potential_return, stamp_parlay_money,
                                  ASSUMED_DECIMAL, STAKE)
idx = {(1, "G1", "moneyline", "AAA ML"): 0.5, (1, "G1", "spread", "AAA -3"): 0.25}
def legs(*specs):
    return [{"market": m, "selection": s, "game_id": "G1", "result": r} for m, s, r in specs]
won = {"bucket": "all_hit", "scope": "week",
       "legs": legs(("moneyline", "AAA ML", "hit"), ("spread", "AAA -3", "hit"))}
lost = {"bucket": "partial", "scope": "week",
        "legs": legs(("moneyline", "AAA ML", "hit"), ("spread", "AAA -3", "miss"))}
pend = {"bucket": "pending", "scope": "week",
        "legs": legs(("moneyline", "AAA ML", "hit"), ("spread", "AAA -3", "pending"))}
prop = {"bucket": "all_hit", "scope": "game",
        "legs": [{"market": "qb_pass_yds", "selection": "X 225+", "game_id": "G1", "result": "hit"}]}
rows = [won, lost, pend, prop]
stamp_parlay_money(rows, 1, idx)
print(json.dumps({
  "won": parlay_money(won, 1, idx)[0],
  "lost": parlay_money(lost, 1, idx)[0],
  "pending_is_none": parlay_money(pend, 1, idx) is None,
  "quote_lost": potential_return(lost, 1, idx)[0],
  "prop_assumed": parlay_money(prop, 1, idx)[2],
  "prop_net": parlay_money(prop, 1, idx)[0],
  "assumed_decimal": ASSUMED_DECIMAL, "stake": STAKE,
  "kinds": [r["money"]["kind"] for r in rows],
  "pend_vig2": rows[2]["money"]["net_vig2"],
  "pend_fair": rows[2]["money"]["net_fair"],
}))
`);
  const r = JSON.parse(out);
  // 2.0 x 4.0 = 8.0 -> $100 stake returns $700 profit
  assert.equal(Math.round(r.won), 700, 'all_hit pays the product of the hit legs');
  assert.equal(r.lost, -100, 'a losing parlay loses the stake, never more');
  assert.ok(r.pending_is_none, 'a pending parlay is not settled');
  // the SAME parlay quotes positive: a quote prices every leg, a settlement only
  // the legs that hit. This is exactly why the two may never be confused.
  assert.ok(r.quote_lost > 0, 'the loser quoted positive before it lost');
  assert.equal(Math.round(r.quote_lost), 700);
  assert.equal(r.prop_assumed, 1, 'a prop leg has no book price');
  assert.equal(r.prop_net, Math.round((r.stake * (r.assumed_decimal - 1)) * 100) / 100);
  assert.deepEqual(r.kinds, ['settled', 'settled', 'potential', 'settled']);
  assert.equal(r.pend_vig2, null, 'a quote is one price, not two');
  assert.equal(Math.round(r.pend_fair), 700);
});

/* 2 — the committed document ------------------------------------------------- */

test('every committed parlay row carries money of a declared kind', () => {
  const weeks = Object.entries(REVIEW.weeks);
  assert.ok(weeks.length > 0, 'the review document has weeks');
  let rows = 0;
  for (const [wk, blk] of weeks) {
    for (const p of blk.parlays || []) {
      rows += 1;
      const m = p.money;
      assert.ok(m && typeof m === 'object', `wk ${wk} ${p.parlay_id} has no money`);
      assert.ok(KINDS.includes(m.kind), `wk ${wk} ${p.parlay_id} kind ${m.kind}`);
      assert.equal(typeof m.net_fair, 'number');
      assert.ok(Number.isInteger(m.assumed_price_legs) && m.assumed_price_legs >= 0);
      assert.ok(m.assumed_price_legs <= (p.legs || []).length, 'cannot assume more legs than exist');
      if (m.kind === 'potential') {
        assert.equal(p.bucket, 'pending', 'only a pending parlay is quoted');
        assert.equal(m.net_vig2, null, 'a quote carries one price');
        assert.ok(m.net_fair > 0, 'a parlay always quotes a positive return');
      } else {
        assert.notEqual(p.bucket, 'pending', 'a pending parlay is never settled');
        assert.equal(typeof m.net_vig2, 'number');
        const won = p.bucket === 'all_hit' || p.bucket === 'push';
        assert.equal(won ? m.net_fair > 0 : m.net_fair === -100, true,
          `wk ${wk} ${p.parlay_id}: ${p.bucket} paid ${m.net_fair}`);
      }
    }
  }
  assert.ok(rows >= 60, `expected a full slate of rows, saw ${rows}`);
});

test('the settled cards of a scope sum to that scope’s $100 footer', () => {
  let scopesChecked = 0;
  for (const [wk, blk] of Object.entries(REVIEW.weeks)) {
    const foot = blk.summary?.parlays?.stake_100;
    if (!foot) continue;
    for (const scope of ['week', 'game']) {
      const f = foot[scope];
      if (!f || !f.graded) continue;
      scopesChecked += 1;
      const settled = (blk.parlays || [])
        .filter((p) => p.scope === scope && p.money.kind === 'settled')
        .map((p) => p.money);
      assert.equal(settled.length, f.graded,
        `wk ${wk} ${scope}: ${settled.length} settled cards vs ${f.graded} graded`);
      const sum = (k) => settled.reduce((t, m) => t + m[k], 0);
      // per-parlay figures are rounded to the cent, so the sum may differ from
      // the footer by at most a cent per card — never by a dollar.
      const slack = 0.01 * settled.length;
      assert.ok(Math.abs(sum('net_fair') - f.net_fair) <= slack,
        `wk ${wk} ${scope}: cards ${sum('net_fair')} vs footer ${f.net_fair}`);
      assert.ok(Math.abs(sum('net_vig2') - f.net_vig2) <= slack,
        `wk ${wk} ${scope}: cards ${sum('net_vig2')} vs footer ${f.net_vig2}`);
      assert.equal(settled.reduce((t, m) => t + m.assumed_price_legs, 0), f.assumed_price_legs);
    }
  }
  assert.ok(scopesChecked >= 1, 'at least one graded scope to reconcile');
});

/* 3 — the reader and the renderer -------------------------------------------- */

/* R93/G03 — parlayMoneyMap indexes every row TWICE: once under its immutable
 * identity (card_id, else parlay_id) and once under the rank-derived parlay_id
 * that app/views/parlays.js still filters and sorts on. A week of N priced rows
 * therefore carries up to 2N keys, so map.size is an implementation detail R93
 * deliberately changed — assert what the map can REACH, and what it refuses to
 * reach, which is what this test is named for. */
test('parlayMoneyMap reads the rows and prices nothing', () => {
  const wk = Object.keys(REVIEW.weeks)[0];
  const map = parlayMoneyMap(Number(wk), REVIEW);
  const rows = REVIEW.weeks[wk].parlays;
  const readable = (p) => !!(p && p.money && typeof p.money === 'object'
    && typeof p.money.net_fair === 'number' && KINDS.includes(p.money.kind));
  const identity = (p) => String(p.card_id || p.parlay_id);
  const priced = rows.filter(readable);
  assert.ok(priced.length > 0, 'the week has priced rows to read');

  // Reachable under BOTH names, and BY REFERENCE: the map hands back the row's
  // own block, it never prices a copy. A rank id can be reused by a
  // post-kickoff rebuild, so it need only resolve where the document keeps it
  // unique; the identity entry is written last and always resolves.
  const ranks = new Map();
  for (const p of priced) {
    const r = String(p.parlay_id);
    ranks.set(r, (ranks.get(r) || 0) + 1);
  }
  for (const p of priced) {
    assert.equal(map.get(identity(p)), p.money, `${identity(p)} is unreachable by identity`);
    if (ranks.get(String(p.parlay_id)) === 1) {
      assert.equal(map.get(String(p.parlay_id)), p.money, `${p.parlay_id} is unreachable by rank id`);
    }
  }
  // ...and nothing is lost on the way or handed to a second row: the distinct
  // money blocks the map can reach are exactly the priced rows.
  assert.equal(new Set(map.values()).size, priced.length, 'one money block per priced row');
  for (const m of map.values()) {
    assert.ok(priced.some((p) => p.money === m), 'the map reaches only money the document wrote');
  }

  // a row without money is simply absent — never defaulted to 0 — under BOTH
  // of its names
  const stripped = JSON.parse(JSON.stringify(REVIEW));
  const gone = stripped.weeks[wk].parlays[0];
  assert.ok(readable(gone), 'the stripped row carried money to begin with');
  delete gone.money;
  const strippedMap = parlayMoneyMap(Number(wk), stripped);
  assert.equal(strippedMap.get(identity(gone)), undefined, 'no money, no identity entry');
  assert.equal(strippedMap.get(String(gone.parlay_id)), undefined, 'no money, no rank entry');
  assert.equal(new Set(strippedMap.values()).size, priced.length - 1, 'exactly one row stopped pricing');
  assert.equal(parlayMoneyMap(999, REVIEW).size, 0, 'an unknown week prices nothing');

  // The dual key is the contract, not an accident of today's document; and an
  // undeclared kind, a non-numeric net_fair or no block at all prices nothing
  // under EITHER name.
  const money = { kind: 'settled', net_fair: 700, net_vig2: 660, assumed_price_legs: 0 };
  const synth = parlayMoneyMap(1, { weeks: { 1: { parlays: [
    { parlay_id: 'wk1-1', card_id: 'aa11', money },
    { parlay_id: 'wk1-2', card_id: 'bb22', money: { kind: 'guess', net_fair: 500 } },
    { parlay_id: 'wk1-3', card_id: 'cc33', money: { kind: 'settled', net_fair: '700' } },
    { parlay_id: 'wk1-4', card_id: 'dd44', money: null },
  ] } } });
  assert.equal(synth.get('aa11'), money, 'a priced row resolves by its identity');
  assert.equal(synth.get('wk1-1'), money, 'and by the rank id the views still hold');
  for (const k of ['wk1-2', 'bb22', 'wk1-3', 'cc33', 'wk1-4', 'dd44']) {
    assert.equal(synth.get(k), undefined, `${k}: an unreadable money block prices nothing`);
  }
  assert.equal(new Set(synth.values()).size, 1, 'one readable row, one money block');
});

test('renderPay labels a quote and a result differently', () => {
  const quote = renderPay({ kind: 'potential', net_fair: 700, net_vig2: null, assumed_price_legs: 0 });
  const paid = renderPay({ kind: 'settled', net_fair: 700, net_vig2: 660, assumed_price_legs: 0 });
  const lost = renderPay({ kind: 'settled', net_fair: -100, net_vig2: -100, assumed_price_legs: 2 });
  assert.match(quote, /\$100 SIM NET · IF HIT/);
  assert.match(paid, /\$100 SIM NET · GRADED/);
  assert.ok(!quote.includes('RETURNED'), 'a quote never reads as a result');
  assert.match(quote, /pay--pos/);
  assert.match(lost, /pay--neg/);
  assert.match(lost, /−\$100/);
  assert.match(lost, /2 legs with assumed or unverified comparison prices/, 'assumptions are named');
  assert.match(payAssumedText({ assumed_price_legs: 0 }), /not an executable quote/);
  assert.match(payAssumedText({ assumed_price_legs: 1 }), /1 leg with assumed or unverified comparison prices/);
  assert.equal(fmtMoney(0), '$0');
  // an unreadable money block paints nothing rather than a zero
  assert.equal(renderPay(null), '');
  assert.equal(renderPay({ kind: 'settled', net_fair: null }), '');
  assert.equal(renderPay({ kind: 'guess', net_fair: 5 }), '');
});

/* 4 — the controls ----------------------------------------------------------- */

test('tierSeg offers only the tiers present, strongest first', () => {
  assert.equal(tierSeg([], 'all'), '', 'no tiers, no chip row');
  const html = tierSeg(['high', 'low'], 'low');
  assert.match(html, /data-tier="all"/);
  assert.match(html, /data-tier="high"/);
  assert.match(html, /data-tier="low"/);
  assert.ok(!html.includes('data-tier="medium"'), 'never offers an empty bucket');
  assert.match(html, /data-tier="low" aria-pressed="true"/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1, 'exactly one chip is pressed');
  assert.ok(html.indexOf('data-tier="high"') < html.indexOf('data-tier="low"'), 'strongest first');
});

test('sortSeg defaults to SLATE and hides the $100 chip until money is readable', () => {
  const without = sortSeg('slate', false);
  assert.ok(!without.includes('data-sort="pay"'), 'no money, no $100 sort');
  // SLATE first and pressed: enabling a sort must not reorder the page for a
  // user who never asked for one.
  assert.match(without, /data-sort="slate" aria-pressed="true"/);
  assert.ok(without.indexOf('data-sort="slate"') < without.indexOf('data-sort="ev"'));
  assert.match(without, /data-sort="ev"/);
  assert.match(without, /data-sort="legs"/);
  const withPay = sortSeg('pay', true);
  assert.match(withPay, /data-sort="pay" aria-pressed="true"/);
  assert.ok(withPay.indexOf('data-sort="ev"') < withPay.indexOf('data-sort="pay"'));
  assert.ok(withPay.indexOf('data-sort="pay"') < withPay.indexOf('data-sort="legs"'));
  assert.equal((withPay.match(/aria-pressed="true"/g) || []).length, 1);
});

/* 5 — the committed slate the controls run on -------------------------------- */

test('every committed parlay carries a tier to filter and an EV to sort', () => {
  const rows = PARLAYS.parlays || [];
  assert.ok(rows.length > 0);
  const seen = new Set();
  for (const p of rows) {
    const t = String(p.confidence_tier || '').toLowerCase();
    assert.ok(TIERS.includes(t), `${p.parlay_id} tier ${p.confidence_tier}`);
    seen.add(t);
    assert.equal(typeof p.model_ev, 'number', `${p.parlay_id} has no model_ev`);
    assert.ok(Number.isFinite(p.model_ev));
  }
  assert.ok(seen.size >= 1);
  // the sort earns its keep only because the feed is NOT already EV-ordered
  for (const scope of ['week', 'game']) {
    const evs = rows.filter((p) => p.scope === scope).map((p) => p.model_ev);
    const sorted = [...evs].sort((a, b) => b - a);
    assert.notDeepEqual(evs, sorted, `${scope} scope arrives EV-sorted — the sort would be a no-op`);
  }
});
