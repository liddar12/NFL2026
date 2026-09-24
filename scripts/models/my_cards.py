"""MY PARLAYS card selection, in Python: an exact mirror of the browser's search.

WHY THIS FILE EXISTS
--------------------
app/views/myparlays.js builds MY cards on the fly, in the browser, from a seed the
viewer types. Nothing recorded them, so nothing could grade them: the one surface
that is built per viewer was also the one surface the learning loop never saw.
scripts/build_my_cards.py records what was offered and scripts/resolve_my_cards.py
grades it -- and both of them need the SAME cards the browser would have shown, or
the record is of something nobody was offered.

So this module is a port, not a re-derivation. Every function below mirrors one in
app/views/myparlays.js (poolLegs, dialLegs, upcomingLegs, matchesSeed, compatible,
conviction, scoreCard, buildCards, seedOptions) or in app/parlay-math.js
(legFromPool, legFromGame, impliedFromModel), operation for operation.
tests/feature/r87_my_cards_parity.test.mjs runs both sides over the committed pool
and fails on any disagreement beyond 1e-9, which is what keeps the two honest.

THE THINGS THAT MAKE A PORT DRIFT, AND WHAT IS DONE ABOUT EACH
  * ROUNDING. parlay_builder.make_leg rounds model_prob and implied_prob to 4dp;
    the browser does not round at all. make_leg is therefore NEVER used here --
    _leg_from_pool / _leg_from_game clamp and price exactly as the JS does, and
    the 4dp rounding happens once, at the moment a card is written to disk.
  * OPERATION ORDER. Floating-point multiplication is not associative, so the
    combination maths runs in the same order as the JS: implied is the running
    product over legs in card order, model is the product over GAME GROUPS in
    insertion order (parlay_builder.combined_game_probs, added for this).
  * SORT STABILITY. JS Array.prototype.sort has been stable since ES2019 and
    Python's sorted() always has been, so the same comparator keys give the same
    order -- including the ties, which decide which of two equally-convicted
    cards is offered.
  * TIE-BREAKS. dialLegs resolves a tie to the HIGHER line, and the game-leg band
    is inclusive to 1e-9 (|0.65 - 0.50| evaluates to 0.15000000000000002). Both
    are reproduced literally rather than "equivalently".

MARKET POLICY, unchanged: implied_prob is display and the terms of the bet. No
function here lets one reach a model probability.

Python 3.11 stdlib only. Pure: nothing here reads a file, fetches, or mutates its
inputs.
"""

import datetime as dt
import os
import sys

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from scripts.models.parlay_builder import (  # noqa: E402
    _clamp, _confidence_tier, combined_game_probs, same_side_game_pair,
)

# The browser's constants, restated so a drift shows up as a parity failure
# rather than as two different numbers for the same card.
DIALS = {"safe": 0.65, "even": 0.50, "longshot": 0.35}
DEFAULT_DIAL = "even"
GAME_LEG_BAND = 0.15
LEG_COUNTS = (2, 3, 4, 5, 6)
PER_COUNT = 2          # two cards per leg count -> ten cards
BEAM = 24              # partial cards kept at each step
POOL_CAP = 220         # strongest non-seed legs considered, by conviction
STAKE = 100.0
DEFAULT_HOLD = 0.045
PROB_EPS = 1e-4
BAND_TOL = 1e-9
SCHEDULED = "STATUS_SCHEDULED"


# --------------------------------------------------------------------------- #
# leg construction (app/parlay-math.js legFromPool / legFromGame)               #
# --------------------------------------------------------------------------- #

def implied_from_model(model_prob, hold=DEFAULT_HOLD):
    """The implied probability for a leg with no book price: our number plus the
    standard hold. The double clamp is the JS's, kept literally."""
    return _clamp(_clamp(model_prob, PROB_EPS, 1.0 - PROB_EPS) * (1.0 + hold),
                  PROB_EPS, 1.0 - PROB_EPS)


