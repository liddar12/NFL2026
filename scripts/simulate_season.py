"""Monte Carlo the 2026 NFL season from OUR model -> data/playoff_odds.json.

OUR MODEL ONLY (user policy): every game samples from the probability already
published in data/schedule_full.json — the exact numbers priced with the
ADOPTED game params — so the simulator can never disagree with the game model,
and no market price is an input anywhere. Playoff rounds price from the same
Elo ratings (data/team_strength.json) with the adopted HFA.

DETERMINISTIC: random.Random(SEED) with a fixed constant — same inputs, same
odds, byte-for-byte (re-runs only change when the underlying model does).

TIEBREAKERS (simplified, documented): real NFL tiebreakers run 12 levels deep
(common games, strength of victory, ...). We apply, in order: (1) head-to-head
win pct among the tied teams in THAT simulated season, (2) division record,
(3) conference record, (4) deterministic RNG pick. The output notes say so —
these odds are ESTIMATES from a simplified seeding model, not league gospel.

Playoff format: 7 seeds per conference (4 division winners by record, then 3
wildcards), higher seed hosts, seed 1 first-round bye, Super Bowl at neutral
site (hfa 0).
"""

import json
import os
import random
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.models import elo as elo_mod  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "playoff_odds.json")
SEED = 20260901          # fixed: deterministic output (no wall-clock anywhere)
N_SIMS = 10000

# The 8 real 2026 divisions, canonical abbrevs (mirrors ESPN identity).
DIVISIONS = {
    "AFC_EAST":  ["BUF", "MIA", "NE", "NYJ"],
    "AFC_NORTH": ["BAL", "CIN", "CLE", "PIT"],
    "AFC_SOUTH": ["HOU", "IND", "JAX", "TEN"],
    "AFC_WEST":  ["DEN", "KC", "LAC", "LV"],
    "NFC_EAST":  ["DAL", "NYG", "PHI", "WAS"],
    "NFC_NORTH": ["CHI", "DET", "GB", "MIN"],
    "NFC_SOUTH": ["ATL", "CAR", "NO", "TB"],
    "NFC_WEST":  ["ARI", "LAR", "SEA", "SF"],
}
CONFERENCES = {
    "AFC": [t for d, ts in DIVISIONS.items() if d.startswith("AFC") for t in ts],
    "NFC": [t for d, ts in DIVISIONS.items() if d.startswith("NFC") for t in ts],
}


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def load_inputs():
    """(games, ratings, hfa): schedule probs, Elo map, adopted playoff HFA."""
    with open(os.path.join(DATA, "schedule_full.json"), encoding="utf-8") as fh:
        games = json.load(fh)["games"]
    with open(os.path.join(DATA, "team_strength.json"), encoding="utf-8") as fh:
        ratings = json.load(fh)["ratings"]
    hfa = elo_mod.HFA_ELO
    try:
        with open(os.path.join(DATA, "model_tuning.json"), encoding="utf-8") as fh:
            gp = json.load(fh).get("game_params") or {}
        if isinstance(gp.get("hfa_elo"), (int, float)):
            hfa = float(gp["hfa_elo"])
    except (OSError, ValueError):
        pass
    return games, ratings, hfa


def rank_group(teams, wins, h2h, div_rec, conf_rec, rng):
    """Order `teams` best-first by wins with the documented tiebreakers.

    wins/div_rec/conf_rec: {team: number}; h2h: {(a, b): wins of a over b}.
    Pure given its inputs + rng — the unit test drives it synthetically.
    """
    def cmp_key(group):
        # Within a tied group, score each team by the tiebreak ladder.
        def key(t):
            h2h_w = sum(h2h.get((t, u), 0) for u in group if u != t)
            h2h_g = sum(h2h.get((t, u), 0) + h2h.get((u, t), 0) for u in group if u != t)
            h2h_pct = (h2h_w / h2h_g) if h2h_g else 0.5
            return (h2h_pct, div_rec.get(t, 0.0), conf_rec.get(t, 0.0), rng.random())
        return key

    ordered = []
    # Group by win count, best first; break ties inside each group.
    for w in sorted({wins[t] for t in teams}, reverse=True):
        group = [t for t in teams if wins[t] == w]
        if len(group) == 1:
            ordered.extend(group)
        else:
            ordered.extend(sorted(group, key=cmp_key(group), reverse=True))
    return ordered


