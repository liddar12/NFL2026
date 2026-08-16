/* tests/feature/parlay_market_independence.test.mjs — R30 blockers, locked.
 *
 * THE POLICY (permanent, owner's words): "I don't want to use Vegas odds in my
 * predictions. If I use them, I'd only want to show them." A market price may be
 * DISPLAYED; it may never be an input to a number we produce.
 *
 * What shipped before R30 broke that in three ways, and this file pins all three:
 *
 *   F1  parlay_builder.derive_candidate_legs passed the book's de-vigged cover
 *       probability as make_leg's third POSITIONAL argument — which is model_prob —
 *       with implied_prob=None alongside, so make_leg then fabricated the IMPL column
 *       back off it (model_prob * 1.045). Both columns on the card were the same book
 *       number. Locked here: the spread leg's model_prob is OUR margin model at the
 *       book's handicap, the book's number appears ONLY in implied_prob, and a market
 *       we have no model for (total) yields NO LEG rather than a borrowed price or a
 *       seed.
 *   F2  odds_api built the spread selection unconditionally from the HOME team while
 *       the builder picked the probability by whichever side OUR model favoured, so an
 *       away favourite named one team and priced the other (3 of 16 shipped games).
 *       Locked here: the team named in `selection` is the team the probability was
 *       computed for, on both sides, including the _side used for correlation.
 *   F3  parlays.schema.json called confidence_tier "Conformal-derived". Locked here:
 *       the contract no longer claims a calibration that does not exist.
 *
 * Plus the gate check itself: validate_data.check_parlay_model_independence must FAIL
 * on the old-shaped document (a check that has never failed is not a check).
 *
 * Node built-ins only; the Python cores are driven through `python3 -` (the
 * parlay_props.test.mjs pattern).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    input: code,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

/** Standard normal CDF — the test does its own math, it does not import the model's. */
function normCdf(z) {
  // Abramowitz & Stegun 7.1.26 style erf approximation (|err| < 1.5e-7).
  const s = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}

/** Inverse standard normal (Beasley-Springer-Moro) — good to ~1e-9 in the body. */
function invNormCdf(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687,
    138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572];
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q)
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const SIGMA = 13.5; // game_model's margin sigma, restated here on purpose.

/** OUR P(home covers `homePoint`) from OUR home win probability. */
function ourHomeCover(pHome, homePoint) {
  return normCdf((invNormCdf(pHome) * SIGMA + homePoint) / SIGMA);
}

/* -------------------------------------------------------------------------
 * F1 + F2 on the builder: an AWAY favourite (the case that shipped wrong).
 * KC hosts DEN. The book has KC -3 (home cover 0.4892 / away cover 0.5108).
 * OUR model has DEN ahead (p_home 0.406) — so the leg must be DEN's.
 * ---------------------------------------------------------------------- */
const LEGS_PY = `
import json, sys
sys.path.insert(0, ".")
from scripts.models.parlay_builder import derive_candidate_legs, model_cover_prob

game = {"game_id": "g1", "home": "KC", "away": "DEN",
        "probs": {"home": 0.406, "away": 0.594}}
market = {
    "moneyline": {"home_prob": 0.55, "away_prob": 0.45},
    "spread": {"home_cover_prob": 0.4892, "away_cover_prob": 0.5108,
               "home_point": -3.0,
               "home_selection": "KC -3", "away_selection": "DEN +3"},
    "total": {"over_prob": 0.5238, "line": 44.5},
}
home_fav = {"game_id": "g2", "home": "SEA", "away": "NE",
            "probs": {"home": 0.61, "away": 0.39}}
home_market = {
    "spread": {"home_cover_prob": 0.5, "away_cover_prob": 0.5,
               "home_point": -3.5,
               "home_selection": "SEA -3.5", "away_selection": "NE +3.5"},
    "total": {"over_prob": 0.4881, "line": 43.5},
}

print(json.dumps({
    "away_fav": derive_candidate_legs(game, market=market),
    "home_fav": derive_candidate_legs(home_fav, market=home_market),
    # No market at all: nothing to price a cover against.
    "no_market": derive_candidate_legs(game),
    # A total market present but no line emitted for it.
    "total_only": derive_candidate_legs(game, market={"total": market["total"]}),
    "cover_home_minus3": model_cover_prob(0.406, -3.0),
}))
`;

