/* tests/feature/r30b_pipeline.test.mjs — R30b pipeline/contract honesty locks.
 *
 * Four defects locked here, all adversarially verified in the R30 RCA
 * (docs/qa/R30_RCA_FINDINGS.md):
 *
 *   1. pipeline-contracts-unimplemented-schema-keywords — validate_data.py's
 *      docstring claimed a keyword subset while minProperties, maxProperties,
 *      pattern, exclusiveMinimum, exclusiveMaximum and minLength were silent
 *      no-ops in 12 contracts. Each keyword now has a negative case: a check
 *      that has never failed is not a check.
 *
 *   2. pipeline-contracts-market-prices-ref-hole — market_prices.schema.json
 *      used $ref, which the validator skipped, so NOTHING below the top level
 *      was validated (a 750% probability shipped clean). The definitions are
 *      now inlined, $ref is a hard validator error, and no contract may carry
 *      one again.
 *
 *   3. model-slate-parlays-kalshi-reported-ok-with-zero-rows (+ its minor twin
 *      pipeline-contracts-kalshi-zero-rows-reported-ok) — build_markets stamped
 *      "ok" unconditionally on success and build_predictions hardcoded "ok"
 *      without reading the row count, so kalshi shipped {rows: 0, status: "ok"}
 *      and the MODEL tab counted an empty feed among "feeds ok". The status
 *      decisions now live in two pure functions, unit-tested here directly.
 *
 *   4. pipeline-contracts-preseason-builder-never-runs — build_preseason.py's
 *      docstring claimed a registry weight and a promotion path that do not
 *      exist. It now states reality (experimental, unwired, output unread) and
 *      bannering every real run; these tests pin the honesty and the fact that
 *      wiring it up must consciously update them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

const PY_PRELUDE = `
import copy, json, sys
sys.path.insert(0, ".")
from scripts.validate_data import validate_against_schema, ValidationError

def verdict(value, schema):
    try:
        validate_against_schema(value, schema, "t")
        return {"ok": True, "err": ""}
    except ValidationError as exc:
        return {"ok": False, "err": str(exc)}
`;

/* ------------------------------------------------- 1. the six keywords bite */

test('every formerly-decorative schema keyword now fails a violating document', () => {
  const r = runPy(`${PY_PRELUDE}
cases = {
  "minProperties":     verdict({"a": 1}, {"type": "object", "minProperties": 30}),
  "maxProperties":     verdict({"a": 1, "b": 2, "c": 3},
                               {"type": "object", "maxProperties": 2}),
  "pattern":           verdict("advisory only",
                               {"type": "string", "pattern": "MEASUREMENT ONLY"}),
  "exclusiveMinimum":  verdict(0.0, {"type": "number", "exclusiveMinimum": 0}),
  "exclusiveMaximum":  verdict(1.0, {"type": "number", "exclusiveMaximum": 1}),
  "minLength":         verdict("short", {"type": "string", "minLength": 40}),
}
print(json.dumps(cases))
`);
  for (const [kw, v] of Object.entries(r)) {
    assert.equal(v.ok, false, `${kw} violation must fail validation`);
    assert.ok(v.err.includes(kw), `${kw} failure must name the keyword: ${v.err}`);
  }
});

test('the same keywords pass a document sitting exactly on every bound', () => {
  const r = runPy(`${PY_PRELUDE}
schema = {"type": "object", "minProperties": 2, "maxProperties": 2,
          "properties": {
            "policy": {"type": "string", "pattern": "MEASUREMENT ONLY",
                       "minLength": 16},
            "p": {"type": "number", "exclusiveMinimum": 0,
                  "exclusiveMaximum": 1}}}
print(json.dumps(verdict({"policy": "MEASUREMENT ONLY", "p": 0.5}, schema)))
`);
  assert.equal(r.ok, true, r.err);
});

test('the keyword enforcement matches what the real contracts rely on', () => {
  // team_strength.minProperties 30 was the R30 repro: a 1-team ratings map
  // validated clean. Prove it reds now, against the REAL schema.
  const r = runPy(`${PY_PRELUDE}
schema = json.load(open("data/contracts/team_strength.schema.json"))
doc = json.load(open("data/team_strength.json"))
committed = verdict(doc, schema)
partial = copy.deepcopy(doc)
partial["ratings"] = {"KC": 1600.0}
print(json.dumps({"committed": committed, "partial": partial and verdict(partial, schema)}))
`);
  assert.equal(r.committed.ok, true, `committed team_strength must stay green: ${r.committed.err}`);
  assert.equal(r.partial.ok, false, 'a 1-team ratings map must now red the gate');
  assert.match(r.partial.err, /minProperties/);
});

/* ------------------------------------- 2. the $ref hole is closed for good */

