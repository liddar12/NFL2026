import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renderAsOfferedRecord, renderParlaySummary } from '../../app/review.js';

const root = new URL('../../', import.meta.url);
const setup = `
import copy, json
from scripts import as_offered_record as ar
g1={'game_id':'g1','home':'AAA','away':'BBB','kickoff_utc':'2026-10-11T18:00:00Z',
    'status':'STATUS_FINAL','final':{'home_score':21,'away_score':14,'winner':'AAA'}}
g2={'game_id':'g2','home':'CCC','away':'DDD','kickoff_utc':'2026-10-11T20:00:00Z',
    'status':'STATUS_FINAL','final':{'home_score':10,'away_score':7,'winner':'CCC'}}
def leg(team): return {'market':'moneyline','selection':team+' ML'}
def card(pid,scope,legs,gid=None):
    return {'parlay_id':pid,'scope':scope,'legs':legs,**({'game_id':gid} if gid else {})}
def snap(sha,stamp,cards):
    return {'sha':sha,'committed_utc':stamp,'path':'data/parlays.json',
            'document':{'season':2026,'week':5,'updated_utc':stamp,'parlays':cards}}
old=[card('g1-first','game',[leg('AAA')],'g1'),card('g2-first','game',[leg('CCC')],'g2'),
     card('week-first','week',[leg('AAA'),leg('CCC')])]
later=[card('g1-late','game',[leg('BBB')],'g1'),card('g2-latest','game',[leg('DDD')],'g2'),
       card('week-late','week',[leg('BBB'),leg('DDD')])]
history={'status':'available','head':'head','snapshots':[
 snap('before','2026-10-11T17:00:00Z',old),snap('between','2026-10-11T19:00:00Z',later)],'exclusions':[]}
review={'season':2026,'weeks':{'5':{'games':[g1,g2],'parlays':[]}}}
`;
const py = (body) => JSON.parse(execFileSync('python3', ['-c', setup + body], {
  cwd: root, encoding: 'utf8', timeout: 120000,
}));

test('real cutoffs pick each Game vintage and first-kickoff Week vintage, not first_seen', () => {
  const r = py(`
history['snapshots'].append(snap('after','2026-10-11T21:00:00Z',old))
for c in history['snapshots'][-1]['document']['parlays']: c['first_seen_utc']='2026-01-01T00:00:00Z'
out=ar.build_record(review,history)['weeks']['5']
reverse=ar.build_record(review,{**history,'snapshots':list(reversed(history['snapshots']))})['weeks']['5']
print(json.dumps({'out':out,'stable':out==reverse}))
`);
  assert.equal(r.stable, true);
  assert.equal(r.out.provenance_status, 'available');
  assert.deepEqual(r.out.cards.map(c => c.parlay_id), ['g1-first', 'g2-latest', 'week-first']);
  assert.deepEqual(r.out.cards.map(c => c.provenance.sha), ['before', 'between', 'before']);
  assert.equal(r.out.headline.successful_cards, 2);
  assert.equal(r.out.headline.decided_cards, 3);
  assert.equal(r.out.headline.full_hits, 2);
  assert.equal(r.out.public_serving_verified, false);
});

test('independent hand oracle separates full/reduced/refund/loss/pending and leg denominator', () => {
  const s = py(`
cards=[{'legs':[{'result':r} for r in rs]} for rs in
       [['hit','hit'],['hit','void'],['void','void'],['miss','pending'],['hit','pending']]]
print(json.dumps(ar.outcome_counts(cards)))
`);
  assert.deepEqual([s.full_hits, s.reduced_successes, s.refunds, s.losses, s.pending], [1, 1, 1, 1, 1]);
  assert.equal(s.cards, 5);
  assert.equal(s.successful_cards, 2);
  assert.equal(s.decided_cards, 3);
  assert.deepEqual(s.legs, { hit: 4, miss: 1, void: 3, pending: 2 });
  assert.equal(s.decided_legs, 5);
  assert.equal(s.leg_hit_rate, 0.8);
});