test('F1: the spread leg carries OUR cover probability, the book only reaches IMPL', () => {
  const r = runPy(LEGS_PY);
  const leg = r.away_fav.find((l) => l.market === 'spread');
  assert.ok(leg, 'a priced spread must still produce a leg');

  // Our number, recomputed independently: DEN +3 with our p_home = 0.406.
  const expected = 1 - ourHomeCover(0.406, -3.0);
  assert.ok(Math.abs(leg.model_prob - expected) < 2e-3,
    `model_prob ${leg.model_prob} is not our margin model's ${expected.toFixed(4)}`);

  // The book's de-vigged number is DISPLAY ONLY: exactly implied_prob, never model.
  assert.equal(leg.implied_prob, 0.5108, 'IMPL must be the book de-vigged away cover');
  assert.notEqual(leg.model_prob, 0.5108, 'the book price must NOT be the model prob');
  assert.notEqual(leg.model_prob, 0.4892);

  // And it is not the deleted seed either (0.5 + (p_fav-0.5)*0.7 = 0.5658), which
  // ignored the handicap entirely and must never come back as a fallback.
  assert.ok(Math.abs(leg.model_prob - (0.5 + (0.594 - 0.5) * 0.7)) > 1e-3,
    'the removed seed formula must not be reachable');

  // IMPL is a real fetched price, so it is NOT the fabricated model*(1+hold).
  assert.ok(Math.abs(leg.implied_prob - leg.model_prob * 1.045) > 1e-4,
    'IMPL must be the book price, not the model re-vigged by the hold');
});

test('F2: the team named in the selection is the team the probability is for', () => {
  const r = runPy(LEGS_PY);
  const away = r.away_fav.find((l) => l.market === 'spread');
  // Our favourite is the AWAY team, so the label, the probability and the
  // correlation side must ALL be the away side's — the shipped bug named "KC -3"
  // while carrying P(DEN covers).
  assert.equal(away.selection, 'DEN +3');
  assert.equal(away._side, 'away');
  assert.ok(away.model_prob > 0.5, 'our model favours DEN, so DEN +3 must be > 0.5');
  assert.equal(r.away_fav.find((l) => l.market === 'moneyline').selection, 'DEN ML');

  // Home favourite: the mirror case must still name the home side.
  const home = r.home_fav.find((l) => l.market === 'spread');
  assert.equal(home.selection, 'SEA -3.5');
  assert.equal(home._side, 'home');
  const expectedHome = ourHomeCover(0.61, -3.5);
  assert.ok(Math.abs(home.model_prob - expectedHome) < 2e-3);

  // The two sides of one line must be complements of each other, not two
  // independently-chosen numbers (1e-4: the leg's prob is rounded to 4 dp).
  assert.ok(Math.abs(r.cover_home_minus3 + away.model_prob - 1) < 1e-4);
});

test('F1: a market with no model of ours yields NO leg (total dropped, not seeded)', () => {
  const r = runPy(LEGS_PY);
  for (const key of ['away_fav', 'home_fav', 'no_market', 'total_only']) {
    assert.equal(r[key].filter((l) => l.market === 'total').length, 0,
      `${key}: a total leg must never be emitted — no scoring model exists`);
  }
  // A total in hand does not conjure any other leg either.
  assert.deepEqual(r.total_only.map((l) => l.market), ['moneyline']);
  // No handicap -> no spread leg, rather than a borrowed book price or a seed.
  assert.equal(r.no_market.filter((l) => l.market === 'spread').length, 0);
});

/* -------------------------------------------------------------------------
 * odds_api: both sides labelled, sign mirrored, no home-only `selection`.
 * ---------------------------------------------------------------------- */
