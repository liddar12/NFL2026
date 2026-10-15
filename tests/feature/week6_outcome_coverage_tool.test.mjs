import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SETUP = `
import copy,importlib.util,json,os,pathlib,subprocess,sys,tempfile,uuid
spec=importlib.util.spec_from_file_location('outcome_coverage','tests/measure_outcome_coverage.py')
M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
def fixture(root):
    scripts=root/'scripts';scripts.mkdir()
    (scripts/'capture_outcome_evidence.py').write_text('def never_called():\\n    return 99\\n\\ndef from_thread():\\n    marker = 4\\n    return marker\\n')
    (scripts/'build_learning_outcomes.py').write_text('VALUE = 1\\n')
def configure(root,shards):
    config=M.make_config(root,uuid.uuid4().hex)
    path=shards/'config.json';path.write_text(json.dumps(config))
    return config,path
def pychild(code,root,path):
    env=M.child_environment(pathlib.Path('tests/coverage').resolve(),path)
    return subprocess.run([sys.executable,'-c',code],cwd=root,env=env,capture_output=True,text=True)
`;

function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, input: SETUP + body,
  }).trim().split('\n').pop());
}

test('outcome coverage hook is inert without the explicit opt-in configuration', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    env=os.environ.copy();env.pop(M.CONFIG_ENV,None)
    env['PYTHONPATH']=str(pathlib.Path('tests/coverage').resolve())
    code='import sys,threading,json;print(json.dumps({"sys_trace":sys.gettrace() is None,"thread_trace":getattr(threading,"gettrace",lambda:None)() is None}))'
    child=subprocess.run([sys.executable,'-c',code],env=env,cwd=tmp,capture_output=True,text=True)
    print(json.dumps({'exit':child.returncode,'result':json.loads(child.stdout),'files':list(pathlib.Path(tmp).iterdir())}))
`);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.result, { sys_trace: true, thread_trace: true });
  assert.deepEqual(r.files, []);
});

test('child thread execution is covered and uncalled function remains in full denominator', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);fixture(root);shards=root/'shards';shards.mkdir()
    config,path=configure(root,shards)
    child=pychild('import threading;from scripts import capture_outcome_evidence as C,build_learning_outcomes; t=threading.Thread(target=C.from_thread);t.start();t.join()',root,path)
    observed,metadata=M.collect_shards(shards,config)
    result=M.summarize(M.executable_lines(root/M.TARGETS[0]),observed[M.TARGETS[0]])
    print(json.dumps({'exit':child.returncode,'stderr':child.stderr,'summary':result,'metadata':metadata,'python':config['python']}))
`);
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.metadata.shards, 1);
  assert.ok(r.summary.covered_lines.includes(5), 'new child thread body was traced');
  assert.ok(r.summary.covered_lines.includes(6));
  assert.ok(r.summary.missing_lines.includes(2), 'never-called function body stays in denominator');
  assert.ok(r.summary.percent < 100);
  assert.equal(r.summary.total, r.summary.covered + r.summary.missing_lines.length);
  assert.ok(r.python.executable.endsWith('python3.12') || r.python.executable.includes('python'));
});

test('malformed, duplicate-key, foreign-run, source, interpreter and line shards fail closed', () => {
  const r = py(`
results={}
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);fixture(root);shards=root/'shards';shards.mkdir();config,path=configure(root,shards)
    child=pychild('from scripts import capture_outcome_evidence,build_learning_outcomes',root,path)
    valid_path=next(p for p in shards.glob('*.json') if p.name!='config.json');valid=json.loads(valid_path.read_text())
    for mode in ('malformed','duplicate','run','interpreter','source','bool_line','outside_line','duplicate_line','unknown_target','bool_version','empty','duplicate_pid','wrong_filename'):
        changed=copy.deepcopy(valid)
        if mode=='run':changed['run_id']='0'*32
        elif mode=='interpreter':changed['python']['version']='wrong'
        elif mode=='source':changed['targets'][M.TARGETS[0]]['source_sha256_after']='wrong'
        elif mode=='bool_line':changed['targets'][M.TARGETS[0]]['covered_lines']=[True]
        elif mode=='outside_line':changed['targets'][M.TARGETS[0]]['covered_lines']=[10000]
        elif mode=='duplicate_line':changed['targets'][M.TARGETS[0]]['covered_lines']=[1,1]
        elif mode=='unknown_target':changed['targets']['other.py']={}
        elif mode=='bool_version':changed['version']=True
        raw='{' if mode=='malformed' else '{"version":1,"version":1}' if mode=='duplicate' else json.dumps(changed)
        valid_path.write_text(raw)
        if mode=='empty':valid_path.unlink()
        extra=None
        if mode=='duplicate_pid':
            extra=shards/(str(valid['pid'])+'-'+'0'*32+'.json');extra.write_text(json.dumps(valid))
        elif mode=='wrong_filename':
            valid_path.unlink();extra=shards/'wrong-filename.json';extra.write_text(json.dumps(valid))
        try:M.collect_shards(shards,config);results[mode]=False
        except (ValueError,TypeError,KeyError):results[mode]=True
        if extra:extra.unlink()
        valid_path.write_text(json.dumps(valid))
print(json.dumps({'exit':child.returncode,'cases':results}))
`);
  assert.equal(r.exit, 0);
  assert.ok(Object.values(r.cases).every(Boolean), JSON.stringify(r.cases));
});

