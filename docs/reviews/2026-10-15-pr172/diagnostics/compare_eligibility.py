"""Compare real weekly/prop producers on one frozen committed input set.

Stdlib, offline, JSON on stdout. Does not modify data or fit any parameter.
The worker imports each checkout in a separate interpreter so its availability
and model dependencies cannot accidentally come from the other revision.
"""
import argparse
import hashlib
import inspect
import json
from pathlib import Path
import subprocess
import sys


def git(tree, *args):
    return subprocess.check_output(["git", "-C", str(tree), *args], text=True)


def worker(args):
    sys.path.insert(0, str(args.code_tree))
    from scripts import build_predictions as bp, build_weekly as bw
    from scripts.models import parlay_builder as pb

    digests = {}

    def read(name, optional=False):
        filename = "data/" + name + ".json"
        proc = subprocess.run(["git", "-C", str(args.repo), "show",
                               args.inputs_ref + ":" + filename],
                              text=True, capture_output=True)
        if proc.returncode:
            if optional:
                return None
            raise RuntimeError(proc.stderr)
        digests[filename] = hashlib.sha256(proc.stdout.encode()).hexdigest()
        return json.loads(proc.stdout)

    projections = read("player_projections")
    previous = read("player_weekly")
    schedule = read("schedule_full")
    injuries = read("injuries")
    depth = read("depth_chart")
    inactives = read("inactives", optional=True)
    ratings = read("team_strength")["ratings"]
    game_document = read("game_predictions")
    season, week = game_document["season"], game_document["week"]
    checked = previous["updated_utc"]
    rows = previous["players"]
    components = {p["gsis_id"]: {"components": p["league_components"],
                   "base_applied_pts": p["base_applied_pts"],
                   "bonus_games": p.get("bonus_games")}
                  for p in rows if p.get("league_components")}
    factors = bw.build_factors(season, read("dvp_positional_history"),
                               read("environment_model"), read("weather_forecast"))
    skipped = sorted({team for game in schedule["games"]
                      if game.get("week") == week and game.get("status") == "STATUS_FINAL"
                      for team in (game["home"], game["away"])})
    kwargs = {"injuries": injuries["injuries"], "first_week": week,
              "completions_by_id": {p["gsis_id"]: p.get("completions_prior", 0) for p in rows},
              "components_by_id": components, "factors": factors, "this_week": week,
              "depth_chart": depth, "gate_skip_teams": skipped, "inactives": inactives}
    if "injury_document" in inspect.signature(bw.build_weekly_document).parameters:
        kwargs["injury_document"] = injuries
    rebuilt = bw.build_weekly_document(projections["players"], schedule["games"], ratings,
        {p["gsis_id"]: p.get("receptions_prior", 0) for p in rows}, season, checked, **kwargs)
    by_id = {p["gsis_id"]: p for p in projections["players"]}
    decisions = []
    for row in rebuilt["players"]:
        if pb.playable_this_week(row, week):
            continue
        period = next((w for w in row["weeks"] if w["wk"] == week), None)
        decisions.append({"player_id": row["gsis_id"], "name": by_id[row["gsis_id"]]["name"],
                          "this_week": row.get("this_week"), "eligibility": row.get("eligibility"),
                          "availability": row.get("availability"), "week_avail": (period or {}).get("avail")})
    # Preserve each revision's actual production caller shape, including its week field.
    if hasattr(bp, "week_game_rows"):
        games = bp.week_game_rows(schedule["games"], week)
    else:
        # Exact pre-checkpoint production list-comprehension field set.
        fields = ("game_id", "home", "away", "kickoff_utc", "roof", "probs", "model", "estimate")
        games = [{k: game[k] for k in fields} for game in schedule["games"]
                 if game.get("week") == week]
    props = pb.build_props_by_game(games, rebuilt, projections)
    cards = pb.build_parlays_document(games, season, week, checked, props_by_game=props)
    # Odds API quotes are not durably replayed here. Both policies therefore receive
    # no optional quote feed; this comparison concerns candidate identity/model p.
    code_files = ("scripts/availability.py", "scripts/build_weekly.py",
                  "scripts/build_predictions.py", "scripts/models/parlay_builder.py")
    return {"code_commit": git(args.code_tree, "rev-parse", "HEAD").strip(),
            "code_sha256": {name: hashlib.sha256((args.code_tree / name).read_bytes()).hexdigest()
                            for name in code_files},
            "checked_utc": checked, "source_state": rebuilt["model"].get("injury_source"),
            "withheld": sorted(decisions, key=lambda p: p["player_id"]),
            "props": [{"game_id": game, **leg} for game, legs in sorted(props.items()) for leg in legs],
            "cards": cards["parlays"], "input_sha256": digests}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--inputs-ref", required=True)
    parser.add_argument("--control-tree", type=Path)
    parser.add_argument("--candidate-tree", type=Path)
    parser.add_argument("--code-tree", type=Path)
    args = parser.parse_args()
    if args.code_tree:
        print(json.dumps(worker(args), sort_keys=True, allow_nan=False))
        return
    if not args.control_tree or not args.candidate_tree:
        parser.error("both comparison checkouts are required")
    reports = {}
    for label, tree in (("control", args.control_tree), ("candidate", args.candidate_tree)):
        result = subprocess.run([sys.executable, __file__, "--repo", str(args.repo),
            "--inputs-ref", args.inputs_ref, "--code-tree", str(tree)],
            text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(label + " worker failed:\n" + result.stderr)
        reports[label] = json.loads(result.stdout)
    control, candidate = reports["control"], reports["candidate"]
    if control["input_sha256"] != candidate["input_sha256"]:
        raise AssertionError("workers did not consume identical frozen inputs")
    def denied(report):
        return {p["player_id"] for p in report["withheld"]}
    def key(leg):
        return tuple(leg.get(k) for k in ("game_id", "gsis_id", "market", "line", "selection"))
    a, b = {key(p): p for p in control["props"]}, {key(p): p for p in candidate["props"]}
    def card_key(card):
        return card.get("scope"), card.get("game_id"), tuple(sorted(
            (key(leg) for leg in card["legs"]), key=repr))
    summary = {"newly_withheld": sorted(denied(candidate) - denied(control)),
               "newly_playable": sorted(denied(control) - denied(candidate)),
               "withheld_counts": {k: len(v["withheld"]) for k, v in reports.items()},
               "prop_counts": {k: len(v["props"]) for k, v in reports.items()},
               "card_counts": {k: len(v["cards"]) for k, v in reports.items()},
               "added_props": [list(k) for k in sorted(b.keys() - a.keys())],
               "removed_props": [list(k) for k in sorted(a.keys() - b.keys())],
               "changed_prop_probabilities": [list(k) for k in sorted(a.keys() & b.keys())
                    if a[k]["model_prob"] != b[k]["model_prob"]],
               "card_identity_sets_equal": {card_key(c) for c in control["cards"]}
                   == {card_key(c) for c in candidate["cards"]},
               "card_probability_vectors_equal": {
                   card_key(c): [leg["model_prob"] for leg in c["legs"]] for c in control["cards"]}
                   == {card_key(c): [leg["model_prob"] for leg in c["legs"]] for c in candidate["cards"]},
               "caveat": "Offline weekly/prop producer comparison; rounded committed Elo and prior component receipts reused; no fresh projections or optional sportsbook quotes."}
    print(json.dumps({"inputs_commit": git(args.repo, "rev-parse", args.inputs_ref).strip(),
                      "summary": summary, "reports": reports}, indent=2, sort_keys=True, allow_nan=False))


if __name__ == "__main__":
    main()
