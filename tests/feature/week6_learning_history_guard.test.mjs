import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SETUP = String.raw`
import contextlib,io,json,os,pathlib,subprocess,tempfile
from unittest.mock import patch
from scripts import learning_history_guard as G
os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
def git(root,*args):
 return subprocess.run(['git','-C',str(root),*args],check=True,text=True,capture_output=True,timeout=10).stdout.strip()
def write(root,path,raw=b'{"synthetic":true}\n'):
 p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw);return p
def commit(root):
 git(root,'add','.');git(root,'-c','commit.gpgsign=false','commit','-m','synthetic history fixture');return git(root,'rev-parse','HEAD')
def repo(root):
 git(root,'init','-b','main');git(root,'config','user.email','fixture@example.invalid');git(root,'config','user.name','Synthetic Fixture')
 git(root,'config','gc.auto','0');git(root,'config','maintenance.auto','false');git(root,'config','core.filemode','true')
 write(root,'README',b'synthetic local history mechanics only\n');return commit(root)
def refused(fn):
 try:fn()
 except Exception:return True
 return False
paths=['data/snapshots/'+p+'/a.json'for p in('learning_journal','learning_sources','learning_outcomes','learning_feedback')]
paths+=['data/learning_control/owner/events/a.json','data/learning_control/inputs/a.json',
 'data/learning_control/transactions/a.json','data/learning_control/unrecognized-history/a.json']
`;
function py(body) {
  const r = spawnSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8',
    input: SETUP + body, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

test('all retained learning families are byte-immutable while unrelated data and new evidence may change', () => {
  const r = py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);repo(root)
 for p in paths:write(root,p)
 write(root,'data/learning_control/current.json');write(root,'data/learning_feedback.json')
 write(root,'data/learning_control/owner/heads/'+'1'*64+'.json')
 old=commit(root)
 for p in paths:write(root,p.replace('a.json','b.json'))
 write(root,'data/learning_control/current.json',b'{"new_pointer":true}')
 write(root,'data/learning_feedback.json',b'{"new_pointer":true}')
 write(root,'data/ordinary.json',b'null')
 head=commit(root);index=(root/'.git/index').read_bytes();before={p:p.read_bytes()for p in(root/'data').rglob('*')if p.is_file()}
 result=G.check_history(root,head,old)
 print(json.dumps({'result':result,'same_index':index==(root/'.git/index').read_bytes(),
  'same_files':all(p.read_bytes()==body for p,body in before.items()),'same_head':git(root,'rev-parse','HEAD')==head}))
`);
  assert.equal(r.result.retained_immutable_files, 8);
  assert.equal(r.result.new_immutable_files, 8);
  assert.equal(r.result.mutable_pointers, 3);
  assert.equal(r.result.owner_authenticated, false);
  assert.equal(r.result.whole_release_pass, false);
  assert.equal(r.same_index, true);
  assert.equal(r.same_files, true);
  assert.equal(r.same_head, true);
});

for (let family = 0; family < 8; family++) test(`immutable family ${family + 1} refuses deletion, replacement, whitespace and mode rewrites despite worktree repair`, () => {
  const r = py(String.raw`
results=[]
# Four mutations per subprocess, one family at a time. Reuse the same original
# Git base for those cases, not an earlier PASS: every mutation gets a distinct
# actual commit and uncommitted repair. All eight families remain independently
# tested, without putting all 32 Git cases inside one 60-second child deadline.
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);repo(root)
 for path in paths:write(root,path)
 old=commit(root)
 for path in [paths[${family}]]:
  for mutation in('delete','replace','whitespace','mode'):
   p=root/path;raw=p.read_bytes()
   if mutation=='delete':p.unlink()
   elif mutation=='replace':p.write_bytes(b'{"synthetic":false}\n')
   elif mutation=='whitespace':p.write_bytes(b'{ "synthetic": true }\n')
   else:p.chmod(0o755)
   head=commit(root);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw);p.chmod(0o644)
   try:G.check_history(root,head,old);raise AssertionError('changed committed history accepted')
   except ValueError as error:results.append(str(error)=='learning_history_removed_or_changed')
