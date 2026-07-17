"""Game-script model — MEASURED 2025 run/pass tendency by game state.

Tests the user's game-script theory with numbers, not vibes:
  - do winners run more (and losers pass more) over a full game?
  - does the winner's rush-share edge grow with final margin (correlation)?
  - blowouts vs one-score games: winner rush share in each;
  - garbage time: teams trailing by >= 14 entering Q4 — do they score more in Q4
    than their own Q1-Q3 pace (late TDs against soft coverage)?

Everything here is MEASURED HISTORY from FINAL 2025 games (each split carries its
sample size n and a low_n flag when n < 8). CAUSATION CAVEAT recorded in notes:
full-game totals conflate cause and effect (teams that run well win AND winners
run out the clock), so these are DESCRIPTIVE deltas. The derived params are
RECORDED in game_script.json with applied=false / weight 0.0 — game probabilities
do not change because this file exists.

Raw fetched rows are cached to data/fixtures/gamestats_2025.json; a re-run (and
the tests) read the cache instead of re-hitting ESPN ~272 times.

Run it for real (network + `requests`, a few minutes of polite API calls):
    python3 -m scripts.build_gamescript
The fast gate never runs this; it validates the committed game_script.json.
"""

import datetime as dt
import json
import math
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape import espn_gamestats  # noqa: E402

SEASON = 2025
LOW_N = 8                 # a split with n < 8 is reported but flagged low_n:true
BLOWOUT_MARGIN = 14       # final margin >= 14 = blowout
ONE_SCORE_MARGIN = 8      # final margin <= 8 = one-score game
GARBAGE_DEFICIT = 14      # trailing by >= 14 entering Q4 = garbage-time candidate

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "game_script.json")
CACHE_PATH = os.path.join(DATA, "fixtures", "gamestats_%d.json" % SEASON)


def _utc_now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def _pearson(xs, ys):
    """Pearson correlation; 0.0 when either side has no variance."""
    n = len(xs)
    if n < 2:
        return 0.0
    mx, my = _mean(xs), _mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return 0.0
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / math.sqrt(sxx * syy)


def load_rows():
    """Season rows from the fixture cache if present, else fetch fresh from ESPN
    (and write the cache so re-runs and tests never refetch)."""
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH, encoding="utf-8") as fh:
            doc = json.load(fh)
        rows = doc.get("games") or []
        if not rows:
            raise espn_gamestats.FeedError(
                f"{CACHE_PATH} exists but has zero games — delete it and re-fetch."
            )
        print(f"cache: {len(rows)} games from {CACHE_PATH}")
        return rows
    print(f"fetching {SEASON} per-game stats from ESPN (~272 summary calls)...")
    rows = espn_gamestats.fetch_season_gamestats(SEASON, log=print)
    _write(CACHE_PATH, {
        "season": SEASON,
        "fetched_utc": _utc_now(),
        "source": "espn scoreboard + summary boxscore",
        "games": rows,
    })
    print(f"cached {len(rows)} games to {CACHE_PATH}")
    return rows


def _rush_share(t):
    tot = t["rush_att"] + t["pass_att"]
    return t["rush_att"] / tot if tot else 0.0


