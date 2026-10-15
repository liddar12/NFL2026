import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = String.raw`
import copy, csv, hashlib, io, json, pathlib, tempfile
from scripts import capture_outcome_evidence as CE
from scripts import resolve_parlay_legs as RL, resolve_my_cards as RM, build_bet_facts as BF
NOW='2026-10-19T01:00:00Z'
GAMES=[
 {'game_id':'F','week':6,'home':'SEA','away':'LAR','kickoff_utc':'2026-10-18T17:00:00Z','status':'STATUS_FINAL'},
 {'game_id':'O','week':6,'home':'BUF','away':'KC','kickoff_utc':'2026-10-18T17:00:00Z','status':'STATUS_FINAL_OVERTIME'},
 {'game_id':'L','week':6,'home':'BAL','away':'CIN','kickoff_utc':'2026-10-18T23:20:00Z','status':'STATUS_IN_PROGRESS'},
 {'game_id':'S','week':6,'home':'SF','away':'DAL','kickoff_utc':'2026-10-20T00:15:00Z','status':'STATUS_SCHEDULED'},
 {'game_id':'D','week':6,'home':'PIT','away':'NE','kickoff_utc':'2026-10-18T17:00:00Z','status':'STATUS_FINAL'},
 {'game_id':'N','week':6,'home':'MIN','away':'DET','kickoff_utc':'2026-10-18T17:00:00Z','status':'STATUS_FINAL'},
]
PLAYERS={'F':('Final Receiver','SEA'),'O':('Zero Receiver','BUF'),
         'L':('Live Receiver','BAL'),'S':('Future Receiver','SF'),
         'D':('Absent Receiver','PIT'),'N':('Unknown Receiver','MIN')}
def raw_event(game):
    return {'id':game['game_id'],'date':game['kickoff_utc'],
      'status':{'type':{'name':game['status']}},
      'competitions':[{'competitors':[
        {'homeAway':'home','team':{'abbreviation':game['home']},'score':'24'},
        {'homeAway':'away','team':{'abbreviation':game['away']},'score':'17'}]}]}
def stat(name,team,value,week=6,pos='WR'):
    return {'season':'2026','week':str(week),'season_type':'REG','position':pos,
      'team':team,'player_display_name':name,'passing_yards':'0','rushing_yards':'0',
      'receiving_yards':str(value),'rushing_tds':'0','receiving_tds':'1'}
STATS=[stat('Final Receiver','SEA',70),stat('Live Receiver','BAL',90),
       stat('Future Receiver','SF',100),stat('Unknown Receiver','MIN','NA'),
       stat('Other Quarterback','KC',0,pos='QB'),stat('Earlier Receiver','SEA',55,week=5)]
SNAPS=[{'season':'2026','week':'6','game_type':'REG','team':team,
        'player':name,'offense_snaps':'40'} for gid,(name,team) in PLAYERS.items() if gid!='D']
SNAPS.append({'season':'2026','week':'6','game_type':'REG','team':'PIT',
              'player':'Other Steeler','offense_snaps':'40'})
def csv_bytes(rows):
    stream=io.StringIO(newline='')
    writer=csv.DictWriter(stream,fieldnames=list(rows[0]))
    writer.writeheader(); writer.writerows(rows)
    return stream.getvalue().encode()
def make_capture(directory,weeks=(6,),events=None):
    calls=[]
    def fetch(spec):
        calls.append(spec['profile'])
        if spec['profile']==CE.SCOREBOARD_PROFILE:
            data={'season':{'year':2026},'week':{'number':spec['week']},
                  'events':events if events is not None else [raw_event(g) for g in GAMES]}
            return 200,{},json.dumps(data).encode()
        return 200,{},csv_bytes(STATS if spec['profile']==CE.STATS_PROFILE else SNAPS)
    bundle=CE.capture(2026,list(weeks),fetcher=fetch,clock=lambda:NOW,sleep=lambda _:None)
    return CE.save_capture(bundle,directory),bundle,calls
def leg(game_id,market='wr_rec_yds',week=6):
    game=next(g for g in GAMES if g['game_id']==game_id); name,team=PLAYERS[game_id]
    value={'season':2026,'week':week,'game_id':game_id,'home':game['home'],'away':game['away'],
      'gsis_id':'fixture-'+game_id,'market':market,'position':'WR','player':name,'team':team,
      'side':'home','direction':'over','comparison_operator':'gte','selection':name+' 40+ rec yds',
      'line':39.5,'model_prob':.7,'p_team':.6,'mu':60.0,'locked':True}
    if market=='moneyline': value.update(selection=team+' ML',line=None)
    if market=='anytime_td': value.update(selection=name+' anytime TD',line=None)
    return value
def card(game_id,atd=False,week=6):
    value=RM._card(game_id+('-td' if atd else '-prop'),'even',
      [leg(game_id,'anytime_td' if atd else 'wr_rec_yds',week),leg(game_id,'moneyline',week)],
      model=.49,n_legs=2)
    value['seed']=PLAYERS[game_id][1]
    return value
def write_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(value))
def prepare(directory):
    data=directory/'sports'; data.mkdir(); cards=data/'my_cards'; cards.mkdir()
    ledger=data/'ledger.json'
    write_json(ledger,{'season':2026,'legs':[leg(g['game_id']) for g in GAMES]})
    write_json(cards/'2026_wk06.json',{'season':2026,'week':6,
      'cards':[card(g['game_id'],atd) for g in GAMES for atd in (False,True)]})
    schedule=data/'schedule.json'
    future={'game_id':'week7','week':7,'home':'ARI','away':'ATL','kickoff_utc':'2026-10-25T17:00:00Z'}
    write_json(schedule,{'season':2026,'games':GAMES+[future]})
    projection=data/'projections.json'
    write_json(projection,{'players':[{'gsis_id':'fixture-'+gid,'name':name,
      'position':'WR','team':team} for gid,(name,team) in PLAYERS.items()]})
    pool=data/'pool.json'; write_json(pool,{'players':[]})
    outputs=directory/'outputs'; outputs.mkdir()
    RL.ledger_path=lambda season:str(ledger)
    RM.owner_excluded=lambda excluded=None:set() if excluded is None else set(excluded)
    BF.DATA=str(data); BF.SCHEDULE_PATH=str(schedule); BF.PROJ_PATH=str(projection); BF.POOL_PATH=str(pool)
    BF.OUT_PATH=str(outputs/'facts.json')
    BF.recorded_legs=lambda:[leg(g['game_id']) for g in GAMES]
    BF.excluded_ids=lambda:set()
    return data,cards,ledger,outputs,schedule
def no_refetch():
    def blocked(*args,**kwargs): raise AssertionError('consumer attempted network or legacy-source fallback')
    for module in (RL,RM,BF): module.load_finals=blocked; module.fetch_csv=blocked
    RM._snaps=blocked; BF._snaps=blocked; CE.http_fetcher=blocked
def previous_facts(week=5):
    return {'kind':'bet_facts','season':2026,'generated_utc':'2026-10-12T00:00:00Z',
      'rule':BF.RULE,'source':'previous immutable fixture','excluded':[],
      'weeks':{str(week):{'games':{'old':{'h':'SEA','a':'LAR','k':'2026-10-11T17:00:00Z','hs':24,'as':17}},
                         'players':{'old':{'y':[0,0,55],'td':0}}}}}
`;

