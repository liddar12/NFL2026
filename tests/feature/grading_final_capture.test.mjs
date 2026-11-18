import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = String.raw`
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from scripts import build_review, capture_grading_inputs as C, refit, resolve_estimates, resolve_locks
from scripts import resolve_my_cards, resolve_parlay_legs
from scripts.harness import snapshot
from scripts.player_outcomes import load_context

ENV = "NFL_GRADING_CAPTURE_DIR"
NOW = "2026-09-23T00:00:00Z"
LOCKED = "2026-09-01T00:00:00Z"
SEASON = 2026
os.environ.pop(ENV, None)

def game(gid, week, home, away):
    start = {1: "2026-09-10T00:20Z", 2: "2026-09-18T00:20Z", 18: "2027-01-10T05:00Z"}[week]
    return {"game_id": gid, "week": week, "home": home, "away": away,
            "kickoff_utc": start, "status": "STATUS_SCHEDULED"}

def board(week, *events):
    return json.dumps({"season": {"year": SEASON, "type": 2}, "week": {"number": week},
                       "events": events}).encode()

def event(game, status="STATUS_FINAL", home_score="24", away_score="14"):
    state = {"type": {"name": status, "completed": status == "STATUS_FINAL"}}
    return {"id": game["game_id"], "date": game["kickoff_utc"], "status": state,
            "competitions": [{"status": state, "competitors": [
                {"homeAway": "home", "score": home_score, "team": {"abbreviation": game["home"]}},
                {"homeAway": "away", "score": away_score, "team": {"abbreviation": game["away"]}},
            ]}]}

def prior(*games):
    weeks = {}
    for g in games:
        weeks.setdefault(str(g["week"]), {"games": []})["games"].append({
            **g, "status": "STATUS_FINAL", "final_source": "espn_final",
            "final": {"home_score": 11, "away_score": 17},
        })
    return {"season": SEASON, "generated_utc": "2026-09-21T00:00:00Z", "weeks": weeks}

def lock(game):
    return snapshot.make_row(game["game_id"], "game", "test", LOCKED, LOCKED, probs=[0.6, 0.4],
                             estimate=False, kickoff_utc=game["kickoff_utc"], status="STATUS_SCHEDULED")

def no_network(*args, **kwargs):
    raise AssertionError("a captured grading consumer attempted a live score fetch")

def use(root, boards, fixtures, previous=None, cache_name="capture", requested_prior=True, stats=None):
    data = root / "data"
    data.mkdir(exist_ok=True)
    schedule = data / "schedule_full.json"
    schedule.write_text(json.dumps({"season": SEASON, "updated_utc": LOCKED, "games": fixtures}) + "\n")
    review = data / "review.json"
    if previous is not None:
        review.write_text(json.dumps(previous) + "\n")
    calls = []
    def transport(url, **kwargs):
        if stats is not None and url.endswith("stats_player_week_2026.csv"):
            return 200, stats
        if "espn.com" not in url:
            return 404, b""
        week = int(parse_qs(urlsplit(url).query)["week"][0])
        calls.append(week)
        answer = boards[week]
        if isinstance(answer, BaseException):
            raise answer
        return answer
    cache = root / cache_name
    with patch.object(C, "_utc_now", return_value=NOW):
        C.capture(SEASON, cache, schedule_path=schedule,
                  prior_review_path=review if requested_prior else None, transport=transport, sleep=lambda _: None)
    return data, cache, calls

def fails(error, detail, call):
    try:
        call()
    except error as exc:
        assert detail in str(exc), str(exc)
    else:
        raise AssertionError(f"expected {error.__name__} containing {detail!r}")
`;

function run(body) {
  const code = fixture + '\nwith TemporaryDirectory() as folder:\n    work = Path(folder)\n'
    + body.trim().split('\n').map(line => `    ${line}`).join('\n');
  execFileSync('python3', ['-B', '-'], { cwd: root, input: code, encoding: 'utf8' });
}

