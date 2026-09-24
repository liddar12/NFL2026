"""R99 E1 — anytime-TD (ATD) model, measured walk-forward (MEASURE ONLY).

The owner bets mostly anytime-TD parlays; the app had no ATD market. Before any
ATD leg is priced (E1-S5) the model has to beat two baselines on held-out
seasons. This script is that measurement; it writes data/atd_backtest.json and
nothing else, and no live number reads it except the `adopted` gate.

Model, for a player on team T facing opponent O in week w of season s:
  lambda_team = L * (off_T / L) * (def_O / L) * home_factor        (S2)
      L       league rushing+receiving TDs per team-game,
      off_T   T's TDs per game, def_O  O's TDs allowed per game — both shrunk
              toward L by K_TEAM games; home_factor from the same history.
  share       the player's share of his team's TDs                  (S3)
      = (his TDs + K_SHARE * opp_share) / (his teams' TDs + K_SHARE), over the
      games he played; opp_share = his expected TDs from carries and targets
      at league per-carry / per-target TD rates over his teams' same total.
      A player with no history takes the prior of players at his position who
      had none either. R92 depth cascade: the share of a player who played for
      T in the last CASCADE_WEEKS weeks and is not active this week moves to
      the ACTIVE players at his position, pro rata; team shares sum to <= 1.
  P(ATD)      = 1 - exp(-lambda_team * share)                       (S4)

History = every earlier week of season s (weight 1) plus season s-1 (weight
PREV_W). Nothing from week w or later is read (tests plant a future row).

Baselines (AC1): the position's walk-forward ATD rate, and opportunity-only
share at the league-average lambda. ADOPTED (AC2) only if the model beats BOTH
on log loss AND Brier in EVERY held-out season, with a calibration slope inside
[0.9, 1.1] in every one; otherwise the verdict names the failing condition (AC3).
Hyper-parameters were chosen on the WARM-UP season (2022) alone and are fixed
here; the held-out seasons never chose them.

Universe = a player-week at QB/RB/WR/TE who took an offensive snap (nflverse
snap counts, pfr ids mapped to gsis through the season rosters) or recorded a
carry, target or TD. Using only stat rows would leak the outcome: every TD
needs a carry or a target, so a player with a stat row is already more likely
to have scored.

Sources (nflverse release CSVs): stats_player/stats_player_week_{season}.csv,
snap_counts/snap_counts_{season}.csv, rosters/roster_{season}.csv. Every fetch
is loud; a season with zero rows raises (never an empty season).

  python scripts/backtest_atd.py                  # runner: fetch, measure, write
  python scripts/backtest_atd.py --cache DIR      # reuse CSVs saved in DIR
  python scripts/backtest_atd.py --selftest       # offline
Stdlib only apart from the optional requests (via the corpus builder).
"""

import argparse
import csv
import io
import json
import math
import os
import sys
import tempfile
from datetime import datetime, timezone

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import build_weekly as bw                         # noqa: E402
from scripts.build_backtest_weekly_corpus import (             # noqa: E402
    CorpusError, fetch_stats, fetch_text, _num, _int, _resolve_columns, RELEASE_BASE)

OUT_PATH = os.path.join(_ROOT, "data", "atd_backtest.json")
SNAPS_URL = RELEASE_BASE + "/snap_counts/snap_counts_{season}.csv"
ROSTER_URL = RELEASE_BASE + "/rosters/roster_{season}.csv"

SKILL = ("QB", "RB", "WR", "TE")
SNAP_POS = {"QB": "QB", "RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR", "TE": "TE"}
WARMUP_SEASON = 2022          # hyper-parameters were chosen on this season only
HELD_OUT = (2023, 2024, 2025)
DEFAULT_SEASONS = (2021,) + (WARMUP_SEASON,) + HELD_OUT   # 2021 = first history

