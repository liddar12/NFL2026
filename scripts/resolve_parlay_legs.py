#!/usr/bin/env python3
"""Resolve the parlay-leg ledger -> data/parlay_leg_scores.json (R58, step 2).

Scores every LOCKED (pre-kickoff) leg in data/estimates/parlays_<season>.json:

  PROP legs   against nflverse stats_player_week_<season>.csv — the release
              scripts/resolve_estimates.py reads (fetch_csv + cache reused by
              import, never copied). `hit` = the market's yards >= the locked
              line (passing_yards / rushing_yards / receiving_yards).
  ML / SPREAD legs against FINAL results: a --finals file (the shape
              scripts.scrape.espn.fetch_final_results returns, i.e. what the game
              ledger grades against), or — offline — the graded lock receipts in
              data/snapshots/*_games_open.json, which carry the winner only, so
              moneyline resolves and spread is `unresolved: no_final_score`.
              When neither is available the document says so (`finals_source`).

HONESTY RULES
  * A week with no stats rows yet is SKIPPED (pending), loudly. No 2026 week has
    resolved as this ships: weeks_resolved is 0 and every metric is null.
  * A locked prop leg whose player has no stat line in a published week is
    `unresolved` with a reason (no_stat_line / ambiguous / player_unidentified /
    no_line) — never a miss, never a 0.
  * The join is the selection's abbreviated name + the market's position + the
    game's two teams; when the ledger locked the full name from the pool it is
    tried first (exact normalised name, unique), then the abbreviation
    (initial + surname, unique). resolve_estimates.norm_name is the normaliser.
  * The SEED pricing (scripts/models/parlay_builder.seed_prop_prob, imported) is
    recomputed from the locked p_team on exactly the legs the calibrated model
    priced, so seed vs calibrated is compared on identical legs.
  * A tie (moneyline) or push (spread) is unresolved, not a miss.

Runs on the runner (network + requests) after the ledger append; --selftest,
--dry-run-with <csv> and the pure core (`resolve_props`, `resolve_games`,
`document`) need neither.
"""

import argparse
import datetime as dt
import glob
import json
import math
import os
import re
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.build_parlay_ledger import (PROP_POSITION, GAME_MARKETS,  # noqa: E402
                                         ledger_path)
from scripts.models.parlay_builder import seed_prop_prob  # noqa: E402
from scripts.resolve_estimates import RELEASE_URL, fetch_csv, norm_name  # noqa: E402
from scripts.scrape.renames import normalize_team  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "parlay_leg_scores.json")
SNAPSHOT_GLOB = os.path.join(DATA, "snapshots", "*_games_open.json")
YARDS_COL = {"QB": "passing_yards", "RB": "rushing_yards", "WR": "receiving_yards"}
_POS_ALIAS = {"FB": "RB", "HB": "RB"}
_EPS = 1e-6
_ABBREV_RE = re.compile(r"^(?P<initial>[^\s.]+)\.?\s+(?P<last>.+)$")
_PROP_SEL_RE = re.compile(r"^(?P<abbrev>.+?) \d+\+ (?:pass|rush|rec) yds$")


def _r(x, nd=4):
    return None if x is None else round(float(x), nd)


def _clamp(p):
    return min(max(float(p), _EPS), 1.0 - _EPS)


def log_loss(p, y):
    p = _clamp(p)
    return -(math.log(p) if y else math.log(1.0 - p))


def brier(p, y):
    return (float(p) - (1.0 if y else 0.0)) ** 2


def _yards(row, col):
    v = row.get(col)
    if v in (None, "", "NA"):
        return 0.0
    try:
        return float(v)
    except ValueError:
        return 0.0


# --------------------------------------------------------------------------- #
# stats index + player join                                                     #
# --------------------------------------------------------------------------- #

