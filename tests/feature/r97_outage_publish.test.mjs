/* tests/feature/r97_outage_publish.test.mjs — R97: a feed outage must degrade,
 * never kill the publish.
 *
 * Run 166 of the daily pipeline failed outright. One of its two validation
 * errors was this: the injuries feed went down, and build_predictions' except
 * path stamped
 *
 *     feeds["injuries"] = {"rows": 0, "age_hours": None, ...}
 *
 * while pipeline_status.schema.json types age_hours as a number and lists it
 * required. So the one document that exists to SAY a feed is down could not
 * itself be written, and a feed the builder is careful to degrade around took
 * the whole run with it. market_feed_record (build_predictions.py, the down
 * branch) already had the convention right — 999.0, "older than any real feed".
 *
 * Two locks, because the defect needs both halves to reappear:
 *   1. the contract really does reject a null age (a check nobody has watched
 *      fail is a check that might do nothing), and
 *   2. no feed record the builder writes carries one — asserted structurally
 *      over build_predictions.py's own source, so a new feed added tomorrow
 *      with a null down-path is caught the same way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  return JSON.parse(execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  }));
}

test('R97: pipeline_status rejects a null age_hours and accepts the 999.0 outage record', () => {
  const v = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import validate_against_schema, ValidationError

schema = json.load(open("data/contracts/pipeline_status.schema.json"))

def doc(age):
    return {"generated_utc": "2026-09-23T10:00:00Z", "health": "down",
            "feeds": {"injuries": {"rows": 0, "age_hours": age,
                                   "last_success_utc": None, "status": "down"}}}

def verdict(age):
    try:
        validate_against_schema(doc(age), schema, "pipeline_status.json")
        return True
    except ValidationError:
        return False

print(json.dumps({"null_age": verdict(None), "outage_age": verdict(999.0)}))
`);
  assert.equal(v.null_age, false,
    'a null age_hours must be a contract violation — that is what made run 166 unpublishable');
  assert.equal(v.outage_age, true,
    'the outage record the builder writes must satisfy its own contract');
});

test('R97: every feed record build_predictions writes states a numeric age', () => {
  const found = runPy(`
import ast, json

src = open("scripts/build_predictions.py", encoding="utf-8").read()
tree = ast.parse(src)

bad = []
seen = 0
for node in ast.walk(tree):
    if not isinstance(node, ast.Dict):
        continue
    keys = [k.value for k in node.keys
            if isinstance(k, ast.Constant) and isinstance(k.value, str)]
    if "age_hours" not in keys or "status" not in keys:
        continue          # not a feed-health record
    seen += 1
    value = node.values[keys.index("age_hours")]
    if isinstance(value, ast.Constant) and value.value is None:
        bad.append(node.lineno)

print(json.dumps({"seen": seen, "bad": bad}))
`);
  assert.ok(found.seen >= 3,
    'the structural scan found no feed records at all — it would pass vacuously');
  assert.deepEqual(found.bad, [],
    `build_predictions.py writes age_hours: None at line(s) ${found.bad.join(', ')} — `
    + 'an outage record must state a number (999.0, as market_feed_record does), '
    + 'or pipeline_status.json cannot be written and the whole run fails');
});
