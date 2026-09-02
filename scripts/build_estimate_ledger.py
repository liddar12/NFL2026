#!/usr/bin/env python3
"""Estimate ledger append -> data/estimates/<season>.json (R49 learning loop, step 1).

Owner's brief: "create estimates for the signal to regress and backtest against to
improve the AI". A backtest needs the estimate to exist BEFORE the week is played.
This builder appends, once per pipeline day, for every projected player:

  * baseline_pts   the games-normalized baseline the candidate signals multiply
                   (player_projections.json candidate_baseline)
  * shipped_pts    proj_points as shipped (baseline x adopted weights — all 0 today)
  * candidate_pts  candidate_points (baseline x every raw signal at full strength)
                   with its calibrated band and `signals` = {name: raw_adj}
  * gated_pts      the gate-conforming number (gated_points; == shipped_pts before
                   the R49 owner override, and the never-regress incumbent after
                   it, when shipped == candidate) — THREE series per player-week
  * weeks          the shipped weekly split (player_weekly.json weeks[].pts), so a
                   (player, week) estimate is candidate_pts x weeks[w]/sum(weeks)

The weights applied on that day sit once in `runs`, not on every row.

COMPACT BY CONSTRUCTION (the ~2 MB brief): per player only the FIRST as-of and the
LATEST as-of are kept, plus `locked` — the per-week estimate frozen at the last
as-of BEFORE that week's first kickoff (data/schedule_full.json). A week is locked
from the PREVIOUS latest on the first append after its kickoff; the locked entry
is what scripts/resolve_estimates.py scores, and nothing written after kickoff can
ever change it. A week whose kickoff passed before any ledger existed simply has
no locked estimate (honest — there was none).

IDEMPOTENT PER DAY: as_of_utc is player_projections.json's updated_utc, so a
re-run on the same build changes no bytes.

Stdlib only, no network. --selftest drives the pure core (`append`) on fixtures.
"""

import argparse
import datetime as dt
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

DATA = os.path.join(_ROOT, "data")
LEDGER_DIR = os.path.join(DATA, "estimates")
PROJECTIONS_PATH = os.path.join(DATA, "player_projections.json")
WEEKLY_PATH = os.path.join(DATA, "player_weekly.json")
SCHEDULE_PATH = os.path.join(DATA, "schedule_full.json")
META_PATH = os.path.join(DATA, "meta.json")
SEASON_GAMES = 17
WEEKS = 18
SOURCE = ("scripts/build_estimate_ledger.py over data/player_projections.json "
          "(shipped + candidate) and data/player_weekly.json (weekly split); "
          "kickoffs from data/schedule_full.json")


def ledger_path(season):
    return os.path.join(LEDGER_DIR, "%d.json" % int(season))


# --------------------------------------------------------------------------- #
# pure core                                                                     #
# --------------------------------------------------------------------------- #

def kickoffs_by_week(schedule_games):
    """{week: earliest kickoff_utc ISO string} over schedule_full-shaped rows."""
    out = {}
    for g in schedule_games or []:
        wk, k = g.get("week"), g.get("kickoff_utc")
        if not isinstance(wk, int) or not k:
            continue
        if wk not in out or k < out[wk]:
            out[wk] = k
    return out


def _estimate(row, weeks, as_of):
    return {
        "as_of_utc": as_of,
        "baseline_pts": round(float(row.get("candidate_baseline",
                                            row.get("proj_points", 0.0)) or 0.0), 2),
        "shipped_pts": round(float(row.get("proj_points") or 0.0), 2),
        "candidate_pts": round(float(row.get("candidate_points",
                                             row.get("proj_points", 0.0)) or 0.0), 2),
        "candidate_low": round(float(row.get("candidate_low", row.get("low", 0.0))
                                     or 0.0), 2),
        "candidate_high": round(float(row.get("candidate_high", row.get("high", 0.0))
                                      or 0.0), 2),
        "gated_pts": round(float(row.get("gated_points", row.get("proj_points", 0.0))
                                 or 0.0), 2),
        "signals": {k: round(float(v), 4)
                    for k, v in sorted((row.get("candidate_signals") or {}).items())},
        "weeks": [round(float(w), 2) for w in weeks],
    }


def week_estimate(est, week):
    """The (player, week) estimate implied by a season estimate: the shipped
    weekly split scaled by candidate/shipped. Pure."""
    weeks = est["weeks"]
    total = sum(weeks)
    share = (weeks[week - 1] / total) if total > 0 else 0.0
    return {
        "as_of_utc": est["as_of_utc"],
        "baseline": round(est["baseline_pts"] * share, 2),
        "shipped": round(weeks[week - 1], 2),
        "candidate": round(est["candidate_pts"] * share, 2),
        "gated": round(float(est.get("gated_pts", est["shipped_pts"])) * share, 2),
        "low": round(est["candidate_low"] * share, 2),
        "high": round(est["candidate_high"] * share, 2),
        "signals": dict(est["signals"]),
    }


