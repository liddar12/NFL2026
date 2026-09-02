# R52 — Dead-code sweep (end to end)

Scanner: `scripts/audit_dead_code.py` (stdlib, report-only; `--selftest` runs in the smoke gate).
It cross-references every JS export in `app/` against every static, dynamic and computed
import in `app/`, `tests/`, `index.html` and `sw.js`; every top-level Python definition in
`scripts/` against `scripts/`, `tests/` and the workflows; and every `data/*.json` feed
against everything that could read it. Every candidate was then re-checked by hand with a
bare-name grep across the repo (docs included) before anything was removed.

## Before → after (2026-09-02, commits 28ee550 → this release)

| inventory | before | after |
|---|---|---|
| JS exports with no importer | 61 | 0 |
| JS exports used only by tests | 214 | 225 (see note) |
| Orphan JS modules | 0 | 0 |
| Python top-level defs unreferenced anywhere | 13 (+5 second-order) | 0 |
| Python modules nothing imports | 1 (`scripts/scrape/weather_fetch.py`) | 0 |
| Data feeds nothing reads | 0 | 0 |

## What was removed
- **`export` keyword dropped** on 52 names that no module or test imports (the symbols stay
  where their own module uses them): auction, availability, draft-live, draft-sim, gate, kdst,
  league, league-rosters, mocks, render, ros, sleeper, sleeper-proj, synclog, team-logic, and
  the grade/players/team views.
- **Symbols deleted outright** (unused even inside their module): `clearKdstCache`,
  `clearSleeperCache`, `SLEEPER_RESERVE_SLOTS`, `SYNC_KINDS`, the `RUNTIME_CONFIG` re-export.
- **Python definitions deleted**: `meta_record.get_record`, `player_projection.load_players`,
  `espn.utc_now_iso`, `nflverse._assert_fresh / _records / _require_nfl_data_py` (the banned
  nfl_data_py path) and the nfl_data_py-era `fetch_weekly_stats / fetch_rosters /
  fetch_depth_charts / fetch_snap_counts`, a **duplicate** `fetch_depth_charts_release`
  (the first definition was shadowed by the second), `odds.fetch_kalshi`,
  `stadiums.outdoor_teams`, `aging.supported_positions`, `dvp_mismatch._prev_totals`, and
  the whole of `scrape/weather_fetch.py` (its one public function had no caller; forecasts
  come from `build_weather_forecast.py`).
- **Retired with the R52 view fixes**: `pendingAutoload` / `pendingAutoRoster` and the direct
  remounts on GRADE and TEAM, the views' private Sleeper player-dump fetchers, and the
  draft-live import in the GRADE view.

## Note on test-only exports
225 names are exported solely so unit tests can reach them. They are not dead — the tests are
the gate — but each is API surface with no runtime consumer. They are listed by the scanner
(`--json`) for a future decision: keep as test seams, or move the tests to behavioural entry
points. Not removed in this release on purpose.

## Guard against regrowth
The scanner's selftest runs in `tests/smoke.sh`; the full inventory is one command
(`python3 scripts/audit_dead_code.py`) and can be promoted to a never-regress gate step
(fail when the no-importer count rises above 0) once the test-only decision is made.
