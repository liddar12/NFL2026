import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { gradeLeg } from '../../app/bets.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = `
import json
from scripts.build_bet_facts import build
from scripts.player_outcomes import context, identity_maps, player_event_facts
from scripts.resolve_my_cards import grade_card, grade_prop
from scripts.resolve_parlay_legs import grade_atd, index_snaps, index_stats, index_td

week = 9
games = [
    {"game_id": "401873039", "week": week, "home": "NO", "away": "CLE"},
    {"game_id": "401873051", "week": week, "home": "MIN", "away": "BUF"},
]
finals = {"401873039": {"home_score": 28, "away_score": 14},
          "401873051": {"home_score": 21, "away_score": 24}}
roster = [{"espn_id": "4569682", "gsis_id": "00-0039373", "pfr_id": "EstiAu00"}]
ids = identity_maps(roster)
ctx = context(games, finals, 2026, ids)
leg = {"game_id": "401873039", "season": 2026, "team": "CLE", "player": "Audric Estime",
       "position": "RB", "gsis_id": "espn-4569682", "selection": "A. Estime 60+ rush yds",
       "market": "rb_rush_yds", "line": 59.5}
td_leg = dict(leg, market="anytime_td", selection="A. Estime anytime TD")
stats = {"game_id": "2026_09_CLE_NO", "season": "2026", "week": "9", "season_type": "REG",
         "team": "NO", "opponent_team": "CLE", "position": "RB",
         "player_id": "00-0039373", "player_display_name": "Audric Estime",
         "passing_yards": "0", "rushing_yards": "72", "receiving_yards": "5",
         "rushing_tds": "1", "receiving_tds": "0"}
snap = {"game_id": "2026_09_CLE_NO", "season": "2026", "week": "9", "game_type": "REG",
        "team": "NO", "opponent": "CLE", "position": "RB", "player": "Audric Estime",
        "pfr_player_id": "EstiAu00", "offense_snaps": "35"}
cle_sheet = dict(snap, team="CLE", opponent="NO", position="WR", player="Cleveland Wide",
                 pfr_player_id="WideCl00", offense_snaps="55")
no_sheet = dict(snap, position="WR", player="Orleans Wide",
                pfr_player_id="WideNo00", offense_snaps="48")
other_stats = dict(stats, game_id="2026_09_BUF_MIN", team="MIN", opponent_team="BUF")
other_snap = dict(snap, game_id="2026_09_BUF_MIN", team="MIN", opponent="BUF")

def facts(receipt=leg, stat_rows=(), snap_rows=(), game_ctx=ctx):
    return player_event_facts(receipt, week, index_stats(stat_rows).get(week, []),
                              index_td(stat_rows).get(week, []),
                              index_snaps(snap_rows).get(week), game_ctx)

def emit(value):
    print(json.dumps(value))
`;

function py(source) {
  return JSON.parse(execFileSync('python3', ['-B', '-'], {
    cwd: root,
    encoding: 'utf8',
    input: fixture + source,
  }).trim());
}

function assertPending(fact, message) {
  assert.equal(fact.y, null, message);
  assert.equal(fact.td, null, message);
  assert.ok(fact.reason, message);
}

test('same-fixture side switch uses stable IDs and preserves receipt terms', () => {
  const r = py(`
stat_rows = [dict(stats, player_display_name="Audric Estimé")]
snap_rows = [dict(snap, player="Different Display"), cle_sheet, no_sheet]
by_week = index_stats(stat_rows)
td = index_td(stat_rows)
snaps = index_snaps(snap_rows)
card = grade_card({"card_id": "example", "legs": [leg, td_leg]}, week, by_week, finals,
                  {"td": td, "snaps": snaps, "context": ctx})
emit({"fact": facts(leg, stat_rows, snap_rows),
      "prop": grade_prop(leg, week, by_week, snaps, ctx),
      "atd": grade_atd(td_leg, week, td, snaps, ctx),
      "card": card, "receipt": leg})
`);
  assert.deepEqual(r.fact, { y: [0, 72, 5], td: 1 });
  assert.deepEqual(r.prop, ['hit', 72, null]);
  assert.deepEqual(r.atd, ['hit', { tds: 1 }, null]);
  assert.deepEqual(r.card.legs.map(l => [l.game_id, l.gsis_id, l.result]), [
    ['401873039', 'espn-4569682', 'hit'],
    ['401873039', 'espn-4569682', 'hit'],
  ]);
  assert.equal(r.receipt.team, 'CLE');
});

test('retained published grades follow exact terms even when two versions share a rank', () => {
  const r = py(`