def append(ledger, projections, weekly, kickoffs, weights, season, generated_utc):
    """One append. ledger may be None (first run). Returns the NEW document.

    Idempotent: when ledger.as_of_utc == projections.updated_utc the returned
    document equals the input (generated_utc aside — the caller keeps the old
    bytes in that case).
    """
    as_of = projections.get("updated_utc")
    if not as_of:
        raise ValueError("player_projections.json has no updated_utc")
    weekly_by_id = {p["gsis_id"]: p for p in (weekly or {}).get("players") or []}
    rule = None
    mode = None
    players_out = {}
    prev_players = (ledger or {}).get("players") or {}
    locked_now = set()
    for row in projections.get("players") or []:
        pid = row.get("gsis_id")
        wk = weekly_by_id.get(pid)
        if not pid or not wk:
            continue          # a player with no weekly split has no per-week estimate
        weeks = [0.0] * WEEKS
        for w in wk.get("weeks") or []:
            i = int(w.get("wk", 0)) - 1
            if 0 <= i < WEEKS:
                weeks[i] = float(w.get("pts") or 0.0)
        est = _estimate(row, weeks, as_of)
        rule = rule or row.get("baseline_rule") or "prior_season_points"
        mode = mode or row.get("shipped_estimate") or "gated"
        prev = prev_players.get(pid)
        first = prev["first"] if prev else est
        locked = dict(prev["locked"]) if prev else {}
        if prev:
            # Lock every week whose kickoff has passed as of THIS append, from the
            # previous latest — the last estimate written before the kickoff.
            p_latest = prev["latest"]
            for week, kick in kickoffs.items():
                key = str(week)
                if key in locked or kick > as_of or p_latest["as_of_utc"] >= kick:
                    continue
                locked[key] = week_estimate(p_latest, int(week))
                locked_now.add(int(week))
        players_out[pid] = {
            "name": row.get("name", ""),
            "team": row.get("team", ""),
            "position": row.get("position", ""),
            "first": first,
            "latest": est,
            "locked": dict(sorted(locked.items(), key=lambda kv: int(kv[0]))),
        }
    runs = list((ledger or {}).get("runs") or [])
    if not any(r.get("as_of_utc") == as_of for r in runs):
        entry = {"as_of_utc": as_of, "shipped_rule": rule or "prior_season_points",
                 "shipped_estimate": mode or "gated",
                 "weights_applied": {k: float(v) for k, v in sorted((weights or {}).items())},
                 "players": len(players_out)}
        if locked_now:
            entry["weeks_locked"] = sorted(locked_now)
        runs.append(entry)
    return {
        "season": int(season),
        "generated_utc": generated_utc,
        "as_of_utc": as_of,
        "source": SOURCE,
        "season_games": SEASON_GAMES,
        "note": ("per player: first as-of, latest as-of, and `locked` = the per-week "
                 "estimate frozen at the last as-of before that week's first kickoff "
                 "(the row the resolver scores). A week's estimate = season estimate "
                 "x weeks[w]/sum(weeks)."),
        "runs": runs,
        "players": players_out,
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
        # Compact on purpose (the 2 MB brief): 18-float arrays per player would
        # cost ~3 MB at indent=2. data/estimates/ is outside the top-level
        # canonical-style audit; ensure_ascii + trailing newline are kept.
        json.dump(doc, fh, ensure_ascii=True, separators=(",", ":"), sort_keys=False)
        fh.write("\n")


def run(projections_path=PROJECTIONS_PATH, weekly_path=WEEKLY_PATH,
        schedule_path=SCHEDULE_PATH, meta_path=META_PATH, out_dir=LEDGER_DIR, now=None):
    projections = _load(projections_path)
    weekly = _load(weekly_path)
    kickoffs = kickoffs_by_week(_load(schedule_path).get("games") if
                                os.path.exists(schedule_path) else [])
    weights = (_load(meta_path).get("weights") if os.path.exists(meta_path) else {}) or {}
    season = int(projections["season"])
    path = os.path.join(out_dir, "%d.json" % season)
    prev = _load(path) if os.path.exists(path) else None
    if prev and prev.get("as_of_utc") == projections.get("updated_utc"):
        print("estimate ledger: as-of %s already appended -> no change (%s)"
              % (prev["as_of_utc"], path))
        return prev, False
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = append(prev, projections, weekly, kickoffs, weights, season, now)
    write(doc, path)
    n_locked = sum(len(p["locked"]) for p in doc["players"].values())
    print("estimate ledger: appended as-of %s for %d players (%d runs, %d locked "
          "player-weeks) -> %s (%d bytes)"
          % (doc["as_of_utc"], len(doc["players"]), len(doc["runs"]), n_locked, path,
             os.path.getsize(path)))
    return doc, True


# --------------------------------------------------------------------------- #
# selftest                                                                      #
# --------------------------------------------------------------------------- #

def _fixture(as_of, shipped=170.0, cand=200.0):
    proj = {"season": 2026, "updated_utc": as_of, "players": [
        {"gsis_id": "espn-1", "name": "A Back", "team": "SF", "position": "RB",
         "proj_points": shipped, "low": 150.0, "high": 190.0, "signals_used": [],
         "baseline_rule": "prior_season_points", "candidate_baseline": 180.0,
         "candidate_points": cand, "candidate_low": cand * 0.8,
         "candidate_high": cand * 1.2, "candidate_signals": {"age_curve": 1.05},
         "gated_points": 165.0, "shipped_estimate": "candidate"}]}
    weeks = [{"wk": i + 1, "pts": (0.0 if i == 8 else shipped / 17.0), "bye": i == 8}
             for i in range(18)]
    weekly = {"players": [{"gsis_id": "espn-1", "weeks": weeks}]}
    return proj, weekly


def selftest():
    kick = {w: "2026-09-%02dT17:00:00Z" % (9 + 7 * (w - 1)) for w in (1, 2, 3)}
    kick[2] = "2026-09-16T17:00:00Z"
    weights = {"age_curve": 0.0}
    p1, w1 = _fixture("2026-09-01T06:00:00Z")
    d1 = append(None, p1, w1, kick, weights, 2026, "2026-09-01T06:00:01Z")
    e = d1["players"]["espn-1"]
    assert e["first"] == e["latest"] and e["locked"] == {}, "first run: nothing to lock"
    assert len(e["latest"]["weeks"]) == 18 and e["latest"]["weeks"][8] == 0.0
    assert d1["runs"][0]["weights_applied"] == {"age_curve": 0.0}
    # idempotent per day: same as-of -> same document (generated_utc aside)
    d1b = append(d1, p1, w1, kick, weights, 2026, "2026-09-01T09:00:00Z")
    d1b["generated_utc"] = d1["generated_utc"]
    assert json.dumps(d1b, sort_keys=True) == json.dumps(d1, sort_keys=True), \
        "a second append on the same as-of must change nothing"
    assert len(d1b["runs"]) == 1
    # a later day before any kickoff: latest moves, first stays, nothing locked
    p2, w2 = _fixture("2026-09-05T06:00:00Z", shipped=175.0, cand=210.0)
    d2 = append(d1, p2, w2, kick, weights, 2026, "2026-09-05T06:00:01Z")
    e = d2["players"]["espn-1"]
    assert e["first"]["as_of_utc"] == "2026-09-01T06:00:00Z"
    assert e["latest"]["shipped_pts"] == 175.0 and e["locked"] == {}
    # first append AFTER week 1 kicked off: week 1 locks from the PREVIOUS latest
    p3, w3 = _fixture("2026-09-10T06:00:00Z", shipped=160.0, cand=190.0)
    d3 = append(d2, p3, w3, kick, weights, 2026, "2026-09-10T06:00:01Z")
    e = d3["players"]["espn-1"]
    assert list(e["locked"]) == ["1"], e["locked"]
    lk = e["locked"]["1"]
    assert lk["as_of_utc"] == "2026-09-05T06:00:00Z", "locked from the last pre-kickoff as-of"
    assert abs(lk["shipped"] - 175.0 / 17) < 0.01
    assert abs(lk["candidate"] - 210.0 / 17) < 0.02 and lk["low"] < lk["candidate"] < lk["high"]
    assert lk["signals"] == {"age_curve": 1.05}
    assert abs(lk["gated"] - 165.0 / 17) < 0.02, "the gated series rides every locked week"
    assert d3["runs"][-1]["shipped_estimate"] == "candidate"
    assert e["latest"]["shipped_pts"] == 160.0, "latest still moves for the remaining weeks"
    assert d3["runs"][-1]["weeks_locked"] == [1]
    # re-appending later never rewrites a locked week
    p4, w4 = _fixture("2026-09-12T06:00:00Z", shipped=100.0, cand=100.0)
    d4 = append(d3, p4, w4, kick, weights, 2026, "2026-09-12T06:00:01Z")
    assert d4["players"]["espn-1"]["locked"]["1"] == lk, "a locked week is immutable"
    # a week whose kickoff passed with no pre-kickoff estimate is NOT locked
    p5, w5 = _fixture("2026-09-20T06:00:00Z")
    d5 = append(None, p5, w5, kick, weights, 2026, "2026-09-20T06:00:01Z")
    assert d5["players"]["espn-1"]["locked"] == {}, "no estimate existed before kickoff"
    assert kickoffs_by_week([{"week": 1, "kickoff_utc": "b"}, {"week": 1, "kickoff_utc": "a"}]) == {1: "a"}
    print("selftest OK: idempotent per as-of, first/latest kept, weeks lock from the "
          "last pre-kickoff estimate and never change, no estimate -> no lock")


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
