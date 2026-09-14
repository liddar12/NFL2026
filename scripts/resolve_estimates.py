#!/usr/bin/env python3
"""Resolve the estimate ledger against actual weekly PPR -> data/estimate_scores.json
(R49 learning loop, step 2) and the `learning_record` in data/meta.json.

Joins data/estimates/<season>.json's LOCKED (player, week) estimates — frozen before
each week's first kickoff by scripts/build_estimate_ledger.py — to nflverse
stats_player_week_{season}.csv (the same release-CSV path scripts/build_kdst.py and
build_dvp_positional.py read), and writes per-row actuals plus error metrics for
THREE series - shipped, candidate and gated (the never-regress incumbent; shipped
== candidate under the R49 owner override): MAE, bias (mean of estimate - actual)
by position, and the share of actuals inside the candidate band.

HONESTY RULES
  * A week with no stats rows yet is SKIPPED, loudly. No 2026 week has resolved as
    this ships, so the document says weeks_resolved: 0 and every metric is null —
    an MAE is never invented. meta.learning_record says the same.
  * The join is name + position (nflverse keys on gsis id, the pool on espn id):
    exact normalised name + position, unique; else exact name, unique. A ledger
    player who never joins ANY row that season is `unmatched` and skipped — never
    scored as 0, and LISTED BY NAME in `unmatched` (R53) so a silent drop is
    impossible. A player who joins the season but has no row in a resolved week
    did not play: actual 0.0 by that FACT, flagged `dnp`.
  * When rows exist but nothing resolves, `skipped` says exactly why: the CSV
    carries other weeks than the locked ones, or no ledger player joined.

R53 — `--dry-run-with <csv> [--ledger <path>]` runs the EXACT production
resolve + score path (`build_document`) against a stats CSV on disk and prints
the document to stdout without writing estimate_scores.json or meta.json. It is
how the first-week path is proven in the sandbox (tests/fixtures/r53/) before
nflverse publishes stats_player_week_2026.csv.
  * Actual = the release's `fantasy_points_ppr` column when present, else the
    standard PPR formula over its component columns (documented in `scoring`).

Runs on the runner (network + requests) after the ledger append; --selftest and
the pure core (`resolve`, `score`) need neither. `requests` missing is a loud skip.
"""

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import unicodedata

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import meta_record  # noqa: E402
from scripts.build_estimate_ledger import ledger_path  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "estimate_scores.json")
PROJECTIONS_PATH = os.path.join(DATA, "player_projections.json")
RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
RELEASE_URL = RELEASE_BASE + "/stats_player/stats_player_week_{season}.csv"
_HTTP_TIMEOUT = 120
POSITIONS = ("QB", "RB", "WR", "TE")
_POS_ALIAS = {"FB": "RB", "HB": "RB"}
SCORING = ("actual = nflverse fantasy_points_ppr when the column is present; else "
           "pass_yd*0.04 + pass_td*4 - int*2 + rush_yd*0.1 + rush_td*6 + rec*1 + "
           "rec_yd*0.1 + rec_td*6 - fumbles_lost*2 + 2pt*2 over the release's "
           "component columns (regular season only)")
# Learned-signal adoption on the player objective (scripts/harness/ledger_objective).
MIN_RESOLVED_WEEKS = 1


