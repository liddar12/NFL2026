"""Weekly per-player projection split (weekly_split_v1) -> data/player_weekly.json.

Pure + deterministic + stdlib only: scripts.build_predictions feeds it the season
projections, the full 2026 schedule, the Elo priors, and prior-season receptions.
No network here, so the gate can drive the math offline with fixtures.

The model — a transparent prior, NOT fitted:
  bye   -> pts 0.0 (a team is on bye in week W iff it plays no game that week
           in schedule_full; 2026 byes fall in weeks 5-14)
  base  = season_proj / games_scheduled (the team's non-bye week count, usually 17)
  tilt  = 1 + TILT_COEF * (team_elo - opp_elo) / 400, clamped to [0.75, 1.25]
  venue = 1 +/- HOME_COEF (home 1.02, away 0.98)
  then every player's non-bye weeks are renormalized to sum EXACTLY to the season
  projection — the tilt REDISTRIBUTES points across weeks, it never inflates them.

TILT_COEF is recorded in the output meta on purpose: it is the parameter the P2
optimizer refits in-season against resolved weekly snapshot locks (NEVER-REGRESS
gated). Every row stays estimate=true until the harness proves otherwise.

INJURY SHAPING (documented prior, NOT fitted): data/injuries.json statuses map
to a multiplier on the FIRST 3 non-bye weeks only (Out 0.55, Doubtful 0.7,
Questionable 0.9, anything else 1.0 — an injury report is near-term news, so it
shapes the near-term weeks and nothing beyond them). The split is then
renormalized so the 18-week total still equals the season projection EXACTLY:
the season projection is the honest prior; injuries shift shape, never total.
When injuries.json is absent or empty the output is byte-identical to the
injury-free build, and the model meta records injury_shape only when at least
one player's split was actually shaped.

INVARIANT: output player order mirrors data/player_projections.json exactly
(same ids, same order) — the app zips the two files by index.
"""

import json
import os

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
INJURIES_PATH = os.path.join(_ROOT, "data", "injuries.json")

WEEKS = 18
INJURY_WEEKS = 3    # injury shaping horizon: the FIRST 3 non-bye weeks only
# status -> near-term availability multiplier (documented prior, NOT fitted).
# Statuses outside this map (Active, Injured Reserve, ...) multiply by 1.0.
INJURY_MULT = {"Out": 0.55, "Doubtful": 0.7, "Questionable": 0.9}
TILT_COEF = 0.5     # Elo-tilt strength; the optimizer-refit parameter (see above)
HOME_COEF = 0.02    # home 1.02 / away 0.98
TILT_MIN = 0.75     # clamp so one lopsided matchup can't swallow the season
TILT_MAX = 1.25
ELO_INIT = 1500.0   # mirrors scripts.models.elo.INIT (league-average prior)
MODEL_NAME = "weekly_split_v1"
MODEL_NOTES = (
    "Season projection split evenly across scheduled weeks, tilted by Elo matchup "
    "and home/away, then renormalized so non-bye weeks sum exactly to the season "
    "projection. TILT_COEF is a transparent prior the optimizer refits in-season."
)