# Chosen on 2022 alone (the grid and its scores are in the output document).
PARAMS = {"prev_w": 0.5, "k_team": 8.0, "k_share": 80.0, "k_opp": 1.0, "cascade_weeks": 3}
SLOPE_BAND = (0.9, 1.1)
TEAM_TD_BAND = (0.95, 1.05)   # S2 AC2: mean lambda / mean realised team TDs,
TEAM_TD_SEASONS = (2024, 2025)  # pooled over these held-out seasons (as approved)
P_FLOOR, P_CEIL = 0.001, 0.95

TD_COLUMNS = {
    "pid": ("player_id",),
    "name": ("player_display_name", "player_name"),
    "pos": ("position",),
    "team": ("team", "recent_team"),
    "opp": ("opponent_team",),
    "week": ("week",),
    "season": ("season",),
    "season_type": ("season_type",),
    "game_id": ("game_id",),
    "carries": ("carries",),
    "targets": ("targets",),
    "rush_tds": ("rushing_tds",),
    "rec_tds": ("receiving_tds",),
}
SNAP_COLUMNS = {"season": ("season",), "game_type": ("game_type",), "week": ("week",),
                "pfr": ("pfr_player_id",), "pos": ("position",), "team": ("team",),
                "snaps": ("offense_snaps",)}
TD_FIELDS = ["carries", "targets", "rush_tds", "rec_tds"]


# ---------------------------------------------------------------------------
# S1 — corpus (pure)
# ---------------------------------------------------------------------------

def _home_of(game_id, team):
    """True/False from nflverse game_id '{season}_{wk}_{away}_{home}'; None if unknown."""
    parts = (game_id or "").strip().split("_")
    if len(parts) != 4 or not team:
        return None
    away, home = bw.norm_team(parts[2]), bw.norm_team(parts[3])
    if team == home:
        return True
    if team == away:
        return False
    return None


def parse_td_stats(text, season):
    """(rows, team_games, stats) for one season's stats_player_week CSV.

    rows: REG player-weeks kept when the player is QB/RB/WR/TE or recorded any
    carry, target or rushing/receiving TD — each {season, week, pid, name, pos,
    team, opp, home, carries, targets, rush_tds, rec_tds}; a blank cell stays
    None (absent, not zero). team_games: {(season, week, team): {opp, home,
    tds, carries, targets}} summed over every REG row of the team, so a team's
    TDs equal the sum of its kept rows' TDs exactly (AC3). Raises on 0 rows."""
    reader = csv.DictReader(io.StringIO(text))
    cols = _resolve_columns(reader.fieldnames or [], TD_COLUMNS)
    stats = {"rows": 0, "kept_rows": 0, "not_reg": 0, "other_season": 0,
             "no_offense": 0, "duplicate_player_week": 0}
    rows, seen, team_games = [], set(), {}
    for raw in reader:
        stats["rows"] += 1
        if (raw.get(cols["season_type"]) or "").strip().upper() != "REG":
            stats["not_reg"] += 1
            continue
        if _int(raw.get(cols["season"])) != int(season):
            stats["other_season"] += 1
            continue
        wk = _int(raw.get(cols["week"]))
        pid = (raw.get(cols["pid"]) or "").strip()
        if wk is None or not pid:
            stats["other_season"] += 1
            continue
        vals = {f: _num(raw.get(cols[f])) for f in TD_FIELDS}
        for f in ("rush_tds", "rec_tds"):
            if vals[f] is not None:
                vals[f] = int(round(vals[f]))
        pos = (raw.get(cols["pos"]) or "").strip().upper()
        offense = any((vals[f] or 0) > 0 for f in TD_FIELDS)
        if pos not in SKILL and not offense:
            stats["no_offense"] += 1
            continue
        if (pid, wk) in seen:
            stats["duplicate_player_week"] += 1
            continue
        seen.add((pid, wk))
        team = bw.norm_team((raw.get(cols["team"]) or "").strip()) or None
        opp = bw.norm_team((raw.get(cols["opp"]) or "").strip()) or None
        home = _home_of(raw.get(cols["game_id"]), team)
        row = {"season": int(season), "week": wk, "pid": pid,
               "name": (raw.get(cols["name"]) or "").strip(), "pos": pos,
               "team": team, "opp": opp, "home": home}
        row.update(vals)
        rows.append(row)
        g = team_games.setdefault((int(season), wk, team),
                                  {"opp": opp, "home": home, "tds": 0, "carries": 0.0,
                                   "targets": 0.0})
        g["tds"] += (row["rush_tds"] or 0) + (row["rec_tds"] or 0)
        g["carries"] += row["carries"] or 0.0
        g["targets"] += row["targets"] or 0.0
        stats["kept_rows"] += 1
    if not rows:
        raise CorpusError("stats_player_week_%d produced 0 REG offence rows — refusing "
                          "to measure an empty season" % int(season))
    return rows, team_games, stats


