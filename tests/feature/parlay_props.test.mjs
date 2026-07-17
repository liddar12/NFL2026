/* tests/feature/parlay_props.test.mjs — player-prop parlay legs + odds_api de-vig,
 * locked on pure fixtures (no network, no data/ reads).
 *
 * Drives the Python cores through `python3 -` (the learning_loop.test.mjs pattern);
 * python3 is already a fast-gate dependency, so the gate stays dependency-free.
 *
 * Locks:
 *   parlay_builder.build_props_by_game(game_preds, weekly_doc, projections_doc):
 *     - exactly the QB/RB/WR seeded prop legs per game (markets qb_pass_yds /
 *       rb_rush_yds / wr_rec_yds), top projected player of the two teams;
 *     - model_prob = 0.5 + 0.4*(p_team_win - 0.5) clamped to [0.35, 0.65];
 *     - _side is the player's team side; ties on proj_points break by gsis_id;
 *     - deterministic: two calls produce identical output;
 *     - players absent from the weekly doc are ineligible (stale projection);
 *   build_game_parlays(props=...): prop legs surface in the same-game parlays and
 *     every same-game parlay stays at <= 3 legs (existing cap; ours are 2).
 *   odds_api.parse_event: pairwise de-vig of a synthetic h2h event (two-sided
 *     normalize sums to 1), spread/total parsing, and unmatchable -> None.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Run a python3 snippet from the repo root; parse the single JSON line it prints. */
function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    input: code,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

/* ---- build_props_by_game: seeded QB/RB/WR legs, clamped, deterministic ------ */

const PROPS_PY = `
import json, sys
sys.path.insert(0, ".")
from scripts.models.parlay_builder import build_props_by_game, build_game_parlays

def player(gsis, name, team, pos, pts):
    return {"gsis_id": gsis, "name": name, "team": team, "position": pos,
            "proj_points": pts}

projections = {"players": [
    # KC vs BUF game pool. Two QBs tied on proj_points -> gsis_id breaks the tie.
    player("00-01", "Patrick Mahomes", "KC", "QB", 300.0),
    player("00-09", "Josh Allen", "BUF", "QB", 300.0),
    player("00-03", "Isiah Pacheco", "KC", "RB", 180.0),
    player("00-04", "James Cook", "BUF", "RB", 220.0),
    player("00-05", "Rashee Rice", "KC", "WR", 250.0),
    player("00-06", "Khalil Shakir", "BUF", "WR", 200.0),
    # Higher-projected WR but NOT in the weekly doc -> ineligible (stale).
    player("00-07", "Ghost Receiver", "KC", "WR", 999.0),
    # Other-game player must never leak into this game's props.
    player("00-08", "Justin Jefferson", "MIN", "WR", 400.0),
]}
weekly = {"players": [{"gsis_id": g} for g in
                      ("00-01", "00-09", "00-03", "00-04", "00-05", "00-06", "00-08")]}

game = {"game_id": "g1", "home": "KC", "away": "BUF",
        "probs": {"home": 0.95, "away": 0.05}}
even = {"game_id": "g2", "home": "MIN", "away": "GB",
        "probs": {"home": 0.5, "away": 0.5}}

props1 = build_props_by_game([game, even], weekly, projections)
props2 = build_props_by_game([game, even], weekly, projections)
parlays = build_game_parlays(game, props=props1["g1"])

print(json.dumps({
    "g1": props1["g1"],
    "g2": props1["g2"],
    "deterministic": props1 == props2,
    "parlays": parlays,
}))
`;

test('build_props_by_game: one QB/RB/WR seeded leg per game, correct markets', () => {
  const r = runPy(PROPS_PY);
  const legs = r.g1;
  assert.equal(legs.length, 3, 'expected exactly 3 prop legs (QB/RB/WR)');
  assert.deepEqual(
    legs.map((l) => l.market),
    ['qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds'],
  );
  // Top projected at each position among the TWO teams, weekly-eligible only:
  // QB tie (300.0 both) breaks by gsis_id -> 00-01 Mahomes (KC, home).
  // RB -> Cook (BUF, away). WR -> Rice (KC): the 999-pt ghost is not in weekly,
  // and the other-game 400-pt Jefferson is not on either team.
  assert.deepEqual(legs.map((l) => l.gsis_id), ['00-01', '00-04', '00-05']);
  assert.deepEqual(legs.map((l) => l._side), ['home', 'away', 'home']);
  // Selections carry abbreviated name + rounded-up seed line + market label.
  assert.equal(legs[0].selection, 'P. Mahomes 225+ pass yds');
  assert.equal(legs[1].selection, 'J. Cook 60+ rush yds');
  assert.equal(legs[2].selection, 'R. Rice 60+ rec yds');
  // Seed lines are the documented values and every leg is labeled an estimate.
  assert.deepEqual(legs.map((l) => l.line), [224.5, 59.5, 59.5]);
  assert.ok(legs.every((l) => l.estimate === true), 'seeded legs must be labeled');
});

test('prop model_prob: 0.5 shaded by team win prob, clamped to [0.35, 0.65]', () => {
  const r = runPy(PROPS_PY);
  // p_home=0.95: home shade = 0.5 + 0.4*0.45 = 0.68 -> CLAMPED to 0.65;
  // away shade = 0.5 + 0.4*(-0.45) = 0.32 -> clamped to 0.35.
  const [qb, rb, wr] = r.g1;
  assert.equal(qb.model_prob, 0.65, 'home QB must hit the upper clamp');
  assert.equal(rb.model_prob, 0.35, 'away RB must hit the lower clamp');
  assert.equal(wr.model_prob, 0.65, 'home WR must hit the upper clamp');
  // Even game (0.5/0.5) shades nothing: every prob sits at the 0.5 seed.
  for (const leg of r.g2) {
    assert.equal(leg.model_prob, 0.5, `${leg.market} must seed at 0.5 in an even game`);
  }
  // Global bounds hold everywhere.
  for (const leg of [...r.g1, ...r.g2]) {
    assert.ok(leg.model_prob >= 0.35 && leg.model_prob <= 0.65,
      `${leg.market} prob ${leg.model_prob} outside clamp`);
  }
});

