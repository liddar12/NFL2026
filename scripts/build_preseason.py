"""BUILD data/preseason_form.json — the Rel17 F7 preseason-form EXPERIMENT.

STATUS: EXPERIMENTAL, UNWIRED, OUTPUT READ BY NOBODY (R30)
----------------------------------------------------------
This script is invoked by NO workflow and no other script — not daily.yml, not
gameday.yml, not backtest.yml, not build_predictions.py, not build_all.py. It
has been standalone since the commit that introduced it (Rel17, 9fdcc0d); git
history shows it was never wired and then orphaned — it simply never ran
anywhere. Consequences, stated so nobody trusts the artifact past what it is:

  * data/preseason_form.json is FROZEN at whatever manual run last wrote it;
    nothing refreshes it, so its numbers are a snapshot, not a feed.
  * `preseason_form` is NOT in scripts/signals/registry.py, NOT in
    data/meta.json weights, and NOT known to scripts/promote_signals.py.
    There is no registry weight and no promotion path for it today — wiring
    those up is a deliberate future feature, not something this docstring may
    claim already exists.
  * No app surface and no pipeline script reads the output.

Running it prints a loud stderr banner saying exactly this (see main()).
The math below is real and --selftest exercises it; the plumbing is not.

WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT
---------------------------------------------
Preseason box scores are NOT true performance. Starters sit or play one series,
play-calling is vanilla, and everyone on the field is avoiding contact. A backup
running back's three-touchdown August cannot mean what a Week 4 three-touchdown
game means. So this signal is built to be small on purpose and to disappear on
schedule:

  * CAPPED    — |adj - 1| can never exceed PRESEASON_CAP (3%). Clamped in code.
  * SCALED    — multiplied by a sample weight, so the starter who played eight
                snaps moves less than the backup who played the whole second half.
  * DECAYING  — multiplied by a decay that reaches EXACTLY 0.0 once the player's
                team has DECAY_GAMES (3) FINAL regular-season games. After that
                the adjustment is exactly 1.0 forever: real football has landed
                and August is not evidence any more.
  * WEIGHT 0  — in the strongest possible sense: `preseason_form` is not
                registered as a signal AT ALL (see STATUS above), so today it
                moves no published number. Registering it at 0.0 and giving it
                a promotion-gate family would be the first step of wiring it —
                neither has happened.
  * LABELLED  — a mandatory `caveat` rides in the document so no surface can
                render the number without the sentence that makes it honest.

HONEST DATA
-----------
Zero opportunities -> adj 1.0, reason "no_preseason_opportunities". No prior-season
baseline -> adj 1.0, reason "no_baseline". No preseason window, no feed, or no
decay basis -> the whole document is {"available": false, "reason": "..."} with an
EMPTY players map. Never a fabricated number, never a silently stale one.

DOCUMENTED DEVIATION FROM SOLUTION_DESIGN §6 — the sample basis is OPPORTUNITIES,
not snaps. §6 specifies `preseason_snaps` / `MIN_SNAPS = 30`. Verified against the
live feed: ESPN's summary boxscore carries NO participation data — there is no snap
count in the payload (checked every `boxscore.players[].statistics` category), and
the only other snap source (nflverse) 403s through the sandbox proxy. Rather than
label an opportunity count "snaps" (which the honest-data rule forbids), the sample
basis is `opportunities` = pass attempts + rush attempts + targets, named as such in
the document, in the schema, and in the caveat, with MIN_OPPORTUNITIES = 15 as the
full-confidence bar (roughly a starter's whole preseason allotment). Everything else
in §6 — the constant names, the formula shape, the clamp, the decay, the reason
strings' role — is implemented verbatim.

MEASURED CORRECTION TO SOLUTION_DESIGN §6 — the "±2 ranks" claim needed a number.
§6 asserts that applying `adj` at FULL strength moves no top-100 player more than
±2 within-position ranks. That is a property of the DATA, not of the 3% cap:
measured against the committed data/player_projections.json, a single player moved
by the full ±3% with everyone else left alone moves up to 5 within-position ranks
(WRs 40-70 are packed inside 3% of each other). So the cap alone does NOT buy the
±2 bound. This builder therefore MEASURES the bound instead of assuming it: every
run stamps `max_rank_move` (the largest within-position rank move any top-100
player would suffer if these adjustments were applied at full strength) and
`rank_guard_ok` (that value <= MAX_RANK_MOVE). The promotion gate — not this
builder — is the place that may refuse to grant weight when the guard is false.

NOT invoked from build_predictions.py (deliberate — a dead preseason feed must
never change the core pipeline's failure semantics) and, unlike the
build_injury_history / build_player_usage siblings that pattern was copied
from, not invoked from any workflow either (see STATUS above). The committed
preseason_form.json is still schema-validated by scripts/validate_data.py and
tests/feature/preseason.test.mjs, so the frozen artifact at least cannot rot
silently into an invalid shape.
--selftest is fixture-driven, touches no network, and writes nothing.
"""

