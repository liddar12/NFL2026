DISCOVERY PIPELINE (gated)
Goal: automation, speed, iteration. Maximize automation through Claude, Claude Code, terminal and CLI, connectors, and Claude in Chrome, with as little manual input from me as possible. Use available skills and connectors wherever they fit.

SCOPING — match effort to the change (decide first, ask if unsure):
- Greenfield project or major feature: run Gates 1 to 4 in order.
- Scoped change on this existing codebase (bug fix, enhancement, copy/UX tweak): skip discovery/design/backlog and go straight to the regression gate + Gate 4 deploy. Do not re-litigate known architecture for a mature repo.
- When you ask me to choose anything, give multiple choices with a recommendation, not an open-ended prompt.

GATE 1 - Solution architecture (confirm before proceeding)
- Classify scope: personal, small business, or enterprise.
- Map the overall solution architecture end to end.
- Design automation-first: state what runs via Claude Code, CLI, connectors, and Chrome with no manual step.
- Recommend the stack from project analysis. Default to my usual tools unless the project argues otherwise: Supabase, Netlify or Vercel, GitHub (liddar12), Cursor and Claude Code, MCP connectors. Choose test frameworks per project.
- For THIS project the stack/architecture is already settled — see PROJECT: NFL2026 below. Don't re-derive it; extend it.

GATE 2 - Design direction (confirm)
- Ask first: optimize for iOS iPhone or Desktop Safari. (This project defaults to iOS iPhone — it is a mobile PWA — but still confirm per task.)
- Propose 2 to 3 distinct visual directions. Avoid the default Claude look (centered cards, purple gradients, generic SaaS). Apply my J5L branding skill. (This project is J5L — nfl2026.j5lagenticstrategy.com.)
- Cover layout, color, and type for each option.
- NOTE: the frontend is a MINIMAL provisional skeleton today. Real visual design is Gate 2's job — do not treat the placeholder index.html as final.

GATE 3 - Backlog (confirm)
- Produce epics, user stories, and tasks.
- Every item has acceptance criteria and at least 90% QA coverage.
- Deliver as markdown files (under docs/), summarized in chat with paths.

GATE 4 - Deploy (confirm before any deploy)
- Precondition: regression is 100% green (the full gate, see PROJECT gate commands). Never deploy red.
- Deploy = push to main → Netlify auto-deploys the PWA. The live-score API deploys separately via the Vercel CLI (see PROJECT).
- Merge to main race-safe (crons push concurrently): git pull --ff-only, merge branch, push; on data conflict prefer freshly generated files.
- After deploy, verify on prod (curl the deployed file/endpoint or load it in Chrome) — do not assume it shipped.
- State the rollback (one-line revert / one command) before deploying. Outward-facing or hard-to-reverse actions: confirm with me first.

BUILD MODEL
Orchestrate the team with the Workflow tool (deterministic fan-out; ~16 concurrency cap matches the hard cap below). Through the gates, work sequentially: architect, designer, planner in order so nothing is skipped. At build, form the team:
- PM / orchestrator agent: owns the backlog, partitions the work, manages the bug-fix agents.
- Solution architect and tech lead agents: own architecture and the final build and deploy.
- Epic / feature build agents: one per independent epic (harness, optimizer, signals, models, scrapers, frontend).
- QA: 3 QA agents plus smoke-test agents that verify every acceptance criterion.
- Bug-fix agents: separate from build, managed by the PM agent.

CONCURRENCY RULE
- Hard cap: 16 concurrent agents.
- The real limit is partitioning, not count. Concurrency equals the number of genuinely independent partitions (disjoint file ownership) so agents do not collide on shared files.
- Default 4 to 6 concurrent. Scale toward 16 only when the architecture has that many independent modules.

ITERATE
Build, test in sandbox (local: npm run serve, and Netlify deploy previews), then production, looping until 100% of regression passes. Add or extend a regression test for every fix and lock the exact behavior changed.