def index_stats(csv_rows):
    """{week: [row]} of REG-season QB/RB/WR rows with canonical team and the
    three yardage columns; a row that fails to normalise is dropped."""
    by_week = {}
    for r in csv_rows:
        if (r.get("season_type") or "REG") != "REG":
            continue
        try:
            wk = int(float(r.get("week") or 0))
        except ValueError:
            continue
        if wk < 1 or wk > 18:
            continue
        pos = (r.get("position") or "").upper()
        pos = _POS_ALIAS.get(pos, pos)
        if pos not in YARDS_COL:
            continue
        name = r.get("player_display_name") or r.get("player_name") or ""
        n = norm_name(name)
        if not n:
            continue
        team = normalize_team(r.get("team") or r.get("recent_team"))
        by_week.setdefault(wk, []).append({
            "name": name, "norm": n, "pos": pos, "team": team,
            "yards": {p: _yards(r, c) for p, c in YARDS_COL.items()},
        })
    return by_week


def split_abbrev(selection):
    """'T. Henderson 60+ rush yds' -> ('t', 'henderson'); None when unparseable."""
    m = _PROP_SEL_RE.match(str(selection))
    if not m:
        return None
    a = _ABBREV_RE.match(m.group("abbrev").strip())
    if not a:
        return None
    ini = norm_name(a.group("initial"))
    last = norm_name(a.group("last"))
    if not ini or not last:
        return None
    return ini[0], last


def find_player(leg, week_rows):
    """(row, None) for the unique stats row behind the leg, else (None, reason)."""
    pos = leg.get("position")
    teams = {leg.get("home"), leg.get("away")}
    cands = [r for r in week_rows if r["pos"] == pos and r["team"] in teams]
    if leg.get("player"):
        full = norm_name(leg["player"])
        exact = [r for r in cands if r["norm"] == full]
        if len(exact) == 1:
            return exact[0], None
        if len(exact) > 1:
            return None, "ambiguous"
    parsed = split_abbrev(leg.get("selection"))
    if parsed is None:
        return None, "bad_selection"
    ini, last = parsed
    hits = []
    for r in cands:
        parts = r["norm"].split(" ")
        if len(parts) >= 2 and parts[0][0] == ini and " ".join(parts[1:]) == last:
            hits.append(r)
    if len(hits) == 1:
        return hits[0], None
    return None, "ambiguous" if hits else "no_stat_line"


# --------------------------------------------------------------------------- #
# resolution (pure)                                                             #
# --------------------------------------------------------------------------- #

def _ref(leg, reason):
    return {"week": int(leg["week"]), "game_id": leg["game_id"], "market": leg["market"],
            "selection": leg["selection"], "reason": reason}


def resolve_props(ledger, csv_rows):
    """(resolved rows, unresolved refs, weeks_with_rows) for locked prop legs."""
    by_week = index_stats(csv_rows)
    resolved, unresolved = [], []
    for leg in ledger.get("legs") or []:
        if not leg.get("locked") or leg.get("market") not in PROP_POSITION:
            continue
        wk = int(leg["week"])
        if wk not in by_week:
            continue                       # the week has no stats rows yet: pending
        if leg.get("line") is None or leg.get("model_prob") is None:
            unresolved.append(_ref(leg, "no_line"))
            continue
        if leg.get("p_team") is None or leg.get("team") is None:
            unresolved.append(_ref(leg, "player_unidentified"))
            continue
        row, why = find_player(leg, by_week[wk])
        if row is None:
            unresolved.append(_ref(leg, why))
            continue
        yards = row["yards"][leg["position"]]
        resolved.append({
            "week": wk, "game_id": leg["game_id"], "market": leg["market"],
            "position": leg["position"], "selection": leg["selection"],
            "player": row["name"], "team": leg["team"], "line": float(leg["line"]),
            "mu": leg.get("mu"), "sd": leg.get("sd"), "z": leg.get("z"),
            "p_team": float(leg["p_team"]), "pricing": leg.get("pricing"),
            "model_prob": float(leg["model_prob"]),
            "seed_prob": round(seed_prop_prob(leg["p_team"]), 4),
            "actual": yards, "hit": bool(yards >= float(leg["line"])),
        })
    return resolved, unresolved, sorted(by_week)


def finals_index(final_rows):
    """{game_id: {"home_score", "away_score"}} from FINAL rows (espn shape).
    A row without both integer scores is ignored — a stub never grades."""
    out = {}
    for g in final_rows or []:
        hs, as_ = g.get("home_score"), g.get("away_score")
        if g.get("game_id") is None or hs is None or as_ is None:
            continue
        out[str(g["game_id"])] = {"home_score": int(hs), "away_score": int(as_)}
    return out