const ODDS_PY = `
import json, sys
sys.path.insert(0, ".")
from scripts.scrape.odds_api import parse_event

event = {
    "home_team": "Kansas City Chiefs", "away_team": "Buffalo Bills",
    "bookmakers": [{"key": "testbook", "markets": [
        {"key": "spreads", "outcomes": [
            {"name": "Kansas City Chiefs", "price": -110, "point": -3.5},
            {"name": "Buffalo Bills", "price": -110, "point": 3.5},
        ]},
    ]}],
}
gid, markets = parse_event(event, lambda h, a: "g1" if (h, a) == ("KC", "BUF") else None)
print(json.dumps({"spread": markets["spread"]}))
`;

test('F2: odds_api emits both sides of the spread with mirrored signs', () => {
  const { spread } = runPy(ODDS_PY);
  assert.equal(spread.home_selection, 'KC -3.5');
  assert.equal(spread.away_selection, 'BUF +3.5');
  assert.equal(spread.home_point, -3.5);
  assert.ok(!('selection' in spread),
    'the ambiguous home-only `selection` must be gone, not merely supplemented');
});

/* -------------------------------------------------------------------------
 * The gate check must actually fail on the old data shape.
 * ---------------------------------------------------------------------- */
const VALIDATOR_PY = `
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import check_parlay_model_independence, ValidationError

preds = {"games": [
    {"game_id": "g1", "home": "KC", "away": "DEN",
     "probs": {"home": 0.406, "away": 0.594}},
]}

def verdict(doc):
    try:
        check_parlay_model_independence(doc, preds)
        return None
    except ValidationError as exc:
        return str(exc)

def parlay(legs):
    return {"parlays": [{"parlay_id": "p1", "scope": "game", "game_id": "g1",
                         "legs": legs}]}

# The OLD shape: the book's de-vigged away cover prob in model_prob, the IMPL
# column fabricated off it by the 4.5% hold, and the HOME team's label.
old_shape = parlay([{"market": "spread", "selection": "KC -3",
                     "model_prob": 0.5108, "implied_prob": 0.5338}])
# The side-mismatch on its own: our number, but attributed to the other team.
mislabelled = parlay([{"market": "spread", "selection": "KC -3",
                       "model_prob": 0.6771, "implied_prob": 0.4892}])
# A total leg reappearing.
total_leg = parlay([{"market": "total", "selection": "Over 44.5",
                     "model_prob": 0.52, "implied_prob": 0.5238}])
# The market feed's number landing in BOTH columns.
same_both = parlay([{"market": "moneyline", "selection": "DEN ML",
                     "model_prob": 0.45, "implied_prob": 0.45}])
# The FIXED shape: our margin model for the team named, book price in IMPL.
fixed = parlay([{"market": "spread", "selection": "DEN +3",
                 "model_prob": 0.6771, "implied_prob": 0.5108},
                {"market": "moneyline", "selection": "DEN ML",
                 "model_prob": 0.594, "implied_prob": 0.45},
                {"market": "qb_pass_yds", "selection": "P. Mahomes 225+ pass yds",
                 "model_prob": 0.4624, "implied_prob": 0.4832}])

print(json.dumps({
    "old_shape": verdict(old_shape),
    "mislabelled": verdict(mislabelled),
    "total_leg": verdict(total_leg),
    "same_both": verdict(same_both),
    "fixed": verdict(fixed),
}))
`;

