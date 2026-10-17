import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url);
test('selected bootstrap preserves exact pre-journal cards as unknown while binding every new offered forecast', () => {
  const r = spawnSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8', timeout: 120000,
    maxBuffer: 4 * 1024 * 1024, input: String.raw`
import contextlib,copy,io,json,os,pathlib,shutil,tempfile
from scripts import generation_capture_runtime as C,run_my_generation as R,run_parlay_feedback as F
from scripts import selected_legacy_bootstrap as S,selected_my_publication_gate as G,my_freshness as M
from scripts import build_my_cards as MY,learning_receipts as L,period_my_generation as D
from tests.fixtures import period_eligibility as fixture
os.environ.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_NOSYSTEM='1',GIT_OPTIONAL_LOCKS='0')
def refusal(fn):
 try:fn()
 except Exception as error:return str(error)
 raise AssertionError('invalid bootstrap accepted')
with tempfile.TemporaryDirectory()as tmp:
 area=pathlib.Path(tmp);root=area/'repo';root.mkdir();data=root/'data';data.mkdir()
 shutil.copytree(F.ROOT/'scripts',root/'scripts',ignore=shutil.ignore_patterns('__pycache__'));shutil.copytree(F.ROOT/'app',root/'app')
 for relative in C.EXTRA_FIXED-{C.RUNTIME_PATH}:
  p=root/relative;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(F.ROOT/relative,p)
 f=fixture.make(qb=True);docs=f['docs']
 for name,relative in C._input_paths(2026,6).items():
  if docs[name]is None:continue
  p=root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(docs[name],ensure_ascii=True,indent=2)+'\n')
 (data/'leg_pool.json').write_text(json.dumps(f['pool'],ensure_ascii=True,indent=2)+'\n')
 with contextlib.redirect_stdout(io.StringIO()):
  MY.run(pool_path=str(data/'leg_pool.json'),schedule_path=str(data/'schedule_full.json'),
   calibration_path=str(data/'parlay_backtest.json'),out_dir=str(data/'my_cards'),
   snapshot_dir=str(area/'earlier-unretained-journal'),now=fixture.GENERATED)
 archive=data/'my_cards/2026_wk06.json';previous=json.loads(archive.read_bytes());raw=archive.read_bytes()
 F.git(root,'init','-b','main');F.git(root,'config','user.name','Synthetic');F.git(root,'config','user.email','synthetic@example.invalid')
 F.git(root,'config','gc.auto','0');F.git(root,'config','maintenance.auto','false')
 def commit(message):
  F.git(root,'add','.');F.git(root,'-c','commit.gpgsign=false','commit','-m',message);return F.git(root,'rev-parse','HEAD')
 source=commit('synthetic previously published archive without retained journal')
 private=area/'private';now=['2026-10-16T20:03:00Z']
 opts=dict(data_dir=data,engine_checkout=area/'absent-engine',engine_commit='b'*40,
  authority_id=L.fingerprint('synthetic-no-model-approval'),actor_ref='synthetic',capture_dir=private,
  generation_sha=source,freshness_profile=M.PROFILE,clock=lambda:now[0])
 with contextlib.redirect_stdout(io.StringIO()):result=R.run(**opts)
 wrapper=S.read_artifact(private/result['binding_artifact_name'],checkout=root)
 binding,proof=S.unwrap(wrapper);assert proof and proof['unverified_receipt_ids']
 assert all(v is False for v in binding['claims'].values())
 assert result['runtime_binding_id']==binding['runtime_binding_id']and result['engine_used']is False
 final=commit('new selected generation retains pre-journal rows unchanged')
 check=G.check_selected(wrapper,checkout=root,expected_head=final,base_head=source,clock=lambda:now[0])
 assert check['consumer_check_pass']and check['retained_legacy_scope']['legacy_training_eligible']is False
 newarchive=json.loads(archive.read_bytes());byid={c['card_id']:c for c in newarchive['cards']}
 assert all(byid[c['card_id']]==c for c in previous['cards'])
 assert not set(proof['unverified_receipt_ids']).intersection(binding['binding']['graph']['generations'][-1]['expected_receipt_ids'])
 # The ordinary v1 replay/gate still refuses the same missing old authority.
 strict=refusal(lambda:D.replay_binding(binding,pool_writer='legacy_pretty'))
 assert 'output_receipt_missing_or_conflicting_authority'in strict
 refusals=[]
 forged=copy.deepcopy(wrapper);forged['legacy_preimage']['unverified_receipt_ids'].append(result['target_generation_id'])
 forged=C.gate._seal({k:v for k,v in forged.items()if k!='selected_binding_id'},'selected_binding_id')
 refusals.append(refusal(lambda:G.check_selected(forged,checkout=root,expected_head=final,base_head=source,clock=lambda:now[0])))
 # Even a whole unchanged card cannot bypass a conflicting known authority.
 _,_,allowed=S.verify(wrapper,checkout=root,expected_head=final,base_head=source)
 loc=proof['unverified_locations'][0];card=byid[loc['card_id']];leg=card['legs'][loc['leg_index']]
 wrong=copy.deepcopy(leg['learning_receipt']);wrong['source_snapshot_id']=L.fingerprint('conflict')
 authority={loc['receipt_id']:[{'source':wrong}]}
 failures=refusal(lambda:C.gate.sem._membership({'season':2026,'week':6,'cards':[card]},authority,
  result['target_generation_id'],2026,6,C.gate._time(now[0]),C.gate._time(now[0]),retained_unknown=allowed))
 assert 'output_receipt_missing_or_conflicting_authority'in failures;refusals.append(failures)
 # A competing publication cannot alter an unknown retained card and have the
 # next writer silently choose the old branch.
 archive_raw=archive.read_bytes();changed=copy.deepcopy(newarchive)
 changed['cards'][0]['legs'][0]['selection']='synthetic competing publication text'
 archive.write_text(json.dumps(changed));competing=commit('competing base changes retained whole card')
 archive.write_bytes(archive_raw);restored=commit('restore generated output for comparison')
 refusals.append(refusal(lambda:G.check_selected(wrapper,checkout=root,expected_head=restored,
  base_head=competing,clock=lambda:now[0])))
 # A forged preimage cannot add a new unknown card that was never in source Git.
 fake_loader=copy.deepcopy(binding['loader']);fake=copy.deepcopy(previous);fake['cards'][0]['card_id']='injected-legacy-card'
 cap=fake_loader['capture'];docsbytes={k:v['raw_utf8'].encode()for k,v in cap['inputs'].items()};docsbytes['previous_my_cards']=C.gate.encoded(fake)
 cap=C.gate.capture_inputs(docsbytes,{k:v['raw_utf8'].encode()for k,v in cap['code'].items()},season=2026,week=6,
  captured_utc=cap['captured_utc_claim'],generation_sha=source,policy=cap['policy'])
 fake_loader['capture']=cap
 refusals.append(refusal(lambda:S.prepare(root,fake_loader,committed_head=final)))
 adapter=S.SelectedCapture(None,proof,{'generations':[],'source_objects':[]})
 refusals.append(refusal(lambda:adapter.journal_graph({'generations':[{'receipt_ids':[proof['unverified_receipt_ids'][0]]}]},
  None,None,None,None,None)))
 # Once a real journal is committed, deleting it is never first-run unknown.
 target=data/'snapshots/learning_journal/2026_wk06'/(result['target_generation_id'][7:]+'.json')
 journal=target.read_bytes();target.unlink();deleted=commit('synthetic deleted known journal')
 assert 'learning_history_removed_or_changed'in refusal(lambda:G.check_selected(wrapper,checkout=root,
  expected_head=deleted,base_head=final,clock=lambda:now[0]));target.write_bytes(journal);commit('restore known journal')
 # Direct prepare on the new source includes known journals and catches a
 # missing working counterpart before a second selected generation writes.
 opts['generation_sha']=F.git(root,'rev-parse','HEAD');now[0]='2026-10-16T20:04:00Z'
 loader=C.begin(root,generation_sha=opts['generation_sha'],clock=lambda:now[0]).loader
 target.unlink();refusals.append(refusal(lambda:S.prepare(root,loader)));target.write_bytes(journal)
 print(json.dumps({'unknown_receipts':len(proof['unverified_receipt_ids']),
  'retained_cards':len(previous['cards']),'new_cards':len(newarchive['cards'])-len(previous['cards']),
  'consumer_pass':check['consumer_check_pass'],'v1_still_strict':True,'refusals':refusals}))
` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.ok(out.unknown_receipts > 0 && out.retained_cards > 0);
  assert.equal(out.consumer_pass, true);
  assert.equal(out.v1_still_strict, true);
  assert.match(out.refusals[0], /bootstrap_proof_not_reproduced/);
  assert.match(out.refusals[1], /output_receipt_missing_or_conflicting_authority/);
  assert.match(out.refusals[2], /bootstrap_retained_card_not_exact_publication_base/);
  assert.match(out.refusals[3], /bootstrap_archive_not_exact_source_preimage/);
  assert.match(out.refusals[4], /bootstrap_current_receipt_marked_legacy/);
  assert.match(out.refusals[5], /bootstrap_known_history_removed/);
});
