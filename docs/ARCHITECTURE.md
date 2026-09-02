# NFL2026 — Architecture

End-to-end: **data sources → pipeline → JSON contracts → static PWA + edge live endpoint.**
This is the reference implementation of a domain-agnostic prediction platform; NFL is the
first adapter. The evaluation harness is the load-bearing core — models are plug-ins.

## 1. Data sources (all guarded, import-in-function, never touched by the gate)

| Source | Feeds | Scraper | Notes |
|---|---|---|---|
| **nflverse** (`nfl_data_py`) | rosters, weekly stats, schedules, IDs | `scripts/scrape/nflverse.py` | Canonical player key = `gsis_id`; canonical team = nflverse abbrev. |
| **ESPN** | live scores, schedule, injuries | `scripts/scrape/espn.py` | Real-time; STATUS_FINAL only counts. Names normalized via `RENAMES`. |
| **Odds API / Kalshi / Polymarket** | spreads, moneylines, totals, market probs | `scripts/scrape/odds.py` | Free-tier budgeted. Market is a first-class model, not just a benchmark. |
| **Open-Meteo** | wind / temp / precip per stadium | `scripts/scrape/weather_fetch.py` | Only affects outdoor/retractable-open roofs. |

Every scraper imports its heavy dependency **inside** the fetch function and wraps the import
so a missing package raises one clear line, never a bare module-top `ImportError`. The
regression gate runs on a clean box with no `pip install` / `npm install`.

## 2. Pipeline (GitHub Actions crons → commit to `data/` on `main`)

- Crons are **heavily throttled** — a `*/15` schedule fires roughly every few hours. Cron
  cadence is NOT real-time; it is the durable record. Real-time comes from the edge endpoint.
- `scripts/build_all.py` is the **offline orchestrator**: it reads fixtures / scraped inputs
  and writes the model JSON. It is gate-safe (stdlib only, deterministic) so the same code
  path runs in CI and locally.
- `scripts/pipeline_status.py` writes `data/pipeline_status.json` with **loud** per-feed
  assertions on row-count and staleness. A 0-row write is a failure, never masked by
  `continue-on-error`.

Flow:

```
scrape/* (guarded fetch)  ->  build_all.py  ->  harness + signals + models + optimize
                                                        |
                                          NEVER-REGRESS gate (log-loss, margin 0.0015)
                                                        |
                                          data/*.json (validated) + data/snapshots/*
                                                        |
                                          validate_data.py  ->  smoke.sh  ->  node --test
```

## 3. JSON contracts (`data/contracts/*.schema.json`)

The contracts are the interface between the Python pipeline and the JS frontend. Each is a
hand-rolled JSON Schema validated by `scripts/validate_data.py` (stdlib only).

| File | Schema | Shape (summary) |
|---|---|---|
| `data/player_projections.json` | `player_projections.schema.json` | per-player: `gsis_id`, `position`, `team`, `proj_points`, `interval`, `signals`. |
| `data/game_predictions.json` | `game_predictions.schema.json` | per-game: `game_id`, teams, `probs` vector, `model`, `estimate`. |
| `data/parlays.json` | `parlays.schema.json` | per-parlay: legs, `model_ev`, `implied`, `edge`, `conformal_tier`, correlation flag. |
| `data/meta.json` | `meta.schema.json` | `season`, `weights` (every signal at 0.0), `optimizer`, model versions. |
| `data/pipeline_status.json` | `pipeline_status.schema.json` | `health` + per-feed `{rows, age_hours, last_success_utc, status}`. |
| `data/snapshots/*.json` | `snapshot.schema.json` | point-in-time locked prediction rows (see below). |

**Snapshot row** (the honesty unit):
`{event_id, event_type("game"|"player_week"), model, locked_utc, as_of_utc, probs?|point?,
interval?, estimate:bool, resolved:bool, actual?, brier?, log_loss?}`. Invariant enforced by
`scripts/harness/honesty.py`: if `estimate=false` and `resolved=true` then `brier` and
`log_loss` are present; if `estimate=true` then both are absent/null. The UI can never present
an estimate as a measurement.

## 4. Static PWA (Netlify)

- Vanilla ES modules under `app/`, hash router, **no build step, no framework, no bundler**.
- `app/data.js` fetches and caches the `data/*.json` contracts — the single JSON contract
  reader. `app/main.js` is the router shell (a placeholder view today; real UI is Gate 2).
- Netlify: publish dir `.`, build = `node scripts/write-runtime-config.mjs` (emits
  `app/runtime-config.js` from env — no secrets committed).
- `sw.js` is a pure cache-purger (does NOT cache). `_headers` controls app-code freshness
  with short `max-age` + `stale-while-revalidate`.

## 5. Edge live endpoint (Vercel)

- A `/api/nfl` Edge Function added to the **existing** `live-api` Vercel project (team
  `liddar-terminal`) that already serves wc2026's `/api/live`.
- `app/live-poller.js` polls it; `app/live-scores.js` holds a JS mirror of `RENAMES` and the
  STATUS-GATING logic. On endpoint error, the client falls back to hitting ESPN directly.
- Redeploy: `cd live-api && vercel deploy --prod --yes --scope liddar-terminal`. Netlify
  ignores `live-api/`.

## 6. The regression gate

`tests/run_gate.sh` runs six steps in order, gating on **exit codes** (never by grepping
colored summaries):

1. `python3 scripts/validate_data.py` — data contracts + cross-file invariants
2. `bash tests/smoke.sh` — files exist, JSON parses, every pipeline selftest
3. `node --test tests/feature/*.mjs` — the locked feature tests (incl. WCAG AA contrast)
4. `python3 scripts/backtest_weekly.py --gate` — R51 weekly split never-regress
   (weekly_split_v2 vs v1 on committed 2023-2025 actuals; see docs/WEEKLY_SPLIT_V2.md)
5. `python3 scripts/backtest_parlay.py --gate` — R51 parlay never-regress (prop
   calibration beats the seed on every walk-forward fold; spread stays NO EDGE;
   see docs/PARLAY_MODEL_V2.md)
6. Playwright web + pwa + perf (`npx playwright test --config tests/playwright.config.mjs`)
   — the simulated click-through; opt-in locally, always run in CI

Both backtest records (data/weekly_backtest.json, data/parlay_backtest.json) render on the
MODEL tab (docs/MODEL_TAB_GATES.md) and are refreshed by the daily workflow before the build.