test('one immutable raw scoreboard supplies FINAL scores, live status, and event identity across graders', () => {
  run(String.raw`
finished = game("finished", 1, "SEA", "NE")
corrected = game("corrected", 1, "SF", "DAL")
live = game("live", 2, "NO", "CLE")
historical = game("historical", 2, "BUF", "MIN")
unknown = game("unknown", 2, "PIT", "BAL")
future = game("future", 18, "HOU", "TEN")
raw = board(1, event(finished), event(corrected))
data, cache, calls = use(work, {1: (200, raw), 2: (200, board(2, event(live, "STATUS_IN_PROGRESS")))},
                         [finished, corrected, live, historical, unknown, future], prior(historical, corrected))
assert calls == [1, 2]
assert (cache / "scoreboard_week_01.json").read_bytes() == raw
assert (cache / C.SCHEDULE).read_bytes() == (data / C.SCHEDULE).read_bytes()
assert (cache / C.PRIOR_REVIEW).read_bytes() == (data / "review.json").read_bytes()
document = C.read_final_scores(cache, SEASON)
assert document["schedule_sha256"] == hashlib.sha256((data / C.SCHEDULE).read_bytes()).hexdigest()
assert document["complete_weeks"] == [1]
scores = {g["game_id"]: g for g in document["games"]}
assert scores["finished"]["home_score"] == 24 and scores["finished"]["observed_utc"] == NOW
assert scores["finished"]["raw_sha256"] == hashlib.sha256(raw).hexdigest()
assert scores["finished"]["final_utc"] is None and scores["finished"]["upstream_updated_utc"] is None
assert scores["historical"]["grading_source"] == "verified_prior_review"
assert scores["historical"]["observed_utc"] is None
assert document["statuses"]["live"] == "STATUS_IN_PROGRESS"
assert document["coverage"][1]["unknown_game_ids"] == ["historical", "unknown"]
assert "1 verified prior review FINAL retained" in document["source"]

# Change the working copies and add a winner-only lock. All consumers use the frozen data.
(data / C.SCHEDULE).write_text(json.dumps({"season": SEASON, "games": []}))
(data / "review.json").write_text(json.dumps(prior(live)))
snapshots = data / "snapshots"
snapshots.mkdir()
first_path = snapshots / "2026_wk01_games_open.json"
second_path = snapshots / "2026_wk02_games_open.json"
wrong_season = snapshots / "2025_wk01_games_open.json"
corrected_receipt = snapshot.resolve(lock(corrected), 1)
first_path.write_text(json.dumps([lock(finished), corrected_receipt]))
second_path.write_text(json.dumps([snapshot.resolve(lock(live), 0), lock(historical), lock(finished),
                                   snapshot.resolve(lock(unknown), 0)]))
wrong_season.write_text(first_path.read_text())
(data / "parlay_leg_scores.json").write_text(json.dumps({"finals_source": "older generation",
    "grading_policy": "event_bound_v1", "resolved": [
        {"week": 2, "game_id": "live", "market": "moneyline", "selection": "NO ML", "hit": True}
    ]}))
(data / "estimate_scores.json").write_text(json.dumps({"source": "older generation", "resolved": [{"week": 2}]}))
(data / "model_tuning.json").write_text(json.dumps({"history": [
    {"kind": "game_params", "search": "previous", "n_resolved": 2, "generated_utc": LOCKED}
]}))
os.environ[ENV] = str(cache)
with patch("scripts.scrape.espn.fetch_scores", side_effect=no_network), \
     patch("scripts.scrape.espn.fetch_final_results", side_effect=no_network), \
     patch.object(snapshot, "SNAPSHOT_DIR", str(snapshots)):
    finals, label = resolve_parlay_legs.load_finals(season=SEASON, weeks=[1, 2],
        review_path=data / "review.json", snapshot_glob=str(snapshots / "*.json"))
    assert finals == {"finished": {"home_score": 24, "away_score": 14},
                      "corrected": {"home_score": 24, "away_score": 14},
                      "historical": {"home_score": 11, "away_score": 17}}
    assert label == document["source"]
    ctx = load_context(data, SEASON, {"live": {"winner": "home"}})
    assert ctx["games"][(1, "finished")]["home"] == "SEA"
    assert not ctx["games"][(2, "live")]["final"]
    assert resolve_locks.main() == 0
    finished_lock, unchanged_corrected = json.loads(first_path.read_text())
    assert finished_lock["actual"] == 0 and unchanged_corrected == corrected_receipt
    live_lock, prior_lock, wrong_week, unchanged_unknown = json.loads(second_path.read_text())
    assert live_lock["actual"] == 0 and prior_lock["actual"] == 1 and not wrong_week["resolved"]
    assert unchanged_unknown["actual"] == 0
    assert not json.loads(wrong_season.read_text())[0]["resolved"]
    assert {r["event_id"] for r in refit._collect_resolved_rows("game", document)} == {"finished", "historical"}
    inputs = build_review.load_inputs(root=work)
    assert inputs["leg_scores"] is None and inputs["estimate_scores"] is None
    assert any("parlay leg scores omitted" in note for note in inputs["notes"])
    assert any("estimate scores omitted" in note for note in inputs["notes"])
    review = build_review.build(inputs, NOW)
    games = {g["game_id"]: g for week in review["weeks"].values() for g in week["games"]}
    assert games["finished"]["final"]["home_score"] == 24
    assert games["live"]["status"] == "STATUS_IN_PROGRESS"
    assert games["live"]["final"] is None and games["live"]["result"] is None
    assert games["unknown"]["final"] is None and games["unknown"]["status"] is None
    assert games["historical"]["final"]["away_score"] == 17
    assert review["learning"]["graded_locks_total"] == 2
    assert review["learning"]["consumed_all"] is None
    fails(C.CaptureError, "cannot override", lambda: resolve_parlay_legs.load_finals("other.json", season=SEASON))
    fails(C.CaptureError, "stats CSV cannot override", lambda: build_review.load_inputs(
        root=work, stats_csv="other.csv"))
    fails(C.CaptureError, "stats CSV cannot override", lambda: resolve_my_cards.run(
        season=SEASON, cards_dir=data, dry_run_csv="other.csv", out_path=data / "never.json"))
    assert not (data / "never.json").exists()
    assert C.capture(SEASON, cache, transport=no_network)["version"] == 2
`);
});

