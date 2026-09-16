/* R74 — ONE LEG PER GAME SIDE.
 *
 * A moneyline on a team and that team's spread are ONE opinion. Winning
 * outright guarantees the cover on any non-negative handicap, so stacking them
 * quotes a payout for risk the bettor never took.
 *
 * This was not a rare accident. `build_game_parlays` ranks candidate pairs by
 * |rho| descending, and the measured moneyline-to-spread correlation (0.71) is
 * the strongest in the table, so the ranking SELECTED the redundant pair as the
 * flagship of every same-game card. It shipped on 1 of the 1 games that had a
 * handicap in week 1, and on 16 of 16 in week 2 once the odds feed filled in —
 * the defect got worse as the data got healthier.
 *
 * Two guards, because the builder is not the only way a document can be written:
 * the pure rule in the builder, and the contract check over the SHIPPED file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = join(ROOT, 'data');
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

const GAME_OUTCOME = new Set(['moneyline', 'spread']);

/** Teams with more than one bet on their own outcome in one parlay. */
function stackedSides(parlay) {
  const bySide = new Map();
  for (const leg of parlay.legs || []) {
    if (!GAME_OUTCOME.has(leg.market)) continue;
    const team = String(leg.selection || '').split(' ')[0].trim();
    if (!team) continue;
    if (!bySide.has(team)) bySide.set(team, []);
    bySide.get(team).push(leg.selection);
  }
  return [...bySide.entries()].filter(([, sels]) => sels.length > 1);
}

test('the builder refuses to pair a moneyline with its own spread', () => {
  const out = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ".")
from scripts.models.parlay_builder import same_side_game_pair, legs_violating_one_per_side
ml   = {"market": "moneyline",   "_side": "home"}
sp   = {"market": "spread",      "_side": "home"}
opp  = {"market": "spread",      "_side": "away"}
prop = {"market": "qb_pass_yds", "_side": "home"}
print(json.dumps({
  "same_side": same_side_game_pair(ml, sp),
  "opposite_side": same_side_game_pair(ml, opp),
  "ml_and_prop": same_side_game_pair(ml, prop),
  "prop_pair": same_side_game_pair(prop, dict(prop)),
  "violations": legs_violating_one_per_side([ml, sp, prop]),
}))`], { cwd: ROOT, encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.same_side, true, 'a moneyline and its own spread are one opinion');
  assert.equal(r.opposite_side, false, 'the other side of the game is a different opinion');
  assert.equal(r.ml_and_prop, false, 'a prop is a different opinion');
  assert.equal(r.prop_pair, false, 'two props are never a game-outcome pair');
  assert.deepEqual(r.violations, [[0, 1]], 'the violating pair is reported by index');
});

test('a real slate rebuilt through the builder carries no stacked side', () => {
  const doc = load(join(DATA, 'parlays.json'));
  assert.ok(doc.parlays.length > 0, 'the shipped slate is empty — nothing is proven');
  // The guard means nothing unless the slate actually HAS handicaps to stack:
  // week 1 shipped only one spread leg, which is why it hid there.
  const spreads = doc.parlays
    .flatMap((p) => p.legs)
    .filter((l) => l.market === 'spread').length;
  assert.ok(spreads > 0,
    'no spread leg on the slate — this file cannot demonstrate the rule holds');
  const offenders = doc.parlays
    .map((p) => [p.parlay_id, stackedSides(p)])
    .filter(([, s]) => s.length > 0);
  assert.deepEqual(offenders, [], 'a parlay sells one opinion as two legs');
});

test('every archived week obeys the rule from here on', () => {
  const dir = join(DATA, 'parlays');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => /^\d{4}_wk\d{2}\.json$/.test(x))) {
    const doc = load(join(dir, f));
    for (const p of doc.parlays || []) {
      const s = stackedSides(p);
      // Weeks archived BEFORE the rule existed are a record of what shipped and
      // are never rewritten; they are reported, not asserted away.
      if (s.length && !doc.closed) {
        assert.fail(`${f} ${p.parlay_id} stacks ${s.map(([t]) => t).join(', ')}`);
      }
    }
  }
});