def _leg_from_pool(row, rung):
    """A pool player's rung -> a leg. No rounding anywhere: the browser shows the
    unrounded number and the record has to be of what was shown."""
    model = _clamp(float(rung["model_prob"]), PROB_EPS, 1.0 - PROB_EPS)
    return {
        "market": row.get("market"),
        "selection": rung.get("selection"),
        "model_prob": model,
        "implied_prob": implied_from_model(model),
        # _corr_tag / _side are parlay_builder's internal keys: _pair_rho reads
        # them, so a ported leg has to carry them under those exact names.
        "_corr_tag": row.get("market"),
        "_side": row.get("side"),
        "side": row.get("side"),
        "game_id": row.get("game_id"),
        "kickoff_utc": row.get("kickoff_utc"),
        "status": row.get("status"),
        "price_source": "assumed",
        "player": row.get("player"),
        "gsis_id": row.get("gsis_id"),
        "position": row.get("position"),
        "team": row.get("team"),
        "line": rung.get("line"),
        "mu": row.get("mu"),
        "priced": False,       # no book feed for props -- the vig is charged above
        "owner": row.get("gsis_id"),
        "label": row.get("player"),
        "availability": row.get("availability"),
    }


def _leg_from_game(leg, side):
    """A copied game leg -> the same shape. Its implied_prob is a REAL book
    comparison price when the pool carries one, never re-derived from the model."""
    ip = leg.get("implied_prob")
    implied = (float(ip) if isinstance(ip, (int, float)) and not isinstance(ip, bool)
               else implied_from_model(leg.get("model_prob")))
    return {
        "market": leg.get("market"),
        "selection": leg.get("selection"),
        "model_prob": leg.get("model_prob"),
        "implied_prob": implied,
        "_corr_tag": leg.get("market"),
        "_side": side or None,
        "side": side or None,
        "game_id": leg.get("game_id"),
        "kickoff_utc": leg.get("kickoff_utc"),
        "status": leg.get("status"),
        "price_source": leg.get("price_source") or "unavailable",
        "player": None,
        "gsis_id": None,
        "position": None,
        "team": leg.get("team"),
        "line": None,
        "mu": None,
        "priced": leg.get("price_source") == "book_quote",
        "owner": "team:%s" % (leg.get("team") or leg.get("selection")),
        "label": leg.get("team") or leg.get("selection"),
        "availability": None,
    }


# --------------------------------------------------------------------------- #
# the searchable universe (app/views/myparlays.js poolLegs / seedOptions)       #
# --------------------------------------------------------------------------- #

def _side_key(game_id, team):
    """The JS template literal `${game_id}|${team}`, with null spelled the way
    JSON does. Only rows that carry both ever reach the map."""
    return "%s|%s" % ("null" if game_id is None else game_id,
                      "null" if team is None else team)


def pool_legs(pool):
    """Every leg in the pool, flattened: one per player-rung plus each game leg."""
    out = []
    sides = {}
    pool = pool or {}
    for row in pool.get("players") or []:
        key = _side_key(row.get("game_id"), row.get("team"))
        if row.get("game_id") and row.get("team") and row.get("side") in ("home", "away"):
            # A disagreement is not resolved by whichever player happens to be last.
            sides[key] = (row["side"] if key not in sides or sides[key] == row["side"]
                          else None)
        for rung in row.get("rungs") or []:
            out.append(_leg_from_pool(row, rung))
    for g in pool.get("game_legs") or []:
        key = _side_key(g.get("game_id"), g.get("team"))
        side = g.get("side") or sides.get(key)
        if not g.get("game_id") or not g.get("team") or side not in ("home", "away"):
            continue
        if key in sides and sides[key] != side:
            continue
        out.append(_leg_from_game(g, side))
    return out