def pfr_to_gsis(roster_texts):
    """{pfr_id: gsis_id} from nflverse season roster CSVs."""
    out = {}
    for text in roster_texts:
        for raw in csv.DictReader(io.StringIO(text)):
            pfr, gsis = (raw.get("pfr_id") or "").strip(), (raw.get("gsis_id") or "").strip()
            if pfr and gsis:
                out[pfr] = gsis
    return out


def parse_snaps(text, season, pfr_map):
    """({(season, week, gsis): (team, pos)} for REG skill players with >= 1
    offensive snap, stats). Unmapped pfr ids are counted, never guessed."""
    reader = csv.DictReader(io.StringIO(text))
    cols = _resolve_columns(reader.fieldnames or [], SNAP_COLUMNS)
    out, stats = {}, {"rows": 0, "kept": 0, "unmapped": 0}
    for raw in reader:
        stats["rows"] += 1
        if (raw.get(cols["game_type"]) or "").strip().upper() != "REG":
            continue
        if _int(raw.get(cols["season"])) != int(season):
            continue
        pos = SNAP_POS.get((raw.get(cols["pos"]) or "").strip().upper())
        if pos is None or (_num(raw.get(cols["snaps"])) or 0) < 1:
            continue
        gsis = pfr_map.get((raw.get(cols["pfr"]) or "").strip())
        if not gsis:
            stats["unmapped"] += 1
            continue
        out[(int(season), _int(raw.get(cols["week"])), gsis)] = (
            bw.norm_team((raw.get(cols["team"]) or "").strip()), pos)
        stats["kept"] += 1
    return out, stats


def build_universe(rows, snaps):
    """{(season, week, pid): record} — every player-week that counts as played.
    A stat row wins for team/opp/home and the counts; a snap-only player-week
    enters with zero counts and the team game's opponent."""
    uni = {}
    for r in rows:
        if r["pos"] in SKILL or (r["carries"] or 0) + (r["targets"] or 0) > 0 \
                or (r["rush_tds"] or 0) + (r["rec_tds"] or 0) > 0:
            pos = r["pos"] if r["pos"] in SKILL else None
            uni[(r["season"], r["week"], r["pid"])] = dict(r, pos=pos)
    for (season, week, pid), (team, pos) in snaps.items():
        key = (season, week, pid)
        if key in uni:
            if uni[key]["pos"] is None:
                uni[key]["pos"] = pos
            continue
        uni[key] = {"season": season, "week": week, "pid": pid, "name": "", "pos": pos,
                    "team": team, "opp": None, "home": None, "carries": 0.0,
                    "targets": 0.0, "rush_tds": 0, "rec_tds": 0}
    return {k: v for k, v in uni.items() if v["pos"] in SKILL}


# ---------------------------------------------------------------------------
# S2–S4 — walk-forward model (pure)
# ---------------------------------------------------------------------------

def _tds(r):
    return (r["rush_tds"] or 0) + (r["rec_tds"] or 0)


def _p(lam_share):
    return min(P_CEIL, max(P_FLOOR, 1.0 - math.exp(-lam_share)))


