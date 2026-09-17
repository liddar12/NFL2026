# R77 — The this-week gate ("will he play this week?")

RCA 2026-09-17. Injured, suspended and non-starting quarterbacks carried points
on the current week and were priced as parlay legs. Root cause: "will he play
this week?" was never a first-class fact. `avail:false` existed only for
season-class absences (IR/PUP/NFI, a parsed duration), an OUT kept 55% of his
week, a DOUBTFUL 70%, a suspension of unstated length 100%, and no consumer
ever consulted a depth chart — so a QB2 behind a healthy starter projected as
if he started, and `build_leg_pool` / `build_props_by_game` priced everyone
with a weekly row.

## The one predicate

`scripts/availability.NOT_PLAYABLE = {DOUBTFUL, OUT, IR, PUP, NFI, SUSPENDED}`
and `status_playable(code)`. QUESTIONABLE is deliberately playable (owner rule:
**Q priced + labelled, D excluded**). Unknown is playable: a wrong zero is
worse than a missed one.

`build_weekly.this_week_gate(...)` decides, per projected player, for the
current week only, in priority order:

1. **inactive** (R79) — his ESPN athlete id is on his team's posted game-day
   inactive list (`data/inactives.json`, read from ESPN's per-competition
   rosters, `didNotPlay`). Fetched only for games inside the window (kickoff
   minus 3h until FINAL); outside it the file is removed so a stale list can
   never gate a later game. The most authoritative source: a healthy scratch
   at any position is caught here and nowhere else.
2. **status** — his canonical injury status is in NOT_PLAYABLE.
3. **depth** (QB only) — he is not the highest-ranked *playable* QB on his
   team's latest depth chart (`data/depth_chart.json`, nflverse, per-team
   latest snapshot). The starter is the first listed QB whose status is
   playable, so a QB2 behind an OUT QB1 is **promoted** (stated as
   `depth_promoted`, playable) and a QB3 behind him is not. A projected QB the
   chart does not list is not the starter (`depth: null`). Two co-listed
   rank-1 QBs gate nobody at the top. Owner rule: **zero unless QB1 is out**.

Nothing is gated on a bye, for a team whose game that week is already FINAL
(a played week is never retro-zeroed), or — for depth — when the chart is
absent (status still gates; the model summary says the chart was missing).

## What it writes

* `player_weekly.json players[].this_week` — present only when not playable
  or promoted: `{wk, playable, reason, status | depth + starter |
  starter_out, points_lost}`. The week row carries `avail:false, pts 0.0`
  (mechanic (c) in `player_weeks(gate_week=)`: that week is excluded from the
  renormalisation, so the season total drops by its pro-rata share; inside a
  season block it changes nothing).
* `player_weekly.json model.this_week` — `{wk, gated, by_reason, promoted,
  depth_snapshot, skipped_final_teams}`.
* `data/depth_chart.json` — written fresh by `build_predictions` every run;
  the last-good file stands in on a feed failure (feed health `depth_chart`).
* `data/inactives.json` — the posted lists for games in the window, with
  `fetched_utc` per game and a `failed` list for games whose fetch failed
  (feed health `inactives`). Never carried across windows.
* `parlays.json` prop legs carry `gsis_id` and, for Q players,
  `availability: "QUESTIONABLE"`. `leg_pool.json players[]` likewise, and
  `counts.not_playable`.

## Consumers

* `parlay_builder.build_props_by_game` — a gated player is never a candidate;
  the next playable player takes the slot.
* `build_leg_pool.prop_legs` — a gated player carries no leg at any rung.
* PLAYERS view headline: `WK n · INACTIVE | OUT | D | SUSP | IR | PUP | NFI |
  QB2 | QB3 | NOT STARTING`, or `MATCHUP · STARTS` for a promoted backup. PARLAYS and MY
  PARLAYS legs carry a `Q` chip.

## The gate in the gate

`validate_data.check_weekly_availability` rules 6–9: a `this_week` block must
agree with the week row it zeroed, with the status, chart or posted list that
justified it, and with the model summary; **no silent sitter** — a not-playable
status with a game this week must have been gated; and **no silent inactive**
— every projected player a posted list names must be gated. `check_no_unplayable_legs`: no
slate or pool prop leg on a player whose row says he sits, every prop leg
names its player, a Q player is labelled and only Q may be labelled.

Locked by `tests/feature/r77_playable.test.mjs` (pipeline + validator) and
`tests/feature/r77_app_playable.test.mjs` (app).

## Cadence

GitHub `schedule:` crons are throttled by hours. The refresh cadence the gate
needs (3+ daily, plus T-3h / T-75min before each game window) is driven by
`workflow_dispatch` from a Claude Routine; the crons stay as a fallback.
Game-day inactives (ESPN, ~90 min before kickoff) feed `this_week_gate` as
reason `inactive` since R79; the Mon/Thu 7:15pm ET and Sunday 12:03 / 3:15 /
7:20pm ET runs are timed to catch each window's list.