def seed_options(pool):
    """Every player and every team the pool can actually price, players first."""
    pool = pool or {}
    players, teams = {}, {}
    for row in pool.get("players") or []:
        if row.get("player"):
            players[row.get("gsis_id")] = {"kind": "player", "id": row.get("gsis_id"),
                                           "name": row.get("player"),
                                           "team": row.get("team"),
                                           "position": row.get("position")}
        if row.get("team"):
            teams[row["team"]] = {"kind": "team", "id": "team:%s" % row["team"],
                                  "name": row["team"]}
    for g in pool.get("game_legs") or []:
        if g.get("team"):
            teams[g["team"]] = {"kind": "team", "id": "team:%s" % g["team"],
                                "name": g["team"]}
    return (sorted(players.values(), key=lambda o: o["name"])
            + sorted(teams.values(), key=lambda o: o["name"]))


def _is_prop_leg(leg):
    """A prop leg: an unpriced rung owned by a PLAYER. Game legs own a `team:` id."""
    owner = leg.get("owner")
    return (not leg.get("priced")) and bool(owner) and not str(owner).startswith("team:")


def dial_legs(legs, target):
    """R86 -- the risk dial, applied to EVERY leg.

    A PLAYER has a ladder, so the dial PICKS one rung: the one whose model
    probability is nearest `target`, ties to the HIGHER line (0.55 and 0.45 are
    equidistant from EVEN; the higher line is the harder bet, and pinning the
    tie-break stops the selection depending on pool order).

    A GAME LEG has no ladder, so the dial FILTERS: keep it only when its model
    probability is within GAME_LEG_BAND of the target. The band edge is INCLUSIVE
    and binary floating point has to be told so -- |0.65 - 0.50| evaluates to
    0.15000000000000002, which would silently drop the leg sitting exactly on the
    edge the legend promises.

    Pure: no leg is mutated and no leg is re-priced. The dial only decides which
    already-calibrated leg is eligible.
    """
    t = float(target)
    chosen = {}
    for leg in legs or []:
        if not _is_prop_leg(leg):
            continue
        owner = leg["owner"]
        cur = chosen.get(owner)
        if cur is None:
            chosen[owner] = leg
            continue
        d = abs(leg["model_prob"] - t)
        d_cur = abs(cur["model_prob"] - t)
        if d < d_cur or (d == d_cur and float(leg["line"]) > float(cur["line"])):
            chosen[owner] = leg
    out = []
    for leg in legs or []:
        if _is_prop_leg(leg):
            if chosen.get(leg["owner"]) is leg:
                out.append(leg)
        elif abs(float(leg["model_prob"]) - t) - GAME_LEG_BAND <= BAND_TOL:
            out.append(leg)
    return out


# --------------------------------------------------------------------------- #
# kickoff gating (app/views/myparlays.js upcomingLegs)                          #
# --------------------------------------------------------------------------- #

def parse_utc(text):
    """ISO-8601 UTC -> aware datetime, or None. data/schedule_full.json carries
    MINUTES only ('2026-09-22T00:15Z') while a build stamp carries seconds, so
    this never compares strings."""
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


def upcoming_legs(legs, games, now_utc):
    """Legs whose game is STATUS_SCHEDULED and has not kicked off at `now_utc`.

    `now_utc` is an ISO-8601 string or a datetime. A game with an unparseable
    kickoff is excluded, exactly as Date.parse -> NaN excludes it in the browser.
    """
    now = now_utc if isinstance(now_utc, dt.datetime) else parse_utc(now_utc)
    if now is None:
        raise ValueError("upcoming_legs needs a parseable now_utc, got %r" % (now_utc,))
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)
    by_id = {}
    for g in games or []:
        by_id[str(g.get("game_id"))] = g
    out = []
    for leg in legs or []:
        g = by_id.get(str(leg.get("game_id")))
        if not g or g.get("status") != SCHEDULED:
            continue
        kick = parse_utc(g.get("kickoff_utc"))
        if kick is not None and kick > now:
            out.append(leg)
    return out


# --------------------------------------------------------------------------- #
# the search (app/views/myparlays.js matchesSeed / compatible / buildCards)     #
# --------------------------------------------------------------------------- #

