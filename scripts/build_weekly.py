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

INVARIANT: output player order mirrors data/player_projections.json exactly
(same ids, same order) — the app zips the two files by index.
"""

WEEKS = 18
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


def player_weeks(season_proj, team, sched_by_team, elos):
    """18 week rows {wk, opp, home, bye, pts} for one player.

    Non-bye pts sum to season_proj exactly before 2dp rounding (so within
    18*0.005 = 0.09 after), which is the tolerance the contract test enforces.
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
        rows.append({"wk": wk, "opp": opp, "home": home, "bye": False,
                     "pts": base * tilt * venue})
        raw.append(len(rows) - 1)

    # Renormalize: tilt redistributes, never inflates — the season total is law.
    total = sum(rows[i]["pts"] for i in raw)
    scale = (season_proj / total) if total > 0 else 0.0
    for i in raw:
        rows[i]["pts"] = round(rows[i]["pts"] * scale, 2)
    return rows


def build_weekly_document(projections, schedule_games, elos, receptions_by_id,
                          season, updated_utc):
    """The full player_weekly.json document. Pure given its inputs.

    projections: player_projections.json's `players` list (order is preserved).
    schedule_games: schedule_full.json's `games` list (all 272 rows, all weeks).
    elos: {team: rating} — the SAME preseason priors the game model used.
    receptions_by_id: {gsis_id: prior-season receptions} (0.0 when absent).
    """
    sched_by_team = team_schedule(schedule_games)
    players = [
        {
            "gsis_id": p["gsis_id"],
            "receptions_prior": round(float(receptions_by_id.get(p["gsis_id"], 0.0) or 0.0), 1),
            "weeks": player_weeks(p["proj_points"], p["team"], sched_by_team, elos),
        }
        for p in projections
    ]
    return {
        "season": season,
        "updated_utc": updated_utc,
        "model": {"name": MODEL_NAME, "tilt_coef": TILT_COEF, "home_coef": HOME_COEF,
                  "estimate": True, "notes": MODEL_NOTES},
        "players": players,
    }