from scripts.grade_observed_parlays import grade_cards
from scripts.observe_parlay_offers import classify_offers
kickoff='2026-11-09T18:00:00Z'
scheduled=[dict(g, status='STATUS_SCHEDULED', kickoff_utc=kickoff) for g in games]
schedule=dict(season=2026,games=scheduled)
slate=dict(season=2026,week=week,updated_utc='2026-11-08T18:00:00Z',parlays=[
    dict(parlay_id='rank-1',scope='game',game_id=leg['game_id'],legs=[leg]),
    dict(parlay_id='rank-1',scope='game',game_id=leg['game_id'],legs=[
        dict(leg,line=89.5,selection='A. Estime 90+ rush yds')]),
    dict(parlay_id='rank-1',scope='game',game_id=games[1]['game_id'],legs=[
        dict(market='moneyline',selection='MIN ML',side='home')])])
refs=classify_offers(slate,schedule,'2026-11-09T17:00:00Z')
observed=[dict(g,final=True,observed_utc='2026-11-09T23:00:00Z',**finals[g['game_id']]) for g in scheduled]
observed[1]['away']='NYJ'
evidence=dict(season=2026,week=week,cards=refs)
emit(grade_cards(evidence,slate,schedule,observed,[stats],[snap,cle_sheet,no_sheet],roster))
`);
  assert.deepEqual(r.cards.map(c => c.result), ['full_hit', 'loss', 'pending']);
  assert.equal(new Set(r.cards.map(c => c.offer_sha256)).size, 3);
  assert.deepEqual(r.cards.slice(0,2).map(c => c.legs[0].actual), [72,72]);
  assert.equal(r.cards[2].legs[0].reason, 'final_fixture_mismatch');
  assert.deepEqual(r.by_scope.game, { full_hit: 1, loss: 1, pending: 1 });
});

test('published calibration scores only the recorded probability of the original full card', () => {
  const result = py(`
from scripts.grade_observed_parlays import summarize_published_calibration

cards = [dict(joint_model_prob=p) for p in (.6,.25,.4,.3,None)]
cards[-1] = dict(model_ev=.1,legs=[dict(model_prob=.8,implied_prob=.5)])
references = [dict(offer_sha256=str(i),pre_kickoff_observed=True) for i in range(len(cards))]
cases = [
    ('game',[('A','hit'),('A','hit')]), ('game',[('A','miss'),('A','hit')]),
    ('week',[('A','miss'),('B','pending')]), ('week',[('A','hit'),('B','void')]),
    ('game',[('A','hit'),('A','hit')]),
]
grades = [dict(offer_sha256=str(i),scope=scope,legs=[dict(game_id=gid,outcome=o) for gid,o in terms])
          for i,(scope,terms) in enumerate(cases)]
emit(summarize_published_calibration(dict(cards=references),dict(parlays=cards),grades))
`);
  assert.equal(result.total.eligible_offers, 5);
  assert.equal(result.total.recorded_joint_probability_count, 4);
  assert.equal(result.total.all_legs_binary_count, 3);
  assert.equal(result.total.scored_count, 2);
  assert.deepEqual(result.total.exclusions, {
    unresolved_leg: 1, void_leg: 1, missing_recorded_joint_probability: 1,
  });
  assert.equal(result.total.expected_full_hits, .85);
  assert.equal(result.total.observed_full_hits, 1);
  assert.ok(Math.abs(result.total.brier - ((.6 - 1) ** 2 + .25 ** 2) / 2) < 1e-12);
  assert.ok(Math.abs(result.total.log_loss + (Math.log(.6) + Math.log(.75)) / 2) < 1e-12);
  assert.equal(result.by_scope.week.brier, null);
  assert.equal(result.by_scope_and_leg_count[0].leg_count, 2);
  assert.equal(result.by_scope.game.max_scored_card_share_one_game, 1);
});

test('refresh series keeps the first public terms despite reordering, repricing and repeated input', () => {
  const result = py(`
