#!/usr/bin/env python3
"""Parlay-leg ledger append -> data/estimates/parlays_<season>.json (R58, step 1).

WHY
---
data/parlays.json is rebuilt every pipeline day and the previous day's legs are
gone. A prop leg ("T. Henderson 60+ rush yds", model_prob 0.31) can only be scored
if the number we shipped BEFORE kickoff still exists AFTER the game. This ledger
is that record: every leg is appended the first time it is seen with its as-made
pricing, and that entry is never rewritten.

RULES
  * Key = (season, week, game_id, market, selection). The FIRST append that sees
    a key locks its as-made fields (mu, sd, z, model_prob, implied_prob, pricing,
    line, kickoff_utc, locked_utc). Later appends never touch an existing key;
    they only add keys that are new.
  * PRE-KICKOFF ONLY: a leg first seen at or after its game's kickoff is recorded
    with `locked: false` and `locked_utc: null` and is excluded from scoring —
    the same rule the player ledger (scripts/build_estimate_ledger.py) applies.
  * IDEMPOTENT PER DAY: the as-of is parlays.json's updated_utc; a second run on
    the same build changes no bytes.
  * The player behind a prop leg is identified by the selection's abbreviated
    name (the builder's `_abbrev_player` rule, imported so the two never drift)
    + the market's position + the game's two teams, looked up in
    data/player_projections.json — the pool the builder chose the player from.
    An unidentifiable player is recorded as null (absent is absent); the
    resolver then falls back to the abbreviated name against the stats release.
  * p_team (the team win probability the leg was priced with) is locked from
    data/game_predictions.json for the leg's side, so the seed pricing can be
    recomputed later on exactly the legs the calibrated model shipped.
  * Moneyline and spread legs are appended for the record (team, side, handicap).
    The book's handicap is the terms of the bet a spread leg is evaluated at —
    never an input to anything. implied_prob is kept as the yardstick it is.

Stdlib only, no network. --selftest drives the pure core (`append`) on fixtures.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.models.parlay_builder import _abbrev_player as abbrev_player  # noqa: E402

DATA = os.path.join(_ROOT, "data")
LEDGER_DIR = os.path.join(DATA, "estimates")
PARLAYS_PATH = os.path.join(DATA, "parlays.json")
GAME_PREDICTIONS_PATH = os.path.join(DATA, "game_predictions.json")
PROJECTIONS_PATH = os.path.join(DATA, "player_projections.json")

PROP_POSITION = {"qb_pass_yds": "QB", "rb_rush_yds": "RB", "wr_rec_yds": "WR"}
GAME_MARKETS = ("moneyline", "spread")
MARKETS = GAME_MARKETS + tuple(PROP_POSITION)
SOURCE = ("scripts/build_parlay_ledger.py over data/parlays.json (legs as shipped), "
          "data/game_predictions.json (game, kickoff, p_team) and "
          "data/player_projections.json (the player behind a prop selection)")

_PROP_RE = re.compile(r"^(?P<abbrev>.+?) (?P<line>\d+)\+ (?:pass|rush|rec) yds$")
_ML_RE = re.compile(r"^(?P<team>[A-Z]{2,3}) ML$")
_SPREAD_RE = re.compile(r"^(?P<team>[A-Z]{2,3}) (?P<hcap>[+-]?\d+(?:\.\d+)?)$")


def ledger_path(season):
    return os.path.join(LEDGER_DIR, "parlays_%d.json" % int(season))


def parse_utc(text):
    """ISO-8601 UTC ('2026-09-10T00:20Z', '...T10:39:10Z', '...+00:00') -> aware
    datetime, or None when absent/unparseable. Never compares strings: the
    schedule carries minutes only and the builds carry seconds."""
    if not text:
        return None
    s = str(text).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc)


def leg_key(leg):
    return (int(leg["season"]), int(leg["week"]), str(leg["game_id"]),
            str(leg["market"]), str(leg["selection"]))


# --------------------------------------------------------------------------- #
# pure core                                                                     #
# --------------------------------------------------------------------------- #

def game_index(game_predictions):
    """({game_id: game}, {team: game}) over game_predictions.json games."""
    by_id, by_team = {}, {}
    for g in (game_predictions or {}).get("games") or []:
        gid = g.get("game_id")
        if not gid:
            continue
        by_id[str(gid)] = g
        for t in (g.get("home"), g.get("away")):
            if t:
                by_team[t] = g
    return by_id, by_team


def identify_player(abbrev, position, teams, projections):
    """(name, team, gsis_id) of the unique projected player whose abbreviated
    name, position and team match; (None, None, None) otherwise."""
    hits = []
    for p in (projections or {}).get("players") or []:
        if p.get("position") != position or p.get("team") not in teams:
            continue
        if abbrev_player(p.get("name", "")) == abbrev:
            hits.append(p)
    if len(hits) != 1:
        return None, None, None
    p = hits[0]
    return p.get("name"), p.get("team"), p.get("gsis_id")


def _num(v):
    return None if v is None else float(v)


def unique_legs(parlays_doc, game_predictions, projections):
    """Every distinct leg in a parlays document, resolved to its game.

    Returns (legs, skipped). A leg that names no known game (a week parlay's
    team not on the slate, an unknown market) is skipped and counted — never
    guessed. Duplicates across parlays collapse on the key; the first wins
    (they are the same leg).
    """
    season = int(parlays_doc["season"])
    week = int(parlays_doc["week"])
    by_id, by_team = game_index(game_predictions)
    skipped = {"unknown_market": 0, "no_game": 0, "bad_selection": 0}
    out = {}
    for parlay in parlays_doc.get("parlays") or []:
        pgame = by_id.get(str(parlay.get("game_id"))) if parlay.get("game_id") else None
        for leg in parlay.get("legs") or []:
            market = leg.get("market")
            selection = str(leg.get("selection", ""))
            if market not in MARKETS:
                skipped["unknown_market"] += 1
                continue
            rec = {"season": season, "week": week, "market": market,
                   "selection": selection}
            if market in GAME_MARKETS:
                m = (_ML_RE if market == "moneyline" else _SPREAD_RE).match(selection)
                if not m:
                    skipped["bad_selection"] += 1
                    continue
                team = m.group("team")
                game = pgame or by_team.get(team)
                if game is None or team not in (game.get("home"), game.get("away")):
                    skipped["no_game"] += 1
                    continue
                side = "home" if team == game.get("home") else "away"
                rec.update({
                    "position": None, "player": None, "gsis_id": None,
                    "team": team, "side": side,
                    "line": _num(m.group("hcap")) if market == "spread" else None,
                    "mu": None, "sd": None, "z": None,
                })
            else:
                m = _PROP_RE.match(selection)
                if not m:
                    skipped["bad_selection"] += 1
                    continue
                game = pgame
                if game is None:
                    skipped["no_game"] += 1
                    continue
                pos = PROP_POSITION[market]
                teams = (game.get("home"), game.get("away"))
                name, team, gsis = identify_player(m.group("abbrev"), pos, teams, projections)
                side = (None if team is None else
                        "home" if team == game.get("home") else "away")
                rec.update({
                    "position": pos, "player": name, "gsis_id": gsis,
                    "team": team, "side": side,
                    "line": _num(leg.get("line")),
                    "mu": _num(leg.get("mu")), "sd": _num(leg.get("sd")),
                    "z": _num(leg.get("z")),
                })
            probs = game.get("probs") or {}
            p_team = probs.get(rec["side"]) if rec["side"] else None
            rec.update({
                "game_id": str(game.get("game_id")),
                "home": game.get("home"), "away": game.get("away"),
                "kickoff_utc": game.get("kickoff_utc"),
                "p_team": _num(p_team),
                "model_prob": _num(leg.get("model_prob")),
                "implied_prob": _num(leg.get("implied_prob")),
                "pricing": leg.get("pricing"),
            })
            key = leg_key(rec)
            if key not in out:
                out[key] = rec
    return list(out.values()), skipped


def append(ledger, parlays_doc, game_predictions, projections, generated_utc):
    """One append. `ledger` may be None (first run). Returns the NEW document.

    Idempotent: when every key in today's build is already in the ledger and
    the run is already recorded, the returned document equals the input
    (generated_utc aside — the caller keeps the old bytes in that case).
    """
    as_of = parlays_doc.get("updated_utc")
    if not as_of:
        raise ValueError("parlays.json has no updated_utc")
    as_of_dt = parse_utc(as_of)
    if as_of_dt is None:
        raise ValueError("parlays.json updated_utc %r is not ISO-8601" % as_of)
    season = int(parlays_doc["season"])
    legs = {leg_key(l): l for l in ((ledger or {}).get("legs") or [])}
    today, skipped = unique_legs(parlays_doc, game_predictions, projections)
    added = locked_added = 0
    for rec in today:
        key = leg_key(rec)
        if key in legs:
            continue                      # first sight wins; never rewritten
        kick = parse_utc(rec.get("kickoff_utc"))
        locked = kick is not None and as_of_dt < kick
        rec = dict(rec)
        rec["seen_utc"] = as_of
        rec["locked"] = bool(locked)
        rec["locked_utc"] = as_of if locked else None
        legs[key] = rec
        added += 1
        locked_added += 1 if locked else 0
    runs = list((ledger or {}).get("runs") or [])
    if not any(r.get("as_of_utc") == as_of for r in runs):
        runs.append({"as_of_utc": as_of, "week": int(parlays_doc["week"]),
                     "legs_seen": len(today), "legs_added": added,
                     "locked_added": locked_added,
                     "unlocked_added": added - locked_added,
                     "skipped": skipped})
    ordered = [legs[k] for k in sorted(legs)]
    return {
        "season": season,
        "generated_utc": generated_utc,
        "as_of_utc": as_of,
        "source": SOURCE,
        "note": ("one entry per (season, week, game_id, market, selection), written the "
                 "first time the leg is seen and never rewritten; `locked` is true only "
                 "when that first sight preceded the game's kickoff — unlocked legs are "
                 "kept for the record and excluded from scoring. p_team is the side's "
                 "win probability the leg was priced with, so the seed pricing can be "
                 "recomputed on identical legs. implied_prob is a yardstick, never an "
                 "input."),
        "runs": runs,
        "legs": ordered,
    }


# --------------------------------------------------------------------------- #
# I/O                                                                           #
# --------------------------------------------------------------------------- #

def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write(doc, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def run(parlays_path=PARLAYS_PATH, games_path=GAME_PREDICTIONS_PATH,
        projections_path=PROJECTIONS_PATH, out_dir=LEDGER_DIR, now=None):
    parlays = _load(parlays_path)
    games = _load(games_path) if os.path.exists(games_path) else {}
    projections = _load(projections_path) if os.path.exists(projections_path) else {}
    season = int(parlays["season"])
    path = os.path.join(out_dir, "parlays_%d.json" % season)
    prev = _load(path) if os.path.exists(path) else None
    if prev and prev.get("as_of_utc") == parlays.get("updated_utc"):
        print("parlay ledger: as-of %s already appended -> no change (%s)"
              % (prev["as_of_utc"], path))
        return prev, False
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = append(prev, parlays, games, projections, now)
    write(doc, path)
    last = doc["runs"][-1]
    n_locked = sum(1 for l in doc["legs"] if l["locked"])
    print("parlay ledger: appended as-of %s week %d: %d legs seen, %d added (%d locked, "
          "%d post-kickoff), skipped %s -> %d legs on file (%d locked) %s (%d bytes)"
          % (doc["as_of_utc"], last["week"], last["legs_seen"], last["legs_added"],
             last["locked_added"], last["unlocked_added"], last["skipped"],
             len(doc["legs"]), n_locked, path, os.path.getsize(path)))
    return doc, True


# --------------------------------------------------------------------------- #
# selftest                                                                      #
# --------------------------------------------------------------------------- #

def _fixture(as_of, mu=44.49, prob=0.3142):
    games = {"games": [
        {"game_id": "g-early", "home": "SEA", "away": "NE",
         "kickoff_utc": "2026-09-10T00:20Z", "probs": {"home": 0.61, "away": 0.39}},
        {"game_id": "g-late", "home": "KC", "away": "BUF",
         "kickoff_utc": "2026-09-14T00:20Z", "probs": {"home": 0.55, "away": 0.45}},
    ]}
    projections = {"players": [
        {"gsis_id": "espn-1", "name": "TreVeyon Henderson", "team": "NE", "position": "RB"},
        {"gsis_id": "espn-2", "name": "Patrick Mahomes", "team": "KC", "position": "QB"},
        {"gsis_id": "espn-3", "name": "Jaxon Smith-Njigba", "team": "SEA", "position": "WR"},
        {"gsis_id": "espn-4", "name": "Josh Allen", "team": "BUF", "position": "QB"},
        {"gsis_id": "espn-5", "name": "Jonathan Allen", "team": "BUF", "position": "QB"},
    ]}
    prop = lambda market, sel, line, m, p: {  # noqa: E731
        "market": market, "selection": sel, "implied_prob": 0.33, "model_prob": p,
        "pricing": "calibrated", "estimate": True, "mu": m, "sd": 38.87,
        "z": round((m - line) / 38.87, 4), "line": line}
    parlays = {"season": 2026, "week": 1, "updated_utc": as_of, "parlays": [
        {"parlay_id": "g-early-1", "scope": "game", "game_id": "g-early", "legs": [
            {"market": "moneyline", "selection": "SEA ML", "implied_prob": 0.6, "model_prob": 0.61},
            {"market": "spread", "selection": "SEA -3", "implied_prob": 0.52, "model_prob": 0.5}]},
        {"parlay_id": "g-early-2", "scope": "game", "game_id": "g-early", "legs": [
            prop("rb_rush_yds", "T. Henderson 60+ rush yds", 59.5, mu, prob),
            prop("wr_rec_yds", "J. Smith-Njigba 60+ rec yds", 59.5, 94.0, 0.65)]},
        {"parlay_id": "g-late-1", "scope": "game", "game_id": "g-late", "legs": [
            prop("qb_pass_yds", "P. Mahomes 225+ pass yds", 224.5, 260.0, 0.6),
            prop("qb_pass_yds", "J. Allen 225+ pass yds", 224.5, 250.0, 0.58),
            {"market": "moneyline", "selection": "KC ML", "implied_prob": 0.55, "model_prob": 0.55}]},
        {"parlay_id": "week-1", "scope": "week", "legs": [
            {"market": "moneyline", "selection": "SEA ML", "implied_prob": 0.6, "model_prob": 0.61},
            {"market": "moneyline", "selection": "BUF ML", "implied_prob": 0.45, "model_prob": 0.45},
            {"market": "moneyline", "selection": "DAL ML", "implied_prob": 0.5, "model_prob": 0.5}]},
    ]}
    return parlays, games, projections


def selftest():
    assert parse_utc("2026-09-10T00:20Z") < parse_utc("2026-09-10T00:20:10Z"), \
        "minute-only kickoffs must compare by time, not by string"
    assert parse_utc(None) is None and parse_utc("nonsense") is None
    p1, g, pr = _fixture("2026-09-08T10:39:10Z")
    d1 = append(None, p1, g, pr, "2026-09-08T10:40:00Z")
    keys = {(l["market"], l["selection"]) for l in d1["legs"]}
    assert ("moneyline", "SEA ML") in keys and ("moneyline", "BUF ML") in keys
    assert ("moneyline", "DAL ML") not in keys, "a team not on the slate is skipped"
    assert d1["runs"][0]["skipped"] == {"unknown_market": 0, "no_game": 1, "bad_selection": 0}
    assert len(d1["legs"]) == 8 and d1["runs"][0]["legs_seen"] == 8, len(d1["legs"])
    hen = next(l for l in d1["legs"] if l["selection"].startswith("T. Henderson"))
    assert hen["player"] == "TreVeyon Henderson" and hen["team"] == "NE" \
        and hen["side"] == "away" and hen["gsis_id"] == "espn-1"
    assert hen["p_team"] == 0.39, "p_team is the player's side, from game_predictions"
    assert hen["locked"] is True and hen["locked_utc"] == "2026-09-08T10:39:10Z"
    assert hen["line"] == 59.5 and hen["mu"] == 44.49 and hen["model_prob"] == 0.3142
    jsn = next(l for l in d1["legs"] if l["selection"].startswith("J. Smith"))
    assert jsn["player"] == "Jaxon Smith-Njigba" and jsn["p_team"] == 0.61
    allen = next(l for l in d1["legs"] if l["selection"].startswith("J. Allen"))
    assert allen["player"] is None and allen["team"] is None and allen["p_team"] is None, \
        "two J. Allen QBs on BUF: ambiguous -> null, never a guess"
    sp = next(l for l in d1["legs"] if l["market"] == "spread")
    assert sp["team"] == "SEA" and sp["side"] == "home" and sp["line"] == -3.0
    ml = next(l for l in d1["legs"] if l["selection"] == "BUF ML")
    assert ml["game_id"] == "g-late" and ml["side"] == "away" and ml["p_team"] == 0.45
    # idempotent per as-of: same build -> same document (generated_utc aside)
    d1b = append(d1, p1, g, pr, "2026-09-08T12:00:00Z")
    d1b["generated_utc"] = d1["generated_utc"]
    assert json.dumps(d1b, sort_keys=True) == json.dumps(d1, sort_keys=True)
    assert len(d1b["runs"]) == 1
    # a later build with moved numbers: the locked leg keeps its as-made fields
    p2, _, _ = _fixture("2026-09-09T10:00:00Z", mu=70.0, prob=0.55)
    p2["parlays"][1]["legs"].append({
        "market": "rb_rush_yds", "selection": "Z. Charbonnet 60+ rush yds",
        "implied_prob": 0.4, "model_prob": 0.42, "pricing": "seed", "line": 59.5})
    d2 = append(d1, p2, g, pr, "2026-09-09T10:00:01Z")
    hen2 = next(l for l in d2["legs"] if l["selection"].startswith("T. Henderson"))
    assert hen2 == hen, "a locked leg is immutable"
    assert len(d2["legs"]) == 9 and d2["runs"][-1]["legs_added"] == 1
    zc = next(l for l in d2["legs"] if l["selection"].startswith("Z. Charbonnet"))
    assert zc["player"] is None and zc["pricing"] == "seed" and zc["mu"] is None, \
        "absent as-made fields stay absent"
    # a build AFTER the early game's kickoff: its legs are recorded but not locked
    p3, _, _ = _fixture("2026-09-10T06:00:00Z")
    p3["parlays"][1]["legs"].append({
        "market": "wr_rec_yds", "selection": "C. Kupp 60+ rec yds", "implied_prob": 0.4,
        "model_prob": 0.45, "pricing": "calibrated", "line": 59.5, "mu": 55.0,
        "sd": 41.58, "z": -0.1})
    p3["parlays"][2]["legs"].append({
        "market": "rb_rush_yds", "selection": "I. Pacheco 60+ rush yds", "implied_prob": 0.4,
        "model_prob": 0.45, "pricing": "calibrated", "line": 59.5, "mu": 55.0,
        "sd": 38.87, "z": -0.1})
    d3 = append(d2, p3, g, pr, "2026-09-10T06:00:01Z")
    kupp = next(l for l in d3["legs"] if l["selection"].startswith("C. Kupp"))
    assert kupp["locked"] is False and kupp["locked_utc"] is None \
        and kupp["seen_utc"] == "2026-09-10T06:00:00Z", "seen after kickoff -> not locked"
    pac = next(l for l in d3["legs"] if l["selection"].startswith("I. Pacheco"))
    assert pac["locked"] is True, "the late game has not kicked off: locked"
    assert d3["runs"][-1] == {"as_of_utc": "2026-09-10T06:00:00Z", "week": 1,
                              "legs_seen": 10, "legs_added": 2, "locked_added": 1,
                              "unlocked_added": 1,
                              "skipped": {"unknown_market": 0, "no_game": 1,
                                          "bad_selection": 0}}
    # a leg whose game has no kickoff can never be locked
    g2 = {"games": [dict(x, kickoff_utc=None) for x in g["games"]]}
    d4 = append(None, p1, g2, pr, "x")
    assert all(l["locked"] is False for l in d4["legs"])
    assert [leg_key(l) for l in d3["legs"]] == sorted(leg_key(l) for l in d3["legs"])
    print("selftest OK: idempotent per as-of, first sight locks as-made fields and never "
          "rewrites them, post-kickoff legs recorded unlocked, player + p_team from the "
          "pool (ambiguous -> null), off-slate legs skipped and counted")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