test('missing weeks remain unknown, and captured nonfinal and conflicting fixtures cannot use prior FINAL', () => {
  run(String.raw`
one = game("one", 1, "SEA", "NE")
two = game("two", 2, "NO", "CLE")
data, cache, calls = use(work, {1: (404, b""), 2: (200, board(2))}, [one, two], prior(one))
assert calls == [1, 2]
doc = C.read_final_scores(cache)
assert [r["game_id"] for r in doc["games"]] == ["one"]
assert [(c["week"], c["http_status"], c["unknown_game_ids"]) for c in doc["coverage"]] == [
    (1, 404, ["one"]), (2, 200, ["two"])]
assert "wk 2: HTTP 200, 1 unknown" in doc["source"]

for label, raw in (
    ("live", board(1, event(one, "STATUS_IN_PROGRESS"))),
    ("other-team", board(1, event(dict(one, away="CLE")))),
    ("other-id", board(1, event(dict(one, game_id="changed")))),
    ("contradictory", board(1, event(one), event(one, home_score="99"))),
    ("unusable-final", board(1, event(one, home_score="NA"))),
):
    fails(C.CaptureError, "contradicts previously verified FINAL", lambda:
          use(work, {1: (200, raw)}, [one], prior(one), cache_name=label))
    assert not list((work / label).iterdir())
wrong = prior(one)
wrong["weeks"]["1"]["games"][0]["home"] = "NE"
_, rejected_prior, _ = use(work, {1: (404, b"")}, [one], wrong, cache_name="wrong-prior")
assert C.read_final_scores(rejected_prior)["games"] == []
bad_nested_id = event(one)
bad_nested_id["competitions"][0]["id"] = "another-game"
bad_nested_date = event(one)
bad_nested_date["competitions"][0]["date"] = "2026-09-12T00:20Z"
bad_state = event(one)
bad_state["status"]["type"]["state"] = "in"
for n, bad in enumerate((bad_nested_id, bad_nested_date, bad_state)):
    _, nested, _ = use(work, {1: (200, board(1, bad))}, [one], cache_name=f"nested-{n}",
                       requested_prior=False)
    read = C.read_final_scores(nested)
    assert read["games"] == [] and read["coverage"][0]["conflicting_game_ids"] == ["one"]
`);
});

test('invalid scoreboard periods, upstream timeouts, and tampered frozen bytes fail closed', () => {
  run(String.raw`
fixture = game("one", 1, "SEA", "NE")
fails(C.CaptureError, "scoreboard_period_mismatch", lambda:
      use(work, {1: (200, board(2, event(fixture)))}, [fixture], cache_name="wrong-week"))
assert not list((work / "wrong-week").iterdir())
fails(C.CaptureError, "fixture transport timeout", lambda:
      use(work, {1: TimeoutError("fixture transport timeout")}, [fixture], cache_name="timeout"))
assert not list((work / "timeout").iterdir())
_, cache, _ = use(work, {1: (200, board(1, event(fixture)))}, [fixture])
for member in ("scoreboard_week_01.json", C.SCHEDULE):
    path = cache / member
    original = path.read_bytes()
    path.write_bytes(original + b" ")
    fails(C.CaptureTampered, member, lambda: C.read_final_scores(cache))
    path.write_bytes(original)
fails(C.CaptureTampered, "expected 2025", lambda: C.read_final_scores(cache, 2025))
`);
});

test('a weekly estimate stays pending until the captured results cover its entire week', () => {
  run(String.raw`
first = game("first", 1, "SF", "DAL")
second = game("second", 2, "SF", "NE")
live = game("live", 2, "NO", "CLE")
stats = (
    b"season,week,game_id,team,opponent_team,player_id,position,player_display_name,"
    b"passing_yards,rushing_yards,receiving_yards,rushing_tds,receiving_tds,fantasy_points_ppr\n"
    b"2026,01.0,2026_01_DAL_SF,SF,DAL,00-0123456,RB,A.J. Back,0,85,0,1,0,14.5\n"
    b"2026,2,2026_02_NE_SF,SF,NE,00-0123456,RB,A.J. Back,0,115,0,2,0,23.5\n")
data, cache, _ = use(work, {1: (200, board(1, event(first))),
    2: (200, board(2, event(second), event(live, "STATUS_IN_PROGRESS")))},
    [first, second, live], stats=stats)
ledger = data / "ledger.json"
ledger.write_text(json.dumps(resolve_estimates._fixture_ledger()))
with patch.object(resolve_estimates, "ledger_path", return_value=str(ledger)), \
     patch.object(resolve_estimates.meta_record, "set_record"):
    result = resolve_estimates.run(season=SEASON, cache_dir=cache,
                                   out_path=data / "scores.json", meta_path=data / "meta.json", now=NOW)
assert [row["week"] for row in result["resolved"]] == [1]
assert result["resolved"][0]["actual"] == 14.5
assert "ESPN grading capture" in result["source"]
`);
});