test('build_props_by_game is deterministic (stable sorts, gsis_id ties)', () => {
  const r = runPy(PROPS_PY);
  assert.equal(r.deterministic, true, 'two identical calls must byte-match');
});

test('prop legs flow through build_game_parlays; same-game parlays stay small', () => {
  const r = runPy(PROPS_PY);
  assert.ok(r.parlays.length >= 3, 'still >=3 parlays per game');
  const propMarkets = new Set(['qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds']);
  const legsSeen = r.parlays.flatMap((p) => p.legs);
  assert.ok(
    legsSeen.some((l) => propMarkets.has(l.market)),
    'at least one prop leg must surface in the game parlays',
  );
  // The QB+WR pair is the strongest prop correlation (rho 0.45) and must appear.
  assert.ok(
    r.parlays.some((p) => {
      const mk = p.legs.map((l) => l.market).sort();
      return mk.length === 2 && mk[0] === 'qb_pass_yds' && mk[1] === 'wr_rec_yds';
    }),
    'expected a qb_pass_yds + wr_rec_yds same-game pair',
  );
  for (const p of r.parlays) {
    assert.equal(p.scope, 'game');
    assert.ok(p.legs.length <= 3, `parlay ${p.parlay_id} has ${p.legs.length} legs`);
    assert.ok(p.correlation_note.length > 0, 'same-game parlays need a note');
    // Schema-clean legs: internal underscore helpers must be stripped.
    for (const leg of p.legs) {
      assert.deepEqual(
        Object.keys(leg).sort(),
        ['implied_prob', 'market', 'model_prob', 'selection'],
      );
    }
  }
});

/* ---- odds_api.parse_event: pure pairwise de-vig on a synthetic event -------- */

const ODDS_PY = `
import json, sys
sys.path.insert(0, ".")
from scripts.scrape.odds_api import parse_event, _american_to_prob, _devig_pair

event = {
    "id": "book-evt-1",
    "home_team": "Kansas City Chiefs",
    "away_team": "Buffalo Bills",
    "bookmakers": [{
        "key": "testbook",
        "markets": [
            {"key": "h2h", "outcomes": [
                {"name": "Kansas City Chiefs", "price": -200},
                {"name": "Buffalo Bills", "price": 170},
            ]},
            {"key": "spreads", "outcomes": [
                {"name": "Kansas City Chiefs", "price": -110, "point": -3.5},
                {"name": "Buffalo Bills", "price": -110, "point": 3.5},
            ]},
            {"key": "totals", "outcomes": [
                {"name": "Over", "price": -105, "point": 47.5},
                {"name": "Under", "price": -115, "point": 47.5},
            ]},
        ],
    }],
}

matcher = lambda home, away: "g1" if (home, away) == ("KC", "BUF") else None
parsed = parse_event(event, matcher)

# Unmatchable cases stay pure: unknown team name and a pairing off the slate.
bogus_team = dict(event, home_team="Narnia Lions")
off_slate = dict(event, home_team="Detroit Lions")

ph_raw = _american_to_prob(-200)
pa_raw = _american_to_prob(170)
ph, pa = _devig_pair(ph_raw, pa_raw)

print(json.dumps({
    "game_id": parsed[0], "markets": parsed[1],
    "bogus_none": parse_event(bogus_team, matcher) is None,
    "off_slate_none": parse_event(off_slate, matcher) is None,
    "ph_raw": ph_raw, "pa_raw": pa_raw, "ph": ph, "pa": pa,
}))
`;

test('odds_api.parse_event de-vigs a synthetic h2h event (normalize sums to 1)', () => {
  const r = runPy(ODDS_PY);
  assert.equal(r.game_id, 'g1');
  // Raw implied probs carry the vig (sum > 1); pairwise normalize sums to 1.
  assert.ok(Math.abs(r.ph_raw - 200 / 300) < 1e-9);
  assert.ok(Math.abs(r.pa_raw - 100 / 270) < 1e-9);
  assert.ok(r.ph_raw + r.pa_raw > 1, 'raw probs must include the vig');
  assert.ok(Math.abs(r.ph + r.pa - 1) < 1e-9, 'de-vigged pair must sum to 1');
  const ml = r.markets.moneyline;
  assert.ok(Math.abs(ml.home_prob - r.ph) < 1e-4);
  assert.ok(Math.abs(ml.away_prob - r.pa) < 1e-4);
  assert.ok(Math.abs(ml.home_prob + ml.away_prob - 1) < 1e-3);
});

test('odds_api.parse_event parses spread + total and rejects unmatchable events', () => {
  const r = runPy(ODDS_PY);
  // Equal -110/-110 spread prices de-vig to a fair 0.5/0.5.
  assert.equal(r.markets.spread.home_cover_prob, 0.5);
  assert.equal(r.markets.spread.away_cover_prob, 0.5);
  assert.equal(r.markets.spread.selection, 'KC -3.5');
  // Total: -105 Over vs -115 Under -> Over slightly below 0.5; line carried.
  assert.equal(r.markets.total.line, 47.5);
  assert.ok(r.markets.total.over_prob > 0.48 && r.markets.total.over_prob < 0.5);
  // Unknown team name and off-slate pairing both return None (caller counts them).
  assert.equal(r.bogus_none, true);
  assert.equal(r.off_slate_none, true);
});
