"""Per-team DEFENSIVE composite from live ESPN rosters -> data/defense_composite.json.

The defensive counterpart of the O-line composite — the missing half of the
registered weight-0 ol_composite_vs_dl signal (offense line vs defensive
front). Same construction discipline as build_oline:

  front (DL/EDGE/LB): n, avg_weight_lb, avg_experience_yrs
  secondary (DB):     n, avg_experience_yrs
  composite = 0.35*z(front weight) + 0.35*z(front experience)
              + 0.30*z(secondary experience), population z across 32 teams,
  mean 0 by construction. DOCUMENTED prior, NOT fitted.

Weight-0 honesty: context only. Nothing reads this into a probability until an
OL-vs-DL matchup term survives the promotion gate — which needs in-season
player-level grading, so this file is groundwork, stated as such.
"""

import datetime as dt
import json
import math
import os
import sys
import time

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.build_oline import (  # noqa: E402 — same fetch/identity machinery
    FeedError, _age_years, _espn_slug, _get_json, _mean, _zscores, CANONICAL_TEAMS,
)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "defense_composite.json")
TEAMS_FIXTURE = os.path.join(DATA, "fixtures", "teams_espn.json")
_SLEEP_S = 0.25

FRONT_POSITIONS = frozenset(["DE", "DT", "NT", "DL", "EDGE", "OLB", "ILB", "MLB", "LB"])
SECONDARY_POSITIONS = frozenset(["CB", "S", "FS", "SS", "DB"])
BLEND = {"front_weight_lb": 0.35, "front_experience_yrs": 0.35,
         "secondary_experience_yrs": 0.30}


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def fetch_team_defenders(abbrev):
    """(front, secondary) player lists from the keyless ESPN roster endpoint."""
    data = _get_json(
        f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/"
        f"{_espn_slug(abbrev)}/roster")
    front, secondary = [], []
    for group in data.get("athletes") or []:
        for ath in group.get("items") or []:
            pos = ((ath.get("position") or {}).get("abbreviation") or "").upper()
            row = {
                "name": ath.get("displayName") or "",
                "weight_lb": float(ath.get("weight") or 0) or None,
                "experience_yrs": (ath.get("experience") or {}).get("years"),
                "dob": ath.get("dateOfBirth"),
            }
            if pos in FRONT_POSITIONS:
                front.append(row)
            elif pos in SECONDARY_POSITIONS:
                secondary.append(row)
    if len(front) < 6 or len(secondary) < 6:
        raise FeedError(f"{abbrev}: thin defense roster (front {len(front)}, "
                        f"secondary {len(secondary)}) — outage or shape drift.")
    return front, secondary


def team_metrics(front, secondary, as_of):
    front_exp = [p["experience_yrs"] for p in front
                 if isinstance(p["experience_yrs"], (int, float))]
    sec_exp = [p["experience_yrs"] for p in secondary
               if isinstance(p["experience_yrs"], (int, float))]
    return {
        "n_front": len(front),
        "n_secondary": len(secondary),
        "front_weight_lb": _mean([p["weight_lb"] for p in front if p["weight_lb"]]),
        "front_experience_yrs": _mean(front_exp),
        "front_avg_age": _mean([_age_years(p["dob"], as_of) for p in front]),
        "secondary_experience_yrs": _mean(sec_exp),
    }


def main():
    with open(TEAMS_FIXTURE, encoding="utf-8") as fh:
        abbrevs = sorted(json.load(fh)["teams"].keys())
    unknown = [ab for ab in abbrevs if ab not in CANONICAL_TEAMS]
    if unknown:
        raise FeedError(f"teams_espn.json has non-canonical abbrevs: {unknown}")

    as_of = dt.datetime.now(dt.timezone.utc).date()
    teams = {}
    for ab in abbrevs:
        front, secondary = fetch_team_defenders(ab)
        teams[ab] = team_metrics(front, secondary, as_of)
        print(f"  {ab}: front {teams[ab]['n_front']}, secondary {teams[ab]['n_secondary']}")
        time.sleep(_SLEEP_S)

    z = {m: _zscores({ab: teams[ab][m] for ab in teams}) for m in BLEND}
    for ab, m in teams.items():
        m["composite"] = round(sum(w * z[metric][ab] for metric, w in BLEND.items()), 4)
        m["front_weight_lb"] = round(m["front_weight_lb"], 1)
        m["front_experience_yrs"] = round(m["front_experience_yrs"], 2)
        m["front_avg_age"] = round(m["front_avg_age"], 1)
        m["secondary_experience_yrs"] = round(m["secondary_experience_yrs"], 2)

    doc = {
        "season": 2026,
        "updated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "espn_roster (front + secondary size/experience blend, documented prior)",
        "teams": teams,
        "params": {
            "applied": False,
            "weight": 0.0,
            "feeds": ("ol_composite_vs_dl signal counterpart - matchup term requires "
                      "in-season player-level grading before promotion"),
        },
        "estimate": True,
    }
    _write(OUT_PATH, doc)
    ranked = sorted(teams.items(), key=lambda kv: -kv[1]["composite"])
    print(f"wrote {OUT_PATH} (32 teams); strongest: "
          + ", ".join(f"{ab} {m['composite']:+.2f}" for ab, m in ranked[:3])
          + " | weakest: "
          + ", ".join(f"{ab} {m['composite']:+.2f}" for ab, m in ranked[-3:]))
    return doc


if __name__ == "__main__":
    main()
