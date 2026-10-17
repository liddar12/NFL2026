import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url);
const ENGINE = process.env.SELFLEARN_CHECKOUT;
test('actual approved pool writer feeds MY cards/journal with preproducer originals, without promoting v1 semantics', (t) => {
  if (!ENGINE || !existsSync(`${ENGINE}/packages/selflearn-core/selflearn_core/store/file_owner_intents.py`)) {
    t.skip('Explicit SELFLEARN_CHECKOUT is required for real producer/shared-kernel integration'); return;
  }
  const r = spawnSync('python3', ['-B', '-'], { cwd: ROOT, encoding: 'utf8', timeout: 120000,
    maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, input: String.raw`
import contextlib,io,json,os,pathlib,shutil,tempfile
from scripts import availability as A,build_leg_pool as B,run_parlay_feedback as F,learning_receipts as L
from scripts import period_my_generation as MY,generation_capture_runtime as C,generation_semantic_gate as G
from scripts import period_operator as O
from scripts.period_calibrator import PeriodCalibrator
from tests.fixtures import period_return as fixture
engine=pathlib.Path(os.environ['SELFLEARN_CHECKOUT']);pin=F.git(engine,'rev-parse','HEAD')
with tempfile.TemporaryDirectory()as tmp:
 fake=object.__new__(PeriodCalibrator);fake.data=pathlib.Path(tmp)/'overlap-checkout/data'
 fake.engine_checkout=pathlib.Path(tmp)/'fake-engine';bad=fake.engine_checkout/'capture'
 try:MY.generate(fake,generation_sha='synthetic',capture_dir=bad);raise AssertionError('capture inside engine allowed')
 except C.CaptureError as e:assert str(e)=='capture_output_overlaps_authority'
 assert not bad.exists()
 root=pathlib.Path(tmp)/'checkout';root.mkdir();data=root/'data'
 shutil.copytree(F.ROOT/'scripts',root/'scripts',ignore=shutil.ignore_patterns('__pycache__'))
 shutil.copytree(F.ROOT/'app',root/'app')
 for relative in C.EXTRA_FIXED-{C.RUNTIME_PATH}:
  target=root/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(F.ROOT/relative,target)
 cfg=root/'config/excluded_games.json';cfg.parent.mkdir(parents=True);shutil.copyfile(F.ROOT/'config/excluded_games.json',cfg)
 fixture.training(data,engine,pin)
 current,schedule,_,_=fixture.inputs(6,'2026-10-16T20:00:00Z',n=6,tag='MY-capture',past=True)
 fixture.write_inputs(data,current,schedule);fixture.write(data/'leg_pool.json',B.build(current))
 # These are frozen eligibility witnesses, not a claim of original provider or
 # earlier weekly-producer reads. The final semantic gate is intentionally NOT
 # complete merely because this actual MY capture/journal join succeeds.
 witness=A.enrich_document({'season':2026,'week':6,'source':'espn','updated_utc':'2026-10-16T19:30:00Z',
  'source_updated_utc':'2026-10-16T19:30:00Z','received_utc':'2026-10-16T19:30:00Z',
  'injuries':[{'team':p['team'],'player':p['name'],'status':'Active'}for p in current['player_projections']['players']]})
 fixture.write(data/'injuries.json',witness)
 now=['2026-10-16T20:01:00Z']
 control=PeriodCalibrator(data_dir=data,engine_checkout=engine,engine_commit=pin,
  authority_id=L.fingerprint('synthetic-MY-local-authority'),actor_ref='synthetic-MY-operator',clock=lambda:now[0])
 oid=control.prepare(season=2026,week=6)
 ack=control.record_intent(oid,action='approve',expires_utc='2026-10-20T00:00:00Z',
  reason='Synthetic original-byte MY mechanics, not actual owner approval',acknowledge_retrospective=True)
 now[0]='2026-10-16T20:02:00Z';private=pathlib.Path(tmp)/'private-originals'
 output=io.StringIO();args=['--data-dir',str(data),'--engine-checkout',str(engine),'--engine-commit',pin,
  '--authority-id',control.authority_id,'--actor-ref',control.actor_ref,'apply-my',
  '--generation-sha','synthetic-MY-code-claim','--capture-dir',str(private)]
 with contextlib.redirect_stdout(output):code=O.main(args,clock=lambda:now[0])
 assert code==0;result=json.loads(output.getvalue())
 assert result['operation']=='apply-my'and result['publication_authorized']is False
 link=json.loads(control.path('generations',result['period_generation_id'][7:]+'.json').read_bytes())
 assert L.fingerprint({k:v for k,v in link.items()if k!='period_generation_id'})==result['period_generation_id']
 _,app,pool=control.current();binding=link['runtime_binding'];inner=binding['binding']
 assert app['application_id']==link['application_id']and app['owner_head_event_id']==ack['event_id']
 assert result['archive_cards']>0 and result['archive_changed']is True
 assert binding['kind']=='nfl.generation_runtime_binding.v1'and inner['capture']['kind']=='nfl.original_generation_inputs.v1'
 assert all(binding['claims'][k]is False for k in C.CLAIMS)
 assert all(link[k]is False for k in('MY_card_semantics_verified','owner_authenticated','publication_authorized',
  'production_authorized','public_serving_verified'))
 assert inner['outputs']['data/leg_pool.json']['raw_utf8'].encode()==(data/'leg_pool.json').read_bytes()
 path='data/my_cards/2026_wk06.json'
 assert inner['outputs'][path]['raw_utf8'].encode()==(root/path).read_bytes()
 assert inner['capture']['inputs']['previous_my_cards']['raw_utf8']=='null'
 assert binding['loader']['read_observations']['injuries']['role']=='eligibility_validation_witness_not_earlier_producer_original'
 private_docs=[json.loads(p.read_bytes())for p in private.glob('*.json')]
 assert {d['kind']for d in private_docs}>={'nfl.generation_loader_observation.v1',
  'nfl.generation_pool_checkpoint.v1','nfl.generation_runtime_binding.v1'}
 # The original gate still holds these v2 receipts: recording actual bytes must
 # never flip a v1 PASS/activation flag or pretend the v2 semantic job is done.
 diagnostic=G.verify_generation(inner,current_input_bytes={n:inner['capture']['inputs'][n]['raw_utf8'].encode()
  for n in G.CURRENT_INPUT_NAMES},current_code_bytes={n:v['raw_utf8'].encode()for n,v in inner['capture']['code'].items()},
  current_output_bytes={n:v['raw_utf8'].encode()for n,v in inner['outputs'].items()},checked_utc=now[0])
 assert diagnostic['supported_consumer_pass']is False and diagnostic['whole_release_pass']is False
 # Recheck actual final files, not matching parsed JSON or a later repair.
 session=C.GenerationCapture(root,binding['loader'],clock=lambda:now[0]);session.last_binding=binding
 MY._unchanged(session)
 raw=(data/'player_weekly.json').read_bytes();(data/'player_weekly.json').write_bytes(raw+b' ')
 try:MY._unchanged(session);raise AssertionError('raw-byte change accepted')
 except ValueError as e:assert str(e)=='period_MY_original_input_changed'
 (data/'player_weekly.json').write_bytes(raw)
 # A changed original BEFORE pricing is refused without creating a new pool or
 # transaction, even when JSON parsing would yield the identical dictionary.
 now[0]='2026-10-16T20:03:00Z';fresh=C.begin(root,generation_sha='synthetic-next-claim',clock=lambda:now[0])
 before=(data/'leg_pool.json').read_bytes();pointer=control.path('current.json').read_bytes()
 (data/'player_weekly.json').write_bytes(raw+b' ')
 try:control.apply_and_save(capture_runtime=fresh,capture_out_dir=private);raise AssertionError('preproducer raw drift accepted')
 except ValueError as e:assert str(e)=='period_return_original_capture_changed'
 assert (data/'leg_pool.json').read_bytes()==before and control.path('current.json').read_bytes()==pointer
 assert not control.path('pending.json').exists();(data/'player_weekly.json').write_bytes(raw)
 try:control.apply_and_save(capture_runtime={},capture_out_dir=private);raise AssertionError('JSON capability accepted')
 except ValueError as e:assert str(e)=='period_return_configured_capture_required'
 # A failed exact-writer checkpoint is unacknowledged, remains unpublished,
 # retains its original preimage and recovers the previous pool/pointer.
 from unittest.mock import patch
 original_files={p:p.read_bytes()for p in data.rglob('*')if p.is_file()}
 archive_before=(root/path).read_bytes();persist=C.persist
 def fail_checkpoint(value,*args,**kwargs):
  if value.get('kind')=='nfl.generation_pool_checkpoint.v1':raise C.CaptureError('generation_capture_unavailable')
  return persist(value,*args,**kwargs)
 now[0]='2026-10-16T20:04:00Z';failed_private=pathlib.Path(tmp)/'failed-private-originals'
 with patch.object(C,'persist',side_effect=fail_checkpoint):
  try:MY.generate(control,generation_sha='synthetic-failed-claim',capture_dir=failed_private);raise AssertionError('failed checkpoint acknowledged')
  except C.CaptureError:pass
 assert control.path('pending.json').exists()and control.path('current.json').read_bytes()==pointer
 assert (root/path).read_bytes()==archive_before and list(failed_private.glob('*.json'))
 with control.journal.lock({'domain':'nfl','task':'nfl.parlay_leg','producer_id':'nfl2026'}):control._recover()
 assert not control.path('pending.json').exists()
 assert all(p.read_bytes()==body for p,body in original_files.items())
 print(json.dumps({'cards':result['archive_cards'],'target':result['target_generation_id'],
  'original_pool_writer_bound':True,'original_archive_writer_bound':True,'private_recovery_records':len(private_docs),
  'v1_semantics_still_held':True,'preproducer_drift_refused':True,'checkpoint_failure_recovered':True,
  'production_authorized':result['production_authorized']}))
` });
  assert.equal(r.status, 0, `${r.error?.code || ''}\n${r.stderr}\n${r.stdout}`);
  const result = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.ok(result.cards > 0);
  assert.equal(result.original_pool_writer_bound, true);
  assert.equal(result.original_archive_writer_bound, true);
  assert.equal(result.v1_semantics_still_held, true);
  assert.equal(result.preproducer_drift_refused, true);
  assert.equal(result.checkpoint_failure_recovered, true);
  assert.equal(result.production_authorized, false);
});
