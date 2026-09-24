"""R101c — grade the recorded ANYTIME-TD cards -> data/atd_card_scores.json.

scripts/build_atd_cards.py records every WEEK-scope ATD card the first time it is
offered (data/atd_cards/{season}_wk{NN}.json). This grades them with the SAME
per-leg graders every other card in this repo uses — resolve_my_cards.grade_card,
which routes an ATD leg to resolve_parlay_legs.grade_atd, a yardage leg to
grade_prop and a moneyline to grade_game — and reports, per mode and per leg
count, how often the cards hit against how often the model said they would.

R101b — the GAME-scope (same-game) cards are recorded in data/atd_game_cards/
and graded here too; their rows carry scope "game" and are summarised under
"game_<mode>" so a same-game size never hides inside the WEEK numbers.

That comparison IS the learning signal for the card shapes: a mode or size whose
hit rate keeps landing below its mean model chance is overstated, and the
record says so in numbers. Pending legs keep a card pending (never a miss); a
void leg (player did not play) is dropped by the grader's own rule.

  python3 scripts/resolve_atd_cards.py [--cache DIR]   runner
  python3 scripts/resolve_atd_cards.py --selftest      offline
"""

import argparse
import datetime as dt
import glob
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.resolve_my_cards import _snaps, grade_card          # noqa: E402
from scripts.resolve_parlay_legs import (                         # noqa: E402
    GAME_MARKETS, index_stats, index_td, load_finals)
from scripts.resolve_estimates import fetch_csv                   # noqa: E402

DATA = os.path.join(_ROOT, "data")
RECORD_GLOB = os.path.join(DATA, "atd_cards", "*_wk*.json")
GAME_RECORD_GLOB = os.path.join(DATA, "atd_game_cards", "*_wk*.json")
OUT_PATH = os.path.join(DATA, "atd_card_scores.json")


def _r(x, nd=4):
    return None if x is None else round(float(x), nd)


def summarize(rows):
    """{mode: {size: {graded, hits, hit_rate, mean_model, ratio}}} over graded rows."""
    out = {}
    for r in rows:
        key = r["mode"] if r.get("scope", "week") == "week" else r["scope"] + "_" + r["mode"]
        blk = out.setdefault(key, {}).setdefault(str(r["n_legs"]),
                                                        {"graded": 0, "hits": 0, "sum_model": 0.0})
        blk["graded"] += 1
        blk["hits"] += 1 if r["result"] == "hit" else 0
        blk["sum_model"] += r["model_prob"]
    for mode in out.values():
        for blk in mode.values():
            n = blk.pop("graded")
            s = blk.pop("sum_model")
            blk.update({"graded": n, "hit_rate": _r(blk["hits"] / n) if n else None,
                        "mean_model": _r(s / n, 6) if n else None,
                        "ratio": _r((blk["hits"] / n) / (s / n), 3) if n and s > 0 else None})
    return out


def grade_records(records, by_week, finals, atd, scope="week"):
    rows, pending = [], 0
    for rec in records:
        week = int(rec["week"])
        for card in rec.get("cards") or []:
            g = grade_card(dict(card, dial=card.get("mode")), week, by_week, finals, atd)
            if g["result"] == "pending":
                pending += 1
                continue
            rows.append({"week": week, "scope": scope, "card_id": card["card_id"],
                         "mode": card["mode"],
                         "n_legs": card["n_legs"], "model_prob": card["model_prob"],
                         "result": g["result"], "legs": g["legs"]})
    return rows, pending


