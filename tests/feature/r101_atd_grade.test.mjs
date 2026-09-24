/* tests/feature/r101_atd_grade.test.mjs — R101 (R99 E1-S6): grading anytime-TD legs.
 *
 * scripts/resolve_parlay_legs.grade_atd, used by every ledger that carries an ATD
 * leg (MY cards now). Locked here:
 *   AC1 the outcomes: hit (a stat line with >= 1 rush/rec TD), miss (a stat line
 *       with none, or no stat line but >= 1 offensive snap), void (his team's snap
 *       sheet is published and he is not on it — did not play, never a loss),
 *       pending (no evidence either way — never a miss, never a void);
 *   AC2 the owner's 63 transcribed ATD player-games (weeks 1-2, 2026) regrade to
 *       the screenshots' results from public nflverse rows — all but one, named:
 *       Caleb Williams wk2 was voided by the book although he played (a book-side
 *       void no data can reproduce), and grades a miss here;
 *   resolve_my_cards routes an ATD leg to this grader, and leaves it pending with
 *   no TD index rather than guessing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\nfrom scripts.resolve_parlay_legs import grade_atd, index_td, index_snaps, read_csv\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('R101 S6 AC1: hit / miss / void / pending, each only on its evidence', () => {
  const r = py(`
td = index_td([
  {"player_display_name": "Alpha Back", "position": "RB", "team": "LA", "week": "3", "season_type": "REG", "rushing_tds": "2", "receiving_tds": ""},
  {"player_display_name": "Beta Wide", "position": "WR", "team": "LA", "week": "3", "season_type": "REG", "rushing_tds": "0", "receiving_tds": "0"}])
snaps = index_snaps([
  {"player": "Gamma Tight", "team": "LA", "week": "3", "game_type": "REG", "offense_snaps": "31"},
  {"player": "Alpha Back", "team": "LA", "week": "3", "game_type": "REG", "offense_snaps": "50"}])
cases = {
  "hit": grade_atd({"player": "Alpha Back", "team": "LAR"}, 3, td, snaps),
  "miss_line": grade_atd({"player": "Beta Wide", "team": "LAR"}, 3, td, snaps),
  "miss_snaps": grade_atd({"player": "Gamma Tight", "team": "LAR"}, 3, td, snaps),
  "void": grade_atd({"player": "Delta Out", "team": "LAR"}, 3, td, snaps),
  "no_sheet": grade_atd({"player": "Delta Out", "team": "LAR"}, 3, td, None),
  "other_team_sheet": grade_atd({"player": "Eps Away", "team": "SF"}, 3, td, snaps),
  "week_unpublished": grade_atd({"player": "Alpha Back", "team": "LAR"}, 4, td, snaps),
  "unidentified": grade_atd({"player": "", "team": "LAR"}, 3, td, snaps)}
print(json.dumps(cases))`);
  assert.deepEqual(r.hit.slice(0, 2), ['hit', { tds: 2 }]);
  assert.deepEqual(r.miss_line.slice(0, 2), ['miss', { tds: 0 }]);
  assert.equal(r.miss_snaps[0], 'miss', 'played, no stat line: a TD needs a touch, so no TD');
  assert.deepEqual(r.void, ['void', null, 'did_not_play']);
  assert.deepEqual(r.no_sheet, ['pending', null, 'no_stat_line'], 'no snap sheet: never a void');
  assert.equal(r.other_team_sheet[0], 'pending', "another team's sheet proves nothing about his");
  assert.deepEqual(r.week_unpublished, ['pending', null, 'week_not_published']);
  assert.equal(r.unidentified[0], 'pending');
});

test("R101 S6 AC2: the owner's 63 ATD player-games regrade to the screenshots (one named book void)", () => {
  const r = py(`
from scripts.resolve_estimates import norm_name
td = index_td(read_csv("tests/fixtures/r101/owner_atd_stats_2026.csv"))
snaps = index_snaps(read_csv("tests/fixtures/r101/owner_atd_snaps_2026.csv"))
doc = json.load(open("docs/backlog/evidence/2026_owner_fanduel_slips.json"))
def wk(date):
    if date.startswith("W"): return int(date[1:])
    return 1 if int(date.split("/")[1]) <= 15 else 2
seen = {}
for t in doc["tickets"]:
    for l in t["legs"]:
        if l["market"] != "ATD" or l["result"] == "?":
            continue
        key = (l["player"], l["team"], wk(l["date"]))
        got = grade_atd({"player": l["player"], "team": l["team"]}, key[2], td, snaps)[0]
        seen["|".join(map(str, key))] = [{"W": "hit", "L": "miss", "V": "void"}[l["result"]], got]
bad = {k: v for k, v in seen.items() if v[0] != v[1]}
print(json.dumps({"n": len(seen), "bad": bad, "hits": sum(1 for v in seen.values() if v[1] == "hit")}))`);
  assert.equal(r.n, 63);
  assert.deepEqual(r.bad, { 'Caleb Williams|CHI|2': ['void', 'miss'] },
    'every other transcribed result is reproduced from public data');
  assert.ok(r.hits >= 25, `hits ${r.hits}`);
});

test('R101 S6: resolve_my_cards routes ATD legs to the grader, pending without a TD index', () => {
  const r = py(`
from scripts.resolve_my_cards import grade_card
card = {"card_id": "c1", "dial": "even", "n_legs": 1, "legs": [
  {"market": "anytime_td", "selection": "A. Back anytime TD", "player": "Alpha Back", "team": "LAR",
   "game_id": "g1", "model_prob": 0.4}]}
td = index_td([{"player_display_name": "Alpha Back", "position": "RB", "team": "LA", "week": "3",
                "season_type": "REG", "rushing_tds": "1", "receiving_tds": "0"}])
with_idx = grade_card(card, 3, {}, {}, {"td": td, "snaps": None})
without = grade_card(card, 3, {}, {}, None)
print(json.dumps({"with": [with_idx["result"], with_idx["legs"][0]["result"]],
                  "without": [without["result"], without["legs"][0]["result"]]}))`);
  assert.deepEqual(r.with, ['hit', 'hit']);
  assert.deepEqual(r.without, ['pending', 'pending'], 'no index: pending, never a miss');
});