print(json.dumps(results))
`);
  assert.equal(r.length, 4);
  assert.ok(r.every(Boolean));
});

test('a mutable authority pointer may not disappear, and a pending transaction cannot be published', () => {
  const r = py(String.raw`
results=[]
for path in('data/learning_feedback.json','data/learning_control/current.json',
 'data/learning_control/owner/heads/'+'1'*64+'.json'):
 with tempfile.TemporaryDirectory()as tmp:
  root=pathlib.Path(tmp);repo(root);p=write(root,path);old=commit(root);p.unlink();head=commit(root)
  results.append(refused(lambda:G.check_history(root,head,old)))
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);old=repo(root);write(root,'data/learning_control/pending.json');head=commit(root)
 results.append(refused(lambda:G.check_history(root,head,old)))
print(json.dumps(results))
`);
  assert.deepEqual(r, [true, true, true, true]);
});

test('exact current head, ancestry and regular committed files are mandatory', () => {
  const r = py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);first=repo(root);write(root,paths[0]);base=commit(root)
 wrong=[refused(lambda:G.check_history(root,h,base))for h in('HEAD','main',True,'0'*40)]
 git(root,'checkout','-b','unrelated',first);write(root,'other',b'branch');other=commit(root)
 wrong.append(refused(lambda:G.check_history(root,other,base)))
 p=root/paths[0];p.parent.mkdir(parents=True,exist_ok=True);p.symlink_to('outside.json');head=commit(root)
 wrong.append(refused(lambda:G.check_history(root,head,first)))
 print(json.dumps(wrong))
`);
  assert.deepEqual(r, [true, true, true, true, true, true]);
});

test('bounded inventory rejects malformed framing, duplicate paths, count/byte limits and changed heads', () => {
  const r = py(String.raw`
raw=b'100644 blob '+b'1'*40+b' 4\tdata/snapshots/learning_sources/a.json\0'
values=[raw[:-1],raw+raw,raw.replace(b'100644',b'120000'),raw.replace(b' blob ',b' commit '),
 raw.replace(b' 4\t',b' -1\t'),raw.replace(b'sources/a',b'sources/../a'),raw.replace(b'data/snapshots/',b'elsewhere/')]
results=[refused(lambda v=v:G._tree(v))for v in values]
for name in('MAX_FILES','MAX_FILE','MAX_TOTAL'):
 with patch.object(G,name,0):results.append(refused(lambda:G._tree(raw)))
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);head=repo(root);call=G.runtime._git
 def changed(root,args,**kwargs):
  if args==['rev-parse','HEAD']and changed.count:
   return b'0'*40
  if args==['rev-parse','HEAD']:changed.count+=1
  return call(root,args,**kwargs)
 changed.count=0
 with patch.object(G.runtime,'_git',side_effect=changed):results.append(refused(lambda:G.check_history(root,head,head)))
 with patch.object(G,'SECONDS',-1):results.append(refused(lambda:G.check_history(root,head,head)))
print(json.dumps(results))
`);
  assert.equal(r.length, 12);
  assert.ok(r.every(Boolean));
});

