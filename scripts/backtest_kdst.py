#!/usr/bin/env python3
"""R55 never-regress gate for the D/ST WEEKLY SPLIT -> data/kdst_backtest.json.

THE QUESTION, AND WHY IT IS THE ONLY ONE ASKED
----------------------------------------------
Until R55 every D/ST week was the season projection divided by games played: the
same number in week 1 and week 17, at home and away, against the best offence in
the league and the worst. The split multiplies that base by what the opponent
SURRENDERS to opposing defences and by home field, then renormalises so the
season total is untouched. So the only thing that changed is the SHAPE, and the
only honest question is whether that shape is closer to what happened.

Both arms therefore share one season level, computed from PRIOR seasons only:
  flat   base = recency-weighted prior-season points per game, every week
  split  base x opponent factor x home tilt, renormalised back to base x weeks
MAE against the resolved week (data/kdst_weekly_history.json).

NEVER-REGRESS. --gate exits non-zero unless the split's pooled MAE beats flat by
more than ADOPT_MARGIN *and* the 95% interval on the paired difference excludes
zero. A tie is a REFUSAL: a model that is not measurably better does not earn
the extra moving part. The gate also refuses a corpus too short to answer.

WALK-FORWARD, NO PEEKING. The opponent rate for season S week W blends season
S-1 at half weight with season S's weeks STRICTLY BEFORE W. Nothing in the fold
can see the week it is predicting, and the selftest plants a signal to prove the
harness can find one and a shuffle to prove it can refuse one.

KICKERS ARE NOT HERE, and that is the finding. Run over this same grid the best
kicker configuration moved MAE by -0.008 +/- 0.014 (not significant) and every
stronger setting made it worse, so no kicker split was built to gate.

  python3 scripts/backtest_kdst.py            write data/kdst_backtest.json
  python3 scripts/backtest_kdst.py --gate     exit non-zero on a regression
  python3 scripts/backtest_kdst.py --selftest planted-signal + refusal proofs
"""
import argparse
import datetime as _dt
import json
import math
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.build_kdst import (  # noqa: E402
    DATA, SPLIT_CLAMP, SPLIT_HOME, SPLIT_MODEL, SPLIT_PRIOR_WEIGHT,
    SPLIT_SHRINK, KICKER_SPLIT_REASON,
)

HISTORY = os.path.join(DATA, "kdst_weekly_history.json")
OUT = os.path.join(DATA, "kdst_backtest.json")
# The seasons scored. Each needs two prior seasons on file for the blend.
FOLD_SEASONS = (2023, 2024, 2025)
RECENCY = ((1, 3.0), (2, 2.0), (3, 1.0))   # build_kdst's season stack
ADOPT_MARGIN = 0.02        # MAE points the split must beat flat by
MIN_ROWS = 800             # below this the corpus cannot answer the question
MIN_SEASONS = 2


def load_rows(path=HISTORY):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["rows"]


class Corpus:
    """Indexed rows. Every lookup is walk-forward by construction: the methods
    take the season and week being predicted and never read at or beyond it."""

    def __init__(self, rows):
        self.rows = rows
        self.by_team_season = {}
        self.surrendered = {}      # (opp, season) -> [pts the opp gave up]
        self.by_season = {}
        for r in rows:
            self.by_team_season.setdefault((r["team"], r["season"]), []).append(r)
            self.surrendered.setdefault((r["opp"], r["season"]), []).append(r)
            self.by_season.setdefault(r["season"], []).append(r)

    def level(self, team, season):
        """Recency-weighted prior-season points per game — the flat arm, and the
        level both arms share. None when the team has no prior season at all."""
        num = den = 0.0
        for back, w in RECENCY:
            prev = self.by_team_season.get((team, season - back))
            if not prev:
                continue
            num += w * (sum(r["pts"] for r in prev) / len(prev))
            den += w
        return (num / den) if den else None

    def opp_rate(self, opp, season, week):
        """What `opp` surrenders per game, season-to-date blended with the prior
        season at half weight. Strictly before `week` — the no-peek rule."""
        num = den = 0.0
        cur = [r for r in self.surrendered.get((opp, season), []) if r["week"] < week]
        if cur:
            num += sum(r["pts"] for r in cur)
            den += len(cur)
        pri = self.surrendered.get((opp, season - 1), [])
        if pri:
            num += SPLIT_PRIOR_WEIGHT * sum(r["pts"] for r in pri)
            den += SPLIT_PRIOR_WEIGHT * len(pri)
        return (num / den) if den else None

    def league_rate(self, season, week):
        num = den = 0.0
        cur = [r for r in self.by_season.get(season, []) if r["week"] < week]
        if cur:
            num += sum(r["pts"] for r in cur)
            den += len(cur)
        pri = self.by_season.get(season - 1, [])
        if pri:
            num += SPLIT_PRIOR_WEIGHT * sum(r["pts"] for r in pri)
            den += SPLIT_PRIOR_WEIGHT * len(pri)
        return (num / den) if den else None