function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    input: FIXTURE + '\n' + body,
  }).trim().split('\n').pop());
}

test('three consumers replay one immutable capture without refetch or legacy fallback', () => {
  const result = py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); cap,bundle,calls=make_capture(root/'capture')
    data,cards,ledger,outputs,schedule=prepare(root)
    sources={p:hashlib.sha256(p.read_bytes()).hexdigest()
      for p in list(data.rglob('*'))+list((root/'capture').rglob('*')) if p.is_file()}
    no_refetch()
    r=RL.run(season=2026,evidence_capture=str(cap),out_path=str(outputs/'legs.json'),now=NOW)
    m=RM.run(season=2026,evidence_capture=str(cap),cards_dir=str(cards),out_path=str(outputs/'my.json'),now=NOW)
    f=BF.run(evidence_capture=str(cap),out_path=BF.OUT_PATH,now=NOW)
    assert BF.run(evidence_capture=str(cap),out_path=BF.OUT_PATH,now=NOW)==f
    assert all(hashlib.sha256(p.read_bytes()).hexdigest()==digest for p,digest in sources.items())
    print(json.dumps({'r':r,'m':m,'f':f,'capture_id':bundle['manifest']['capture_id'],'calls':calls}))
`);
  assert.deepEqual(result.calls, ['espn_scoreboard_v1', 'nflverse_stats_player_v1', 'nflverse_snap_counts_v1']);
  for (const source of [result.r.source, result.r.finals_source, result.m.source, result.m.finals_source, result.f.source]) {
    assert.ok(source.includes(result.capture_id));
  }
  assert.deepEqual(result.r.resolved.map(row => row.game_id), ['F']);
  assert.ok(result.r.unresolved.some(row => row.game_id === 'L' && row.reason === 'game_not_final'));
  assert.ok(result.r.unresolved.some(row => row.game_id === 'S' && row.reason === 'game_not_final'));
  assert.equal(result.m.cards.some(row => row.card_id.startsWith('L-') || row.card_id.startsWith('S-')), false);
  assert.equal(result.m.cards.find(row => row.card_id === 'F-prop').result, 'hit');
  assert.equal(result.m.cards.find(row => row.card_id === 'F-td').result, 'hit');
  assert.equal(result.m.cards.find(row => row.card_id === 'O-prop').result, 'miss');
  assert.equal(result.m.cards.find(row => row.card_id === 'D-prop').result, 'void');
  assert.equal(result.m.cards.some(row => row.card_id === 'N-prop'), false);
  const facts = result.f.weeks['6'];
  assert.deepEqual(facts.players['fixture-F'].y, [0, 0, 70]);
  assert.deepEqual(facts.players['fixture-O'].y, [0, 0, 0]);
  assert.equal(facts.players['fixture-D'].y, 'dnp');
  assert.equal(facts.players['fixture-L'], undefined);
  assert.equal(facts.players['fixture-S'], undefined);
  assert.equal(facts.players['fixture-N'].y, null);
  assert.equal(facts.games.O.hs, 24, 'FINAL_OVERTIME remains score-eligible');
  assert.equal(facts.games.L.hs, undefined);
  assert.equal(facts.games.S.hs, undefined);
  assert.equal(result.f.weeks['7'], undefined, 'future schedule does not require future captures');
});

test('missing locked ledger/card weeks rejects before replacing either score aggregate', () => {
  const result = py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); cap,_,_=make_capture(root/'capture')
    data,cards,ledger,outputs,_=prepare(root); no_refetch()
    write_json(ledger,{'season':2026,'legs':[leg('F',week=5)]})
    write_json(cards/'2026_wk05.json',{'season':2026,'week':5,'cards':[card('F',week=5)]})
    errors=[]
    for name,call in [('legs',lambda out:RL.run(season=2026,evidence_capture=str(cap),out_path=str(out))),
      ('my',lambda out:RM.run(season=2026,evidence_capture=str(cap),cards_dir=str(cards),out_path=str(out)))]:
        out=outputs/(name+'.json'); out.write_bytes(b'previous aggregate evidence')
        try: call(out)
        except ValueError as error: errors.append(str(error))
        else: raise AssertionError('missing locked history accepted')
        assert out.read_bytes()==b'previous aggregate evidence'
    print(json.dumps(errors))
`);
  assert.equal(result.length, 2);
  assert.ok(result.every(message => message.includes('missing required weeks: [5]')));
});