def matches_seed(leg, seeds):
    """Does this leg belong to one of the seeds? Teams match their players too."""
    for s in seeds or []:
        if s.get("kind") == "player" and leg.get("owner") == s.get("id"):
            return True
        if s.get("kind") == "team" and (leg.get("team") == s.get("name")
                                        or leg.get("owner") == s.get("id")):
            return True
    return False


def _violates_one_per_side(legs):
    """R74, as the VIEW states it: two bets on one team's outcome IN ONE GAME.

    parlay_builder.legs_violating_one_per_side omits the game_id test because the
    legs it is handed already share a game; the view's rule has to carry it (the
    same side of a DIFFERENT game is two opinions, not one), so it is spelled out
    here rather than imported and quietly widened.
    """
    n = len(legs)
    for i in range(n):
        gi = legs[i].get("game_id")
        if not gi:
            continue
        for j in range(i + 1, n):
            if gi == legs[j].get("game_id") and same_side_game_pair(legs[i], legs[j]):
                return True
    return False


def compatible(legs, nxt, max_per_game=2):
    """Two legs may not sit in one card when they are the same opinion twice.
    R101d -- max_per_game (default 2, R83) is raised only by a TD mode's verdict."""
    gid = nxt.get("game_id")
    if gid:
        same = 0
        for leg in legs:
            if leg.get("game_id") == gid:
                same += 1
        if same >= max_per_game:              # R83 -- at most two legs per game
            return False
    owner = nxt.get("owner")
    selection = nxt.get("selection")
    for leg in legs:
        if leg.get("owner") == owner:         # one leg per player / team
            return False
        if leg.get("selection") == selection:
            return False
    return not _violates_one_per_side(list(legs) + [nxt])


def conviction(legs, corr=None, big_groups=None):
    """Conviction: the combined model probability, correlation-aware within a game."""
    return combined_game_probs(legs, corr, big_groups)[0]


def score_card(legs, corr=None, big_groups=None):
    """Everything a card shows, from its legs alone."""
    same_game = len(legs) > 1 and all(
        l.get("game_id") and l.get("game_id") == legs[0].get("game_id") for l in legs)
    games = [l.get("game_id") for l in legs if l.get("game_id")]
    mixed_game = (not same_game) and len(set(games)) < len(games)
    model, implied = combined_game_probs(legs, corr, big_groups)
    decimal = (1.0 / implied) if implied > 0 else 0.0
    per_game = {}
    for g in games:
        per_game[g] = per_game.get(g, 0) + 1
    return {
        "legs": legs,
        "model": model,
        "implied": implied,
        "ev": (model / implied - 1.0) if implied > 0 else 0.0,
        "tier": _confidence_tier(model, implied, len(legs)),
        "same_game": same_game,
        "mixed_game": mixed_game,
        # R101d -- some game supplies 3+ legs, priced as the product (GAME verdict).
        "big_game": any(k > 2 for k in per_game.values()),
        # What $100 would return if every leg hit, at the prices shown.
        "payout": STAKE * (decimal - 1.0) if decimal > 0 else 0.0,
        "assumed": sum(1 for l in legs if not l.get("priced")),
    }