def winners_from_locks(lock_docs):
    """{game_id: {"winner": "home"|"away"}} from graded lock rows (actual 0 = home
    win, 1 = away win — scripts/resolve_locks.py). Unresolved rows contribute nothing."""
    out = {}
    for rows in lock_docs or []:
        for row in rows or []:
            if row.get("event_type") != "game" or not row.get("resolved"):
                continue
            a = row.get("actual")
            if a in (0, 1):
                out[str(row.get("event_id"))] = {"winner": "home" if a == 0 else "away"}
    return out


def resolve_games(ledger, finals):
    """(resolved rows, unresolved refs) for locked moneyline / spread legs.
    `finals` values carry home_score/away_score, or just `winner`."""
    resolved, unresolved = [], []
    for leg in ledger.get("legs") or []:
        if not leg.get("locked") or leg.get("market") not in GAME_MARKETS:
            continue
        fin = (finals or {}).get(str(leg.get("game_id")))
        if fin is None:
            continue                       # not FINAL yet: pending
        if leg.get("model_prob") is None or leg.get("side") not in ("home", "away"):
            unresolved.append(_ref(leg, "no_model_prob"))
            continue
        side = leg["side"]
        actual = None
        if "home_score" in fin:
            hs, as_ = fin["home_score"], fin["away_score"]
            actual = {"home_score": hs, "away_score": as_}
            if leg["market"] == "moneyline":
                if hs == as_:
                    unresolved.append(_ref(leg, "tie"))
                    continue
                hit = (hs > as_) if side == "home" else (as_ > hs)
            else:
                if leg.get("line") is None:
                    unresolved.append(_ref(leg, "no_line"))
                    continue
                own, opp = (hs, as_) if side == "home" else (as_, hs)
                margin = own + float(leg["line"]) - opp
                if margin == 0:
                    unresolved.append(_ref(leg, "push"))
                    continue
                hit = margin > 0
        else:
            if leg["market"] != "moneyline":
                unresolved.append(_ref(leg, "no_final_score"))
                continue
            actual = {"winner": fin["winner"]}
            hit = fin["winner"] == side
        resolved.append({
            "week": int(leg["week"]), "game_id": leg["game_id"], "market": leg["market"],
            "selection": leg["selection"], "team": leg.get("team"), "side": side,
            "line": leg.get("line"), "model_prob": float(leg["model_prob"]),
            "actual": actual, "hit": bool(hit),
        })
    return resolved, unresolved


# --------------------------------------------------------------------------- #
# scoring (pure)                                                                #
# --------------------------------------------------------------------------- #

def _pair_metrics(pairs):
    if not pairs:
        return {"log_loss": None, "brier": None}
    return {"log_loss": _r(sum(log_loss(p, y) for p, y in pairs) / len(pairs)),
            "brier": _r(sum(brier(p, y) for p, y in pairs) / len(pairs))}


def props_block(rows):
    """Metrics over prop rows. `model` scores the as-made model_prob; `seed`
    scores the seed recomputed from the locked p_team — on the SAME rows."""
    n = len(rows)
    if not n:
        return {"n": 0, "hit_rate": None, "model": _pair_metrics([]),
                "seed": _pair_metrics([]), "by_pricing": {}}
    by_pricing = {}
    for r in rows:
        k = r.get("pricing") or "unknown"
        by_pricing[k] = by_pricing.get(k, 0) + 1
    return {
        "n": n,
        "hit_rate": _r(sum(1 for r in rows if r["hit"]) / n),
        "model": _pair_metrics([(r["model_prob"], r["hit"]) for r in rows]),
        "seed": _pair_metrics([(r["seed_prob"], r["hit"]) for r in rows]),
        "by_pricing": dict(sorted(by_pricing.items())),
    }


def game_block(rows):
    n = len(rows)
    if not n:
        return {"n": 0, "hit_rate": None, "log_loss": None, "brier": None}
    m = _pair_metrics([(r["model_prob"], r["hit"]) for r in rows])
    return {"n": n, "hit_rate": _r(sum(1 for r in rows if r["hit"]) / n),
            "log_loss": m["log_loss"], "brier": m["brier"]}


