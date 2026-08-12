# Phase 2 · Head-to-Head Compare

**Status:** ⬜ Design (scaffold — not built)
**Layer:** NFL UI (extends N5) · reuses P7 design system, `app/render.js` primitives, `app/team-logic.js` fit engine, `app/data.js` contract reader.
**Lenses served:** DRAFT (who to pick / who to draft next) **and** ONGOING MANAGEMENT (who to start / who to sit / who to trade for).

> This is a design + backlog document. It specifies a new lightweight surface — a two-player side-by-side comparison — that renders **only** from the existing validated contracts through existing helpers. It computes nothing new about players: every number already exists in `player_projections`, `player_weekly`, `player_history` / `ai_insights`, `team_strength`, `adp`, and `player_usage`. The compare surface is a **re-arrangement** of data the Players and Team views already show, placed two-up so a decision between two names is a glance, not a scroll-and-remember.

---

## 1. Design

### 1.1 Problem & why a new surface

Both core decisions in fantasy — *draft this player or that one?* and *start this player or that one?* — are **pairwise**. The Players view (`#/players`) is a ranked one-column list: comparing two players there means scrolling, holding one card's numbers in your head, and finding the other. The Team draft room (`#/team`) ranks a whole pool but never puts two specific names beside each other on equal footing. Head-to-Head Compare is the missing pairwise surface: pick two players, see every decision-relevant metric side by side with the edge called out, under a lens (DRAFT or START/SIT) that orders the metrics for the decision at hand.

Design tenets (inherited standing rules):
- **No new model math.** Compare reads contracts and calls existing pure functions (`vorScore`, `strengthOfSchedule`, `trendLabel`, `weeklyPoints`, `byeWeek`, `scoringAdjust`). It never invents a projection or a ranking.
- **Reuse render primitives + theme tokens.** `renderTrendChip`, `renderSos`, `renderWeekStrip` from `app/render.js` and the token palette in `app/theme.css` (`--brand`, `--accent`, `--pos`, `--home`, `--away`, `--muted`, `--surface-2`). No new colors.
- **Honest by construction.** Every projection stays labeled `ESTIMATE`; a missing feed (older deploy 404) hides its row, never blanks the surface; market prices are never shown as an input.
- **Stateless + deep-linkable.** The two picks live in the URL hash (`#/compare?a=<id>&b=<id>`) so a comparison is shareable and survives reload with no login and no storage requirement. (A `nfl2026.compare.v1` tray in `localStorage` is a convenience mirror, not the source of truth.)
- **13" iPad first, iPhone graceful.** Two columns side by side on iPad/landscape; the same two columns stack (A above B) with a sticky metric rail on narrow iPhone widths.

### 1.2 Surface & routing

A new route `#/compare` mounted exactly like the other lazy views (`app/main.js` `ROUTES` map), reading its two subjects from the hash query:

```
#/compare?a=espn-3117251&b=espn-4430807&lens=draft&pos=RB
```

- `a`, `b` — `gsis_id`s of the two players (either may be empty → that column shows an inline finder).
- `lens` — `draft` (default) | `startsit`.
- `pos` — optional filter passed to the finder / to the VOR pool selection.

Parsing the hash query keeps Compare a first-class bookmarkable/shareable object with zero backend, consistent with the app's no-login posture. `main.js`'s router currently keys on the bare hash; Compare needs the query string stripped before the route lookup (a one-line `hash.split('?')[0]` normalization in `renderRoute`).

**Not a new tab.** To avoid crowding the 5-tab bar (Slate/Players/Parlays/Team/Model), Compare has **no tab**. It is reached by action, not navigation:
1. From **Players** cards — a `COMPARE` affordance adds the player to a compare tray.
2. From the **Team** finder rows and reco rows — same tray.
3. Directly via a shared/bookmarked `#/compare?...` link.
4. From the compare view itself — each column has an inline finder to pick or swap either side.

### 1.3 The compare tray (entry pattern)

A slim, dismissible **compare tray** (a bottom pill above the tab bar, `--surface-2`, safe-area-aware) appears the moment one player is marked for compare and disappears when cleared:

```
┌─────────────────────────────────────────────┐
│  COMPARE:  [ C. McCaffrey ✕ ]  [ + add ]     │  ← 1 selected
│            [ Compare → ]  (disabled until 2) │
└─────────────────────────────────────────────┘
```