test('facts coverage preserves previous actual weeks, started weeks and original card locks', () => {
  const result = py(String.raw`
results=[]
for cause in ('previous','started','locked'):
  with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); cap,_,_=make_capture(root/'capture')
    data,cards,ledger,outputs,schedule=prepare(root); no_refetch()
    if cause=='previous': write_json(pathlib.Path(BF.OUT_PATH),previous_facts())
    elif cause=='started':
        doc=json.loads(schedule.read_text()); doc['games'].append(
          {'game_id':'old','week':5,'home':'ARI','away':'ATL','kickoff_utc':'2026-10-11T17:00:00Z'})
        write_json(schedule,doc)
    else: write_json(cards/'2026_wk05.json',{'season':2026,'week':5,'cards':[card('F',week=5)]})
    out=pathlib.Path(BF.OUT_PATH); before=out.read_bytes() if out.exists() else None
    try: BF.run(evidence_capture=str(cap),out_path=str(out),now=NOW)
    except ValueError as error: results.append(str(error))
    else: raise AssertionError('incomplete historical facts accepted')
    assert (out.read_bytes() if out.exists() else None)==before
print(json.dumps(results))
`);
  assert.equal(result.length, 3);
  assert.ok(result.every(message => message.includes('missing required weeks: [5]')));
});

