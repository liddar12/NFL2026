"""R101c — this week's ANYTIME-TD cards for the WEEK scope -> data/atd_cards.json.

Owner (2026-09-24): GAME, WEEK and MY each go up to 10 legs, with an anytime-TD
selector: ALL TD (every leg an anytime TD), MAJORITY TD (more than half the legs
anytime TD, the rest the strongest other legs — the "TD + floor ladder") and
50%+ SCORERS (every leg an anytime TD the model rates 50 % or better).

WEEK SCOPE = ONE LEG PER GAME. Every card takes each leg from a different game,
so its legs are independent and the card's model probability is the product of
its legs' — the same rule the slate's week parlays use, and the only joint
number here that needs no same-game model. (Same-game cards arrive with the
joint pricer, which must first pass its own held-out test.)

EVERY LEG IS A POOL LEG, AT THE POOL'S NUMBER. Legs come from data/leg_pool.json
(atd_legs, the in-support yardage rungs, the copied game legs), so a card can
never price a leg the pool does not offer, and validate_data.py re-checks every
leg against the pool. Only games that have not kicked off are used. Nothing is
built unless data/atd_backtest.json is adopted (the pool offers no ATD leg
otherwise, so there is nothing to build from).

SELECTION. For each mode and size (2..10), up to CARDS_PER_SIZE cards, strongest
first: the best leg of each eligible game, ranked by model probability, then
deterministic single swaps for the alternatives. A size the week cannot fill
(e.g. too few 50 %+ scorers in distinct games) is NOT OFFERED and says why.

RECORDED FOR GRADING. Each card seen for the first time is appended to
data/atd_cards/{season}_wk{NN}.json with its as-offered legs and probabilities
(first sight wins; a later run never rewrites it). scripts/resolve_atd_cards.py
grades that record, so what these cards claim is measured every week.

MARKET POLICY: no book number is read. A card shows the model's hit chance and
the break-even American odds that chance implies — never an EV against a price.

  python3 scripts/build_atd_cards.py            write data/atd_cards.json (+ record)
  python3 scripts/build_atd_cards.py --selftest offline
"""

import argparse
import datetime as _dt
import hashlib
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

DATA = os.path.join(_ROOT, "data")
OUT = os.path.join(DATA, "atd_cards.json")
RECORD_DIR = os.path.join(DATA, "atd_cards")
ATD = "anytime_td"
MODES = ("all_td", "majority_td", "scorers_50")
MODE_LABEL = {"all_td": "ALL ANYTIME TD", "majority_td": "MAJORITY TD",
              "scorers_50": "50%+ SCORERS"}
SIZES = tuple(range(2, 11))
CARDS_PER_SIZE = 3
SCORER_MIN = 0.5
PROP_POSITION = {"qb_pass_yds": "QB", "rb_rush_yds": "RB", "wr_rec_yds": "WR"}


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_utc(s):
    s = str(s or "").strip().replace("Z", "")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return _dt.datetime.strptime(s, fmt).replace(tzinfo=_dt.timezone.utc)
        except ValueError:
            continue
    return None


def upcoming_games(schedule, now):
    """{game_id} scheduled and not yet kicked off."""
    out = set()
    for g in (schedule or {}).get("games") or []:
        ko = _parse_utc(g.get("kickoff_utc"))
        if g.get("status") == "STATUS_SCHEDULED" and ko is not None and ko > now:
            out.add(str(g.get("game_id")))
    return out


