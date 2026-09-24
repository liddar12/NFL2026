"""R99 E1 test fixture: a deterministic synthetic league for scripts/backtest_atd.py.

league(seed) -> (universe, team_games) for 2023-2024, four teams, fixed roles,
each role scoring at its true rate from random.Random(seed). No network and no
data/ reads; the tests in tests/feature/r99_*.test.mjs import it.
"""

import random

from scripts import backtest_atd as A

TEAMS = ("AAA", "BBB", "CCC", "DDD")
# role, position, carries, targets, true P(TD) per game
ROLES = (("QB1", "QB", 30, 2, 0.03), ("RB1", "RB", 16, 4, 0.30), ("RB2", "RB", 5, 2, 0.08),
         ("WR1", "WR", 0, 9, 0.28), ("WR2", "WR", 0, 6, 0.16), ("TE1", "TE", 0, 5, 0.12))


def league(seed=7, seasons=(2023, 2024), weeks=10):
    rnd = random.Random(seed)
    uni, tg = {}, {}
    for s in seasons:
        for w in range(1, weeks + 1):
            order = TEAMS if w % 2 else TEAMS[1:] + TEAMS[:1]
            for home, away in ((order[0], order[1]), (order[2], order[3])):
                for team, opp, is_home in ((home, away, True), (away, home, False)):
                    g = {"opp": opp, "home": is_home, "tds": 0, "carries": 0.0, "targets": 0.0}
                    for role, pos, c, t, rate in ROLES:
                        scored = 1 if rnd.random() < rate else 0
                        pid = team + "-" + role
                        uni[(s, w, pid)] = {
                            "season": s, "week": w, "pid": pid, "name": pid, "pos": pos,
                            "team": team, "opp": opp, "home": is_home,
                            "carries": float(c), "targets": float(t),
                            "rush_tds": scored if c >= t else 0,
                            "rec_tds": scored if t > c else 0}
                        g["tds"] += scored
                        g["carries"] += c
                        g["targets"] += t
                    tg[(s, w, team)] = g
    return uni, tg


def week_preds(uni, tg, season, week, params=A.PARAMS):
    """{pid: prediction} for one week."""
    by_week, tg_week = A._index(uni, tg)
    return {p["pid"]: p for p in A.predict_week(season, week, by_week, tg_week, params)}
