# PLAYERS · AI+ = THIS WEEK (R51)

`#/players` carries a BASE / AI+ toggle (`.aiseg`, persisted in the shared
`nfl2026.ai.v1` key). As of R51 the toggle means one thing:

> **AI+ ON** — the card's headline is **this week's league-priced points**
> (`WK n · MATCHUP`), the rest-of-season sum rides every card (`RoS x · g`),
> the season projection stays visible as `BASE x · SEASON`, and the list is
> sorted by this week's number (ties by the season number).
>
> **BASE** — the season projection, exactly as before.

Nothing about a player's numbers is multiplied or tilted by the toggle any
more. AI+ is a *view* onto the weekly split the app already ships; it does not
make a new number.

## The arithmetic (one split, three surfaces)

All weekly numbers on this tab come from `weeklyPoints()` in
`app/team-logic.js`, the same function LINEUP (`app/views/lineup.js`) and
GRADE (`app/grade-weekly.js`) price their weeks with:

```
season      = projSeason(p, w, mode)                    # league-priced season number
week[k]     = weeklyPoints(w, season, p.proj_points)[k] # the pipeline's weekly share, priced
this week   = week[currentWk]                           # the WK n · MATCHUP headline
RoS         = rosValue(p, w, mode, currentWk).points    # Σ week[k], k ≥ currentWk, non-bye
BASE        = season
```

- `weekValue()` (`app/views/players.js`) is the headline: `{ points, bye, opp,
  home }`, or `null` when the player has no weekly row / no row for that week.
  `null` renders as `—` with the label `WK n · NO WEEKLY ROW` and **sorts last
  in either direction** — absent is never 0. A bye is a real 0 and is labelled
  `WK n · BYE`.
- `rosValue()` is unchanged from R30b; it is the remaining-week sum of the same
  split scaled by the same season ratio. `tests/feature/r51_ai_plus.test.mjs`
  locks `RoS == Σ weekValue()` over the remaining weeks on the committed data.
- The 80% conformal band under the headline is a **season** quantity. It is no
  longer scaled by anything but the scoring mode, and it keeps its season ends.
- The WEEKS strip scales by the scoring ratio only, so its `WK n` cell equals
  the AI+ headline.

### Which week is "this week"

The same rule LINEUP uses: the pipeline's `game_predictions.json` week
(default 1), overridden by Sleeper's current **regular-season** week when the
TEAM sync stored one (`defaultLineupWeek(loadNflWeek(), 18)` from
`app/league-rosters.js`). With nothing known the label reads `WK 1`.
`league-rosters.js` is a `LAZY_ONLY` module in the perf budget and
`players.js` is on the boot graph, so it is a dynamic `import()` inside the
mount, never a static edge.

### What the toggle may claim

The legend and the AI+ note read `data/player_weekly.json → model.name` at
runtime (`aiPlusCopy()`):

- `weekly_split_v2` — "matchup-adjusted weekly points from the same split
  GRADE and LINEUP use (opponent DvP, weather, venue; Elo for QB). Measured vs
  last season's split: MAE −2.3%, rank corr +5.7%. ESTIMATE."
- any other name (today's doc ships `weekly_split_v1`) — "matchup-adjusted
  weekly points (weekly split), the same split GRADE and LINEUP use. ESTIMATE."
  No factor and no measurement is claimed for a split that was not measured.

The toggle renders only when the weekly layer exists (`hasWeekly`); it used to
be gated on `ai_insights`, which no longer has anything to do with it.

## Why the trajectory tilt was retired

Before R51, AI+ multiplied the season projection (and its interval) by
`1 + clamp(trajectory_adj.value, ±0.25)` from `data/ai_insights.json` — a
5-year trajectory tilt — and re-ranked the list by the tilted number.

Measured offline against 2025 actuals, the tilt made the number **worse**:

| | season projection | × trajectory tilt |
|---|---|---|
| rank correlation vs actuals | baseline | **−0.016** |
| MAE (points, on a ~54-point scale) | baseline | **+4.2** |

A toggle that degrades the number it labels "AI" is a claim the data does not
support, so the multiplier, its clamp, the `AI PROJ PTS` label, the
`+x.x AI` delta and the "re-ranks by 5-yr trajectory (±25%)" copy are deleted
from `app/views/players.js` (not just switched off). The delta was dropped
rather than redefined: with nothing multiplied there is no base-vs-AI delta to
show, and "this week minus a seventeenth of the season" would have been a new
number with no measurement behind it.

## What remains of `ai_insights` on this tab

- **TREND chip** (`trajFor()` → `trendLabel()`): ▲ / ▼ / ▬ with the measured
  pts/yr when ≥3 seasons exist, `AI EST` when age-curve estimated. Information
  only — it moves no number.
- **TREND sort**: orders by the signed trajectory value. Still information; it
  re-orders, it does not re-price.

## TEAM tab

`app/views/team.js` shares the preference key but its AI+ is a different
mechanism: the Fit Engine v2 (`recommendV2` / `fitScoreV2` in
`app/team-logic.js`) re-ranks *recommendations* by fixed trajectory / cold /
stack weights. It never multiplied a displayed projection by the trajectory
tilt, so nothing there was retired in R51; it only reads the preference.

## Tests

- `tests/feature/r51_ai_plus.test.mjs` — the multiplier is gone; the week comes
  from league-rosters (lazily); RoS == Σ remaining priced weeks; absent → `—`
  and last; wording switches on `model.name`; toggle gated on `hasWeekly`.
- `tests/web/r51_ai_plus.spec.mjs` — on `#/players` with committed data: AI+
  shows `WK n · MATCHUP`, different numbers from BASE, RoS + BASE on the card,
  the PROJ chip relabels to `WK n`, BASE restores the season numbers exactly,
  and the choice persists across a reload.