def simulate_once(games, ratings, hfa, rng, team_div, team_conf):
    """One simulated season+postseason. Returns (playoff_set, div_winners,
    conf_champs {conf: team}, champion)."""
    wins = {t: 0 for t in team_div}
    div_w = {t: 0.0 for t in team_div}
    conf_w = {t: 0.0 for t in team_div}
    h2h = {}
    for g in games:
        h, a = g["home"], g["away"]
        home_won = rng.random() < g["probs"]["home"]
        w, l = (h, a) if home_won else (a, h)
        wins[w] += 1
        h2h[(w, l)] = h2h.get((w, l), 0) + 1
        if team_div[w] == team_div[l]:
            div_w[w] += 1
        if team_conf[w] == team_conf[l]:
            conf_w[w] += 1

    playoff, div_winners, conf_champs = set(), set(), {}
    finalists = {}
    for conf, teams in CONFERENCES.items():
        winners = []
        for d, dteams in DIVISIONS.items():
            if not d.startswith(conf):
                continue
            best = rank_group(dteams, wins, h2h, div_w, conf_w, rng)[0]
            winners.append(best)
            div_winners.add(best)
        rest = [t for t in teams if t not in winners]
        wildcards = rank_group(rest, wins, h2h, div_w, conf_w, rng)[:3]
        seeds = rank_group(winners, wins, h2h, div_w, conf_w, rng) + wildcards
        playoff.update(seeds)

        def beat(x, y, neutral=False):
            p = elo_mod.expected_home(ratings.get(x, elo_mod.INIT),
                                      ratings.get(y, elo_mod.INIT),
                                      0.0 if neutral else hfa)
            return x if rng.random() < p else y

        # Wildcard: 2v7 3v6 4v5 (seed 1 bye) -> divisional (reseeded) -> title.
        alive = [seeds[0], beat(seeds[1], seeds[6]), beat(seeds[2], seeds[5]),
                 beat(seeds[3], seeds[4])]
        order = {t: i for i, t in enumerate(seeds)}
        alive.sort(key=lambda t: order[t])
        alive = [beat(alive[0], alive[3]), beat(alive[1], alive[2])]
        alive.sort(key=lambda t: order[t])
        champ = beat(alive[0], alive[1])
        conf_champs[conf] = champ
        finalists[conf] = champ

    sb_home, sb_away = finalists["AFC"], finalists["NFC"]
    p = elo_mod.expected_home(ratings.get(sb_home, elo_mod.INIT),
                              ratings.get(sb_away, elo_mod.INIT), 0.0)
    champion = sb_home if rng.random() < p else sb_away
    return playoff, div_winners, conf_champs, champion


def main(n_sims=N_SIMS):
    games, ratings, hfa = load_inputs()
    if len(games) < 200:
        raise RuntimeError(f"schedule has only {len(games)} games — refusing to simulate.")
    team_div = {t: d for d, ts in DIVISIONS.items() for t in ts}
    team_conf = {t: c for c, ts in CONFERENCES.items() for t in ts}
    missing = [t for t in team_div if t not in ratings]
    if missing:
        raise RuntimeError(f"teams missing from team_strength ratings: {missing}")

    rng = random.Random(SEED)
    tallies = {t: {"playoff": 0, "division": 0, "conference": 0, "champion": 0}
               for t in team_div}
    for _ in range(n_sims):
        playoff, div_winners, conf_champs, champion = simulate_once(
            games, ratings, hfa, rng, team_div, team_conf)
        for t in playoff:
            tallies[t]["playoff"] += 1
        for t in div_winners:
            tallies[t]["division"] += 1
        for t in conf_champs.values():
            tallies[t]["conference"] += 1
        tallies[champion]["champion"] += 1

    import datetime as dt  # noqa: PLC0415 (single stamp, mirrors build_predictions)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = {
        "season": 2026,
        "updated_utc": now,
        "sims": n_sims,
        "estimate": True,
        "source": "elo_prior + adopted game_params — OUR MODEL ONLY (no market input)",
        "method": (f"Monte Carlo, seed {SEED}: regular season sampled from "
                   f"schedule_full.json probs (adopted params); playoffs from Elo "
                   f"(hfa {hfa}, SB neutral); 7 seeds/conf."),
        "notes": [
            "Tiebreakers SIMPLIFIED: head-to-head pct, division record, conference "
            "record, then a deterministic RNG pick. Real NFL tiebreakers run deeper "
            "(common games, strength of victory, ...) — these odds are estimates.",
            "Deterministic: fixed RNG seed; output changes only when the model does.",
        ],
        "teams": {t: {k: round(v / n_sims, 4) for k, v in tallies[t].items()}
                  for t in sorted(tallies)},
    }
    _write(OUT_PATH, doc)
    top = sorted(doc["teams"].items(), key=lambda kv: -kv[1]["champion"])[:5]
    print(f"wrote {OUT_PATH}: {n_sims} sims, top champions: "
          + ", ".join(f"{t} {v['champion']:.3f}" for t, v in top))
    return doc


if __name__ == "__main__":
    main()
