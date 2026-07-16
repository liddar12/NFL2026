# NFL2026 — Decision Log (initial-design history)

A durable, append-only record of the decisions that shaped the initial build, so future adapters
(and future me) can see *why*, not just *what*. Newest entries at the bottom. Each entry: date,
decision, rationale, and status.

Format for future entries:
```
## YYYY-MM-DD — <short title>
**Decision:** …  **Rationale:** …  **Status:** adopted | superseded by <entry>
```

---

## 2026-07-15 — Platform thesis: evaluation harness first, models second
**Decision:** Build NFL2026 as the **reference implementation of a domain-agnostic prediction
platform**, first adapter = NFL. The generalizable core (ranked): (1) the evaluation harness —
point-in-time snapshots, event-level log-loss/Brier/calibration, estimate-vs-measured flags enforced
by tests, baseline gates; (2) the optimizer with the NEVER REGRESS gate; (3) the multi-model
ensemble; (4) conformal safe sets; (5) feed-health monitoring; (6) the JSON contract; (7) dual
weight modes (fitted = truth, sliders = labeled sandbox).
**Rationale:** Distilled from four prior projects (wc2026-tracker, bracket-analytics-2026,
liddar-terminal, F1 fantasy). The harness is the actual product; models are plug-ins. The single
biggest prior regret was not archiving point-in-time predictions from day one — so that is Story #1.
**Status:** adopted (Gate 1).

## 2026-07-15 — Gate 1: scope & architecture
**Decision:** Personal-scope (single user), no auth/pools. Stack: vanilla-JS **no-build PWA** on
**Netlify**; **Python + GitHub Actions crons** committing versioned JSON to `data/`; a **Vercel edge**
`/api/nfl` for live scores; **Supabase not used in v1** (no auth needed). Data sources: **nflverse**
(`nfl_data_py`, canonical key `gsis_id`), **ESPN** (schedule/scores/injuries), **The Odds
API + Kalshi** (free-tier budgeted), **Open-Meteo** (weather).
**Rationale:** Reuses the proven wc2026 topology; nflverse is the free gold-standard NFL source.
No bundler/framework — keeps iteration fast for a solo builder with agent teams.
**Status:** adopted (Gate 1).

## 2026-07-15 — Snapshot storage: JSON-in-repo
**Decision:** Point-in-time prediction snapshots live as **JSON in the repo** (`data/snapshots/`),
not Supabase tables.
**Rationale:** Simple, versioned, free; NFL volume (~272 games + ~350 players × 18 weeks) is a few
MB/season — well within repo scale. Revisit only if bloat becomes real.
**Status:** adopted.

## 2026-07-15 — Repository: public
**Decision:** `liddar12/NFL2026` is **public**.
**Rationale:** User's choice over the private recommendation — unlimited Actions minutes and a J5L
portfolio piece. Trade-off acknowledged: parlay edges and curated ratings are world-readable; can be
flipped to private at any time without affecting the build.
**Status:** adopted.

## 2026-07-15 — Core invariants adopted (framework guardrails)
**Decision:** These are non-negotiable across every epic and every future adapter:
- **NEVER REGRESS** — new parameters adopted only if they beat current by log-loss margin **0.0015**
  on the same leak-safe set; otherwise current is kept.
- **Signals enter at weight 0.0** and earn weight only via the optimizer ("Dominance started at 0").
- **Estimate vs measured** — non-measured rows flagged `estimate:true`; measured rows carry
  `brier`+`log_loss`; enforced by tests. The UI can never present an estimate as a measurement.
- **Full-probability-vector blending** — blend whole vectors, take the max on directional
  disagreement; never average point picks.
- **STATUS-gating** — only FINAL results (STATUS_FINAL etc.) award points / advance state; live,
  half, and 0-0 scheduled stubs are display-only.
- **Loud feeds** — every feed asserts row-count and staleness and fails loudly; no `continue-on-error`
  masking a zero-row write. `pipeline_status.json` may honestly report "degraded".
- **A signal that does not reach the model does not exist** — wire end-to-end or don't build it.
- **Regression gate on exit codes**, 100% green before any deploy; **rollback stated before
  deploying**; **verify on prod** after.
**Rationale:** Each traces to a specific prior postmortem (silent zero-output scrapers, frozen
analytics, unwired signals, chasing noise on small samples).
**Status:** adopted; encoded as acceptance criteria across P1–P10.

## 2026-07-15 — Gate 2: design direction
**Decision:** **Broadcast Gameday**, **dark-only**, **J5L palette** (blue `#4A90C2` + crimson
`#E35A61` on `#0D1117`, extracted from the live `wc2026-tracker` tokens — not invented), target
**iOS iPhone 16 Pro**, installable **PWA**. The **PWA UI is tested independently of the web UI**
(separate Playwright projects). **WCAG-AA / ADA contrast** is a hard requirement, audited (0 failures)
and enforced by a permanent gate test.
**Rationale:** Broadcast scorebug energy fits an NFL prediction tool; J5L brand fidelity via the
existing token set; dark-only per user. AA was made computable (a validator run, not eyeballed) and
locked so it can't regress.
**Status:** adopted (Gate 2); implemented in PR #1.

