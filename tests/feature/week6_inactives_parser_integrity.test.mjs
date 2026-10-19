import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const setup = String.raw`
import contextlib, copy, datetime as dt, io, json, sys
from unittest.mock import patch
sys.path.insert(0, '.')
from scripts.scrape import espn as E
from scripts import build_predictions as P, build_weekly as W

def refused(call):
    try: call()
    except E.FeedError as error:
        assert str(error)
        return str(error)
    raise AssertionError('malformed roster accepted')

def provider(home_rows, away_rows=None, *, reverse=False, good_rows=None):
    bodies = {}
    for gid, home, away, rows in (
        ('BAD', 'SF', 'DAL', (home_rows, [] if away_rows is None else away_rows)),
        ('GOOD', 'GB', 'CHI', ([{'playerId':303, 'didNotPlay':True, 'displayName':'GB RB'}]
                             if good_rows is None else good_rows, [])),
    ):
        competitors = []
        for side, team, entries in zip(('home', 'away'), (home, away), rows):
            team_url, roster_url = 'fixture://'+gid+'/'+side+'/team', 'fixture://'+gid+'/'+side+'/roster'
            competitors.append({'homeAway':side, 'team':{'$ref':team_url}, 'roster':{'$ref':roster_url}})
            bodies[team_url] = {'abbreviation':team}
            bodies[roster_url] = {'entries':entries}
        bodies[E._CORE_COMPETITION_URL.format(gid=gid)] = {'competitors':competitors[::-1] if reverse else competitors}
    requests = []
    def get(url, **kwargs):
        requests.append(url)
        assert url in bodies, 'unexpected provider request'
        return copy.deepcopy(bodies[url])
    return get, requests

NOW = '2026-10-18T16:00:00Z'
GAMES = [{'game_id':gid, 'home':home, 'away':away, 'week':6,
          'kickoff_utc':'2026-10-18T17:00:00Z', 'status':'STATUS_SCHEDULED'}
         for gid,home,away in (('BAD','SF','DAL'), ('GOOD','GB','CHI'))]
PROJECTIONS = [
    {'gsis_id':'espn-101', 'name':'QB One', 'team':'SF', 'position':'QB'},
    {'gsis_id':'espn-102', 'name':'QB Two', 'team':'SF', 'position':'QB'},
    {'gsis_id':'espn-303', 'name':'GB RB', 'team':'GB', 'position':'RB'},
]
DEPTH = {'updated_utc':NOW, 'teams':{'SF':{'QB':[
    {'rank':1, 'name':'QB One', 'espn_id':'101'},
    {'rank':2, 'name':'QB Two', 'espn_id':'102'},
]}}}

def weekly(home_rows, away_rows=None, *, reverse=False):
    get, requests = provider(home_rows, away_rows, reverse=reverse)
    warning = io.StringIO()
    with patch.object(E, '_get_json', side_effect=get), contextlib.redirect_stderr(warning):
        # Exercise the actual fetch function through the default producer path.
        doc = P._inactives_doc(NOW, GAMES, 6, now_utc=dt.datetime(2026,10,18,16,tzinfo=dt.timezone.utc))
    gates, meta = W.this_week_gate(PROJECTIONS, {}, [], DEPTH, 6, W.team_schedule(GAMES), inactives=doc)
    assert list(doc) == ['season','week','updated_utc','source','window_hours','counts','games','failed']
    return doc, gates, meta, warning.getvalue(), requests

def assert_game_refused(home_rows, away_rows=None, *, reverse=False):
    doc, gates, meta, warning, requests = weekly(home_rows, away_rows, reverse=reverse)
    assert doc['counts'] == {'games':1, 'failed':1, 'players':1}, doc
    assert [game['game_id'] for game in doc['games']] == ['GOOD']
    assert len(doc['failed']) == 1 and doc['failed'][0]['game_id'] == 'BAD'
    assert 'ESPN' in doc['failed'][0]['error'] and 'inactives for game BAD' in warning
    assert 'espn-101' not in gates, 'refused observation manufactured QB1 inactive'
    assert gates['espn-102']['reason'] == 'depth' and gates['espn-102']['playable'] is False
    assert meta['promoted'] == 0, 'refused observation promoted QB2'
    assert gates['espn-303']['reason'] == 'inactive' and gates['espn-303']['game_id'] == 'GOOD'
    assert meta['by_reason']['inactive'] == 1
    return doc
`;