test('malformed prior facts and season mismatches fail closed before writes', () => {
  const result = py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); cap,_,_=make_capture(root/'capture')
    data,cards,ledger,outputs,schedule=prepare(root); no_refetch()
    out=pathlib.Path(BF.OUT_PATH); out.write_bytes(b'not JSON')
    try: BF.run(evidence_capture=str(cap),out_path=str(out),now=NOW)
    except (ValueError,TypeError): pass
    else: raise AssertionError('malformed prior facts ignored')
    assert out.read_bytes()==b'not JSON'
    errors=[]
    for call in (lambda:RL.run(season=2025,evidence_capture=str(cap),out_path=str(outputs/'legs.json')),
      lambda:RM.run(season=2025,evidence_capture=str(cap),cards_dir=str(cards),out_path=str(outputs/'my.json'))):
        try: call()
        except ValueError as error: errors.append(str(error))
        else: raise AssertionError('wrong season accepted')
    doc=json.loads(schedule.read_text()); doc['season']=2025; write_json(schedule,doc)
    try: BF.run(evidence_capture=str(cap),out_path=str(out))
    except ValueError as error: errors.append(str(error))
    else: raise AssertionError('facts used another season')
    assert out.read_bytes()==b'not JSON'
    print(json.dumps(errors))
`);
  assert.equal(result.length, 3);
  assert.ok(result.every(message => message.includes('season mismatch')));
});

test('conflicting duplicated FINAL events cannot settle any market from a season CSV', () => {
  const result = py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); events=[raw_event(g) for g in GAMES]
    changed=copy.deepcopy(events[0]); changed['competitions'][0]['competitors'][0]['score']='3'; events.append(changed)
    cap,_,_=make_capture(root/'capture',events=events)
    data,cards,ledger,outputs,_=prepare(root); no_refetch()
    r=RL.run(season=2026,evidence_capture=str(cap),out_path=str(outputs/'legs.json'),now=NOW)
    m=RM.run(season=2026,evidence_capture=str(cap),cards_dir=str(cards),out_path=str(outputs/'my.json'),now=NOW)
    f=BF.run(evidence_capture=str(cap),out_path=BF.OUT_PATH,now=NOW)
    print(json.dumps({'resolved':[row['game_id'] for row in r['resolved']],
                     'cards':[row['card_id'] for row in m['cards']], 'f':f}))
`);
  assert.equal(result.resolved.includes('F'), false);
  assert.equal(result.cards.some(id => id.startsWith('F-')), false);
  assert.equal(result.f.weeks['6'].players['fixture-F'], undefined);
  assert.equal(result.f.weeks['6'].games.F.hs, undefined);
});

