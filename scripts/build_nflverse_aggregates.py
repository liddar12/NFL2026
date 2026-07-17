"""nflverse-derived aggregates -> data/nflverse_aggregates.json.

Two aggregates (depth-chart continuity deliberately deferred to a later
release — documented, not forgotten):

  combine_oline     Per-team average COMBINE BENCH-PRESS reps for current O-linemen
                    (the strength input the O-line composite was designed around):
                    join the 2025 roster release's OL to combine.csv on
                    (normalized name, OL position family). Join rate reported —
                    a thin join is stated, never hidden.
  score_state_rush  GAME-SCRIPT v2 from real play-by-play: rush share by score
                    state AT THE SNAP (leading by 7+, trailing by 7+, within 7)
                    plus Q4-trailing-by-14+ pass share. This removes the
                    kneel-down confound the full-game game_script.json analysis
                    documented — situational, not game-total.

NETWORK: nflverse release assets 403 through some sandbox proxies but download
fine on GitHub Actions runners. So: real fetches when reachable; on FeedError
the existing output file is left untouched and we exit 0 with a loud stderr
warn (the cron fills it in on the runner). `--selftest` drives the FULL
aggregation pipeline from data/fixtures/nflverse_sample/ so the math is
unit-tested offline regardless of the network.

Weight-0 honesty: this file is CONTEXT (it refines the o-line composite and
records situational splits); no game probability reads it.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape import nflverse  # noqa: E402
from scripts.scrape.renames import normalize_team  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "nflverse_aggregates.json")
FIXTURE_DIR = os.path.join(DATA, "fixtures", "nflverse_sample")
SEASON = 2025

OL_POSITIONS = frozenset(["C", "G", "OG", "T", "OT", "OL"])


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def _norm_name(name):
    """Join key: lowercase, no punctuation/suffixes ("A.J. Smith Jr." -> "aj smith")."""
    s = "".join(c for c in str(name or "").lower() if c.isalpha() or c == " ")
    parts = [p for p in s.split() if p not in ("jr", "sr", "ii", "iii", "iv", "v")]
    return " ".join(parts)


def combine_oline_aggregate(roster_rows, combine_rows):
    """{abbrev: {avg_bench_press, n_tested, n_linemen}} + join-rate stats.

    roster rows need: team, position, full_name (nflverse release columns);
    combine rows need: player_name (or pos+bench_press). Only OL positions
    join; a lineman with no combine bench row simply doesn't contribute
    (n_tested vs n_linemen carries the join quality per team). Pure.
    """
    bench = {}
    for r in combine_rows:
        if str(r.get("pos") or r.get("position") or "").upper() not in OL_POSITIONS:
            continue
        reps = r.get("bench") or r.get("bench_press")
        try:
            reps = float(reps)
        except (TypeError, ValueError):
            continue
        key = _norm_name(r.get("player_name") or r.get("player"))
        if key:
            bench[key] = reps  # newest class wins on collision (rows are chronological)

    teams = {}
    joined = total = 0
    for r in roster_rows:
        if str(r.get("position") or "").upper() not in OL_POSITIONS:
            continue
        ab = normalize_team(r.get("team"))
        if ab is None:
            continue
        total += 1
        t = teams.setdefault(ab, {"reps": [], "n_linemen": 0})
        t["n_linemen"] += 1
        reps = bench.get(_norm_name(r.get("full_name") or r.get("player_name")))
        if reps is not None:
            t["reps"].append(reps)
            joined += 1
    out = {}
    for ab, t in sorted(teams.items()):
        out[ab] = {
            "avg_bench_press": round(sum(t["reps"]) / len(t["reps"]), 2) if t["reps"] else None,
            "n_tested": len(t["reps"]),
            "n_linemen": t["n_linemen"],
        }
    join_rate = round(joined / total, 3) if total else 0.0
    return out, join_rate


def score_state_rush_aggregate(pbp_rows):
    """Rush share by score state at the snap, from pbp rows (streamed or fixture).

    Needs columns: play_type ('run'/'pass' rows only count), posteam_score,
    defteam_score, qtr. Buckets: leading_by_7plus / within_7 / trailing_by_7plus,
    plus q4_trailing_14plus (pass share). Pure; returns {bucket: {..., n_plays}}.
    """
    buckets = {
        "leading_by_7plus": [0, 0],   # [rush, total]
        "within_7": [0, 0],
        "trailing_by_7plus": [0, 0],
        "q4_trailing_14plus": [0, 0],  # [pass, total] — pass share here
    }
    for r in pbp_rows:
        pt = str(r.get("play_type") or "")
        if pt not in ("run", "pass"):
            continue
        try:
            diff = float(r.get("posteam_score")) - float(r.get("defteam_score"))
            qtr = int(float(r.get("qtr")))
        except (TypeError, ValueError):
            continue
        if diff >= 7:
            b = buckets["leading_by_7plus"]
        elif diff <= -7:
            b = buckets["trailing_by_7plus"]
        else:
            b = buckets["within_7"]
        b[1] += 1
        if pt == "run":
            b[0] += 1
        if qtr == 4 and diff <= -14:
            q = buckets["q4_trailing_14plus"]
            q[1] += 1
            if pt == "pass":
                q[0] += 1
    out = {}
    for name, (num, total) in buckets.items():
        share_name = "pass_share" if name.startswith("q4") else "rush_share"
        out[name] = {
            share_name: round(num / total, 4) if total else None,
            "n_plays": total,
        }
    return out


def _fixture_rows(name):
    import csv  # noqa: PLC0415 (selftest-only)
    with open(os.path.join(FIXTURE_DIR, name), encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def build(selftest=False):
    """Build the aggregates doc. selftest=True uses the committed fixtures."""
    if selftest:
        roster = _fixture_rows("roster.csv")
        combine = _fixture_rows("combine.csv")
        pbp = _fixture_rows("pbp.csv")
        source = "selftest fixtures"
    else:
        roster = nflverse.fetch_roster_release(SEASON)
        combine = nflverse.fetch_combine_release()
        pbp = nflverse.iter_pbp_release(SEASON)
        source = f"nflverse release CSVs (roster_{SEASON}, combine, pbp_{SEASON})"

    combine_oline, join_rate = combine_oline_aggregate(roster, combine)
    score_state = score_state_rush_aggregate(pbp)

    import datetime as dt  # noqa: PLC0415 (single stamp, mirrors build_predictions)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "updated_utc": now,
        "season": SEASON,
        "source": source,
        "estimate": True,
        "combine_join_rate": join_rate,
        "combine_oline": combine_oline,
        "score_state_rush": score_state,
        "notes": [
            "combine_oline: avg combine bench-press reps of CURRENT rostered OL "
            "(join by normalized name + OL position; n_tested/n_linemen is the "
            "per-team join quality — thin joins are visible, never hidden).",
            "score_state_rush: situational rush share AT THE SNAP from play-by-play "
            "— the causal follow-up to game_script.json's full-game splits (which "
            "conflate winning-by-running with kneel-downs).",
            "Depth-chart continuity deferred to a later release (documented).",
            "Weight-0: context only — no game probability reads this file.",
        ],
    }


def main():
    selftest = "--selftest" in sys.argv
    try:
        doc = build(selftest=selftest)
    except nflverse.FeedError as exc:
        # Unreachable host (sandbox proxy) — keep any existing file, exit 0
        # loudly. The cron on the GH runner (open network) fills this in.
        print(f"[warn] nflverse aggregates unavailable, existing file untouched: {exc}",
              file=sys.stderr)
        return None
    if selftest:
        # Selftest validates the MATH from fixtures — fixture-derived numbers
        # must never masquerade as real data, so nothing is written.
        print("selftest ok (no file written):", doc["combine_join_rate"],
              doc["score_state_rush"]["leading_by_7plus"])
        return doc
    _write(OUT_PATH, doc)
    ss = doc["score_state_rush"]
    print(f"wrote {OUT_PATH}: combine join rate {doc['combine_join_rate']}, "
          f"lead7+ rush {ss['leading_by_7plus']['rush_share']}, "
          f"trail7+ rush {ss['trailing_by_7plus']['rush_share']}")
    return doc


if __name__ == "__main__":
    main()