def analyze(rows):
    """All splits from the raw rows. Ties are excluded from winner/loser splits
    (no winner to attribute the script to); OT periods beyond Q4 are ignored for
    the entering-Q4 state but OT points never count as Q4 points either."""
    # Winner/loser volume splits (decided games only).
    w_rush, l_rush, w_pass, l_pass = [], [], [], []
    w_shares, l_shares, share_diffs, margins = [], [], [], []
    blowout_shares, one_score_shares = [], []
    for g in rows:
        hs, as_ = g["home_score"], g["away_score"]
        if hs == as_:
            continue
        win_ab, lose_ab = (g["home"], g["away"]) if hs > as_ else (g["away"], g["home"])
        wt, lt = g["teams"][win_ab], g["teams"][lose_ab]
        margin = abs(hs - as_)
        w_rush.append(wt["rush_att"])
        l_rush.append(lt["rush_att"])
        w_pass.append(wt["pass_att"])
        l_pass.append(lt["pass_att"])
        w_shares.append(_rush_share(wt))
        l_shares.append(_rush_share(lt))
        share_diffs.append(_rush_share(wt) - _rush_share(lt))
        margins.append(margin)
        if margin >= BLOWOUT_MARGIN:
            blowout_shares.append(_rush_share(wt))
        elif margin <= ONE_SCORE_MARGIN:
            one_score_shares.append(_rush_share(wt))

    # Garbage-time proxy: trailing by >= 14 entering Q4 (linescore periods 1-3),
    # compare that team's Q4 points to its own Q1-Q3 per-quarter pace. Q4 points
    # >= 7 is the "late TD" proxy rate.
    q4_pts, q123_pace, q4_td = [], [], []
    for g in rows:
        pairs = (
            (g["home_linescores"], g["away_linescores"]),
            (g["away_linescores"], g["home_linescores"]),
        )
        for mine, theirs in pairs:
            if len(mine) < 4 or len(theirs) < 4:
                continue  # shortened game; no Q4 state to evaluate
            deficit = sum(theirs[:3]) - sum(mine[:3])
            if deficit >= GARBAGE_DEFICIT:
                q4_pts.append(mine[3])
                q123_pace.append(sum(mine[:3]) / 3.0)
                q4_td.append(1 if mine[3] >= 7 else 0)

    n_dec = len(w_rush)
    n_gt = len(q4_pts)
    rush_delta = _mean(w_rush) - _mean(l_rush)
    pass_delta = _mean(w_pass) - _mean(l_pass)
    share_delta = _mean(share_diffs)
    gt_delta = _mean(q4_pts) - _mean(q123_pace)
    return {
        "rush_attempts": {
            "winner_avg": round(_mean(w_rush), 2),
            "loser_avg": round(_mean(l_rush), 2),
            "delta": round(rush_delta, 2),
            "n": n_dec,
            "low_n": n_dec < LOW_N,
        },
        "pass_attempts": {
            "winner_avg": round(_mean(w_pass), 2),
            "loser_avg": round(_mean(l_pass), 2),
            "delta": round(pass_delta, 2),
            "n": n_dec,
            "low_n": n_dec < LOW_N,
        },
        "rush_share": {
            "winner_avg": round(_mean(w_shares), 4),
            "loser_avg": round(_mean(l_shares), 4),
            "delta": round(share_delta, 4),
            "margin_correlation": round(_pearson(share_diffs, margins), 4),
            "n": n_dec,
            "low_n": n_dec < LOW_N,
        },
        "winner_rush_share_blowout": {
            "avg": round(_mean(blowout_shares), 4),
            "n": len(blowout_shares),
            "low_n": len(blowout_shares) < LOW_N,
        },
        "winner_rush_share_one_score": {
            "avg": round(_mean(one_score_shares), 4),
            "n": len(one_score_shares),
            "low_n": len(one_score_shares) < LOW_N,
        },
        "garbage_time": {
            "trailing_q4_avg_points": round(_mean(q4_pts), 2),
            "trailing_q123_avg_points_per_quarter": round(_mean(q123_pace), 2),
            "delta": round(gt_delta, 2),
            "q4_td_rate": round(_mean(q4_td), 4),
            "n": n_gt,
            "low_n": n_gt < LOW_N,
        },
    }, rush_delta, pass_delta, share_delta, gt_delta


def main():
    rows = load_rows()
    if len(rows) < 250:
        raise espn_gamestats.FeedError(
            f"season {SEASON}: only {len(rows)} FINAL games with stats (expected "
            f"~272) — partial season or outage, refusing to publish thin splits."
        )
    splits, rush_delta, pass_delta, share_delta, gt_delta = analyze(rows)
    doc = {
        "season": SEASON,
        "updated_utc": _utc_now(),
        "games_analyzed": len(rows),
        "splits": splits,
        "params": {
            # DESCRIPTIVE deltas only, recorded for the optimizer. Weight-0
            # discipline: nothing downstream may read these until an explicit
            # NEVER-REGRESS adoption flips applied.
            "rush_lean_when_leading": {
                "value": round(share_delta, 4),
                "applied": False,
                "weight": 0.0,
            },
            "trailing_pass_boost": {
                "value": round(gt_delta, 2),
                "applied": False,
                "weight": 0.0,
            },
        },
        "estimate": True,
        "notes": [
            f"Measured from {len(rows)} FINAL {SEASON} regular-season games (ESPN "
            f"scoreboard + summary boxscore, STATUS-gated). Ties excluded from "
            f"winner/loser splits.",
            "CAUSATION CAVEAT: full-game totals conflate cause and effect. Winners "
            "out-rushing losers mixes 'good running wins games' with 'leading teams "
            "kneel on the clock'. These are DESCRIPTIVE deltas, not causal effects.",
            f"Blowout = final margin >= {BLOWOUT_MARGIN}; one-score = margin <= "
            f"{ONE_SCORE_MARGIN}. rush_share = rushAtt / (rushAtt + passAtt).",
            f"garbage_time: teams trailing by >= {GARBAGE_DEFICIT} entering Q4 (from "
            f"scoreboard linescores, periods 1-3). Q4 points only (OT excluded); "
            f"q4_td_rate = share of those teams scoring >= 7 in Q4 (TD proxy, since "
            f"linescores carry points, not scoring plays).",
            "params.rush_lean_when_leading.value = mean winner-minus-loser rush-share "
            "gap; params.trailing_pass_boost.value = trailing team's Q4 points minus "
            "its own Q1-Q3 per-quarter pace. Both recorded at weight 0 / applied "
            "false; game probabilities are unchanged by this file.",
            f"Raw rows cached at data/fixtures/gamestats_{SEASON}.json; delete the "
            f"cache to force a refetch.",
        ],
    }
    _write(OUT_PATH, doc)
    print(f"wrote {OUT_PATH}: {len(rows)} games")
    print(f"  winner-loser rush att delta {rush_delta:+.2f}, pass att delta {pass_delta:+.2f}")
    print(f"  rush-share delta {share_delta:+.4f}, corr with margin "
          f"{splits['rush_share']['margin_correlation']:+.4f}")
    print(f"  garbage-time Q4 uplift {gt_delta:+.2f} pts "
          f"(n={splits['garbage_time']['n']}, td rate {splits['garbage_time']['q4_td_rate']:.3f})")


if __name__ == "__main__":
    main()
