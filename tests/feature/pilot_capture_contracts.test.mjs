// Checkpoint 2 producer contracts: synthetic inputs, stdlib Python, temporary
// output only. Engine grading/settlement and trusted live-clock orchestration
// are separate contracts; an injected historical clock is not wall-time proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRELUDE = String.raw`
import copy, hashlib, importlib.util, json, tempfile
from pathlib import Path
from unittest.mock import patch
from scripts import capture_outcome_evidence as capture, export_learning as export
from scripts import learning_journal as journal, learning_receipts as lr
spec = importlib.util.spec_from_file_location("week6_outcomes", "tests/fixtures/week6_outcomes.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

def offered(pool):
    return [{"card_id": "synthetic-card", "legs": [dict(r) for r in pool["players"][0]["rungs"]]}]

def reseal(receipt):
    receipt["receipt_id"] = lr.fingerprint({k: v for k, v in receipt.items() if k != "receipt_id"})

def tree(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in Path(root).rglob("*") if p.is_file()}
`;

function runPy(code) {
  const result = spawnSync('python3', ['-B', '-'], {
    cwd: ROOT, input: `${PRELUDE}\n${code}`, encoding: 'utf8', timeout: 20_000,
    maxBuffer: 512 * 1024,
    env: { ...process.env, PYTHONPATH: ROOT, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('pregame journal freezes generation, receipts and sources before display dedupe', () => {
  const r = runPy(String.raw`
with tempfile.TemporaryDirectory() as root:
    doc, pool, schedule = fixture.generation(root)
    generation = doc["generations"][0]
    frozen = copy.deepcopy(doc)
    pool["players"][0]["rungs"][0]["learning_receipt"]["served_prob"] = 0.01
    plan = export.plan(root)
    print(json.dumps({"audit": generation["audit"], "detached": frozen == doc,
        "generation_id": generation["generation_id"], "source_n": len(plan["source_objects"]),
        "export_receipts": plan["generations"][0]["expected_receipt_ids"],
        "receipt_ids": generation["receipt_ids"], "status": generation["publication_status"],
        "population": generation["population"],
        "times": [[row["learning_receipt"]["forecast_created_utc"], row["recorded_utc"], row["kickoff_utc"]]
                  for row in doc["receipts"]]}))
`);
  assert.deepEqual(r.audit, { candidate_rungs: 2, eligible_receipts: 2, quarantined_records: 0, quarantine_reasons: {} });
  assert.equal(r.detached, true);
  assert.equal(r.source_n, 3);
  assert.match(r.generation_id, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(r.export_receipts, r.receipt_ids);
  assert.equal(r.status, 'generated_unverified');
  assert.equal(r.population, 'eligible_pool_prop_rungs_before_display_dedupe');
  for (const [created, recorded, kickoff] of r.times) {
    assert.ok(Date.parse(created) <= Date.parse(recorded));
    assert.ok(Date.parse(recorded) < Date.parse(kickoff));
  }
});

test('invalid receipts are quarantined with nonempty counted reasons before export', () => {
  const r = runPy(String.raw`
with tempfile.TemporaryDirectory() as root:
    _, pool, schedule = fixture.generation(Path(root) / "seed")
    player = pool["players"][0]
    player["rungs"][0].pop("learning_receipt")
    player["rungs"][1]["learning_receipt"]["served_prob"] = 0.01
    doc, added = journal.record(pool, schedule, None, offered(pool), fixture.RECORDED, str(Path(root) / "bad"))
    plan = export.plan(Path(root) / "bad")
    print(json.dumps({"added": added, "receipts": doc["receipts"], "audit": doc["generations"][0]["audit"],
                      "export_receipts": plan["generations"][0]["expected_receipt_ids"]}))
`);
  assert.equal(r.added, true);
  assert.deepEqual(r.receipts, []);
  assert.deepEqual(r.export_receipts, []);
  assert.deepEqual(r.audit, { candidate_rungs: 2, eligible_receipts: 0, quarantined_records: 2,
    quarantine_reasons: { missing_or_unsupported_receipt: 1, receipt_hash_mismatch: 1 } });
});

test('new journal captures reject kickoff, late, FINAL and recorded-before-created clocks', () => {
  const r = runPy(String.raw`
with tempfile.TemporaryDirectory() as root:
    _, pool, schedule = fixture.generation(Path(root) / "seed")
    out = {}
    cases = [("kickoff", fixture.KICKOFF, "STATUS_SCHEDULED"),
             ("late", "2026-09-02T00:15:01Z", "STATUS_SCHEDULED"),
             ("final", fixture.RECORDED, "STATUS_FINAL"),
             ("before_created", "2026-09-01T11:59:59Z", "STATUS_SCHEDULED")]
    for label, recorded, status in cases:
        games = copy.deepcopy(schedule)
        games["games"][0]["status"] = status
        doc, _ = journal.record(pool, games, None, offered(pool), recorded, str(Path(root) / label))
        out[label] = {"receipts": len(doc["receipts"]), "audit": doc["generations"][0]["audit"]}
    print(json.dumps(out))
`);
  for (const [label, row] of Object.entries(r)) {
    assert.equal(row.receipts, 0, label);
    assert.equal(row.audit.quarantined_records, 2, label);
    assert.deepEqual(row.audit.quarantine_reasons, {
      [label === 'final' ? 'game_not_scheduled' : 'not_captured_pregame']: 2,
    }, label);
  }
});

test('receipts require known source clocks available before their forecast', () => {
  const r = runPy(String.raw`
with tempfile.TemporaryDirectory() as root:
    _, original, schedule = fixture.generation(root)
    out = {}
    for label, timestamps in [("missing", {}), ("unknown", {"fixture": None}),
                              ("future", {"fixture": fixture.RECORDED})]:
        pool = copy.deepcopy(original)
        for rung in pool["players"][0]["rungs"]:
            receipt = rung["learning_receipt"]
            receipt["source_timestamps"] = timestamps
            reseal(receipt)
        doc, _ = journal.capture(pool, schedule, None, offered(pool), fixture.RECORDED)
        out[label] = doc["generations"][0]["audit"]
    print(json.dumps(out))
`);
  for (const [label, reason] of Object.entries({ missing: 'missing_source_timestamps', unknown: 'invalid_timestamp', future: 'source_after_prediction_or_invalid_time' })) {
    assert.equal(r[label].eligible_receipts, 0, label);
    assert.deepEqual(r[label].quarantine_reasons, { [reason]: 2 }, label);
  }
});

test('exact journal replay preserves first capture time and immutable source conflicts fail closed', () => {
  const r = runPy(String.raw`
with tempfile.TemporaryDirectory() as root:
    doc, pool, schedule = fixture.generation(root)
    before = tree(root)
    replay, added = journal.record(pool, schedule, None, offered(pool), "2026-10-20T12:00:00Z", root)
    unchanged = before == tree(root)
    source = next((Path(root) / "learning_sources").glob("*.json"))
    source.write_text("{}\n", encoding="utf-8")
    errors = []
    for action in [lambda: journal.record(pool, schedule, None, offered(pool), fixture.RECORDED, root),
                   lambda: export.plan(root)]:
        try:
            action()
            errors.append(None)
        except ValueError as error:
            errors.append(str(error).split(": ")[0])
    print(json.dumps({"same": replay == doc, "added": added, "unchanged": unchanged,
                      "recorded": replay["generations"][0]["recorded_utc"], "errors": errors}))
`);
  assert.equal(r.same, true);
  assert.equal(r.added, false);
  assert.equal(r.unchanged, true);
  assert.equal(r.recorded, '2026-09-01T12:01:00Z');
  assert.deepEqual(r.errors, ['missing or conflicting learning source snapshot', 'source_hash_mismatch']);
});

test('raw evidence hashes and offline replay are immutable and reject byte tampering', () => {
  const r = runPy(String.raw`
with tempfile.TemporaryDirectory() as root:
    bundle = fixture.bundle()
    path = capture.save_capture(bundle, root)
    before = tree(root)
    with patch.object(capture, "http_fetcher", side_effect=AssertionError("unexpected network")):
        replay = capture.load_capture(path)
        repeated_path = capture.save_capture(replay, root)
    unchanged = before == tree(root)
    raw_id = next(iter(bundle["raw_objects"]))
    damaged = copy.deepcopy(bundle)
    damaged["raw_objects"][raw_id] += b" "
    errors = []
    for action in [lambda: capture.verify_capture(damaged), lambda: capture.save_capture(damaged, root)]:
        try:
            action()
            errors.append(None)
        except capture.CaptureError as error:
            errors.append(str(error))
    raw_path = Path(root) / "objects" / (raw_id.split(":")[1] + ".bin")
    raw_path.write_bytes(bundle["raw_objects"][raw_id] + b" ")
    try:
        capture.load_capture(path)
        errors.append(None)
    except capture.CaptureError as error:
        errors.append(str(error))
    print(json.dumps({"same": replay == bundle, "same_path": repeated_path == path,
        "unchanged": unchanged, "errors": errors,
        "hashes_valid": all(key == "sha256:" + hashlib.sha256(raw).hexdigest()
                            for key, raw in bundle["raw_objects"].items())}))
`);
  assert.equal(r.same, true);
  assert.equal(r.same_path, true);
  assert.equal(r.unchanged, true);
  assert.equal(r.hashes_valid, true);
  assert.deepEqual(r.errors, Array(3).fill('raw_source_hash_or_size_mismatch'));
});

test('changed raw correction appends a vintage; repeated captures retain producer identity', () => {
  const r = runPy(String.raw`
with tempfile.TemporaryDirectory() as root:
    original = fixture.bundle(value="80")
    first = capture.save_capture(original, root)
    before = tree(root)
    repeated = fixture.bundle(value="80")
    same_path = capture.save_capture(repeated, root) == first
    repeat_unchanged = before == tree(root)
    correction = fixture.bundle(value="81", observed="2026-09-04T12:00:00Z")
    corrected_path = capture.save_capture(correction, root)
    preserved = all((Path(root) / name).read_bytes() == raw for name, raw in before.items())
    later = fixture.bundle(value="81", observed="2026-09-05T12:00:00Z")
    later_path = capture.save_capture(later, root)
    print(json.dumps({"same_path": same_path, "repeat_unchanged": repeat_unchanged,
        "new_capture": corrected_path != first, "preserved": preserved,
        "old": capture.csv_rows(capture.load_capture(first), capture.STATS_PROFILE)[0]["receiving_yards"],
        "corrected": capture.csv_rows(capture.load_capture(corrected_path), capture.STATS_PROFILE)[0]["receiving_yards"],
        "later_is_new_observation": later_path != corrected_path,
        "later_reuses_raw": set(later["raw_objects"]) == set(correction["raw_objects"]),
        "raw_objects": len(list((Path(root) / "objects").glob("*.bin"))),
        "manifests": len(list((Path(root) / "captures").glob("*.json")))}))
`);
  for (const key of ['same_path', 'repeat_unchanged', 'new_capture', 'preserved', 'later_is_new_observation', 'later_reuses_raw']) assert.equal(r[key], true, key);
  assert.equal(r.old, '80');
  assert.equal(r.corrected, '81');
  assert.equal(r.raw_objects, 4);
  assert.equal(r.manifests, 3);
});

test('missing and negative statistics remain raw strings; capture does not invent zero or labels', () => {
  const r = runPy(String.raw`
out = []
for value in ["", "-1", "not-a-number", "0"]:
    bundle = fixture.bundle(value=value)
    capture.verify_capture(bundle)
    observation = capture.source_observation(bundle, capture.STATS_PROFILE)
    rows = capture.csv_rows(bundle, capture.STATS_PROFILE)
    out.append({"input": value, "value": rows[0]["receiving_yards"],
                "policy": observation["audit"]["measurement_policy"],
                "raw_present": bundle["raw_objects"][observation["raw_sha256"]] == fixture.csv_bytes(fixture.STATS_HEADERS, [fixture.stats_row(value)]),
                "keys": sorted(bundle)})
print(json.dumps(out))
`);
  assert.equal(r.length, 4);
  for (const row of r) {
    assert.equal(row.value, row.input);
    assert.equal(typeof row.value, 'string');
    assert.equal(row.raw_present, true);
    assert.match(row.policy, /missing\/negative cells are not coerced or graded/);
    assert.deepEqual(row.keys, ['manifest', 'observations', 'raw_objects']);
  }
});