test('the gate check REDS on the old shape and passes the fixed one', () => {
  const r = runPy(VALIDATOR_PY);
  assert.ok(r.old_shape, 'the book price in model_prob MUST red the gate');
  assert.match(r.old_shape, /OUR margin model's cover probability/);
  assert.ok(r.mislabelled, 'a leg naming one team and pricing the other MUST red');
  assert.ok(r.total_leg, 'a total leg MUST red — no scoring model exists');
  assert.match(r.total_leg, /no scoring\/total model/);
  assert.ok(r.same_both, 'model_prob == the market feed probability MUST red');
  assert.equal(r.fixed, null, `the fixed shape must pass, got: ${r.fixed}`);
});

/* -------------------------------------------------------------------------
 * The shipped artifacts, not just the code paths (the R28 lesson: prove the
 * data moved).
 * ---------------------------------------------------------------------- */
const doc = JSON.parse(readFileSync(new URL('../../data/parlays.json', import.meta.url), 'utf8'));
const preds = JSON.parse(readFileSync(new URL('../../data/game_predictions.json', import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../../data/contracts/parlays.schema.json', import.meta.url), 'utf8'));

test('shipped parlays.json: every spread leg is OUR number for the team it names', () => {
  const byTeam = new Map();
  for (const g of preds.games) {
    byTeam.set(g.home, { pHome: g.probs.home, isHome: true });
    byTeam.set(g.away, { pHome: g.probs.home, isHome: false });
  }
  let checked = 0;
  for (const p of doc.parlays) {
    for (const leg of p.legs) {
      if (leg.market !== 'spread') continue;
      const m = /^([A-Z]{2,3}) ([+-]?\d+(?:\.\d+)?)$/.exec(leg.selection);
      assert.ok(m, `unparseable spread selection ${leg.selection}`);
      const [, team, pointStr] = m;
      const side = byTeam.get(team);
      assert.ok(side, `${leg.selection} names a team off the slate`);
      const point = Number(pointStr);
      const expected = side.isHome
        ? ourHomeCover(side.pHome, point)
        : 1 - ourHomeCover(side.pHome, -point);
      assert.ok(Math.abs(leg.model_prob - expected) < 2e-3,
        `${p.parlay_id} ${leg.selection}: model_prob ${leg.model_prob} != ours ${expected.toFixed(4)}`);
      // The old fabricated IMPL was exactly model * 1.045; a real price is not.
      assert.ok(Math.abs(leg.implied_prob - leg.model_prob * 1.045) > 1e-4,
        `${p.parlay_id} ${leg.selection}: IMPL looks fabricated from MODEL`);
      checked += 1;
    }
  }
  /* `checked >= 16` was a pin on one day's odds snapshot, and it broke the
   * gate the first time the odds feed shipped a slate with no handicaps: the
   * 2026-08-16T01:35Z refresh carried zero spread markets, the R30a builder
   * honestly emitted zero spread legs (the line DEFINES a cover bet — no
   * line, no leg, never a fabricated one), and this floor called that honesty
   * a failure. The vacuous-pass risk it guarded against (a drifted market
   * name silently skipping every leg) is covered exactly instead: every leg
   * the document CALLS a spread must have been checked. */
  const spreadLegs = doc.parlays
    .flatMap((p) => p.legs).filter((l) => l.market === 'spread').length;
  assert.equal(checked, spreadLegs,
    `${spreadLegs} spread legs in the document but only ${checked} verified`);
});

test('shipped parlays.json carries no total leg (no scoring model exists)', () => {
  for (const p of doc.parlays) {
    for (const leg of p.legs) {
      assert.notEqual(leg.market, 'total',
        `${p.parlay_id} ships a total leg with no model behind it`);
    }
  }
});

test('F3: the contract no longer claims a conformal confidence tier', () => {
  const tier = schema.properties.parlays.items.properties.confidence_tier.description;
  // The exact false claim, in any of its natural phrasings. (Naming
  // scripts/harness/conformal.py to say it is NOT involved is allowed and useful,
  // which is why this bans the claim rather than the word.)
  assert.ok(!/conformal[- ](derived|based)|conformal (confidence|coverage|band|tier)/i.test(tier),
    'confidence_tier is a hard-coded edge threshold; the contract may not call it conformal');
  assert.match(tier, /hard-coded edge threshold/i,
    'the contract must say what the tier actually is');
  assert.match(tier, /no coverage guarantee/i,
    'the contract must say plainly that no coverage is guaranteed');
  assert.ok(!/conformal/i.test(schema.description),
    'the file-level description may not claim a conformal tier either');
  // The model column's meaning is the load-bearing contract statement for F1.
  const legProps = schema.properties.parlays.items.properties.legs.items.properties;
  assert.match(legProps.model_prob.description,
    /de-vigged probability may never appear here/i);
  assert.match(legProps.implied_prob.description, /display only/i);
});
