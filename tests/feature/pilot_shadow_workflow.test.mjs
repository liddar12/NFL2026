// Locks the default-off shadow-capture workflow and the capture tool's
// shadow/pin guard. Enabling capture is a reviewed config change, never a
// side effect of merging this workflow; serving stays shadow-only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PIN = 'aacb19c73122f257449e977df40f2a2733991b2f';
// The workflow is staged under docs/pilot/proposed/ until a token with GitHub
// `workflow` permission installs it at .github/workflows/ (same bytes). The
// installed copy wins when both exist, and the two must then be identical.
const INSTALLED = join(ROOT, '.github/workflows/selflearning-shadow-capture.yml');
const PROPOSED = join(ROOT, 'docs/pilot/proposed/selflearning-shadow-capture.yml');
const source = readFileSync(existsSync(INSTALLED) ? INSTALLED : PROPOSED, 'utf8');
if (existsSync(INSTALLED) && existsSync(PROPOSED))
  assert.equal(readFileSync(PROPOSED, 'utf8'), source, 'installed and proposed workflow differ');
const NAMES = [
  'Checkout published main data', 'Setup Python', 'Resolve pilot configuration',
  'Refuse drifting engine pin or non-shadow serving', 'Report disabled pilot',
  'Capture shadow generation', 'Deliver to pinned SelfLearning journal', 'Retain shadow evidence only',
];
function steps(text) {
  const at = [...text.matchAll(/^      - name: (.+)$/gm)];
  return Object.fromEntries(at.map((m, i) => [m[1], text.slice(m.index, at[i + 1]?.index)]));
}

test('shadow workflow: read-only, main-only triggers, no repo writes or privileged events', () => {
  assert.match(source, /^name: selflearning-shadow-capture$/m);
  const triggers = source.slice(source.indexOf('\non:\n'), source.indexOf('\npermissions:\n')).trim();
  assert.equal(triggers, 'on:\n  workflow_run:\n    workflows: [daily-pipeline]\n    types: [completed]\n    branches: [main]\n  workflow_dispatch: {}');
  assert.equal(source.match(/^permissions:\n(?:  .*\n)+/m)?.[0], 'permissions:\n  contents: read\n');
  assert.doesNotMatch(source, /pull_request|continue-on-error|contents: write|git push|git commit|\benvironment:|\bcontainer:|npm (?:i|ci|install)\b|pip install|curl\b|wget\b|OPERATOR_TOKEN|NETLIFY|VERCEL_TOKEN/);
  assert.match(source, /^    timeout-minutes: 15$/m);
  assert.match(source, /^          persist-credentials: false$/m);
  assert.match(source, new RegExp('^      EXPECTED_ENGINE_COMMIT: ' + PIN + '$', 'm'));
  assert.match(source, /^      SELFLEARN_BASE_URL: https:\/\/self-learning-beige\.vercel\.app$/m);
});

test('shadow workflow: steps, gating on enabled, pin refusal and secret scope are locked', () => {
  const all = steps(source);
  assert.deepEqual(Object.keys(all), NAMES);
  assert.match(all['Resolve pilot configuration'], /python3 -B scripts\/pilot_config\.py --github-output "\$GITHUB_OUTPUT"/);
  assert.match(all['Refuse drifting engine pin or non-shadow serving'], /test "\$RESOLVED_COMMIT" = "\$EXPECTED_ENGINE_COMMIT"/);
  assert.match(all['Refuse drifting engine pin or non-shadow serving'], /test "\$RESOLVED_MODE" = shadow/);
  assert.doesNotMatch(all['Refuse drifting engine pin or non-shadow serving'], /^        if:/m);
  for (const name of ['Capture shadow generation', 'Deliver to pinned SelfLearning journal'])
    assert.match(all[name], /^        if: steps\.pilot\.outputs\.enabled == '1'$/m, name);
  const secretUses = [...source.matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1]);
  assert.deepEqual(secretUses, ['SELFLEARN_NFL_INGEST_TOKEN']);
  assert.match(all['Deliver to pinned SelfLearning journal'], /SELFLEARN_NFL_INGEST_TOKEN: \$\{\{ secrets\.SELFLEARN_NFL_INGEST_TOKEN \}\}/);
  assert.match(all['Deliver to pinned SelfLearning journal'], /--send --snapshots "\$RUNNER_TEMP\/shadow\/snapshots"/);
  assert.match(all['Capture shadow generation'], /--execute --workspace "\$RUNNER_TEMP\/shadow"/);
});

test('committed pilot config keeps the engine pin and shadow serving that the workflow requires', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'config/selflearning_pilot.json'), 'utf8'));
  assert.equal(config.engine_commit, PIN);
  assert.equal(config.serving_mode, 'shadow');
  assert.equal(typeof config.enabled, 'boolean');
});

test('capture tool: allows enabled true or false, refuses a drifted pin either way', () => {
  const py = `
import json, tempfile, pathlib
from scripts import pilot_capture as cap
base = json.load(open("config/selflearning_pilot.json"))
out = {}
for label, doc in (("off", {**base, "enabled": False}), ("on", {**base, "enabled": True}),
                   ("drift", {**base, "enabled": True, "engine_commit": "0" * 40})):
    root = pathlib.Path(tempfile.mkdtemp())
    (root / "config").mkdir()
    (root / "config/selflearning_pilot.json").write_text(json.dumps(doc))
    cap.ROOT = root
    try:
        cap.pinned_shadow_config(); out[label] = "ok"
    except cap.PilotCaptureError as error:
        out[label] = error.args[0]
print(json.dumps(out))`;
  const r = spawnSync('python3', ['-B', '-c', py], {cwd: ROOT, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {off: 'ok', on: 'ok', drift: 'pilot_shadow_pin_required'});
});