- Holds **exactly two** slots. Marking a third replaces the older selection (FIFO) with a tiny toast ("swapped in Bijan Robinson").
- `Compare →` navigates to `#/compare?a=..&b=..` at the current scoring mode + lens.
- The tray is one small shared module (`app/compare-tray.js`) that Players and Team import; it owns the `nfl2026.compare.v1` selection and repaints itself. Card affordance = a `.cmp-pick` button on `.card.player` (Players) and `.fnd-row` (Team finder) that toggles membership.

### 1.4 Layout — the compare view

Two equal columns under a shared control bar; rows are **metric-aligned** (each metric is one horizontal band spanning both columns with a center **edge chip** naming the winner and the margin):

```
┌───────────────── COMPARE ─────────────────┐
│  [DRAFT | START/SIT]   [PPR|HALF|STD]      │  ← lens seg + scoring seg (shared keys)
├──────────────────┬──────────┬──────────────┤
│  C. McCaffrey    │          │  Bijan Robin.│  ← identity headers (team tint, pos)
│  RB · SF         │          │  RB · ATL    │
├──────────────────┼──────────┼──────────────┤
│  416.6           │  +23.4 ◀ │  393.2       │  PROJ PTS (scoring-adjusted)  ESTIMATE
│  [287 ▓▓▓▓░ 546] │          │ [270 ▓▓▓░ 512]│  80% conformal interval bars
├──────────────────┼──────────┼──────────────┤
│  ▲ +27.0/yr 5-YR │  even    │ ▲ +18.1/yr   │  TREND (renderTrendChip)
│  SOS 3.4 ▓▓▓░░   │  B eas.◀ │ SOS 2.9 ▓▓░░ │  STRENGTH OF SCHEDULE (renderSos)
│  BYE W9          │  ⚠ same  │ BYE W9       │  BYE
│  VOR +71.2       │  A ◀     │ VOR +54.0    │  VALUE OVER REPLACEMENT (draft lens)
│  ADP 1.1 (rank1) │  A value │ ADP 1.8      │  ADP + value vs draft cost (draft lens)
│  tgt share 23%   │  A ◀     │ tgt share 19%│  USAGE (player_usage, id-joined)
├──────────────────┴──────────┴──────────────┤
│  [W1 W2 … W18 sparkline, both overlaid]     │  WEEKLY (renderWeekStrip ×2 or overlay)
└─────────────────────────────────────────────┘
```

- **Edge chip** (`.cmp-edge`) is the heart of the surface: for each numeric metric it shows which side wins and by how much, using `--pos` for the leader's margin and a neutral `even` when within an epsilon. The chip is the *accessible source of truth* (text + arrow glyph), never color alone — same discipline as `renderSos`.
- **Higher-is-better vs lower-is-better** is per-metric and explicit: PROJ/VOR/usage → higher wins; SOS/ADP/bye-risk → lower is "easier/cheaper," labeled "easier"/"value" not "better" so the meaning is never ambiguous.
- On iPhone the three-cell band collapses to a stacked pair with the edge chip between them; the metric label pins to a sticky left rail.

### 1.5 The two lenses

A `.cmp-lens` segmented control (BASE/AI+ visual pattern from `players.js` `aiSegRow`) reorders and re-weights which rows lead. **Same data, decision-appropriate ordering** — nothing is hidden, the lead metrics just change:

| Row | DRAFT lens order | START/SIT lens order |
|---|---|---|
| Season PROJ + interval | 1 (lead) | 3 |
| VOR (value over replacement) | 2 | — (hidden; not a weekly concept) |
| ADP + value-vs-cost | 3 | — (hidden) |
| Positional rank | 4 | 6 |
| **This-week points** (weeks[wk]) | 6 | **1 (lead)** |
| **This-week matchup** (opp + opp Elo) | — | **2** |
| Trend (5-yr) | 5 | 5 |
| SoS (full season) | 7 | 4 (rest-of-season difficulty) |
| Bye | 8 | 7 (with "on bye THIS week" hard flag) |
| Usage (target share / rush att / RZ) | 9 | 8 |
| Weekly strip | footer | footer (current week highlighted) |

