import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
function py(input){
 const result=spawnSync('python3',['-B','-'],{cwd:ROOT,input,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
 assert.equal(result.status,0,result.stderr+result.stdout);return JSON.parse(result.stdout.trim().split('\n').pop());
}
const COMMON=String.raw`
import contextlib,copy,io,json,os,pathlib,tempfile,types
from unittest.mock import patch
from scripts import pilot_config as C,publish_my_generation as P,generation_capture_runtime as G
from scripts import run_my_generation as R,my_freshness as S
def refused(fn):
 try:fn()
 except (ValueError,OSError,TypeError,KeyError,RecursionError):return True
 return False
def config():
 value=json.loads(pathlib.Path('config/selflearning_pilot.json').read_bytes());value['enabled']=False;return value
def result():
 return {'version':1,'kind':'nfl.MY_generation_run.v1','status':'local_MY_generated_not_published',
  'route':'incumbent_no_owner_intent','generation_sha':'a'*40,'engine_used':False,'engine_commit_verified':False,
  'freshness_profile':S.PROFILE,'owner_intent_action':None,'runtime_binding_id':'sha256:'+'1'*64,
  'target_generation_id':'sha256:'+'2'*64,'binding_artifact_name':'3'*64+'.json',
  'period_generation_id':None,'application_id':None,'owner_head_event_id':None,
  'archive_changed':True,'archive_cards':7,**R.FLAGS}
def owned():
 value=result();value.update(route='existing_explicit_owner_intent',engine_used=True,engine_commit_verified=True,
  owner_intent_action='approve',period_generation_id='sha256:'+'4'*64,application_id='sha256:'+'5'*64,
  owner_head_event_id='sha256:'+'6'*64);return value
`;

test('reviewed source config is defaultable without manual vars; only a complete explicit pair can override',()=>{
 const r=py(COMMON+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 path=pathlib.Path(tmp)/'config.json';path.write_text(json.dumps(config()));rows=[]
 for env in ({},{'SELFLEARN_NFL_PILOT_ENABLED':'','SELFLEARN_NFL_ENGINE_COMMIT':''},
  {'SELFLEARN_NFL_PILOT_ENABLED':'1','SELFLEARN_NFL_ENGINE_COMMIT':'c'*40},
  {'SELFLEARN_NFL_PILOT_ENABLED':'0','SELFLEARN_NFL_ENGINE_COMMIT':'d'*40}):rows.append(C.resolve(path,env))
 invalid=[]
 for env in ({'SELFLEARN_NFL_PILOT_ENABLED':'1'},{'SELFLEARN_NFL_ENGINE_COMMIT':'c'*40},
  {'SELFLEARN_NFL_PILOT_ENABLED':'true','SELFLEARN_NFL_ENGINE_COMMIT':'c'*40},
  {'SELFLEARN_NFL_PILOT_ENABLED':'1','SELFLEARN_NFL_ENGINE_COMMIT':'main'},
  {'SELFLEARN_NFL_PILOT_ENABLED':' 1','SELFLEARN_NFL_ENGINE_COMMIT':'C'*40}):invalid.append(refused(lambda:C.resolve(path,env)))
 assert C.PROFILE==S.PROFILE
 print(json.dumps({'rows':rows,'invalid':invalid}))
`);
 assert.deepEqual(r.rows.map(row=>row.enabled),['0','0','1','0']);
 assert.deepEqual(r.rows.map(row=>row.configuration_source),['repository_config','repository_config','repository_variables','repository_variables']);
 assert.deepEqual(r.invalid,Array(5).fill(true));
});

test('malformed, duplicate, oversized and nonregular source config never silently falls back',()=>{
 const r=py(COMMON+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);path=root/'config.json';checks=[]
 for key,value in (('version',True),('enabled',1),('engine_commit','main'),('engine_commit','B'*40),
  ('freshness_profile','PRIVATE_PROFILE'),('authority_id','wrong'),('actor_ref','owner\nINJECT=1'),('extra','PRIVATE')):
  bad=config();bad[key]=value;path.write_text(json.dumps(bad));checks.append(refused(lambda:C.resolve(path,{})))
 for raw in ('{"version":1,"version":1}','x'*16385,'[]'):
  path.write_text(raw);checks.append(refused(lambda:C.resolve(path,{})))
 path.write_text(json.dumps(config()));link=root/'link.json';link.symlink_to(path)
 checks.append(refused(lambda:C.resolve(link,{})))
 fifo=root/'fifo';os.mkfifo(fifo);checks.append(refused(lambda:C.resolve(fifo,{})))
 print(json.dumps(checks))
`);
 assert.deepEqual(r,Array(13).fill(true));
});

test('GHA output appends validated nonsecret fields only to its provided regular single-link file',()=>{
 const r=py(COMMON+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);path=root/'config.json';path.write_text(json.dumps(config()))
 output=root/'GITHUB_OUTPUT';output.write_text('previous=preserved\n')
 env={'GITHUB_OUTPUT':str(output),'SELFLEARN_OPERATOR_TOKEN':'PRIVATE_OPERATOR_SECRET','SUPABASE_SECRET_KEY':'PRIVATE_DB_SECRET'}
 values=C.resolve(path,env);C.write_outputs(output,values,env);text=output.read_text();checks=[]
 wrong=root/'wrong';wrong.write_text('safe')
 checks.append(refused(lambda:C.write_outputs(wrong,values,env)))
 link=root/'link';link.symlink_to(output)
 checks.append(refused(lambda:C.write_outputs(link,values,{'GITHUB_OUTPUT':str(link)})))
 hard=root/'hard';os.link(wrong,hard)
 checks.append(refused(lambda:C.write_outputs(wrong,values,{'GITHUB_OUTPUT':str(wrong)})))
 bad={**values,'actor_ref':'owner\nINJECT=1'}
 checks.append(refused(lambda:C.write_outputs(output,bad,env)))
 checks.append(refused(lambda:C.write_outputs(output,values,{})))
 assert wrong.read_text()=='safe'
 print(json.dumps({'text':text,'checks':checks}))
`);
 assert.ok(r.text.startsWith('previous=preserved\n'));assert.match(r.text,/enabled=0\n/);
 assert.ok(!r.text.includes('PRIVATE')&&!r.text.includes('TOKEN')&&!r.text.includes('SUPABASE'));
 assert.deepEqual(r.checks,Array(5).fill(true));
});

test('config CLI failure diagnostics never expose raw config, private paths or environment secrets',()=>{
 const r=py(COMMON+String.raw`
with tempfile.TemporaryDirectory(prefix='PRIVATE-')as tmp:
 path=pathlib.Path(tmp)/'PRIVATE.json';path.write_text('PRIVATE_NOT_JSON')
 out,err=io.StringIO(),io.StringIO()
 with patch.dict(os.environ,{'SELFLEARN_OPERATOR_TOKEN':'PRIVATE_TOKEN'},clear=True),contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
  code=C.main(['--config',str(path)])
 print(json.dumps({'code':code,'stdout':out.getvalue(),'error':err.getvalue()}))
`);
 assert.equal(r.code,2);assert.equal(r.stdout,'');assert.ok(!r.error.includes('PRIVATE'));
 assert.equal(JSON.parse(r.error).status,'pilot_configuration_refused');
});

test('publication dispatcher routes only fixed flags; owner/engine pins come from trusted invocation, not result JSON',()=>{
 const r=py(COMMON+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);path=root/'result.json';opts=dict(result_path=path,capture_dir=root/'capture',
  engine_checkout=root/'engine',engine_commit='b'*40,authority_id='sha256:'+'7'*64,actor_ref='liddar12',message='data: synthetic fixture')
 rows=[]
 with patch.object(G,'head_identity',return_value='a'*40):
  for value in (result(),owned()):
   path.write_text(json.dumps(value));rows.append(P.command(**opts))
 print(json.dumps(rows))
`);
 assert.ok(r[0][1].endsWith('/scripts/publish_data.sh'));assert.equal(r[0][2],'--selected-MY-binding');
 assert.match(r[0][3],/[0-9a-f]{64}\.json$/);assert.equal(r[0].at(-1),'data: synthetic fixture');
 assert.deepEqual(r[1].filter(value=>value.startsWith('--')),['--period-generation-id','--period-engine-checkout','--period-engine-commit','--period-authority-id','--period-actor-ref']);
 assert.equal(r[1][r[1].indexOf('--period-engine-commit')+1],'b'.repeat(40));
 assert.equal(r[1][r[1].indexOf('--period-actor-ref')+1],'liddar12');
});

test('publication metadata rejects extra/nested/duplicate/oversized fields, path traversal and route switching before subprocess',()=>{
 const r=py(COMMON+String.raw`
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);path=root/'result.json';checks=[]
 faults=(('version',True),('kind','other'),('status','already_published'),('route','other'),
  ('generation_sha','main'),('freshness_profile','unselected'),('archive_cards',True),('archive_cards',1000001),
  ('archive_changed',1),('binding_artifact_name','../escape.json'),('binding_artifact_name','/private/file.json'),
  ('runtime_binding_id','bad'),('engine_used',True),('period_generation_id','sha256:'+'4'*64),
  ('owner_intent_action','approve'),('publication_authorized',True),('extra',{'nested':['PRIVATE']}))
 for key,value in faults:
  bad=result();bad[key]=value;path.write_text(json.dumps(bad));checks.append(refused(lambda:P.read_result(path)))
 for key,value in (('engine_commit_verified',False),('period_generation_id',None),('owner_intent_action','prepare')):
  bad=owned();bad[key]=value;path.write_text(json.dumps(bad));checks.append(refused(lambda:P.read_result(path)))
 for raw in ('{"version":1,"version":1}','x'*16385,'[]'):
  path.write_text(raw);checks.append(refused(lambda:P.read_result(path)))
 path.write_text(json.dumps(result()));link=root/'link';link.symlink_to(path);checks.append(refused(lambda:P.read_result(link)))
 opts=dict(result_path=path,capture_dir=root/'capture',engine_checkout=root/'engine',engine_commit='b'*40,
  authority_id='sha256:'+'7'*64,actor_ref='liddar12',message='data: fixture')
 with patch.object(G,'head_identity',return_value='c'*40):checks.append(refused(lambda:P.command(**opts)))
 with patch.object(G,'head_identity',return_value='a'*40):
  for changes in ({'engine_commit':'main'},{'authority_id':'bad'},{'actor_ref':'bad\nINJECT=1'},
   {'message':'bad\nmessage'},{'capture_dir':P.ROOT}):checks.append(refused(lambda:P.command(**{**opts,**changes})))
 print(json.dumps(checks))
`);
 assert.deepEqual(r,Array(30).fill(true));
});

test('publication CLI is default-off, propagates the real publisher exit code and never reports a forged success',()=>{
 const r=py(COMMON+String.raw`
out=io.StringIO()
with patch.object(P.subprocess,'run',side_effect=AssertionError('no publish')),contextlib.redirect_stdout(out):dry=P.main([])
with tempfile.TemporaryDirectory()as tmp:
 root=pathlib.Path(tmp);path=root/'result.json';path.write_text(json.dumps(result()))
 args=['--execute','--result-path',str(path),'--capture-dir',str(root/'capture'),'--engine-checkout',str(root/'engine'),
  '--engine-commit','b'*40,'--authority-id','sha256:'+'7'*64,'--actor-ref','liddar12','--message','data: fixture']
 with patch.object(G,'head_identity',return_value='a'*40),patch.object(P.subprocess,'run',return_value=types.SimpleNamespace(returncode=7))as publish:
  code=P.main(args)
 assert publish.call_count==1 and publish.call_args.kwargs=={'cwd':P.ROOT,'check':False}
 path.write_text('PRIVATE_INVALID');error=io.StringIO()
 with patch.object(P.subprocess,'run',side_effect=AssertionError('no publish')),contextlib.redirect_stderr(error):refused_code=P.main(args)
 print(json.dumps({'dry':dry,'dry_result':json.loads(out.getvalue()),'code':code,'refused':refused_code,'error':error.getvalue()}))
`);
 assert.equal(r.dry,0);assert.equal(r.dry_result.writes,false);assert.equal(r.code,7);assert.equal(r.refused,2);
 assert.ok(!r.error.includes('PRIVATE'));assert.equal(JSON.parse(r.error).publication_authorized,false);
});
