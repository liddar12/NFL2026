import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = String.raw`
import copy
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from scripts import run_parlay_feedback as feedback

OLD = "aacb19c73122f257449e977df40f2a2733991b2f"
OLD_CODE = "sha256:6b5445ff01e75ec341f504f5d4b983d3c179912ecc29747cac3ccee5f504c9e6"
NEW = "b" * 40
NEW_CODE = "sha256:" + "c" * 64
FOREIGN = "d" * 40
HISTORIES = ("source_object_ids", "source_imports", "receipts", "receipt_imports",
             "generation_records", "observation_records", "revisions", "capture_records")

def save(folder, key, value):
    value[key] = feedback.export.fingerprint(value)
    feedback.save(artifacts, folder, value[key], value)
    return value[key]

def state(sequence, parent=None):
    value = {key: copy.deepcopy(parent[key]) if parent else [] for key in HISTORIES}
    value["receipt_imports"].append({"receipt_id": f"fixture-{sequence}", "first_imported_utc": "2026-10-18T00:00:00Z"})
    value.update(sequence=sequence, previous_state_id=parent["state_id"] if parent else None,
                 updated_utc="2026-10-18T00:00:00Z")
    save("states", "state_id", value)
    return value

def record(run_state, commit=OLD, code=OLD_CODE, **changes):
    state_id = run_state["state_id"]
    evaluation_id = save("evaluations", "evaluation_id", {"state_id": state_id, "report": {}})
    profile = feedback.PROFILE if commit == OLD else feedback.PARTITION_EXECUTION_PROFILE
    value = {"version": 1, "kind": "nfl.repository_feedback_run.v1", "state_id": state_id,
             "evaluation_id": evaluation_id, "graph_id": feedback.export.fingerprint({"synthetic": True}),
             "engine_commit": commit, "engine_code_id": code, "execution_profile": profile,
             "execution_profile_id": feedback.export.fingerprint(profile),
             "basis": "local_repository_files_not_live_publication_or_hosted_ACK", **feedback.FLAGS, **changes}
    run_id = save("runs", "run_id", value)
    return {"version": 1, "kind": "nfl.repository_feedback_pointer.v1", "run_id": run_id,
            "state_id": state_id, "evaluation_id": evaluation_id}

def point(value):
    feedback.pointer(data).write_text(json.dumps(value))

def contents():
    return {str(path): path.read_bytes() for path in data.rglob("*") if path.is_file()}

def reject(reason, action):
    try:
        action()
    except feedback.FeedbackError as exc:
        assert str(exc) == reason, str(exc)
    else:
        raise AssertionError(f"expected {reason}")
`;

function run(body) {
  execFileSync('python3', ['-I', '-S', '-B', '-'], {
    cwd: root,
    encoding: 'utf8',
    input: `import sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path.cwd()))\n${fixtures}\n${body}`,
  });
}

test('upgraded reader accepts the historical runtime and keeps the complete history byte-for-byte', () => {
  run(String.raw`
with tempfile.TemporaryDirectory() as temporary, patch.object(feedback, "ENGINE_COMMIT", NEW):
    data = Path(temporary).resolve()
    artifacts = data / "snapshots" / "learning_feedback"
    first = state(1)
    historical = record(first)
    point(historical)
    before = contents()
    assert feedback.previous(data, artifacts) == (historical, first)
    assert feedback.previous(data, artifacts) == (historical, first)
    assert contents() == before

    second = state(2, first)
    current = record(second, NEW, NEW_CODE)
    point(current)
    upgraded = contents()
    assert feedback.previous(data, artifacts) == (current, second)
    assert feedback.previous(data, artifacts) == (current, second)
    assert contents() == upgraded
    assert all(upgraded[path] == raw for path, raw in before.items() if path != str(feedback.pointer(data)))
    assert all(row is False for row in feedback.FLAGS.values())
    assert not any(name == "selflearn_core" or name.startswith("selflearn_core.") for name in sys.modules)
    reject("feedback_exact_engine_commit_required", lambda: feedback.engine(data / "old-engine", OLD))
`);
});