class _History:
    """Additive aggregates over a weighted set of weeks."""

    def __init__(self):
        self.lg = [0.0, 0.0]                  # sum w*tds, sum w (team-games)
        self.home = {True: [0.0, 0.0], False: [0.0, 0.0]}
        self.rates = [0.0, 0.0, 0.0, 0.0]     # w*rush_tds, w*carries, w*rec_tds, w*targets
        self.off, self.dfn = {}, {}           # team -> [w*tds, w]
        self.player = {}                      # pid -> [w, w*ptd, w*team_tds, w*c, w*t, w*team_c, w*team_t]
        self.pos_rate = {}                    # pos -> [w*scored, w]
        self.new_share = {}                   # pos -> [w*ptd, w*team_tds] (first appearances)

    def add_week(self, uni_week, team_games_week, wt):
        for team, g in team_games_week.items():
            self.lg[0] += wt * g["tds"]
            self.lg[1] += wt
            if g["home"] is not None:
                h = self.home[g["home"]]
                h[0] += wt * g["tds"]
                h[1] += wt
            o = self.off.setdefault(team, [0.0, 0.0])
            o[0] += wt * g["tds"]
            o[1] += wt
            if g["opp"]:
                d = self.dfn.setdefault(g["opp"], [0.0, 0.0])
                d[0] += wt * g["tds"]
                d[1] += wt
        for r in uni_week:
            g = team_games_week.get(r["team"])
            if g is None:
                continue
            self.rates[0] += wt * (r["rush_tds"] or 0)
            self.rates[1] += wt * (r["carries"] or 0)
            self.rates[2] += wt * (r["rec_tds"] or 0)
            self.rates[3] += wt * (r["targets"] or 0)
            pr = self.pos_rate.setdefault(r["pos"], [0.0, 0.0])
            pr[0] += wt * (1 if _tds(r) > 0 else 0)
            pr[1] += wt
            if r["pid"] not in self.player:
                ns = self.new_share.setdefault(r["pos"], [0.0, 0.0])
                ns[0] += wt * _tds(r)
                ns[1] += wt * g["tds"]
            a = self.player.setdefault(r["pid"], [0.0] * 7)
            a[0] += wt
            a[1] += wt * _tds(r)
            a[2] += wt * g["tds"]
            a[3] += wt * (r["carries"] or 0)
            a[4] += wt * (r["targets"] or 0)
            a[5] += wt * g["carries"]
            a[6] += wt * g["targets"]


def _index(universe, team_games):
    """({(season, week): [universe rows]}, {(season, week): {team: game}})."""
    by_week, tg_week = {}, {}
    for r in universe.values():
        by_week.setdefault((r["season"], r["week"]), []).append(r)
    for (season, week, team), g in team_games.items():
        tg_week.setdefault((season, week), {})[team] = g
    return by_week, tg_week


def _history_for(season, week, by_week, tg_week, prev_w):
    """History over season-1 (weight prev_w) and weeks < week of season.
    Re-added every week from scratch — O(weeks^2), fast enough for 5 seasons."""
    h = _History()
    for (s, w) in sorted(tg_week):
        if s == season - 1 and prev_w > 0:
            h.add_week(by_week.get((s, w), []), tg_week[(s, w)], prev_w)
        elif s == season and w < week:
            h.add_week(by_week.get((s, w), []), tg_week[(s, w)], 1.0)
    return h


def base_share(h, pid, pos, params=PARAMS):
    """(share, opp_share, has_history) before the cascade and the team cap.

    No history: the prior of players at this position who had none either
    (AC3). Otherwise the opportunity share (carries/targets at league per-carry
    and per-target TD rates, shrunk toward that prior by k_opp games), and the
    TD share shrunk toward it by k_share team TDs."""
    ns = h.new_share.get(pos, [0.0, 0.0])
    prior = ns[0] / ns[1] if ns[1] > 0 else 0.0
    a = h.player.get(pid)
    if not a or a[0] <= 0:
        return prior, prior, False
    rc = h.rates[0] / h.rates[1] if h.rates[1] > 0 else 0.0
    rt = h.rates[2] / h.rates[3] if h.rates[3] > 0 else 0.0
    k_share, k_opp = params["k_share"], params.get("k_opp", 0.0)
    team_x = rc * a[5] + rt * a[6]
    raw_opp = (rc * a[3] + rt * a[4]) / team_x if team_x > 0 else 0.0
    opp_share = (a[0] * raw_opp + k_opp * prior) / (a[0] + k_opp)
    td_share = (a[1] + k_share * opp_share) / (a[2] + k_share)
    return td_share, opp_share, True


