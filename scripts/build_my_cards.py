#!/usr/bin/env python3
"""MY PARLAYS offered-card record -> data/my_cards/<season>_wk<NN>.json (R87).

WHY
---
MY cards are built in the browser, from a seed the viewer types, and then they are
gone. Game parlays and week parlays are recorded (data/parlays.json), archived
(data/parlays/) and graded (data/parlay_leg_scores.json, data/review.json); MY
cards were the one surface that shipped a number and never had to answer for it.
Nothing recorded what was offered, so nothing could score it, so the learning loop
could not learn from the feature that produces the most cards.

This step writes that record. For the pool's week it rebuilds, with
scripts/models/my_cards.py, exactly the ten cards app/views/myparlays.js would have
built for every TEAM seed at every dial at the moment the pool was generated -- the
moment they were offered -- and appends anything it has not seen before.

RULES (the ledger discipline of scripts/build_parlay_ledger.py, applied to cards)
  * KEY = (dial, seed, sorted selections). Leg order is not part of it: the same
    set of legs reached by a different beam path is the same card, which is the
    de-dupe the search itself applies. `card_id` is a short stable hash of it.
  * FIRST SIGHT LOCKS. The first run that sees a key appends it with its as-made
    numbers (model, implied, ev, tier, payout, and every leg's own pair of
    probabilities) and no later run ever touches that entry.
  * PRE-KICKOFF ONLY. `locked` is true only when the first sight precedes the
    EARLIEST kickoff among the card's legs. Only locked cards are graded. In the
    normal pipeline every card is locked by construction -- upcoming_legs admits
    only games that have not kicked off at `now` -- and the flag is written anyway,
    because a record that asserts a property it never checks is not a record.
  * IDEMPOTENT PER POOL. The as-of is the pool's generated_utc; `runs` holds one
    entry per as-of and a second run on the same pool writes nothing at all.

WHAT IS NOT RECORDED. Player-typed seeds. A viewer may type any of ~220 players and
recording every one of those card sets would be a record of combinations nobody
asked for; the recorded universe is every TEAM seed at every dial, which covers
every game on the slate and every player the pool can price through his team.

Probabilities are stored at 4dp, like the slate ledger. The PARITY proof is on the
pure module (tests/feature/r87_my_cards_parity.test.mjs), before any rounding.

MARKET POLICY: implied_prob is display and the terms of the bet. Nothing here
lets one reach a model probability.

Stdlib only, no network. --selftest drives the pure core on fixtures.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.models.my_cards import (  # noqa: E402
    DIALS, build_cards, card_key, dial_legs, parse_utc, pool_legs, seed_options,
    upcoming_legs,
)
from scripts.models.parlay_builder import _correlation_table  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_DIR = os.path.join(DATA, "my_cards")
POOL_PATH = os.path.join(DATA, "leg_pool.json")
SCHEDULE_PATH = os.path.join(DATA, "schedule_full.json")
CALIBRATION_PATH = os.path.join(DATA, "parlay_backtest.json")

# The order the chips sit in, so the record reads the way the view does.
DIAL_ORDER = ("safe", "even", "longshot")
SEED_KIND = "team"

RULE = ("every card is the card app/views/myparlays.js would have built for that seed "
        "at that dial from data/leg_pool.json and data/schedule_full.json at "
        "pool_generated_utc, appended the first time its key (dial, seed, sorted "
        "selections) is seen with its as-made numbers and never rewritten; `locked` is "
        "true only when that first sight preceded the earliest kickoff among the "
        "card's legs, and only locked cards are graded")
NOTE = ("player-typed seeds are NOT recorded: the recorded universe is every team seed "
        "at every dial, which reaches every game on the slate and every player the pool "
        "can price through his team. Probabilities are stored at 4dp; the JS/Python "
        "parity proof (tests/feature/r87_my_cards_parity.test.mjs) is on the pure "
        "module, before rounding. implied_prob is the yardstick and the terms of the "
        "bet, never an input.")
SOURCE_NOTE = ("scripts/build_my_cards.py over data/leg_pool.json (the offered legs), "
               "data/schedule_full.json (kickoff + status gating) and "
               "data/parlay_backtest.json (the measured correlations)")


def out_path(season, week):
    return os.path.join(OUT_DIR, "%d_wk%02d.json" % (int(season), int(week)))


def _r(v, nd=4):
    return None if v is None else round(float(v), nd)


def card_id_of(key):
    """A short, stable handle for a key. Stable across runs and machines (sha1 of
    the key text), short enough to read in a diff, long enough that the ~1,000
    cards a week produces never collide."""
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


# --------------------------------------------------------------------------- #
# pure core                                                                     #
# --------------------------------------------------------------------------- #

def kickoff_index(games):
    """{game_id: kickoff_utc} over the committed schedule. The schedule is the
    only source of a kickoff (the pool carries none), and a game it does not name
    has no kickoff here -- absent, never assumed."""
    out = {}
    for g in games or []:
        gid = g.get("game_id")
        if gid is not None:
            out[str(gid)] = g.get("kickoff_utc")
    return out


def offered_cards(pool, games, corr, as_of):
    """[(dial, seed, rank, card)] -- every card the browser would have offered at
    `as_of`, for every team seed the pool can price, at every dial.

    The flatten and the kickoff gate happen ONCE; the dial and the seed are what
    vary. dial_legs compares rungs by identity, so every seed at one dial searches
    the same leg objects the view would have searched.
    """
    eligible = upcoming_legs(pool_legs(pool), games, as_of)
    seeds = [s for s in seed_options(pool) if s.get("kind") == SEED_KIND]
    out = []
    for dial in DIAL_ORDER:
        dialled = dial_legs(eligible, DIALS[dial])
        for seed in seeds:
            for rank, card in enumerate(build_cards(dialled, [seed], corr), start=1):
                out.append((dial, seed, rank, card))
    return out, len(seeds)


def _leg_record(leg):
    """What a leg has to carry for the resolver to grade it and for a reader to
    check it against the screen. mu and line are the projection and the threshold
    the why-line printed; model_prob / implied_prob are the two numbers the leg
    showed, rounded once, here."""
    return {
        "market": leg.get("market"),
        "selection": leg.get("selection"),
        "game_id": leg.get("game_id"),
        "team": leg.get("team"),
        "side": leg.get("side"),
        "player": leg.get("player"),
        "gsis_id": leg.get("gsis_id"),
        "position": leg.get("position"),
        "line": _r(leg.get("line"), 2),
        "mu": _r(leg.get("mu"), 2),
        "model_prob": _r(leg.get("model_prob")),
        "implied_prob": _r(leg.get("implied_prob")),
        "price_source": leg.get("price_source"),
        "priced": bool(leg.get("priced")),
    }


def card_record(dial, seed, rank, card, kickoffs):
    """One offered card, as made. Lock state is decided by `append`, which is the
    only place that knows when this card was first seen."""
    legs = card["legs"]
    key = card_key(dial, seed.get("id"), legs)
    # The earliest kickoff among the card's legs is what the lock is measured
    # against. One leg with an unknown kickoff makes the whole card unlockable:
    # a card is offered as one bet, so its exposure starts at its first leg, and
    # a kickoff we cannot read is absent, never assumed.
    parsed = []
    for leg in legs:
        raw = kickoffs.get(str(leg.get("game_id")))
        when = parse_utc(raw)
        if when is None:
            parsed = None
            break
        parsed.append((when, raw))
    earliest = min(parsed, key=lambda p: p[0])[1] if parsed else None
    return {
        "card_id": card_id_of(key),
        "dial": dial,
        "seed": seed.get("name"),
        "rank": rank,
        "n_legs": len(legs),
        "same_game": bool(card["same_game"]),
        "mixed_game": bool(card["mixed_game"]),
        "model": _r(card["model"]),
        "implied": _r(card["implied"]),
        "ev": _r(card["ev"]),
        "tier": card["tier"],
        "payout": _r(card["payout"], 2),
        "assumed": int(card["assumed"]),
        "earliest_kickoff_utc": earliest,
        "legs": [_leg_record(l) for l in legs],
    }


def append(prev, records, season, week, as_of, generated_utc):
    """One append. `prev` may be None (first run). Returns the NEW document.

    A key already on file is left exactly as it was; only new keys are appended,
    in the order they were offered. Idempotent per as-of: the same pool produces
    the same keys, so nothing is added and `runs` gains nothing.
    """
    as_of_dt = parse_utc(as_of)
    if as_of_dt is None:
        raise ValueError("pool generated_utc %r is not ISO-8601" % (as_of,))
    cards = list((prev or {}).get("cards") or [])
    known = {c["card_id"] for c in cards}
    added = locked_added = 0
    for rec in records:
        if rec["card_id"] in known:
            continue                       # first sight wins; never rewritten
        kick = parse_utc(rec.get("earliest_kickoff_utc"))
        locked = kick is not None and as_of_dt < kick
        rec = dict(rec)
        rec["first_seen_utc"] = as_of
        rec["locked"] = bool(locked)
        rec["locked_utc"] = as_of if locked else None
        cards.append(rec)
        known.add(rec["card_id"])
        added += 1
        locked_added += 1 if locked else 0
    runs = list((prev or {}).get("runs") or [])
    if not any(r.get("pool_generated_utc") == as_of for r in runs):
        runs.append({"pool_generated_utc": as_of, "week": int(week),
                     "cards_seen": len(records), "cards_added": added,
                     "locked_added": locked_added,
                     "unlocked_added": added - locked_added})
    return {
        "season": int(season),
        "week": int(week),
        "generated_utc": generated_utc,
        "pool_generated_utc": as_of,
        "source": SOURCE_NOTE,
        "dials": list(DIAL_ORDER),
        "seeds": SEED_KIND,
        "rule": RULE,
        "note": NOTE,
        "runs": runs,
        "cards": cards,
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


def run(pool_path=POOL_PATH, schedule_path=SCHEDULE_PATH,
        calibration_path=CALIBRATION_PATH, out_dir=OUT_DIR, now=None):
    if not os.path.exists(pool_path):
        print("my cards: no leg pool at %s yet -- scripts/build_leg_pool.py writes it "
              "on the daily run; nothing to record"
              % os.path.relpath(pool_path, _ROOT))
        return None, False
    pool = _load(pool_path)
    season, week = int(pool["season"]), int(pool["week"])
    as_of = pool.get("generated_utc")
    if not as_of:
        raise ValueError("leg_pool.json has no generated_utc")
    path = os.path.join(out_dir, "%d_wk%02d.json" % (season, week))
    prev = _load(path) if os.path.exists(path) else None
    if prev and any(r.get("pool_generated_utc") == as_of
                    for r in prev.get("runs") or []):
        print("my cards: pool as-of %s already recorded -> no change (%s)"
              % (as_of, os.path.relpath(path, _ROOT)))
        return prev, False

    games = (_load(schedule_path).get("games") or []) if os.path.exists(schedule_path) else []
    calib = _load(calibration_path) if os.path.exists(calibration_path) else None
    corr = _correlation_table(calib)
    offered, n_seeds = offered_cards(pool, games, corr, as_of)
    kickoffs = kickoff_index(games)
    records = [card_record(dial, seed, rank, card, kickoffs)
               for dial, seed, rank, card in offered]
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = append(prev, records, season, week, as_of, now)
    write(doc, path)
    last = doc["runs"][-1]
    n_locked = sum(1 for c in doc["cards"] if c["locked"])
    per_dial = {d: sum(1 for c in doc["cards"] if c["dial"] == d) for d in DIAL_ORDER}
    print("my cards: wk %d as-of %s, %d team seeds x %d dials: %d cards offered, %d added "
          "(%d locked, %d post-kickoff) -> %d on file (%d locked) %s %s (%d bytes)"
          % (week, as_of, n_seeds, len(DIAL_ORDER), last["cards_seen"], last["cards_added"],
             last["locked_added"], last["unlocked_added"], len(doc["cards"]), n_locked,
             per_dial, os.path.relpath(path, _ROOT), os.path.getsize(path)))
    return doc, True


# --------------------------------------------------------------------------- #
# selftest                                                                      #
# --------------------------------------------------------------------------- #

def _fixture_pool(generated_utc):
    """A pool small enough to reason about: two games, four players, two game legs,
    every rung priced near the EVEN dial so the cards are not all one shape."""
    def rung(line, p, name, unit):
        return {"line": line, "z": 0.0, "selection": "%s %d+ %s" % (name, line + 0.5, unit),
                "model_prob": p}
    return {
        "season": 2026, "week": 3, "generated_utc": generated_utc,
        "players": [
            {"gsis_id": "p1", "player": "Alpha One", "team": "AAA", "position": "WR",
             "market": "wr_rec_yds", "game_id": "G1", "side": "home", "mu": 70.0,
             "p_team": 0.6, "pricing": "pool_calibrated",
             "rungs": [rung(39, 0.72, "A. One", "rec yds"), rung(59, 0.51, "A. One", "rec yds")]},
            {"gsis_id": "p2", "player": "Beta Two", "team": "AAA", "position": "RB",
             "market": "rb_rush_yds", "game_id": "G1", "side": "home", "mu": 60.0,
             "p_team": 0.6, "pricing": "pool_calibrated",
             "rungs": [rung(39, 0.55, "B. Two", "rush yds")]},
            {"gsis_id": "p3", "player": "Gamma Three", "team": "BBB", "position": "QB",
             "market": "qb_pass_yds", "game_id": "G1", "side": "away", "mu": 240.0,
             "p_team": 0.4, "pricing": "pool_calibrated",
             "rungs": [rung(224, 0.49, "G. Three", "pass yds")]},
            {"gsis_id": "p4", "player": "Delta Four", "team": "CCC", "position": "WR",
             "market": "wr_rec_yds", "game_id": "G2", "side": "home", "mu": 80.0,
             "p_team": 0.55, "pricing": "pool_calibrated",
             "rungs": [rung(59, 0.53, "D. Four", "rec yds")]},
        ],
        "game_legs": [
            {"market": "moneyline", "selection": "AAA ML", "model_prob": 0.56,
             "implied_prob": 0.58, "side": "home", "price_source": "assumed",
             "game_id": "G1", "team": "AAA"},
            {"market": "moneyline", "selection": "CCC ML", "model_prob": 0.52,
             "implied_prob": 0.54, "side": "home", "price_source": "assumed",
             "game_id": "G2", "team": "CCC"},
        ],
    }


def _fixture_games():
    return [
        {"game_id": "G1", "status": "STATUS_SCHEDULED", "kickoff_utc": "2026-09-27T17:00Z",
         "home": "AAA", "away": "BBB", "week": 3},
        {"game_id": "G2", "status": "STATUS_SCHEDULED", "kickoff_utc": "2026-09-28T00:20Z",
         "home": "CCC", "away": "DDD", "week": 3},
        {"game_id": "G3", "status": "STATUS_FINAL", "kickoff_utc": "2026-09-21T17:00Z",
         "home": "EEE", "away": "FFF", "week": 2},
    ]


def selftest():
    as_of = "2026-09-25T10:11:22Z"
    pool = _fixture_pool(as_of)
    games = _fixture_games()
    corr = _correlation_table(None)
    kicks = kickoff_index(games)
    assert kicks["G1"] == "2026-09-27T17:00Z" and kicks["G3"] == "2026-09-21T17:00Z"

    offered, n_seeds = offered_cards(pool, games, corr, as_of)
    assert n_seeds == 3, n_seeds                    # AAA, BBB, CCC
    assert offered, "the fixture pool offered no card at all"
    dials = {d for d, _, _, _ in offered}
    assert dials == set(DIAL_ORDER), dials
    # Rank is 1..n WITHIN a (dial, seed), and conviction falls as legs are added.
    ranks = {}
    for dial, seed, rank, card in offered:
        ranks.setdefault((dial, seed["name"]), []).append(rank)
        assert 0.0 < card["model"] <= 1.0
    for k, v in ranks.items():
        assert v == list(range(1, len(v) + 1)), (k, v)

    records = [card_record(d, s, r, c, kicks) for d, s, r, c in offered]
    ids = [r["card_id"] for r in records]
    assert len(set(ids)) == len(ids), "two offered cards share a card_id"
    for rec in records:
        assert rec["earliest_kickoff_utc"] in ("2026-09-27T17:00Z", "2026-09-28T00:20Z")
        assert set(rec) == {"card_id", "dial", "seed", "rank", "n_legs", "same_game",
                            "mixed_game", "model", "implied", "ev", "tier", "payout",
                            "assumed", "earliest_kickoff_utc", "legs"}
        for leg in rec["legs"]:
            assert 0 < leg["model_prob"] < 1 and 0 < leg["implied_prob"] < 1
            assert leg["priced"] is False   # no book quote anywhere in the fixture
    # A card built only from G1 legs takes G1's (earlier) kickoff.
    only_g1 = [r for r in records if all(l["game_id"] == "G1" for l in r["legs"])]
    assert only_g1 and all(r["earliest_kickoff_utc"] == "2026-09-27T17:00Z" for r in only_g1)

    # ---- first sight locks, and nothing is ever rewritten --------------------
    d1 = append(None, records, 2026, 3, as_of, "2026-09-25T10:12:00Z")
    assert len(d1["cards"]) == len(records)
    assert all(c["locked"] is True and c["locked_utc"] == as_of for c in d1["cards"]), \
        "every card first seen before kickoff must lock"
    assert d1["runs"] == [{"pool_generated_utc": as_of, "week": 3,
                           "cards_seen": len(records), "cards_added": len(records),
                           "locked_added": len(records), "unlocked_added": 0}]
    assert d1["seeds"] == "team" and d1["dials"] == list(DIAL_ORDER)

    # idempotent per as-of: the same pool -> the same document (generated_utc aside)
    d1b = append(d1, records, 2026, 3, as_of, "2026-09-25T18:00:00Z")
    d1b["generated_utc"] = d1["generated_utc"]
    assert json.dumps(d1b, sort_keys=True) == json.dumps(d1, sort_keys=True)
    assert len(d1b["runs"]) == 1

    # a later run whose numbers have MOVED: the card on file keeps its as-made ones
    first = dict(d1["cards"][0])
    moved = [dict(r) for r in records]
    moved[0] = dict(moved[0], model=0.99, implied=0.99, payout=1.0)
    d2 = append(d1, moved, 2026, 3, "2026-09-26T10:00:00Z", "2026-09-26T10:00:01Z")
    assert d2["cards"][0] == first, "a locked card is immutable"
    assert d2["runs"][-1]["cards_added"] == 0 and len(d2["runs"]) == 2

    # a genuinely new key appends (and only it)
    extra = dict(records[0], card_id="ffffffffffff")
    d3 = append(d2, moved + [extra], 2026, 3, "2026-09-26T12:00:00Z", "t")
    assert len(d3["cards"]) == len(d1["cards"]) + 1
    assert d3["runs"][-1]["cards_added"] == 1 and d3["runs"][-1]["locked_added"] == 1

    # ---- the pre-kickoff rule, exercised on both sides ----------------------
    late = [dict(r, earliest_kickoff_utc="2026-09-25T09:00Z") for r in records[:2]]
    d4 = append(None, late, 2026, 3, as_of, "t")
    assert all(c["locked"] is False and c["locked_utc"] is None for c in d4["cards"]), \
        "a card first seen AFTER the earliest kickoff must not lock"
    assert d4["runs"][-1] == {"pool_generated_utc": as_of, "week": 3, "cards_seen": 2,
                              "cards_added": 2, "locked_added": 0, "unlocked_added": 2}
    # a card whose kickoff is unknown can never lock -- absent is absent
    d5 = append(None, [dict(records[0], earliest_kickoff_utc=None)], 2026, 3, as_of, "t")
    assert d5["cards"][0]["locked"] is False and d5["cards"][0]["locked_utc"] is None

    # ---- the gate: a FINAL or already-kicked game is never offered -----------
    kicked = [dict(g, kickoff_utc="2026-09-24T17:00Z") for g in games]
    after, _ = offered_cards(pool, kicked, corr, as_of)
    assert after == [], "legs whose game has kicked off must not reach a card"
    finals = [dict(g, status="STATUS_FINAL") for g in games]
    assert offered_cards(pool, finals, corr, as_of)[0] == [], \
        "only STATUS_SCHEDULED games are offered"

    print("selftest OK: every team seed at every dial, rank 1..n per seed, first sight "
          "locks the as-made numbers and never rewrites them, idempotent per pool "
          "generated_utc, post-kickoff and unknown-kickoff cards recorded unlocked, "
          "started / finished games never offered")


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