test('ledger void outranks retrospective miss; missing rows may use explicit review fallback; FINAL gate wins', () => {
  const r = py(`
prop={'market':'wr_rec_yds','selection':'R. Rice 60+ rec yds'}
review['weeks']['5']['parlays']=[{'legs':[{**prop,'game_id':'g1','result':'miss','actual':0}]}]
scores={'unresolved':[{'week':5,'game_id':'g1',**prop,'reason':'no_stat_line'}]}
ledger,fallback=ar.grade_context(review,scores)
a=ar.grade_leg(prop,'g1',5,g1,ledger,fallback)
b=ar.grade_leg(prop,'g1',5,g1,{},fallback)
c=ar.grade_leg(prop,'g1',5,{**g1,'status':'STATUS_IN_PROGRESS'},ledger,fallback)
ledger[ar._key(5,'g1',prop)].append(('hit',90,None))
d=ar.grade_leg(prop,'g1',5,g1,ledger,fallback)
print(json.dumps([a,b,c,d]))
`);
  assert.deepEqual(r.map(x => x.result), ['void', 'miss', 'pending', 'pending']);
  assert.equal(r[0].source, 'leg_ledger');
  assert.equal(r[1].source, 'review_fallback');
  assert.equal(r[3].reason, 'conflicting_outcomes');
});

test('spread/ML grade actual FINAL scores without administrative exclusions or missing-score invention', () => {
  const r = py(`
items=[{'market':'spread','selection':'AAA -7'}, {'market':'spread','selection':'BBB +6.5'},leg('AAA')]
result=[ar.grade_leg(l,'g1',5,g1,{}, {}) for l in items]
result.append(ar.grade_leg(leg('AAA'),'g1',5,{**g1,'final':{'winner':None}}, {}, {}))
result.append(ar.grade_leg({'market':'spread','selection':'AAA -7'},'g1',5,
              {**g1,'final':{'winner':'AAA'}}, {}, {}))
print(json.dumps(result))
`);
  assert.deepEqual(r.map(x => x.result), ['void', 'miss', 'hit', 'pending', 'pending']);
});

test('shared FINAL and overtime statuses grade all markets; unfinished games never enter decided denominators', () => {
  const r = py(`
items=[leg('AAA'),leg('BBB'),
       {'market':'spread','selection':'AAA -7'},
       {'market':'spread','selection':'BBB +6.5'},
       {'market':'spread','selection':'AAA -6.5'},
       {'market':'qb_pass_yds','selection':'Q. One 200+ pass yds'},
       {'market':'rb_rush_yds','selection':'R. One 60+ rush yds'},
       {'market':'wr_rec_yds','selection':'W. One 40+ rec yds'}]
scores={'resolved':[{'week':5,'game_id':'g1',**items[5],'hit':True,'actual':220},
                    {'week':5,'game_id':'g1',**items[6],'hit':False,'actual':50}],
        'unresolved':[{'week':5,'game_id':'g1',**items[7],'reason':'no_stat_line'}]}
ledger,fallback=ar.grade_context(review,scores)
def graded(status,final=g1['final']):
 rows=[ar.grade_leg(l,'g1',5,{**g1,'status':status,'final':final},ledger,fallback) for l in items]
 return {'rows':rows,'summary':ar.outcome_counts([{'legs':[row]} for row in rows])}
print(json.dumps({'finals':[graded(s) for s in ('STATUS_FINAL','STATUS_FINAL_OVERTIME')],
 'unfinished':[graded(s) for s in ('STATUS_IN_PROGRESS','STATUS_HALFTIME','STATUS_SCHEDULED',
                                  'STATUS_POSTPONED','STATUS_END_REGULATION',None)],
 'missing_final':graded('STATUS_FINAL_OVERTIME',{})}))
`);
  for (const group of r.finals) {
    assert.deepEqual(group.rows.map(x => x.result), ['hit', 'miss', 'void', 'miss', 'hit', 'hit', 'miss', 'void']);
    assert.deepEqual(group.rows.slice(5).map(x => x.source), ['leg_ledger', 'leg_ledger', 'leg_ledger']);
    assert.deepEqual([group.summary.full_hits, group.summary.losses, group.summary.refunds,
      group.summary.decided_cards, group.summary.decided_legs], [3, 3, 2, 6, 6]);
  }
  for (const group of [...r.unfinished, r.missing_final]) {
    assert.ok(group.rows.every(x => x.result === 'pending' && x.reason === 'no_final_evidence'));
    assert.equal(group.summary.decided_cards, 0);
    assert.equal(group.summary.decided_legs, 0);
  }
});