def predict_week(season, week, by_week, tg_week, params=PARAMS, history=None):
    """[{pid, pos, team, p_model, p_base, p_opp, share, lam, y}] for every
    universe row of (season, week), from history strictly before it."""
    h = history or _history_for(season, week, by_week, tg_week, params["prev_w"])
    if h.lg[1] <= 0:
        return []
    L = h.lg[0] / h.lg[1]
    home_f = {k: (v[0] / v[1]) / L if v[1] > 0 else 1.0 for k, v in h.home.items()}
    k_team = params["k_team"]
    tgw = tg_week.get((season, week), {})
    rows = by_week.get((season, week), [])

    def shares_for(r):
        return base_share(h, r["pid"], r["pos"], params)

    # R92 cascade: who played for each team recently but is not active now.
    recent = {}
    for back in range(1, params["cascade_weeks"] + 1):
        for r in by_week.get((season, week - back), []):
            recent.setdefault(r["team"], {}).setdefault(r["pid"], r["pos"])
    active = {}
    for r in rows:
        active.setdefault(r["team"], set()).add(r["pid"])
    shares = {r["pid"]: shares_for(r) for r in rows}
    out_mass = {}
    for team, players in recent.items():
        for pid, pos in players.items():
            if pid in active.get(team, set()):
                continue
            share = shares_for({"pid": pid, "pos": pos})[0]
            out_mass[(team, pos)] = out_mass.get((team, pos), 0.0) + share
    pos_active = {}
    for r in rows:
        pos_active.setdefault((r["team"], r["pos"]), 0.0)
        pos_active[(r["team"], r["pos"])] += shares[r["pid"]][0]
    final = {}
    for r in rows:
        base = shares[r["pid"]][0]
        denom = pos_active.get((r["team"], r["pos"]), 0.0)
        extra = out_mass.get((r["team"], r["pos"]), 0.0) * (base / denom) if denom > 0 else 0.0
        final[r["pid"]] = base + extra
    team_sum = {}
    for r in rows:
        team_sum[r["team"]] = team_sum.get(r["team"], 0.0) + final[r["pid"]]
    preds = []
    for r in rows:
        g = tgw.get(r["team"]) or {}
        opp = r["opp"] or g.get("opp")
        home = r["home"] if r["home"] is not None else g.get("home")
        o = h.off.get(r["team"], [0.0, 0.0])
        d = h.dfn.get(opp, [0.0, 0.0])
        off = (o[0] + k_team * L) / (o[1] + k_team)
        dfn = (d[0] + k_team * L) / (d[1] + k_team)
        lam = L * (off / L) * (dfn / L) * (home_f.get(home, 1.0) if home is not None else 1.0)
        share = final[r["pid"]]
        if team_sum.get(r["team"], 0.0) > 1.0:
            share /= team_sum[r["team"]]
        pr = h.pos_rate.get(r["pos"], [0.0, 0.0])
        p_base = pr[0] / pr[1] if pr[1] > 0 else 0.18
        preds.append({"pid": r["pid"], "pos": r["pos"], "team": r["team"], "week": week,
                      "team_tds": g.get("tds"),
                      "p_model": _p(lam * share), "p_base": min(P_CEIL, max(P_FLOOR, p_base)),
                      "p_opp": _p(L * shares[r["pid"]][1]), "share": share, "lam": lam,
                      "y": 1 if _tds(r) > 0 else 0})
    return preds


def walk_forward(universe, team_games, seasons, params=PARAMS):
    """{season: [prediction rows]} for each season in `seasons` (each needs its
    previous season in the corpus as history)."""
    by_week, tg_week = _index(universe, team_games)
    out = {}
    for season in seasons:
        weeks = sorted(w for (s, w) in tg_week if s == season)
        rows = []
        for week in weeks:
            rows.extend(predict_week(season, week, by_week, tg_week, params))
        out[season] = rows
    return out