import datetime as dt
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "preseason_form.json")
HISTORY_PATH = os.path.join(DATA, "player_history.json")
PROJECTIONS_PATH = os.path.join(DATA, "player_projections.json")

SEASON = 2026
PRIOR_SEASON = 2025
PRESEASON_WEEKS = range(1, 5)      # ESPN seasontype=1: HOF game + PRE1-PRE3
REGULAR_WEEKS = range(1, 19)       # for the decay basis (team FINAL count)

# --- the three constants the owner rule is written in terms of ---------------
PRESEASON_CAP = 0.03      # |adj - 1| can never exceed 3%
MIN_OPPORTUNITIES = 15    # opportunities for a full-confidence sample (see docstring)
DECAY_GAMES = 3           # decays to EXACTLY 0 after 3 FINAL regular-season team games
MAX_RANK_MOVE = 2         # the bound `rank_guard_ok` reports against

SEASON_GAMES = 17.0       # baseline is a per-game rate: prior season points / 17

# Standard PPR (ESPN leaguedefaults/3 — the same scoring player_history.json is in).
PPR = {
    "pass_yds": 0.04,
    "pass_td": 4.0,
    "interceptions": -2.0,
    "rush_yds": 0.1,
    "rush_td": 6.0,
    "receptions": 1.0,
    "rec_yds": 0.1,
    "rec_td": 6.0,
    "fumbles_lost": -2.0,
}

# What "playing time" means here. Named for what it is: NOT snaps (see docstring).
OPPORTUNITIES = ("pass_att", "rush_att", "targets")

CAVEAT = (
    "Preseason snaps are not true performance - starters sit or play a series and "
    "everyone is avoiding injury. Capped at +/-3%, scaled by preseason opportunities "
    "(ESPN publishes no snap counts), decays to zero after three regular-season "
    "games, and currently carries weight 0."
)

SOURCE = ("ESPN summary boxscores, seasontype=1 (HOF game + PRE1-PRE3), FINAL games "
          "only; baseline = data/player_history.json prior-season PPR points")


# ---------------------------------------------------------------------------
# Pure math — no network, no I/O. Everything below is exercised by --selftest.
# ---------------------------------------------------------------------------

def ppr_points(line):
    """Standard-PPR fantasy points for one aggregated preseason stat line."""
    return round(sum(PPR[k] * float(line.get(k, 0) or 0) for k in PPR), 2)


def opportunities(line):
    """Playing-time proxy: pass attempts + rush attempts + targets. NOT snaps."""
    return int(sum(int(line.get(k, 0) or 0) for k in OPPORTUNITIES))


def clamp(value, lo, hi):
    return lo if value < lo else (hi if value > hi else value)


def decay_for(team_finals):
    """1.0 with no regular-season football played, EXACTLY 0.0 at DECAY_GAMES.

    Written as (DECAY_GAMES - n) / DECAY_GAMES rather than 1 - n/DECAY_GAMES so the
    intermediate steps are exact thirds (1 - 1/3 is 0.6666666666666667 in binary
    floating point; 2/3 is 0.6666666666666666) — the decay ladder is asserted to the
    bit in --selftest, and "decays to exactly zero" should mean exactly.
    """
    return max(0.0, (float(DECAY_GAMES) - float(team_finals)) / DECAY_GAMES)