def score(prop_rows, game_rows):
    def blocks(props, games):
        return {"props": props_block(props),
                "moneyline": game_block([g for g in games if g["market"] == "moneyline"]),
                "spread": game_block([g for g in games if g["market"] == "spread"])}
    weeks = sorted({r["week"] for r in prop_rows} | {r["week"] for r in game_rows})
    out = {"pooled": blocks(prop_rows, game_rows), "weeks": [], "by_position": {}}
    for wk in weeks:
        b = blocks([r for r in prop_rows if r["week"] == wk],
                   [r for r in game_rows if r["week"] == wk])
        b["week"] = wk
        out["weeks"].append({"week": wk, "props": b["props"], "moneyline": b["moneyline"],
                             "spread": b["spread"]})
    for pos in sorted({r["position"] for r in prop_rows}):
        out["by_position"][pos] = props_block([r for r in prop_rows if r["position"] == pos])
    return out


def document(season, ledger, ledger_rel, prop_rows, game_rows, unresolved, skipped,
             finals_source, generated_utc, source=None):
    legs = ledger.get("legs") or [] if ledger else []
    s = score(prop_rows, game_rows)
    resolved = sorted(prop_rows + game_rows,
                      key=lambda r: (r["week"], r["game_id"], r["market"], r["selection"]))
    return {
        "season": int(season),
        "generated_utc": generated_utc,
        "source": source or RELEASE_URL.format(season=season),
        "finals_source": finals_source,
        "ledger": ledger_rel,
        "rule": ("prop hit = the market's yards >= the locked line; seed = "
                 "parlay_builder.seed_prop_prob(locked p_team) on the same legs; only "
                 "legs locked before kickoff are scored; a player with no stat line, a "
                 "tie or a push is unresolved with a reason, never a miss"),
        "weeks_resolved": len({r["week"] for r in resolved}),
        "legs": {
            "on_file": len(legs),
            "locked": sum(1 for l in legs if l.get("locked")),
            "unlocked": sum(1 for l in legs if not l.get("locked")),
            "resolved": len(resolved),
            "unresolved": len(unresolved),
        },
        "skipped": skipped,
        "pooled": s["pooled"],
        "by_position": s["by_position"],
        "weeks": s["weeks"],
        "unresolved": sorted(unresolved, key=lambda u: (u["week"], u["game_id"],
                                                        u["market"], u["selection"])),
        "resolved": resolved,
    }


# --------------------------------------------------------------------------- #
# I/O                                                                           #
# --------------------------------------------------------------------------- #

