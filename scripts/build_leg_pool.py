#!/usr/bin/env python3
"""BUILD data/leg_pool.json — every leg MY PARLAYS may use this week.

WHAT THIS IS FOR
----------------
data/parlays.json ships 66 curated cards built from 48 prop legs: the single
highest-projected QB, RB and WR in each game, each at one fixed line. That is the
right shape for a curated slate and the wrong shape for "type a player's name":
247 QB/RB/WRs have weekly rows, so five out of six players cannot be asked about
at all. This file prices the WIDE universe so the view can build a card around
whoever the user names.

THE SUPPORT RULE (why most rungs are refused)
---------------------------------------------
A player is offered a rung only when its z = (projected yards - line) /
residual_sd falls inside the z range the corpus actually covers for that
position (scripts/backtest_leg_pool.py writes `support`). Outside it the model is
extrapolating, and measured, that is exactly where it knows least: out-of-support
WR rungs score skill +0.013 and ECE 0.133 against +0.126 / 0.092 in support.
Refusing them means a player can come back with NO leg, and that honest silence
is the point — the alternative is a confident number for a question the model has
never been asked.

ITS OWN CALIBRATION, AND WHY THAT PROTECTS THE SLATE
-----------------------------------------------------
Prop probabilities here use the POOL calibration from
data/leg_pool_backtest.json, not the slate's. Measured on 2023-25, one
coefficient set cannot serve both populations (pool: ECE 0.007 refit vs 0.072
shipped; slate: the reverse). Because this file reads its own coefficients and
writes its own artifact, data/parlays.json cannot move when the pool changes —
that is a structural guarantee, not a promise, and tests/smoke.sh checks it.

GAME LEGS ARE COPIED, NEVER RE-PRICED
--------------------------------------
Moneyline and spread legs are lifted verbatim from the current data/parlays.json,
which already carries the as-made book prices the runner's odds feed supplied.
Re-deriving them here would mean a second pricing path that could silently
disagree with the shipped slate about the same bet.

MARKET POLICY (unchanged): a book price is display and the terms of the bet. No
market number reaches model_prob, here or anywhere.

  python3 scripts/build_leg_pool.py             write data/leg_pool.json
  python3 scripts/build_leg_pool.py --selftest  fixtures only, writes nothing
"""
import argparse
import datetime as _dt
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.models.parlay_builder import (  # noqa: E402
    _PROP_SEEDS, _clamp, _sigmoid, playable_this_week, project_prop_yards,
    questionable_label,
)

DATA = os.path.join(_ROOT, "data")
OUT = os.path.join(DATA, "leg_pool.json")
POOL_BACKTEST = os.path.join(DATA, "leg_pool_backtest.json")
PROB_CLAMP = (0.05, 0.95)     # the builder's own clamp, mirrored
POSITIONS = ("QB", "RB", "WR")
MARKET_OF = {pos: _PROP_SEEDS[pos][0] for pos in POSITIONS}
LABEL_OF = {pos: _PROP_SEEDS[pos][2] for pos in POSITIONS}


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def pool_prob(coef, z, p_team):
    """The POOL calibration's probability. Same functional form as the slate's
    (sigmoid(a + b*z + c*(p_team - 0.5)), same clamp) — only the coefficients
    differ, because they were fit on a different population."""
    a, b, c = coef["a"], coef["b"], coef["c"]
    return round(_clamp(_sigmoid(a + b * z + c * (p_team - 0.5)), *PROB_CLAMP), 4)


def _abbrev(name):
    parts = str(name or "").split()
    return ("%s. %s" % (parts[0][0], " ".join(parts[1:]))) if len(parts) > 1 else str(name)


