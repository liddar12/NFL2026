# N5 · NFL UI (Slate / Players / Parlays / Live)
**Layer:** NFL Adapter   ·   **Status:** ✅ three views delivered in PR #1 (pending merge to `main`); live/detail ⬜   ·   **Instantiates:** P7 (PWA Shell & Design System)

> **Branch note:** this backlog branch is based on `main`; the design-system and view code was **built and CI-verified in PR #1** (draft, pending merge). Per-story ⬜/🟡 statuses below mean "not yet on `main`," not "not built" — treat PR #1's delivered items as ✅.

**Reuse:** A future adapter re-authors THIS epic end to end — the views, the team-identity tints, and the domain labels are NFL-specific. What it reuses from P7 is the shell, the token/design primitives, the contrast gate, and the `app/data.js` contract-reader pattern. The reusable seam is: views render *only* from validated `data/*.json` contracts through `app/render.js` primitives; swap the contracts + view copy and the presentation machinery carries over.

## Goal
Instantiate the P7 shell as the NFL surface: three data-driven views — Slate (game model win-probability), Players (season projections with an 80% conformal interval), Parlays (per-leg model-vs-implied edge, correlation notes, tier) — plus the planned live in-game and game-detail views. Every surface renders only from validated contracts and shows honest states (`ESTIMATE`, "no signals weighted yet · day zero", `DATA · DEGRADED`) rather than inventing confidence. The UI is downstream of the harness: it never computes predictions, it displays what the pipeline locked.

## Why it matters / risk if skipped
The UI is where a dishonest number does the most damage: a win-prob meter with no uncertainty, a projection that hides that it is an unfitted day-zero estimate, or a parlay whose "edge" is model noise looks authoritative and gets bet. The postmortems bite here — frozen analytics that silently show stale numbers, and unwired signals presenting as signal ("a signal that doesn't reach the model does not exist"). Honest states are load-bearing product, not chrome: the app must say `ESTIMATE`, `day zero`, and `DEGRADED` out loud, and team tints must never fail AA to do it.

## User stories

### N5-S1 — Contract-reader wiring (single data source)   ·  Status: 🟡   ·  Est: S
**As** an Analyst **I want** every view to read through `app/data.js` **so that** a contract change touches one file and no view fetches raw JSON.
**Acceptance criteria:**
- N5-S1-AC1 — Given any view, When it needs data, Then it calls an `app/data.js` getter (playerProjections/gamePredictions/parlays/meta/pipelineStatus) — no direct `fetch` of `/data/*` in view code.
- N5-S1-AC2 — Given a failed contract, When a getter resolves, Then it returns a `{ __error }` marker and the view renders a `DATA · DEGRADED` state, never a crash or blank.
- N5-S1-AC3 — Given concurrent callers on one tick, When two views request the same contract, Then a single network request is issued (promise-cached).
**Tasks:**
- [ ] N5-S1-T1 — Keep `PATHS` + promise cache in `app/data.js`; expose typed getters per contract.
- [ ] N5-S1-T2 — Enforce `{ __error }` marker on fetch/parse failure (no throw into views).
- [ ] N5-S1-T3 — Add a unit test for the promise-dedupe and the error-marker path.
**QA coverage:**
- N5-S1-AC1 → `tests/smoke.sh::no-raw-data-fetch-in-views` (smoke) — Planned
- N5-S1-AC2 → `tests/feature/data_reader.test.mjs::error-marker-on-bad-feed` (unit) — Planned
- N5-S1-AC3 → `tests/feature/data_reader.test.mjs::promise-dedupe` (unit) — Planned
- Coverage: 3/3 = 100%. Test types: unit(node:test) | smoke(bash).
**Traceability:** `app/data.js`, `app/main.js`.