- **DRAFT lens** answers "which player is the better *pick*" — leads with season value and scarcity (VOR against the still-available pool), and flags ADP value (a player going later than his projection rank is a "value," earlier is a "reach"). This is the same VOR/ADP machinery the Team draft room already runs; Compare just isolates two candidates.
- **START/SIT lens** answers "which player do I *start this week*" — leads with the current week's projected points and this week's opponent difficulty, hard-flags a player **on bye this week** (a zero, not a low projection), and treats SoS as rest-of-season context. `wk` comes from `game_predictions.week` (the same source the topbar week chip reads).

### 1.6 Honesty & degradation (load-bearing)

- Every projection carries the `ESTIMATE` label; the interval bar reuses the players-card `.interval` treatment so uncertainty is visible, not a bare number.
- **Feed-optional rows self-hide.** `player_weekly` / `player_history` / `ai_insights` / `team_strength` / `adp` / `player_usage` each 404 on older deploys — `Promise.allSettled` per feed (the `players.js` pattern); a missing feed drops its row(s) with a one-line "trend unavailable on this build" note, never a blank column.
- **Usage id-join is honest.** `player_usage.json` keys by nflverse gsis (`00-0033280`) while projections key by ESPN id (`espn-3117251`). Compare joins on the crosswalk when present and, when a player has no usage match, renders "usage: not matched" for that side rather than fabricating a share. (Ownership of the crosswalk is a task in C1-S6.)
- **Market prices never appear** on Compare — it is a projection/decision surface, not a betting one.
- Duplicate pick (`a === b`) and empty picks render honest inline states, never a broken diff.

### 1.7 Accessibility & responsive (P7 gate)

- All new color pairings pass WCAG AA graphics ≥ 3:1 / text ≥ 4.5:1 — covered by extending `tests/feature/contrast_aa.test.mjs`. Edge/winner is text+glyph, never color-only.
- Two columns use CSS grid `grid-template-columns: 1fr auto 1fr` on iPad; a `@media (max-width: 560px)` collapses to a single column with the metric rail sticky. Reuses existing breakpoints in `theme.css`.
- `#view` focus handling and `aria-live` already exist in `main.js`; the lens/scoring segs are `role="group"` with `aria-pressed`, matching `renderScoreSeg`.

---

## 2. How it serves BOTH lenses (draft + ongoing management)

The surface is a single component with a lens switch, so the **same** two-column diff serves the whole season:

- **Draft day (draft lens).** During a live draft in the Team room, mark two players you're torn between → Compare → the VOR + ADP-value rows say which is the better pick *given who's already gone* (VOR reads the available pool). This is the pairwise view the draft room's top-5 reco can't give you between two specific names.
- **Weekly management (start/sit lens).** Every week, two flex-worthy players → Compare → this-week points, this-week matchup difficulty, and a hard bye flag decide the lineup. The weekly strip footer shows both players' full 18-week shape with the current week highlighted, so a start/sit call also reveals the rest-of-season trade context.
- **Trade evaluation (either lens).** Comparing a player you own against one you'd acquire is the same surface; the season-long DRAFT lens values the asset, the START/SIT lens values it this week.

One code path, one design, one test suite — the lens is the only thing that changes, so ongoing-management value is delivered at essentially no marginal cost over the draft-day build.

---

## 3. Epics → user stories → acceptance criteria → QA

### Epic C1 · Head-to-Head Compare
**Goal:** a lightweight, deep-linkable two-player comparison surface serving draft and start/sit lenses, built entirely from existing contracts + render primitives.
**Reuse seam:** `#/compare` renders from `app/data.js` getters through `app/render.js` primitives and `app/team-logic.js` pure functions; a future adapter re-authors the row set + labels but keeps the two-column + edge-chip + lens machinery.

---

