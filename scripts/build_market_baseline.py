"""BUILD data/market_baseline.json — historical MONEYLINE-implied home win
probabilities (de-vigged) for resolved games, from the nflverse nfldata games
table.

POLICY BOUNDARY (the owner's standing rule): market prices are NEVER an input
to predictions. This file exists for MEASUREMENT ONLY — the promotion gate
scores the incumbent model against the market baseline on the same walk-forward
games ("did our number beat the close?"), which is the honest scoreboard for
whether the self-learning loop is actually learning. The validator pins every
market signal at weight 0.0; nothing here changes that.

Stdlib urllib + csv. Loud on failure; keeps the existing file. --selftest
checks the de-vig math only.
"""

import csv
import io
import json
import os
import sys
import urllib.request

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "market_baseline.json")
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
SEASONS = {2021, 2022, 2023, 2024, 2025}
RENAMES = {"LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}


def implied_prob(ml):
    """American moneyline -> raw implied probability."""
    ml = float(ml)
    if ml < 0:
        return -ml / (-ml + 100.0)
    return 100.0 / (ml + 100.0)


def devig_home(home_ml, away_ml):
    """De-vigged home win probability by proportional normalization."""
    ph = implied_prob(home_ml)
    pa = implied_prob(away_ml)
    if ph + pa <= 0:
        return None
    return ph / (ph + pa)


def selftest():
    assert abs(implied_prob(-150) - 0.6) < 1e-9
    assert abs(implied_prob(130) - (100 / 230)) < 1e-9
    # -110/-110 de-vigs to exactly 50/50.
    assert abs(devig_home(-110, -110) - 0.5) < 1e-9
    # Favorite keeps its edge after normalization.
    assert devig_home(-200, 170) > 0.6
    print("selftest OK: moneyline de-vig math exact")


def main():
    existing = None
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, encoding="utf-8") as fh:
            existing = json.load(fh)
    try:
        with urllib.request.urlopen(GAMES_URL, timeout=60) as resp:
            text = resp.read().decode("utf-8")
    except Exception as err:  # noqa: BLE001 — loud, keep existing
        print(f"MARKET BASELINE: fetch failed: {err}", file=sys.stderr)
        return 0 if existing else 1

    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        try:
            season = int(r.get("season") or 0)
        except ValueError:
            continue
        if season not in SEASONS or (r.get("game_type") or "") != "REG":
            continue
        hml, aml = r.get("home_moneyline"), r.get("away_moneyline")
        if not hml or not aml:
            continue
        p = devig_home(hml, aml)
        if p is None:
            continue
        home = RENAMES.get(r["home_team"], r["home_team"])
        away = RENAMES.get(r["away_team"], r["away_team"])
        out[f"{season}|{int(r['week'])}|{home}|{away}"] = round(p, 4)

    if len(out) < 1000:
        print(f"MARKET BASELINE: only {len(out)} priced games (<1000) — refusing partial",
              file=sys.stderr)
        return 0 if existing else 1

    import datetime as dt
    doc = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "nflverse nfldata games.csv moneylines, proportionally de-vigged",
        "policy": "MEASUREMENT ONLY - never an input to predictions (owner rule)",
        "games": out,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")
    print(f"Wrote market_baseline.json: {len(out)} priced games")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
