import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const ROOT = new URL('../..', import.meta.url);
function py(body, timeout = 120000) {
  const result = spawnSync('python3', ['-B', '-'], {cwd: ROOT, encoding: 'utf8',
    timeout, maxBuffer: 4 * 1024 * 1024, input: body});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('referenced known authority never excuses a conflict, missing offer or changed/new card', () => {
  const result = py(String.raw`
import copy,json
from scripts import generation_semantic_gate as G,build_my_cards as MY,learning_journal as J
from tests.fixtures import period_eligibility as F
f=F.make(qb=True);pool=f['pool'];schedule=f['docs']['schedule'];calibration=f['docs']['parlay_calibration']
offered,_=MY.offered_cards(pool,schedule['games'],MY._correlation_table(calibration),F.GENERATED)
records=[MY.card_record(dial,seed,rank,card,MY.kickoff_index(schedule['games']))for dial,seed,rank,card in offered]
journal,snapshots=J.capture(pool,schedule,calibration,records,F.GENERATED)
graph=G.sem._graph({'version':1,'source_objects':[{'version':1,'kind':'source_snapshot','object_id':oid,'payload':doc}for oid,doc in snapshots.items()],
 'generations':[{'request':{'version':1,'kind':'generation','object_id':journal['envelope_id'],'payload':journal},'expected_receipt_ids':sorted(journal['generations'][0]['receipt_ids'])}]})
authority=G.sem.publication._authority(graph,2026,6)
card=copy.deepcopy(next(c for c in records if any(l.get('learning_receipt')for l in c['legs'])))
output={'season':2026,'week':6,'cards':[card]};now=G._time(F.CHECKED)
context={'cards':{card['card_id']:copy.deepcopy(card)},'locations':set(),'known_authority':authority}
target='sha256:'+'1'*64
members,_=G.sem._membership(output,{},target,2026,6,now,now,retained_unknown=context)
assert members and all(m['lineage_class']=='retained_older_display_vintage'for m in members)
index=next(i for i,l in enumerate(card['legs'])if l.get('learning_receipt'));rid=card['legs'][index]['learning_receipt']['receipt_id']
refused=[]
def reject(name,doc,ctx,expected):
 try:G.sem._membership(doc,{},target,2026,6,now,now,retained_unknown=ctx)
 except G.sem.SemanticError as error:
  assert str(error)==expected,(name,str(error));refused.append(name);return
 raise AssertionError('accepted '+name)
bad=copy.deepcopy(context);bad['known_authority'][rid][0]['source']['source_snapshot_id']='sha256:'+'9'*64
bad['locations'].add((card['card_id'],index,rid))
reject('known-conflict-cannot-be-unknown',output,bad,'output_receipt_missing_or_conflicting_authority')
bad=copy.deepcopy(context);bad['known_authority'][rid][0]['offered']={}
reject('known-receipt-never-offered',output,bad,'output_receipt_not_offered_for_card')
changed=copy.deepcopy(output);changed['cards'][0]['card_id']='new-card-cannot-borrow-history'
reject('new-card-borrow',changed,context,'output_receipt_missing_or_conflicting_authority')
changed=copy.deepcopy(output);changed['cards'][0]['legs'][index]['selection']='changed retained display'
reject('changed-whole-card-borrow',changed,context,'output_receipt_missing_or_conflicting_authority')
print(json.dumps({'known_exact_supported':True,'refused':refused}))
`);
  assert.equal(result.known_exact_supported, true);
  assert.equal(result.refused.length, 4);
});

const FIXTURE = String.raw`
import contextlib,copy,io,json,os,pathlib,shutil,tempfile
from scripts import generation_capture_runtime as C,run_my_generation as R,run_parlay_feedback as F
from scripts import selected_legacy_bootstrap as S,selected_my_publication_gate as G,my_freshness as M
from scripts import build_my_cards as MY,learning_receipts as L
from tests.fixtures import period_eligibility as fixture
os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
def setup(tmp,prejournal):
 area=pathlib.Path(tmp);root=area/'repo';root.mkdir();data=root/'data';data.mkdir()
 shutil.copytree(F.ROOT/'scripts',root/'scripts',ignore=shutil.ignore_patterns('__pycache__'));shutil.copytree(F.ROOT/'app',root/'app')
 for relative in C.EXTRA_FIXED-{C.RUNTIME_PATH}:
  p=root/relative;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(F.ROOT/relative,p)
 f=fixture.make(qb=True);docs=f['docs']
 for name,relative in C._input_paths(2026,6).items():
  if docs[name]is None:continue
  p=root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(docs[name],ensure_ascii=True,indent=2)+'\n')
 (data/'leg_pool.json').write_text(json.dumps(f['pool'],ensure_ascii=True,indent=2)+'\n')
 if prejournal:
  with contextlib.redirect_stdout(io.StringIO()):
   MY.run(pool_path=str(data/'leg_pool.json'),schedule_path=str(data/'schedule_full.json'),
    calibration_path=str(data/'parlay_backtest.json'),out_dir=str(data/'my_cards'),
    snapshot_dir=str(area/'earlier-unretained-journal'),now=fixture.GENERATED)
 F.git(root,'init','-b','main');F.git(root,'config','user.name','Synthetic');F.git(root,'config','user.email','synthetic@example.invalid')
 F.git(root,'config','gc.auto','0');F.git(root,'config','maintenance.auto','false')
 return area,root,data
def commit(root,message):
 F.git(root,'add','.');F.git(root,'-c','commit.gpgsign=false','commit','-m',message);return F.git(root,'rev-parse','HEAD')
def generate(area,root,data,source,clock,label):
 private=area/('private-'+label)
 with contextlib.redirect_stdout(io.StringIO()):
  result=R.run(data_dir=data,engine_checkout=area/'absent-engine',engine_commit='b'*40,
   authority_id=L.fingerprint('synthetic-no-model-approval'),actor_ref='synthetic',capture_dir=private,
   generation_sha=source,freshness_profile=M.PROFILE,clock=lambda:clock)
 return result,S.read_artifact(private/result['binding_artifact_name'],checkout=root)
`;

test('a strict first publication followed by three known-only refreshes retains exact Git authority', () => {
  const result = py(FIXTURE + String.raw`
with tempfile.TemporaryDirectory()as tmp:
 area,root,data=setup(tmp,False);source=commit(root,'synthetic first-run source without archive')
 first,wrapper=generate(area,root,data,source,'2026-10-16T20:03:00Z','first')
 assert wrapper['kind']=='nfl.generation_runtime_binding.v1'
 assert first['engine_used']is False and first['model_approval_recorded']is False
 source=commit(root,'actual strict first publication')
 unknown=[]
 for index in range(3):
  now='2026-10-16T20:%02d:00Z'%(4+index)
  result,wrapper=generate(area,root,data,source,now,str(index))
  assert wrapper['kind']==S.REFERENCED_KIND
  binding,proof=S.unwrap(wrapper)
  assert len(binding['binding']['graph']['generations'])==1
  assert proof['known_journals']==index+1
  assert proof['unverified_receipt_ids']==[] and proof['unverified_locations']==[]
  assert all(wrapper[k]is False for k in S.FLAGS)
  base=source;source=commit(root,'known-only referenced refresh '+str(index))
  check=G.check_selected(wrapper,checkout=root,expected_head=source,base_head=base,clock=lambda:now)
  assert check['consumer_check_pass']is True and check['engine_used']is False
  unknown.append(len(proof['unverified_receipt_ids']))
 print(json.dumps({'known_only_refreshes':len(unknown),'unknown_counts':unknown,'first_v1_unchanged':True}))
`);
  assert.equal(result.first_v1_unchanged, true);
  assert.equal(result.known_only_refreshes, 3);
  assert.deepEqual(result.unknown_counts, [0, 0, 0]);
});

test('the final selected gate refuses deletion of fetched-base-only cards and run rows', () => {
  const result = py(FIXTURE + String.raw`
with tempfile.TemporaryDirectory()as tmp:
 area,root,data=setup(tmp,True);source=commit(root,'synthetic original published archive')
 now='2026-10-16T20:03:00Z';result,wrapper=generate(area,root,data,source,now,'target')
 original_final=commit(root,'actual new generation')
 assert G.check_selected(wrapper,checkout=root,expected_head=original_final,base_head=source,clock=lambda:now)['consumer_check_pass']is True
 path=data/'my_cards/2026_wk06.json';generated_raw=path.read_bytes();refused=[]
 for kind in('card','run','duplicate-run'):
  archive=json.loads(generated_raw)
  if kind=='card':
   concurrent=copy.deepcopy(archive['cards'][-1]);concurrent['card_id']='synthetic-concurrent-published-card'
   archive['cards'].append(concurrent)
  else:
   concurrent=copy.deepcopy(archive['runs'][-1])
   if kind=='run':concurrent['pool_generated_utc']='2026-10-16T20:02:30Z'
   archive['runs'].append(concurrent)
  path.write_text(json.dumps(archive,ensure_ascii=True,indent=2)+'\n')
  base=commit(root,'competing publication adds retained '+kind)
  path.write_bytes(generated_raw);final=commit(root,'candidate final tree wrongly drops competing '+kind)
  try:G.check_selected(wrapper,checkout=root,expected_head=final,base_head=base,clock=lambda:now)
  except Exception as error:
   assert 'reference_'in str(error),str(error);refused.append(kind)
  else:raise AssertionError('selected final gate accepted deletion of fetched-base-only '+kind)
 print(json.dumps({'base_only_deletions_refused':refused}))
`);
  assert.deepEqual(result.base_only_deletions_refused, ['card', 'run', 'duplicate-run']);
});