def pool_legs(pool, open_games):
    """(atd_by_game, other_by_game): the best leg per player per game, in the
    pool's own numbers. A yardage player contributes his highest-probability
    in-support rung (the "floor"); game legs are copied verbatim."""
    atd, other = {}, {}
    for r in (pool or {}).get("atd_legs") or []:
        gid = str(r.get("game_id"))
        if gid not in open_games:
            continue
        rung = r["rungs"][0]
        atd.setdefault(gid, []).append({
            "market": ATD, "selection": rung["selection"], "model_prob": rung["model_prob"],
            "line": rung["line"], "player": r.get("player"), "team": r.get("team"),
            "position": r.get("position"), "gsis_id": r.get("gsis_id"), "game_id": gid,
            "side": r.get("side")})
    for r in (pool or {}).get("players") or []:
        gid = str(r.get("game_id"))
        if gid not in open_games or not r.get("rungs"):
            continue
        rung = max(r["rungs"], key=lambda x: (x["model_prob"], -x["line"]))
        other.setdefault(gid, []).append({
            "market": r.get("market"), "selection": rung["selection"],
            "model_prob": rung["model_prob"], "line": rung["line"], "player": r.get("player"),
            "team": r.get("team"), "position": r.get("position"), "gsis_id": r.get("gsis_id"),
            "game_id": gid, "side": r.get("side")})
    for g in (pool or {}).get("game_legs") or []:
        gid = str(g.get("game_id"))
        if gid not in open_games or g.get("market") != "moneyline" \
                or g.get("side") not in ("home", "away"):
            continue
        other.setdefault(gid, []).append({
            "market": "moneyline", "selection": g["selection"], "model_prob": g["model_prob"],
            "line": None, "player": None, "team": g.get("team"), "position": None,
            "gsis_id": None, "game_id": gid, "side": g.get("side")})
    for d in (atd, other):
        for gid in d:
            d[gid].sort(key=lambda l: (-l["model_prob"], l["selection"]))
    return atd, other


def _prod(legs):
    p = 1.0
    for leg in legs:
        p *= leg["model_prob"]
    return p


def break_even_american(p):
    """The American odds at which a bet with hit chance p breaks even."""
    if p <= 0 or p >= 1:
        return None
    if p >= 0.5:
        return -int(round(100 * p / (1 - p)))
    return int(round(100 * (1 - p) / p))


def _card(mode, legs):
    legs = sorted(legs, key=lambda l: (-l["model_prob"], l["selection"]))
    key = mode + "|" + "|".join(sorted("%s@%s" % (l["selection"], l["game_id"]) for l in legs))
    p = _prod(legs)
    return {"card_id": hashlib.sha1(key.encode("utf-8")).hexdigest()[:16], "mode": mode,
            "label": MODE_LABEL[mode], "n_legs": len(legs), "legs": legs,
            "model_prob": round(p, 8), "break_even_american": break_even_american(p),
            "n_atd": sum(1 for l in legs if l["market"] == ATD)}


def _variants(best, alts, n, k):
    """Up to k leg lists of size n, strongest first: the top n `best` legs, then
    single swaps of the weakest chosen leg for (a) the next unused game's best
    leg, (b) the chosen game's second-best leg — deterministic, never repeating
    a game within a card."""
    if len(best) < n:
        return []
    base = best[:n]
    out, seen = [base], {tuple(l["selection"] for l in base)}
    swaps = []
    for i in range(n - 1, -1, -1):
        for cand in best[n:n + 3]:
            swaps.append(base[:i] + base[i + 1:] + [cand])
        for alt in alts.get(base[i]["game_id"], [])[1:2]:
            swaps.append(base[:i] + [alt] + base[i + 1:])
    swaps.sort(key=lambda legs: -_prod(legs))
    for legs in swaps:
        sig = tuple(sorted(l["selection"] for l in legs))
        if sig in seen or len({l["game_id"] for l in legs}) < n:
            continue
        seen.add(sig)
        out.append(legs)
        if len(out) >= k:
            break
    return out