#### C1-S1 — Compare route + hash-query state · Est: M
**As** a manager **I want** a `#/compare?a=..&b=..` surface **so that** a two-player comparison is a bookmarkable, shareable object with no login.
**Acceptance criteria:**
- C1-S1-AC1 — Given a hash `#/compare?a=<id>&b=<id>`, When it loads, Then the router mounts the compare view with both players resolved from `player_projections`; the query string does not break route lookup for other tabs.
- C1-S1-AC2 — Given only `a` (or neither), When mounted, Then the missing column renders an inline finder, not an error.
- C1-S1-AC3 — Given `lens` / `pos` params, When present, Then they set the initial lens + finder filter; absent → `draft` / no filter.
- C1-S1-AC4 — Given a swap/clear action in-view, When the picks change, Then `location.hash` updates (history-replace, no scroll jump) so reload/share reflects the current pair.
**Tasks:**
- [ ] C1-S1-T1 — Add `'#/compare'` to `ROUTES` in `app/main.js`; normalize `hash.split('?')[0]` before lookup.
- [ ] C1-S1-T2 — `app/views/compare.js` parses `a/b/lens/pos` from `location.hash`.
- [ ] C1-S1-T3 — Resolve ids → players via `getPlayerProjections`; empty-slot → finder.
**QA coverage:**
- C1-S1-AC1 → `tests/feature/compare_view.test.mjs::route-parses-two-ids` (unit) — Planned
- C1-S1-AC2 → `tests/feature/compare_view.test.mjs::empty-slot-shows-finder` (unit) — Planned
- C1-S1-AC3 → `tests/feature/compare_view.test.mjs::lens-and-pos-params` (unit) — Planned
- C1-S1-AC4 → `tests/web/compare.spec.mjs::hash-reflects-picks` (e2e-web) — Planned
- Coverage: 4/4 = 100%. Types: unit(node:test) | e2e-web.
**Traceability:** `app/main.js`, `app/views/compare.js` (new), `app/data.js`.

#### C1-S2 — Compare tray + card entry points · Est: M
**As** a manager **I want** a `COMPARE` affordance on Players cards and Team finder rows **so that** I collect two players without leaving my flow.
**Acceptance criteria:**
- C1-S2-AC1 — Given a `.card.player` (Players) or `.fnd-row` (Team finder), When I tap its `COMPARE` control, Then the player joins a shared two-slot tray; a second tap removes it.
- C1-S2-AC2 — Given two players trayed, When I tap `Compare →`, Then I navigate to `#/compare?a=..&b=..` carrying the current scoring mode + lens.
- C1-S2-AC3 — Given a third pick, When added, Then the oldest slot is replaced (FIFO) with a toast; the tray never holds more than two.
- C1-S2-AC4 — Given an empty tray, When nothing is selected, Then the tray is not shown (no persistent chrome).
**Tasks:**
- [ ] C1-S2-T1 — `app/compare-tray.js` owns `nfl2026.compare.v1` selection + renders the tray pill (safe-area aware, above `.tabbar`).
- [ ] C1-S2-T2 — Add `.cmp-pick` control to `renderPlayerCard` (guarded opt, off by default) and to Team finder rows in `app/views/team.js`.
- [ ] C1-S2-T3 — Wire toggle + FIFO + navigate; storage failures degrade to in-memory.
**QA coverage:**
- C1-S2-AC1 → `tests/feature/compare_tray.test.mjs::toggle-membership` (unit) — Planned
- C1-S2-AC2 → `tests/web/compare.spec.mjs::tray-navigates-with-scoring` (e2e-web) — Planned
- C1-S2-AC3 → `tests/feature/compare_tray.test.mjs::fifo-cap-two` (unit) — Planned
- C1-S2-AC4 → `tests/web/compare.spec.mjs::empty-tray-hidden` (e2e-web) — Planned
- Coverage: 4/4 = 100%. Types: unit(node:test) | e2e-web.
**Traceability:** `app/compare-tray.js` (new), `app/render.js`, `app/views/players.js`, `app/views/team.js`.