# ---------------------------------------------------------------------------
# Metrics and the verdict
# ---------------------------------------------------------------------------

def _logit(p):
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def calibration(ps, ys):
    """(intercept, slope) of logistic regression of y on logit(p), Newton."""
    a, b = 0.0, 1.0
    xs = [_logit(p) for p in ps]
    for _ in range(50):
        g0 = g1 = h00 = h01 = h11 = 0.0
        for x, y in zip(xs, ys):
            q = 1.0 / (1.0 + math.exp(-(a + b * x)))
            d, w = y - q, q * (1 - q)
            g0 += d
            g1 += d * x
            h00 += w
            h01 += w * x
            h11 += w * x * x
        det = h00 * h11 - h01 * h01
        if det <= 0:
            break
        da, db = (h11 * g0 - h01 * g1) / det, (-h01 * g0 + h00 * g1) / det
        a, b = a + da, b + db
        if abs(da) + abs(db) < 1e-10:
            break
    return a, b


def score(ps, ys):
    n = len(ys)
    if n == 0:
        return None
    ll = -sum(y * math.log(p) + (1 - y) * math.log(1 - p) for p, y in zip(ps, ys)) / n
    br = sum((p - y) ** 2 for p, y in zip(ps, ys)) / n
    a, b = calibration(ps, ys)
    return {"n": n, "log_loss": round(ll, 5), "brier": round(br, 5),
            "calibration_intercept": round(a, 4), "calibration_slope": round(b, 4),
            "mean_p": round(sum(ps) / n, 4), "hit_rate": round(sum(ys) / n, 4)}


def reliability(ps, ys, bins=(0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 1.01)):
    out, lo = [], 0.0
    for hi in bins:
        sel = [(p, y) for p, y in zip(ps, ys) if lo <= p < hi]
        if sel:
            out.append({"p_from": lo, "p_to": min(hi, 1.0), "n": len(sel),
                        "mean_p": round(sum(p for p, _ in sel) / len(sel), 4),
                        "hit_rate": round(sum(y for _, y in sel) / len(sel), 4)})
        lo = hi
    return out


def season_report(rows):
    ys = [r["y"] for r in rows]
    rep = {k: score([r[col] for r in rows], ys)
           for k, col in (("model", "p_model"), ("position_base_rate", "p_base"),
                          ("opportunity_only", "p_opp"))}
    rep["by_position"] = {pos: score([r["p_model"] for r in rows if r["pos"] == pos],
                                     [r["y"] for r in rows if r["pos"] == pos])
                          for pos in SKILL if any(r["pos"] == pos for r in rows)}
    rep["reliability"] = reliability([r["p_model"] for r in rows], ys)
    rep["team_td"] = team_td_report(rows)
    return rep


def team_td_report(rows):
    """S2 AC2: mean predicted lambda_team vs mean realised team TDs, one per
    team-game (every player row of a team-game carries the same lambda)."""
    games = {}
    for r in rows:
        if r.get("team_tds") is not None:
            games.setdefault((r["week"], r["team"]), (r["lam"], r["team_tds"]))
    if not games:
        return None
    lam = sum(v[0] for v in games.values()) / len(games)
    act = sum(v[1] for v in games.values()) / len(games)
    return {"team_games": len(games), "mean_lambda": round(lam, 4),
            "mean_realised": round(act, 4),
            "ratio": round(lam / act, 4) if act > 0 else None}


def pooled_team_td(reports, seasons=TEAM_TD_SEASONS):
    """S2 AC2 as approved: mean predicted vs mean realised team TDs pooled over
    the held-out 2024-25 team-games (per-season ratios stay in each report)."""
    n = lam = act = 0.0
    for season in seasons:
        t = (reports.get(str(season)) or {}).get("team_td")
        if not t:
            return None
        n += t["team_games"]
        lam += t["mean_lambda"] * t["team_games"]
        act += t["mean_realised"] * t["team_games"]
    if n <= 0 or act <= 0:
        return None
    return {"seasons": list(seasons), "team_games": int(n), "mean_lambda": round(lam / n, 4),
            "mean_realised": round(act / n, 4), "ratio": round(lam / act, 4)}