def build_mode(mode, atd, other, sizes=SIZES, k=CARDS_PER_SIZE):
    """{"cards": {size: [card]}, "not_offered": {size: reason}}."""
    cards, refused = {}, {}
    if mode in ("all_td", "scorers_50"):
        floor = SCORER_MIN if mode == "scorers_50" else 0.0
        pools = {g: [l for l in legs if l["model_prob"] >= floor] for g, legs in atd.items()}
        best = sorted((v[0] for v in pools.values() if v),
                      key=lambda l: (-l["model_prob"], l["selection"]))
        for n in sizes:
            got = [_card(mode, legs) for legs in _variants(best, pools, n, k)]
            if got:
                cards[str(n)] = got
            else:
                refused[str(n)] = ("only %d game(s) have an anytime-TD leg%s this week; a WEEK "
                                   "card takes one leg per game"
                                   % (len(best), " at 50%+" if floor else ""))
        return {"cards": cards, "not_offered": refused}
    # majority_td: m = n//2 + 1 ATD legs from the strongest ATD games, the rest
    # the strongest non-ATD leg of OTHER games (the floor ladder).
    atd_best = sorted((v[0] for v in atd.values() if v),
                      key=lambda l: (-l["model_prob"], l["selection"]))
    for n in sizes:
        m = n // 2 + 1
        got, seen = [], set()
        for shift in range(0, 4):
            atd_part = atd_best[shift:shift + m] if shift == 0 else \
                atd_best[:m - 1] + atd_best[m - 1 + shift:m + shift]
            if len(atd_part) < m:
                continue
            used = {l["game_id"] for l in atd_part}
            rest = sorted((v[0] for g, v in other.items() if g not in used and v),
                          key=lambda l: (-l["model_prob"], l["selection"]))
            if len(rest) < n - m:
                continue
            legs = atd_part + rest[:n - m]
            c = _card(mode, legs)
            if c["card_id"] in seen:
                continue
            seen.add(c["card_id"])
            got.append(c)
            if len(got) >= k:
                break
        got.sort(key=lambda c: -c["model_prob"])
        if got:
            cards[str(n)] = got
        else:
            refused[str(n)] = ("needs %d anytime-TD games and %d other games this week; "
                               "%d and %d are open" % (m, n - m, len(atd_best), len(other)))
    return {"cards": cards, "not_offered": refused}


def build(pool, schedule, atd_backtest, now=None):
    now = now or _dt.datetime.now(_dt.timezone.utc)
    adopted = bool((atd_backtest or {}).get("adopted")) and bool((pool or {}).get("atd_legs"))
    doc = {"kind": "atd_cards", "season": (pool or {}).get("season"),
           "week": (pool or {}).get("week"), "generated_utc": _iso(now),
           "pool_generated_utc": (pool or {}).get("generated_utc"), "adopted": adopted,
           "scope": "week", "pricing": "independent: one leg per game, product of pool model_prob",
           "modes": {}, "notes": [
               "Every card takes each leg from a different game, so the card's model chance "
               "is the product of its legs' — no same-game correlation to model.",
               "Legs are this week's leg_pool.json legs at the pool's own probability; only "
               "games not yet kicked off are used.",
               "Break-even odds are what the model's chance is worth; no book price is read."]}
    if not adopted:
        doc["notes"].append("No card: the anytime-TD model is not adopted, so the pool "
                            "offers no ATD leg.")
        return doc
    atd, other = pool_legs(pool, upcoming_games(schedule, now))
    for mode in MODES:
        doc["modes"][mode] = build_mode(mode, atd, other)
    return doc


def record(doc, record_dir=RECORD_DIR, now=None):
    """Append first-seen cards to data/atd_cards/{season}_wk{NN}.json. First sight
    wins: a card already on file is never rewritten, so what was offered is what
    is graded. Returns the number of cards added."""
    if not doc.get("adopted") or doc.get("season") is None or doc.get("week") is None:
        return 0
    path = os.path.join(record_dir, "%d_wk%02d.json" % (int(doc["season"]), int(doc["week"])))
    try:
        rec = _load(path)
    except (OSError, ValueError):
        rec = {"kind": "atd_cards_record", "season": int(doc["season"]),
               "week": int(doc["week"]), "cards": []}
    have = {c["card_id"] for c in rec["cards"]}
    added = 0
    for mode, blk in doc["modes"].items():
        for size, cards in blk["cards"].items():
            for c in cards:
                if c["card_id"] in have:
                    continue
                have.add(c["card_id"])
                rec["cards"].append(dict(c, first_seen_utc=doc["generated_utc"]))
                added += 1
    if added:
        os.makedirs(record_dir, exist_ok=True)
        _write(path, rec)
    return added


def _write(path, doc):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def _optional(path):
    try:
        return _load(path)
    except (OSError, ValueError):
        return None


