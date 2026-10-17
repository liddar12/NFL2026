"""Synthetic real-producer/raw-grader/shared-fitter fixture, not accuracy proof."""
import copy
import datetime as dt
import json
import math
from pathlib import Path
import random

from scripts import build_leg_pool as pool, learning_journal, learning_receipts as lr
from scripts import capture_outcome_evidence as capture, run_parlay_feedback as feedback
from tests.fixtures import week6_outcomes as raw

PAIRS=[('SEA','LAR'),('NE','NYJ'),('CHI','GB'),('DAL','PHI'),('LAC','KC'),('BUF','MIA'),
       ('ATL','CAR'),('DEN','LV'),('DET','MIN'),('BAL','CIN'),('HOU','IND'),('JAX','TEN')]
POSITIONS=['QB','RB','WR']
MARKETS=['qb_pass_yds','rb_rush_yds','wr_rec_yds']
COMP=['pass_yd','rush_yd','rec_yd']


def stamp(value):return value.isoformat().replace('+00:00','Z')


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,allow_nan=False))


def write_inputs(data,value,schedule):
    names={'pool_backtest':'leg_pool_backtest.json','player_weekly':'player_weekly.json',
        'player_projections':'player_projections.json','game_predictions':'game_predictions.json',
        'parlays':'parlays.json','atd_week':'atd_week.json','atd_backtest':'atd_backtest.json'}
    for key,name in names.items():write(data/name,value[key])
    write(data/'schedule_full.json',schedule)
    value['excluded_games']=sorted(pool.excluded_ids())


def inputs(week,created,*,n=180,tag=None,past=False):
    tag=tag or str(week);now=lr.instant(created);rnd=random.Random(9931+week)
    games=[{'game_id':f'synthetic-{tag}-{i}','week':week,'home':home,'away':away,
        'kickoff_utc':stamp(now+dt.timedelta(days=1,hours=6)),'status':'STATUS_SCHEDULED',
        'probs':{'home':.5}}for i,(home,away)in enumerate(PAIRS)]
    players=[];weekly=[];actuals=[];snaps=[]
    for i in range(n):
        g=games[i%len(games)];pos=i%3;p=.2+.6*rnd.random();mu=59.5+20*math.log(p/(1-p))
        sid=f'00-synthetic-{tag}-{i}';name=f'Synthetic {tag} Player {i}'
        players.append({'gsis_id':sid,'name':name,'team':g['home'],'position':POSITIONS[pos]})
        weekly.append({'gsis_id':sid,'weeks':[{'wk':week,'pts':10,'home':True,'opp':g['away']}],
            'league_components':{COMP[pos]:mu},'eligibility':{'eligible':True,'week':week}})
        hit=rnd.random()<1/(1+math.exp(-(.9+math.log(p/(1-p)))))
        row=raw.stats_row('0',season='2026',week=str(week),position=POSITIONS[pos],team=g['home'],
            player_id=sid,player_display_name=name)
        row[['passing_yards','rushing_yards','receiving_yards'][pos]]='80'if hit else'20'
        actuals.append(row);snaps.append(raw.snap_row(week=str(week),team=g['home'],player=name))
    if past:
        games[-1]['status']='STATUS_FINAL';games[-1]['kickoff_utc']=stamp(now-dt.timedelta(hours=12))
    calibration={pos:{'a':0.,'b':1.,'c':0.}for pos in POSITIONS}
    source=stamp(now-dt.timedelta(minutes=30))
    value={'generated_utc':created,'excluded_games':[],
        'pool_backtest':{'generated_utc':source,'model':'synthetic-wide-pool','calibration':calibration,
            'support':{pos:[-8.,8.]for pos in POSITIONS},'residual_sd':{pos:20. for pos in POSITIONS},
            'ladder':{pos:[59.5]for pos in POSITIONS},'verdict':{'adopt':True}},
        'player_projections':{'generated_utc':source,'players':players},
        'player_weekly':{'generated_utc':source,'players':weekly},
        'game_predictions':{'generated_utc':source,'games':games},
        'parlays':{'season':2026,'week':week,'parlays':[{'game_id':g['game_id'],'legs':[
            {'market':'moneyline','selection':g['home']+' ML','model_prob':.5,'implied_prob':.52,
             'side':'home','price_source':'fair_market'}]}for g in games]},
        'atd_week':None,'atd_backtest':None}
    schedule={'season':2026,'updated_utc':source,'games':copy.deepcopy(games)}
    return value,schedule,actuals,snaps


def outcomes(week,schedule,actuals,snaps,observed):
    events=[]
    for g in schedule['games']:
        events.append({'id':g['game_id'],'date':g['kickoff_utc'],'status':{'type':{'name':'STATUS_FINAL'}},
            'competitions':[{'competitors':[{'homeAway':'home','score':'24','team':{'abbreviation':g['home']}},
                {'homeAway':'away','score':'17','team':{'abbreviation':g['away']}}]}]})
    bodies={capture.SCOREBOARD_PROFILE:json.dumps({'season':{'year':2026},'week':{'number':week},'events':events}).encode(),
        capture.STATS_PROFILE:raw.csv_bytes(raw.STATS_HEADERS,actuals),
        capture.SNAPS_PROFILE:raw.csv_bytes(raw.SNAPS_HEADERS,snaps)}
    time=lr.instant(observed)
    def clock():
        nonlocal time
        time+=dt.timedelta(seconds=1);return stamp(time)
    return capture.capture(2026,[week],fetcher=lambda spec:(200,{},bodies[spec['profile']]),clock=clock)


def training(data,engine,commit):
    """Three complete pregame cohorts, then observed raw FINAL data; no uploads/PASS flags."""
    records=[]
    for week in (1,2,3):
        created=stamp(dt.datetime(2026,9,27,12,tzinfo=dt.timezone.utc)+dt.timedelta(days=(week-1)*7))
        value,schedule,actuals,snaps=inputs(week,created)
        built=pool.build(value)
        learning_journal.record(built,schedule,None,[],stamp(lr.instant(created)+dt.timedelta(minutes=1)),str(data/'snapshots'))
        records.append((week,created,schedule,actuals,snaps))
        feedback.run(data_dir=data,snapshot_dir=data/'snapshots',captures=[],engine_checkout=engine,engine_commit=commit,
            observed_utc=stamp(lr.instant(created)+dt.timedelta(hours=1)),
            evaluation_clock=lambda created=created:stamp(lr.instant(created)+dt.timedelta(hours=1,seconds=1)))
        bundle=outcomes(week,schedule,actuals,snaps,stamp(lr.instant(created)+dt.timedelta(days=2)))
        saved=capture.save_capture(bundle,data.parent/f'external-{week}')
        feedback.run(data_dir=data,snapshot_dir=data/'snapshots',captures=[saved],engine_checkout=engine,engine_commit=commit,
            observed_utc=stamp(lr.instant(created)+dt.timedelta(days=3)),
            evaluation_clock=lambda created=created:stamp(lr.instant(created)+dt.timedelta(days=3,seconds=1)))
    return records