def verdict(reports, held_out=HELD_OUT, band=SLOPE_BAND):
    """(adopted, text). Adopted only when the model beats BOTH baselines on log
    loss AND Brier in EVERY held-out season and every slope is inside `band`."""
    fails = []
    for season in held_out:
        rep = reports.get(str(season))
        if not rep or not rep.get("model"):
            fails.append("%d: not measured" % season)
            continue
        m = rep["model"]
        for base in ("position_base_rate", "opportunity_only"):
            b = rep[base]
            for metric in ("log_loss", "brier"):
                if not m[metric] < b[metric]:
                    fails.append("%d: %s %s %.5f is not better than %s %.5f"
                                 % (season, "model", metric, m[metric], base, b[metric]))
        s = m["calibration_slope"]
        if not band[0] <= s <= band[1]:
            fails.append("%d: calibration slope %.3f outside [%.1f, %.1f]"
                         % (season, s, band[0], band[1]))
    pooled = pooled_team_td(reports)
    ratio = pooled["ratio"] if pooled else None
    if ratio is None or not TEAM_TD_BAND[0] <= ratio <= TEAM_TD_BAND[1]:
        fails.append("team TDs %s: mean lambda / mean realised %s outside [%.2f, %.2f]"
                     % ("-".join(str(s) for s in TEAM_TD_SEASONS), ratio,
                        TEAM_TD_BAND[0], TEAM_TD_BAND[1]))
    if fails:
        return False, "NOT ADOPTED — " + "; ".join(fails)
    return True, ("ADOPTED — beats the position base rate and opportunity-only share on "
                  "log loss and Brier in every held-out season (%s), calibration slope "
                  "inside [%.1f, %.1f] in each; team TDs within 5%% over 2024-25" % (", ".join(str(s) for s in held_out),
                                                   band[0], band[1]))


def document(reports, corpus_stats, now=None, params=PARAMS, held_out=HELD_OUT):
    adopted, text = verdict(reports, held_out)
    return {
        "generated_utc": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "kind": "atd_backtest",
        "policy": ("MEASURE ONLY (R99 E1). P(anytime TD) = 1 - exp(-lambda_team * share), "
                   "walk-forward. No ATD leg is offered while adopted is false. No book "
                   "price is an input."),
        "model": ("lambda_team = league TDs/game x shrunk offence rate x shrunk opponent "
                  "TDs-allowed rate x home factor; share = TD share shrunk toward "
                  "carries/targets opportunity share, R92 depth cascade, team sum <= 1"),
        "params": dict(params),
        "warmup_season": WARMUP_SEASON,
        "held_out_seasons": list(held_out),
        "slope_band": list(SLOPE_BAND),
        "team_td_band": list(TEAM_TD_BAND),
        "team_td_pooled": pooled_team_td(reports),
        "adopted": adopted,
        "verdict": text,
        "corpus": corpus_stats,
        "seasons": reports,
    }