def run(cache_dir=None, out_path=OUT_PATH, now=None, offline=False):
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    def _read(pattern):
        out = []
        for f in sorted(glob.glob(pattern)):
            try:
                with open(f, encoding="utf-8") as fh:
                    out.append(json.load(fh))
            except (OSError, ValueError):
                continue
        return out
    week_recs, game_recs = _read(RECORD_GLOB), _read(GAME_RECORD_GLOB)
    records = week_recs + game_recs
    season = max(r["season"] for r in records) if records else None
    skipped, rows, pending, finals_source = None, [], 0, None
    if not records:
        skipped = "no recorded ATD cards yet"
    else:
        weeks = sorted({int(r["week"]) for r in records})
        finals, finals_source = load_finals(None, season=season, weeks=weeks, offline=offline)
        csv_rows, why = (None, "offline") if offline else fetch_csv(season, cache_dir)
        if csv_rows is None:
            skipped = why
            by_week, atd = {}, None
        else:
            by_week = index_stats(csv_rows)
            atd = {"td": index_td(csv_rows), "snaps": _snaps(season, cache_dir, None, offline)}
        rows, pending = grade_records(week_recs, by_week, finals, atd)
        g_rows, g_pending = grade_records(game_recs, by_week, finals, atd, scope="game")
        rows, pending = rows + g_rows, pending + g_pending
    doc = {"kind": "atd_card_scores", "season": season, "generated_utc": now,
           "finals_source": finals_source, "skipped": skipped,
           "rule": ("a card hits when every leg hits; a pending leg keeps the card pending "
                    "(never a miss); ATD legs graded by grade_atd (void = did not play)"),
           "graded": len(rows), "pending": pending, "by_mode": summarize(rows),
           "cards": rows}
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    return doc


def selftest():
    from scripts.resolve_parlay_legs import index_td as itd
    td = itd([{"player_display_name": "Alpha Back", "position": "RB", "team": "LA", "week": "3",
               "season_type": "REG", "rushing_tds": "1", "receiving_tds": "0"},
              {"player_display_name": "Beta Wide", "position": "WR", "team": "SF", "week": "3",
               "season_type": "REG", "rushing_tds": "0", "receiving_tds": "0"}])
    leg = lambda name, team, gid: {"market": "anytime_td", "selection": name + " anytime TD",  # noqa: E731
                                   "player": name, "team": team, "game_id": gid,
                                   "model_prob": 0.5, "position": "RB", "side": "home"}
    rec = {"season": 2026, "week": 3, "cards": [
        {"card_id": "c1", "mode": "all_td", "n_legs": 1, "model_prob": 0.5,
         "legs": [leg("Alpha Back", "LAR", "g1")]},
        {"card_id": "c2", "mode": "all_td", "n_legs": 2, "model_prob": 0.25,
         "legs": [leg("Alpha Back", "LAR", "g1"), leg("Beta Wide", "SF", "g2")]},
        {"card_id": "c3", "mode": "all_td", "n_legs": 2, "model_prob": 0.25,
         "legs": [leg("Alpha Back", "LAR", "g1"), leg("Nobody", "NE", "g3")]}]}
    rows, pending = grade_records([rec], {}, {}, {"td": td, "snaps": None})
    res = {r["card_id"]: r["result"] for r in rows}
    assert res == {"c1": "hit", "c2": "miss"} and pending == 1, (res, pending)
    s = summarize(rows)
    assert s["all_td"]["1"]["hits"] == 1 and s["all_td"]["2"]["hit_rate"] == 0.0, s
    g_rows, _ = grade_records([rec], {}, {}, {"td": td, "snaps": None}, scope="game")
    sg = summarize(rows + g_rows)
    assert sg["game_all_td"]["2"]["graded"] == 1 and sg["all_td"]["2"]["graded"] == 1, \
        "GAME cards summarised apart from WEEK cards"
    rows2, pending2 = grade_records([rec], {}, {}, None)
    assert rows2 == [] and pending2 == 3, "no TD index: every ATD card pending, never a miss"
    print("selftest ok: hit / miss / pending per card, pending never a miss, summary by mode and size")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--cache")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    doc = run(cache_dir=args.cache)
    print("atd_card_scores: %d graded, %d pending%s" % (doc["graded"], doc["pending"],
                                                      ("; " + doc["skipped"]) if doc["skipped"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