def load_injuries(path=INJURIES_PATH):
    """Injury rows from data/injuries.json; absent/unreadable/empty -> [].

    Graceful BY CONTRACT, unlike the feeds: a missing injuries file means
    "shape nothing" and the weekly output stays byte-identical to the
    injury-free build. Loudness lives upstream in espn.fetch_injuries.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return []
    return doc.get("injuries") or []


def _norm_name(name):
    """Casefold + strip periods so 'A.J. Brown' joins 'AJ Brown'."""
    return " ".join(str(name or "").replace(".", "").lower().split())


def injury_multipliers(projections, injuries):
    """{gsis_id: multiplier} for projected players whose status shapes the split.

    Join on (team, normalized player name); a player with several report rows
    keeps the WORST (lowest) multiplier. Statuses outside INJURY_MULT map to
    1.0 and are dropped, so an all-Active report is a clean no-op and only the
    players actually shaped are returned (their count is statuses_used).
    """
    by_key = {}
    for row in injuries or []:
        mult = INJURY_MULT.get(row.get("status"), 1.0)
        if mult >= 1.0:
            continue
        key = (row.get("team"), _norm_name(row.get("player")))
        by_key[key] = min(by_key.get(key, 1.0), mult)
    out = {}
    for p in projections:
        mult = by_key.get((p.get("team"), _norm_name(p.get("name"))))
        if mult is not None:
            out[p["gsis_id"]] = mult
    return out


def team_schedule(schedule_games):
    """{team: {week: (opp, home_bool)}} from schedule_full-shaped game rows.

    Bye detection falls out of this map: a team is on bye in week W iff W is
    absent from its entry (it appears in no game that week).
    """
    sched = {}
    for g in schedule_games:
        wk = g["week"]
        sched.setdefault(g["home"], {})[wk] = (g["away"], True)
        sched.setdefault(g["away"], {})[wk] = (g["home"], False)
    return sched


def player_weeks(season_proj, team, sched_by_team, elos, injury_mult=1.0,
                 round_dp=2):
    """18 week rows {wk, opp, home, bye, pts} for one player.

    Non-bye pts sum to season_proj exactly before 2dp rounding (so within
    18*0.005 = 0.09 after), which is the tolerance the contract test enforces.
    Pass round_dp=None to skip the final rounding (the injury test asserts the
    exact-preservation invariant to 1e-6 on the unrounded split).

    injury_mult (< 1.0 for an injured player) discounts the FIRST INJURY_WEEKS
    non-bye weeks only, before the renormalization — so the injury shifts the
    SHAPE toward the healthy back weeks while the season total stays law.
    """
    sched = sched_by_team.get(team, {})
    team_elo = elos.get(team, ELO_INIT)
    base = season_proj / len(sched) if sched else 0.0

    raw = []  # (index, unnormalized pts) for non-bye weeks
    rows = []
    for wk in range(1, WEEKS + 1):
        game = sched.get(wk)
        if game is None:
            rows.append({"wk": wk, "opp": None, "home": False, "bye": True, "pts": 0.0})
            continue
        opp, home = game
        tilt = 1.0 + TILT_COEF * (team_elo - elos.get(opp, ELO_INIT)) / 400.0
        tilt = min(TILT_MAX, max(TILT_MIN, tilt))
        venue = 1.0 + HOME_COEF if home else 1.0 - HOME_COEF
        pts = base * tilt * venue
        if len(raw) < INJURY_WEEKS:  # this is the 1st/2nd/3rd non-bye week
            pts *= injury_mult
        rows.append({"wk": wk, "opp": opp, "home": home, "bye": False,
                     "pts": pts})
        raw.append(len(rows) - 1)

    # Renormalize: tilt (and any injury discount) redistributes, never
    # deflates or inflates — the season total is law.
    total = sum(rows[i]["pts"] for i in raw)
    scale = (season_proj / total) if total > 0 else 0.0
    for i in raw:
        pts = rows[i]["pts"] * scale
        rows[i]["pts"] = round(pts, round_dp) if round_dp is not None else pts
    return rows


def build_weekly_document(projections, schedule_games, elos, receptions_by_id,
                          season, updated_utc, injuries=None,
                          injuries_path=INJURIES_PATH):
    """The full player_weekly.json document. Pure given its inputs.

    projections: player_projections.json's `players` list (order is preserved).
    schedule_games: schedule_full.json's `games` list (all 272 rows, all weeks).
    elos: {team: rating} — the SAME preseason priors the game model used.
    receptions_by_id: {gsis_id: prior-season receptions} (0.0 when absent).
    injuries: injury rows (see load_injuries); None -> read injuries_path from
    disk (absent/empty file -> no shaping, byte-identical output). Tests pass
    the list directly so the function stays pure under test.
    """
    if injuries is None:
        injuries = load_injuries(injuries_path)
    mults = injury_multipliers(projections, injuries)
    sched_by_team = team_schedule(schedule_games)
    players = [
        {
            "gsis_id": p["gsis_id"],
            "receptions_prior": round(float(receptions_by_id.get(p["gsis_id"], 0.0) or 0.0), 1),
            "weeks": player_weeks(p["proj_points"], p["team"], sched_by_team, elos,
                                  injury_mult=mults.get(p["gsis_id"], 1.0)),
        }
        for p in projections
    ]
    model = {"name": MODEL_NAME, "tilt_coef": TILT_COEF, "home_coef": HOME_COEF,
             "estimate": True, "notes": MODEL_NOTES}
    if mults:
        # statuses_used = projected players whose split was actually shaped.
        model["injury_shape"] = {"applied": True, "statuses_used": len(mults)}
    return {
        "season": season,
        "updated_utc": updated_utc,
        "model": model,
        "players": players,
    }