def norm_name(name):
    text = unicodedata.normalize("NFD", str(name or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    text = re.sub(r"[.'’`]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    parts = [p for p in text.split(" ") if p]
    while len(parts) > 1 and re.match(r"^(jr|sr|ii|iii|iv|v)$", parts[-1]):
        parts.pop()
    return " ".join(parts)


# --------------------------------------------------------------------------- #
# actuals                                                                       #
# --------------------------------------------------------------------------- #

def _num(row, key):
    v = row.get(key)
    if v is None or v == "" or v == "NA":
        return 0.0
    try:
        return float(v)
    except ValueError:
        return 0.0


def ppr_points(row):
    """Actual PPR points for one stats_player_week row."""
    v = row.get("fantasy_points_ppr")
    if v not in (None, "", "NA"):
        return round(float(v), 2)
    return round(
        _num(row, "passing_yards") * 0.04 + _num(row, "passing_tds") * 4.0
        - _num(row, "passing_interceptions") * 2.0
        + _num(row, "rushing_yards") * 0.1 + _num(row, "rushing_tds") * 6.0
        + _num(row, "receptions") + _num(row, "receiving_yards") * 0.1
        + _num(row, "receiving_tds") * 6.0
        - (_num(row, "rushing_fumbles_lost") + _num(row, "receiving_fumbles_lost")
           + _num(row, "sack_fumbles_lost")) * 2.0
        + (_num(row, "passing_2pt_conversions") + _num(row, "rushing_2pt_conversions")
           + _num(row, "receiving_2pt_conversions")) * 2.0, 2)


def index_actuals(csv_rows):
    """{(norm_name, position): {week: pts}}, plus {norm_name: set(positions)} for
    the name-only fallback, plus the set of weeks that carry any rows."""
    by_np, weeks = {}, set()
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
        if pos not in POSITIONS:
            continue
        n = norm_name(r.get("player_display_name") or r.get("player_name"))
        if not n:
            continue
        weeks.add(wk)
        by_np.setdefault((n, pos), {})[wk] = ppr_points(r)
    names = {}
    for (n, pos) in by_np:
        names.setdefault(n, set()).add(pos)
    return by_np, names, weeks


def lookup_actuals(name, position, by_np, names):
    """The player's {week: pts} map, or None when no unique join exists."""
    n = norm_name(name)
    hit = by_np.get((n, position))
    if hit is not None:
        return hit
    poss = names.get(n)
    if poss and len(poss) == 1:
        return by_np.get((n, next(iter(poss))))
    return None


# --------------------------------------------------------------------------- #
# scoring (pure)                                                                #
# --------------------------------------------------------------------------- #

def _block(rows):
    n = len(rows)
    if not n:
        return {"n": 0, "mae_shipped": None, "mae_candidate": None, "mae_gated": None,
                "mae_baseline": None, "bias_shipped": None, "bias_candidate": None,
                "bias_gated": None, "band_coverage": None}
    g = lambda r: float(r.get("gated", r["shipped"]))  # noqa: E731
    return {
        "n": n,
        "mae_shipped": round(sum(abs(r["shipped"] - r["actual"]) for r in rows) / n, 3),
        "mae_candidate": round(sum(abs(r["candidate"] - r["actual"]) for r in rows) / n, 3),
        "mae_gated": round(sum(abs(g(r) - r["actual"]) for r in rows) / n, 3),
        "mae_baseline": round(sum(abs(r["baseline"] - r["actual"]) for r in rows) / n, 3),
        "bias_shipped": round(sum(r["shipped"] - r["actual"] for r in rows) / n, 3),
        "bias_candidate": round(sum(r["candidate"] - r["actual"] for r in rows) / n, 3),
        "bias_gated": round(sum(g(r) - r["actual"] for r in rows) / n, 3),
        "band_coverage": round(sum(1 for r in rows if r["low"] <= r["actual"] <= r["high"])
                               / n, 4),
    }


def score(resolved, weeks_available=None):
    """Metric blocks from resolved rows. Counts are conserved: totals.n == len(rows)
    == sum over positions == sum over weeks."""
    by_pos = {}
    by_week = {}
    for r in resolved:
        by_pos.setdefault(r["position"], []).append(r)
        by_week.setdefault(r["week"], []).append(r)
    weeks = []
    for wk in sorted(set(by_week) | set(weeks_available or [])):
        b = _block(by_week.get(wk, []))
        weeks.append({"week": wk, "rows_available": int((weeks_available or {}).get(wk, 0)),
                      "players_scored": b["n"], "mae_shipped": b["mae_shipped"],
                      "mae_candidate": b["mae_candidate"], "mae_gated": b["mae_gated"],
                      "bias_shipped": b["bias_shipped"],
                      "bias_candidate": b["bias_candidate"], "bias_gated": b["bias_gated"],
                      "band_coverage": b["band_coverage"]})
    return {
        "totals": _block(resolved),
        "by_position": {p: _block(by_pos[p]) for p in sorted(by_pos)},
        "weeks": weeks,
    }


def resolve(ledger, csv_rows):
    """Pure: ledger document + stats rows -> (resolved rows, unmatched ledger
    players [{gsis_id, name, team, position}], weeks_available {week: row count})."""
    by_np, names, weeks_with_rows = index_actuals(csv_rows)
    rows_per_week = {}
    for m in by_np.values():
        for wk in m:
            rows_per_week[wk] = rows_per_week.get(wk, 0) + 1
    resolved, unmatched = [], []
    for pid, p in sorted((ledger.get("players") or {}).items()):
        if not p.get("locked"):
            continue
        actual_map = lookup_actuals(p.get("name"), p.get("position"), by_np, names)
        if actual_map is None:
            unmatched.append({"gsis_id": pid, "name": p.get("name", ""),
                              "team": p.get("team", ""), "position": p.get("position", "")})
            continue
        for key, lk in p["locked"].items():
            wk = int(key)
            if wk not in weeks_with_rows:
                continue       # the week has no stats rows yet: skip, never 0
            dnp = wk not in actual_map
            row = {"gsis_id": pid, "week": wk, "position": p["position"],
                   "baseline": lk["baseline"], "shipped": lk["shipped"],
                   "candidate": lk["candidate"], "low": lk["low"], "high": lk["high"],
                   "gated": float(lk.get("gated", lk["shipped"])),
                   "actual": 0.0 if dnp else actual_map[wk],
                   "signals": dict(lk.get("signals") or {})}
            if dnp:
                row["dnp"] = True
            resolved.append(row)
    return resolved, unmatched, rows_per_week


def document(season, ledger_rel, resolved, unmatched, rows_per_week, skipped,
             generated_utc):
    s = score(resolved, rows_per_week)
    return {
        "season": int(season),
        "generated_utc": generated_utc,
        "source": RELEASE_URL.format(season=season),
        "scoring": SCORING,
        "ledger": ledger_rel,
        "weeks_resolved": len({r["week"] for r in resolved}),
        "players_scored": len({r["gsis_id"] for r in resolved}),
        "rows_resolved": len(resolved),
        "unmatched_players": len(unmatched),
        "unmatched": list(unmatched),
        "skipped": skipped,
        "totals": s["totals"],
        "by_position": s["by_position"],
        "weeks": s["weeks"],
        "resolved": resolved,
    }


def locked_weeks(ledger):
    """The set of weeks any ledger player has a locked (pre-kickoff) estimate for."""
    out = set()
    for p in (ledger.get("players") or {}).values():
        out |= {int(k) for k in (p.get("locked") or {})}
    return out


def explain_nothing_resolved(ledger, rows, rows_per_week, unmatched, season):
    """Why a non-empty CSV resolved nothing, in plain words. Pure."""
    locked = sorted(locked_weeks(ledger))
    with_rows = sorted(rows_per_week)
    if not with_rows:
        return ("stats_player_week_%d.csv has %d rows but none is a regular-season "
                "QB/RB/WR/TE row — nothing to resolve" % (season, len(rows)))
    hit = sorted(set(locked) & set(with_rows))
    if not hit:
        return ("stats_player_week_%d.csv carries week(s) %s only; the locked ledger "
                "week(s) %s have no stats rows yet — nothing resolved, nothing scored"
                % (season, with_rows, locked))
    return ("stats_player_week_%d.csv has rows for locked week(s) %s but no ledger player "
            "joined by name + position (%d ledger players unmatched, listed in "
            "`unmatched`)" % (season, hit, len(unmatched)))


def build_document(ledger, rows, season, ledger_rel, now):
    """THE production resolve + score path, shared by `run` and `--dry-run-with`:
    ledger document + stats rows (a list; None = not fetched) -> the scores
    document, with `skipped` filled honestly whenever nothing resolved. Pure."""
    resolved, unmatched, rows_per_week, skipped = [], [], {}, None
    if not locked_weeks(ledger):
        skipped = ("ledger has no locked (pre-kickoff) player-week yet — the first "
                   "week locks on the first append after its kickoff")
    elif rows is None:
        skipped = "stats not fetched"
    else:
        resolved, unmatched, rows_per_week = resolve(ledger, rows)
        if not resolved:
            skipped = explain_nothing_resolved(ledger, rows, rows_per_week, unmatched, season)
    return document(season, ledger_rel, resolved, unmatched, rows_per_week, skipped, now)


def last_proposal(tuning_history):
    """The latest archived player-signal fit (scripts/fit_player_signals.py
    --propose, kind player_signal_fit) reduced to what the MODEL tab shows; None
    when nothing has been archived. Pure."""
    for h in reversed(list(tuning_history or [])):
        if isinstance(h, dict) and h.get("kind") == "player_signal_fit":
            return {
                "generated_utc": h.get("generated_utc"),
                "verdict": h.get("verdict") or (
                    "refused" if not h.get("folds") else
                    ("propose" if h.get("would_adopt") else "retain")),
                "would_adopt": bool(h.get("would_adopt")),
                "folds": int(h.get("folds") or 0),
                "weeks_resolved": int(h.get("weeks_resolved") or 0),
                "candidate_mae": h.get("candidate_mae"),
                "gated_mae": h.get("gated_mae"),
                "reason": h.get("reason") or "",
            }
    return None


def learning_record(doc, weights, backtest_2025=None, margin_mae=0.10, tuning_history=None):
    """The data/meta.json `learning_record` for the MODEL tab. Null metrics until
    a week has actually resolved — never an invented number. `last_proposal`
    (R53) is the latest archived fit verdict, null until one exists."""
    t = doc["totals"]
    rec = {
        "weeks_resolved": doc["weeks_resolved"],
        "players_scored": doc["players_scored"],
        "mae_ppr": t["mae_shipped"],
        "bias_ppr": t["bias_shipped"],
        "candidate_mae_ppr": t["mae_candidate"],
        "candidate_bias_ppr": t["bias_candidate"],
        "gated_mae_ppr": t["mae_gated"],
        "gated_bias_ppr": t["bias_gated"],
        "band_coverage": t["band_coverage"],
        "signals_with_weight": sorted(k for k, v in (weights or {}).items()
                                      if float(v) != 0.0),
        "ledger": doc["ledger"],
        "objective_ready": doc["weeks_resolved"] >= MIN_RESOLVED_WEEKS,
        "adoption_margin_mae": margin_mae,
        "note": (doc["skipped"] if doc["skipped"] else
                 "shipped, candidate and gated scored on locked pre-kickoff estimates; "
                 "the never-regress comparison is candidate vs gated on the walk-forward "
                 "player objective (scripts/fit_player_signals.py) — shipped == candidate "
                 "under the R49 owner override"),
        "updated_utc": doc["generated_utc"],
        "last_proposal": last_proposal(tuning_history),
    }
    if backtest_2025:
        rec["backtest_2025"] = {
            "baseline_mae": backtest_2025.get("baseline_mae"),
            "candidate_mae": backtest_2025.get("candidate_mae"),
            "gated_mae": backtest_2025.get("gated_mae"),
            "shipped_mae": backtest_2025.get("shipped_mae"),
            "band_coverage": backtest_2025.get("band_coverage"),
            "players": int(backtest_2025.get("players") or 0),
            "sleeper_mae": backtest_2025.get("sleeper_mae"),
            "sleeper_players": backtest_2025.get("sleeper_players"),
            "sleeper_note": backtest_2025.get("sleeper_note") or "",
            "signals_evaluated": list(backtest_2025.get("signals_evaluated") or []),
            "signals_not_evaluable": list(backtest_2025.get("signals_not_evaluable") or []),
        }
    return rec


# --------------------------------------------------------------------------- #
# I/O                                                                           #
# --------------------------------------------------------------------------- #

def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def fetch_csv(season, cache_dir=None):
    """Rows for the season, or (None, reason) when the release has none yet."""
    url = RELEASE_URL.format(season=int(season))
    cached = os.path.join(cache_dir, "stats_player_week_%d.csv" % season) if cache_dir else None
    if cached and os.path.exists(cached):
        with open(cached, encoding="utf-8", newline="") as fh:
            return list(csv.DictReader(fh)), None
    try:
        import requests  # noqa: PLC0415 — runner dependency, guarded
    except ImportError:
        return None, "requests is not installed (the daily runner installs it)"
    try:
        resp = requests.get(url, timeout=_HTTP_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 — a network fault is a skip, not a crash
        return None, "GET %s failed: %s" % (url, exc.__class__.__name__)
    if resp.status_code != 200:
        return None, "GET %s -> HTTP %s (no %d weekly stats published yet)" % (
            url, resp.status_code, season)
    text = resp.content.decode("utf-8", errors="replace")
    if cached:
        os.makedirs(cache_dir, exist_ok=True)
        with open(cached, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
    return list(csv.DictReader(io.StringIO(text))), None


def write(doc, path=OUT_PATH):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def run(season=None, cache_dir=None, out_path=OUT_PATH, meta_path=meta_record.META_PATH,
        now=None, offline=False):
    if season is None:
        season = int(_load(PROJECTIONS_PATH)["season"])
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lpath = ledger_path(season)
    ledger_rel = os.path.relpath(lpath, _ROOT)
    if not os.path.exists(lpath):
        skipped = ("no ledger at %s yet — scripts/build_estimate_ledger.py appends the "
                   "first estimates on the daily run; nothing to resolve" % ledger_rel)
        doc = document(season, ledger_rel, [], [], {}, skipped, now)
    else:
        ledger = _load(lpath)
        rows, why = None, None
        if locked_weeks(ledger):
            if offline:
                why = "offline run: stats not fetched"
            else:
                rows, why = fetch_csv(season, cache_dir)
        doc = build_document(ledger, rows, season, ledger_rel, now)
        if rows is None and why and doc["skipped"] == "stats not fetched":
            doc["skipped"] = why
    write(doc, out_path)
    weights = (_load(meta_path).get("weights") if os.path.exists(meta_path) else {}) or {}
    meta_record.set_record("learning_record",
                           learning_record(doc, weights, _backtest_2025(),
                                           tuning_history=_tuning_history()),
                           path=meta_path)
    _summary(doc)
    return doc


def _tuning_history():
    path = os.path.join(DATA, "model_tuning.json")
    return _load(path).get("history") if os.path.exists(path) else []


def _backtest_2025():
    bt_path = os.path.join(DATA, "player_backtest.json")
    return _load(bt_path).get("candidate_2025") if os.path.exists(bt_path) else None


def _summary(doc):
    if doc["skipped"]:
        print("[resolve_estimates] SKIPPED (0 weeks resolved): %s" % doc["skipped"],
              file=sys.stderr)
    else:
        t = doc["totals"]
        print("resolve_estimates: %d weeks, %d players, %d rows resolved (%d ledger "
              "players unmatched: %s); MAE shipped %.2f candidate %.2f gated %.2f, bias "
              "shipped %+.2f, band coverage %.3f"
              % (doc["weeks_resolved"], doc["players_scored"], doc["rows_resolved"],
                 doc["unmatched_players"],
                 ", ".join(u["name"] for u in doc["unmatched"][:8])
                 + (" ..." if doc["unmatched_players"] > 8 else "") or "none",
                 t["mae_shipped"], t["mae_candidate"], t["mae_gated"], t["bias_shipped"],
                 t["band_coverage"]), file=sys.stderr)


def dry_run(csv_path, ledger_file=None, season=None, now=None):
    """R53: the production path against a CSV on disk; prints the document to
    stdout, writes NOTHING. Returns the document."""
    if season is None:
        season = int(_load(PROJECTIONS_PATH)["season"])
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lpath = ledger_file or ledger_path(season)
    ledger_rel = os.path.relpath(lpath, _ROOT) if not ledger_file else lpath
    with open(csv_path, encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    doc = build_document(_load(lpath), rows, season, ledger_rel, now)
    print("[resolve_estimates] DRY RUN against %s (%d csv rows, ledger %s) — nothing written"
          % (csv_path, len(rows), lpath), file=sys.stderr)
    _summary(doc)
    json.dump(doc, sys.stdout, ensure_ascii=True, indent=2, sort_keys=False)
    sys.stdout.write("\n")
    return doc


# --------------------------------------------------------------------------- #
# selftest                                                                      #
# --------------------------------------------------------------------------- #

def _fixture_ledger():
    def lk(sh, ca, lo, hi):
        return {"as_of_utc": "2026-09-05T06:00:00Z", "baseline": sh, "shipped": sh,
                "candidate": ca, "low": lo, "high": hi, "gated": sh - 1.0,
                "signals": {"age_curve": 1.05}}
    return {"season": 2026, "players": {
        "espn-1": {"name": "A.J. Back", "team": "SF", "position": "RB",
                   "locked": {"1": lk(10.0, 12.0, 8.0, 16.0), "2": lk(10.0, 12.0, 8.0, 16.0)}},
        "espn-2": {"name": "Some Receiver", "team": "DAL", "position": "WR",
                   "locked": {"1": lk(8.0, 9.0, 6.0, 12.0)}},
        "espn-3": {"name": "Never Joins", "team": "NE", "position": "TE",
                   "locked": {"1": lk(5.0, 5.0, 3.0, 7.0)}},
        "espn-4": {"name": "Unlocked Guy", "team": "NE", "position": "QB", "locked": {}},
    }}


def selftest():
    ledger = _fixture_ledger()
    rows = [
        {"season_type": "REG", "week": "1", "position": "RB", "player_display_name": "AJ Back",
         "fantasy_points_ppr": "14.0"},
        {"season_type": "REG", "week": "1", "position": "WR",
         "player_display_name": "Some Receiver", "receptions": "5", "receiving_yards": "50",
         "receiving_tds": "1"},                                   # formula path: 5+5+6=16
        {"season_type": "REG", "week": "1", "position": "QB", "player_display_name": "Other QB",
         "fantasy_points_ppr": "20"},
        {"season_type": "POST", "week": "1", "position": "TE",
         "player_display_name": "Never Joins", "fantasy_points_ppr": "99"},   # ignored
    ]
    assert ppr_points(rows[1]) == 16.0
    resolved, unmatched, per_week = resolve(ledger, rows)
    assert [u["name"] for u in unmatched] == ["Never Joins"], \
        "Never Joins (REG rows only) must be unmatched BY NAME, not scored 0"
    assert {(r["gsis_id"], r["week"]) for r in resolved} == {("espn-1", 1), ("espn-2", 1)}, \
        "week 2 has no rows -> skipped loudly, not scored"
    assert per_week == {1: 3}
    doc = document(2026, "data/estimates/2026.json", resolved, unmatched, per_week, None,
                   "2026-09-15T00:00:00Z")
    assert doc["weeks_resolved"] == 1 and doc["players_scored"] == 2
    assert doc["unmatched_players"] == 1 and doc["unmatched"][0]["gsis_id"] == "espn-3"
    t = doc["totals"]
    assert t["n"] == 2 == sum(b["n"] for b in doc["by_position"].values()) \
        == sum(w["players_scored"] for w in doc["weeks"]), "counts conserve"
    assert abs(t["mae_shipped"] - ((14 - 10) + (16 - 8)) / 2) < 1e-9
    assert abs(t["mae_candidate"] - ((14 - 12) + (16 - 9)) / 2) < 1e-9
    assert abs(t["bias_shipped"] + 6.0) < 1e-9, "bias = mean(estimate - actual)"
    assert abs(t["mae_gated"] - 7.0) < 1e-9 and abs(t["bias_gated"] + 7.0) < 1e-9, \
        "the gated series is scored as its own third series"
    assert t["band_coverage"] == 0.5
    # a joined player with no row in a resolved week did not play -> 0.0, flagged
    rows2 = rows + [{"season_type": "REG", "week": "2", "position": "WR",
                     "player_display_name": "Some Receiver", "fantasy_points_ppr": "3"}]
    resolved2, _, _ = resolve(ledger, rows2)
    r = next(x for x in resolved2 if x["gsis_id"] == "espn-1" and x["week"] == 2)
    assert r["actual"] == 0.0 and r["dnp"] is True
    # the shared production path explains WHY nothing resolved
    other = build_document(ledger, [dict(rows[0], week="3")], 2026, "x", "t")
    assert other["weeks_resolved"] == 0 and "week(s) [3] only" in other["skipped"] \
        and "[1, 2]" in other["skipped"], other["skipped"]
    nojoin = build_document(ledger, [dict(rows[2])], 2026, "x", "t")
    assert "no ledger player joined" in nojoin["skipped"] and \
        len(nojoin["unmatched"]) == 3, nojoin["skipped"]
    assert build_document({"players": {}}, rows, 2026, "x", "t")["skipped"].startswith(
        "ledger has no locked")
    assert build_document(ledger, None, 2026, "x", "t")["skipped"] == "stats not fetched"
    assert build_document(ledger, rows, 2026, "x", "t")["totals"] == doc["totals"], \
        "the dry-run path IS the production path"
    # nothing resolved -> honest empty document with null metrics
    empty = document(2026, "x", [], [], {}, "no rows", "2026-09-01T00:00:00Z")
    assert empty["weeks_resolved"] == 0 and empty["totals"]["mae_shipped"] is None \
        and empty["totals"]["mae_gated"] is None
    rec = learning_record(empty, {"age_curve": 0.0})
    assert rec["mae_ppr"] is None and rec["gated_mae_ppr"] is None \
        and rec["objective_ready"] is False and rec["signals_with_weight"] == []
    rec2 = learning_record(doc, {"age_curve": 0.25})
    assert rec2["objective_ready"] is True and rec2["signals_with_weight"] == ["age_curve"]
    assert rec["last_proposal"] is None and rec2["last_proposal"] is None
    hist = [{"kind": "game_params"}, {"kind": "player_signal_fit", "folds": 0,
                                      "would_adopt": False, "verdict": "refused",
                                      "reason": "needs >= 2", "generated_utc": "t"},
            {"kind": "game_params"}]
    lp = learning_record(doc, {}, tuning_history=hist)["last_proposal"]
    assert lp["verdict"] == "refused" and lp["reason"] == "needs >= 2" and lp["folds"] == 0
    assert last_proposal([{"kind": "player_signal_fit", "folds": 1, "would_adopt": True}])["verdict"] == "propose"
    print("selftest OK: name+position join, REG-only, skip-when-no-rows, dnp=0 by fact, "
          "unmatched listed by name and never scored, skip reasons name the weeks, "
          "counts conserve, null metrics at 0 resolved")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--offline", action="store_true", help="never fetch; write the honest skip")
    ap.add_argument("--dry-run-with", metavar="CSV", default=None,
                    help="R53: run the production resolve+score path against this stats "
                         "CSV and print the document; writes nothing")
    ap.add_argument("--ledger", default=None,
                    help="with --dry-run-with: a ledger file other than data/estimates/"
                         "<season>.json (tests lock a week on a copy)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    if args.dry_run_with:
        dry_run(args.dry_run_with, ledger_file=args.ledger, season=args.season)
        return 0
    if args.ledger:
        ap.error("--ledger is only valid with --dry-run-with")
    run(season=args.season, cache_dir=args.cache_dir, offline=args.offline)
    return 0


if __name__ == "__main__":
    sys.exit(main())
