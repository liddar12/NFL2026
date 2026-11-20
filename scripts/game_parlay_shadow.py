#!/usr/bin/env python3
"""Freeze the walk-forward Game parlay challenger and report graded results."""
from collections import defaultdict
from datetime import datetime, timezone
from math import exp, isfinite, log
from pathlib import Path
import argparse
import json
import random
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.grade_observed_parlays import read_observation
from scripts.build_weekly import injury_source_state
from scripts.learning_receipts import fingerprint, instant
from scripts.models import parlay_builder as builder

POLICY = "game_market_blend_prior_market_offset_v1"
PROPS = {"qb_pass_yds", "rb_rush_yds", "wr_rec_yds"}
MARKETS = PROPS | {"moneyline", "spread"}
ORIGIN = "https://nfl2026.netlify.app"


def show(commit, path):
    return json.loads(subprocess.check_output(["git", "-C", str(ROOT), "show", f"{commit}:{path}"]))


def log_odds(p):
    p = max(.000001, min(.999999, p))
    return log(p / (1 - p))


def model_log_odds(leg):
    score = log_odds(leg["model_prob"])
    market = leg.get("implied_prob")
    if (leg["market"] == "moneyline" and leg.get("price_source") == "fair_market"
            and type(market) in (float, int) and 0 < market < 1):
        score = .75 * score + .25 * log_odds(market)
    return score


def sigmoid(x):
    return 1 / (1 + exp(-x))


def fit(rows):
    markets = defaultdict(list)
    for leg, y in rows:
        markets[leg["market"]].append((model_log_odds(leg), y))
    offsets = {}
    for market, predictions in markets.items():
        if len(predictions) < 20:
            continue
        offset = 0.
        for _ in range(10):
            fitted = [(sigmoid(score + offset), y) for score, y in predictions]
            offset -= (sum(p - y for p, y in fitted) + 40 * offset) / (sum(p * (1 - p) for p, _ in fitted) + 40)
        offsets[market] = max(-.75, min(.75, offset))
    return offsets


def eligible(leg):
    p = leg.get("model_prob")
    return leg.get("market") in MARKETS and type(p) in (int, float) and isfinite(p) and 0 <= p <= 1


def grading_inputs(commit):
    review = show(commit, "data/review.json")
    scores = show(commit, "data/parlay_leg_scores.json")
    exclusions = show(commit, "config/excluded_games.json")["games"]
    return review, prop_facts(review, scores), {(row["week"], str(row["game_id"])) for row in exclusions
                                              if row["season"] == review["season"]}


def prop_facts(review, scores):
    facts = defaultdict(set)
    for row in scores["resolved"]:
        if row["market"] in PROPS and type(row["hit"]) is bool:
            facts[row["week"], str(row["game_id"]), row["market"], row["selection"], row.get("line")].add(int(row["hit"]))
    for week, data in review["weeks"].items():
        for card in data["parlays"]:
            for leg in card["legs"]:
                if leg["market"] not in PROPS or not leg.get("game_id"):
                    continue
                match = re.search(r"(?:^|\s)(\d+)\+(?=\s|$)", leg["selection"])
                status = leg["result"]
                if match and status in {"hit", "miss", "void"}:
                    key = int(week), str(leg["game_id"]), leg["market"], leg["selection"], int(match[1]) - .5
                    facts[key].add({"hit": 1, "miss": 0, "void": None}[status])
    return facts


def leg_result(leg, week, gid, game, facts, excluded):
    if (week, gid) in excluded or not game or not game.get("final"):
        return None
    result = game["final"]
    market, selection = leg["market"], leg["selection"]
    if market == "moneyline":
        team = selection.removesuffix(" ML")
        return int(result["winner"] == team) if result.get("winner") and team in (game["home"], game["away"]) else None
    if market == "spread":
        line, side = leg.get("line"), leg.get("side")
        if type(line) not in (int, float) or side not in ("home", "away"):
            return None
        margin = result[f"{side}_score"] - result["away_score" if side == "home" else "home_score"] + line
        return int(margin > 0) if margin else None
    observed = facts[week, gid, market, selection, leg.get("line")]
    return next(iter(observed)) if len(observed) == 1 else None


def original_training(commit, schedule, current_week, review, facts, excluded):
    rows = []
    for week in range(1, current_week):
        fixtures = {str(g["game_id"]): g for g in schedule["games"] if g["week"] == week}
        games = {str(g["game_id"]): g for g in review["weeks"].get(str(week), {}).get("games", [])}
        if not fixtures or len(games) != len(fixtures) or any(not g.get("final") for g in games.values()):
            continue
        kickoff = min(instant(g["kickoff_utc"]) for g in fixtures.values())
        origin = subprocess.check_output(["git", "-C", str(ROOT), "log", "-1", "--first-parent",
            "--format=%H", f"--before={kickoff.isoformat()}", commit, "--", "data/parlays.json"]).decode().strip()
        if not origin:
            continue
        prior = show(origin, "data/parlays.json")
        if prior["week"] != week or prior["season"] != schedule["season"]:
            continue
        team_games = {g[side]: gid for gid, g in fixtures.items() for side in ("home", "away")}
        seen = {}
        for card in prior["parlays"]:
            for leg in card["legs"]:
                if not eligible(leg):
                    continue
                gid = str(leg.get("game_id") or card.get("game_id") or team_games.get(leg["selection"].split()[0]))
                y = leg_result(leg, week, gid, games.get(gid), facts, excluded)
                if y is not None:
                    key = gid, leg["market"], leg.get("gsis_id") or leg["selection"], leg.get("line"), leg.get("side")
                    seen.setdefault(key, (leg, y))
        rows.extend(seen.values())
    return rows