from hashlib import sha256
from pathlib import Path
from runpy import run_path
from tempfile import TemporaryDirectory
from scripts.grade_observed_parlays import evaluate_series
from scripts.learning_receipts import fingerprint
from scripts.observe_parlay_offers import classify_offers
from scripts.capture_outcome_evidence import save_capture

fixture = run_path('tests/fixtures/week6_outcomes.py')
season, week, kickoff = 2026, 6, fixture['KICKOFF']
schedule = dict(season=season,games=[dict(game_id='G1',week=week,home='SEA',away='LAR',
                                         kickoff_utc=kickoff,status='STATUS_SCHEDULED')])
team_leg = dict(market='moneyline',selection='SEA ML')
stable = dict(market='wr_rec_yds',gsis_id=fixture['player_ids']()[0],player='Alpha One',
              team='SEA',line=59.5,selection='Alpha 60+')
loser = dict(market='moneyline',selection='LAR ML')

def offer(rank, terms, **value):
    return dict(parlay_id=rank,scope='game',game_id='G1',legs=terms,**value)

def retain(root, when, offers):
    slate = dict(season=season,week=week,updated_utc=when,parlays=offers)
    hashes = {}
    for name, value in (('parlays.json',slate),('schedule_full.json',schedule)):
        raw = json.dumps(value).encode()
        hashes[name] = sha256(raw).hexdigest()
        (root / (hashes[name] + '.bin')).write_bytes(raw)
    evidence = dict(version=1,kind='nfl.public_parlay_observation.v1',objects_sha256=hashes,
                    observed_completed_utc=when,origin='https://fixture.invalid',
                    season=season,week=week,cards=classify_offers(slate,schedule,when))
    identifier = fingerprint(evidence)
    path = root / (identifier[7:] + '.json')
    path.write_text(json.dumps(dict(evidence,observation_id=identifier)))
    return path

with TemporaryDirectory() as folder:
    root = Path(folder)
    first = retain(root,'2026-09-01T17:00:00Z',[
        offer('old-1',[team_leg,stable],joint_model_prob=.6),
        offer('old-2',[loser]),
    ])
    later = retain(root,'2026-09-01T18:00:00Z',[
        offer('updated-1',[dict(stable,side='home'),dict(team_leg,side='home')],joint_model_prob=.9),
        offer('updated-2',[loser],joint_model_prob=.2),
        offer('new-line',[team_leg,dict(stable,line=89.5,selection='Alpha 90+')],joint_model_prob=.25),
    ])
    late = retain(root,'2026-09-02T00:16:00Z',[offer('after-kickoff',[team_leg],joint_model_prob=.8)])
    ambiguous = retain(root,'2026-09-01T17:00:00Z',[offer('tie',[team_leg,stable],joint_model_prob=.7)])
    outcomes = save_capture(fixture['bound_bundle'](),root / 'outcomes')
    report = evaluate_series([later, late, first, first],outcomes)
    assert report == evaluate_series([first,late,later],outcomes)
    try:
        evaluate_series([first,ambiguous],outcomes)
    except ValueError as exc:
        tie_refusal = str(exc)
    else:
        raise AssertionError('conflicting first probabilities were silently selected')
    emit(dict(report=report,tie_refusal=tie_refusal))
`);
  const { report } = result;
  assert.equal(result.tie_refusal, 'ambiguous_first_card_forecast');
  assert.equal(report.superseded_or_repeated_offers, 2);
  assert.equal(report.excluded_unverified_offers, 1);
  assert.equal(report.observation_ids.length, 3);
  assert.deepEqual(report.calibration.cards.map((card) => card.joint_model_prob), [.6, null, .25]);
  assert.deepEqual(report.calibration.cards.map((card) => card.full_hit), [true, false, false]);
  assert.equal(report.calibration.total.scored_count, 2);
  assert.equal(report.calibration.total.expected_full_hits, .85);
  assert.equal(report.calibration.total.exclusions.missing_recorded_joint_probability, 1);
});

test('observer waits for the exact publisher bytes and reuses the first successful capture', () => {
  const result = py(`
from pathlib import Path
from subprocess import check_output
from tempfile import TemporaryDirectory
from unittest.mock import patch
from scripts import observe_parlay_offers as O

commit = check_output(['git','rev-parse','HEAD'],text=True).strip()
public = {name:check_output(['git','show',f'{commit}:data/{name}']) for name in O.NAMES}
responses, pauses = [], []

