#!/usr/bin/env python3
"""Grade the recorded MY cards -> data/my_card_scores.json (R87, step 2).

WHY
---
scripts/build_my_cards.py records what MY PARLAYS offered. This scores it, so the
one surface that builds a card per viewer finally answers for its numbers the way
the slate does: how often does a whole card hit, at each dial, at each leg count,
and what would a flat $100 on every one of them have returned.

WHAT IS GRADED
  * Only LOCKED cards (first seen before the earliest kickoff among their legs).
    Unlocked cards are counted and never scored -- the ledger rule, unchanged.
  * A PROP leg resolves against nflverse stats_player_week_<season>.csv, the same
    release scripts/resolve_estimates.py reads: `hit` = the market's yards >= the
    recorded line. index_stats / find_player / split_abbrev / read_csv come from
    scripts/resolve_parlay_legs.py and fetch_csv from scripts/resolve_estimates.py
    by IMPORT, never by copy, so the join can never drift between the two records.
  * A GAME leg resolves against FINAL results through the same layered
    `load_finals` the leg resolver uses (a --finals file wins; else lock receipts,
    data/review.json and ESPN live merge, and `finals_source` names what was used).
    Moneyline grades on the winner; spread grades on the margin against the
    handicap the SELECTION states ("TB -8.5" -- the terms of the bet as displayed,
    parsed with the ledger's own regex). A tie or an exact push is a VOID leg.

HONESTY RULES (the ones this file exists to keep)
  * AN UNRESOLVED LEG IS NEVER A MISS. A week with no stats rows, a player with no
    stat line, an unreadable handicap: all PENDING, with the reason recorded.
  * A card with any pending leg is pending; a card is a miss if any leg missed; a
    void if something voided and nothing missed; a hit only when every leg hit.
    That is build_review.review_parlay's rule, and the bucket comes from
    build_review.parlay_bucket so the five buckets mean the same thing everywhere.
  * WITH NO GRADED CARD EVERY METRIC IS NULL, NEVER 0. A hit rate of 0.0 says we
    measured and nothing hit; null says we have not measured.
  * Money is display-only and never an input. parlay_money settles a card at the
    card's OWN recorded implied prices (a prop, having no book feed, falls to the
    -110 assumption build_review applies everywhere).

`cards[]` holds the GRADED cards. A pending card carries no outcome to record and
the complete record of what was offered is data/my_cards/ -- putting ~900 pending
rows a week into an app-reachable feed would cost the reader megabytes to learn
nothing. weeks[] counts every recorded card, graded or not.

Stdlib only. --selftest drives the pure core on fixtures; --offline writes the
honest 0-resolved document.
"""

import argparse
import datetime as dt
import glob
import json
import os
import re
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.build_my_cards import DIAL_ORDER, OUT_DIR as CARDS_DIR  # noqa: E402
from scripts.build_parlay_ledger import _SPREAD_RE  # noqa: E402
from scripts.build_review import STAKE, parlay_bucket, parlay_money  # noqa: E402
from scripts.models.my_cards import LEG_COUNTS  # noqa: E402
from scripts.resolve_estimates import RELEASE_URL, fetch_csv  # noqa: E402
from scripts.resolve_parlay_legs import (  # noqa: E402
    ATD_MARKET, GAME_MARKETS, PROP_POSITION, SNAPS_URL, brier, find_player, grade_atd,
    index_snaps, index_stats, index_td, load_finals, log_loss, read_csv, split_abbrev,
)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "my_card_scores.json")
BUCKETS = ("all_hit", "push", "partial", "all_missed", "pending")

RULE = ("only LOCKED cards are graded; a prop leg hits when the market's yards reach "
        "the recorded line and a game leg is graded against FINAL scores (moneyline on "
        "the winner, spread on the margin against the handicap its selection states, an "
        "exact push void); a card is a hit only when every leg hit, a miss when any leg "
        "missed, void when something voided and nothing missed, and pending while any "
        "leg is unresolved -- an unresolved leg is never a miss")


def _r(x, nd=4):
    return None if x is None else round(float(x), nd)