### N5-S2 — Slate view (game model win-prob meters)   ·  Status: 🟡   ·  Est: M
**As** an Analyst **I want** the week's slate with a win-probability meter per game **so that** I see the model's read at a glance with its honesty state.
**Acceptance criteria:**
- N5-S2-AC1 — Given `data/game_predictions.json`, When the Slate renders, Then each game shows a two-sided win-prob meter whose segments sum to 100% and match the contract's probability vector (never a re-derived point pick).
- N5-S2-AC2 — Given a row flagged `estimate` (or day-zero with all signals at weight 0), When rendered, Then it carries a visible `ESTIMATE` / "no signals weighted yet · day zero" badge.
- N5-S2-AC3 — Given the meter fill/track and team tints, When contrast-checked, Then all pairings meet AA graphics ≥ 3:1 (P7-S5).
- N5-S2-AC4 — Given a degraded `pipeline_status` for the games feed, When rendered, Then the Slate shows `DATA · DEGRADED` and does not present the stale numbers as live.
**Tasks:**
- [ ] N5-S2-T1 — Build `app/views/slate.js` reading `gamePredictions` + `pipelineStatus` via `app/data.js`.
- [ ] N5-S2-T2 — Render win-prob meter from the full probability vector using `app/render.js` meter primitive.
- [ ] N5-S2-T3 — Apply AA-safe team tints from `app/teams.js`; wire honesty + degraded badges.
- [ ] N5-S2-T4 — Add unit test (meter segments sum to 100, honest-state selection) + e2e render.
**QA coverage:**
- N5-S2-AC1 → `tests/feature/slate_view.test.mjs::meter-matches-vector` (unit) — Planned
- N5-S2-AC2 → `tests/feature/slate_view.test.mjs::estimate-badge` (unit) — Planned
- N5-S2-AC3 → `tests/feature/contrast_aa.test.mjs::slate-meter-and-tints` (contrast) — Planned
- N5-S2-AC4 → `tests/web/slate.spec.mjs::degraded-state` (e2e-web) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test) | contrast(AA) | e2e-web.
**Traceability:** `app/views/slate.js` (new), `app/render.js` (new), `app/teams.js` (new), `app/data.js`, `data/game_predictions.json`.

### N5-S3 — Players view (projection + 80% conformal interval)   ·  Status: 🟡   ·  Est: M
**As** an Analyst **I want** each player's season projection shown with its 80% conformal interval **so that** I read a range, not a false-precision point.
**Acceptance criteria:**
- N5-S3-AC1 — Given `data/player_projections.json`, When a player renders, Then the point projection is shown WITH its 80% interval `[lo, hi]` from the contract (lo ≤ point ≤ hi), never a bare number.
- N5-S3-AC2 — Given a projection flagged `estimate`, When rendered, Then it carries an `ESTIMATE` badge and the interval is styled to read as wide/uncertain.
- N5-S3-AC3 — Given the projections list, When rendered, Then it is sorted/filterable by position and the interval bar meets AA graphics ≥ 3:1.
- N5-S3-AC4 — Given a missing interval field, When rendered, Then the view degrades honestly (shows point + "interval unavailable"), never fabricates bounds.
**Tasks:**
- [ ] N5-S3-T1 — Build `app/views/players.js` reading `playerProjections` via `app/data.js`.
- [ ] N5-S3-T2 — Render an interval bar primitive (point marker within `[lo,hi]`) in `app/render.js`.
- [ ] N5-S3-T3 — Wire `estimate` badge + position filter; AA-safe styling.
- [ ] N5-S3-T4 — Unit-test interval invariants (lo ≤ point ≤ hi; missing-bound degrade) + e2e render.
**QA coverage:**
- N5-S3-AC1 → `tests/feature/players_view.test.mjs::interval-contains-point` (unit) — Planned
- N5-S3-AC2 → `tests/feature/players_view.test.mjs::estimate-badge` (unit) — Planned
- N5-S3-AC3 → `tests/feature/contrast_aa.test.mjs::interval-bar` (contrast) + `tests/web/players.spec.mjs::position-filter` (e2e-web) — Planned
- N5-S3-AC4 → `tests/feature/players_view.test.mjs::missing-bound-degrade` (unit) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test) | contrast(AA) | e2e-web.
**Traceability:** `app/views/players.js` (new), `app/render.js` (new), `app/data.js`, `data/player_projections.json`.

### N5-S4 — Parlays view (edge, correlation, tier)   ·  Status: 🟡   ·  Est: M
**As** an Analyst **I want** each parlay's legs with model-vs-implied edge, correlation notes, and a tier **so that** I judge whether the "edge" is real or noise.
**Acceptance criteria:**
- N5-S4-AC1 — Given `data/parlays.json`, When a parlay renders, Then each leg shows model prob, implied (market) prob, and their signed edge (model − implied), with edge sign color-coded (positive/negative tokens).
- N5-S4-AC2 — Given correlated legs, When rendered, Then the parlay shows its correlation note and does NOT present naive-independent combined odds as if legs were independent.
- N5-S4-AC3 — Given the builder invariant, When the view loads a week, Then it displays ≥ 3 parlays per game (and the contract is validated to that floor upstream).
- N5-S4-AC4 — Given a tier label, When rendered, Then each parlay shows its tier badge and, on a day-zero/unfitted model, an `ESTIMATE` state so edges are not read as fitted.
**Tasks:**
- [ ] N5-S4-T1 — Build `app/views/parlays.js` reading `parlays` + `meta` via `app/data.js`.
- [ ] N5-S4-T2 — Render per-leg edge (model/implied/edge) + tier badge via `app/render.js`.
- [ ] N5-S4-T3 — Surface correlation notes; suppress naive-independent combined odds when correlated.
- [ ] N5-S4-T4 — Unit-test edge math + ≥3/game floor + honest-state; add e2e render.
**QA coverage:**
- N5-S4-AC1 → `tests/feature/parlays_view.test.mjs::edge-model-minus-implied` (unit) — Planned
- N5-S4-AC2 → `tests/feature/parlays_view.test.mjs::correlated-no-naive-odds` (unit) — Planned
- N5-S4-AC3 → `tests/feature/parlay_rules.test.mjs::min-three-per-game` (unit, exists) — Done
- N5-S4-AC4 → `tests/web/parlays.spec.mjs::tier-and-estimate` (e2e-web) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test) | e2e-web.
**Traceability:** `app/views/parlays.js` (new), `app/render.js` (new), `app/data.js`, `data/parlays.json`, `tests/feature/parlay_rules.test.mjs`.