def get(_, name):
    responses.append(name)
    return b'{}' if len(responses) == 1 else public[name]

with TemporaryDirectory() as folder:
    root = Path(folder)
    receipt = root / 'published-data.txt'
    receipt.write_text(f'84 2 {commit}\\n')
    with patch.object(O,'_get_json',side_effect=get), patch.object(O,'_now',return_value='2099-01-01T00:00:00Z'):
        try:
            O.observe_after_publisher('https://fixture.invalid',receipt,'84','1',root / 'observed',
                                      sleep=pauses.append)
        except ValueError as exc:
            refusal = str(exc)
        else:
            raise AssertionError('receipt was accepted for the wrong attempt')
        assert not responses
        first = O.observe_after_publisher('https://fixture.invalid',receipt,'84','2',root / 'observed',
                                          sleep=pauses.append)
        second = O.observe_after_publisher('https://fixture.invalid',receipt,'84','2',root / 'observed',
                                           sleep=pauses.append)
        receipt.write_text('84 2 noop\\n')
        noop = O.observe_after_publisher('https://fixture.invalid',receipt,'84','2',root / 'observed',
                                         sleep=pauses.append)
    emit(dict(refusal=refusal,pauses=pauses,requests=len(responses),first=first['observation_id'],
              second=second['observation_id'],replayed=second['replayed'],noop=noop['status']))
`);
  assert.equal(result.refusal, 'queue_publisher_receipt_invalid');
  assert.deepEqual(result.pauses, [10]);
  assert.equal(result.requests, 6);
  assert.equal(result.first, result.second);
  assert.equal(result.replayed, true);
  assert.equal(result.noop, 'publisher_no_new_commit');
});

test('played in another fixture stays pending even with the old fixture snap sheet', () => {
  const r = py(`
all_snaps = [cle_sheet, no_sheet, other_snap]
new_leg = dict(leg, game_id="401873051", team="MIN")
idents = {leg["gsis_id"]: {"name": leg["player"], "team": "MIN", "position": "RB"}}
records = [dict(leg, week=week), dict(new_leg, week=week)]
doc = build(games, finals, idents, index_stats([other_stats]), index_td([other_stats]),
            index_snaps(all_snaps), [], 2026, "fixture", "fixture",
            event_context=ctx, recorded=records)
emit({"old": facts(leg, [other_stats], all_snaps),
      "new": facts(new_leg, [other_stats], all_snaps),
      "records": records, "doc": doc})
`);
  assertPending(r.old);
  assert.deepEqual(r.new, { y: [0, 72, 5], td: 1 });
  const published = r.doc.weeks[9];
  const [oldLeg, newLeg] = r.records;
  assert.deepEqual(published.players_by_game[oldLeg.game_id][oldLeg.gsis_id], r.old);
  assert.deepEqual(published.players_by_game[newLeg.game_id][newLeg.gsis_id], r.new);
  assert.deepEqual(published.players[oldLeg.gsis_id], { y: null, td: null });
  assert.equal(gradeLeg(oldLeg, r.doc).result, 'pending');
  assert.deepEqual(gradeLeg(newLeg, r.doc), { result: 'hit', actual: 72, reason: null });
});

test('known player ID in another fixture survives a position mismatch check', () => {
  const r = py(`
emit(facts(leg, [dict(other_stats, position="WR")],
           [cle_sheet, no_sheet, dict(other_snap, position="WR")]))
`);
  assertPending(r);
});

test('missing measured yards stay pending while a measured zero and independent TD still grade', () => {
  const r = py(`
snap_rows = [snap, cle_sheet, no_sheet]
snaps = index_snaps(snap_rows)
values = ["", "NA", "NaN", "Infinity", "bad", "0"]
emit({
    "props": [grade_prop(leg, week, index_stats([dict(stats, rushing_yards=value)]), snaps, ctx)
              for value in values],
    "facts": facts(leg, [dict(stats, rushing_yards="NA")], snap_rows),
})
`);
  assert.deepEqual(r.props.slice(0, -1),
    Array.from({ length: 5 }, () => ['pending', null, 'missing_stat_value']));
  assert.deepEqual(r.props.at(-1), ['miss', 0, null]);
  assert.deepEqual(r.facts, { y: null, td: 1 });
});

test('unknown explicit game, wrong team, wrong season and absent final stay pending', () => {
  const r = py(`