def selftest():
    now = _dt.datetime(2026, 9, 27, 12, 0, tzinfo=_dt.timezone.utc)
    sched = {"games": [{"game_id": "G%d" % i, "status": "STATUS_SCHEDULED",
                        "kickoff_utc": "2026-09-28T17:00Z"} for i in range(1, 7)]
             + [{"game_id": "G9", "status": "STATUS_FINAL", "kickoff_utc": "2026-09-25T00:15Z"}]}
    atd_legs, players, game_legs = [], [], []
    for i in range(1, 7):
        for j, p in enumerate((0.62 - i * 0.04, 0.30)):
            atd_legs.append({"gsis_id": "a%d%d" % (i, j), "player": "Back %d%d" % (i, j),
                             "team": "T%d" % i, "position": "RB", "market": ATD,
                             "game_id": "G%d" % i, "side": "home", "pricing": "atd_model",
                             "rungs": [{"line": 0.5, "selection": "B. %d%d anytime TD" % (i, j),
                                        "model_prob": round(p, 4)}]})
        players.append({"gsis_id": "w%d" % i, "player": "Wide %d" % i, "team": "T%d" % i,
                        "position": "WR", "market": "wr_rec_yds", "game_id": "G%d" % i,
                        "side": "away", "rungs": [{"line": 19.5, "selection": "W. %d 20+ rec yds" % i,
                                                   "model_prob": 0.9},
                                                  {"line": 59.5, "selection": "W. %d 60+ rec yds" % i,
                                                   "model_prob": 0.45}]})
    atd_legs.append({"gsis_id": "late", "player": "Late Guy", "team": "T9", "position": "WR",
                     "market": ATD, "game_id": "G9", "side": "home", "pricing": "atd_model",
                     "rungs": [{"line": 0.5, "selection": "L. Guy anytime TD", "model_prob": 0.9}]})
    pool = {"season": 2026, "week": 3, "generated_utc": "x", "atd_legs": atd_legs,
            "players": players, "game_legs": game_legs}
    doc = build(pool, sched, {"adopted": True}, now)
    all_td = doc["modes"]["all_td"]
    c4 = all_td["cards"]["4"][0]
    assert c4["n_legs"] == 4 and c4["n_atd"] == 4
    assert len({l["game_id"] for l in c4["legs"]}) == 4, "one leg per game"
    assert all(l["game_id"] != "G9" for l in c4["legs"]), "a kicked-off game is never used"
    assert abs(c4["model_prob"] - 0.58 * 0.54 * 0.50 * 0.46) < 1e-6, c4["model_prob"]
    assert "7" in all_td["not_offered"] and "6" in all_td["cards"]
    s50 = doc["modes"]["scorers_50"]
    assert set(s50["cards"]) == {"2", "3"} and all(
        l["model_prob"] >= 0.5 for c in s50["cards"]["3"] for l in c["legs"]), s50
    maj = doc["modes"]["majority_td"]["cards"]["5"][0]
    assert maj["n_atd"] == 3 and len({l["game_id"] for l in maj["legs"]}) == 5, maj
    assert all(l["model_prob"] == 0.9 for l in maj["legs"] if l["market"] != ATD), \
        "the non-TD legs are each game's strongest floor"
    assert break_even_american(0.25) == 300 and break_even_american(0.8) == -400
    none = build(pool, sched, {"adopted": False}, now)
    assert none["modes"] == {} and none["adopted"] is False
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        n1 = record(doc, tmp)
        n2 = record(doc, tmp)
        assert n1 > 0 and n2 == 0, (n1, n2)
    print("selftest ok: one leg per game, kicked-off games excluded, product pricing, "
          "unfillable sizes refused, 50%+ floor, majority = n//2+1 TD + floors, not adopted = "
          "no card, first sight recorded once")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    doc = build(_optional(os.path.join(DATA, "leg_pool.json")),
                _optional(os.path.join(DATA, "schedule_full.json")),
                _optional(os.path.join(DATA, "atd_backtest.json")))
    _write(OUT, doc)
    added = record(doc)
    counts = {m: {s: len(c) for s, c in b["cards"].items()} for m, b in doc["modes"].items()}
    print("atd_cards %s wk %s: adopted=%s, cards %s; %d new card(s) recorded"
          % (doc["season"], doc["week"], doc["adopted"], counts, added))
    return 0


if __name__ == "__main__":
    sys.exit(main())