test('$ref is a hard validator error, never a silent no-op', () => {
  const r = runPy(`${PY_PRELUDE}
schema = {"type": "object",
          "properties": {"src": {"$ref": "#/definitions/source"}},
          "definitions": {"source": {"type": "object",
                                     "required": ["status"],
                                     "additionalProperties": False}}}
# Before R30b this passed: the $ref node had no type/properties, so garbage
# below it validated as anything-goes.
print(json.dumps(verdict({"src": {"bogus": 1}}, schema)))
`);
  assert.equal(r.ok, false, 'a schema carrying $ref must fail loudly');
  assert.match(r.err, /\$ref/);
  assert.match(r.err, /inline/i, 'the error must tell the author the fix');
});

test('no contract under data/contracts/ uses $ref', () => {
  const dir = join(REPO_ROOT, 'data', 'contracts');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!src.includes('"$ref"'),
      `${f} uses $ref — the validator hard-errors on it; inline the definition `
      + '(see player_backtest.schema.json\'s note)');
  }
});

test('market_prices.schema.json validates BELOW the top level (proof of bite)', () => {
  const r = runPy(`${PY_PRELUDE}
schema = json.load(open("data/contracts/market_prices.schema.json"))
doc = json.load(open("data/market_prices.json"))
committed = verdict(doc, schema)

bad_key = copy.deepcopy(doc)
bad_key["sources"]["kalshi"]["bogus_key"] = 123          # the R30 injection repro

bad_prob = copy.deepcopy(doc)
bad_prob["futures"]["polymarket"].append({"team": "KC", "prob": 7.5})

bad_status = copy.deepcopy(doc)
bad_status["sources"]["polymarket"]["status"] = "fine"

# What build_markets emits on a half-broken source must be DECLARED, so
# enforcement cannot re-run the R29 failure (cron dying on a by-design shape).
degraded = copy.deepcopy(doc)
degraded["sources"]["polymarket"] = {"status": "degraded", "rows": 15,
                                     "dropped_unmapped": 0,
                                     "note": "futures: event renamed"}
down = copy.deepcopy(doc)
down["sources"]["kalshi"] = {"status": "down", "rows": 0, "note": "HTTP 503"}

print(json.dumps({
  "committed": committed,
  "bad_key": verdict(bad_key, schema),
  "bad_prob": verdict(bad_prob, schema),
  "bad_status": verdict(bad_status, schema),
  "degraded_declared": verdict(degraded, schema),
  "down_declared": verdict(down, schema),
}))
`);
  assert.equal(r.committed.ok, true, `committed market_prices must stay green: ${r.committed.err}`);
  assert.equal(r.bad_key.ok, false, 'an undeclared nested key must red');
  assert.equal(r.bad_prob.ok, false, 'a 750% nested probability must red');
  assert.match(r.bad_prob.err, /maximum/);
  assert.equal(r.bad_status.ok, false, 'an off-enum nested status must red');
  assert.equal(r.degraded_declared.ok, true,
    `builder-emitted degraded+note must be legal: ${r.degraded_declared.err}`);
  assert.equal(r.down_declared.ok, true,
    `builder-emitted down+note must be legal: ${r.down_declared.err}`);
});

/* -------------------------- 3. zero rows from a configured feed is never ok */

test('build_markets.source_record: a 0-row write is NEVER silently ok', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.build_markets import source_record
print(json.dumps({
  "zero":    source_record(0, extra={"events_seen": 26, "unmatched": 0}),
  "healthy": source_record(7, extra={"events_seen": 9, "unmatched": 1}),
  "partial": source_record(15, parts_failed=1, parts_total=2,
                           note="futures: renamed"),
  "dead":    source_record(0, parts_failed=2, parts_total=2, note="a; b"),
  "one_row": source_record(1),
}))
`);
  // The shipped defect, exactly: 26 events seen, 0 rows delivered, was "ok".
  assert.equal(r.zero.status, 'degraded', 'rows 0 from a reachable feed = degraded');
  assert.equal(r.zero.rows, 0);
  assert.ok(r.zero.note && r.zero.note.length > 0, 'a degraded zero must say why');
  assert.equal(r.zero.events_seen, 26, 'counters still carried for the report');

  assert.equal(r.healthy.status, 'ok');
  assert.equal(r.partial.status, 'degraded', 'one sub-source down = degraded');
  assert.equal(r.partial.rows, 15, 'a partial pull keeps its real row count');
  assert.equal(r.dead.status, 'down', 'every sub-source down = down');
  assert.equal(r.one_row.status, 'ok', 'a single row is a real (if thin) pull');
});

test('build_predictions.market_feed_record: the hardcoded-ok mapping is gone', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.build_predictions import market_feed_record
NOW = "2026-08-15T00:00:00Z"
print(json.dumps({
  "shipped_defect": market_feed_record({"status": "ok", "rows": 0,
                                        "events_seen": 26, "unmatched": 0}, NOW),
  "healthy":  market_feed_record({"status": "ok", "rows": 34}, NOW),
  "degraded": market_feed_record({"status": "degraded", "rows": 15,
                                  "note": "futures: renamed"}, NOW),
  "down":     market_feed_record({"status": "down", "rows": 0}, NOW),
  "absent":   market_feed_record({}, NOW),
}))
`);
  // data/pipeline_status.json shipped kalshi {rows: 0, status: "ok"} off this
  // exact source record. It may never map to ok again.
  assert.equal(r.shipped_defect.status, 'degraded',
    'a source saying ok over 0 rows must be degraded in pipeline_status');
  assert.equal(r.shipped_defect.rows, 0);

  assert.equal(r.healthy.status, 'ok');
  assert.equal(r.healthy.rows, 34);
  assert.equal(r.healthy.last_success_utc, '2026-08-15T00:00:00Z');

  assert.equal(r.degraded.status, 'degraded',
    'the source\'s own degraded status must carry through, not collapse to ok');
  assert.equal(r.degraded.rows, 15, 'a partial pull keeps its real row count');

  for (const [label, rec] of [['down', r.down], ['absent', r.absent]]) {
    assert.equal(rec.status, 'down', `${label} source = down feed`);
    assert.equal(rec.rows, 0);
    assert.equal(rec.last_success_utc, null,
      `${label}: no fabricated success timestamp`);
  }
});