#### C1-S3 — Side-by-side layout + edge chips + render reuse · Est: L
**As** a manager **I want** metric-aligned columns with a winner/margin chip per row **so that** the better option is a glance, not arithmetic.
**Acceptance criteria:**
- C1-S3-AC1 — Given two resolved players, When rendered, Then each metric is one band spanning both columns with a center `.cmp-edge` chip naming the leader and the signed margin (text + glyph, never color-only).
- C1-S3-AC2 — Given a metric where lower is easier/cheaper (SOS/ADP), When compared, Then the chip labels it "easier"/"value", not "better", and picks the correct side.
- C1-S3-AC3 — Given a near-tie (|Δ| ≤ ε), When rendered, Then the chip reads "even" and favors neither.
- C1-S3-AC4 — Given the trend / SoS / weekly rows, When rendered, Then they reuse `renderTrendChip` / `renderSos` / `renderWeekStrip` from `app/render.js` unchanged.
**Tasks:**
- [ ] C1-S3-T1 — Pure `compareRow(metricSpec, a, b)` helper (dir: higher|lower, formatter, ε) → `{ leader, marginText }`.
- [ ] C1-S3-T2 — `app/views/compare.js` grid `1fr auto 1fr`; iPhone collapse `@media`.
- [ ] C1-S3-T3 — Reuse render primitives; add only `.cmp-*` classes to `app/theme.css`.
**QA coverage:**
- C1-S3-AC1 → `tests/feature/compare_view.test.mjs::edge-chip-leader-and-margin` (unit) — Planned
- C1-S3-AC2 → `tests/feature/compare_view.test.mjs::lower-is-easier-metrics` (unit) — Planned
- C1-S3-AC3 → `tests/feature/compare_view.test.mjs::near-tie-is-even` (unit) — Planned
- C1-S3-AC4 → `tests/web/compare.spec.mjs::reuses-render-primitives` (e2e-web) — Planned
- Coverage: 4/4 = 100%. Types: unit(node:test) | e2e-web.
**Traceability:** `app/views/compare.js` (new), `app/render.js`, `app/theme.css`.

#### C1-S4 — DRAFT lens (VOR + ADP value + rank) · Est: M
**As** a drafter **I want** the draft lens to lead with season value, VOR, and ADP value **so that** I pick the better player given who's gone.
**Acceptance criteria:**
- C1-S4-AC1 — Given the draft lens, When rendered, Then rows lead with scoring-adjusted season PROJ + interval, then VOR, then ADP value, per §1.5.
- C1-S4-AC2 — Given `vorScore` against the available pool (projections minus trayed/taken ids when arriving from the Team room), When shown, Then each side's VOR matches `app/team-logic.js` `vorScore` exactly (no re-implementation).
- C1-S4-AC3 — Given `adp.json`, When present, Then each player shows ADP and a value flag: projection-rank earlier than ADP = "value," later = "reach"; absent ADP feed → row hidden.
- C1-S4-AC4 — Given the scoring seg (PPR/HALF/STD, shared `nfl2026.scoring.v1`), When toggled, Then all adjusted numbers + VOR recompute via `scoringAdjust`.
**Tasks:**
- [ ] C1-S4-T1 — Wire `vorScore` / positional rank from the projection pool (respect taken/tray exclusions).
- [ ] C1-S4-T2 — Join `getAdp`; compute projection-rank-vs-ADP value flag.
- [ ] C1-S4-T3 — Bind scoring seg to shared key; recompute on change.
**QA coverage:**
- C1-S4-AC1 → `tests/feature/compare_view.test.mjs::draft-lens-row-order` (unit) — Planned
- C1-S4-AC2 → `tests/feature/compare_view.test.mjs::vor-matches-team-logic` (unit) — Planned
- C1-S4-AC3 → `tests/feature/compare_view.test.mjs::adp-value-flag` (unit) — Planned
- C1-S4-AC4 → `tests/web/compare.spec.mjs::scoring-recompute` (e2e-web) — Planned
- Coverage: 4/4 = 100%. Types: unit(node:test) | e2e-web.
**Traceability:** `app/views/compare.js` (new), `app/team-logic.js`, `app/data.js`, `data/adp.json`.