def build_cards(legs, seeds, corr=None, per_count=PER_COUNT, counts=LEG_COUNTS,
                beam=BEAM, pool_cap=POOL_CAP, max_non_atd=None, max_per_game=2):
    """Top cards containing at least one seed leg (beam search).

    Beam search rather than enumeration: 1,400+ legs choose 6 is astronomical, and
    the greedy frontier finds the same high-conviction cards because conviction is
    monotone decreasing as legs are added. `beam` keeps enough alternatives that a
    leg blocked by the one-per-player or R74 rules does not dead-end the branch.

    The one place this deliberately differs from the JS in FORM (never in result):
    the JS sorts with a comparator that recomputes conviction per comparison, this
    sorts on a precomputed key. Both are stable sorts on the same number, so the
    order -- ties included -- is identical, and the key form is what keeps the
    32-seed sweep inside a pipeline step's budget.
    """
    # R101c -- a TD mode caps the non-TD legs (MAJORITY) or allows none (ALL TD /
    # 50%+); None = no cap (ANY). R101d -- max_per_game above two prices those
    # groups as the product. Both mirror app/views/myparlays.js buildCards.
    def non_td(ls):
        return sum(1 for l in ls if l.get("market") != "anytime_td")
    big = "product" if max_per_game > 2 else None
    seed_legs = [l for l in legs if matches_seed(l, seeds)
                 and (max_non_atd is None or l.get("market") == "anytime_td" or max_non_atd > 0)]
    if not seed_legs:
        return []
    by_conviction = lambda l: -l["model_prob"]  # noqa: E731 -- mirrors the JS comparator
    others = sorted((l for l in legs if not matches_seed(l, seeds)),
                    key=by_conviction)[:pool_cap]
    candidates = sorted(seed_legs, key=by_conviction) + others

    frontier = [[l] for l in sorted(seed_legs, key=by_conviction)[:beam]]
    out = []
    max_legs = max(counts)
    for size in range(2, max_legs + 1):
        grown = []
        for partial in frontier:
            for nxt in candidates:
                if not compatible(partial, nxt, max_per_game):
                    continue
                if (max_non_atd is not None and nxt.get("market") != "anytime_td"
                        and non_td(partial) >= max_non_atd):
                    continue
                grown.append(partial + [nxt])
        if not grown:
            break
        grown.sort(key=lambda card: -conviction(card, corr, big))
        # de-dupe: the same set of legs reached by different orders is one card
        seen = set()
        frontier = []
        for card in grown:
            key = "|".join(sorted(l["selection"] for l in card))
            if key in seen:
                continue
            seen.add(key)
            frontier.append(card)
            if len(frontier) >= beam:
                break
        if size in counts:
            out.extend(score_card(c, corr, big) for c in frontier[:per_count])
    return out


# --------------------------------------------------------------------------- #
# R101c / R101d -- the TD modes (app/views/myparlays.js atdPoolLegs, tdLegsFor,  #
# mergedCalib, tdMaxPerGame)                                                    #
# --------------------------------------------------------------------------- #

def atd_pool_legs(pool):
    """The pool's anytime-TD legs, one per player, owned by the player."""
    out = []
    for row in (pool or {}).get("atd_legs") or []:
        rungs = row.get("rungs") or []
        if not rungs:
            continue
        out.append(_leg_from_pool(row, rungs[0]))
    return out


def td_legs_for(mode, n, atd, other):
    """(legs, max_non_atd) for a TD mode and card size n."""
    if mode == "all_td":
        return atd, 0
    if mode == "scorers_50":
        return [l for l in atd if l["model_prob"] >= 0.5], 0
    return list(atd) + list(other), n - (n // 2 + 1)


def merged_calib(calib, pool):
    """The slate's correlations plus the pool's measured ATD pairs."""
    base = dict((calib or {}).get("correlations") or {})
    extra = ((pool or {}).get("atd_correlations") or {}).get("pairs") or []
    base["pairs"] = list(base.get("pairs") or []) + list(extra)
    return {"correlations": base}


def td_max_per_game(mode, verdict):
    """Legs ONE game may supply in a TD mode: the largest n with every size 2..n
    offered for the mode by a product-priced verdict; else the R83 cap of two."""
    if mode == "any" or not verdict or verdict.get("pricer") != "independent":
        return 2
    sizes = {int(x) for x in ((verdict.get("offered_sizes") or {}).get(mode) or [])}
    n = 2
    while n + 1 in sizes:
        n += 1
    return n if 2 in sizes else 2


def card_key(dial, seed_id, legs):
    """The identity of an OFFERED card: which dial, which seed, which selections.

    Leg ORDER is not part of it -- the same set of legs reached by a different
    beam path is the same card, which is exactly the de-dupe the search itself
    applies. The stored record keeps the order the card was offered in.
    """
    return "%s|%s|%s" % (dial, seed_id, "|".join(sorted(l["selection"] for l in legs)))

