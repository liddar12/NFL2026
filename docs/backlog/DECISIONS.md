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