def scores(card, correlation, offsets):
    legs = [{**leg, "_side": leg.get("side"), "_corr_tag": leg["market"]} for leg in card["legs"]]
    updated = [{**leg, "model_prob": sigmoid(model_log_odds(leg) + offsets.get(leg["market"], 0.))}
               for leg in legs]
    return [builder._combined_probs(prices, True, correlation)[0] for prices in (legs, updated)]


def record(observation):
    evidence, slate, schedule = read_observation(observation)
    if evidence["origin"] != ORIGIN:
        raise ValueError("Unexpected public origin")
    week, commit = evidence["week"], evidence["published_commit"]
    injury = injury_source_state(show(commit, "data/injuries.json"), evidence["observed_completed_utc"], week)
    review, facts, excluded = grading_inputs(commit)
    train = original_training(commit, schedule, week, review, facts, excluded)
    shifts = fit(train)
    correlation = builder._correlation_table(show(commit, "data/parlay_backtest.json"))
    games = {str(g["game_id"]): g for g in schedule["games"] if g["week"] == week}
    grouped = defaultdict(list)
    for card, ref in zip(slate["parlays"], evidence["cards"]):
        if (injury["verified"] and ref["pre_kickoff_observed"] and card["scope"] == "game" and len(card["legs"]) == 2
                and all(eligible(leg) for leg in card["legs"])):
            gid = str(card["game_id"])
            grouped[gid].append({"legs": card["legs"], "offer": ref["offer_sha256"],
                                 "probabilities": scores(card, correlation, shifts)})
    pairs = []
    for gid, group in grouped.items():
        fixture = {field: games[gid][field] for field in ("home", "away", "kickoff_utc")}
        pairs.append({"game_id": gid, **fixture, "base": max(group, key=lambda row: row["probabilities"][0]),
                      "challenger": max(group, key=lambda row: row["probabilities"][1])})
    body = {"policy": POLICY, "season": slate["season"], "week": week, "commit": commit,
            "observed_utc": evidence["observed_completed_utc"], "observation_id": evidence["observation_id"],
            "training_legs": len(train), "injury_source": injury, "pairs": pairs}
    return {**body, "record_id": fingerprint(body)}


def weekly(directory, commit, now):
    review, facts, excluded = grading_inputs(commit)
    latest = {}
    for path in sorted(directory.rglob("game-shadow.json")):
        rec = json.loads(path.read_bytes())
        body = {key: value for key, value in rec.items() if key != "record_id"}
        if rec["policy"] != POLICY or rec["season"] != review["season"]:
            continue
        if fingerprint(body) != rec["record_id"]:
            raise ValueError("Shadow artifact integrity check failed")
        observed = instant(rec["observed_utc"])
        for pair in rec["pairs"]:
            key = rec["week"], pair["game_id"]
            if observed < instant(pair["kickoff_utc"]) < now and (key not in latest or latest[key][0] < observed):
                latest[key] = observed, pair
    blocks = defaultdict(lambda: [0, 0, 0, 0])
    for week in {week for week, _ in latest}:
        blocks[week][3] = sum(bool(game.get("final")) and (week, str(game["game_id"])) not in excluded
                              for game in review["weeks"].get(str(week), {}).get("games", []))
    for (week, gid), (_, pair) in latest.items():
        games = review["weeks"].get(str(week), {}).get("games", [])
        game = next((g for g in games if str(g["game_id"]) == gid), None)
        if not game or not game.get("final") or (game["home"], game["away"], instant(game["kickoff_utc"])) != (
                pair["home"], pair["away"], instant(pair["kickoff_utc"])):
            continue
        block = blocks[week]
        grades = [[leg_result(leg, week, gid, game, facts, excluded) for leg in pair[variant]["legs"]]
                  for variant in ("base", "challenger")]
        if any(leg is None for grade in grades for leg in grade):
            continue
        block[0] += int(all(grades[0]))
        block[1] += int(all(grades[1]))
        block[2] += 1
    rows = [row for row in blocks.values() if row[2]]
    coverage, gradeable = sum(b[3] for b in blocks.values()), sum(b[2] for b in rows)
    base, challenger = sum(b[0] for b in rows), sum(b[1] for b in rows)
    interval = None
    if rows:
        rng = random.Random(20261119)
        draws = []
        for _ in range(50000):
            sample = rng.choices(rows, k=len(rows))
            draws.append(sum(b[1] - b[0] for b in sample) / sum(b[2] for b in sample))
        draws.sort()
        interval = [draws[1249], draws[48749]]
    passed = len(rows) >= 4 and gradeable >= 40 and gradeable >= .8 * coverage and interval[0] > 0
    return {"policy": POLICY, "as_of": now.isoformat(), "review_commit": commit,
            "weeks": dict(sorted(blocks.items())), "paired_weeks": len(rows), "graded_games": gradeable,
            "eligible_final_games": coverage, "baseline_hits": base, "challenger_hits": challenger,
            "change_95_interval": interval, "recommendation": "review_for_promotion" if passed else "hold_in_shadow"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--observation-result", type=Path)
    modes.add_argument("--weekly", type=Path)
    parser.add_argument("--commit")
    args = parser.parse_args()
    if args.observation_result:
        result = json.loads(args.observation_result.read_bytes())
        manifest = Path(result["manifest"])
        if manifest.resolve().parent != args.observation_result.resolve().parent:
            parser.error("Observation manifest must be in the same evidence folder")
        data = record(manifest)
    else:
        if not args.commit or not re.fullmatch(r"[0-9a-f]{40}", args.commit):
            parser.error("Weekly evaluation requires the exact review commit")
        data = weekly(args.weekly, args.commit, datetime.now(timezone.utc))
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