#### C1-S5 — START/SIT lens (this-week points + matchup + bye) · Est: M
**As** a manager **I want** the start/sit lens to lead with this week's points, opponent difficulty, and a bye flag **so that** I set my lineup fast.
**Acceptance criteria:**
- C1-S5-AC1 — Given `game_predictions.week` = W and `player_weekly`, When start/sit lens renders, Then each side leads with this week's projected points (`weeks[W-1].pts` at the active scoring ratio) and the week's opponent (`@OPP` / `OPP`).
- C1-S5-AC2 — Given a player on bye in week W, When rendered, Then the side hard-flags "ON BYE — W{W}" (a zero, not a low number) and the edge chip favors the other side regardless of season projection.
- C1-S5-AC3 — Given `team_strength`, When shown, Then this-week matchup difficulty = the opponent's Elo mapped to the SoS scale, and the SoS row reads as rest-of-season difficulty via `strengthOfSchedule`.
- C1-S5-AC4 — Given `player_weekly` absent, When start/sit lens is requested, Then it degrades to season-only with an honest "weekly split unavailable" note (no fabricated weekly points).
**Tasks:**
- [ ] C1-S5-T1 — Read current week from `getGamePredictions`; index `weeks[W-1]`; reuse `weeklyPoints` ratio.
- [ ] C1-S5-T2 — Bye detection via `byeWeek`; hard-flag + edge override.
- [ ] C1-S5-T3 — Opponent-Elo lookup from `team_strength.ratings` for the week's `opp`.
**QA coverage:**
- C1-S5-AC1 → `tests/feature/compare_view.test.mjs::startsit-this-week-points` (unit) — Planned
- C1-S5-AC2 → `tests/feature/compare_view.test.mjs::bye-hard-flag-overrides-edge` (unit) — Planned
- C1-S5-AC3 → `tests/feature/compare_view.test.mjs::this-week-matchup-difficulty` (unit) — Planned
- C1-S5-AC4 → `tests/feature/compare_view.test.mjs::weekly-absent-degrades` (unit) — Planned
- Coverage: 4/4 = 100%. Types: unit(node:test).
**Traceability:** `app/views/compare.js` (new), `app/team-logic.js`, `app/data.js`.

#### C1-S6 — Usage row (id-joined, honest) · Est: S
**As** a manager **I want** a usage row (target share / rush att / RZ touches) **so that** I compare opportunity, not just projection.
**Acceptance criteria:**
- C1-S6-AC1 — Given `player_usage.json` (nflverse-keyed) and a projection player (ESPN-keyed), When joined, Then usage is matched via the crosswalk and target share / rush att / RZ touches show for each side.
- C1-S6-AC2 — Given no usage match for a side, When rendered, Then that side reads "usage: not matched" and the edge chip is suppressed for the row (no fabricated share).
- C1-S6-AC3 — Given `player_usage.json` absent, When rendered, Then the whole usage row hides.
**Tasks:**
- [ ] C1-S6-T1 — Add `getPlayerUsage` getter to `app/data.js` (404-graceful, promise-cached).
- [ ] C1-S6-T2 — id crosswalk (reuse an existing map if one exists; else name+team fallback join, documented as best-effort).
- [ ] C1-S6-T3 — Suppress edge chip on unmatched/partial rows.
**QA coverage:**
- C1-S6-AC1 → `tests/feature/compare_view.test.mjs::usage-id-join` (unit) — Planned
- C1-S6-AC2 → `tests/feature/compare_view.test.mjs::usage-unmatched-honest` (unit) — Planned
- C1-S6-AC3 → `tests/feature/compare_view.test.mjs::usage-feed-absent-hides` (unit) — Planned
- Coverage: 3/3 = 100%. Types: unit(node:test).
**Traceability:** `app/data.js`, `app/views/compare.js` (new), `data/player_usage.json`.

#### C1-S7 — Honest states (empty / duplicate / degraded) · Est: S
**As** a manager **I want** honest empty/duplicate/missing states **so that** the surface never lies or blanks.
**Acceptance criteria:**
- C1-S7-AC1 — Given `a === b`, When rendered, Then a "pick two different players" state shows, no zero-margin diff.
- C1-S7-AC2 — Given an unresolvable id (dropped player), When rendered, Then that column shows "player not in current pool" + a finder, other column intact.
- C1-S7-AC3 — Given any optional feed 404 (`player_weekly`/`player_history`/`ai_insights`/`team_strength`/`adp`/`player_usage`), When mounted, Then only that feed's rows hide with a one-line note; the surface renders.
- C1-S7-AC4 — Given `player_projections` itself fails, When mounted, Then a single `DATA · DEGRADED` state shows (the only hard dependency).
**Tasks:**
- [ ] C1-S7-T1 — `Promise.allSettled` per feed (players.js pattern); per-row presence guards.
- [ ] C1-S7-T2 — Duplicate + unresolved-id states.
**QA coverage:**
- C1-S7-AC1 → `tests/feature/compare_view.test.mjs::duplicate-pick-state` (unit) — Planned
- C1-S7-AC2 → `tests/feature/compare_view.test.mjs::unresolved-id-state` (unit) — Planned
- C1-S7-AC3 → `tests/feature/compare_view.test.mjs::optional-feed-404-degrades` (unit) — Planned
- C1-S7-AC4 → `tests/web/compare.spec.mjs::projections-fail-degraded` (e2e-web) — Planned
- Coverage: 4/4 = 100%. Types: unit(node:test) | e2e-web.
**Traceability:** `app/views/compare.js` (new), `app/data.js`.

