/* R105 — THE MODEL TAB SHOWS THE LEARNING.
 *
 * Owner, 2026-10-01: "Show the learning." The LEARNING RECORD showed one
 * proposal line; the system has eleven loops that can move a shipped number and
 * five measure-only experiments. scripts/build_learning_loops.py reads each
 * loop's OWN record and states what it decided and why (verbatim); the MODEL
 * tab's LEARNING LOOPS card paints that, plus the append-only log of every
 * state change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { learningLoopsCard } from '../../app/views/model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the builder selftest passes (verbatim reasons, absent never guessed, append-only transitions)', () => {
  execFileSync('python3', ['scripts/build_learning_loops.py', '--selftest'], { cwd: ROOT, stdio: 'pipe' });
});

test('the builder states every loop on the committed records, and covers the gated loops', () => {
  const out = execFileSync('python3', ['-'], {
    cwd: ROOT, encoding: 'utf8',
    input: `import json, sys\nsys.path.insert(0, ".")
from scripts import build_learning_loops as b
doc, _ = b.build(b.load_sources(), None, "2026-10-01T00:00:00Z")
print(json.dumps(doc))`,
  });
  const doc = JSON.parse(out.trim().split('\n').pop());
  const ids = doc.loops.map((l) => l.id);
  for (const id of ['game_params', 'player_signals', 'weekly_split', 'leg_pool_live', 'atd_model', 'joint_pricer']) {
    assert.ok(ids.includes(id), `loop ${id} is reported`);
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const l of doc.loops) {
    assert.ok(['adopted', 'held', 'reverted', 'measuring', 'absent'].includes(l.state), l.id);
    assert.ok(l.why && l.why.length > 3, `${l.id} carries its reason`);
    if (l.group === 'measure') assert.equal(l.state === 'measuring' || l.state === 'absent', true, l.id);
  }
  assert.equal(Object.values(doc.summary).reduce((a, b) => a + b, 0), doc.loops.length);
});

test('the committed record (when present) agrees with the loops\' own records', () => {
  if (!existsSync(join(ROOT, 'data', 'learning_loops.json'))) return;   // first runner build pending
  const out = execFileSync('python3', ['-'], {
    cwd: ROOT, encoding: 'utf8',
    input: `import json, sys\nsys.path.insert(0, ".")
from scripts import build_learning_loops as b
on_file = json.load(open("data/learning_loops.json"))
fresh = b.derive_loops(b.load_sources())
print(json.dumps([[l["id"], l["state"], f["state"]] for l, f in zip(on_file["loops"], fresh)
                  if l["id"] != f["id"] or l["state"] != f["state"]]))`,
  });
  assert.deepEqual(JSON.parse(out.trim()), [], 'a loop state on file disagrees with its source record');
});

const DOC = {
  kind: 'learning_loops', generated_utc: '2026-10-01T10:00:00Z', policy: 'p',
  summary: { adopted: 1, held: 1, reverted: 1, measuring: 1, absent: 0 },
  loops: [
    { id: 'weekly_split', group: 'ships', name: 'Weekly split', learns: '2023-25', moves: 'weekly numbers',
      source: 'data/weekly_backtest.json', state: 'adopted', why: 'v2 beats v1', last_run_utc: '2026-10-01T10:18:50Z' },
    { id: 'game_params', group: 'ships', name: 'Game model parameters', learns: 'finals', moves: 'win probs',
      source: 'data/model_tuning.json', state: 'held', why: 'NEVER REGRESS: <kept>', last_run_utc: '2026-09-29T13:52:39Z',
      runs: 53, live: 'hfa 45', live_since_utc: '2026-07-17T17:16:18Z' },
    { id: 'player_signals', group: 'ships', name: 'Player signal weights', learns: 'player-weeks', moves: 'projections',
      source: 'data/model_tuning.json', state: 'reverted', why: 'now loses to full strength', last_run_utc: null },
    { id: 'weather', group: 'measure', name: 'Rain and wind', learns: 'games', moves: 'nothing',
      source: 'data/weather_backtest.json', state: 'measuring', why: 'not powered', last_run_utc: '2026-09-29T13:53:30Z' },
  ],
  transitions: [
    { utc: '2026-10-03T10:00:00Z', loop: 'player_signals', name: 'Player signal weights', from: 'held', to: 'adopted', why: 'beats by 0.2' },
    { utc: '2026-10-10T10:00:00Z', loop: 'player_signals', name: 'Player signal weights', from: 'adopted', to: 'reverted', why: 'now loses' },
  ],
};

test('the card: one row per loop with its chip and verbatim reason, grouped, newest change first', () => {
  const html = learningLoopsCard(DOC);
  const t = text(html);
  assert.match(t, /4 loops · 1 adopted · 1 held · 1 reverted · 1 measure only/);
  assert.ok(t.indexOf('CAN MOVE A SHIPPED NUMBER') < t.indexOf('MEASURE ONLY — ADOPTS NOTHING'));
  assert.match(html, /data-loop="weekly_split" data-state="adopted"[\s\S]*?gate-chip--adopted">ADOPTED/);
  assert.match(html, /data-loop="player_signals" data-state="reverted"[\s\S]*?gate-chip--reverted">REVERTED/);
  assert.match(html, /data-loop="weather" data-state="measuring"[\s\S]*?>MEASURE ONLY</);
  assert.ok(html.includes('NEVER REGRESS: &lt;kept&gt;'), 'the reason is escaped, never raw HTML');
  assert.match(t, /live: hfa 45 · since 2026-07-17 · last run 2026-09-29 · 53 runs/);
  assert.match(t, /no run on file/);
  const changes = [...html.matchAll(/class="ll-change">([^]*?)<\/div>/g)].map((m) => text(m[1]));
  assert.deepEqual(changes, [
    '2026-10-10 · Player signal weights : ADOPTED → REVERTED — now loses',
    '2026-10-03 · Player signal weights : HELD → ADOPTED — beats by 0.2',
  ]);
});

test('no record on file and no change yet are honest lines, never a blank card', () => {
  assert.match(learningLoopsCard(null), /No learning-loop record on file yet/);
  assert.match(learningLoopsCard({ loops: [] }), /No learning-loop record on file yet/);
  const quiet = learningLoopsCard({ ...DOC, transitions: [] });
  assert.match(text(quiet), /No loop has changed state since this record began \(2026-10-01\)/);
});