def compute_adj(preseason_ppr, preseason_games, prior_season_points, opps,
                team_finals):
    """(adj, reason, parts) for one player. `reason` is None when a real signal
    was computed; otherwise it names — honestly — why the answer is exactly 1.0.

        ratio  = (preseason_ppr / preseason_games) / (prior_season_points / 17)
        signal = clamp(ratio, 1 - CAP, 1 + CAP)
        sample = min(opportunities / MIN_OPPORTUNITIES, 1.0)
        decay  = max(0.0, 1.0 - team_finals / DECAY_GAMES)
        adj    = 1 + (signal - 1) * sample * decay
    """
    parts = {"ratio": None, "signal": None, "sample": 0.0,
             "decay": round(decay_for(team_finals), 4)}
    if not preseason_games or opps <= 0:
        return 1.0, "no_preseason_opportunities", parts
    if not prior_season_points or float(prior_season_points) <= 0:
        return 1.0, "no_baseline", parts
    baseline = float(prior_season_points) / SEASON_GAMES
    ratio = (float(preseason_ppr) / float(preseason_games)) / baseline
    signal = clamp(ratio, 1.0 - PRESEASON_CAP, 1.0 + PRESEASON_CAP)
    sample = min(float(opps) / MIN_OPPORTUNITIES, 1.0)
    decay = decay_for(team_finals)
    adj = 1.0 + (signal - 1.0) * sample * decay
    parts = {"ratio": round(ratio, 4), "signal": round(signal, 4),
             "sample": round(sample, 4), "decay": round(decay, 4)}
    return round(adj, 4), None, parts


def aggregate(games):
    """Sum per-game player lines into one row per player.

    `games` is fetch_preseason_playerstats() output. Returns
    {player_id: {name, team, games, <stat fields>}}. A player only counts a game
    in which he actually has a stat line — the per-player games played is the
    honest denominator, not the team's game count.
    """
    out = {}
    for g in games:
        for pid, line in (g.get("players") or {}).items():
            row = out.setdefault(pid, {"name": line.get("name") or "",
                                       "team": line.get("team"), "games": 0})
            row["name"] = line.get("name") or row["name"]
            row["team"] = line.get("team") or row["team"]
            row["games"] += 1
            for k, v in line.items():
                if k in ("name", "team"):
                    continue
                row[k] = row.get(k, 0) + int(v or 0)
    return out


def prior_points(history, pid):
    """Prior-season PPR points for a player, or None. Honest about absence."""
    entry = (history or {}).get(pid)
    if not entry:
        return None
    for season in entry.get("seasons") or []:
        if season.get("yr") == PRIOR_SEASON:
            pts = season.get("pts")
            return float(pts) if pts is not None else None
    return None


def build_rows(totals, history, team_finals, projections=None):
    """One emitted row per preseason player, each carrying every input that made
    its `adj` — so any surface can show the arithmetic, not just the answer."""
    proj_by_id = {p["gsis_id"]: p for p in (projections or [])}
    rows = {}
    for pid, tot in totals.items():
        proj = proj_by_id.get(pid)
        # Decay keys on the team whose regular-season games have actually landed
        # for THIS player: his current fantasy team when we know it, else the
        # team he suited up for in the preseason.
        team = (proj or {}).get("team") or tot.get("team")
        finals = int((team_finals or {}).get(team, 0))
        ppr = ppr_points(tot)
        opps = opportunities(tot)
        base = prior_points(history, pid)
        adj, reason, parts = compute_adj(ppr, tot["games"], base, opps, finals)
        rows[pid] = {
            "name": tot.get("name") or (proj or {}).get("name") or "",
            "team": team,
            "preseason_team": tot.get("team"),
            "preseason_games": int(tot["games"]),
            "preseason_ppr": ppr,
            "opportunities": opps,
            "prior_season_points": base,
            "team_regular_finals": finals,
            "ratio": parts["ratio"],
            "signal": parts["signal"],
            "sample": parts["sample"],
            "decay": parts["decay"],
            "adj": adj,
            "reason": reason,
        }
    return rows


def _position_ranks(entries):
    """{player_id: rank within his position} from (pid, position, points)."""
    by_pos = {}
    for pid, pos, pts in entries:
        by_pos.setdefault(pos, []).append((pts, pid))
    ranks = {}
    for pos, group in by_pos.items():
        for i, (_pts, pid) in enumerate(sorted(group, key=lambda x: (-x[0], x[1])), 1):
            ranks[pid] = i
    return ranks