def write_json(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Fetch + run
# ---------------------------------------------------------------------------

def _cached(cache, name, fetch):
    if cache:
        path = os.path.join(cache, name)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            with open(path, encoding="utf-8") as fh:
                return fh.read()
    text = fetch()
    if cache:
        os.makedirs(cache, exist_ok=True)
        with open(os.path.join(cache, name), "w", encoding="utf-8") as fh:
            fh.write(text)
    return text


def load_corpus(seasons, cache=None):
    """(universe, team_games, corpus_stats) fetched (or read from cache)."""
    rows, team_games, cstats = [], {}, {}
    roster_texts, snap_texts = [], {}
    for season in seasons:
        text = _cached(cache, "stats_player_week_%d.csv" % season, lambda s=season: fetch_stats(s))
        r, tg, st = parse_td_stats(text, season)
        rows.extend(r)
        team_games.update(tg)
        roster_texts.append(_cached(cache, "roster_%d.csv" % season,
                                    lambda s=season: fetch_text(ROSTER_URL.format(season=s))))
        snap_texts[season] = _cached(cache, "snap_counts_%d.csv" % season,
                                     lambda s=season: fetch_text(SNAPS_URL.format(season=s)))
        cstats[str(season)] = {"stats": st, "team_games": len(tg)}
    pmap = pfr_to_gsis(roster_texts)
    snaps = {}
    for season, text in snap_texts.items():
        sn, sst = parse_snaps(text, season, pmap)
        if not sn:
            raise CorpusError("snap_counts_%d produced 0 skill player-weeks" % season)
        snaps.update(sn)
        cstats[str(season)]["snaps"] = sst
    universe = build_universe(rows, snaps)
    for season in seasons:
        cstats[str(season)]["universe"] = sum(1 for k in universe if k[0] == season)
    return universe, team_games, cstats


def run(seasons=DEFAULT_SEASONS, cache=None, out=OUT_PATH, now=None):
    universe, team_games, cstats = load_corpus(seasons, cache)
    scored = [s for s in seasons if s - 1 in seasons]
    preds = walk_forward(universe, team_games, scored)
    reports = {str(s): season_report(rows) for s, rows in preds.items() if rows}
    doc = document(reports, cstats, now)
    write_json(out, doc)
    return doc


# ---------------------------------------------------------------------------
# selftest — offline
# ---------------------------------------------------------------------------

_SELF_STATS = """player_id,player_display_name,position,team,opponent_team,season,week,season_type,game_id,carries,targets,rushing_tds,receiving_tds
a,Back A,RB,AAA,BBB,2024,1,REG,2024_01_BBB_AAA,20,3,1,0
b,Wide B,WR,AAA,BBB,2024,1,REG,2024_01_BBB_AAA,0,9,,1
c,Back C,RB,BBB,AAA,2024,1,REG,2024_01_BBB_AAA,15,2,0,0
d,Line D,DE,BBB,AAA,2024,1,REG,2024_01_BBB_AAA,,,0,1
e,Kick E,K,BBB,AAA,2024,1,REG,2024_01_BBB_AAA,,,,
a,Back A,RB,AAA,BBB,2024,19,POST,2024_19_BBB_AAA,20,3,1,0
"""


def selftest():
    rows, tg, st = parse_td_stats(_SELF_STATS, 2024)
    assert st["not_reg"] == 1 and st["no_offense"] == 1 and len(rows) == 4, st
    b = next(r for r in rows if r["pid"] == "b")
    assert b["rush_tds"] is None and b["carries"] == 0.0 and b["home"] is True
    assert tg[(2024, 1, "AAA")]["tds"] == 2 and tg[(2024, 1, "BBB")]["tds"] == 1
    for (s, w, team), g in tg.items():
        assert g["tds"] == sum(_tds(r) for r in rows if r["team"] == team and r["week"] == w)
    try:
        parse_td_stats(_SELF_STATS.split("\n", 1)[0] + "\n", 2024)
        raise AssertionError("an empty season must raise")
    except CorpusError:
        pass
    ok, text = verdict({"2023": None}, held_out=(2023,))
    assert not ok and "2023: not measured" in text
    with tempfile.TemporaryDirectory() as tmp:
        write_json(os.path.join(tmp, "x.json"), {"a": 1})
    print("selftest ok: corpus kept/absent/reconcile, empty season raises, verdict names failures")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--cache", help="directory to read/save the nflverse CSVs")
    ap.add_argument("--out", default=OUT_PATH)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    doc = run(cache=args.cache, out=args.out)
    for s in doc["held_out_seasons"]:
        m = doc["seasons"].get(str(s), {}).get("model")
        print("%d model %s" % (s, m))
    print(doc["verdict"])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except CorpusError as exc:
        print("ATD BACKTEST ERROR: %s" % exc, file=sys.stderr)
        sys.exit(1)
