# NFL2026

A domain-agnostic prediction platform, first adapter = the 2026 NFL season. Built by
[J5L Agentic Strategy](https://j5lagenticstrategy.com). Live at
**nfl2026.j5lagenticstrategy.com**.

**Evaluation harness first, models second.** The harness — point-in-time snapshots, honest
estimate-vs-measured accounting, and a walk-forward NEVER-REGRESS gate — is the product.
Models are plug-ins that must earn their place against a baseline on held-out log-loss.

## Two surfaces

1. **Player analytics (season-long).** Per-player projections by position (QB / RB / WR / TE
   first). Baseline = prior performance + a position-specific age curve. Everything else —
   injuries, O-line vs D-line, target competition, coaching/scheme change, schedule, weather —
   enters as a **named signal at weight 0** and earns weight only through the optimizer.
2. **Weekly winners + parlays.** A game model (Elo + market + J5L composite, a *fitted*
   probability-vector blend) plus a correlation-aware parlay builder that emits **at least 3
   parlays per game and at least 3 per week**, each with a model EV and a conformal confidence
   tier (85% / 70% coverage).

## Quickstart

```sh
# Run the full regression gate (stdlib / built-ins only — no pip install, no npm install).
bash tests/run_gate.sh
```

The gate runs, in order, gating on exit codes:

```sh
python3 scripts/validate_data.py      # schema-validate every data/*.json contract
bash tests/smoke.sh                   # files exist, JSON parses, invariants hold
node --test tests/feature/*.mjs       # honesty, never-regress, metrics, conformal, parlay rules
# Playwright UX tests arrive with the Gate-2 frontend.
```

Serve the PWA locally:

```sh
node scripts/write-runtime-config.mjs   # emit app/runtime-config.js
npx serve .                             # or any static server; open index.html
```

## Architecture

```
                         GitHub Actions crons (throttled; durable record)
                                          |
   data sources                           v
  +----------------+   scrape/     +---------------+   validate   +------------------+
  | nflverse       |-------------->|  build_all.py |------------->|  data/*.json     |
  | ESPN           |  (guarded,    | (offline,     |  schema-     |  contracts:      |
  | Odds API/Kalshi|   import-in-  |  gate-safe    |  gated       |  projections,    |
  | Open-Meteo     |   -function)  |  orchestrator)|              |  predictions,    |
  +----------------+               +-------+-------+              |  parlays, meta,  |
                                           |                      |  pipeline_status |
                          harness + optimize + signals + models  |  snapshots/      |
                                           |                      +---------+--------+
                                           v                                |
                                    NEVER-REGRESS gate                      | static fetch
                                    (log-loss margin 0.0015)                v
                                                              +-------------------------+
   real-time scores                                           |  Static PWA (Netlify)   |
  +----------------+   ESPN (STATUS_FINAL only counts)         |  vanilla ES modules,    |
  | Vercel edge fn |<-----------------------------------------|  hash router, no build  |
  | live-api       |------ live poll ------------------------>|  app/main.js, data.js   |
  | /api/nfl       |   (direct-ESPN fallback on error)        +-------------------------+
  +----------------+
```

- **PWA** → Netlify, publish dir `.`, build = `node scripts/write-runtime-config.mjs`.
- **Live-score API** → a `/api/nfl` Edge Function on the existing Vercel `live-api` project.
- **Pipeline** → GitHub Actions commits validated JSON to `data/` on `main`.

## Docs

- [docs/PLATFORM_THESIS.md](docs/PLATFORM_THESIS.md) — why the harness is the product.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — end-to-end data flow and JSON contracts.
- [docs/EVALUATION_HARNESS.md](docs/EVALUATION_HARNESS.md) — snapshots, metrics, NEVER REGRESS.
- [docs/SIGNAL_REGISTRY.md](docs/SIGNAL_REGISTRY.md) — every signal, all starting at weight 0.
- [docs/ROADMAP.md](docs/ROADMAP.md) — 8-week plan to Week 1 kickoff.

## License

MIT © 2026 J5L Agentic Strategy. See [LICENSE](LICENSE).