emit({
    "unknown": facts(dict(leg, game_id="unknown"), [stats], [snap]),
    "team": facts(dict(leg, team="MIN"), [stats], [snap]),
    "season": facts(dict(leg, season=2025), [stats], [snap]),
    "team_only": facts(dict(leg, game_id=None), [stats], [snap]),
    "scheduled": facts(leg, [stats], [snap], context(games, {}, 2026, ids)),
    "empty_schedule": facts(leg, [stats], [snap], context([], finals, 2026, ids)),
})
`);
  for (const name of ['unknown', 'team', 'season', 'scheduled', 'empty_schedule']) {
    assertPending(r[name], name);
  }
  assert.deepEqual(r.team_only, { y: [0, 72, 5], td: 1 });
});

test('conflicting player IDs and ambiguous cross-team names prevent a DNP inference', () => {
  const r = py(`
conflicting_id = context(games, finals, 2026, identity_maps(
    roster + [dict(roster[0], gsis_id="00-0034444")]))
no_bridge = context(games, finals, 2026)
emit({
    "id_disagrees": facts(leg, [dict(stats, player_id="00-0034444")], [cle_sheet, no_sheet]),
    "crosswalk": facts(leg, [stats], [cle_sheet, no_sheet], conflicting_id),
    "same_name": facts(leg, [stats, dict(other_stats, player_id="00-0034444")],
                       [cle_sheet, no_sheet], no_bridge),
    "off_team_nickname": facts(leg, [dict(other_stats, player_display_name="Audy Estime")],
                               [cle_sheet, no_sheet], no_bridge),
    "unmapped_nickname": facts(leg, [dict(stats, player_display_name="Audy Estime",
                                         player_id=None, team="CLE", opponent_team="NO"),
                                    dict(other_stats, player_id="00-0034444",
                                         player_display_name="Other Runningback")],
                               [cle_sheet, no_sheet]),
})
`);
  for (const name of ['id_disagrees', 'crosswalk', 'same_name', 'off_team_nickname']) {
    assertPending(r[name], name);
  }
  assert.notEqual(r.unmapped_nickname.y, 'dnp');
  assert.notEqual(r.unmapped_nickname.td, 'dnp');
});

test('DNP requires a complete fixture sheet and no malformed player snap evidence', () => {
  const r = py(`
emit({
    "partial": facts(leg, [], [cle_sheet]),
    "complete": facts(leg, [], [cle_sheet, no_sheet]),
    "zero": facts(leg, [], [snap | {"offense_snaps": "0"}, cle_sheet, no_sheet]),
    "played": facts(leg, [], [snap, cle_sheet, no_sheet]),
    "malformed": [facts(leg, [], [dict(snap, offense_snaps=value), cle_sheet, no_sheet])
                  for value in (None, "", "unknown", "NaN", "Infinity", "-1")],
    "wrong_source_opponent": facts(leg, [dict(stats, opponent_team="NO")], [cle_sheet, no_sheet]),
    "unknown_source_fixture": facts(leg, [dict(stats, game_id="unknown")], [cle_sheet, no_sheet]),
    "indexed_missing": player_event_facts(leg, week, [], [],
        {"rows": [{"norm": "audric estime", "team": "CLE", "pos": "RB", "snaps": None}]}, ctx),
})
`);
  assertPending(r.partial);
  assert.equal(r.complete.y, 'dnp');
  assert.equal(r.complete.td, 'dnp');
  assert.deepEqual(r.played, { y: [0, 0, 0], td: 0 });
  for (const [index, fact] of r.malformed.entries()) assertPending(fact, `malformed case ${index}`);
  assertPending(r.wrong_source_opponent);
  assertPending(r.unknown_source_fixture);
  assertPending(r.indexed_missing);
  assert.equal(r.zero.td, 'dnp');
});

test('different verified player IDs on initial and surname matches do not prevent DNP', () => {
  const r = py(`
tyler = dict(leg, player="Tyler Johnson", gsis_id="00-0036427", position="WR")
ty = dict(stats, player_display_name="Ty Johnson", player_id="00-0035537", position="WR")
tez = dict(other_stats, player_display_name="Tez Johnson", player_id="00-0040237", position="WR")
ty_snap = dict(no_sheet, player="Ty Johnson", pfr_player_id="JohnTy00")
ty_ctx = context(games, finals, 2026, identity_maps(
    roster + [{"gsis_id": "00-0035537", "pfr_id": "JohnTy00"}]))