def _clamp(x, lo, hi):
    return lo if x < lo else (hi if x > hi else x)


def fold(corpus, seasons, shrink=SPLIT_SHRINK, home=SPLIT_HOME, clamp=SPLIT_CLAMP):
    """[(season, flat_abs_err, split_abs_err)] — one pair per scored team-week."""
    lo, hi = clamp
    pairs = []
    for season in seasons:
        teams = sorted({r["team"] for r in corpus.by_season.get(season, [])})
        for team in teams:
            rows = sorted(corpus.by_team_season.get((team, season), []),
                          key=lambda r: r["week"])
            base = corpus.level(team, season)
            if base is None or not rows:
                continue
            raw = []
            for r in rows:
                rate = corpus.opp_rate(r["opp"], season, r["week"])
                lg = corpus.league_rate(season, r["week"])
                f = _clamp(1.0 + shrink * (rate / lg - 1.0), lo, hi) \
                    if (rate and lg) else 1.0
                f *= (1.0 + home) if r["home"] else (1.0 - home)
                raw.append(base * f)
            total = sum(raw)
            scale = (base * len(raw) / total) if total > 0 else 1.0
            for r, x in zip(rows, raw):
                pairs.append((season, abs(base - r["pts"]), abs(x * scale - r["pts"])))
    return pairs


def verdict(pairs, margin=ADOPT_MARGIN):
    """Pooled MAEs plus the 95% interval on the PAIRED difference. Paired,
    because both arms score the identical rows — an unpaired interval here would
    be wider than the truth and would hide a real gain behind team variance."""
    if not pairs:
        return {"n": 0, "flat_mae": None, "split_mae": None, "delta": None,
                "ci95": None, "beats_flat": False,
                "why": "no rows scored — nothing to compare"}
    n = len(pairs)
    flat = sum(p[1] for p in pairs) / n
    split = sum(p[2] for p in pairs) / n
    diffs = [p[2] - p[1] for p in pairs]
    mean = sum(diffs) / n
    var = sum((d - mean) ** 2 for d in diffs) / n
    half = 1.96 * math.sqrt(var / n)
    beats = (mean < -margin) and (mean + half < 0)
    return {
        "n": n,
        "flat_mae": round(flat, 4),
        "split_mae": round(split, 4),
        "delta": round(mean, 4),
        "ci95": [round(mean - half, 4), round(mean + half, 4)],
        "margin": margin,
        "beats_flat": beats,
        "why": ("split beats flat by %.4f, 95%% CI [%.4f, %.4f] excludes 0"
                % (-mean, mean - half, mean + half)) if beats else
               ("split does NOT clear the gate: delta %.4f, 95%% CI [%.4f, %.4f], "
                "margin %.2f" % (mean, mean - half, mean + half, margin)),
    }


def build(rows=None):
    rows = rows if rows is not None else load_rows()
    corpus = Corpus(rows)
    seasons = [s for s in FOLD_SEASONS if s in corpus.by_season]
    pooled = verdict(fold(corpus, seasons))
    per_season = {str(s): verdict(fold(corpus, [s])) for s in seasons}
    return {
        "generated_utc": _dt.datetime.now(_dt.timezone.utc)
                            .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": SPLIT_MODEL,
        "corpus": {"rows": len(rows),
                   "seasons": sorted({r["season"] for r in rows}),
                   "folds": seasons},
        "params": {"shrink": SPLIT_SHRINK, "clamp": list(SPLIT_CLAMP),
                   "home_coef": SPLIT_HOME, "prior_weight": SPLIT_PRIOR_WEIGHT},
        "pooled": pooled,
        "per_season": per_season,
        "kicker": {"split": False, "reason": KICKER_SPLIT_REASON},
        "note": "flat = the season projection divided by games played, every "
                "week, which is what shipped before R55. split = the same level "
                "reshaped by the opponent's surrendered D/ST points and home "
                "field, renormalised so the season total is unchanged. Both arms "
                "score identical rows, so the interval is paired. No market "
                "number is read anywhere in this file.",
    }


