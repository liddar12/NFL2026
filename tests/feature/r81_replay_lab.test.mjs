/* tests/feature/r81_replay_lab.test.mjs — R81 PARLAY REPLAY LAB, locked.
 *
 * The lab exists to answer "would this candidate rule have done better?" on the
 * weeks already played, and its whole value depends on three properties that a
 * careless edit would quietly destroy:
 *
 *   1. IDENTICAL LEGS. Every variant re-prices the SAME resolved legs, and each
 *      paired comparison runs on exactly the legs that variant priced — never on
 *      the baseline's larger set. A variant that silently scores a different
 *      population is measuring the population, not the rule.
 *   2. NOTHING ADOPTS. The module writes exactly one file, its own output. There
 *      is no gate, no promotion, and no variant function that can even see a book
 *      price — the registry signature does not hand one over.
 *   3. ABSENT IS ABSENT. A locked leg with no outcome is counted under its reason
 *      and never scored; a parlay with any unresolved leg is excluded and counted;
 *      and a document with nothing resolved is all nulls, never zeros.
 *
 * Also locked: the four variants produce the numbers they claim on a fixture, the
 * bootstrap calls better/worse/same from synthetic outcomes where the answer is
 * known, the parlay recomputation is the BUILDER's arithmetic (an archived parlay
 * reproduces its own model_ev), the selection rules count what they name, and the
 * committed document round-trips through the script and its contract.
 *
 * Node built-ins only; the Python core is driven through `python3 -`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const PRELUDE = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
import scripts.replay_lab as rl
`;

/** Run a python snippet against the module; return the last stdout line as JSON. */
function py(body) {
  const r = spawnSync('python3', ['-'], {
    input: PRELUDE + body, cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/* 1 — every variant prices IDENTICAL legs ------------------------------------ */

test('every variant re-prices the same resolved legs, and its skips are counted', () => {
  const out = py(`
ledger, scores, archives, pool = rl._fixture()
rows, reasons, counts = rl.join_legs(ledger, scores)
ctx = {"pool_calibration": pool["calibration"], "pool_support": pool["support"]}
keys = {}
per = {}
for name in rl.VARIANTS:
    priced, skipped = rl.price_rows(rows, name, ctx)
    per[name] = {"priced": len(priced), "skipped": skipped}
    keys[name] = sorted(str(rl.leg_key(r["week"], r["game_id"], r["market"], r["selection"]))
                        for r, _ in priced)
base = keys[rl.BASELINE]
print(json.dumps({"counts": counts, "reasons": reasons, "per": per,
                  "n_rows": len(rows),
                  "subset_of_baseline": {k: set(v).issubset(set(base)) is True
                                         for k, v in keys.items()}}))
`);
  // the join scores only LOCKED legs that RESOLVED; everything else is counted
  assert.deepEqual(out.counts, { on_file: 8, locked: 7, unlocked: 1, resolved: 5 });
  assert.deepEqual(out.reasons, { no_stat_line: 1, week_not_resolved: 1 });
  for (const [name, v] of Object.entries(out.per)) {
    assert.equal(v.priced + v.skipped, out.n_rows,
      `${name}: priced + skipped must account for every resolved leg`);
    assert.ok(out.subset_of_baseline[name],
      `${name}: priced a leg the baseline never saw — the populations diverged`);
  }
  assert.equal(out.per.shipped.priced, 5);
  assert.equal(out.per.shipped.skipped, 0);
});

test('the paired comparison uses the baseline on EXACTLY the legs the variant priced', () => {
  const doc = readJson('data/replay_lab.json');
  const shipped = doc.variants.shipped.legs.pooled;
  for (const [name, v] of Object.entries(doc.variants)) {
    const p = v.legs.pooled;
    if (p.n === 0) continue;
    assert.equal(typeof p.shipped_log_loss_same_legs, 'number', name);
    if (p.n === shipped.n) {
      assert.equal(p.shipped_log_loss_same_legs, shipped.log_loss,
        `${name}: same leg count but a different baseline loss`);
    }
    // the delta is the difference it claims to be, to rounding
    assert.ok(Math.abs((p.log_loss - p.shipped_log_loss_same_legs) - p.delta_log_loss) < 5e-3,
      `${name}: delta ${p.delta_log_loss} does not reconcile with `
      + `${p.log_loss} - ${p.shipped_log_loss_same_legs}`);
  }
});

/* 2 — each variant produces the number it claims ------------------------------ */

test('seed / pool / margin / shrink produce the expected numbers on a fixture', () => {
  const out = py(`
import math
import scripts.models.parlay_builder as pb
import scripts.backtest_parlay as bp
ledger, scores, archives, pool = rl._fixture()
rows, _, _ = rl.join_legs(ledger, scores)
ctx = {"pool_calibration": pool["calibration"], "pool_support": pool["support"]}
by = {r["market"]: r for r in rows}
qb, wr, ml, sp = by["qb_pass_yds"], by["wr_rec_yds"], by["moneyline"], by["spread"]
tight = {"pool_calibration": pool["calibration"],
         "pool_support": {"QB": [0.0, 0.05], "RB": [0.0, 0.05], "WR": [0.0, 0.05]}}
print(json.dumps({
  "seed_prop": rl.v_seed(qb, ctx), "seed_prop_want": pb.seed_prop_prob(qb["p_team"]),
  "seed_ml": rl.v_seed(ml, ctx), "seed_ml_want": ml["p_team"],
  "seed_spread": rl.v_seed(sp, ctx),
  "shrink_qb": rl.v_shrink_to_half(qb, ctx),
  "shrink_qb_want": 0.5 + 0.5 * (qb["shipped_prob"] - 0.5),
  "shrink_game_untouched": rl.v_shrink_to_half(ml, ctx) == ml["shipped_prob"],
  "pool_qb": rl.v_pool_calibration(qb, ctx),
  "pool_qb_want": pb._clamp(pb._sigmoid(0.13 + 1.29 * qb["z"] + 0.54 * (qb["p_team"] - 0.5)),
                            0.05, 0.95),
  "pool_game_untouched": rl.v_pool_calibration(ml, ctx) == ml["shipped_prob"],
  "pool_out_of_support": rl.v_pool_calibration(dict(qb, z=9.0), ctx),
  "pool_tight_skips": rl.price_rows(rows, "pool_calibration", tight)[1],
  "pool_wide_skips": rl.price_rows(rows, "pool_calibration", ctx)[1],
  "margin_spread": rl.v_spread_margin_model(sp, ctx),
  "margin_spread_want": bp.shipped_home_cover_prob(sp["p_team"], -sp["line"]),
  "margin_even": rl.v_spread_margin_model(
      {"market": "spread", "p_team": 0.5, "line": 0.0, "shipped_prob": 0.5}, ctx),
  "margin_props_untouched": rl.v_spread_margin_model(qb, ctx) == qb["shipped_prob"],
  "phi_half": rl.phi(0.0), "phi_inv_half": rl.phi_inv(0.5),
}))
`);
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
  close(out.seed_prop, out.seed_prop_want, 'seed prop = seed_prop_prob(p_team)');
  close(out.seed_ml, out.seed_ml_want, 'seed moneyline = p_team');
  assert.equal(out.seed_spread, 0.5, 'seed spread is a flat coin flip');
  close(out.shrink_qb, out.shrink_qb_want, 'shrink halves the distance from 0.5');
  assert.equal(out.shrink_game_untouched, true, 'shrink is props only');
  close(out.pool_qb, out.pool_qb_want, 'pool prop uses the wide-pool coefficients');
  assert.equal(out.pool_game_untouched, true, 'the pool never fit game legs');
  assert.equal(out.pool_out_of_support, null,
    'a leg outside the pool support must be SKIPPED, never extrapolated');
  assert.ok(out.pool_tight_skips > out.pool_wide_skips,
    'a tighter support window must skip more legs');
  // the retired rule, reproduced EXACTLY — this variant re-measures that rule,
  // not a lookalike of it.
  close(out.margin_spread, out.margin_spread_want, 'margin rule = the retired rule');
  close(out.margin_even, 0.5, 'a pick-em at a zero handicap is 0.5');
  assert.equal(out.margin_props_untouched, true, 'the margin variant is spreads only');
  close(out.phi_half, 0.5, 'Phi(0)');
  close(out.phi_inv_half, 0.0, 'Phi^-1(0.5)');
});

/* 3 — the bootstrap verdict ---------------------------------------------------- */

test('the bootstrap calls better / worse / same on synthetic outcomes', () => {
  const out = py(`
n = 400
ship = [(0.5, i % 2) for i in range(n)]
good = [(0.9 if y else 0.1, y) for _, y in ship]
bad = [(0.1 if y else 0.9, y) for _, y in ship]
d_good = [rl.log_loss_one(p, y) - rl.log_loss_one(0.5, y) for p, y in good]
d_bad = [rl.log_loss_one(p, y) - rl.log_loss_one(0.5, y) for p, y in bad]
# a NOISY small sample must not earn a verdict: the mean leans one way, the
# spread swamps it. (A perfectly consistent edge on 12 legs IS significant under
# a bootstrap, and should be — this is the case that is not.)
d_tiny = [(-0.5 if i % 2 else 0.54) for i in range(20)]
print(json.dumps({
  "good": rl.verdict_of(rl.paired_bootstrap(d_good)[1]),
  "bad": rl.verdict_of(rl.paired_bootstrap(d_bad)[1]),
  "flat": rl.verdict_of(rl.paired_bootstrap([0.0] * n)[1]),
  "tiny": rl.verdict_of(rl.paired_bootstrap(d_tiny)[1]),
  "none": rl.verdict_of(None),
  "empty": rl.paired_bootstrap([]),
  "deterministic": rl.paired_bootstrap(d_good) == rl.paired_bootstrap(d_good),
  "ci_good": rl.paired_bootstrap(d_good)[1],
}))
`);
  assert.equal(out.good, 'better');
  assert.equal(out.bad, 'worse');
  assert.equal(out.flat, 'same', 'no difference at all is "same", not "better"');
  assert.equal(out.tiny, 'same', 'a noisy 20-leg sample must not earn a verdict');
  assert.equal(out.none, null);
  assert.deepEqual(out.empty, [null, null], 'no legs = no statistic, never a zero');
  assert.equal(out.deterministic, true, 'a fixed seed must give a reproducible CI');
  assert.ok(out.ci_good[1] < 0, 'a winning variant’s CI sits below 0');
});

/* 4 — the parlay replay is the BUILDER's arithmetic ---------------------------- */

test('an archived parlay recomputed leg-for-leg reproduces the builder\u2019s own EV', () => {
  const out = py(`
import glob
import scripts.models.parlay_builder as pb
import scripts.build_review as br
ledger = json.load(open("data/estimates/parlays_2026.json"))
scores = json.load(open("data/parlay_leg_scores.json"))
archives = rl.archive_weeks(glob.glob(rl.ARCHIVE_GLOB))
rows, _, _ = rl.join_legs(ledger, scores)
weeks = {r["week"] for r in rows}
outcomes = {rl.leg_key(r["week"], r["game_id"], r["market"], r["selection"]): r["y"]
            for r in rows}
led_idx = {(int(l["week"]), l["market"], l["selection"]): l for l in ledger["legs"]}
corr = pb._correlation_table(pb.load_calibration())

# ARM 1 — feed the replay each archived card's OWN leg probabilities. It must
# then reproduce that card's model_ev and confidence_tier exactly: proof that the
# lab recombines with the builder's arithmetic and not a local copy of it.
#
# ONE CARD AT A TIME, because since R90/F12 the archive keeps a FROZEN card
# verbatim and appends the next generation's card beside it, so one (week,
# market, selection) legitimately carries several archived probabilities — 22 of
# week 2's 167 legs did on 2026-09-20. Flattening the archive into one price per
# leg (what this arm used to do) handed a frozen card the price of whichever
# later card was written last, and 41 of 101 cards then "failed" to reproduce an
# EV nobody had computed that way. The archive is not the thing that drifted.
arm1, archived_cards = [], []
for wk, doc in archives:
    for card in doc["parlays"]:
        own = {}
        for lg in card["legs"]:
            led = led_idx.get((wk, lg["market"], lg["selection"]))
            if led is None:
                continue
            own[rl.leg_key(wk, led.get("game_id"), lg["market"],
                           lg["selection"])] = lg["model_prob"]
        replayed, _ = rl.replay_parlays([(wk, {"parlays": [card]})], led_idx, own,
                                        outcomes, {}, br.ledger_price_index(ledger),
                                        corr, weeks)
        for row in replayed:
            arm1.append(row)
            archived_cards.append(card)

# ARM 2 — the real \`shipped\` baseline: the price LOCKED on first sight, which
# is what the resolver grades. Same arithmetic, an earlier snapshot of the leg.
locked = {rl.leg_key(r["week"], r["game_id"], r["market"], r["selection"]): r["shipped_prob"]
          for r in rows}
arm2, excluded = rl.replay_parlays(archives, led_idx, locked, outcomes, {},
                                   br.ledger_price_index(ledger), corr, weeks)

# parlay_id is NOT the archive's identity (R90: card_id is, and a rank change
# adds a card), so the two arms are paired POSITIONALLY: both walk the same
# archive in the same order and apply the same eligibility rules, which the
# alignment check below asserts rather than assumes.
worst = max((abs(r["model_ev"] - c["model_ev"])
             for r, c in zip(arm1, archived_cards)), default=None)
tiers = sum(1 for r, c in zip(arm1, archived_cards)
            if r["tier"] != c["confidence_tier"])
aligned = (len(arm1) == len(arm2)
           and all(a["week"] == b["week"] and a["parlay_id"] == b["parlay_id"]
                   for a, b in zip(arm1, arm2)))
moved = sum(1 for a, b in zip(arm1, arm2)
            if abs(a["model_ev"] - b["model_ev"]) > 1e-9)
money_same = all(a["net_fair"] == b["net_fair"] for a, b in zip(arm1, arm2))
print(json.dumps({"n": len(arm1), "worst_ev_gap": worst, "tier_mismatches": tiers,
                  "n_locked": len(arm2), "aligned": aligned, "moved": moved,
                  "money_same": money_same, "excluded": excluded}))
`);
  assert.ok(out.n > 10, `only ${out.n} parlays replayed`);
  assert.ok(out.worst_ev_gap < 1e-9,
    `the recomputed EV drifted from the archive by ${out.worst_ev_gap} — the lab is `
    + 'not using the builder\u2019s arithmetic');
  assert.equal(out.tier_mismatches, 0, 'the confidence tier must reproduce too');
  // The baseline is the LOCKED price, not the archived card's later refresh, so
  // the two arms differ — and the record has to say so rather than let a reader
  // assume the replayed EV is the number printed on the card.
  assert.equal(out.n_locked, out.n, 'both arms must replay the same parlays');
  assert.equal(out.aligned, true,
    'the per-card arm and the whole-archive arm walked the archive differently — '
    + 'the positional pairing below would compare two different cards');
  assert.ok(out.moved > 0, 'the locked and archived snapshots are identical here — '
    + 'if that is genuinely true the limits note about them should be retired');
  assert.ok(out.money_same,
    'the realised settlement must not move with the pricing snapshot: what a bet '
    + 'paid is a fact about the outcome and the book price');
  const doc = readJson('data/replay_lab.json');
  assert.ok(doc.limits.some((l) => /LOCKED ON FIRST SIGHT/.test(l)),
    'the record must state that the baseline is the locked price, not the card\u2019s');
  // an unresolved leg excludes its parlay, counted by reason — never settled on
  // the legs that happen to have graded.
  assert.ok(Object.keys(out.excluded).length > 0, 'nothing was excluded at all');
  for (const [reason, n] of Object.entries(out.excluded)) {
    assert.ok(Number.isInteger(n) && n > 0, `${reason}: ${n}`);
  }
});

test('the selection rules count what they name, and an empty selection has no ROI', () => {
  const out = py(`
rows = [
 {"week": 1, "parlay_id": "a", "scope": "game", "n_legs": 2, "model_ev": 0.10,
  "tier": "high", "bucket": "all_hit", "net_fair": 200.0, "net_vig2": 180.0,
  "assumed_price_legs": 0},
 {"week": 1, "parlay_id": "b", "scope": "game", "n_legs": 3, "model_ev": 0.02,
  "tier": "low", "bucket": "all_missed", "net_fair": -100.0, "net_vig2": -100.0,
  "assumed_price_legs": 1},
 {"week": 1, "parlay_id": "c", "scope": "week", "n_legs": 2, "model_ev": -0.30,
  "tier": "low", "bucket": "partial", "net_fair": -100.0, "net_vig2": -100.0,
  "assumed_price_legs": 2},
]
print(json.dumps({
  "picked": {r: [x["parlay_id"] for x in rl.select(rows, r)] for r in rl.SELECTION_RULES},
  "settled_ev": rl.settle(rl.select(rows, "ev_gt_0")),
  "settled_empty": rl.settle([]),
  "rules": list(rl.SELECTION_RULES),
}))
`);
  assert.deepEqual(out.picked.all, ['a', 'b', 'c']);
  assert.deepEqual(out.picked.ev_gt_0, ['a', 'b']);
  assert.deepEqual(out.picked['ev_gt_0.05'], ['a']);
  assert.deepEqual(out.picked.tier_high_only, ['a']);
  assert.deepEqual(out.picked.max_2_legs, ['a', 'c']);
  assert.deepEqual(out.settled_ev, {
    n: 2, hit: 1, staked: 200.0, net_fair: 100.0, net_vig2: 80.0,
    roi_fair: 0.5, roi_vig2: 0.4, assumed_price_legs: 1,
  });
  assert.equal(out.settled_empty.n, 0);
  assert.equal(out.settled_empty.roi_fair, null, 'an empty selection has no ROI, not 0');
  assert.equal(out.settled_empty.staked, null);
});

/* 5 — absent is absent --------------------------------------------------------- */

test('a 0-resolved-week document validates against the contract with nulls, never zeros', () => {
  const out = py(`
sys.path.insert(0, ${JSON.stringify(ROOT)})
from scripts.validate_data import validate_against_schema, ValidationError
ledger, scores, archives, pool = rl._fixture()
doc = rl.build(ledger=ledger, scores={"resolved": [], "unresolved": []},
               archives=archives, pool=pool, generated_utc="2026-01-01T00:00:00Z")
schema = json.load(open("data/contracts/replay_lab.schema.json"))
err = None
try:
    validate_against_schema(doc, schema, "replay_lab.json (0 weeks)")
except ValidationError as exc:
    err = str(exc)
print(json.dumps({
  "err": err, "weeks": doc["weeks_replayed"], "resolved": doc["legs"]["resolved"],
  "reasons": doc["legs"]["unresolved_by_reason"],
  "pooled": {k: v["legs"]["pooled"] for k, v in doc["variants"].items()},
  "rules": {k: v["parlays"]["rules"]["all"] for k, v in doc["variants"].items()},
  "eligible": {k: v["parlays"]["eligible"] for k, v in doc["variants"].items()},
}))
`);
  assert.equal(out.err, null, out.err);
  assert.deepEqual(out.weeks, []);
  assert.equal(out.resolved, 0);
  assert.deepEqual(out.reasons, { week_not_resolved: 7 });
  for (const [name, p] of Object.entries(out.pooled)) {
    assert.equal(p.n, 0, name);
    for (const k of ['hit_rate', 'log_loss', 'brier', 'delta_log_loss', 'ci90',
      'verdict', 'shipped_log_loss_same_legs']) {
      assert.equal(p[k], null, `${name}.${k} must be null with nothing resolved, got ${p[k]}`);
    }
  }
  for (const [name, r] of Object.entries(out.rules)) {
    assert.equal(r.n, 0, name);
    assert.equal(r.staked, null, `${name}: staked must be null, not 0`);
    assert.equal(r.net_fair, null, name);
    assert.equal(r.roi_fair, null, name);
  }
  for (const [name, n] of Object.entries(out.eligible)) assert.equal(n, 0, name);
});

/* 6 — the committed document round-trips --------------------------------------- */

test('the script reproduces the committed document and it validates against the contract', () => {
  assert.ok(existsSync(join(ROOT, 'data/replay_lab.json')),
    'the committed replay lab record is missing');
  const dir = mkdtempSync(join(tmpdir(), 'r81-'));
  try {
    const out = join(dir, 'replay_lab.json');
    const run = spawnSync('python3', ['scripts/replay_lab.py', '--out', out],
      { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const fresh = JSON.parse(readFileSync(out, 'utf8'));
    const committed = readJson('data/replay_lab.json');
    // generated_utc is a clock; everything else must be byte-for-byte identical,
    // which is what makes the fixed bootstrap seed worth having.
    delete fresh.generated_utc;
    const committedNoStamp = { ...committed };
    delete committedNoStamp.generated_utc;
    assert.deepEqual(fresh, committedNoStamp,
      'the committed record is not what the script produces from the committed inputs');

    const v = py(`
from scripts.validate_data import validate_against_schema, ValidationError
doc = json.load(open(${JSON.stringify(out)}))
schema = json.load(open("data/contracts/replay_lab.schema.json"))
err = None
try:
    validate_against_schema(doc, schema, "replay_lab.json")
except ValidationError as exc:
    err = str(exc)
print(json.dumps({"err": err}))
`);
    assert.equal(v.err, null, v.err);

    // the committed file writes nothing else: the temp dir holds one file.
    const stray = spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.trim().split('\n');
    assert.deepEqual(stray, ['replay_lab.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed record is honest about what it measured', () => {
  const doc = readJson('data/replay_lab.json');
  assert.equal(doc.baseline, 'shipped');
  assert.ok(Array.isArray(doc.policy) && doc.policy.length >= 4);
  assert.match(doc.policy[0], /MEASURE ONLY/);
  assert.ok(doc.policy.some((p) => /never an input/i.test(p)),
    'the policy must still say a market number is never an input');
  assert.ok(doc.limits.some((l) => /snapshot/i.test(l)),
    'the limits must name the input-snapshot limit');
  // a variant that moved nothing must not be sold as a measured "same"
  for (const [name, v] of Object.entries(doc.variants)) {
    if (name === doc.baseline) {
      assert.equal(v.verdict, null, 'the baseline has no verdict on itself');
      continue;
    }
    assert.ok(['better', 'worse', 'same', null].includes(v.verdict), `${name}: ${v.verdict}`);
    if (v.legs.changed_legs === 0) {
      assert.match(v.note, /nothing was measured/,
        `${name}: changed no leg, so its note must say the verdict measures nothing`);
    }
  }
  // unresolved legs are counted by reason, and they add up
  const counted = Object.values(doc.legs.unresolved_by_reason)
    .reduce((a, b) => a + b, 0);
  assert.equal(doc.legs.resolved + counted, doc.legs.locked,
    'every locked leg is either scored or counted under a reason');
});

/* 7 — nothing adopts ------------------------------------------------------------ */

test('the lab writes exactly one file — its own output — and has no gate', () => {
  const src = read('scripts/replay_lab.py');
  const writes = [...src.matchAll(/open\(([^,]+),\s*["']w["']/g)].map((m) => m[1].trim());
  assert.deepEqual(writes, ['out_path'],
    `replay_lab.py writes to ${writes.join(', ')} — the lab may only write its own record`);
  // no --gate / adoption vocabulary: a measure-only bench must not grow one by
  // accident, which is exactly how a "report" becomes a promotion path.
  assert.ok(!/add_argument\(["']--gate/.test(src), 'the replay lab must not have a --gate');
  assert.ok(!/["']adopt["']\s*:/.test(src), 'the replay lab must not emit an adopt flag');
  // and it must never name a calibration or slate artifact as a write target
  for (const artifact of ['parlay_backtest.json', 'leg_pool_backtest.json',
    'parlays.json', 'parlay_leg_scores.json']) {
    const re = new RegExp(`${artifact.replace('.', '\\.')}["']?\\s*,?\\s*["']w`);
    assert.ok(!re.test(src), `replay_lab.py opens ${artifact} for writing`);
  }
});

test('no variant function can see a book price', () => {
  const out = py(`
names = {}
for name, spec in rl.VARIANTS.items():
    code = spec["fn"].__code__
    names[name] = sorted(set(code.co_names) | {str(c) for c in code.co_consts if c is not None})
print(json.dumps(names))
`);
  for (const [name, used] of Object.entries(out)) {
    assert.ok(!used.includes('implied_prob'),
      `${name} reads implied_prob — a market number may never price a model leg`);
  }
});

test('the replay lab is wired into the pipeline and the smoke gate', () => {
  const yml = read('.github/workflows/daily.yml');
  assert.ok(yml.includes('scripts/replay_lab.py'),
    'nothing re-runs the lab, so a stale record would be indistinguishable from a fresh one');
  // it must run AFTER the resolver it reads
  assert.ok(yml.indexOf('scripts/resolve_parlay_legs.py') < yml.indexOf('scripts/replay_lab.py'),
    'the lab must run after the resolver whose outcomes it joins');
  const smoke = read('tests/smoke.sh');
  assert.ok(smoke.includes('scripts/replay_lab.py --selftest'),
    'the selftest is not in the smoke gate');
});

test('the Python core selftests clean', () => {
  const r = spawnSync('python3', [join('scripts', 'replay_lab.py'), '--selftest'],
    { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /selftest OK/);
});