sheet = [cle_sheet, ty_snap]
emit({
    "known_aliases": facts(tyler, [ty, tez], sheet, ty_ctx),
    "unknown_alias": facts(tyler, [ty, dict(tez, player_id=None)], sheet, ty_ctx),
    "unknown_snap_id": facts(tyler, [ty], [cle_sheet, dict(ty_snap, pfr_player_id=None)], ty_ctx),
    "full_name_conflict": facts(tyler, [dict(ty, player_display_name="Tyler Johnson")], sheet, ty_ctx),
    "played_elsewhere": facts(tyler, [dict(tez, player_id=tyler["gsis_id"])], sheet, ty_ctx),
})
`);
  assert.deepEqual(r.known_aliases, { y: 'dnp', td: 'dnp' });
  assert.deepEqual(r.unknown_alias, { y: null, td: null, reason: 'identity_unverified' });
  assert.deepEqual(r.unknown_snap_id, r.unknown_alias);
  assert.deepEqual(r.full_name_conflict, { y: null, td: null, reason: 'identity_conflict' });
  assert.deepEqual(r.played_elsewhere, { y: null, td: null, reason: 'player_game_mismatch' });
});

test('an ID-only leg can use a verified stat row while optional feeds remain unknown', () => {
  const r = py(`
id_only = dict(leg, player=None, selection=None)
indexed = index_stats([stats]).get(week)
emit({
    "mapped": player_event_facts(id_only, week, indexed, None, None, ctx),
    "unknown": player_event_facts(id_only, week, indexed, None, None, context(games, finals, 2026)),
})
`);
  assert.deepEqual(r.mapped, { y: [0, 72, 5], td: null });
  assert.deepEqual(r.unknown, { y: null, td: null, reason: 'player_unidentified' });
});

test('a native player ID and explicit nflverse ID must agree', () => {
  const r = py(`
receipt = dict(leg, team="NO", gsis_id="00-0039373", nflverse_id="00-0039373")
emit({
    "same": facts(receipt, [stats], [snap, cle_sheet, no_sheet]),
    "conflict": facts(dict(receipt, gsis_id="00-0034444"), [stats], [snap, cle_sheet, no_sheet]),
})
`);
  assert.deepEqual(r.same, { y: [0, 72, 5], td: 1 });
  assert.deepEqual(r.conflict, { y: null, td: null, reason: 'identity_conflict' });
});

test('browser event facts take precedence and never look up a different game', () => {
  const facts = { season: 2026, weeks: { 9: {
    games: { old: { h: 'NO', a: 'CLE', hs: 28, as: 14 },
      new: { h: 'MIN', a: 'BUF', hs: 21, as: 24 } },
    players: { 'espn-1': { y: [0, 70, 0], td: 1 } },
    players_by_game: { old: { 'espn-1': { y: null, td: null, reason: 'player_game_mismatch' } },
      new: { 'espn-1': { y: [0, 70, 0], td: 1 } } },
  } } };
  const leg = { week: 9, game_id: 'old', team: 'CLE', gsis_id: 'espn-1',
    market: 'rb_rush_yds', line: 59.5 };
  assert.deepEqual(gradeLeg(leg, facts), {
    result: 'pending', actual: null, reason: 'player_game_mismatch',
  });
  assert.deepEqual(gradeLeg({ ...leg, market: 'anytime_td' }, facts), {
    result: 'pending', actual: null, reason: 'player_game_mismatch',
  });
  assert.equal(gradeLeg({ ...leg, team: 'MIN', game_id: 'new' }, facts).result, 'hit');
  assert.equal(gradeLeg({ ...leg, team: 'CLE', game_id: 'new' }, facts).result, 'pending');
  assert.equal(gradeLeg({ ...leg, team: 'MIN', game_id: 'missing' }, facts).result, 'pending');
  assert.equal(gradeLeg({ ...leg, team: 'MIN', game_id: 'new', season: 2025 }, facts).result, 'pending');
  assert.equal(gradeLeg({ ...leg, team: 'MIN', game_id: null }, facts).result, 'hit');
  assert.equal(gradeLeg(leg, { ...facts, weeks: { 9: {
    ...facts.weeks[9], players_by_game: {},
  } } }).result, 'pending');
});