def max_rank_move(rows, projections, top_n=100):
    """Largest within-position rank move a top-`top_n` player would suffer if every
    `adj` in `rows` were applied at FULL strength (i.e. ignoring the registry weight).

    This is the owner rule made measurable: "must never be able to flip a ranking on
    its own". Returns 0 when no projected player carries an adjustment.
    """
    if not projections:
        return 0
    base = [(p["gsis_id"], p["position"], float(p["proj_points"])) for p in projections]
    before = _position_ranks(base)
    after = _position_ranks([
        (pid, pos, pts * float((rows.get(pid) or {}).get("adj", 1.0)))
        for pid, pos, pts in base
    ])
    top = sorted(projections, key=lambda p: -float(p["proj_points"]))[:top_n]
    moves = [abs(after[p["gsis_id"]] - before[p["gsis_id"]]) for p in top]
    return max(moves) if moves else 0


def document(rows, games_seen, projections, available=True, reason=None):
    """The emitted document. Unavailable documents carry the SAME shape with an
    empty players map — a consumer never has to special-case the honest answer."""
    rows = rows or {}
    moved = max_rank_move(rows, projections) if available else 0
    return {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SOURCE,
        "season": SEASON,
        "available": bool(available),
        "reason": reason,
        "estimate": True,
        "caveat": CAVEAT,
        "sample_basis": "opportunities",
        "constants": {
            "preseason_cap": PRESEASON_CAP,
            "min_opportunities": MIN_OPPORTUNITIES,
            "decay_games": DECAY_GAMES,
            "max_rank_move": MAX_RANK_MOVE,
        },
        "preseason_games_seen": int(games_seen),
        "max_rank_move": int(moved),
        "rank_guard_ok": bool(moved <= MAX_RANK_MOVE),
        "players": rows,
    }


# ---------------------------------------------------------------------------
# Runner entry point.
# ---------------------------------------------------------------------------

def _load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _write(doc):
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")


# Printed by main() on every real run. A quiet dead script looks alive the
# moment someone runs it by hand; this one announces what it is.
UNWIRED_BANNER = (
    "=" * 72 + "\n"
    "  build_preseason.py is EXPERIMENTAL AND UNWIRED (R30):\n"
    "  - no workflow or script invokes it (this is a manual run);\n"
    "  - preseason_form is NOT in the signal registry and has NO weight;\n"
    "  - nothing reads data/preseason_form.json, and nothing refreshes it,\n"
    "    so the file this run writes will sit frozen until the next manual run.\n"
    + "=" * 72)


def main():
    print(UNWIRED_BANNER, file=sys.stderr)

    from scripts.scrape import espn, espn_gamestats           # noqa: PLC0415
    from scripts.scrape.espn import FeedError                 # noqa: PLC0415

    # A dead feed and a timed-out feed are the same fact to this builder: we do not
    # know August's numbers. requests.RequestException subclasses OSError, so this
    # tuple covers the transport layer without a bare `except Exception`. Either way
    # we write a FRESH available:false document rather than leaving yesterday's
    # numbers in place with today's timestamp — stale-but-plausible is the failure
    # mode the honest-data rule exists to prevent.
    feed_down = (FeedError, OSError)

    projections = (_load(PROJECTIONS_PATH) or {}).get("players") or []
    history = (_load(HISTORY_PATH) or {}).get("players") or {}

    try:
        games = espn_gamestats.fetch_preseason_playerstats(
            SEASON, weeks=PRESEASON_WEEKS,
            log=lambda m: print("  " + m, file=sys.stderr))
    except feed_down as err:
        print(f"NOTICE: preseason feed unavailable ({err}); writing an honest "
              f"available:false document.", file=sys.stderr)
        _write(document({}, 0, projections, available=False,
                        reason="preseason feed unavailable: %s" % err))
        return 0

    if not games:
        print("NOTICE: no FINAL preseason games yet; writing available:false.",
              file=sys.stderr)
        _write(document({}, 0, projections, available=False,
                        reason="no FINAL preseason games in season %d weeks %d-%d"
                               % (SEASON, PRESEASON_WEEKS[0], PRESEASON_WEEKS[-1])))
        return 0

    # The decay basis. Without it we cannot say how much real football has landed,
    # and a guessed decay is exactly the fabrication the honest-data rule forbids.
    try:
        finals = espn.fetch_final_results(SEASON, weeks=REGULAR_WEEKS)
    except feed_down as err:
        print(f"NOTICE: regular-season finals unavailable ({err}); refusing to guess "
              f"a decay.", file=sys.stderr)
        _write(document({}, len(games), projections, available=False,
                        reason="decay basis unavailable (regular-season finals): %s"
                               % err))
        return 0

    team_finals = {}
    for g in finals:
        for side in ("home", "away"):
            team_finals[g[side]] = team_finals.get(g[side], 0) + 1

    rows = build_rows(aggregate(games), history, team_finals, projections)
    doc = document(rows, len(games), projections)
    _write(doc)
    real = sum(1 for r in rows.values() if r["reason"] is None)
    print("Wrote preseason_form.json: %d FINAL preseason games, %d players "
          "(%d with a real signal), max_rank_move=%d rank_guard_ok=%s"
          % (len(games), len(rows), real, doc["max_rank_move"],
             doc["rank_guard_ok"]))
    if not doc["rank_guard_ok"]:
        print("NOTICE: preseason adjustments would move a top-100 player %d "
              "within-position ranks at full strength (bound %d). Weight stays 0; "
              "the promotion gate must not grant weight while this is false."
              % (doc["max_rank_move"], MAX_RANK_MOVE), file=sys.stderr)
    return 0


