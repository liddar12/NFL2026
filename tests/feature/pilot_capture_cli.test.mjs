import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
function py(code) {
  return JSON.parse(execFileSync('python3', ['-B', '-'], {
    cwd: ROOT, input: code, encoding: 'utf8', env: { ...process.env, PYTHONPATH: ROOT },
  }).trim().split('\n').at(-1));
}
const PRELUDE = `
import copy, json, pathlib, subprocess, sys, tempfile
from scripts import pilot_capture as pc, learning_journal as journal, export_learning as export
from tests.fixtures import week6_outcomes as F
def inputs():
    with tempfile.TemporaryDirectory() as d:
        _, pool, schedule = F.generation(pathlib.Path(d))
    return pool, schedule
pool, schedule = inputs()
`;

test('capture preview writes nothing; explicit workspace records and replays without changing original clocks', () => {
  const r = py(`${PRELUDE}
with tempfile.TemporaryDirectory() as d:
    out = pathlib.Path(d) / 'shadow'
    preview = pc.capture_generation(pool, schedule, None, workspace=out, clock=lambda:F.RECORDED)
    absent = not out.exists()
    first = pc.capture_generation(pool, schedule, None, workspace=out, execute=True, clock=lambda:F.RECORDED)
    before = {str(p.relative_to(out)):p.read_bytes() for p in out.rglob('*.json')}
    again = pc.capture_generation(pool, schedule, None, workspace=out, execute=True, clock=lambda:'2026-09-04T12:00:00Z')
    after = {str(p.relative_to(out)):p.read_bytes() for p in out.rglob('*.json')}
    print(json.dumps(dict(preview=preview, absent=absent, first=first, again=again, unchanged=before==after)))
`);
  assert.equal(r.absent, true);
  assert.equal(r.preview.writes, false);
  assert.equal(r.first.added_generation, true);
  assert.ok(r.first.eligible_receipts > 0);
  assert.equal(r.again.added_generation, false);
  assert.equal(r.again.recorded_utc, r.first.recorded_utc);
  assert.equal(r.again.envelope_id, r.first.envelope_id);
  assert.equal(r.unchanged, true);
  assert.equal(r.first.offered_cards, 0, 'eligible-pool capture does not invent an offered-card cohort');
  assert.equal(r.first.learning_enabled, false);
});

test('first capture at kickoff quarantines all receipts', () => {
  const r = py(`${PRELUDE}
with tempfile.TemporaryDirectory() as d:
    closed = pc.capture_generation(pool, schedule, None, workspace=d, execute=True, clock=lambda:F.KICKOFF)
    print(json.dumps(dict(closed=closed)))
`);
  assert.equal(r.closed.eligible_receipts, 0);
  assert.ok(r.closed.audit.quarantine_reasons.not_captured_pregame > 0);
});

test('future or missing generation clocks are refused before adding an engine-poisoning envelope', () => {
  const r = py(`${PRELUDE}
results=[]
with tempfile.TemporaryDirectory() as d:
    for stamp in (None,'not-a-clock','2026-09-05T12:00:00Z'):
        bad=copy.deepcopy(pool); bad['generated_utc']=stamp
        out=pathlib.Path(d)/str(len(results))
        try:
            pc.capture_generation(bad,schedule,None,workspace=out,execute=True,clock=lambda:F.RECORDED)
            result='accepted'
        except pc.PilotCaptureError as e:
            result=str(e)
        results.append(dict(result=result,absent=not out.exists()))
print(json.dumps(results))
`);
  assert.equal(r.length, 3);
  for (const row of r) {
    assert.equal(row.result, 'pilot_generation_clock_invalid');
    assert.equal(row.absent, true);
  }
});