def prop_legs(players, weekly_by_id, game_preds, calib, support, sd, ladder):
    """One leg per (player, in-support rung). Returns (legs, counters).

    Every input is the one the slate uses: the same project_prop_yards, the same
    weekly rows, the same Elo team probability. Only the player cut and the line
    are wider, so nothing here can disagree with the slate about a shared leg
    except through the calibration, which is the deliberate difference."""
    by_team = {}
    for gp in game_preds:
        p_home = float((gp.get("probs") or {}).get("home", 0.5))
        by_team[gp.get("home")] = (gp, "home", p_home)
        by_team[gp.get("away")] = (gp, "away", 1.0 - p_home)

    legs = []
    counts = {"no_game": 0, "no_weekly_row": 0, "no_projection": 0,
              "no_calibration": 0, "refused_out_of_support": 0, "players_with_no_leg": 0,
              "not_playable": 0}
    for p in players:
        pos = p.get("position")
        if pos not in POSITIONS:
            continue
        gsis = p.get("gsis_id")
        rec = weekly_by_id.get(gsis)
        if rec is None:
            counts["no_weekly_row"] += 1
            continue
        # R77 -- THE GATE. A player who does not play this week (his weekly row
        # says so: OUT / DOUBTFUL / IR / suspended / a QB2 behind a healthy
        # starter) gets no leg at any rung. His zeroed week would price to a
        # near-certain UNDER, which is not a bet, it is a bug wearing odds.
        if not playable_this_week(rec):
            counts["not_playable"] += 1
            continue
        slot = by_team.get(p.get("team"))
        if slot is None:
            counts["no_game"] += 1
            continue
        gp, side, p_team = slot
        coef, window, s = calib.get(pos), support.get(pos), sd.get(pos)
        if not coef or not window or not s:
            counts["no_calibration"] += 1
            continue
        mu, reason = project_prop_yards(pos, rec, gp, side)
        if mu is None:
            counts["no_projection"] += 1
            continue
        lo, hi = window
        made, rungs = 0, []
        for line in ladder.get(pos, []):
            z = (mu - line) / s
            if not (lo <= z <= hi):
                counts["refused_out_of_support"] += 1
                continue
            rungs.append({
                "line": line, "z": round(z, 4),
                "selection": "%s %.0f+ %s" % (_abbrev(p.get("name")), line + 0.5,
                                              LABEL_OF[pos]),
                "model_prob": pool_prob(coef, z, p_team),
            })
            made += 1
        if made == 0:
            counts["players_with_no_leg"] += 1
            continue
        # PLAYER-KEYED, not leg-keyed. A player is the unit the user types, so it
        # is the unit the view looks up -- and the fields that do not vary across
        # his rungs (team, game, projection, team win probability) are stated once
        # instead of 2-8 times, which is most of the file.
        row = {
            "gsis_id": gsis, "player": p.get("name"), "team": p.get("team"),
            "position": pos, "market": MARKET_OF[pos],
            "game_id": str(gp.get("game_id")), "side": side,
            "mu": round(mu, 2), "p_team": round(p_team, 4),
            "pricing": "pool_calibrated", "rungs": rungs,
        }
        q = questionable_label(rec)
        if q:
            row["availability"] = q      # priced, and labelled -- never silent
        legs.append(row)
    legs.sort(key=lambda r: (r["game_id"], r["position"], r["player"] or "", r["gsis_id"]))
    return legs, counts


def game_legs_from_slate(parlays_doc, game_by_team=None, side_by_team=None):
    """Moneyline / spread legs lifted VERBATIM from the shipped slate, de-duped.

    Copied rather than re-derived on purpose: the slate's legs already carry the
    as-made book prices, and a second pricing path here could disagree with the
    shipped card about the same bet.

    game_id is RESOLVED, not copied. A week-scope parlay carries no game_id --
    cross-game legs are combined as independent, so the slate never needed one --
    but My Parlays does: without the game it cannot correlation-adjust a same-game
    pair, and it cannot apply R74's one-leg-per-game-side rule. The team named by
    the selection ("BAL ML", "BAL -3.5") identifies the game, so it is looked up.
    The side is preserved from new slates or recovered from the SAME current
    game prediction for older slates. Missing identity remains null; the client
    refuses unresolved legs instead of assuming same-side correlation."""
    # Keyed on (market, selection), NOT on the game: a team plays once a week, so
    # "BAL ML" is one bet however many cards carry it. Keying on game_id would let
    # the same bet appear twice — once from a game-scope card that knows its game
    # and once from a week-scope card that does not.
    best = {}
    for parlay in (parlays_doc or {}).get("parlays", []) or []:
        for leg in parlay.get("legs") or []:
            if leg.get("market") not in ("moneyline", "spread"):
                continue
            team = str(leg.get("selection", "")).split(" ")[0].strip()
            gid = parlay.get("game_id") or (game_by_team or {}).get(team)
            gid = str(gid) if gid else None
            side = leg.get("side")
            # Only recover identity when the event agrees. Mixing a historical
            # slate with this week's predictions must not invent a team side.
            mapped_gid = (game_by_team or {}).get(team)
            mapped_side = (side_by_team or {}).get(team)
            if mapped_gid is not None and str(mapped_gid) == gid:
                if side in ("home", "away") and mapped_side in ("home", "away") \
                        and side != mapped_side:
                    raise ValueError("conflicting side for %s in game %s" % (team, gid))
                side = side or mapped_side
            key = (leg["market"], leg["selection"])
            if key in best:
                old = best[key]
                old_identity = (old["game_id"] is not None,
                                old.get("side") in ("home", "away"))
                new_identity = (gid is not None, side in ("home", "away"))
                if old_identity >= new_identity:
                    continue        # keep the copy with more complete identity
            row = dict(leg)
            row["game_id"] = gid
            row["team"] = team or None
            row["side"] = side if side in ("home", "away") else None
            row["source"] = "parlays.json (comparison probability; not an exact-card quote)"
            row["price_source"] = leg.get("price_source", "unavailable")
            best[key] = row
    out = list(best.values())
    out.sort(key=lambda l: (str(l.get("game_id")), l["market"], l["selection"]))
    return out