test('source changes and mismatched startup interpreters terminate instrumentation rather than silently skip', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp);fixture(root);shards=root/'shards';shards.mkdir();config,path=configure(root,shards)
    changed=copy.deepcopy(config);changed['python']['version']='wrong';path.write_text(json.dumps(changed))
    mismatch=pychild('print("must not run")',root,path)
    changed=copy.deepcopy(config);changed['version']=True;path.write_text(json.dumps(changed))
    boolean=pychild('print("must not run")',root,path)
    path.write_text(json.dumps(config));(root/M.TARGETS[0]).write_text('CHANGED = True\\n')
    changed_source=pychild('print("must not run")',root,path)
    print(json.dumps({'mismatch':mismatch.returncode,'source':changed_source.returncode,'boolean':boolean.returncode,
                      'stdout':mismatch.stdout+changed_source.stdout+boolean.stdout}))
`);
  assert.equal(r.mismatch, 97);
  assert.equal(r.source, 97);
  assert.equal(r.boolean, 97);
  assert.equal(r.stdout, '');
});

test('each critical file must meet the floor and failed suites or changed sources cannot pass', () => {
  const r = py(`
rows=[{'covered':900,'total':900,'percent':100.0},{'covered':89,'total':100,'percent':89.0}]
ok=[{'exit_code':0}]
aggregate_only=M.passes(rows,ok,True,[],90)
rows[1].update(covered=90,percent=90.0)
print(json.dumps({'aggregate_only':aggregate_only,'per_file':M.passes(rows,ok,True,[],90),
 'failed_suite':M.passes(rows,[{'exit_code':1}],True,[],90),
 'unstable':M.passes(rows,ok,False,[],90),'bad_shard':M.passes(rows,ok,True,['bad'],90),
 'rounded_up':M.passes([{'covered':2249999,'total':2500000,'percent':90.0}],ok,True,[],90)}))
`);
  assert.deepEqual(r, { aggregate_only: false, per_file: true, failed_suite: false, unstable: false, bad_shard: false, rounded_up: false });
});

test('report output is JSON evidence only, never sources/data or a symlink redirected path', () => {
  const r = py(`
with tempfile.TemporaryDirectory() as tmp:
    base=pathlib.Path(tmp);root=base/'checkout';root.mkdir();(root/'docs/reviews').mkdir(parents=True)
    (root/'data').mkdir();(root/'data/schedule.json').write_text('source bytes')
    (root/'docs/reviews/redirect').symlink_to(root/'data',target_is_directory=True)
    (root/'docs/reviews/old.json').write_text('old evidence')
    (root/'docs/reviews/link.json').symlink_to(root/'docs/reviews/old.json')
    os.link(root/'data/schedule.json',root/'docs/reviews/hardlink.json')
    (base/'redirect').symlink_to(root/'docs/reviews',target_is_directory=True)
    denied={}
    for name,path in {'data':root/'data/schedule.json','other_source':root/'config.json',
      'wrong_extension':base/'report.py','home':pathlib.Path.home()/'coverage-report.json',
      'directory_link':root/'docs/reviews/redirect/report.json','file_link':root/'docs/reviews/link.json',
      'external_link':base/'redirect/report.json','git':root/'.git/report.json',
      'hard_link':root/'docs/reviews/hardlink.json'}.items():
        try:M.safe_output_path(root,path);denied[name]=False
        except ValueError:denied[name]=True
    allowed=[M.safe_output_path(root,root/'docs/reviews/new.json')==(root/'docs/reviews/new.json').resolve(),
             M.safe_output_path(root,base/'temporary.json')==(base/'temporary.json').resolve()]
    try:M.write_evidence(root,root/'docs/reviews/hardlink.json',{'report':True});denied['hard_link_write']=False
    except ValueError:denied['hard_link_write']=True
    M.write_evidence(root,root/'docs/reviews/new.json',{'report':True})
    print(json.dumps({'denied':denied,'allowed':allowed,'source':(root/'data/schedule.json').read_text(),
                      'written':json.loads((root/'docs/reviews/new.json').read_text())}))
`);
  assert.ok(Object.values(r.denied).every(Boolean), JSON.stringify(r.denied));
  assert.deepEqual(r.allowed, [true, true]);
  assert.equal(r.source, 'source bytes');
  assert.deepEqual(r.written, { report: true });
});