test('a deliberately unconfigured feed reads as awaiting-config, not ok/down', () => {
  // The idiom the market feeds must NOT use (they are keyless, always
  // configured) but odds_api does: no API key -> status "unconfigured",
  // excluded from the health roll-up, surfaced as "awaiting config".
  const preds = readFileSync(join(REPO_ROOT, 'scripts', 'build_predictions.py'), 'utf8');
  assert.match(preds, /OddsKeyMissing/,
    'odds_api must distinguish a missing key from a broken feed');
  assert.match(preds, /"status": "unconfigured"/);
  const validator = readFileSync(join(REPO_ROOT, 'scripts', 'validate_data.py'), 'utf8');
  assert.match(validator, /f\["status"\] != "unconfigured"/,
    'the health roll-up must exclude unconfigured feeds');
});

/* --------------------------- 4. build_preseason tells the truth about itself */

test('build_preseason.py states reality: experimental, unwired, output unread', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'build_preseason.py'), 'utf8');

  // The old lie, gone: it claimed a registry weight + promotion path.
  assert.ok(!/ships at registry weight 0\.0 like every learned\s+signal/.test(src),
    'the docstring is back to claiming a registry weight that does not exist');
  assert.match(src, /EXPERIMENTAL, UNWIRED/i);
  assert.match(src, /NOT in scripts\/signals\/registry\.py/);

  // The loud banner: defined, and printed by main() before any work.
  assert.match(src, /UNWIRED_BANNER/);
  assert.match(src, /print\(UNWIRED_BANNER, file=sys\.stderr\)/);

  // And the claims are still TRUE: no workflow invokes it, and the registry
  // has never heard of preseason_form. If someone wires it up, these flips
  // force the docstring/banner to be rewritten in the same change.
  const wfDir = join(REPO_ROOT, '.github', 'workflows');
  for (const f of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
    assert.ok(!readFileSync(join(wfDir, f), 'utf8').includes('build_preseason'),
      `${f} invokes build_preseason.py — its docstring and banner now lie; `
      + 'update them (and register the signal) in this same change');
  }
  const registry = readFileSync(
    join(REPO_ROOT, 'scripts', 'signals', 'registry.py'), 'utf8');
  assert.ok(!registry.includes('preseason_form'),
    'preseason_form is registered now — build_preseason.py\'s docstring is stale');
});

test('the frozen preseason artifact is at least gate-validated now', () => {
  // R30: preseason_form.schema.json was the ONE contract missing from
  // validate_data.SCHEMA_TO_DATA, so the crons never checked the artifact.
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import SCHEMA_TO_DATA, OPTIONAL_DATA
print(json.dumps({
  "mapped": SCHEMA_TO_DATA.get("preseason_form.schema.json"),
  "optional": "preseason_form.json" in OPTIONAL_DATA,
}))
`);
  assert.equal(r.mapped, 'preseason_form.json');
  assert.equal(r.optional, true,
    'the artifact is manual-run-built; its absence must not red a fresh clone');
});

/* ----------------------- 5. parlays.schema confidence_tier honesty (R30a) */

test('parlays.schema.json never claims conformal derivation for the tier', () => {
  const src = readFileSync(
    join(REPO_ROOT, 'data', 'contracts', 'parlays.schema.json'), 'utf8');
  assert.ok(!/conformal-derived/i.test(src),
    'confidence_tier is a hard-coded threshold; the contract may not call it conformal');
  const schema = JSON.parse(src);
  const tier = schema.properties.parlays.items.properties.confidence_tier;
  assert.match(tier.description, /HARD-CODED/i);
  assert.match(tier.description, /NO coverage guarantee/i);
  // The only mention of conformal anywhere in the contract must be the denial.
  for (const line of src.split('\n').filter((l) => /conformal/i.test(l))) {
    assert.match(line, /plays no part/i,
      `a contract line mentions conformal without denying it: ${line.trim()}`);
  }
});