def build(inputs):
    bt = inputs["pool_backtest"]
    calib = {p: v for p, v in (bt.get("calibration") or {}).items() if v}
    support = {p: tuple(v) for p, v in (bt.get("support") or {}).items()}
    sd = bt.get("residual_sd") or {}
    ladder = bt.get("ladder") or {}
    adopted = bool(((bt.get("verdict") or {}).get("adopt")))

    weekly_by_id = {r["gsis_id"]: r
                    for r in (inputs["player_weekly"] or {}).get("players", []) or []
                    if r.get("gsis_id")}
    players = (inputs["player_projections"] or {}).get("players", []) or []
    game_preds = (inputs["game_predictions"] or {}).get("games", []) or []

    props, counts = prop_legs(players, weekly_by_id, game_preds, calib, support, sd, ladder)
    game_by_team, side_by_team = {}, {}
    for gp in game_preds:
        for side in ("home", "away"):
            if gp.get(side):
                game_by_team[gp[side]] = str(gp.get("game_id"))
                side_by_team[gp[side]] = side
    games = game_legs_from_slate(inputs.get("parlays"), game_by_team, side_by_team)
    parlays_doc = inputs.get("parlays") or {}
    return {
        "season": parlays_doc.get("season"),
        "week": parlays_doc.get("week"),
        "generated_utc": _dt.datetime.now(_dt.timezone.utc)
                            .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": bt.get("model"),
        "calibration_adopted": adopted,
        "ladder": ladder,
        "support": {p: list(v) for p, v in support.items()},
        "residual_sd": sd,
        "counts": dict(counts,
                       prop_legs=sum(len(r["rungs"]) for r in props),
                       game_legs=len(games), players_with_a_leg=len(props)),
        "players": props,
        "game_legs": games,
        "notes": [
            "PROP legs are priced with the POOL calibration (leg_pool_backtest.json), "
            "which is fit on the wide player universe. The shipped slate keeps its own "
            "calibration in parlay_backtest.json and is not affected by this file.",
            "A rung is offered only when its z falls inside `support`; "
            "%d rung(s) were refused as extrapolation and %d player(s) came back with "
            "no leg at all, which is the honest answer rather than a guessed one."
            % (counts["refused_out_of_support"], counts["players_with_no_leg"]),
            "GAME legs are copied verbatim from parlays.json so the pool and the "
            "shipped card can never disagree about the same bet.",
            "%d player(s) who do not play this week (OUT / DOUBTFUL / IR / suspended, "
            "or a quarterback listed behind a healthy starter) carry no leg; a "
            "QUESTIONABLE player is priced and labelled `availability`."
            % counts["not_playable"],
            "Money and book prices are display and the terms of the bet. No market "
            "number reaches model_prob.",
        ],
    }


def load_inputs():
    return {
        "pool_backtest": _load(POOL_BACKTEST),
        "player_weekly": _load(os.path.join(DATA, "player_weekly.json")),
        "player_projections": _load(os.path.join(DATA, "player_projections.json")),
        "game_predictions": _load(os.path.join(DATA, "game_predictions.json")),
        "parlays": _load(os.path.join(DATA, "parlays.json")),
    }