test('offered card with a refused receipt is refused as a whole before writes', () => {
  const r = py(`${PRELUDE}
offered = [{'card_id':'fixture', 'legs':[{'learning_receipt':pool['players'][0]['rungs'][0]['learning_receipt']}]}]
with tempfile.TemporaryDirectory() as d:
    out = pathlib.Path(d)/'shadow'
    try:
        pc.capture_generation(pool, schedule, None, offered_records=offered, workspace=out,
                              execute=True, clock=lambda:F.KICKOFF)
        result='accepted'
    except pc.PilotCaptureError as e:
        result=str(e)
    print(json.dumps(dict(result=result, absent=not out.exists())))
`);
  assert.equal(r.result, 'pilot_offered_card_has_refused_receipt');
  assert.equal(r.absent, true);
});

test('an offered cohort captured before kickoff replays after kickoff with its original receipts and clocks', () => {
  const r = py(`${PRELUDE}
offered=[{'card_id':'fixture','legs':[{'learning_receipt':pool['players'][0]['rungs'][0]['learning_receipt']}]}]
with tempfile.TemporaryDirectory() as d:
    first=pc.capture_generation(pool,schedule,None,offered_records=offered,workspace=d,
                                execute=True,clock=lambda:F.RECORDED)
    before={str(p):p.read_bytes() for p in pathlib.Path(d).rglob('*.json')}
    repeat=pc.capture_generation(pool,schedule,None,offered_records=offered,workspace=d,
                                 execute=True,clock=lambda:F.KICKOFF)
    after={str(p):p.read_bytes() for p in pathlib.Path(d).rglob('*.json')}
    print(json.dumps(dict(first=first,repeat=repeat,unchanged=before==after)))
`);
  assert.equal(r.first.offered_cards, 1);
  assert.equal(r.repeat.offered_cards, 1);
  assert.equal(r.repeat.eligible_receipts, r.first.eligible_receipts);
  assert.equal(r.repeat.recorded_utc, r.first.recorded_utc);
  assert.equal(r.repeat.added_generation, false);
  assert.equal(r.unchanged, true);
});

test('offline workspace may not overlap checkout or input files; symlink outputs are refused', () => {
  const r = py(`${PRELUDE}
out=[]
for value in (pc.ROOT, pc.ROOT/'data', pc.ROOT/'data'/'snapshots', pc.ROOT.parent, None):
    try: pc.workspace_root(value); out.append('accepted')
    except pc.PilotCaptureError as e: out.append(str(e))
with tempfile.TemporaryDirectory() as d:
    link=pathlib.Path(d)/'redirect'; link.symlink_to(pc.ROOT/'data', target_is_directory=True)
    try: pc.workspace_root(link); out.append('accepted')
    except pc.PilotCaptureError as e: out.append(str(e))
print(json.dumps(out))
`);
  assert.ok(r.every(reason => reason !== 'accepted'));
  assert.equal(r.at(-1), 'pilot_workspace_symlink');
});

test('CLI owns real capture time and has no historical --as-of option', () => {
  const r = py(`${PRELUDE}
help=subprocess.run([sys.executable,'-B','scripts/pilot_capture.py','--help'],capture_output=True,text=True)
bad=subprocess.run([sys.executable,'-B','scripts/pilot_capture.py','--as-of',F.RECORDED],capture_output=True,text=True)
with tempfile.TemporaryDirectory() as d:
    source=pathlib.Path(d)/'inputs'; source.mkdir()
    for name,value in (('leg_pool',pool),('schedule_full',schedule),('parlay_backtest',None)):
        (source/(name+'.json')).write_text(json.dumps(value))
    run=subprocess.run([sys.executable,'-B','scripts/pilot_capture.py','--input-dir',str(source)],capture_output=True,text=True)
    result=json.loads(run.stdout)
    print(json.dumps(dict(help=help.returncode,bad=bad.returncode,exit=run.returncode,result=result,
                         files=len(list(source.rglob('*'))))))
`);
  assert.equal(r.help, 0);
  assert.equal(r.bad, 2);
  assert.equal(r.exit, 0);
  assert.equal(r.result.writes, false);
  assert.equal(r.result.eligible_receipts, 0, 'old synthetic forecast is never revived with a fake pregame clock');
  assert.equal(r.files, 3);
});
