import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url);
test('local operator dispatch keeps read/prepare/intent/apply separate and never invents release permission', () => {
  const result = JSON.parse(execFileSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8', input: String.raw`
import contextlib,io,json
from unittest.mock import patch
from scripts import period_operator as O
class Journal:
 def read_owner_intents(self,_):return {'events':[]}
class Control:
 def __init__(self,**kwargs):self.journal=Journal();self.clock=kwargs['clock'];self.calls=[];controls.append(self)
 def current(self):self.calls.append('current');return 'base',None,{'generated_utc':'2026-10-16T20:00:00Z'}
 def prepare(self,**kwargs):self.calls.append(('prepare',kwargs));return 'package'
 def record_intent(self,oid,**kwargs):
  self.calls.append(('intent',oid,kwargs))
  if kwargs['action']!='revoke'and not kwargs['acknowledge_retrospective']:raise ValueError('PRIVATE_RISK_ACK_MISSING')
  return {'event_id':'event'}
 def apply_and_save(self):
  self.calls.append('apply');return {'generated_utc':'now'},{'application_id':'app','artifact_id':'artifact','owner_head_event_id':'event'}
 def reverify(self):self.calls.append('reverify');return {'MY_card_semantics_verified':False}
controls=[];args=['--data-dir','PRIVATE_DATA','--engine-checkout','PRIVATE_ENGINE','--engine-commit','pin',
 '--authority-id','authority','--actor-ref','actor'];results=[]
commands=[['inspect'],['prepare','--season','2026','--week','6'],['apply'],['reverify']]
for action in('approve','rollback','revoke'):
 c=[action,'--package-id','package','--reason','PRIVATE_REASON']
 if action!='revoke':c+=['--expires-utc','2026-10-20T00:00:00Z','--ack-retrospective-risk']
 commands.append(c)
with patch.object(O.period,'PeriodCalibrator',Control):
 for command in commands:
  out=io.StringIO()
  with contextlib.redirect_stdout(out):code=O.main(args+command,clock=lambda:'2026-10-16T20:00:01Z')
  results.append({'code':code,'result':json.loads(out.getvalue()),'calls':controls[-1].calls})
 err=io.StringIO()
 with contextlib.redirect_stderr(err):denied=O.main(args+['approve','--package-id','package','--reason','PRIVATE_REASON',
  '--expires-utc','2026-10-20T00:00:00Z'])
 results.append({'code':denied,'error':err.getvalue()})
print(json.dumps(results))
` }));
  assert.equal(result.length, 8);
  for (const { code, result: r } of result.slice(0, 7)) {
    assert.equal(code, 0);
    assert.equal(r.owner_authenticated, false);
    assert.equal(r.production_authorized, false);
    assert.equal(r.publication_authorized, false);
    assert.equal(r.accuracy_improvement_verified, false);
    assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  }
  assert.deepEqual(result[0].calls, ['current']);
  assert.deepEqual(result[1].calls, [['prepare', { season: 2026, week: 6 }]]);
  assert.deepEqual(result[2].calls, ['apply']);
  assert.deepEqual(result[3].calls, ['reverify']);
  assert.equal(result[7].code, 2);
  assert.ok(!result[7].error.includes('PRIVATE'));
});
