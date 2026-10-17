import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SETUP = String.raw`
import contextlib,io,json,os,pathlib,subprocess,tempfile
from unittest.mock import patch
from scripts import period_publication_gate as G
os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
def git(root,*args):
 return subprocess.run(['git','-C',str(root),*args],check=True,text=True,capture_output=True,timeout=10).stdout.strip()
def write(root,path,raw=b'{"synthetic":true}\n'):
 p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw);return p
def commit(root,message='synthetic settlement fixture'):
 git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-m',message);return git(root,'rev-parse','HEAD')
def repo(root):
 git(root,'init','-b','main');git(root,'config','user.email','fixture@example.invalid');git(root,'config','user.name','Synthetic Fixture')
 git(root,'config','gc.auto','0');git(root,'config','maintenance.auto','false');git(root,'config','core.filemode','true')
 write(root,'data/learning_control/current.json',b'{"synthetic_expired_historical_application":true}\n')
 write(root,'data/leg_pool.json');write(root,'data/my_cards/2026_wk06.json')
 write(root,'scripts/old_consumer.py',b'# synthetic old released source\n')
 write(root,'app/old_consumer.js',b'// synthetic old released browser\n')
 return commit(root,'synthetic published consumer, not a validated real model')
def check(root,head,base):
 return G.check_publication(checkout=root,expected_head=head,base_head=base,clock=lambda:'2026-10-18T22:00:00Z')
def refusal(fn):
 try:fn()
 except Exception as error:return str(error)
 raise AssertionError('invalid publication accepted')
`;
function py(body) {
  const r = spawnSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8',
    input: SETUP + body, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

test('settlement preserves historical MY consumer bytes without falsely revalidating its expired forecast', () => {
  const r = py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);base=repo(root)
 for path in('data/pipeline_stages.json','data/review.json','data/model_tuning.json','data/parlays/2026_wk06.json',
  'data/snapshots/learning_outcomes/new.json','data/snapshots/learning_feedback/new.json','data/learning_feedback.json'):
  write(root,path)
 head=commit(root);before=(root/'.git/index').read_bytes()
 with patch.object(G.replay,'check_committed',side_effect=AssertionError('historical expiry/refit must not run')):
  result=check(root,head,base)
 assert before==(root/'.git/index').read_bytes()
 print(json.dumps(result))
`);
  assert.equal(r.consumer_check_pass, true);
  assert.equal(r.new_generation, false);
  assert.equal(r.consumer_unchanged_proven, true);
  assert.equal(r.historical_generation_revalidated, false);
  assert.equal(r.supported_MY_yardage_consumer_semantics_verified, false);
  for (const flag of ['whole_release_pass', 'publication_authorized', 'production_authorized',
    'owner_authenticated', 'provider_authenticated', 'upstream_eligibility_verified',
    'public_serving_verified', 'accuracy_improvement_verified', 'source_writes']) assert.equal(r[flag], false, flag);
});

for (const [name, paths] of [
  ['producer sources', ['data/player_weekly.json', 'data/injuries.json', 'data/depth_chart.json', 'data/inactives.json']],
  ['consumer code and policy', ['scripts/new_consumer.py', 'app/new_consumer.js', 'config/excluded_games.json', 'sw.js']],
  ['MY pool, archive and lineage', ['data/leg_pool.json', 'data/my_cards/2026_wk06.json',
    'data/snapshots/learning_journal/new.json', 'data/snapshots/learning_sources/new.json']],
  ['current or owner authority', ['data/learning_control/current.json', 'data/learning_control/owner/events/new.json',
    'data/learning_control/owner/heads/new.json', 'data/learning_control/evidence/new.json']],
]) test(`a settlement cannot change ${name}`, () => {
  const r = py(String.raw`
results=[]
for path in ${JSON.stringify(paths)}:
 with tempfile.TemporaryDirectory()as tmp:
  root=pathlib.Path(tmp);base=repo(root);write(root,path,b'{"changed":true}\n');head=commit(root)
  # An uncommitted repair is not the original selected Git tree.
  write(root,path,b'{"synthetic":true}\n')
  results.append(refusal(lambda:check(root,head,base)))
print(json.dumps(results))
`);
  assert.equal(r.length, paths.length);
  assert.ok(r.every(s => /period_publication_explicit_generation_pins_required/.test(s)), r);
});

test('temporary unpublished forecast changes cannot hide behind a final restoration', () => {
  const r = py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);write(root,'data/injuries.json');base=repo(root)
 raw=(root/'data/injuries.json').read_bytes();write(root,'data/injuries.json',b'{"temporary_forecast":true}\n');commit(root)
 write(root,'data/injuries.json',raw);write(root,'data/review.json');head=commit(root)
 print(json.dumps(refusal(lambda:check(root,head,base))))
`);
  assert.equal(r, 'period_publication_unpublished_consumer_change');
});

test('new control records never use the unchanged route and input errors cannot authorize publication', () => {
  const r = py(String.raw`
results=[]
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);git(root,'init','-b','main');git(root,'config','user.email','fixture@example.invalid');git(root,'config','user.name','Synthetic Fixture')
 write(root,'data/review.json');base=commit(root);write(root,'data/learning_control/current.json');head=commit(root)
 results.append(refusal(lambda:check(root,head,base)))
 results.append(refusal(lambda:check(root,'HEAD',base)))
 results.append(refusal(lambda:check(root,head,head)))
 out=io.StringIO();err=io.StringIO()
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
  code=G.main(['--checkout',str(root),'--expected-head',head,'--base-head',base])
 assert code==2 and not out.getvalue();denied=json.loads(err.getvalue())
 results.append(denied['consumer_check_pass']is False and denied['publication_authorized']is False)
print(json.dumps(results))
`);
  assert.deepEqual(r, ['period_publication_explicit_generation_pins_required',
    'period_publication_exact_distinct_heads_required', 'period_publication_exact_distinct_heads_required', true]);
});

test('ambiguous merged settlements and consumer symlinks cannot pass as byte-identical history', () => {
  const r = py(String.raw`
results=[]
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);base=repo(root);git(root,'checkout','-b','other');write(root,'data/other.json');commit(root)
 git(root,'checkout','main');write(root,'data/review.json');commit(root)
 git(root,'-c','commit.gpgsign=false','merge','--no-ff','other','-m','synthetic ambiguous merge')
 results.append(refusal(lambda:check(root,git(root,'rev-parse','HEAD'),base)))
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);base=repo(root);p=root/'data/leg_pool.json';p.unlink();p.symlink_to('elsewhere.json');head=commit(root)
 results.append(refusal(lambda:check(root,head,base)))
print(json.dumps(results))
`);
  assert.deepEqual(r, ['period_publication_ambiguous_commit', 'period_publication_nonregular_consumer']);
});

test('publisher requires complete explicit v2 pins and retains the exact-tree default refusal', () => {
  const r = spawnSync('bash', ['scripts/publish_data.sh', '--period-generation-id', `sha256:${'1'.repeat(64)}`, 'synthetic'],
    { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /all five period publication pins are required/);
});