test('history reader rejects foreign engines, wrong historical code IDs and enabled historical runs', () => {
  run(String.raw`
from contextlib import contextmanager

@contextmanager
def workspace():
    global data, artifacts
    with tempfile.TemporaryDirectory() as temporary, patch.object(feedback, "ENGINE_COMMIT", NEW):
        data = Path(temporary).resolve()
        artifacts = data / "snapshots" / "learning_feedback"
        yield

for commit, code, changes in ((FOREIGN, OLD_CODE, {}), (OLD, NEW_CODE, {}),
                              (OLD, OLD_CODE, {"learning_enabled": True}),
                              (OLD, OLD_CODE, {"production_authorized": 0})):
    with workspace():
        initial = state(1)
        bad = record(initial, commit, code, **changes)
        point(bad)
        before = contents()
        reject("feedback_run_contract_mismatch", lambda: feedback.previous(data, artifacts))
        assert contents() == before

with workspace():
    initial = state(1)
    record(initial, OLD, NEW_CODE)
    current = state(2, initial)
    point(record(current, NEW, NEW_CODE))
    before = contents()
    reject("feedback_run_contract_mismatch", lambda: feedback.previous(data, artifacts))
    assert contents() == before
`);
});

test('qualified-shadow upgrade reads the independently measured event-label runtime without importing it', () => {
  run(String.raw`
reviewed = "69d37eb0d171f7999b94f706748f4635f9c58606"
reviewed_code = "sha256:f5b5a90f07497d28d64e0c782695a566269443fb5a2052d3f1811603a7b1da89"
with tempfile.TemporaryDirectory() as temporary:
    data = Path(temporary).resolve()
    artifacts = data / "snapshots" / "learning_feedback"
    initial = state(1)
    historical = record(initial, reviewed, reviewed_code)
    point(historical)
    before = contents()
    assert feedback.previous(data, artifacts) == (historical, initial)
    assert contents() == before
    assert not any(name == "selflearn_core" or name.startswith("selflearn_core.") for name in sys.modules)
    reject("feedback_exact_engine_commit_required", lambda: feedback.engine(data / "old-engine", reviewed))
    bad = record(initial, reviewed, NEW_CODE)
    point(bad)
    reject("feedback_run_contract_mismatch", lambda: feedback.previous(data, artifacts))
`);
});

test('feedback command reports disabled flags without opening an engine or workspace', () => {
  const result = JSON.parse(execFileSync('python3', ['-I', '-S', '-B', 'scripts/run_parlay_feedback.py'], {
    cwd: root,
    encoding: 'utf8',
  }));
  assert.equal(result.status, 'disabled_dry_run');
  for (const key of [
    'model_adoption', 'public_serving_verified', 'working_live_loop', 'provider_authenticated',
    'accuracy_improvement_verified', 'hosted_ack', 'production_authorized', 'learning_enabled',
    'network_used', 'writes',
  ]) {
    assert.equal(result[key], false, key);
  }
});


test('qualified-jobs upgrade reads approved qualified-shadow history without allowing old execution', () => {
  run(String.raw`
OLD_SHADOW = "889e147e84b01c28898f268eb89f91c978ef490f"
MEASURED_CODE = "sha256:2ea378132a1ac93a2a2a6c0e607174ec819cf1fe6703b40fbd07832a941ea564"
with tempfile.TemporaryDirectory() as temporary:
    data = Path(temporary).resolve()
    artifacts = data / "snapshots" / "learning_feedback"
    initial = state(1)
    historical = record(initial, OLD_SHADOW, MEASURED_CODE)
    point(historical)
    before = contents()
    assert feedback.previous(data, artifacts) == (historical, initial)
    assert contents() == before
    reject("feedback_exact_engine_commit_required", lambda: feedback.engine(data / "old-engine", OLD_SHADOW))
    bad = record(initial, OLD_SHADOW, NEW_CODE)
    point(bad)
    before = contents()
    reject("feedback_run_contract_mismatch", lambda: feedback.previous(data, artifacts))
    assert contents() == before
`);
});

test('collection-handoff upgrade preserves qualified-job history and refuses the old engine for execution', () => {
  run(String.raw`
reviewed = "5e68953989b95731503d9e909ede7d4279b2a570"
reviewed_code = "sha256:91085f0c18ed243d9632fa2abafc7d9df6d85677ab88d2040473ced089c4c811"
with tempfile.TemporaryDirectory() as temporary:
    data = Path(temporary).resolve()
    artifacts = data / "snapshots" / "learning_feedback"
    initial = state(1)
    old = record(initial, reviewed, reviewed_code)
    point(old)
    before = contents()
    assert feedback.previous(data, artifacts) == (old, initial)
    assert contents() == before
    assert not any(name == "selflearn_core" or name.startswith("selflearn_core.") for name in sys.modules)
    reject("feedback_exact_engine_commit_required", lambda: feedback.engine(data / "old-engine", reviewed))
    point(record(initial, reviewed, NEW_CODE))
    before = contents()
    reject("feedback_run_contract_mismatch", lambda: feedback.previous(data, artifacts))
    assert contents() == before
`);
});