## 2026-07-15 — Design system is token-swappable (reuse seam)
**Decision:** The PWA shell, router, JSON-contract reader, AA test, and web/PWA test harness are
**domain- and brand-agnostic**; the Broadcast/dark/J5L look is expressed purely through
`app/theme.css` tokens + `app/teams.js` tints.
**Rationale:** A future adapter re-skins by swapping tokens, not rebuilding the shell — the P7
framework seam.
**Status:** adopted.


## 2026-07-16 — Real data pipeline: ESPN + Elo priors (nflverse deferred to cron)
**Decision:** The live pipeline is `scripts/build_predictions.py`. ESPN's keyless public API
supplies the real 2026 schedule (272 games), team identity (colors/venues), 2025 FINAL results,
and injuries; 2025 results feed `scripts/models/elo.py` (MOV-adjusted Elo, reverted to mean) to
produce real 2026 win probabilities through the full-vector game model. Weather via Open-Meteo.
nflverse ingestion stays a guarded, cron-only path (its release CSVs are proxy-blocked in the build
sandbox but fine on GitHub runners). Market feeds (Odds API / Kalshi) stay honestly `degraded` until
a key is set. `build_all.py` remains the offline, stdlib-only, fixtures-based generator (players +
parlays); crons run `build_all` then `build_predictions` so real game data overwrites the fixture
placeholder.
**Rationale:** Ship real, honest predictions now without waiting on paid keys — ESPN covers the
adapter's backbone keylessly. Elo-only is a transparent baseline every later signal must beat.
**Status:** adopted; game/schedule/team/feed-health data is now real. Player projections stay
fixture-based estimates until N2's real ingestion.

## 2026-07-16 — N2 real player projections via ESPN Fantasy API + P1 opening locks
**Decision:** Player projections now come from ESPN's Fantasy API (`kona_player_info`,
leaguedefaults/3 = ESPN PPR scoring): ~400 fantasy-relevant players with REAL prior-season
totals (statSourceId 0 / statSplitTypeId 0 — never ESPN's projections), ages merged from the
32 team rosters, live injuryStatus flowing into interval widening. Records key `espn-<id>`
until the nflverse cron lands the gsis mapping. Parlays are rebuilt from the real slate each
run (ids can no longer drift from game_predictions). P1 is on: each week's game predictions
are archived as an immutable `_games_open` snapshot lock (estimate=false, measurable) the
harness will grade against FINAL scores.
**Rationale:** The statistics/byathlete API has deterministic server-side holes (mid-pagination
pages return empty at any page size — observed receiving ranks 26-40), silently dropping top
players; the fantasy endpoint is whole, ESPN-scored, and carries injury status. Locks-from-day-one
is the platform's #1 discipline.
**Status:** adopted. Day-zero honesty: projection == prior-season production until signals earn
weight (locked by tests/feature/real_data.test.mjs); smoke + parlay tests now derive the slate
instead of hardcoding fixture ids.

## 2026-07-16 — Weekly model v1, selectable scoring, and the TEAM builder
**Decision:** (1) Week-by-week projections via `scripts/build_weekly.py`: season projection split
over scheduled weeks, tilted by opponent Elo (`tilt = 1 + 0.5·Δelo/400`, clamped [0.75,1.25]) and
home/away (±2%), zeroed on byes, renormalized to the season total — labeled ESTIMATE, with
`tilt_coef`/`home_coef` recorded in the contract meta as the parameters the P2 optimizer refits
in-season against resolved weekly locks (the self-learning loop, NEVER-REGRESS gated). New contract
`data/player_weekly.json` mirrors player_projections order. (2) Scoring is user-selectable
(PPR/Half/Standard) with EXACT conversion via real prior-season receptions (ESPN raw statId 53).
(3) TEAM tab: QB·2RB·2WR·TE·FLEX + 6 bench (no K/D-ST until modeled), localStorage persistence,
and a deterministic fit engine (`app/team-logic.js`, pure + unit-locked) whose recommendations carry
plain-language reasons: QB↔receiver stacks, bye-clash penalties, bye-cover credits, worst-week
floor raises, complementary-matchup weeks. (4) Slate gained a WK 1–18 selector off schedule_full;
parlay GAME/WEEK toggle restyled to a solid-brand active pill (AA pair added to the contrast test).
**Rationale:** User feedback after first prod review. Weekly numbers stay honest (a transparent
split of a real season prior, not fabricated per-week skill), and the builder recommends by LOGIC,
not just points — the explicit ask.
**Status:** adopted. Gate at 66 unit + 16 e2e, all green.