#### C1-S8 — A11y, iPad/iPhone responsive, AA contrast · Est: S
**As** any user **I want** the surface accessible and correct on iPad and iPhone **so that** it meets the P7 gate.
**Acceptance criteria:**
- C1-S8-AC1 — Given all new `.cmp-*` color pairings, When contrast-checked, Then graphics ≥ 3:1 / text ≥ 4.5:1 (AA), extending `contrast_aa.test.mjs`.
- C1-S8-AC2 — Given a 13" iPad viewport, When rendered, Then two columns sit side by side; given ≤ 560px, Then they stack with a sticky metric rail.
- C1-S8-AC3 — Given the lens + scoring segs, When rendered, Then they are `role="group"` with `aria-pressed`, keyboard-operable, and focus lands on `#view` on mount (existing `main.js` behavior).
**Tasks:**
- [ ] C1-S8-T1 — Add `.cmp-*` token usages; register pairings in the contrast test.
- [ ] C1-S8-T2 — Grid + `@media` collapse; iPad + iPhone Playwright viewports.
**QA coverage:**
- C1-S8-AC1 → `tests/feature/contrast_aa.test.mjs::compare-edge-and-columns` (contrast) — Planned
- C1-S8-AC2 → `tests/web/compare.spec.mjs::ipad-two-col-iphone-stack` (e2e-web) — Planned
- C1-S8-AC3 → `tests/web/compare.spec.mjs::segs-aria-and-focus` (e2e-web) — Planned
- Coverage: 3/3 = 100%. Types: contrast(AA) | e2e-web.
**Traceability:** `app/theme.css`, `app/views/compare.js` (new), `tests/feature/contrast_aa.test.mjs`.

#### C1-S9 — Smoke + gate wiring · Est: S
**As** a maintainer **I want** Compare in the regression gate **so that** it can never ship red.
**Acceptance criteria:**
- C1-S9-AC1 — Given `tests/smoke.sh`, When run, Then it asserts `app/views/compare.js` + `app/compare-tray.js` exist and `#/compare` is registered in `main.js`.
- C1-S9-AC2 — Given the fast gate (`node --test tests/feature/*.mjs`), When run, Then `compare_view.test.mjs` + `compare_tray.test.mjs` pass with zero npm installs (stdlib/builtins only).
- C1-S9-AC3 — Given `no-raw-data-fetch-in-views`, When smoke runs, Then `compare.js` uses only `app/data.js` getters (no direct `/data/*` fetch).
**Tasks:**
- [ ] C1-S9-T1 — Extend `tests/smoke.sh` file-exists + route checks.
- [ ] C1-S9-T2 — Ensure new feature tests are picked up by the `tests/feature/*.mjs` glob.
**QA coverage:**
- C1-S9-AC1 → `tests/smoke.sh::compare-files-and-route` (smoke) — Planned
- C1-S9-AC2 → `tests/run_gate.sh` step 3 green (gate) — Planned
- C1-S9-AC3 → `tests/smoke.sh::no-raw-data-fetch-in-views` (smoke) — Planned
- Coverage: 3/3 = 100%. Types: smoke(bash) | gate.
**Traceability:** `tests/smoke.sh`, `tests/run_gate.sh`, `tests/feature/`.

**Epic QA roll-up:** 33 ACs → 33 mapped tests = **100%**. Types: unit(node:test), e2e-web(Playwright), contrast(AA), smoke(bash).

---

## 4. File-by-file change plan