def gate(doc):
    """Exit code, and the reason on stderr. Refuses on a short corpus as loudly
    as on a regression: a gate that cannot see enough to answer must not pass."""
    c = doc["corpus"]
    if len(c["seasons"]) < MIN_SEASONS or doc["pooled"]["n"] < MIN_ROWS:
        print("[gate] REFUSED: corpus too short to answer — %d row(s) over %d "
              "season(s), need >= %d over >= %d"
              % (doc["pooled"]["n"], len(c["seasons"]), MIN_ROWS, MIN_SEASONS),
              file=sys.stderr)
        return 1
    if not doc["pooled"]["beats_flat"]:
        print("[gate] REFUSED: %s" % doc["pooled"]["why"], file=sys.stderr)
        return 1
    print("[gate] kdst weekly split PASS: flat %.4f -> split %.4f (%s)"
          % (doc["pooled"]["flat_mae"], doc["pooled"]["split_mae"],
             doc["pooled"]["why"]))
    return 0


def _synthetic(signal):
    """A two-season toy league. `signal` scales how much a team's output depends
    on the opponent it faces; at 0.0 the weeks are pure noise and the split has
    nothing to find."""
    teams = ["T%02d" % i for i in range(12)]
    weakness = {t: 1.0 + 0.4 * ((i % 4) - 1.5) / 1.5 for i, t in enumerate(teams)}
    rows = []
    seed = 7
    for season in (2021, 2022, 2023):
        for week in range(1, 12):
            order = teams[week % len(teams):] + teams[:week % len(teams)]
            for a, b in zip(order[::2], order[1::2]):
                for team, opp, home in ((a, b, True), (b, a, False)):
                    seed = (1103515245 * seed + 12345) % (1 << 31)
                    noise = (seed / (1 << 31)) * 4.0 - 2.0
                    pts = 8.0 + signal * 6.0 * (weakness[opp] - 1.0) + noise
                    rows.append({"season": season, "week": week, "team": team,
                                 "opp": opp, "home": home,
                                 "pts": round(max(pts, 0.0), 3)})
    return rows


def selftest():
    # 1. a planted opponent signal is FOUND
    strong = build(_synthetic(signal=1.0))
    assert strong["pooled"]["beats_flat"], strong["pooled"]
    assert strong["pooled"]["delta"] < 0, strong["pooled"]

    # 2. no signal -> the gate REFUSES rather than adopting noise
    flat_world = build(_synthetic(signal=0.0))
    assert not flat_world["pooled"]["beats_flat"], flat_world["pooled"]

    # 3. no peeking: a fold's prediction cannot move when a LATER week changes
    rows = _synthetic(signal=1.0)
    corpus = Corpus(rows)
    before = corpus.opp_rate("T01", 2023, 5)
    tampered = [dict(r) for r in rows]
    for r in tampered:
        if r["season"] == 2023 and r["week"] >= 5 and r["opp"] == "T01":
            r["pts"] += 50.0
    assert Corpus(tampered).opp_rate("T01", 2023, 5) == before, \
        "a later week leaked into an earlier fold"

    # 4. the split never invents season points — it only moves them
    c2 = Corpus(rows)
    for team in {r["team"] for r in rows if r["season"] == 2023}:
        wk = sorted(c2.by_team_season.get((team, 2023), []), key=lambda r: r["week"])
        base = c2.level(team, 2023)
        if base is None or not wk:
            continue
        raw = []
        for r in wk:
            rate, lg = c2.opp_rate(r["opp"], 2023, r["week"]), c2.league_rate(2023, r["week"])
            f = _clamp(1 + SPLIT_SHRINK * (rate / lg - 1), *SPLIT_CLAMP) if (rate and lg) else 1.0
            f *= (1 + SPLIT_HOME) if r["home"] else (1 - SPLIT_HOME)
            raw.append(base * f)
        scale = base * len(raw) / sum(raw)
        assert abs(sum(x * scale for x in raw) - base * len(raw)) < 1e-9, team

    # 5. the gate refuses a corpus too short to answer, however good it looks
    short = build(_synthetic(signal=1.0)[:50])
    assert gate(short) == 1, "a 50-row corpus must not pass"

    # 6. verdict maths: a tie is a refusal, not a pass
    tie = verdict([(2023, 1.0, 1.0)] * 500)
    assert not tie["beats_flat"] and tie["delta"] == 0.0, tie
    tiny = verdict([(2023, 1.0, 0.995)] * 5000)
    assert not tiny["beats_flat"], "a gain under the margin is not adoption"

    print("selftest OK: planted signal found, noise refused, no later week "
          "leaks into an earlier fold, the split conserves the season total, "
          "a short corpus and a tie are both refusals")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gate", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    doc = build()
    if args.gate:
        return gate(doc)
    with open(OUT, "w", encoding="utf-8") as fh:
        # The repo's one on-disk convention (CLAUDE.md, gated by tests/smoke.sh):
        # ensure_ascii=True, indent=2, trailing newline, NO sort_keys.
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    print("wrote %s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