### N5-S5 — Team identity tints (AA-safe)   ·  Status: ⬜   ·  Est: S
**As** a Modeler **I want** AA-safe per-team color tints in one module **so that** team identity reads on the dark theme without ever failing contrast.
**Acceptance criteria:**
- N5-S5-AC1 — Given `app/teams.js`, When a team tint is used as a surface/background, Then its paired text/graphic token meets AA (text ≥ 4.5:1, graphics ≥ 3:1) and is included in the P7-S5 pairing set.
- N5-S5-AC2 — Given a team not in the map, When rendered, Then a neutral token fallback is used (no undefined tint, no raw hex leak).
- N5-S5-AC3 — Given the tint map, When audited, Then every value is a `--token` reference (tints live in the theme layer, not hard-coded in views).
**Tasks:**
- [ ] N5-S5-T1 — Author `app/teams.js` mapping team → tint token (32 teams).
- [ ] N5-S5-T2 — Add each tint pairing to the contrast test enumeration.
- [ ] N5-S5-T3 — Neutral fallback for unknown teams; grep guard against raw hex.
**QA coverage:**
- N5-S5-AC1 → `tests/feature/contrast_aa.test.mjs::team-tints-checked` (contrast) — Planned
- N5-S5-AC2 → `tests/feature/teams.test.mjs::unknown-team-fallback` (unit) — Planned
- N5-S5-AC3 → `tests/smoke.sh::tints-are-tokens` (smoke) — Planned
- Coverage: 3/3 = 100%. Test types: contrast(AA) | unit(node:test) | smoke(bash).
**Traceability:** `app/teams.js` (new), `app/theme.css` (new), `tests/feature/contrast_aa.test.mjs`.

### N5-S6 — Live in-game view + game detail   ·  Status: ⬜   ·  Est: L
**As** an Analyst **I want** a live in-game view and a per-game detail drill-down **so that** I can watch the model update against the live score — with FINAL-only results honored.
**Acceptance criteria:**
- N5-S6-AC1 — Given the live feed (N6 `/api/nfl`), When a game is in progress, Then the live view shows current score + game state as DISPLAY-ONLY and never renders it as a settled result (STATUS-gating: only FINAL settles — see N6).
- N5-S6-AC2 — Given a tap on a slate game, When the detail view opens (`#/games/:id`), Then it shows the probability vector, key player projections for that game, and any parlays touching it.
- N5-S6-AC3 — Given the live poller errors, When the view is open, Then it falls back gracefully (last durable `data/actual_results` value) and shows `DATA · DEGRADED`, not a frozen "live" number.
- N5-S6-AC4 — Given a FINAL result arrives, When the live view updates, Then it transitions the game to a settled state consistent with the durable git-pipeline record.
**Tasks:**
- [ ] N5-S6-T1 — Add live route + `app/views/live` consuming `app/live-scores.js`/`app/live-poller.js` (N6).
- [ ] N5-S6-T2 — Add `#/games/:id` detail route joining predictions + projections + parlays.
- [ ] N5-S6-T3 — Enforce display-only vs settled rendering via the shared STATUS gate.
- [ ] N5-S6-T4 — e2e for live→final transition and degraded fallback.
**QA coverage:**
- N5-S6-AC1 → `tests/feature/status_gate.test.mjs::live-is-display-only` (unit) — Planned
- N5-S6-AC2 → `tests/web/game_detail.spec.mjs::detail-join` (e2e-web) — Planned
- N5-S6-AC3 → `tests/web/live.spec.mjs::degraded-fallback` (e2e-web) — Planned
- N5-S6-AC4 → `tests/feature/status_gate.test.mjs::final-settles` (unit) — Planned
- Coverage: 4/4 = 100%. Test types: unit(node:test) | e2e-web.
**Traceability:** `app/views/*` (new), `app/live-scores.js` (new, N6), `app/live-poller.js` (new, N6), `app/render.js` (new), `app/data.js`.