### New files
- **`app/views/compare.js`** — the compare view. Parses `a/b/lens/pos` from the hash; `Promise.allSettled` loads `getPlayerProjections` (hard dep) + `getPlayerWeekly` / `getPlayerHistory` / `getAiInsights` / `getTeamStrength` / `getAdp` / `getPlayerUsage` (optional). Builds a per-metric row spec (label, `dir: higher|lower`, formatter, ε, lens visibility), renders the `1fr auto 1fr` grid, reuses `renderTrendChip`/`renderSos`/`renderWeekStrip`, and wires the lens + scoring segs. Mirrors the structure/heading comment style of `app/views/players.js`. Owns its own local markup (render.js stays integrator-owned).
- **`app/compare-tray.js`** — shared two-slot selection + tray pill. Owns `nfl2026.compare.v1`; exports `toggle(id)`, `slots()`, `mountTray(root)`; imported by Players + Team. Storage-failure tolerant (in-memory fallback), FIFO cap 2, safe-area-aware pill above `.tabbar`.
- **`tests/feature/compare_view.test.mjs`** — pure unit tests for the row-spec/edge-chip/lens logic (extract the pure `compareRow` + lens-ordering into testable exports). Node built-in `node:test`, zero deps.
- **`tests/feature/compare_tray.test.mjs`** — unit tests for toggle/FIFO/cap-two.
- **`tests/web/compare.spec.mjs`** — Playwright e2e: route parse, tray → navigate, scoring recompute, iPad 2-col / iPhone stack, a11y segs.

### Edited files
- **`app/main.js`** — add `'#/compare'` to `ROUTES` (lazy `import('./views/compare.js')`, no tab); in `renderRoute`, normalize `const key = (window.location.hash||'#/').split('?')[0]` before the `ROUTES` lookup so the query string routes correctly without breaking existing tabs. (Compare has no `.tab`; `setActiveTab` handles "no active tab" gracefully.)
- **`app/render.js`** — add a small guarded `.cmp-pick` affordance to `renderPlayerCard` behind an opt (`opts.compare === true`), off by default so every existing caller/test is byte-identical (same guard discipline as the existing `opts.weekly`/`opts.trend` adornments). No changes to existing primitives.
- **`app/data.js`** — add `getPlayerUsage` getter (`/data/player_usage.json`, 404-graceful, promise-cached), following the existing REL-getter comment pattern.
- **`app/views/players.js`** — pass `compare: true` to `renderPlayerCard`; delegate `.cmp-pick` clicks to `compare-tray.toggle`; mount the tray. No change to sorting/scoring/AI logic.
- **`app/views/team.js`** — add a `COMPARE` control to finder rows (and optionally reco rows) → `compare-tray.toggle`; mount the tray. The tray respects the draft room's `taken`/tray exclusions so the draft-lens VOR pool is correct.
- **`app/theme.css`** — add `.cmp-*` classes (grid, columns, `.cmp-edge`, tray pill, `@media (max-width:560px)` stack) using **existing tokens only** (`--surface-2`, `--brand`, `--pos`, `--muted`, `--home`, `--away`). No new color variables.
- **`tests/feature/contrast_aa.test.mjs`** — register the new `.cmp-edge` / column / tray pairings.
- **`tests/smoke.sh`** — assert the two new `app/` files exist, `#/compare` is registered, and `compare.js` contains no raw `/data/*` fetch.
- **`docs/ROADMAP.md`** — add a Phase 2 line pointing at this doc (optional, non-blocking).

### Data — no changes
No new contract, no schema change, no pipeline work. Compare consumes `player_projections`, `player_weekly`, `player_history`, `ai_insights`, `team_strength`, `adp`, `player_usage`, `game_predictions` exactly as emitted. The only data-adjacent risk is the **usage id crosswalk** (ESPN ↔ nflverse ids), handled as an honest best-effort join that degrades to "not matched" rather than requiring a pipeline change.

### Rollback
Single revert: Compare is additive and route-gated. Reverting the `main.js` `ROUTES` line + the `players.js`/`team.js` tray mounts removes the surface entirely; the guarded `renderPlayerCard` opt is inert when unused. One-line revert of the commit range restores byte-identical prior behavior.

---

## 5. Test & gate strategy

- **Fast gate stays dependency-free** (§`run_gate.sh`): all Compare *logic* (row spec, edge chip, lens ordering, VOR match, bye override, usage join, degradation) is unit-tested under `node --test` with no npm install — the pure functions are extracted from `compare.js` for direct import, mirroring how `team-logic.js` is tested.
- **Playwright** covers the wired surface (routing, tray navigation, scoring recompute, responsive iPad/iPhone, a11y) as the opt-in step-4 that CI runs.
- **Contrast** is a fast-gate feature test (`contrast_aa.test.mjs`), so AA can't regress silently.
- Ship only when `bash tests/run_gate.sh` is 100% green.