# --------------------------------------------------------------------------- #
# loading the recorded cards                                                    #
# --------------------------------------------------------------------------- #

def load_cards(cards_dir=CARDS_DIR, season=None):
    """[(week, card, doc)] over data/my_cards/<season>_wk<NN>.json, week order."""
    pattern = os.path.join(cards_dir, ("%d_wk*.json" % int(season)) if season else "*_wk*.json")
    rows = []
    for path in sorted(glob.glob(pattern)):
        try:
            with open(path, encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            continue
        week = int(doc.get("week"))
        for card in doc.get("cards") or []:
            rows.append((week, card))
    rows.sort(key=lambda r: (r[0], r[1].get("dial"), r[1].get("seed"), r[1].get("rank")))
    return rows


def seasons_on_file(cards_dir=CARDS_DIR):
    out = set()
    for path in sorted(glob.glob(os.path.join(cards_dir, "*_wk*.json"))):
        m = re.match(r"^(\d{4})_wk\d{2}\.json$", os.path.basename(path))
        if m:
            out.add(int(m.group(1)))
    return sorted(out)


# --------------------------------------------------------------------------- #
# leg resolution (pure)                                                         #
# --------------------------------------------------------------------------- #

def spread_handicap(leg):
    """The handicap a spread leg is evaluated at: the recorded line when the record
    carries one, else the number its SELECTION states ("TB -8.5"), parsed with the
    parlay ledger's own regex so the two records read a selection the same way. The
    handicap is the terms of the bet -- never an input to anything."""
    line = leg.get("line")
    if isinstance(line, (int, float)) and not isinstance(line, bool):
        return float(line)
    m = _SPREAD_RE.match(str(leg.get("selection") or ""))
    if not m:
        return None
    if leg.get("team") and m.group("team") != leg["team"]:
        return None                    # the selection names another team: refuse
    return float(m.group("hcap"))


def grade_prop(leg, week, by_week):
    """(result, actual, reason) for one prop leg. Never a miss without a stat line."""
    rows = by_week.get(int(week))
    if rows is None:
        return "pending", None, "week_not_published"
    line = leg.get("line")
    if line is None:
        return "pending", None, "no_line"
    position = leg.get("position")
    if position not in PROP_POSITION.values():
        return "pending", None, "player_unidentified"
    if not leg.get("player") and split_abbrev(leg.get("selection")) is None:
        return "pending", None, "bad_selection"
    # The recorded leg names the player's own team, which is a tighter filter than
    # the game's two teams: the man on the card is the man on that roster.
    ref = {"position": position, "player": leg.get("player"),
           "selection": leg.get("selection"),
           "home": leg.get("team"), "away": leg.get("team")}
    row, why = find_player(ref, rows)
    if row is None:
        return "pending", None, why
    yards = row["yards"][position]
    return ("hit" if yards >= float(line) else "miss"), yards, None


def grade_game(leg, finals):
    """(result, actual, reason) for one moneyline / spread leg."""
    fin = (finals or {}).get(str(leg.get("game_id")))
    if fin is None:
        return "pending", None, "no_final"
    side = leg.get("side")
    if side not in ("home", "away"):
        return "pending", None, "no_side"
    if "home_score" in fin:
        hs, away = int(fin["home_score"]), int(fin["away_score"])
        actual = {"home_score": hs, "away_score": away}
        if leg.get("market") == "moneyline":
            if hs == away:
                return "void", actual, "tie"
            hit = (hs > away) if side == "home" else (away > hs)
            return ("hit" if hit else "miss"), actual, None
        hcap = spread_handicap(leg)
        if hcap is None:
            return "pending", actual, "no_line"
        own, opp = (hs, away) if side == "home" else (away, hs)
        margin = own + hcap - opp
        if margin == 0:
            return "void", actual, "push"
        return ("hit" if margin > 0 else "miss"), actual, None
    # A winner-only source (the graded lock receipts) grades a moneyline and
    # nothing else: a cover cannot be read off a winner.
    if leg.get("market") != "moneyline":
        return "pending", None, "no_final_score"
    winner = fin.get("winner")
    if winner not in ("home", "away"):
        return "pending", None, "no_final_score"
    return ("hit" if winner == side else "miss"), {"winner": winner}, None


def grade_card(card, week, by_week, finals, atd=None):
    """A graded card row: per-leg results, the card's result + bucket, and money.
    `atd` = {"td": index_td(...), "snaps": index_snaps(...)} grades anytime-TD legs
    (R101); without it an ATD leg stays pending, never a miss."""
    legs_out = []
    for leg in card.get("legs") or []:
        market = leg.get("market")
        if market == ATD_MARKET:
            result, actual, reason = (grade_atd(leg, week, atd.get("td"), atd.get("snaps"))
                                      if atd else ("pending", None, "no_td_index"))
        elif market in GAME_MARKETS:
            result, actual, reason = grade_game(leg, finals)
        elif market in PROP_POSITION:
            result, actual, reason = grade_prop(leg, week, by_week)
        else:
            result, actual, reason = "pending", None, "unknown_market"
        legs_out.append({"selection": leg.get("selection"), "market": market,
                         "game_id": leg.get("game_id"), "result": result,
                         "actual": actual, "reason": reason})
    results = [l["result"] for l in legs_out]
    if not results or "pending" in results:
        pres = "pending"
    elif "miss" in results:
        pres = "miss"
    elif "void" in results:
        pres = "void"
    else:
        pres = "hit"
    bucket = parlay_bucket(results)
    price_index = {}
    for leg in card.get("legs") or []:
        ip = leg.get("implied_prob")
        if isinstance(ip, (int, float)) and not isinstance(ip, bool) and 0 < ip < 1:
            price_index[(int(week), str(leg.get("game_id")), leg.get("market"),
                         leg.get("selection"))] = float(ip)
    settled = parlay_money({"bucket": bucket, "legs": legs_out}, int(week), price_index)
    money = None
    if settled is not None:
        fair, vig, assumed = settled
        money = {"net_fair": _r(fair, 2), "net_vig2": _r(vig, 2),
                 "assumed_price_legs": assumed}
    return {
        "card_id": card.get("card_id"),
        "week": int(week),
        "dial": card.get("dial"),
        "seed": card.get("seed"),
        "n_legs": int(card.get("n_legs") or len(legs_out)),
        "model": card.get("model"),
        "result": pres,
        "bucket": bucket,
        "legs": [{"selection": l["selection"], "market": l["market"],
                  "result": l["result"], "actual": l["actual"]} for l in legs_out],
        "money": money,
    }


# --------------------------------------------------------------------------- #
# scoring (pure)                                                                #
# --------------------------------------------------------------------------- #

def _block(cards, graded_rows):
    """One slice's record. `cards` is every recorded card in the slice (graded or
    not); `graded_rows` are the graded ones. Every METRIC is null at zero graded --
    a 0.0 hit rate claims a measurement that was never made."""
    n = len(cards)
    graded = len(graded_rows)
    all_hit = sum(1 for r in graded_rows if r["bucket"] == "all_hit")
    if not graded:
        return {"n": n, "graded": 0, "all_hit": 0, "hit_rate": None,
                "mean_model": None, "log_loss": None, "brier": None,
                "staked": None, "net_fair": None, "net_vig2": None, "roi_fair": None}
    pairs = [(r["model"], r["bucket"] == "all_hit") for r in graded_rows
             if isinstance(r.get("model"), (int, float))]
    net_fair = sum((r["money"] or {}).get("net_fair") or 0.0 for r in graded_rows)
    net_vig2 = sum((r["money"] or {}).get("net_vig2") or 0.0 for r in graded_rows)
    staked = STAKE * graded
    return {
        "n": n,
        "graded": graded,
        "all_hit": all_hit,
        "hit_rate": _r(all_hit / graded),
        "mean_model": _r(sum(p for p, _ in pairs) / len(pairs)) if pairs else None,
        "log_loss": _r(sum(log_loss(p, y) for p, y in pairs) / len(pairs)) if pairs else None,
        "brier": _r(sum(brier(p, y) for p, y in pairs) / len(pairs)) if pairs else None,
        "staked": _r(staked, 2),
        "net_fair": _r(net_fair, 2),
        "net_vig2": _r(net_vig2, 2),
        "roi_fair": _r(net_fair / staked) if staked else None,
    }


def week_block(week, cards, graded_rows):
    """One week: the counts, the five buckets, and the record per dial / leg count."""
    locked = [c for c in cards if c.get("locked")]
    by_bucket = {b: 0 for b in BUCKETS}
    for r in graded_rows:
        by_bucket[r["bucket"]] = by_bucket.get(r["bucket"], 0) + 1
    by_bucket["pending"] = len(locked) - len(graded_rows)
    return {
        "week": int(week),
        "n_cards": len(cards),
        "locked": len(locked),
        "graded": len(graded_rows),
        "pending": len(locked) - len(graded_rows),
        "buckets": by_bucket,
        "by_dial": {d: _block([c for c in cards if c.get("dial") == d],
                              [r for r in graded_rows if r["dial"] == d])
                    for d in DIAL_ORDER},
        "by_legs": {str(k): _block([c for c in cards if int(c.get("n_legs") or 0) == k],
                                   [r for r in graded_rows if r["n_legs"] == k])
                    for k in LEG_COUNTS},
    }


def document(season, weeks, cards_rows, finals_source, skipped, generated_utc,
             source=None):
    return {
        "season": int(season),
        "generated_utc": generated_utc,
        "source": source or RELEASE_URL.format(season=int(season)),
        "finals_source": finals_source,
        "rule": RULE,
        "weeks_resolved": sum(1 for w in weeks if w["graded"] > 0),
        "weeks": weeks,
        "cards": cards_rows,
        "skipped": skipped,
    }


def score(rows, by_week, finals, atd=None):
    """(week blocks, graded card rows) over [(week, card)] recorded cards."""
    weeks, graded_all = [], []
    for week in sorted({w for w, _ in rows}):
        cards = [c for w, c in rows if w == week]
        graded = []
        for card in cards:
            if not card.get("locked"):
                continue                       # counted, never scored
            row = grade_card(card, week, by_week, finals, atd)
            if row["result"] != "pending":
                graded.append(row)
        weeks.append(week_block(week, cards, graded))
        graded_all.extend(graded)
    return weeks, graded_all


# --------------------------------------------------------------------------- #
# I/O                                                                           #
# --------------------------------------------------------------------------- #

def write(doc, path=OUT_PATH):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def _snaps(season, cache_dir, dry_run_csv, offline):
    """R101 — the season's snap counts (the did-not-play evidence for an ATD void),
    or None: without them an ATD leg with no stat line stays pending."""
    if dry_run_csv or offline:
        return None
    cached = os.path.join(cache_dir, "snap_counts_%d.csv" % season) if cache_dir else None
    if cached and os.path.exists(cached):
        return index_snaps(read_csv(cached))
    try:
        import requests  # noqa: PLC0415 — runner dependency, guarded
        resp = requests.get(SNAPS_URL.format(season=int(season)), timeout=120)
    except Exception as exc:  # noqa: BLE001 — a fault is a skip, not a crash
        print("[resolve_my_cards] snap counts unavailable: %s" % exc.__class__.__name__,
              file=sys.stderr)
        return None
    if resp.status_code != 200 or not resp.content:
        return None
    import csv as _csv  # noqa: PLC0415
    import io as _io  # noqa: PLC0415
    return index_snaps(list(_csv.DictReader(_io.StringIO(resp.content.decode("utf-8", "replace")))))


def run(season=None, cache_dir=None, out_path=OUT_PATH, offline=False, dry_run_csv=None,
        finals_path=None, cards_dir=CARDS_DIR, now=None):
    if season is None:
        found = seasons_on_file(cards_dir)
        season = found[-1] if found else int(dt.datetime.now(dt.timezone.utc).year)
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = load_cards(cards_dir, season)
    skipped = None
    source = None
    by_week = {}
    atd = None

    # The weeks whose finals matter: every week holding a locked game leg.
    game_weeks = sorted({w for w, c in rows if c.get("locked")
                         and any(l.get("market") in GAME_MARKETS for l in c.get("legs") or [])})
    finals, finals_source = load_finals(finals_path, season=season, weeks=game_weeks,
                                        offline=offline)

    if not rows:
        skipped = ("no recorded cards at %s yet -- scripts/build_my_cards.py writes them "
                   "on the daily run; nothing to grade" % os.path.relpath(cards_dir, _ROOT))
    elif not any(c.get("locked") for _, c in rows):
        skipped = "no locked (pre-kickoff) card on file yet"
    else:
        csv_rows = None
        if dry_run_csv:
            csv_rows, source = read_csv(dry_run_csv), "dry run: %s" % dry_run_csv
        elif offline:
            skipped = "offline run: stats not fetched"
        else:
            csv_rows, why = fetch_csv(season, cache_dir)
            if csv_rows is None:
                skipped = why
        if csv_rows is not None:
            by_week = index_stats(csv_rows)
            atd = {"td": index_td(csv_rows), "snaps": None}
            if any(l.get("market") == ATD_MARKET for _, c in rows for l in c.get("legs") or []):
                atd["snaps"] = _snaps(season, cache_dir, dry_run_csv, offline)

    weeks, graded = score(rows, by_week, finals, atd)
    if rows and not graded and not skipped:
        skipped = "stats and finals reachable, but no recorded card has every leg resolved"
    doc = document(season, weeks, graded, finals_source, skipped, now, source=source)

    stream = sys.stdout
    if dry_run_csv and out_path is None:
        print(json.dumps(doc, ensure_ascii=True, indent=2))
        stream = sys.stderr              # stdout is the document in a dry run
    else:
        write(doc, out_path)
    n_cards = sum(w["n_cards"] for w in weeks)
    n_locked = sum(w["locked"] for w in weeks)
    if not graded:
        print("[resolve_my_cards] SKIPPED (0 weeks resolved): %s (%d cards on file, %d "
              "locked)" % (skipped or "nothing resolved", n_cards, n_locked), file=sys.stderr)
    else:
        print("resolve_my_cards: %d weeks resolved, %d of %d locked cards graded (%d cards "
              "on file); %s%s"
              % (doc["weeks_resolved"], len(graded), n_locked, n_cards,
                 ", ".join("%s %s" % (w["week"], w["buckets"]) for w in weeks),
                 ("; %s" % skipped) if skipped else ""), file=stream)
    return doc


# --------------------------------------------------------------------------- #
# selftest                                                                      #
# --------------------------------------------------------------------------- #

def _leg(market, selection, **kw):
    base = {"market": market, "selection": selection, "game_id": "g1", "team": None,
            "side": None, "player": None, "gsis_id": None, "position": None,
            "line": None, "mu": None, "model_prob": 0.5, "implied_prob": 0.52,
            "price_source": "assumed", "priced": False}
    base.update(kw)
    return base


def _card(card_id, dial, legs, model=0.25, locked=True, n_legs=None, rank=1):
    return {"card_id": card_id, "dial": dial, "seed": "SEA", "rank": rank,
            "n_legs": n_legs or len(legs), "same_game": False, "mixed_game": False,
            "model": model, "implied": 0.3, "ev": -0.1, "tier": "low", "payout": 233.0,
            "assumed": len(legs), "earliest_kickoff_utc": "2026-09-10T00:20Z",
            "legs": legs, "first_seen_utc": "2026-09-08T10:39:10Z", "locked": locked,
            "locked_utc": "2026-09-08T10:39:10Z"}


def _fixture_rows():
    """Six cards over one week: an all-hit, a miss, a void (push), a pending prop,
    an unlocked card, and a moneyline pair that grades on the winner alone."""
    hen = _leg("rb_rush_yds", "T. Henderson 60+ rush yds", team="NE", side="away",
               player="TreVeyon Henderson", position="RB", line=59.5, mu=70.0,
               model_prob=0.55, implied_prob=0.575)
    jsn = _leg("wr_rec_yds", "J. Smith-Njigba 60+ rec yds", team="SEA", side="home",
               player="Jaxon Smith-Njigba", position="WR", line=59.5, mu=94.0,
               model_prob=0.6, implied_prob=0.627)
    low = _leg("qb_pass_yds", "S. Darnold 300+ pass yds", team="SEA", side="home",
               player="Sam Darnold", position="QB", line=299.5, mu=240.0,
               model_prob=0.3, implied_prob=0.3135)
    ghost = _leg("wr_rec_yds", "N. Body 60+ rec yds", team="SEA", side="home",
                 player="Nobody Here", position="WR", line=59.5, mu=60.0)
    sea_ml = _leg("moneyline", "SEA ML", team="SEA", side="home", model_prob=0.61,
                  implied_prob=0.64, price_source="fair_market")
    sea_sp = _leg("spread", "SEA -3.5", team="SEA", side="home", model_prob=0.5,
                  implied_prob=0.52, price_source="fair_market")
    ne_sp = _leg("spread", "NE +5.5", team="NE", side="away", model_prob=0.5,
                 implied_prob=0.52, price_source="fair_market")
    return [
        (1, _card("hit000000001", "even", [hen, jsn], model=0.33)),
        (1, _card("miss00000001", "even", [hen, low], model=0.17)),
        (1, _card("void00000001", "safe", [jsn, sea_sp], model=0.31)),
        (1, _card("pend00000001", "even", [jsn, ghost], model=0.36)),
        (1, _card("unlk00000001", "even", [hen, jsn], model=0.33, locked=False)),
        (1, _card("game00000001", "longshot", [sea_ml, ne_sp], model=0.30)),
    ]


def _fixture_stats():
    def row(name, pos, team, py=0.0, ry=0.0, rec=0.0):
        return {"season_type": "REG", "week": "1", "position": pos, "team": team,
                "player_display_name": name, "passing_yards": py, "rushing_yards": ry,
                "receiving_yards": rec}
    return [
        row("TreVeyon Henderson", "RB", "NE", ry=74),        # 74 >= 59.5 -> hit
        row("Jaxon Smith-Njigba", "WR", "SEA", rec=101),     # 101 >= 59.5 -> hit
        row("Sam Darnold", "QB", "SEA", py=211),             # 211 < 299.5 -> miss
    ]


def selftest():
    assert spread_handicap({"selection": "SEA -3.5", "team": "SEA"}) == -3.5
    assert spread_handicap({"selection": "NE +5.5", "team": "NE"}) == 5.5
    assert spread_handicap({"selection": "SEA -3.5", "team": "NE"}) is None, \
        "a handicap may not be read off another team's selection"
    assert spread_handicap({"selection": "SEA ML", "team": "SEA"}) is None
    assert spread_handicap({"selection": "x", "team": "SEA", "line": -2.5}) == -2.5

    rows = _fixture_rows()
    by_week = index_stats(_fixture_stats())
    # SEA 24, NE 17. SEA -3.5 covers (24 - 3.5 - 17 = +3.5); NE +5.5 does not
    # (17 + 5.5 - 24 = -1.5); SEA -7.0 is an EXACT push.
    finals = {"g1": {"home_score": 24, "away_score": 17}}
    weeks, graded = score(rows, by_week, finals)
    assert len(weeks) == 1
    w = weeks[0]
    assert w["n_cards"] == 6 and w["locked"] == 5, w
    by_id = {r["card_id"]: r for r in graded}
    assert "unlk00000001" not in by_id, "an unlocked card must never be graded"
    assert "pend00000001" not in by_id, "a card with an unresolvable leg stays pending"
    assert w["graded"] == 4 and w["pending"] == 1, w

    hit = by_id["hit000000001"]
    assert hit["result"] == "hit" and hit["bucket"] == "all_hit", hit
    assert [l["result"] for l in hit["legs"]] == ["hit", "hit"]
    assert hit["legs"][0]["actual"] == 74.0
    assert hit["money"]["net_fair"] > 0 and hit["money"]["assumed_price_legs"] == 2

    miss = by_id["miss00000001"]
    assert miss["result"] == "miss" and miss["bucket"] == "partial", miss
    assert miss["money"]["net_fair"] == -100.0 and miss["money"]["net_vig2"] == -100.0

    # an EXACT push voids the spread leg; the card is a push, not a loss
    push_rows = [(1, _card("push00000001", "safe",
                           [_leg("spread", "SEA -7.0", team="SEA", side="home",
                                 model_prob=0.5, implied_prob=0.52,
                                 price_source="fair_market"),
                            rows[0][1]["legs"][1]], model=0.3))]
    _, push_graded = score(push_rows, by_week, finals)
    assert push_graded[0]["bucket"] == "push" and push_graded[0]["result"] == "void", \
        push_graded[0]
    assert push_graded[0]["legs"][0]["result"] == "void"

    game = by_id["game00000001"]
    assert [l["result"] for l in game["legs"]] == ["hit", "miss"], game
    assert game["bucket"] == "partial"

    # a WINNER-ONLY final grades the moneyline and leaves the spread pending
    _, winner_only = score([(1, _card("wo0000000001", "even",
                                      [rows[5][1]["legs"][0], rows[5][1]["legs"][1]]))],
                           by_week, {"g1": {"winner": "home"}})
    assert winner_only == [], "a cover cannot be read off a winner -- the card stays pending"

    # ---- the blocks --------------------------------------------------------
    even = w["by_dial"]["even"]
    assert even["n"] == 4 and even["graded"] == 2 and even["all_hit"] == 1
    assert even["hit_rate"] == 0.5 and even["staked"] == 200.0
    assert abs(even["mean_model"] - 0.25) < 1e-9, even
    assert even["log_loss"] is not None and even["brier"] is not None
    assert abs(even["roi_fair"] - even["net_fair"] / 200.0) < 1e-4
    assert set(w["by_legs"]) == {"2", "3", "4", "5", "6"}
    assert w["by_legs"]["2"]["graded"] == 4 and w["by_legs"]["5"]["graded"] == 0
    for empty in (w["by_legs"]["5"], w["by_legs"]["6"]):
        for k in ("hit_rate", "mean_model", "log_loss", "brier", "staked",
                  "net_fair", "net_vig2", "roi_fair"):
            assert empty[k] is None, (k, empty)
    assert sum(w["buckets"].values()) == w["locked"], w["buckets"]

    # ---- nothing resolved -> an honest, null document ----------------------
    none_weeks, none_graded = score(rows, {}, {})
    doc = document(2026, none_weeks, none_graded, "none", "offline run", "t")
    assert doc["weeks_resolved"] == 0 and doc["cards"] == []
    b = doc["weeks"][0]["by_dial"]["even"]
    assert b["graded"] == 0 and b["hit_rate"] is None and b["staked"] is None
    assert doc["weeks"][0]["pending"] == 5

    print("selftest OK: locked-only grading, an unresolved leg is pending and never a "
          "miss, exact push voids, winner-only finals grade a moneyline and not a "
          "cover, buckets sum to the locked cards, $100 flat settles from the card's "
          "own prices, and every metric is null (never 0) with nothing graded")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--offline", action="store_true",
                    help="never fetch the stats release; write the honest skip")
    ap.add_argument("--dry-run-with", metavar="CSV", default=None,
                    help="grade against this stats CSV and print the document "
                         "(writes nothing unless --out is given)")
    ap.add_argument("--finals", metavar="JSON", default=None,
                    help="FINAL rows (game_id, home_score, away_score) for game legs")
    ap.add_argument("--out", default=None, help="write the document here instead")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    out_path = args.out or (None if args.dry_run_with else OUT_PATH)
    run(season=args.season, cache_dir=args.cache_dir, out_path=out_path,
        offline=args.offline, dry_run_csv=args.dry_run_with, finals_path=args.finals)
    return 0


if __name__ == "__main__":
    sys.exit(main())