test('opt-in gating preserves R106/owner exclusions and leaves default pure graders unchanged', () => {
  const result = py(String.raw`
stats=RL.index_stats(STATS); td=RL.index_td(STATS); snaps=RL.index_snaps(SNAPS)
live=leg('L'); old_rows,_,_=RL.resolve_props({'legs':[live]},STATS)
facts=BF.build(GAMES,{}, {'live':{'name':'Live Receiver','team':'BAL','position':'WR'}},
  stats,td,snaps,[],2026,NOW,'legacy fixture')
excluded=RM.grade_card(card('L'),6,stats,{}, {'td':td,'snaps':snaps}, {'L'}, set())
print(json.dumps({'legacy_prop':RM.grade_prop(live,6,stats,snaps),'legacy_leg':old_rows[0]['actual'],
                 'legacy_facts':facts['weeks']['6']['players']['live']['y'],
                 'excluded':[row['result'] for row in excluded['legs']]}))
`);
  assert.deepEqual(result.legacy_prop, ['hit', 90, null]);
  assert.equal(result.legacy_leg, 90);
  assert.deepEqual(result.legacy_facts, [0, 0, 90]);
  assert.deepEqual(result.excluded, ['void', 'void']);
});

test('game IDs repeated across captured weeks remain pending with visible quarantine provenance', () => {
  const result = py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); cap,bundle,_=make_capture(root/'capture',weeks=(5,6))
    captured=RL.captured_inputs(str(cap),2026)
    data,cards,ledger,outputs,_=prepare(root); no_refetch()
    r=RL.run(season=2026,evidence_capture=str(cap),out_path=str(outputs/'legs.json'),now=NOW)
    m=RM.run(season=2026,evidence_capture=str(cap),cards_dir=str(cards),out_path=str(outputs/'my.json'),now=NOW)
    f=BF.run(evidence_capture=str(cap),out_path=BF.OUT_PATH,now=NOW)
    print(json.dumps({'resolved':r['resolved'],'cards':m['cards'],'players':f['weeks']['6']['players'],
                     'source':r['finals_source'],'audit':captured['audit']}))
`);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.cards, []);
  assert.deepEqual(result.players, {});
  assert.equal(result.audit.cross_week_conflicting_game_ids.length, 6);
  assert.match(result.source, /6 quarantined game IDs remain pending/);
});

test('known captured game identities cannot be attached to another week, team or kickoff', () => {
  const result = py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); cap,_,_=make_capture(root/'capture')
    captured=RL.captured_inputs(str(cap),2026)
    cases=[{**leg('F'),'week':5},{**leg('F'),'season':2025},
           {**leg('F'),'team':'CHI'},{**leg('F'),'home':'CHI'},
           {**leg('F'),'kickoff_utc':'2026-10-18T20:25:00Z'}]
    errors=[]
    for item in cases:
        try: RL.require_capture_games(captured,[item])
        except ValueError as error: errors.append(str(error))
        else: raise AssertionError('contradictory identity accepted')
    RL.require_capture_games(captured,[{**leg('F'),'kickoff_utc':'2026-10-18T12:00:00-05:00'}])
    data,cards,ledger,outputs,_=prepare(root); no_refetch()
    doc=json.loads(ledger.read_text()); doc['legs'][0]['team']='CHI'; write_json(ledger,doc)
    out=outputs/'prior.json'; out.write_bytes(b'preserved')
    try: RL.run(season=2026,evidence_capture=str(cap),out_path=str(out))
    except ValueError: pass
    else: raise AssertionError('contradictory ledger accepted')
    assert out.read_bytes()==b'preserved'
    print(json.dumps(errors))
`);
  assert.equal(result.length, 5);
  assert.ok(result.every(message => message.includes('mismatch')));
});

