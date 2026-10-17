import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FILES = ['scripts/capture_final_participation.py', 'scripts/shadow_participation_guard.py'];
const hashes = FILES.map(name => createHash('sha256').update(readFileSync(ROOT + name)).digest('hex'));
// Reuse only the local synthetic provider fixture, not the author's assertions
// or expected result computation. These are not real retained ESPN wire bytes.
const fixtureSource = readFileSync(ROOT + 'tests/feature/week6_final_participation.test.mjs', 'utf8');
const match = fixtureSource.match(/const FIXTURE = String.raw`([\s\S]*?)`;\nfunction py/);
assert.ok(match, 'Local synthetic fixture must remain explicit and reviewable');

function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], {cwd:ROOT, input:match[1] + body,
    encoding:'utf8', timeout:30000, maxBuffer:8*1024*1024,
    env:{...process.env, PYTHONDONTWRITEBYTECODE:'1'}}).trim());
}

test('identifiable malformed DNP flags quarantine only that identity; unidentifiable rows do not contaminate the other team', () => {
  const result = py(String.raw`
identified=capture(Provider(home=[{'playerId':'123','didNotPlay':True},{'playerId':'124','didNotPlay':'false'}]))
unidentified=capture(Provider(home=[{'playerId':'123','didNotPlay':True},{'playerId':True,'didNotPlay':True}]))
print(json.dumps({'identified':[P.explicit_dnp(identified,p,t)for p,t in(('123','SEA'),('124','SEA'),('200','LAR'))],
 'unidentified':[P.explicit_dnp(unidentified,p,t)for p,t in(('123','SEA'),('200','LAR'))]}))
`);
  assert.deepEqual(result.identified.map(row => row.explicit_dnp), [true, null, true]);
  assert.deepEqual(result.unidentified.map(row => row.explicit_dnp), [null, true]);
  assert.ok([...result.identified, ...result.unidentified].every(row => !row.played_inferred && !row.source_authority_authenticated));
});

test('provider reference injection never chooses a fetch URL or acquires source authority', () => {
  const result = py(String.raw`
results=[]
for ref in('https://sports.core.api.espn.com.evil.invalid/teams/26','https://user@sports.core.api.espn.com/teams/26',
           P.CORE+'/teams/26?redirect=https://evil.invalid/',P.CORE+'/teams/26#trusted'):
 provider=Provider()
 def mutate(spec,value):
  if spec['profile']==P.COMPETITION:value['competitors'][0]['team']['$ref']=ref
 provider.mutate=mutate
 results.append({'rejected':error(lambda:capture(provider))is not None,
  'safe_urls':all(q['source_url'].startswith(P.CORE+'/')or q['profile']==P.SCOREBOARD for q in provider.calls),
  'calls':len(provider.calls)})
print(json.dumps(results))
`);
  assert.ok(result.every(row => row.rejected && row.safe_urls && row.calls === 2));
});

test('as-of participation requires the whole validated capture, with exact UTC cutoff and no inferred clearance', () => {
  const result = py(String.raw`
b=capture();h=history();end=b['manifest']['completed_utc']
before=(P.instant(end)-dt.timedelta(microseconds=1)).isoformat().replace('+00:00','Z')
same=G.evaluate(h,[b],context(decision_utc=end),clearance={'verified':True,'status':'Active'})
late=G.evaluate(h,[b],context(decision_utc=before))
print(json.dumps({'same':same,'late':late}))
`);
  assert.equal(result.same.direct_dnp_observed, true);
  assert.equal(result.late.direct_dnp_observed, null);
  assert.ok([result.same, result.late].every(row => row.status === 'held_unknown' && row.shadow_signal === null && row.weight === 0));
  assert.ok([result.same, result.late].every(row => !row.previous_game_inventory_verified && !row.clearance_authority_verified && !row.serving_changed));
});

test('duplicate raw JSON and resealed source-authority assertions cannot become valid participation evidence', () => {
  const result = py(String.raw`
base=Provider()
def duplicate(spec):
 status,headers,raw=base(spec)
 if spec['profile']==P.ROSTER and spec['team_id']=='26':
  raw=raw.replace(b'"didNotPlay":true',b'"didNotPlay":true,"didNotPlay":false',1)
 return status,headers,raw
errors=[error(lambda:P.capture(2026,5,GID,fetcher=duplicate,clock=clock()))]
b=capture();tampered=copy.deepcopy(b);tampered['manifest']['source_authority_authenticated']=True
tampered['manifest']=P.seal({k:v for k,v in tampered['manifest'].items()if k!='capture_id'},'capture_id')
errors.append(error(lambda:P.verify_capture(tampered)))
calls=[];context_bad=context();context_bad['team']='S'*5000;h=history()
with mock.patch.object(C,'verify_capture',side_effect=lambda *_:calls.append('should-not-reach')):
 refusal=G.evaluate(h,[b],context_bad)
print(json.dumps({'errors':errors,'refusal':refusal,'early_parser_calls':calls}))
`);
  assert.ok(result.errors.every(Boolean));
  assert.deepEqual(result.early_parser_calls, []);
  assert.equal(result.refusal.reason, 'participation_shadow_refused');
  assert.equal(result.refusal.shadow_signal, null);
});

after(() => {
  FILES.forEach((name, index) => assert.equal(createHash('sha256').update(readFileSync(ROOT + name)).digest('hex'), hashes[index],
    'Participaton source changed during independent verification'));
});
