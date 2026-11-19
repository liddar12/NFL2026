import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = `
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from scripts import build_review as review

os.environ.pop("NFL_GRADING_CAPTURE_DIR", None)
season = 2026
now = "2026-09-17T12:00:00Z"

def game(gid, home, away, week=1):
    return {"game_id": gid, "home": home, "away": away, "week": week,
            "kickoff_utc": "2026-09-10T00:20Z", "status": "STATUS_FINAL"}

def verified(fixture, hs, away_score):
    f = {**fixture, "final_source": "espn_final"}
    f["final"] = {"home_score": hs, "away_score": away_score,
                  "winner": f["home"] if hs > away_score else f["away"] if away_score > hs else None}
    return f

def summary(doc):
    return {g["game_id"]: g["final"] for w in doc["weeks"].values() for g in w["games"]}
`;

function py(source) {
  return JSON.parse(execFileSync('python3', ['-B', '-'], {
    cwd: root, encoding: 'utf8', input: fixture + source,
  }).trim());
}

test('partial, failed and empty live refreshes preserve prior verified scores', () => {
  const result = py(`
first = game("first", "SEA", "NE")
second = game("second", "NO", "CLE")
schedule = {"season": season, "games": [first, second]}
previous = {"season": season, "weeks": {"1": {"games": [verified(first, 17, 14),
                                                        verified(second, 28, 17)]}}}
fresh = [{**first, "home_score": 21, "away_score": 14}]
with TemporaryDirectory() as folder:
    data = Path(folder, "data")
    data.mkdir()
    (data / "schedule_full.json").write_text(json.dumps(schedule))
    (data / "review.json").write_text(json.dumps(previous))
    snapshots = data / "snapshots"
    snapshots.mkdir()
    (snapshots / "2026_wk01_games_open.json").write_text(json.dumps([
        {"event_id": "first", "event_type": "game", "probs": [0.55, 0.45],
         "resolved": True, "actual": 0},
        {"event_id": "second", "event_type": "game", "probs": [0.55, 0.45],
         "resolved": True, "actual": 0},
    ]))
    stats = data / "stats.csv"
    stats.write_text("player_display_name,team,week,position\\n")
    outcomes = []
    with patch("scripts.scrape.espn.fetch_scores",
               side_effect=[fresh, RuntimeError("ESPN down"), []]):
        for _ in range(3):
            inputs = review.load_inputs(root=folder, stats_csv=str(stats))
            doc = review.build(inputs, now)
            review.write(doc, data / "review.json")
            outcomes.append({"scores": summary(doc), "sources": doc["sources"], "notes": doc["notes"]})
    offline = review.build(review.load_inputs(root=folder, offline=True), now)
    print(json.dumps({"outcomes": outcomes, "offline": summary(offline)}))
`);
  const scores = {
    first: { home_score: 21, away_score: 14, winner: 'SEA' },
    second: { home_score: 28, away_score: 17, winner: 'NO' },
  };
  for (const row of result.outcomes) assert.deepEqual(row.scores, scores);
  assert.deepEqual(result.offline, scores);
  assert.match(result.outcomes[0].sources.finals, /1 verified FINAL scores retained/);
  for (const row of result.outcomes.slice(1)) {
    assert.match(row.sources.finals, /2 verified FINAL scores retained/);
    assert.ok(row.notes.some(note => note.includes('no verified FINAL scores from espn')));
  }
  assert.ok(result.outcomes[1].notes.some(note => note.includes('ESPN down')));
});

test('retention refuses conflicting fixture identities and unverifiable results', () => {
  const result = py(`
first = game("first", "SEA", "NE")
second = game("second", "NO", "CLE")
third = game("third", "BUF", "MIN")
fourth = game("fourth", "SF", "DAL")
fifth = game("fifth", "LV", "GB", week=2)
schedule = {"season": season, "games": [first, second, third, fourth, fifth]}
rows = [verified(first, 21, 14),
        verified(dict(second, home="CLE", away="NO"), 10, 31),
        dict(verified(third, 26, 23), status="STATUS_IN_PROGRESS"),
        dict(verified(fourth, 30, 13), final_source="lock_receipt"),
        verified(fifth, 20, 7)]
previous = {"season": season, "weeks": {"1": {"games": rows}}}
fresh = [{**first, "season": 2025, "home_score": 52, "away_score": 0},
         {**first, "away": "CLE", "home_score": 52, "away_score": 0},
         {**first, "status": "STATUS_IN_PROGRESS", "home_score": 52, "away_score": 0}]
retained = review.merge_review_finals(schedule, season, previous, fresh)
old_season = review.merge_review_finals(schedule, season, dict(previous, season=2025), [])
print(json.dumps({"retained": retained, "old_season": old_season}))
`);
  assert.deepEqual(result.retained, [[{
    game_id: 'first', home_score: 21, away_score: 14, status: 'STATUS_FINAL',
  }], 1, 0]);
  assert.deepEqual(result.old_season, [[], 0, 0]);
});