MANUAL HANDOFFS
When a step requires me to do something by hand (a UI action, an auth step, a value to fetch, a console command, anything outside Claude's reach), stop and give me:
1. Numbered, copy-paste-ready steps. One action per line. Exact menu paths, exact commands, exact field names.
2. The exact place to click or paste, and what I should see when it works.
3. A confirmation block I can copy and paste back to report status, pre-filled so I only edit values.
Wait for my paste-back before continuing. Prefer the `! <command>` prompt prefix when I need to run something locally so the output lands in this session. Minimize handoffs: the Vercel CLI and connectors are already authenticated.

================================================================
PROJECT: NFL2026 (GATE 1 pre-answered — this is the settled architecture)

NFL 2026 prediction + analytics platform. This is the REFERENCE IMPLEMENTATION of a
domain-agnostic prediction platform; NFL is the first adapter. Evaluation harness first,
models second — the harness is the product, models are plug-ins.

Two product surfaces:
- Player analytics (season-long): per-player projection by position (QB/RB/WR/TE first),
  baseline = prior performance + position age curve, every factor a named signal at weight 0.
- Weekly winners + parlays: game model (Elo + market + J5L composite, fitted blend) plus a
  correlation-aware parlay builder (>=3 parlays per game and per week) with model EV +
  conformal confidence tiers.

Tech: Vanilla JS PWA, NO build step. index.html shell + ES modules under app/ (hash router,
no framework). Do not introduce a bundler/framework/build pipeline for the app.
Python 3.11 stdlib only in gate-run code; Node 22 built-ins only for tests.

Hosting topology (non-obvious — get this right):
- PWA → Netlify (nfl2026.j5lagenticstrategy.com). Publish dir "."; build is just
  `node scripts/write-runtime-config.mjs`. Deploy = push to main → auto-deploy.
- Live-score API → a NEW `/api/nfl` Edge Function added to the EXISTING Vercel `live-api`
  project (team liddar-terminal) — same project that serves wc2026's /api/live. Redeploy:
  `cd live-api && vercel deploy --prod --yes --scope liddar-terminal`. Netlify ignores live-api/.
- Data pipeline → GitHub Actions crons commit JSON to data/ on main.
- Auth/pools (later) → Supabase, username/password with synthetic emails (NOT Google OAuth).
  NEVER write to the deploy-preview project; never apply migrations to prod without an
  explicit OK in chat.

Regression gate (run in order; 100% green before any deploy; gate on EXIT CODES, not by
grepping ANSI-colored summaries):
  python3 scripts/validate_data.py
  bash tests/smoke.sh
  node --test tests/feature/*.mjs
  # Playwright UX tests arrive with the Gate-2 frontend — added to the gate then, not before.
`tests/run_gate.sh` runs the three live steps in order, gating on exit codes.

Live data — hard-won rules (inherited from wc2026):
- GitHub `schedule:` crons are heavily throttled (a */15 cron fires ~every few hours). Do NOT
  rely on cron cadence for real-time.
- Real-time scores come from ESPN via the Vercel /api/nfl endpoint (app/live-scores.js →
  app/live-poller.js), with direct-ESPN fallback on error. The git pipeline
  (data/*.json) is the durable record for scoring/leaderboards.
- STATUS-GATING IS CRITICAL: only FINAL games (STATUS_FINAL) award points / update actuals.
  Live, scheduled, and 0-0 stubs are display-only — never as results.
- Name normalization: ESPN names differ from nflverse. The RENAMES map is defined once in
  scripts/scrape/renames.py and MIRRORED in app/live-scores.js and the Vercel edge fn —
  keep the three in sync.
- Canonical keys: player = nflverse `gsis_id` (e.g. "00-0034796"); team = nflverse abbrev
  (ARI ATL BAL BUF ... WAS). All records key on these.

The models & optimizer (core inherited asset — do not weaken):
- J5L Composite: weighted blend of curated + Elo + signals; weights FITTED, not hand-set.
- Market model: sportsbook/Kalshi/Polymarket odds ingested as a first-class model.
- Hybrid: fitted blend of J5L / market / elo. Blend FULL probability vectors and take max on
  disagreement — NEVER average point picks. Market typically earns the largest weight.
- Stacker: alpha*z(J5L) + (1-alpha)*z(other), alpha refit every cron run.
- Conformal layer: split-conformal safe sets at 85% and 70% coverage = the user-facing
  uncertainty layer (a set of plausible outcomes, not a false point estimate).
- Optimizer: walk-forward, leak-safe (each event predicted using only info available as-of
  kickoff), shrinkage toward current weights, objective = log-loss (games) / MAE+rank-corr
  (player points); accuracy reported alongside, never optimized.
- NEVER REGRESS: new params adopted ONLY if they beat current params' log-loss on the same
  leak-safe set by a margin (default 0.0015). Otherwise current is kept. NEVER lower this
  margin to force an adoption. New signals enter at weight 0 and earn weight only via the fit.

Backtest honesty (the discipline that matters most):
- Archive point-in-time snapshots from day one. Every prediction locked pre-event.
- Non-measured rows MUST be flagged "estimate": true; measured rows MUST carry brier &
  log_loss. A test enforces this — the UI can never present estimates as measurements.
- Validation unit = the event (game / player-week), never the season.
- Baseline gate: every complexity increment must beat the simpler baseline (Elo, or the
  market) on held-out log-loss or it is cut.

Feed-health monitoring (the silent-scraper 404 lesson):
- data/pipeline_status.json tracks per-feed rows, age_hours, last_success_utc, status
  (ok/stale/degraded/down) plus an overall health. Every feed asserts row-count and staleness
  and fails LOUDLY — never continue-on-error masking a 0-row write.

Conventions:
- Match data/*.json on-disk encoding when writing from scripts (ensure_ascii=True, indent=2,
  trailing newline) — keep diffs minimal, no cosmetic churn.
- sw.js does NOT cache (pure cache-purger); _headers controls app-code freshness (short
  max-age + stale-while-revalidate).
- Fix only what's scoped; no opportunistic refactors or new abstractions.
- ZERO external deps in anything the gate runs. Real data libs (nfl_data_py, requests) import
  INSIDE functions in scripts/scrape/* only, guarded so a missing package raises one clear line.
- Design/architecture notes live in docs/ (ARCHITECTURE, PLATFORM_THESIS, EVALUATION_HARNESS,
  SIGNAL_REGISTRY, ROADMAP).