test('read-only direct CLI still imports the shared final-status contract', () => {
  const help = execFileSync('python3', ['scripts/as_offered_record.py', '--help'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  assert.match(help, /--repo/);
  assert.match(help, /--ref/);
});

test('post-kickoff exclusion flagged without rewriting original cohort; settlement separately preserved', () => {
  const r = py(`
excluded={'games':[{'game_id':'g1','added_utc':'2026-10-11T17:00:00Z','reason':'owner'}]}
history['exclusions']=[{'sha':'ex','committed_utc':'2026-10-11T18:05:00Z','document':excluded}]
review['weeks']['5']['parlays']=[{'scope':'game','legs':[{'result':'void'}]}]
print(json.dumps(ar.build_record(review,history,exclusions=excluded)['weeks']['5']))
`);
  assert.equal(r.cards[0].legs[0].result, 'hit');
  assert.equal(r.cards[0].legs[0].exclusion.post_kickoff, true);
  assert.equal(r.cards[0].legs[0].exclusion.sha, 'ex');
  assert.equal(r.settlement.summary.all.refunds, 1);
  assert.equal(r.headline.full_hits, 2);
});

test('shallow/missing/conflicting/late/deleted history never becomes a prospective headline', () => {
  const rows = py(`
cases=[{'status':'unavailable','reason':'shallow_history'}, {**history,'snapshots':[]}]
conflict=copy.deepcopy(history);conflict['snapshots'].append(snap('other','2026-10-11T17:00:00Z',later));cases.append(conflict)
late=copy.deepcopy(history);late['snapshots'][0]['document']['updated_utc']='2026-10-11T18:01:00Z';cases.append(late)
deleted=copy.deepcopy(history);deleted['snapshots'].append({'sha':'deleted','committed_utc':'2026-10-11T17:30:00Z','document':None});cases.append(deleted)
print(json.dumps([ar.build_record(review,h)['weeks']['5'] for h in cases]))
`);
  for (const row of rows) assert.equal(row.headline, null);
  assert.equal(rows[0].provenance_status, 'unavailable');
  assert.ok(rows[2].coverage.missing.some(x => x.reason === 'conflicting_latest_blobs'));
  assert.ok(rows[4].coverage.missing.some(x => x.reason === 'latest_blob_missing_or_wrong_week'));
});

test('wrong/unknown leg game cutoff cannot inherit the parent card pregame proof', () => {
  const r = py(`
history['snapshots'][1]['document']['parlays'][1]['legs'][0]['game_id']='g1'
out=ar.build_record(review,history)['weeks']['5']
print(json.dumps(out))
`);
  assert.equal(r.headline, null);
  assert.ok(r.coverage.missing.some(x => x.reason === 'leg_cutoff_not_verified'));
});

test('Git reader uses actual commit times and refuses a shallow clone (temporary repositories only)', () => {
  const r = py(`
import tempfile, pathlib, os, subprocess
with tempfile.TemporaryDirectory(prefix='r130-test-') as tmp:
 repo=pathlib.Path(tmp)/'full';repo.mkdir()
 def git(*args,env=None):return subprocess.check_output(['git',*args],cwd=repo,env=env,stderr=subprocess.PIPE,text=True)
 git('init');git('config','user.name','R130 fixture');git('config','user.email','fixture@example.test')
 (repo/'data').mkdir()
 for stamp,cards in [('2026-10-11T17:00:00Z',old),('2026-10-11T21:00:00Z',later)]:
  (repo/'data/parlays.json').write_text(json.dumps({'season':2026,'week':5,'updated_utc':stamp,'parlays':cards}))
  git('add','data/parlays.json');git('commit','-m','fixture',env={**os.environ,'GIT_AUTHOR_DATE':stamp,'GIT_COMMITTER_DATE':stamp})
 evidence=ar.read_git_history(repo)
 out=ar.build_record(review,evidence)['weeks']['5']
 shallow=pathlib.Path(tmp)/'shallow'
 subprocess.check_output(['git','clone','--depth=1',repo.as_uri(),str(shallow)],stderr=subprocess.PIPE)
 print(json.dumps({'status':evidence['status'],'snapshots':len(evidence['snapshots']),
                   'ids':[c['parlay_id'] for c in out['cards']], 'shallow':ar.read_git_history(shallow)}))
`);
  assert.equal(r.status, 'available');
  assert.equal(r.snapshots, 2);
  assert.deepEqual(r.ids, ['g1-first', 'g2-first', 'week-first']);
  assert.equal(r.shallow.reason, 'shallow_history');
});

test('real review producer adds the separate contract without changing settlement summaries', () => {
  const r = py(`
from scripts import build_review as br
from scripts.validate_data import validate_against_schema
inputs=br._fixture_inputs()
before=br.build(inputs,'2026-09-20T12:00:00Z')
after=br.build({**inputs,'as_offered_history':{'status':'unavailable','reason':'shallow_history'}},'2026-09-20T12:00:00Z')
schema=json.load(open('data/contracts/review.schema.json'))
validate_against_schema(after,schema,'R130')
same=all(before['weeks'][w]['summary']==after['weeks'][w]['summary'] and before['weeks'][w]['parlays']==after['weeks'][w]['parlays'] for w in before['weeks'])
print(json.dumps({'same':same,'statuses':[w['as_offered']['provenance_status'] for w in after['weeks'].values()]}))
`);
  assert.equal(r.same, true);
  assert.ok(r.statuses.every(x => x === 'unavailable'));
});

test('UI labels evidence and denominators, never presents legacy 16/18 as prospective', () => {
  const record = py("print(json.dumps(ar.build_record(review,history)['weeks']['5']))");
  const html = renderAsOfferedRecord(record);
  assert.match(html, /2\/3 successful \(2 full-contract wins \+ 0 reduced-leg successes\)/);
  assert.match(html, /Public serving is not verified/);
  const legacy = renderParlaySummary(1, { parlays: { n: 18, hit: 16, legs_hit: 79, legs_n: 81 } });
  assert.match(legacy, /PRE-KICKOFF RECORD UNAVAILABLE/);
  assert.match(legacy, /LEGACY SETTLEMENT/);
  assert.doesNotMatch(legacy, /PRE-KICKOFF · ALL CURATED/);
  const unavailable = renderAsOfferedRecord({ ...record, provenance_status: 'partial' });
  assert.doesNotMatch(unavailable, /2\/3/);
});

test('frozen historical settlement oracle and honest repository history availability', () => {
  const r = py(`
import os,subprocess
root=os.environ.get('R130_FULL_HISTORY_REPO','.')
history=ar.read_git_history(root,'32c5bfbe')
try:
 def frozen(path):return json.loads(subprocess.check_output(['git','show','32c5bfbe:'+path],cwd=root,stderr=subprocess.PIPE))
 out=ar.build_record(frozen('data/review.json'),history,frozen('data/parlay_leg_scores.json'),frozen('config/excluded_games.json'))
 print(json.dumps({'frozen':True,'history':history['status'],'reason':history.get('reason'),
  'weeks':{w:{'headline':b['headline'],'summary':b['summary'],'settlement':b['settlement']} for w,b in out['weeks'].items() if int(w)<=5}}))
except subprocess.CalledProcessError:
 print(json.dumps({'frozen':False,'history':history['status'],'reason':history.get('reason')}))
`);
  if (!r.frozen) {
    assert.equal(r.history, 'unavailable', 'a checkout missing the fixed ref cannot claim recovery');
    assert.equal(r.reason, 'history_unreadable');
    return;
  }
  const w5 = r.weeks['5'].settlement.summary;
  assert.deepEqual([w5.week.full_hits, w5.week.reduced_successes, w5.week.losses, w5.week.cards], [1, 3, 19, 23]);
  assert.deepEqual([w5.all.successful_cards, w5.all.decided_cards], [16, 65]);
  if (r.history === 'available') {
    assert.deepEqual(Object.values(r.weeks).map(w => [w.headline.successful_cards, w.headline.decided_cards]),
      [[17, 66], [13, 66], [21, 66], [22, 65], [14, 63]]);
  } else {
    assert.equal(r.reason, 'shallow_history');
    assert.ok(Object.values(r.weeks).every(w => w.headline === null));
  }
});