test('CLI reports static held diagnostics without leaking a private argument or claiming release authority', () => {
  const r = py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);head=repo(root);out,err=io.StringIO(),io.StringIO()
 args=['--checkout',str(root),'--expected-head',head,'--base-head',head]
 with contextlib.redirect_stdout(out):good=G.main(args)
 args[-1]='PRIVATE_INVALID_BASE'
 with contextlib.redirect_stderr(err):bad=G.main(args)
 print(json.dumps({'good':good,'result':json.loads(out.getvalue()),'bad':bad,'error':err.getvalue()}))
`);
  assert.equal(r.good, 0);
  assert.equal(r.bad, 2);
  assert.equal(r.result.production_authorized, false);
  assert.ok(!r.error.includes('PRIVATE'));
});

test('actual publisher refuses remote-head conflicts on feedback/control pointers instead of taking either writer', () => {
  const r = py(String.raw`
results=[]
for path in('data/learning_feedback.json','data/learning_control/current.json'):
 with tempfile.TemporaryDirectory()as tmp:
  root=pathlib.Path(tmp);origin=root/'origin.git';a=root/'a';b=root/'b'
  git(root,'init','--bare',str(origin));git(root,'clone',str(origin),str(a));repo(a)
  write(a,path,b'{"value":"base"}');commit(a);git(a,'push','origin','HEAD:main')
  git(root,'clone','--branch','main',str(origin),str(b));git(b,'config','user.email','fixture@example.invalid');git(b,'config','user.name','Synthetic Fixture')
  write(b,path,b'{"value":"remote"}');commit(b);git(b,'push','origin','main');remote=git(origin,'rev-parse','refs/heads/main')
  write(a,path,b'{"value":"local"}')
  env={**os.environ,'PUBLISH_VALIDATE_CMD':'true','PUBLISH_ATTEMPTS':'1','PUBLISH_BACKOFF_S':'0'}
  result=subprocess.run(['bash',str(G.ROOT/'scripts/publish_data.sh'),'synthetic conflict refusal'],cwd=a,env=env,text=True,capture_output=True,timeout=20)
  results.append([result.returncode!=0,'conflict on learning authority/state records'in result.stdout,
   git(origin,'rev-parse','refs/heads/main')==remote,(a/path).read_bytes()==b'{"value":"local"}'])
print(json.dumps(results))
`);
  assert.deepEqual(r, [[true, true, true, true], [true, true, true, true]]);
});

test('actual publisher refuses loss of old evidence that is no longer referenced by a current pointer', () => {
  const r = py(String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);origin=root/'origin.git';work=root/'work'
 git(root,'init','--bare',str(origin));git(root,'clone',str(origin),str(work));repo(work)
 old=write(work,'data/snapshots/learning_sources/old-unreferenced.json');commit(work);git(work,'push','origin','HEAD:main')
 remote=git(origin,'rev-parse','refs/heads/main');old.unlink();write(work,'data/ordinary.json',b'null')
 env={**os.environ,'PUBLISH_VALIDATE_CMD':'true','PUBLISH_ATTEMPTS':'1','PUBLISH_BACKOFF_S':'0'}
 result=subprocess.run(['bash',str(G.ROOT/'scripts/publish_data.sh'),'synthetic old evidence deletion'],cwd=work,env=env,text=True,capture_output=True,timeout=20)
 print(json.dumps({'held':result.returncode!=0,'reason':'append-only learning history changed'in result.stdout,
  'remote_unchanged':git(origin,'rev-parse','refs/heads/main')==remote}))
`);
  assert.deepEqual(r, { held: true, reason: true, remote_unchanged: true });
});

test('R111 fallback cannot replace even a nonconflicting learning state pointer with the other writer', () => {
  const r = py(String.raw`
results=[]
for path in('data/learning_feedback.json','data/learning_control/current.json'):
 with tempfile.TemporaryDirectory()as tmp:
  root=pathlib.Path(tmp);origin=root/'origin.git';a=root/'a';b=root/'b'
  git(root,'init','--bare',str(origin));git(root,'clone',str(origin),str(a));repo(a)
  write(a,path,b'{"value":"base"}');commit(a);git(a,'push','origin','HEAD:main')
  git(root,'clone','--branch','main',str(origin),str(b));git(b,'config','user.email','fixture@example.invalid');git(b,'config','user.name','Synthetic Fixture')
  write(b,'data/unrelated.json',b'{"remote":true}');commit(b);git(b,'push','origin','main');remote=git(origin,'rev-parse','refs/heads/main')
  write(a,path,b'{"value":"local"}')
  env={**os.environ,'PUBLISH_VALIDATE_CMD':'false','PUBLISH_ATTEMPTS':'1','PUBLISH_BACKOFF_S':'0'}
  result=subprocess.run(['bash',str(G.ROOT/'scripts/publish_data.sh'),'synthetic state fallback refusal'],cwd=a,env=env,text=True,capture_output=True,timeout=20)
  results.append([result.returncode!=0,'fallback would replace learning authority/state records'in result.stdout,
   git(origin,'rev-parse','refs/heads/main')==remote,(a/path).read_bytes()==b'{"value":"local"}'])
print(json.dumps(results))
`);
  assert.deepEqual(r, [[true, true, true, true], [true, true, true, true]]);
});
