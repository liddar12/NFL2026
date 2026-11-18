import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = `
import json
from scripts import build_review as review, resolve_parlay_legs as ledger
from scripts.player_outcomes import context

week = 10
old_game = {"game_id": "401873062", "week": week, "home": "LV", "away": "SEA"}
new_game = {"game_id": "401873060", "week": week, "home": "GB", "away": "MIN"}
games = [old_game, new_game]
sched = {g["game_id"]: g for g in games}
finals = {g["game_id"]: {"home_score": 14, "away_score": 21, "status": "STATUS_FINAL"} for g in games}
ctx = context(games, finals, 2026)
old_leg = {"game_id": old_game["game_id"], "week": week, "season": 2026, "home": "LV", "away": "SEA",
           "player": "Kirk Cousins", "gsis_id": "00-0029604", "team": "LV", "side": "home",
           "position": "QB", "market": "qb_pass_yds", "selection": "K. Cousins 200+ pass yds",
           "line": 199.5, "locked": True, "p_team": 0.5, "model_prob": 0.6}
new_leg = dict(old_leg, game_id=new_game["game_id"], home="GB", away="MIN", team="MIN", side="away")
stats = {"game_id": "2026_10_MIN_GB", "season": "2026", "week": "10", "season_type": "REG",
         "team": "MIN", "opponent_team": "GB", "position": "QB", "player_id": "00-0029604",
         "player_display_name": "Kirk Cousins", "passing_yards": "207"}
pledger = {"legs": [old_leg, new_leg]}

def emit(value):
    print(json.dumps(value))
`;

function py(source) {
  return JSON.parse(execFileSync('python3', ['-B', '-'], {
    encoding: 'utf8', cwd: root, input: fixture + source,
  }).trim());
}

test('published slate props resolve only against the selected fixture', () => {
  const r = py(`
# A week/team-only lookup can accept this row, but its source game contradicts
# the recorded fixture. Test that condition separately from a normal trade.
invalid = dict(stats, team="LV", opponent_team="SEA")
resolved, pending, _ = ledger.resolve_props(pledger, [stats], ctx)
invalid_resolved, invalid_pending, _ = ledger.resolve_props({"legs": [old_leg]}, [invalid], ctx)
emit([resolved, pending, invalid_resolved, invalid_pending])
`);
  assert.deepEqual(r[0].map(l => [l.game_id, l.actual, l.hit]), [['401873060', 207, true]]);
  assert.deepEqual(r[1].map(l => [l.game_id, l.reason]), [['401873062', 'player_game_mismatch']]);
  assert.deepEqual(r[2], []);
  assert.equal(r[3][0].reason, 'source_game_conflict');
});

test('archived slate regrades from game evidence and ignores unmarked cached prop outcomes', () => {
  const r = py(`
direct = review.direct_leg_grader(sched, finals, [stats], None, pledger, ctx)
stale = {"resolved": [dict(old_leg, actual=207, hit=True),
                      dict(old_leg, market="moneyline", selection="LV ML", hit=False)]}
scoped = {"grading_policy": ledger.GRADING_POLICY, "resolved": [dict(new_leg, actual=207, hit=True)]}
old_card = {"parlay_id": "old", "scope": "game", "game_id": old_game["game_id"], "legs": [old_leg]}
new_card = {"parlay_id": "new", "scope": "game", "game_id": new_game["game_id"], "legs": [new_leg]}
old_outcomes = review.leg_outcomes_from_ledger(stale, event_bound=True)
new_outcomes = review.leg_outcomes_from_ledger(scoped, event_bound=True)
emit({
    "old": review.review_parlay(old_card, week, old_outcomes, direct=direct)["legs"],
    "new": review.review_parlay(new_card, week, new_outcomes, direct=direct)["legs"],
    "old_moneyline": old_outcomes[week, old_game["game_id"], "moneyline", "LV ML"],
    "wrong_gid": review.leg_game_id(dict(old_leg, game_id="missing"), None, week, {}, {}),
    "wrong_card": review.leg_game_id(new_leg, old_game["game_id"], week, {}, {}),
    "unbound": review.leg_game_id({"market": old_leg["market"], "selection": old_leg["selection"]},
        None, week, {(week, old_leg["market"], old_leg["selection"]): None}, {}),
})
`);
  assert.deepEqual(r.old.map(l => [l.result, l.actual, l.why]),
    [['pending', null, 'pending: player_game_mismatch']]);
  assert.deepEqual(r.new.map(l => [l.result, l.actual, l.why]), [['hit', 207, 'ledger: hit']]);
  assert.equal(r.old_moneyline.hit, false);
  assert.equal(r.wrong_gid, 'missing');
  assert.equal(r.wrong_card, null);
  assert.equal(r.unbound, null);
});