test('capture CLI rejects conflicting legacy inputs before opening a supplied path', () => {
  for (const script of ['resolve_parlay_legs.py', 'resolve_my_cards.py', 'build_bet_facts.py']) {
    const conflicts = [['--offline'], ['--cache-dir', '/unused-test-cache']];
    if (script !== 'build_bet_facts.py') conflicts.push(['--dry-run-with', '/unused.csv'], ['--finals', '/unused.json']);
    for (const flags of conflicts) {
      const result = spawnSync('python3', ['scripts/' + script, '--evidence-capture', '/nonexistent-capture.json', ...flags], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      assert.equal(result.status, 2, script + ' ' + flags.join(' ') + ': ' + result.stderr);
      assert.match(result.stderr, /exclusive/);
      assert.equal(result.stdout, '');
    }
  }
});

test('an explicitly empty capture path cannot silently select the legacy fetch path', () => {
  const result = py(String.raw`
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); _,cards,_,outputs,_=prepare(root); no_refetch()
    failed=[]
    for name,call in [('legs',lambda:RL.run(season=2026,evidence_capture='',out_path=str(outputs/'legs.json'))),
      ('my',lambda:RM.run(season=2026,evidence_capture='',cards_dir=str(cards),out_path=str(outputs/'my.json'))),
      ('facts',lambda:BF.run(evidence_capture='',out_path=BF.OUT_PATH))]:
        try: call()
        except (ValueError,OSError): failed.append(name)
        else: raise AssertionError('empty capture selected the legacy path')
    assert not list(outputs.iterdir())
    print(json.dumps(failed))
`);
  assert.deepEqual(result, ['legs', 'my', 'facts']);
});

test('unknown or ambiguous capture participation never becomes zero or DNP and quarantines only its team-week', () => {
  const results = py(String.raw`
original_stats,original_snaps=copy.deepcopy(STATS),copy.deepcopy(SNAPS)
results={}
for label,value in [('NA','NA'),('empty',''),('nan','NaN'),('infinite','Infinity'),
                    ('negative','-1'),('boolean',True),('fraction','1.5'),('zero','0'),
                    ('duplicate','40')]:
    STATS=[r for r in copy.deepcopy(original_stats) if r['player_display_name']!='Final Receiver']
    STATS.append(stat('Measured Neighbor','SEA',88))
    SNAPS=copy.deepcopy(original_snaps)
    next(r for r in SNAPS if r['player']=='Final Receiver')['offense_snaps']=value
    if label=='duplicate':SNAPS.append(copy.deepcopy(next(r for r in SNAPS if r['player']=='Final Receiver')))
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp);cap,_,_=make_capture(root/'capture')
        _,cards,_,outputs,_=prepare(root);no_refetch()
        captured=RL.captured_inputs(str(cap),2026)
        graded=RM.run(season=2026,evidence_capture=str(cap),cards_dir=str(cards),out_path=str(outputs/'my.json'),now=NOW)
        facts=BF.run(evidence_capture=str(cap),out_path=BF.OUT_PATH,now=NOW)
        index=RL.index_stats(captured['stats']);td=RL.index_td(captured['stats']);snaps=captured['snap_index']
        measured=leg('F');measured['player']='Measured Neighbor'
        same_team=RM.grade_prop(measured,6,index,snaps)
        target=RM.grade_prop(leg('F'),6,index,snaps)
        target_td=RL.grade_atd(leg('F','anytime_td'),6,td,snaps)
        results[label]={'cards':[c['card_id'] for c in graded['cards']],
          'target_fact':facts['weeks']['6']['players'].get('fixture-F'),
          'positive_fact':facts['weeks']['6']['players']['fixture-O'],
          'dnp_fact':facts['weeks']['6']['players']['fixture-D'],
          'same_team':same_team,'target':target,'target_td':target_td,
          'audit':captured['participation_audit'],'source':graded['source'],
          'schema':__import__('scripts.validate_data',fromlist=['check_bet_facts']).check_bet_facts(facts)}
print(json.dumps(results))
`);
  for (const [label, result] of Object.entries(results)) {
    assert.equal(result.cards.includes('F-prop'), false, label);
    assert.equal(result.cards.includes('F-td'), false, label);
    assert.equal(result.target_fact, null, label);
    assert.equal(result.target[0], 'pending', label);
    assert.equal(result.target_td[0], 'pending', label);
    assert.equal(result.same_team[0], 'hit', `${label}: measured same-team stats are still valid`);
    assert.equal(result.same_team[1], 88, label);
    assert.deepEqual(result.positive_fact.y, [0, 0, 0], `${label}: other team's R106 evidence unaffected`);
    assert.equal(result.dnp_fact.y, 'dnp', `${label}: complete different-team DNP evidence unaffected`);
    assert.equal(result.cards.includes('O-prop'), true, label);
    assert.equal(result.cards.includes('D-prop'), true, label);
    assert.equal(result.schema, null, label);
    assert.equal(result.audit.length, label === 'zero' ? 0 : 1, label);
    if (label !== 'zero') {
      assert.deepEqual(result.audit[0], { week: 6, team: 'SEA', reason: 'incomplete_participation_sheet' });
      assert.ok(result.source.includes('quarantined participation team-weeks'), label);
    }
  }
});

test('capture rows need explicit REG/season identity and damaged stat joins cannot become absence', () => {
  const results = py(String.raw`
original_stats,original_snaps=copy.deepcopy(STATS),copy.deepcopy(SNAPS)
results={}
for mode in ('stats_blank_period','stats_missing_period','stats_blank_season','stats_blank_name',
             'stats_blank_team','stats_blank_position','stats_wrong_position',
             'snaps_blank_period','snaps_missing_period','snaps_blank_season'):
    STATS=copy.deepcopy(original_stats);SNAPS=copy.deepcopy(original_snaps)
    STATS.append(stat('Measured Neighbor','SEA',88))
    if mode.startswith('stats'):
        target=next(r for r in STATS if r['player_display_name']=='Final Receiver')
        if mode.endswith('blank_period'):target['season_type']=''
        elif mode.endswith('missing_period'):
            for r in STATS:r.pop('season_type',None)
        elif mode.endswith('blank_season'):target['season']=''
        elif mode.endswith('blank_name'):target['player_display_name']=''
        elif mode.endswith('blank_team'):target['team']=''
        elif mode.endswith('blank_position'):target['position']=''
        else:target['position']='TE'
    else:
        STATS=[r for r in STATS if r['player_display_name']!='Final Receiver']
        target=next(r for r in SNAPS if r['player']=='Final Receiver')
        if mode.endswith('blank_period'):target['game_type']=''
        elif mode.endswith('missing_period'):
            for r in SNAPS:r.pop('game_type',None)
        else:target['season']=''
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp)
        try:cap,_,_=make_capture(root/'capture')
        except CE.CaptureError:
            results[mode]={'capture_rejected':True,'output_exists':(root/'outputs').exists()};continue
        _,cards,_,outputs,_=prepare(root);no_refetch()
        c=RL.captured_inputs(str(cap),2026)
        by=RL.index_stats(c['stats']);td=RL.index_td(c['stats']);snaps=c['snap_index']
        measured=leg('F');measured['player']='Measured Neighbor'
        # A wrong but valid ATD position can still provide measured TDs; never
        # let that turn a missing required WR measurement into inferred zero.
        facts=BF.run(evidence_capture=str(cap),out_path=BF.OUT_PATH,now=NOW)
        results[mode]={'prop':RM.grade_prop(leg('F'),6,by,snaps),
          'atd':RL.grade_atd(leg('F','anytime_td'),6,td,snaps),
          'fact':facts['weeks']['6']['players'].get('fixture-F'),
          'neighbor':RM.grade_prop(measured,6,by,snaps),
          'source':c['source'],'stat_audit':c['stat_audit'],'snap_audit':c['participation_audit']}
print(json.dumps(results))
`);
  for (const [mode, result] of Object.entries(results)) {
    if (mode.endsWith('blank_season')) {
      assert.equal(result.capture_rejected, true, mode);
      assert.equal(result.output_exists, false, mode);
      continue;
    }
    assert.equal(result.prop[0], 'pending', mode);
    assert.equal(result.fact?.y ?? null, null, `${mode}: no false zero/DNP`);
    assert.equal(result.atd[0], 'pending', mode);
    if (mode !== 'stats_missing_period') {
      assert.equal(result.neighbor[0], 'hit', `${mode}: independently measured same-team neighbor remains valid`);
    }
    if (mode === 'stats_wrong_position') {
      assert.equal(result.atd[2], 'unverified_stat_identity', 'frozen leg supplies the position mismatch context');
    } else {
      assert.ok(result.stat_audit.length || result.snap_audit.length, `${mode}: uncertainty is visible`);
      assert.ok(result.source.includes('remain pending'), mode);
    }
  }
});

test('unknown snap teams/names and possible nickname aliases cannot prove DNP', () => {
  const results = py(String.raw`
original_stats,original_snaps=copy.deepcopy(STATS),copy.deepcopy(SNAPS)
results={}
for mode in ('unknown_team','missing_name','initial_alias','nickname_alias','unlocatable'):
    STATS=[r for r in copy.deepcopy(original_stats) if r['player_display_name']!='Final Receiver']
    STATS.append(stat('Measured Neighbor','SEA',88))
    SNAPS=copy.deepcopy(original_snaps)
    target=next(r for r in SNAPS if r['player']=='Final Receiver')
    if mode in ('unknown_team','unlocatable'):target['team']=''
    if mode in ('missing_name','unlocatable'):target['player']=''
    if mode=='initial_alias':target['player']='F. Receiver'
    if mode=='nickname_alias':target['player']='Fabulous Receiver'
    SNAPS.append({'season':'2026','week':'6','game_type':'REG','team':'SEA','player':'Other Seahawk','offense_snaps':'50'})
    with tempfile.TemporaryDirectory() as tmp:
        root=pathlib.Path(tmp);cap,_,_=make_capture(root/'capture');_,cards,_,outputs,_=prepare(root);no_refetch()
        if mode=='unlocatable':
            rejected=[]
            for label,call in [('legs',lambda p:RL.run(season=2026,evidence_capture=str(cap),out_path=str(p),now=NOW)),
                ('my',lambda p:RM.run(season=2026,evidence_capture=str(cap),cards_dir=str(cards),out_path=str(p),now=NOW)),
                ('facts',lambda p:BF.run(evidence_capture=str(cap),out_path=str(p),now=NOW))]:
                out=outputs/(label+'.json');out.write_bytes(b'previous immutable aggregate')
                try:call(out);rejected.append(False)
                except ValueError:rejected.append(out.read_bytes()==b'previous immutable aggregate')
            results[mode]={'rejected':rejected};continue
        c=RL.captured_inputs(str(cap),2026);by=RL.index_stats(c['stats']);td=RL.index_td(c['stats'])
        graded=RM.run(season=2026,evidence_capture=str(cap),cards_dir=str(cards),out_path=str(outputs/'my.json'),now=NOW)
        facts=BF.run(evidence_capture=str(cap),out_path=BF.OUT_PATH,now=NOW)
        measured=leg('F');measured['player']='Measured Neighbor'
        results[mode]={'prop':RM.grade_prop(leg('F'),6,by,c['snap_index']),
          'atd':RL.grade_atd(leg('F','anytime_td'),6,td,c['snap_index']),
          'fact':facts['weeks']['6']['players'].get('fixture-F'),
          'neighbor':RM.grade_prop(measured,6,by,c['snap_index']),
          'cards':[x['card_id'] for x in graded['cards']],'audit':c['participation_audit']}
print(json.dumps(results))
`);
  for (const [mode, result] of Object.entries(results)) {
    if (mode === 'unlocatable') {
      assert.deepEqual(result.rejected, [true, true, true], 'all prior output bytes preserved');
      continue;
    }
    assert.equal(result.prop[0], 'pending', mode);
    assert.equal(result.atd[0], 'pending', mode);
    assert.equal(result.fact, null, mode);
    assert.equal(result.neighbor[0], 'hit', mode);
    assert.equal(result.cards.includes('F-prop') || result.cards.includes('F-td'), false, mode);
    assert.equal(result.cards.includes('O-prop') && result.cards.includes('D-prop'), true, mode);
    if (mode.endsWith('alias')) {
      assert.ok(['participation_unknown', 'unverified_stat_identity'].includes(result.atd[2]), mode);
    }
    else assert.equal(result.audit.length, 1, mode);
  }
});