def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write(doc, path=OUT_PATH):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def read_csv(path):
    import csv
    with open(path, encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def load_finals(finals_path=None, snapshot_glob=SNAPSHOT_GLOB):
    """(finals index, source label). A --finals file wins; else the graded lock
    receipts (winner only); else nothing."""
    if finals_path:
        doc = _load(finals_path)
        rows = doc.get("games") if isinstance(doc, dict) else doc
        return finals_index(rows), "final scores from %s (scripts.scrape.espn " \
            "fetch_final_results shape — the game ledger's source)" % finals_path
    docs = []
    for f in sorted(glob.glob(snapshot_glob)):
        try:
            docs.append(_load(f))
        except (OSError, ValueError):
            continue
    winners = winners_from_locks(docs)
    if winners:
        return winners, ("winner only, from the graded lock receipts data/snapshots/"
                         "*_games_open.json (scripts/resolve_locks.py, STATUS-gated "
                         "FINAL); spread legs need scores and stay unresolved")
    return {}, "none reachable offline: no --finals file and no graded lock receipt yet"


def run(season=None, cache_dir=None, out_path=OUT_PATH, offline=False, dry_run_csv=None,
        finals_path=None, now=None):
    if season is None:
        season = int(_load(os.path.join(DATA, "parlays.json"))["season"])
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lpath = ledger_path(season)
    ledger_rel = os.path.relpath(lpath, _ROOT)
    ledger, prop_rows, game_rows, unresolved, skipped = None, [], [], [], None
    source = None
    finals, finals_source = load_finals(finals_path)
    if not os.path.exists(lpath):
        skipped = ("no ledger at %s yet — scripts/build_parlay_ledger.py appends the first "
                   "legs on the daily run; nothing to resolve" % ledger_rel)
    else:
        ledger = _load(lpath)
        if not any(l.get("locked") for l in ledger.get("legs") or []):
            skipped = "ledger has no locked (pre-kickoff) leg yet"
        else:
            game_rows, g_unres = resolve_games(ledger, finals)
            unresolved += g_unres
            rows = None
            if dry_run_csv:
                rows, source = read_csv(dry_run_csv), "dry run: %s" % dry_run_csv
            elif offline:
                skipped = "offline run: stats not fetched"
            else:
                rows, why = fetch_csv(season, cache_dir)
                if rows is None:
                    skipped = why
            if rows is not None:
                prop_rows, p_unres, weeks = resolve_props(ledger, rows)
                unresolved += p_unres
                if not prop_rows and not game_rows:
                    skipped = ("stats_player_week_%d.csv has %d rows (weeks %s) but no "
                               "locked leg resolved" % (season, len(rows), weeks))
    doc = document(season, ledger, ledger_rel, prop_rows, game_rows, unresolved, skipped,
                   finals_source, now, source=source)
    stream = sys.stdout
    if dry_run_csv and out_path is None:
        print(json.dumps(doc, ensure_ascii=True, indent=2))
        stream = sys.stderr          # stdout is the document in a dry run
    else:
        write(doc, out_path)
    if skipped:
        print("[resolve_parlay_legs] SKIPPED (0 weeks resolved): %s" % skipped,
              file=sys.stderr)
    else:
        p = doc["pooled"]["props"]
        print("resolve_parlay_legs: %d weeks, %d legs resolved (%d unresolved); props n=%d "
              "hit %s model ll %s seed ll %s; moneyline n=%d spread n=%d"
              % (doc["weeks_resolved"], doc["legs"]["resolved"], doc["legs"]["unresolved"],
                 p["n"], p["hit_rate"], p["model"]["log_loss"], p["seed"]["log_loss"],
                 doc["pooled"]["moneyline"]["n"], doc["pooled"]["spread"]["n"]),
              file=stream)
    return doc


# --------------------------------------------------------------------------- #
# selftest                                                                      #
# --------------------------------------------------------------------------- #

def _fixture_ledger():
    def prop(sel, market, pos, team, side, player, p_team, mu, prob, locked=True, week=1,
             gid="g1", home="SEA", away="NE", line=59.5):
        return {"season": 2026, "week": week, "game_id": gid, "home": home, "away": away,
                "kickoff_utc": "2026-09-10T00:20Z", "market": market, "selection": sel,
                "position": pos, "player": player, "gsis_id": None, "team": team,
                "side": side, "line": line, "mu": mu, "sd": 38.87,
                "z": round((mu - line) / 38.87, 4), "p_team": p_team,
                "model_prob": prob, "implied_prob": 0.4, "pricing": "calibrated",
                "seen_utc": "2026-09-08T10:39:10Z", "locked": locked,
                "locked_utc": "2026-09-08T10:39:10Z" if locked else None}
    return {"season": 2026, "legs": [
        prop("T. Henderson 60+ rush yds", "rb_rush_yds", "RB", "NE", "away",
             "TreVeyon Henderson", 0.39, 44.49, 0.3142),
        prop("J. Smith-Njigba 60+ rec yds", "wr_rec_yds", "WR", "SEA", "home",
             "Jaxon Smith-Njigba", 0.61, 94.02, 0.6525),
        prop("S. Darnold 225+ pass yds", "qb_pass_yds", "QB", "SEA", "home",
             None, 0.61, 240.0, 0.55, line=224.5),        # no pool name: abbreviation join
        prop("K. Williams 60+ rush yds", "rb_rush_yds", "RB", "LAR", "home",
             "Kyren Williams", 0.7, 71.08, 0.5479, gid="g2", home="LAR", away="ARI"),
        prop("N. Harris 60+ rush yds", "rb_rush_yds", "RB", "LAC", "home",
             "Najee Harris", 0.6, 60.0, 0.5, gid="g3", home="LAC", away="KC"),   # no row
        prop("D. Adams 60+ rec yds", "wr_rec_yds", "WR", "LAR", "home",
             "Davante Adams", 0.7, 70.0, 0.5, gid="g2", home="LAR", away="ARI"),  # ambiguous
        prop("X. Late 60+ rec yds", "wr_rec_yds", "WR", "NE", "away",
             "Xavier Late", 0.39, 70.0, 0.6, locked=False),
        prop("W. Two 60+ rec yds", "wr_rec_yds", "WR", "NE", "away",
             "Week Two", 0.39, 70.0, 0.6, week=2, gid="g9"),
        prop("U. Known 60+ rec yds", "wr_rec_yds", "WR", None, None,
             None, None, 70.0, 0.6),
        {"season": 2026, "week": 1, "game_id": "g1", "home": "SEA", "away": "NE",
         "kickoff_utc": "2026-09-10T00:20Z", "market": "moneyline", "selection": "SEA ML",
         "position": None, "player": None, "gsis_id": None, "team": "SEA", "side": "home",
         "line": None, "mu": None, "sd": None, "z": None, "p_team": 0.61,
         "model_prob": 0.61, "implied_prob": 0.6, "pricing": None,
         "seen_utc": "x", "locked": True, "locked_utc": "x"},
        {"season": 2026, "week": 1, "game_id": "g1", "home": "SEA", "away": "NE",
         "kickoff_utc": "2026-09-10T00:20Z", "market": "spread", "selection": "SEA -3",
         "position": None, "player": None, "gsis_id": None, "team": "SEA", "side": "home",
         "line": -3.0, "mu": None, "sd": None, "z": None, "p_team": 0.61,
         "model_prob": 0.5, "implied_prob": 0.52, "pricing": None,
         "seen_utc": "x", "locked": True, "locked_utc": "x"},
        {"season": 2026, "week": 1, "game_id": "g2", "home": "LAR", "away": "ARI",
         "kickoff_utc": "2026-09-13T20:05Z", "market": "moneyline", "selection": "LAR ML",
         "position": None, "player": None, "gsis_id": None, "team": "LAR", "side": "home",
         "line": None, "mu": None, "sd": None, "z": None, "p_team": 0.7,
         "model_prob": 0.7, "implied_prob": 0.68, "pricing": None,
         "seen_utc": "x", "locked": True, "locked_utc": "x"},
    ]}


def _fixture_rows():
    def row(name, pos, team, week="1", **yds):
        r = {"season": "2026", "week": week, "season_type": "REG", "position": pos,
             "team": team, "player_display_name": name, "passing_yards": "0",
             "rushing_yards": "0", "receiving_yards": "0"}
        r.update({k: str(v) for k, v in yds.items()})
        return r
    return [
        row("TreVeyon Henderson", "RB", "NE", rushing_yards=48),          # miss
        row("Jaxon Smith-Njigba", "WR", "SEA", receiving_yards=101),      # hit
        row("Sam Darnold", "QB", "SEA", passing_yards=224.5),             # hit at the line
        row("Kyren Williams", "RB", "LA", rushing_yards=77),              # LA -> LAR, hit
        row("Davante Adams", "WR", "LA", receiving_yards=70),
        row("Davante Adams", "WR", "ARI", receiving_yards=20),            # ambiguous
        row("Xavier Late", "WR", "NE", receiving_yards=100),              # unlocked leg
        row("TreVeyon Henderson", "RB", "NE", week="1", season_type="POST",
            rushing_yards=200),                                            # POST ignored
        row("Najee Harris", "RB", "LAC", week="2", rushing_yards=90),     # not week 1
    ]


def selftest():
    ledger = _fixture_ledger()
    rows = _fixture_rows()
    rows[7]["season_type"] = "POST"
    assert split_abbrev("J. Smith-Njigba 60+ rec yds") == ("j", "smith njigba")
    assert split_abbrev("A. St. Brown 60+ rec yds") == ("a", "st brown")
    assert split_abbrev("SEA ML") is None
    props, unres, weeks = resolve_props(ledger, rows)
    assert weeks == [1, 2]
    got = {r["selection"].split(" ")[1]: r for r in props}
    assert set(got) == {"Henderson", "Smith-Njigba", "Darnold", "Williams"}, set(got)
    assert got["Henderson"]["hit"] is False and got["Henderson"]["actual"] == 48.0
    assert got["Smith-Njigba"]["hit"] is True
    assert got["Darnold"]["hit"] is True and got["Darnold"]["player"] == "Sam Darnold", \
        "yards == line hits (60+ means >= the seed line); abbreviation join works"
    assert got["Williams"]["hit"] is True, "nflverse LA joins the canonical LAR"
    assert got["Henderson"]["seed_prob"] == round(seed_prop_prob(0.39), 4)
    reasons = {u["selection"].split(" ")[1]: u["reason"] for u in unres}
    assert reasons == {"Harris": "no_stat_line", "Adams": "ambiguous",
                       "Known": "player_unidentified", "Two": "no_stat_line"}, reasons
    assert not any(r["selection"].startswith("X. Late") for r in props), \
        "an unlocked leg is never scored"
    assert not any(r["week"] == 2 for r in props), \
        "week 2 is published but W. Two has no row there -> unresolved, never scored"
    # games: scores resolve ML + spread; winner-only resolves ML only; tie / push
    finals = finals_index([{"game_id": "g1", "home_score": 24, "away_score": 20},
                           {"game_id": "g2", "home_score": 17, "away_score": 17},
                           {"game_id": "stub", "home_score": None, "away_score": None}])
    games, g_unres = resolve_games(ledger, finals)
    assert {(g["selection"], g["hit"]) for g in games} == {("SEA ML", True), ("SEA -3", True)}
    assert [u["reason"] for u in g_unres] == ["tie"]
    push = finals_index([{"game_id": "g1", "home_score": 23, "away_score": 20}])
    games2, g_unres2 = resolve_games(ledger, push)
    assert [u["reason"] for u in g_unres2] == ["push"] and len(games2) == 1
    winners = winners_from_locks([[{"event_type": "game", "event_id": "g1", "resolved": True,
                                    "actual": 1}, {"event_type": "game", "event_id": "g2",
                                                   "resolved": False}]])
    games3, g_unres3 = resolve_games(ledger, winners)
    assert [(g["selection"], g["hit"]) for g in games3] == [("SEA ML", False)]
    assert [u["reason"] for u in g_unres3] == ["no_final_score"]
    # scoring: seed and model are scored on the SAME legs; counts conserve
    doc = document(2026, ledger, "data/estimates/parlays_2026.json", props, games,
                   unres + g_unres, None, "test", "2026-09-15T00:00:00Z")
    p = doc["pooled"]["props"]
    assert p["n"] == 4 and p["hit_rate"] == 0.75 and p["by_pricing"] == {"calibrated": 4}
    assert p["model"]["log_loss"] is not None and p["seed"]["log_loss"] is not None
    exp = -(math.log(1 - 0.3142) + math.log(0.6525) + math.log(0.55) + math.log(0.5479)) / 4
    assert abs(p["model"]["log_loss"] - exp) < 1e-4
    assert doc["weeks_resolved"] == 1 and doc["legs"]["resolved"] == 6
    assert doc["legs"]["locked"] == 11 and doc["legs"]["unlocked"] == 1
    assert doc["pooled"]["moneyline"]["n"] == 1 and doc["pooled"]["spread"]["n"] == 1
    assert sum(w["props"]["n"] for w in doc["weeks"]) == p["n"]
    assert sum(b["n"] for b in doc["by_position"].values()) == p["n"]
    assert len(doc["unresolved"]) == 5
    # nothing resolved -> honest null metrics
    empty = document(2026, ledger, "x", [], [], [], "no rows", "none", "t")
    assert empty["weeks_resolved"] == 0 and empty["pooled"]["props"]["hit_rate"] is None \
        and empty["pooled"]["props"]["model"]["log_loss"] is None
    print("selftest OK: name/abbreviation join on team + position, LA->LAR, REG only, "
          "hit at the line, unlocked never scored, no stat line / ambiguous / "
          "unidentified are unresolved with reasons, tie and push unresolved, seed and "
          "model scored on identical legs, null metrics at 0 resolved")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--offline", action="store_true",
                    help="never fetch the stats release; write the honest skip")
    ap.add_argument("--dry-run-with", metavar="CSV", default=None,
                    help="resolve against this stats CSV and print the document "
                         "(writes nothing unless --out is given)")
    ap.add_argument("--finals", metavar="JSON", default=None,
                    help="FINAL rows (game_id, home_score, away_score) for ML/spread legs")
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