# ---------------------------------------------------------------------------
# --selftest: fixture-driven, no network, writes nothing.
# ---------------------------------------------------------------------------

def _line(**kw):
    line = {"completions": 0, "pass_att": 0, "pass_yds": 0, "pass_td": 0,
            "interceptions": 0, "rush_att": 0, "rush_yds": 0, "rush_td": 0,
            "receptions": 0, "rec_yds": 0, "rec_td": 0, "targets": 0,
            "fumbles_lost": 0}
    line.update(kw)
    return line


def selftest():
    # --- 1. PPR scoring is the documented table, exactly. -------------------
    assert ppr_points(_line(receptions=3, rec_yds=38)) == 6.8
    assert ppr_points(_line(rush_att=12, rush_yds=60)) == 6.0
    assert ppr_points(_line(pass_yds=250, pass_td=2, interceptions=1)) == 16.0
    assert ppr_points(_line(rec_td=1, fumbles_lost=1)) == 4.0

    # --- 2. opportunities is pass att + rush att + targets, and NOT snaps. ---
    assert opportunities(_line(pass_att=20, rush_att=3, targets=0)) == 23
    assert opportunities(_line(receptions=9, rec_yds=200)) == 0  # catches aren't chances

    # --- 3. THE CAP. Nothing can exceed +/-3%, at any ratio. -----------------
    # A 10x preseason (the absurd case) with a full sample and no decay:
    adj, reason, parts = compute_adj(100.0, 1, 17.0, 999, 0)
    assert (adj, reason) == (1.03, None), (adj, reason)
    assert parts["signal"] == 1.03 and parts["ratio"] == 100.0
    # A zero preseason with a full sample and no decay:
    adj, reason, _ = compute_adj(0.0, 1, 170.0, 20, 0)
    assert (adj, reason) == (0.97, None), (adj, reason)
    for ratio_pts in (0.0, 0.5, 1.0, 5.0, 50.0, 500.0):
        a, _r, _p = compute_adj(ratio_pts, 1, 17.0, 999, 0)
        assert abs(a - 1.0) <= PRESEASON_CAP + 1e-12, (ratio_pts, a)

    # --- 4. THE DECAY. Exactly zero at 3 team finals, and forever after. ----
    assert [decay_for(n) for n in (0, 1, 2, 3, 4, 17)] == [
        1.0, 2.0 / 3.0, 1.0 / 3.0, 0.0, 0.0, 0.0]
    expected = {0: 1.03, 1: 1.02, 2: 1.01, 3: 1.0, 4: 1.0}
    for finals, want in expected.items():
        got, _r, _p = compute_adj(100.0, 1, 17.0, 999, finals)
        assert got == want, (finals, got, want)
    # At DECAY_GAMES the adjustment is 1.0 EXACTLY — not 0.9999, not "about 1".
    dead, _r, parts = compute_adj(0.0, 1, 170.0, 999, DECAY_GAMES)
    assert dead == 1.0 and parts["decay"] == 0.0

    # --- 5. THE SAMPLE. A one-series starter moves a fraction of the cap. ----
    #  3 of 15 opportunities -> sample 0.2 -> a capped +3% becomes +0.6%.
    adj, _r, parts = compute_adj(100.0, 1, 17.0, 3, 0)
    assert (adj, parts["sample"]) == (1.006, 0.2), (adj, parts)
    #  15+ opportunities saturate at 1.0 and never exceed it.
    _a, _r, parts = compute_adj(100.0, 1, 17.0, 45, 0)
    assert parts["sample"] == 1.0

    # --- 6. HONEST ABSENCE. Never a fabricated value. -----------------------
    assert compute_adj(0.0, 0, 170.0, 0, 0)[:2] == (1.0, "no_preseason_opportunities")
    assert compute_adj(9.0, 1, 170.0, 0, 0)[:2] == (1.0, "no_preseason_opportunities")
    assert compute_adj(9.0, 1, None, 12, 0)[:2] == (1.0, "no_baseline")
    assert compute_adj(9.0, 1, 0.0, 12, 0)[:2] == (1.0, "no_baseline")

    # --- 7. Aggregation sums across games and counts GAMES PLAYED. ----------
    games = [
        {"players": {"espn-1": dict(_line(receptions=2, rec_yds=20, targets=4),
                                    name="A", team="KC")}},
        {"players": {"espn-1": dict(_line(receptions=1, rec_yds=10, targets=2),
                                    name="A", team="KC"),
                     "espn-2": dict(_line(rush_att=5, rush_yds=25),
                                    name="B", team="SF")}},
    ]
    tot = aggregate(games)
    assert tot["espn-1"]["games"] == 2 and tot["espn-1"]["receptions"] == 3
    assert tot["espn-1"]["targets"] == 6 and tot["espn-2"]["games"] == 1
    assert ppr_points(tot["espn-1"]) == 6.0  # 3 rec + 30 yds
    assert opportunities(tot["espn-1"]) == 6

    # --- 8. THE RANK GUARD, on the REAL committed projections. --------------
    projections = (_load(PROJECTIONS_PATH) or {}).get("players") or []
    assert projections, "player_projections.json is required for the rank guard"
    # (a) all-1.0 adjustments move nobody.
    assert max_rank_move({}, projections) == 0
    # (b) the guard actually detects movement: push the whole board by the cap in
    #     alternating directions and it must report a non-zero, and it must trip.
    adversarial = {}
    for i, p in enumerate(projections):
        adversarial[p["gsis_id"]] = {"adj": 1.0 + PRESEASON_CAP * (1 if i % 2 else -1)}
    worst = max_rank_move(adversarial, projections)
    assert worst > MAX_RANK_MOVE, worst
    # (c) the emitted document self-reports honestly.
    doc = document(adversarial, 1, projections)
    assert doc["max_rank_move"] == worst and doc["rank_guard_ok"] is False
    # (d) and the committed document, if present, agrees with a recompute.
    committed = _load(OUT_PATH)
    if committed:
        recomputed = max_rank_move(committed.get("players") or {}, projections)
        assert committed["max_rank_move"] == recomputed, (
            committed["max_rank_move"], recomputed)
        assert committed["rank_guard_ok"] == (recomputed <= MAX_RANK_MOVE)
        assert committed["caveat"] == CAVEAT
        assert committed["constants"]["preseason_cap"] == PRESEASON_CAP
        for pid, row in (committed.get("players") or {}).items():
            assert abs(row["adj"] - 1.0) <= PRESEASON_CAP + 1e-9, (pid, row["adj"])
            if row["reason"] is not None:
                assert row["adj"] == 1.0, (pid, row)

    # --- 9. The unavailable document is the same shape, empty and honest. ---
    down = document({}, 0, projections, available=False, reason="feed down")
    assert down["available"] is False and down["players"] == {}
    assert down["reason"] == "feed down" and down["caveat"] == CAVEAT
    assert down["estimate"] is True and down["max_rank_move"] == 0

    print("selftest OK: PPR table exact; cap +/-%.2f enforced at every ratio; decay "
          "1.0/0.667/0.333/0.0 -> adj 1.03/1.02/1.01/1.0 EXACTLY at 3 team finals; "
          "sample 3/%d -> 1.006; honest 1.0 with a reason on absent inputs; rank "
          "guard measured against the real 300-player board (bound %d)"
          % (PRESEASON_CAP, MIN_OPPORTUNITIES, MAX_RANK_MOVE))


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
