/* R106 — EVERY PARLAY REACHES A FINAL RESULT, AND ONLY ALL-HIT WINS.
 *
 * Owner, 2026-10-01: "partially hit parlays are considered a loss. It's only a
 * win if all of them hit. Some are still in this pending status from weeks
 * 1,2,3, and they should all be final." The RCA found three causes:
 *
 *  1. A missed leg beside a pending one left the parlay PENDING, though nothing
 *     the pending leg did could save it.
 *  2. A prop whose player did not play had no stat line and stayed pending
 *     forever (Darnold / Flowers / Harvey wk2, Nacua wk2-3, ...). The anytime-TD
 *     grader already read the snap sheet for that; the yardage grader did not.
 *  3. The review graded only the cards parlays.json held at one moment, and a
 *     leg only when the leg ledger had LOCKED it — but rebuilds after kickoff put
 *     187 cards into the wk2/wk3 archives whose legs the ledger first saw after
 *     kickoff (unlocked, never resolved). The archive now refuses a card built
 *     after its kickoff (r90_card_freeze locks that), and the review grades every
 *     archived card, any leg the ledger did not, from the same evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const py = (body) => JSON.parse(execFileSync('python3', ['-'], {
  cwd: ROOT, encoding: 'utf8', input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
}).trim().split('\n').pop());

test('one missed leg settles the parlay as a LOSS at once; only all-hit wins', () => {
  const r = py(`
from scripts.build_review import parlay_result, parlay_bucket
cases = [["hit", "miss", "pending"], ["miss", "pending"], ["hit", "pending"],
         ["hit", "miss"], ["hit", "void"], ["hit", "hit"], ["void", "miss"]]
print(json.dumps([[parlay_result(c), parlay_bucket(c)] for c in cases]))`);
  assert.deepEqual(r, [
    ['miss', 'partial'],      // already lost: a pending leg cannot save it
    ['miss', 'all_missed'],
    ['pending', 'pending'],   // no miss yet: genuinely undecided
    ['miss', 'partial'],      // partial is a loss
    ['void', 'push'],         // a voided leg drops out, the rest all hit
    ['hit', 'all_hit'],
    ['miss', 'all_missed'],
  ]);
});

test('a prop with no stat line reads the snap sheet: played -> miss at 0, absent -> void', () => {
  const r = py(`
from scripts.resolve_my_cards import grade_prop
by_week = {2: [{"name": "Other Guy", "norm": "other guy", "pos": "QB", "team": "SEA",
                "yards": {"QB": 250.0, "RB": 0.0, "WR": 0.0}}]}
snaps = {2: {"teams": {"SEA", "BAL"}, "rows": [
    {"norm": "zay flowers", "team": "BAL", "snaps": 41.0},
    {"norm": "drew lock", "team": "SEA", "snaps": 60.0}]}}
leg = lambda sel, team, player=None: {"position": "QB" if "pass" in sel else "WR",
    "selection": sel, "team": team, "line": 59.5 if "rec" in sel else 224.5, "player": player}
print(json.dumps({
  "dnp": grade_prop(leg("S. Darnold 225+ pass yds", "SEA"), 2, by_week, snaps),
  "played": grade_prop(leg("Z. Flowers 60+ rec yds", "BAL", "Zay Flowers"), 2, by_week, snaps),
  "no_sheet": grade_prop(leg("J. Jefferson 60+ rec yds", "MIN"), 2, by_week, snaps),
  "no_snaps": grade_prop(leg("S. Darnold 225+ pass yds", "SEA"), 2, by_week, None)}))`);
  assert.deepEqual(r.dnp, ['void', null, 'did_not_play'], 'on no published snap sheet row: void, never a loss');
  assert.deepEqual(r.played, ['miss', 0.0, null], 'played with no stat line: 0 yards, a miss');
  assert.deepEqual(r.no_sheet, ['pending', null, 'no_stat_line'], 'no sheet for his team: no call');
  assert.deepEqual(r.no_snaps, ['pending', null, 'no_stat_line'], 'no evidence at all: pending');
});

test('the review grades a leg the ledger recorded UNLOCKED, and every archived card of the week', () => {
  const r = py(`
from scripts import build_review as br
sched = {"G1": {"game_id": "G1", "home": "SF", "away": "LAR", "week": 1}}
finals = {"G1": {"home_score": 20, "away_score": 27, "status": "STATUS_FINAL"}}
stats = [{"season_type": "REG", "week": "1", "position": "QB", "player_display_name": "Brock Purdy",
          "team": "SF", "passing_yards": "205", "rushing_yards": "0", "receiving_yards": "0"}]
ledger = {"legs": [{"week": 1, "game_id": "G1", "market": "qb_pass_yds", "selection": "B. Purdy 225+ pass yds",
                    "player": "Brock Purdy", "team": "SF", "side": "home", "line": 224.5, "locked": False}]}
g = br.direct_leg_grader(sched, finals, stats, None, ledger)
card = {"parlay_id": "G1-g1", "game_id": "G1", "scope": "game", "legs": [
  {"market": "qb_pass_yds", "selection": "B. Purdy 225+ pass yds", "side": "home", "line": 224.5},
  {"market": "spread", "selection": "LAR -3.5", "side": "away"}]}
row = br.review_parlay(card, 1, {}, {}, {}, {}, g)
print(json.dumps({"legs": [[l["result"], l["actual"], l["why"]] for l in row["legs"]],
                  "result": row["result"], "bucket": row["bucket"]}))`);
  assert.deepEqual(r.legs[0], ['miss', 205.0, 'graded: miss'], 'the stat line grades the unlocked leg');
  assert.deepEqual(r.legs[1], ['hit', { home_score: 20, away_score: 27 }, 'graded: hit'],
    'LAR won by 7 and covered -3.5');
  assert.equal(r.result, 'miss');
  assert.equal(r.bucket, 'partial', 'one hit, one miss: a partial, which is a loss');
});