def selftest():
    calib = {"WR": {"a": 0.0, "b": 1.0, "c": 0.0}}
    support = {"WR": (-1.0, 1.0)}
    sd = {"WR": 40.0}
    ladder = {"WR": [19.5, 59.5, 99.5, 199.5]}
    gp = [{"game_id": "G1", "home": "AAA", "away": "BBB", "probs": {"home": 0.6}}]
    players = [{"gsis_id": "w1", "name": "Alpha Receiver", "team": "AAA", "position": "WR"},
               {"gsis_id": "w2", "name": "Beta Receiver", "team": "CCC", "position": "WR"},
               {"gsis_id": "w3", "name": "Gamma Receiver", "team": "BBB", "position": "WR"}]
    weekly = {"w1": {"gsis_id": "w1"}, "w3": {"gsis_id": "w3"}}

    # Patch THIS module's globals, not scripts.build_leg_pool's: run as __main__
    # the two are different module objects and patching the import would land on
    # a copy nothing here calls.
    g = globals()
    saved = g["project_prop_yards"]
    g["project_prop_yards"] = lambda pos, rec, gp_, side: (60.0, None)
    try:
        legs, counts = prop_legs(players, weekly, gp, calib, support, sd, ladder)
    finally:
        g["project_prop_yards"] = saved

    # only the in-support rungs survive: z = (60 - line)/40 -> 19.5:+1.01 (OUT),
    # 59.5:+0.01 (in), 99.5:-0.99 (in), 199.5:-3.49 (OUT)
    lines = sorted(r["line"] for row in legs for r in row["rungs"])
    assert lines == [59.5, 59.5, 99.5, 99.5], lines   # 2 rungs x 2 eligible players
    assert counts["refused_out_of_support"] == 4, counts   # 2 rungs x 2 players
    assert counts["no_weekly_row"] == 1 and counts["no_game"] == 0, counts
    assert {r["gsis_id"] for r in legs} == {"w1", "w3"}, legs
    # the home player's p_team is the home win prob; the away player's is 1 - it
    home = next(r for r in legs if r["gsis_id"] == "w1")
    away = next(r for r in legs if r["gsis_id"] == "w3")
    assert home["p_team"] == 0.6 and away["p_team"] == 0.4, (home, away)
    # every rung carries a model probability, never a market one, inside the clamp
    allr = [r for row in legs for r in row["rungs"]]
    assert all(PROB_CLAMP[0] <= r["model_prob"] <= PROB_CLAMP[1] for r in allr)
    assert all("implied_prob" not in r for r in allr), "the pool prices, it does not quote"
    # a longer line is never MORE likely than a shorter one for the same player
    for row in legs:
        seq = [r["model_prob"] for r in sorted(row["rungs"], key=lambda x: x["line"])]
        assert seq == sorted(seq, reverse=True), (row["player"], seq)
    # selection reads as the bet: line 59.5 -> "60+"
    assert next(r for r in home["rungs"] if r["line"] == 59.5)["selection"] \
        .endswith("60+ rec yds"), home["rungs"]

    # a player with NO in-support rung is counted, not invented
    tight = dict(support, WR=(2.0, 3.0))
    g["project_prop_yards"] = lambda pos, rec, gp_, side: (60.0, None)
    try:
        legs2, counts2 = prop_legs(players, weekly, gp, calib, tight, sd, ladder)
    finally:
        g["project_prop_yards"] = saved
    assert legs2 == [] and counts2["players_with_no_leg"] == 2, counts2

    # game legs are copied verbatim and de-duped
    doc = {"parlays": [
        {"game_id": "G1", "legs": [{"market": "moneyline", "selection": "AAA ML",
                                    "implied_prob": 0.55, "model_prob": 0.6}]},
        {"game_id": "G1", "legs": [{"market": "moneyline", "selection": "AAA ML",
                                    "implied_prob": 0.55, "model_prob": 0.6},
                                   {"market": "qb_pass_yds", "selection": "X 225+"}]},
    ]}
    gl = game_legs_from_slate(doc, {"AAA": "G1"})
    assert len(gl) == 1 and gl[0]["implied_prob"] == 0.55, gl
    assert gl[0]["market"] == "moneyline" and gl[0]["team"] == "AAA", gl
    # a week-scope leg carries no game_id on the slate; it is RESOLVED from the
    # team so the same bet de-dupes against its game-scope twin instead of
    # appearing twice under different keys.
    wk = {"parlays": [
        {"legs": [{"market": "moneyline", "selection": "AAA ML",
                   "implied_prob": 0.55, "model_prob": 0.6}]},
        {"game_id": "G1", "legs": [{"market": "moneyline", "selection": "AAA ML",
                                    "implied_prob": 0.55, "model_prob": 0.6}]},
    ]}
    both = game_legs_from_slate(wk, {"AAA": "G1"})
    assert len(both) == 1 and both[0]["game_id"] == "G1", both
    # unresolvable team -> still ONE leg, and it keeps the game_id the game-scope
    # card knew, so an unresolved week-scope twin never becomes a duplicate.
    orphan = game_legs_from_slate(wk, {})
    assert len(orphan) == 1 and orphan[0]["game_id"] == "G1", orphan
    # and with no game-scope twin at all it is still offered, game_id null
    lone = game_legs_from_slate({"parlays": [wk["parlays"][0]]}, {})
    assert len(lone) == 1 and lone[0]["game_id"] is None, lone
    print("selftest OK: only in-support rungs ship, refusals and leg-less players are "
          "counted, p_team follows the side, the pool prices without quoting, and game "
          "legs are copied verbatim and de-duped")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    doc = build(load_inputs())
    if not doc["calibration_adopted"]:
        print("[warn] the pool calibration is NOT adopted by its gate — refusing to "
              "write a pool priced by coefficients that did not clear", file=sys.stderr)
        return 1
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    c = doc["counts"]
    print("wrote %s: %d prop legs (%d players) + %d game legs; refused %d rung(s), "
          "%d player(s) with no leg"
          % (os.path.relpath(OUT, _ROOT), c["prop_legs"], c["players_with_a_leg"],
             c["game_legs"], c["refused_out_of_support"], c["players_with_no_leg"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
