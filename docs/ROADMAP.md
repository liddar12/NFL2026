# NFL2026 — Roadmap

Today is **2026-07-15**. Week 1 kickoff is **~2026-09-10**. That is ~8 weeks. Preseason
(mid-August) is the pipeline shakedown. The organizing principle: **the evaluation harness must
be live and honest before Week 1**, because Week 1 predictions must be locked as point-in-time
snapshots the moment they are made — there is no retrofitting honesty after the fact.

## The four gates (per CLAUDE.md)

- **Gate 1 — Solution architecture.** Pre-answered; settled in CLAUDE.md. Do not re-derive.
- **Gate 2 — Design direction.** The real frontend (2–3 visual directions, J5L branding,
  iOS-iPhone-first PWA). Replaces the provisional placeholder `index.html`.
- **Gate 3 — Backlog.** Epics / stories / tasks with acceptance criteria and >=90% QA coverage,
  as markdown under `docs/`.
- **Gate 4 — Deploy.** Regression 100% green → push to `main` → Netlify auto-deploys; `/api/nfl`
  edge fn deploys via the Vercel CLI. Verify on prod. State rollback before deploying.

## 8-week plan

### Week 0 (2026-07-15 → 07-21) — Skeleton + harness core
- Scaffold the repo (this commit): docs, JSON contracts, harness, optimizer, signals, models,
  scrapers, minimal PWA shell, the regression gate.
- Harness green on fixtures: snapshots, metrics, honesty, conformal, NEVER-REGRESS all tested.
- `tests/run_gate.sh` passes on a clean box with no installs.

### Week 1 (07-22 → 07-28) — Live scrapers wired (behind the gate)
- Implement guarded nflverse / ESPN / odds / weather fetches; import-in-function only.
- `pipeline_status.py` writes honest per-feed health; a stale/degraded feed fails loudly.
- First real (non-fixture) data landing in `data/*.json` from the offline orchestrator.

### Week 2 (07-29 → 08-04) — Snapshots for real events
- Begin archiving point-in-time snapshots for preseason games as a dry run of the honesty path.
- Baseline models live: Elo (games), prior-perf + age-curve (players), market ingestion.
- Estimate-vs-measured accounting verified on resolved preseason results.

### Week 3 (08-05 → 08-11) — Preseason shakedown begins
- Preseason Week 1 = end-to-end pipeline test: scrape → build → validate → snapshot → score.
- Feed-health dashboard data proven; catch silent-404 / 0-row failures now, not in Week 1.
- Conformal safe sets calibrated on the first resolved batch.

### Week 4 (08-12 → 08-18) — Optimizer walk-forward on preseason
- Run the walk-forward optimizer over accumulated preseason snapshots.
- Confirm NEVER-REGRESS behaves: candidates that don't clear the 0.0015 margin are NOT adopted.
- Signals still at/near 0 weight until they measurably earn it — verify no hand-weighting crept in.

### Week 5 (08-19 → 08-25) — Gate 2 design direction
- Present 2–3 visual directions; pick one. Build the real PWA UI for both surfaces.
- Wire the two surfaces to the live JSON contracts. Add Playwright UX tests to the gate.

### Week 6 (08-26 → 09-01) — Parlays + live endpoint
- Parlay builder producing >=3 parlays/game and >=3/week, correlation-aware, EV + conformal tier.
- `/api/nfl` edge fn deployed to the Vercel `live-api` project; live poller + ESPN fallback wired.
- STATUS-GATING verified end to end: only FINAL games move actuals/leaderboards.

### Week 7 (09-02 → 09-08) — Hardening + full regression
- Full regression 100% green (validate → smoke → node --test → Playwright).
- Backtest-honesty audit: every measured row carries brier+log_loss; every estimate flagged.
- Load/latency check on the edge endpoint; rollback path rehearsed.

### Week 8 (09-09 → 09-10) — Week 1 go-live
- Lock Week 1 snapshots BEFORE kickoff. Deploy PWA to Netlify + edge fn to Vercel.
- Verify on prod (curl the contracts + the endpoint; load in Chrome). Monitor feed health.

## Deploy plan (recap)
- PWA: push to `main` → Netlify auto-deploy (publish `.`, build = `write-runtime-config.mjs`).
- Live API: `cd live-api && vercel deploy --prod --yes --scope liddar-terminal`.
- Race-safe merge (concurrent crons): `git pull --ff-only`, merge, push; prefer freshly
  generated data files on conflict.
- Precondition for every deploy: the regression gate is 100% green on exit codes. Never deploy red.