function python(body) {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-'], {
    cwd: ROOT, encoding: 'utf8', input: setup + body, timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, (result.error?.message ?? '') + result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test('inactive parser refuses malformed container/rows and every present non-boolean DNP flag', () => {
  const result = python(String.raw`
bad_containers = ({}, False, 0, 1, '', 'roster', ())
bad_rows = (None, False, 0, 1, '', 'row', [], ['row'])
bad_flags = (None, 0, 1, -1, 0.0, 1.0, '', 'false', 'true', [], [1], {}, {'flag':True})
for value in bad_containers: refused(lambda:E.parse_game_roster(value))
for value in bad_rows: refused(lambda:E.parse_game_roster([value]))
for value in bad_flags:
    refused(lambda:E.parse_game_roster([{'playerId':101, 'didNotPlay':value}]))
    refused(lambda:E.parse_game_roster([{'didNotPlay':value}]))
assert E.parse_game_roster(None) == [] and E.parse_game_roster([]) == []
print(json.dumps({'containers':len(bad_containers), 'rows':len(bad_rows), 'flags_with_and_without_id':2*len(bad_flags)}))
`);
  assert.deepEqual(result, {containers: 7, rows: 8, flags_with_and_without_id: 26});
});

test('emitted inactive IDs are exact positive canonical identities; non-emitted invalid IDs remain ignored', () => {
  const result = python(String.raw`
valid = [1, '2', 999999999999998, '999999999999999']
assert E.parse_game_roster([{'playerId':value, 'didNotPlay':True} for value in valid]) == [
    {'espn_id':str(value), 'name':''} for value in valid]
invalid = [True, False, 0, -1, 1.0, 1.5, 10**15, '0', '-1', '+1', '01', ' 1', '1 ', '1\n',
           '1.0', '1e2', '١', '１', '1000000000000000', [], [1], {}, {'id':1}]
for value in invalid:
    refused(lambda:E.parse_game_roster([{'playerId':value, 'didNotPlay':True}]))
    assert E.parse_game_roster([{'playerId':value, 'didNotPlay':False}, {'playerId':value}]) == []
assert E.parse_game_roster([{'didNotPlay':True}, {'playerId':None,'didNotPlay':True},
                           {'playerId':'','didNotPlay':True}]) == []
assert E.parse_game_roster([{'playerId':101,'didNotPlay':False,'active':False},
                           {'playerId':102,'active':False}]) == []
print(json.dumps({'valid_ids':len(valid), 'refused_emitted_ids':len(invalid), 'missing_ids_dropped':3}))
`);
  assert.deepEqual(result, {valid_ids: 4, refused_emitted_ids: 23, missing_ids_dropped: 3});
});

test('duplicate canonical roster identities are refused for every true/false/absent flag combination and order', () => {
  const result = python(String.raw`
flags = ({'didNotPlay':True}, {'didNotPlay':False}, {})
cases = 0
for first in flags:
    for second in flags:
        rows = [dict(first,playerId=101), dict(second,playerId='101')]
        for ordered in (rows, rows[::-1]):
            refused(lambda:E.parse_game_roster(ordered));cases += 1
print(json.dumps({'duplicate_combinations':cases}))
`);
  assert.deepEqual(result, {duplicate_combinations: 18});
});

test('inactive display names are strings only and never change the emitted identity or output schema', () => {
  const result = python(String.raw`
names = [None, False, 0, 1, [], {}, ['name'], {'name':'wrong'}]
entries = [{'playerId':index+1,'didNotPlay':True,'displayName':name} for index,name in enumerate(names)]
entries += [{'playerId':9,'didNotPlay':True}, {'playerId':10,'didNotPlay':True,'displayName':'Z Last'},
            {'playerId':11,'didNotPlay':True,'displayName':'A First'}]
rows = E.parse_game_roster(entries)
assert rows == ([{'espn_id':str(index),'name':''} for index in range(1,10)]
                + [{'espn_id':'11','name':'A First'}, {'espn_id':'10','name':'Z Last'}])
assert all(set(row) == {'espn_id','name'} for row in rows)
print(json.dumps({'names_normalized':9, 'string_names_preserved':2}))
`);
  assert.deepEqual(result, {names_normalized: 9, string_names_preserved: 2});
});

test('real provider-to-document-to-weekly path refuses malformed observations without promoting a backup; another game survives', () => {
  const result = python(String.raw`
bad_flags = (None, 0, 1, -1, 0.0, 1.0, '', 'false', 'true', [], [1], {}, {'flag':True})
for value in bad_flags: assert_game_refused([{'playerId':101,'didNotPlay':value}])
for rows in ([None], [False], [1], ['row'], [[]], {}, False, 0, '', 'roster'):
    assert_game_refused(rows)
for value in (True, 0, 1.0, '0101', '101 ', {'id':101}):
    assert_game_refused([{'playerId':value,'didNotPlay':True}])
assert_game_refused([{'playerId':101,'didNotPlay':True}, {'playerId':'101','didNotPlay':False}])
print(json.dumps({'malformed_flag_games':len(bad_flags), 'bad_shape_games':10, 'bad_id_games':6,
                  'duplicate_game':1, 'unaffected_game_preserved':True, 'false_promotion':False}))
`);
  assert.deepEqual(result, {malformed_flag_games: 13, bad_shape_games: 10, bad_id_games: 6,
    duplicate_game: 1, unaffected_game_preserved: true, false_promotion: false});
});

test('same-game cross-team canonical duplicates are refused even for false/absent rows, in either competitor order', () => {
  const result = python(String.raw`
flags = ({'didNotPlay':True}, {'didNotPlay':False}, {})
cases = 0
for home in flags:
    for away in flags:
        for reverse in (False, True):
            assert_game_refused([dict(home,playerId=101)], [dict(away,playerId='101')], reverse=reverse)
            cases += 1
# Identity checks are local to a single fetched event, not a season/global store.
get, _ = provider([{'playerId':101,'didNotPlay':True}], good_rows=[{'playerId':'101','didNotPlay':True}])
with patch.object(E,'_get_json',side_effect=get):
    assert E.fetch_game_inactives('BAD')['inactive']['SF'] == [{'espn_id':'101','name':''}]
    assert E.fetch_game_inactives('GOOD')['inactive']['GB'] == [{'espn_id':'101','name':''}]
print(json.dumps({'cross_team_combinations':cases, 'cross_game_global_deduplication':False}))
`);
  assert.deepEqual(result, {cross_team_combinations: 18, cross_game_global_deduplication: false});
});

test('genuine boolean true still gates QB1 and promotes QB2; false, absent and empty observations do neither', () => {
  const result = python(String.raw`
doc,gates,meta,warning,_ = weekly([{'playerId':'101','didNotPlay':True,'displayName':{'not':'text'}}])
assert doc['counts'] == {'games':2,'failed':0,'players':2} and warning == ''
assert gates['espn-101']['reason'] == 'inactive' and gates['espn-101']['game_id'] == 'BAD'
assert gates['espn-102']['reason'] == 'depth_promoted' and gates['espn-102']['playable'] is True
assert meta['promoted'] == 1 and gates['espn-303']['reason'] == 'inactive'
assert doc['games'][0]['inactive']['SF'] == [{'espn_id':'101','name':''}]
for observation in (None, [], [{'playerId':101,'didNotPlay':False,'active':False}], [{'playerId':101,'active':False}]):
    doc,gates,meta,warning,_ = weekly(observation)
    assert doc['counts'] == {'games':2,'failed':0,'players':1} and warning == ''
    assert 'espn-101' not in gates and gates['espn-102']['reason'] == 'depth'
    assert meta['promoted'] == 0
    # No new completeness/posted/confirmation authority is added to the feed.
    assert set(doc['games'][0]) == {'game_id','home','away','kickoff_utc','status','fetched_utc','inactive'}
print(json.dumps({'genuine_true_promotes':True, 'nonnegative_observations_do_not_promote':4,
                  'new_confirmation_fields':False}))
`);
  assert.deepEqual(result, {genuine_true_promotes: true, nonnegative_observations_do_not_promote: 4,
    new_confirmation_fields: false});
});
