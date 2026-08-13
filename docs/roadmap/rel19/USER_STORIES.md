# REL19 — BACKLOG: EPICS → USER STORIES → TASKS

**Release:** Custom league scoring + league shape. Paste a Sleeper league id, get that
league's exact scoring and exact roster shape, and have every player surface recalculate
from **real per-player components** — never from a rescaled PPR total.

**Authority:** `docs/roadmap/rel19/SOLUTION_DESIGN.md`. Where `ARCHITECTURE.md` or
`FEASIBILITY.md` disagree with it, SOLUTION_DESIGN wins and this backlog follows
SOLUTION_DESIGN. Every count quoted below was re-verified against the committed tree in
this pass, not copied forward.

**Actors.** *Manager* = the human playing fantasy football in the app. *System* = the
Python pipeline / GitHub-Actions runner. *Operator* = whoever runs the gate and ships.

**Owner decisions in force (not re-litigated):** **D1** paste a Sleeper league id,
auto-fetch that league's exact scoring, every value hand-editable afterwards. **D2** real
per-player component projections; custom scoring exact, never scaled off a PPR total.
**D3** all player surfaces recalculate (Players, Team draft room incl. VOR / ADP value /
auction dollars, Lineup optimizer, Compare) plus a new page to connect and edit scoring.

**Standing rules that bind every story:** no login and no commissioner tools (a pasted
league id is a public identifier, not a login); market prices display-only and never a
model input; no build step / bundler / framework; stdlib-only Python; honest data — never
fabricate, degrade loudly and visibly, runner-built feeds ship **dormant** rather than
faking values; learned signals start at weight 0 behind the never-regress promotion gate;
13-inch iPad first with iPhone graceful; dark-only tokens, AA contrast; fix only what is
scoped.

---

## 0. Release summary

| | |
|---|---|
| Epics | **6** |
| User stories | **25** |
| Tasks | **140** |
| Acceptance criteria | **153** |
| Automated AC coverage | **152 / 153 = 99.3%** — exactly one deploy-manual AC (§7) |
| New test files | **2** (`league_profile.test.mjs`, `components_reconcile.test.mjs`) |
| Build agents | **P1 first** → then P2 ∥ P3 ∥ P4 (§8) |
| Gate baseline to preserve | **277 unit** / **82 E2E** (74 web + 8 pwa) — re-counted this pass |

**Measured blast radius the whole backlog is written against** (SOLUTION_DESIGN §1,
re-verified here against the committed tree):

* The owner league **Omilia-US** (`1393691504228184064`) is **10 teams**, roster
  `QB RB RB WR WR TE FLEX K DEF · BN×4` = **nine starters including a K and a team
  defense**, **147** scoring keys of which **65 are non-zero**, caps
  `QB2 RB5 WR5 TE3 K2 DEF2`, `draft_rounds 3` with `max_keepers 1` (a **keeper** draft).
* The app today assumes **7 starters** (`STARTER_SLOTS` = `QB1 RB1 RB2 WR1 WR2 TE1 FLEX`,
  `team-logic.js:29`) with `STARTER_DEMAND {QB:1,RB:2,WR:2,TE:1}` (`:725`) and
  `MODELED = ['QB','RB','WR','TE']` (`:38`) — **no kicker, no team defense anywhere.**
* `data/player_projections.json` holds **300** rows carrying only a single PPR season
  total: top **Christian McCaffrey 416.6**, 300th **Noah Gray 38.8**. Kickers project
  **130–195** under the owner's rules, so merging K/DST into that pool would evict ~74
  offensive players — which is why K/DST get their own contract (§E4-S3).
* `replacementLevel()` (`team-logic.js:781`) computes replacement **per roster**
  (`ranked[demand + extra]`) while `fairDollars()` (`auction.js:107-108`) computes it
  **league-wide** (`Math.round(demand * leagueSize) - 1`). **Team count therefore has no
  effect on VOR today** — "this is a 10-team league" is currently a cosmetic fact.
* `app/views/compare.js:100` reads `Number(p.proj_points)` raw — Compare does not honour
  even today's PPR/HALF/STD toggle.
* Gate re-counted this pass: `node --test tests/feature/*.mjs` → **277 pass**;
  `tests/web/web.spec.mjs` **74**; `tests/pwa/standalone.spec.mjs` **8**. There is **no**
  `tests/competition.test.mjs`, **no** `tests/ux/`, **no** `tests/integrated/` — the gate
  is `bash tests/run_gate.sh`.

> **Backlog-wide precondition — the CORS leg.** The browser-direct `fetch()` of
> `api.sleeper.app` is proven at header level (`ACAO: *` on a GET carrying the production
> `Origin`) and by one browser-level header replay, but **has never run from a browser
> against Sleeper's own host** — the sandbox cannot distinguish transport from policy
> (a known-good `raw.githubusercontent.com` control fails identically). Every story below
> is written so this does **not** gate the release: the paste tier (R19-E1-S2) ships in
> the same release and is required by D1 regardless. **R19-E1-S1-AC7 is the 30-second
> production check that converts the inference to fact**, and it is the only manual AC in
> this backlog.

---

## EPIC R19-E1 · Connect my league — no login, no backend, no lost edits
**Owner:** P1 (profile core + store) with P4 (the page)
**Answers:** Q1 (CORS), Q8 (storage + sharing), D1
**Status:** 🔴 Not started

### Goal
A manager pastes a league id and the app knows their league: the exact 147 scoring values,
the exact roster shape, the caps, the keeper draft. It gets there with a plain
cross-origin `fetch()` from a static page — and when that path is unavailable for any
reason, the same screen accepts the league JSON pasted in, or a scoring table built by
hand from the PPR default. Every value stays editable forever, edits survive a re-fetch,
and "reset to league" is exact.

### Why it matters
Today the app offers three scoring modes and one 12-team assumption, and the owner's real
league matches none of them. The gap is not cosmetic: `pass_td` is **6.0** not 4.0 and
`pass_cmp` is **0.5**, which is roughly **200 extra points a season** for a starting QB.
Until the app can hold that table, every QB number it shows is denominated in the wrong
currency. And because there is no login and never will be, the connection has to work from
a public identifier alone, on one device, with a share path that carries no secret.

---

### R19-E1-S1 — "I paste league id 1393691504228184064 and the app detects 6-pt passing TDs and 0.5 per completion" · Est: L
**As** a Manager **I want** to paste my Sleeper league id on a new Scoring page and have
the app read my league's real scoring and roster **so that** I stop hand-translating my
league into "PPR-ish" and start seeing numbers that are actually mine.

**Acceptance criteria** (Given/When/Then):
- **R19-E1-S1-AC1** — Given the Scoring page at `#/scoring`, When I type
  `1393691504228184064` and press **FETCH**, Then the app performs one browser-direct
  `fetch('https://api.sleeper.app/v1/league/<id>')` with **`credentials: 'omit'`** and
  **no custom request headers** (so it stays a CORS *simple request* and is never
  preflighted), and within 12 s the page shows `CONNECTED · Omilia-US · 10 teams`.
- **R19-E1-S1-AC2 — the headline values, on screen** — Given the fetch succeeds, When the
  scoring table paints, Then `pass_td` reads **6.00**, `pass_cmp` reads **0.50**,
  `pass_yd` **0.04**, `pass_int` **−2.00**, `rec` **1.00**, `rec_yd` **0.10**,
  `fum_lost` **−2.00**, and the header reads **`65 of 147 keys non-zero`**.
- **R19-E1-S1-AC3 — the league is not PPR and the app says which keys differ** — Given the
  connected profile, When compared against `ESPN_PPR_DEFAULT`, Then the page names
  `pass_td 4.00 → 6.00` and `pass_cmp 0.00 → 0.50` as differences from the app default,
  and `isDefaultPpr(profile)` returns **false**.
- **R19-E1-S1-AC4 — shape, not just scoring** — Given the same payload, When the roster
  block paints, Then it reads `QB RB RB WR WR TE FLEX K DEF · BN×4 · IR×1`, **9 starters /
  4 bench / size 13**, caps `QB2 RB5 WR5 TE3 K2 DEF2`, and **`3-round keeper draft`** —
  `draftRounds` is taken from `settings.draft_rounds` (**3**) and **not** from roster size.
- **R19-E1-S1-AC5 — a bad id fails loudly and changes nothing** — Given I paste a
  non-existent id, an id with letters, or an empty string, When I press FETCH, Then the
  page shows a specific error (`no league with that id` / `that does not look like a
  Sleeper league id`), any previously connected profile is **left intact**, and no
  partially-parsed profile is stored.
- **R19-E1-S1-AC6 — the fetch can never hang the page** — Given Sleeper does not respond,
  When 12 s elapse, Then an `AbortController` cancels the request, the page stays
  interactive, and it offers the paste tier (R19-E1-S2) inline rather than spinning.
- **R19-E1-S1-AC7 — proven on the real domain** *(deploy-manual — the only one in this
  backlog)* — Given the release is deployed, When the Operator loads
  `https://nfl2026.j5lagenticstrategy.com/#/scoring` in a browser, pastes
  `1393691504228184064` and presses FETCH, Then 10 teams / 9 starters / 147 keys render
  from a real cross-origin fetch, and the result is written into the deploy notes. **This
  is the leg the sandbox cannot prove; it is 30 seconds and it is mandatory.**

**Tasks:**
- [ ] R19-E1-S1-T1 — Create `app/league-profile.js` (pure; no DOM, no storage) exporting `fetchSleeperLeague`, `parseSleeperLeague`, `normalizeShape`, `effectiveScoring`, `classifyKeys`, `ESPN_PPR_DEFAULT`, `isDefaultPpr`.
- [ ] R19-E1-S1-T2 — Implement `fetchSleeperLeague(id)`: `credentials:'omit'`, no custom headers, 12 s `AbortController`, typed failure results (`bad_id`, `not_found`, `network`, `timeout`) — never a thrown error.
- [ ] R19-E1-S1-T3 — Implement `parseSleeperLeague(payload)` → the `LeagueProfile` of SOLUTION_DESIGN §7.2, storing **all 147 keys including zeros**.
- [ ] R19-E1-S1-T4 — Implement `normalizeShape`: Sleeper token fold (`QB/RB/WR/TE/K` → own, `DEF` → team defense, `FLEX`→RB/WR/TE, `REC_FLEX`→WR/TE, `WRRB_FLEX`→WR/RB, `SUPER_FLEX`→QB/RB/WR/TE, `IDP_*`→`unsupported`, `BN`→bench, `IR`/`TAXI` excluded from `size`), repeats numbered in encounter order.
- [ ] R19-E1-S1-T5 — Create `app/views/scoring.js` + the CONNECT block; register route `#/scoring` and the 7th tab in `app/main.js` / `index.html` using the existing lazy-import-with-degrade pattern.
- [ ] R19-E1-S1-T6 — Add the Omilia-US payload as a committed fixture and drive `parseSleeperLeague` / `normalizeShape` from it in `tests/feature/league_profile.test.mjs`.
- [ ] R19-E1-S1-T7 — Add the production FETCH check to the deploy checklist in the release notes.

**QA coverage:**
- AC1 → `tests/web/web.spec.mjs::scoring_fetch_is_simple_request_and_connects` (e2e, network intercepted) — Planned
- AC2 → `tests/feature/league_profile.test.mjs::parses_omilia_headline_values` (unit) — Planned
- AC3 → `tests/feature/league_profile.test.mjs::omilia_is_not_default_ppr` (unit) — Planned
- AC4 → `tests/feature/league_profile.test.mjs::normalizes_nine_starter_keeper_shape` (unit) — Planned
- AC5 → `tests/feature/league_profile.test.mjs::bad_id_returns_typed_failure_and_preserves_profile` (unit) — Planned
- AC6 → `tests/web/web.spec.mjs::scoring_fetch_times_out_and_offers_paste` (e2e, route stalled) — Planned
- AC7 → **manual** production check, recorded in the deploy notes — Manual
- **Coverage: 6/7 automated = 85.7%** (the 7th is the irreducible production leg). Types: unit(node:test), e2e(Playwright), manual(deploy).

**Traceability:** `app/league-profile.js`, `app/views/scoring.js`, `app/main.js`,
`index.html`, `tests/feature/league_profile.test.mjs`, `tests/web/web.spec.mjs`.

---

### R19-E1-S2 — When the app can't reach Sleeper, I paste my league instead · Est: M
**As** a Manager on a corporate network, offline, or during a Sleeper outage **I want** a
second and third way to get my league into the app **so that** a connection problem never
becomes "you can't use custom scoring".

**Acceptance criteria** (Given/When/Then):
- **R19-E1-S2-AC1 — three tiers, all shipping together** — Given the Scoring page, When it
  renders, Then it offers **Tier 1** paste-an-id-and-fetch, **Tier 2** *paste league JSON*
  into a textarea, and **Tier 3** *start from the PPR default* with all 147 keys editable
  — and Tier 2/3 are reachable **without** a failed fetch first.
- **R19-E1-S2-AC2 — the same parser** — Given I paste the raw JSON body of
  `/v1/league/1393691504228184064` into the textarea, When I press APPLY, Then the
  resulting profile is **deep-equal** to the one Tier 1 produces except `source` is
  `'paste'` and `fetched_utc` is null.
- **R19-E1-S2-AC3 — junk in the textarea is refused, not half-applied** — Given I paste
  text that is not JSON, or JSON with no `scoring_settings`, When I press APPLY, Then the
  page names what is missing and **no profile is stored or replaced**.
- **R19-E1-S2-AC4 — Tier 3 is a real starting point** — Given I choose *start from the PPR
  default*, When the table paints, Then it holds the app's ESPN-PPR table with
  **`pass_td: 4.0`** (not 6.0 — the app's "PPR" is ESPN-PPR), `source: 'manual'`, and
  `isDefaultPpr` is **true** until I edit something.
- **R19-E1-S2-AC5 — a fetch failure hands me straight to Tier 2** — Given the Tier-1 fetch
  fails or times out, When the error paints, Then the paste textarea is already expanded
  beneath it with a one-line instruction naming the exact URL to open in a browser tab.
- **R19-E1-S2-AC6 — non-Sleeper leagues are first-class** — Given I play in a league that
  is not on Sleeper, When I use Tier 3 and hand-edit, Then nothing on the page, in the
  profile, or in any later surface requires a `league_id` to be present.

**Tasks:**
- [ ] R19-E1-S2-T1 — Implement the paste textarea in `app/views/scoring.js` reusing `parseSleeperLeague` verbatim (one parser, three entry points).
- [ ] R19-E1-S2-T2 — Implement `ESPN_PPR_DEFAULT` in `app/league-profile.js` with `pass_td: 4.0`, and a `defaultProfile()` builder covering all 147 keys.
- [ ] R19-E1-S2-T3 — Wire typed fetch failures to auto-expand the paste tier with the literal URL.
- [ ] R19-E1-S2-T4 — Make `league_id`, `name`, `season` and `fetched_utc` all nullable throughout the profile contract and every consumer.
- [ ] R19-E1-S2-T5 — Cover all three tiers producing an equivalent profile in `tests/feature/league_profile.test.mjs`.

**QA coverage:**
- AC1 → `tests/web/web.spec.mjs::scoring_page_offers_three_tiers` (e2e) — Planned
- AC2 → `tests/feature/league_profile.test.mjs::paste_tier_equals_fetch_tier` (unit) — Planned
- AC3 → `tests/feature/league_profile.test.mjs::malformed_paste_is_refused` (unit) — Planned
- AC4 → `tests/feature/league_profile.test.mjs::ppr_default_has_pass_td_four` (unit) — Planned
- AC5 → `tests/web/web.spec.mjs::fetch_failure_expands_paste_tier` (e2e) — Planned
- AC6 → `tests/feature/league_profile.test.mjs::profile_without_league_id_is_valid` (unit) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/league-profile.js`, `app/views/scoring.js`.

---

### R19-E1-S3 — Every one of the 147 values is mine to edit, and I can always get back to my league's · Est: M
**As** a Manager whose commissioner uses a house rule Sleeper doesn't model **I want** to
change any scoring value by hand **so that** the app matches what my league actually pays
— and I want to be able to undo that in one click.

**Acceptance criteria** (Given/When/Then):
- **R19-E1-S3-AC1 — all 147, including the zeros** — Given a connected profile, When the
  table renders, Then **every** one of the 147 keys is editable, including keys currently
  at 0.0 and including the 17 IDP keys this league never uses, grouped by category
  (PASSING / RUSHING / RECEIVING / KICKING / DEFENSE / MISC).
- **R19-E1-S3-AC2 — edits are an overlay, never a merge** — Given I change `pass_td` from
  6.0 to 6.5, When the profile is stored, Then `scoring.pass_td` is still **6.0** and
  `edits.pass_td` is **6.5**; the effective table is `{...scoring, ...edits}`.
- **R19-E1-S3-AC3 — I can see what I changed** — Given three edited keys, When the page
  renders, Then each edited row carries a `*` marker and the section header reads
  **`3 edited`**.
- **R19-E1-S3-AC4 — reset is exact** — Given any set of edits, When I press **reset to
  league**, Then `edits` is emptied and every one of the 147 values equals the fetched
  value **exactly** (not re-rounded, not re-derived).
- **R19-E1-S3-AC5 — a re-fetch refreshes the league without destroying my work** — Given
  edits exist and my commissioner changes `rec` from 1.0 to 0.5, When I press FETCH again,
  Then `scoring.rec` becomes 0.5, my `edits` survive untouched, and the page reports which
  underlying league values moved since the last fetch.
- **R19-E1-S3-AC6 — bad input is rejected at the field** — Given I type text, an empty
  value, or something outside a sane range into a scoring field, When it blurs, Then the
  field reverts and explains itself; a non-numeric value can never reach the profile or
  any scorer.

**Tasks:**
- [ ] R19-E1-S3-T1 — Implement `effectiveScoring(profile)` = `{...scoring, ...edits}` as the single read path every consumer uses.
- [ ] R19-E1-S3-T2 — Build the grouped, editable table in `app/views/scoring.js` (category groups, `*` markers, edited count).
- [ ] R19-E1-S3-T3 — Implement `resetToLeague()` (delete `edits`) and the re-fetch diff report (`scoring` replaced, `edits` preserved).
- [ ] R19-E1-S3-T4 — Implement field-level numeric validation with revert-and-explain.
- [ ] R19-E1-S3-T5 — Cover overlay semantics, reset exactness and re-fetch preservation in `tests/feature/league_profile.test.mjs`.
- [ ] R19-E1-S3-T6 — Add the iPhone-width collapse (one column per category group, sticky category sub-header) and the AA token pairs for the dense table.

**QA coverage:**
- AC1 → `tests/web/web.spec.mjs::all_147_keys_are_editable_including_zeros` (e2e) — Planned
- AC2 → `tests/feature/league_profile.test.mjs::edits_are_an_overlay` (unit) — Planned
- AC3 → `tests/web/web.spec.mjs::edited_keys_are_marked_and_counted` (e2e) — Planned
- AC4 → `tests/feature/league_profile.test.mjs::reset_to_league_is_exact` (unit) — Planned
- AC5 → `tests/feature/league_profile.test.mjs::refetch_preserves_edits` (unit) — Planned
- AC6 → `tests/web/web.spec.mjs::non_numeric_scoring_input_reverts` (e2e) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/league-profile.js`, `app/views/scoring.js`, `app/theme.css`,
`tests/feature/contrast_aa.test.mjs`.

---

### R19-E1-S4 — "I hand-edit one value and everything re-ranks" · Est: M
**As** a Manager **I want** a single edited scoring value to flow through every player
surface immediately **so that** I can see what a house rule is actually worth before my
draft instead of guessing.

**Acceptance criteria** (Given/When/Then):
- **R19-E1-S4-AC1 — one edit, one re-rank** — Given Omilia-US is connected and I change
  `pass_cmp` from 0.50 to 0.00, When I return to **Players**, Then every QB's points fall
  by exactly `0.5 × their projected completions`, the list re-sorts, and no other
  position's number changes by a single decimal.
- **R19-E1-S4-AC2 — the draft room follows** — Given the same edit, When I open the
  **Team** draft room, Then VOR, best-pick-now, the ADP value flags and the auction dollars
  are all recomputed from the edited table on the same visit — no reload, no stale card.
- **R19-E1-S4-AC3 — the lineup follows** — Given the same edit, When I open **Lineup**,
  Then the optimizer re-solves against the edited points and the weekly split rescales
  with them.
- **R19-E1-S4-AC4 — Compare follows** — Given the same edit, When I open **Compare** on
  two QBs, Then both PROJ PTS values reflect the edited table (this is the surface that
  ignores scoring entirely today — see R19-E6-S3).
- **R19-E1-S4-AC5 — the edit is durable** — Given the edit and a full page reload, When any
  surface paints, Then the edited value is still in force, sourced from
  `nfl2026.league.v1`.
- **R19-E1-S4-AC6 — one routing function, not scattered call sites** — Given the codebase
  after this story, When `scoringAdjust(` call sites are audited across `app/views/`, Then
  every player-points read goes through **`adjustedPoints(player, ctx)`** in
  `app/team-logic.js`, which short-circuits to `scoringAdjust` on the default-PPR bypass
  and otherwise calls `scoreComponents(comp, effectiveScoring(profile))`.

**Tasks:**
- [ ] R19-E1-S4-T1 — Implement `adjustedPoints(player, ctx)` in `app/team-logic.js` per SOLUTION_DESIGN §12 (bypass → `scoringAdjust`; profile → `scoreComponents`; missing row → `fallback:'no_components'`).
- [ ] R19-E1-S4-T2 — Route `app/views/players.js`, `app/views/team.js`, `app/views/lineup.js`, `app/views/compare.js` through `adjustedPoints`.
- [ ] R19-E1-S4-T3 — Scale `low`/`high` by `custom/ppr` through the existing `scoreRatio` mechanism (`views/players.js:266`, `:492`); leave the AI± ratio composing on top unchanged.
- [ ] R19-E1-S4-T4 — Make the Scoring page publish a profile-changed event the mounted views re-read on navigation.
- [ ] R19-E1-S4-T5 — Add the single-edit re-rank case to `tests/feature/team_logic.test.mjs` (**add only**) and an end-to-end edit→re-rank walk to `tests/web/web.spec.mjs`.

**QA coverage:**
- AC1 → `tests/feature/components_reconcile.test.mjs::single_key_edit_moves_only_that_category` (unit) — Planned
- AC2 → `tests/web/web.spec.mjs::edit_reranks_draft_room` (e2e) — Planned
- AC3 → `tests/web/web.spec.mjs::edit_reranks_lineup` (e2e) — Planned
- AC4 → `tests/web/web.spec.mjs::edit_reranks_compare` (e2e) — Planned
- AC5 → `tests/web/web.spec.mjs::edit_survives_reload` (e2e) — Planned
- AC6 → `tests/feature/team_logic.test.mjs::all_surfaces_route_through_adjustedPoints` (unit, source assertion) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/team-logic.js`, `app/views/{players,team,lineup,compare}.js`.

---

### R19-E1-S5 — My league lives on this device, and I can hand it to another one · Est: M
**As** a Manager with a phone and an iPad and **no account** **I want** to move my league
setup between devices with a link **so that** I don't rebuild 147 values twice — and I
want the app to be straight with me that nothing syncs by itself.

**Acceptance criteria** (Given/When/Then):
- **R19-E1-S5-AC1 — one versioned key** — Given a connected profile, When it is stored,
  Then it lives at **`nfl2026.league.v1`** alongside the existing
  `nfl2026.{scoring,team,ai,taken,mocklocks,unlock}.v1` family, and reading a
  missing/corrupt value degrades to *no profile connected*, never to a thrown error.
- **R19-E1-S5-AC2 — private mode degrades, it does not break** — Given `localStorage`
  writes throw (private browsing), When I connect a league, Then the profile is held
  **session-only**, everything still recalculates, and the page says the setup will not
  survive closing the tab.
- **R19-E1-S5-AC3 — the league-id link is the primary share** — Given a connected Sleeper
  league, When I press **copy share link**, Then I get
  `…/#/scoring?league=1393691504228184064`, and opening it on another device re-fetches
  live — so it can never carry a stale copy of a league whose commissioner changed a
  setting.
- **R19-E1-S5-AC4 — hand-edited profiles share too** — Given a hand-edited or non-Sleeper
  profile, When I press **copy profile JSON** / the blob link, Then the profile encodes to
  `#/scoring?p=<base64url>` (compressed via `CompressionStream('deflate-raw')` when the
  platform has it, raw base64url when it does not), and the decoder detects which it got.
- **R19-E1-S5-AC5 — an import always lands in review** — Given I open a share link while a
  profile is already connected, When the page loads, Then it shows the incoming league in a
  **REVIEW** state naming what would change, and nothing is overwritten until I confirm.
- **R19-E1-S5-AC6 — the app says nothing syncs** — Given any connected profile, When the
  page renders, Then it states plainly that the setup is stored on this device only and
  that there is no account — the manager learns this from the UI, not by losing work.

**Tasks:**
- [ ] R19-E1-S5-T1 — Create `app/league-store.js` (`load`/`save`/`clear` on `nfl2026.league.v1`) with the existing try/catch-and-degrade pattern and a session-only fallback.
- [ ] R19-E1-S5-T2 — Implement `?league=` deep link (re-fetch) and `?p=` blob encode/decode with the `CompressionStream` fallback sniff.
- [ ] R19-E1-S5-T3 — Implement the REVIEW-then-confirm import flow; never silently overwrite.
- [ ] R19-E1-S5-T4 — Add the "stored on this device only, no account" line and the disconnect button (which clears `nfl2026.league.v1`).
- [ ] R19-E1-S5-T5 — Stamp `{league_id, profile_hash, teams, roster_positions}` onto every new `nfl2026.mocklocks.v1` lock and onto `nfl2026.team.v1`; treat an unstamped lock as a pre-Rel19 PPR lock.
- [ ] R19-E1-S5-T6 — Cover round-trip encode/decode, storage failure and stamping in `tests/feature/league_profile.test.mjs`.

**QA coverage:**
- AC1 → `tests/feature/league_profile.test.mjs::store_key_and_corrupt_value_degrade` (unit) — Planned
- AC2 → `tests/web/web.spec.mjs::storage_blocked_yields_session_profile` (e2e, storage stubbed) — Planned
- AC3 → `tests/web/web.spec.mjs::league_share_link_refetches` (e2e) — Planned
- AC4 → `tests/feature/league_profile.test.mjs::blob_link_round_trips_both_encodings` (unit) — Planned
- AC5 → `tests/web/web.spec.mjs::import_lands_in_review_state` (e2e) — Planned
- AC6 → `tests/web/web.spec.mjs::scoring_page_states_no_sync` (e2e) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/league-store.js`, `app/views/scoring.js`, `app/main.js`.

---

## EPIC R19-E2 · Real component projections — exact, never a rescaled PPR total
**Owner:** P2 (pipeline) with P1 (the pure scorer + the reconciliation gate)
**Answers:** Q4 (component model + reconciliation), D2
**Status:** 🔴 Not started

### Goal
Give every projected player a per-category breakdown — completions, passing yards, passing
TDs, interceptions, rushing yards/TDs, receptions, receiving yards/TDs, fumbles lost, 2PT,
return TDs — harvested from the **same ESPN feed the pipeline already downloads and
throws away**. Then score those components under any league's table. And prove, on every
pipeline run, that scoring them under **default PPR reproduces today's number exactly** —
because if it doesn't, every number in the app has silently moved.

### Why it matters
The existing PPR/half/standard toggle works only because receptions happen to be the one
component the app has. It can express "half point per catch". It **cannot** express
`pass_cmp 0.5` or a 6-point passing TD, and no ratio applied to a single PPR total ever
will. D2 exists because approximating this is not a smaller version of the feature — it is
a different, wrong feature. The reconciliation gate is what stops this release from
becoming a silent, app-wide re-pricing of every player.

---

### R19-E2-S1 — The pipeline writes a real per-category breakdown for all 300 players · Est: L
**As** the System **I want** to keep the component statistics ESPN already sends instead of
discarding them **so that** the app can re-score any player under any league's rules.

**Acceptance criteria** (Given/When/Then):
- **R19-E2-S1-AC1 — a new file, not a widened one** — Given a pipeline run, When it
  completes, Then it writes **`data/player_components.json`** with a per-player component
  block, and `data/player_projections.json`, `data/player_weekly.json` and both their
  schemas are **byte-unchanged** by this story.
- **R19-E2-S1-AC2 — the whitelist, by name** — Given `scripts/scrape/espn_players.py`,
  When it harvests, Then it maps **exactly** these statIds and no others:
  `0 pass_att · 1 pass_cmp · 3 pass_yd · 4 pass_td · 19 pass_2pt · 20 pass_int ·
  23 rush_att · 24 rush_yd · 25 rush_td · 26 rush_2pt · 42 rec_yd · 43 rec_td ·
  44 rec_2pt · 53 rec · 63 fum_rec_td · 72 fum_lost · 101/102/104 st_td`.
  A loop that carries unknown ids forward is a defect — an id ESPN adds later must not
  silently start scoring.
- **R19-E2-S1-AC3 — return TDs are in, and that is the finding** — Given the harvest, When
  return men (e.g. Rashid Shaheed, Parker Washington) are scored, Then statIds
  `101/102/104` and `63` contribute at 6.0 each. **Dropping them is what produced the
  earlier documents' 11–12 mismatched players; with them the residual is zero.**
- **R19-E2-S1-AC4 — coverage is total by construction** — Given the file, When compared to
  `data/player_projections.json`, Then it carries **exactly 300** rows with the **same
  `gsis_id` set** — because the rows harvested *are* the projection rows.
- **R19-E2-S1-AC5 — the same scalar, every category** — Given `project_player()` applies
  one scalar `Π applied` per player across every stat, When components are written, Then
  each component is `prior_i × Π applied` using that **same** scalar, and the file records
  it so the identity is auditable.
- **R19-E2-S1-AC6 — this is not dormant** — Given the release ships, When the next ordinary
  pipeline run completes, Then `player_components.json` exists and is complete; it is
  **not** in `validate_data.py`'s `OPTIONAL_DATA`, so its absence after a run is a **red
  gate**, not a shrug.

**Tasks:**
- [ ] R19-E2-S1-T1 — Extend `scripts/scrape/espn_players.py` to retain the whitelisted `stats` map alongside `appliedTotal` and `stats["53"]`.
- [ ] R19-E2-S1-T2 — Create `scripts/build_components.py` writing `data/player_components.json` (`ensure_ascii=True`, matching on-disk encoding).
- [ ] R19-E2-S1-T3 — Apply `Π applied` per player from `scripts/models/player_projection.py` and record it per row.
- [ ] R19-E2-S1-T4 — Add `data/contracts/player_components.schema.json` (`additionalProperties: false`) and register it in `validate_data.py`'s `SCHEMA_FOR_DATA`; **do not** add it to `OPTIONAL_DATA`.
- [ ] R19-E2-S1-T5 — Wire the build into `scripts/build_predictions.py` call sites plus a `pipeline_status.json` row.
- [ ] R19-E2-S1-T6 — Add `python3 scripts/build_components.py --selftest` to `tests/smoke.sh`, matching the `build_epa_history` pattern.

**QA coverage:**
- AC1 → `tests/feature/weekly_contract.test.mjs` + `real_data.test.mjs` green **unmodified**, plus `git diff --stat` on the two data files (gate) — Existing
- AC2 → `tests/feature/components_reconcile.test.mjs::harvest_is_a_named_whitelist` (unit, source assertion) — Planned
- AC3 → `tests/feature/components_reconcile.test.mjs::return_tds_are_scored` (unit) — Planned
- AC4 → `tests/feature/components_reconcile.test.mjs::component_ids_equal_projection_ids` (unit, = R2) — Planned
- AC5 → `scripts/build_components.py --selftest` via `tests/smoke.sh` (smoke) — Planned
- AC6 → `scripts/validate_data.py` (data) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), data(validate_data), smoke, gate.

**Traceability:** `scripts/scrape/espn_players.py`, `scripts/build_components.py`,
`scripts/build_predictions.py`, `scripts/validate_data.py`,
`data/contracts/player_components.schema.json`, `tests/smoke.sh`.

---

### R19-E2-S2 — Scoring my components under plain PPR must reproduce today's number exactly · Est: L
**As** the Operator **I want** a hard gate proving the new breakdown adds up to the old
total **so that** a scoring feature can never silently re-price 300 players.

**Acceptance criteria** (Given/When/Then):
- **R19-E2-S2-AC1 — R1, the reconciliation lock** — Given every player in
  `data/player_components.json`, When scored under `ESPN_PPR_DEFAULT`, Then
  `|score_PPR(components) − proj_points| ≤ **0.011**` for **300 of 300**. No percentage
  carve-out, no per-player escape hatch. The threshold is 2-dp rounding slack
  (0.005 + 0.005 + float), set by measurement — a residual of **0.0** was measured across
  900 player-seasons (2023, 2024, 2025).
- **R19-E2-S2-AC2 — a loose tolerance is itself the bug** — Given this gate, When anyone
  proposes `≥ 95% within 0.01` or `> 0.5 per player`, Then it is **rejected**: those were
  calibrated for a cross-feed comparison this design does not perform. Inside one feed,
  "95% match" means a statId is wrong.
- **R19-E2-S2-AC3 — R2, no partial file** — Given both files, When compared, Then their
  `gsis_id` sets are **exactly equal**; a partial components file cannot pass the gate and
  therefore can never reach a manager's board.
- **R19-E2-S2-AC4 — the gate catches a remapped id** — Given a deliberately mutated statId
  map in a test fixture, When R1 runs, Then it **fails**. This is the whole reason
  reconciliation is a gate and not a report: ESPN changing an id's meaning shows up as a
  red gate on the next pipeline run.
- **R19-E2-S2-AC5 — R5, bounds are sane** — Given the unmodeled-key upper bounds, When
  checked, Then `pass_td_40p ≤ pass_td`, `rush_td_40p ≤ rush_td`, `rec_td_40p ≤ rec_td`,
  `pass_int_td ≤ pass_int`, `bonus_pass_yd_400 ≤ games` — so a bound computed off the wrong
  field can never be printed as if it were a measurement.
- **R19-E2-S2-AC6 — the default table is ESPN-PPR** — Given `ESPN_PPR_DEFAULT`, When
  inspected, Then `pass_td` is **4.0**, not 6.0, and a test asserts it by name. Getting
  this wrong makes R1 fail for every QB and look like a component bug.
- **R19-E2-S2-AC7 — the honest label** — Given the Scoring page, When components are in
  use, Then it labels them **`basis: 2025 actuals, rescaled`** — because what this ships is
  a faithful *decomposition* of the existing projection carrying exactly as much predictive
  information as `proj_points`, not a new per-category forecast.

**Tasks:**
- [ ] R19-E2-S2-T1 — Implement `scoreComponents(components, table)` in `app/league-profile.js` as a pure linear scorer.
- [ ] R19-E2-S2-T2 — Create `tests/feature/components_reconcile.test.mjs` with R1 (300/300 @ 0.011) and R2 (exact set equality) against the committed JSON.
- [ ] R19-E2-S2-T3 — Add the mutated-statId negative fixture proving R1 fails when a mapping breaks.
- [ ] R19-E2-S2-T4 — Implement `unmodeledBounds(components, profile)` and R5's sanity assertions.
- [ ] R19-E2-S2-T5 — Add the `pass_td === 4.0` assertion on `ESPN_PPR_DEFAULT` and the `basis:` label to the Scoring page.
- [ ] R19-E2-S2-T6 — Add a cross-file `player_components` ↔ `player_projections` id-set check to `scripts/validate_data.py`.

**QA coverage:**
- AC1 → `tests/feature/components_reconcile.test.mjs::R1_ppr_score_equals_proj_points_300_of_300` (unit) — Planned
- AC2 → same test, asserted with no tolerance parameter and no skip list (unit, source assertion) — Planned
- AC3 → `tests/feature/components_reconcile.test.mjs::R2_id_sets_are_equal` + `scripts/validate_data.py` (unit + data) — Planned
- AC4 → `tests/feature/components_reconcile.test.mjs::R1_fails_on_a_remapped_statid` (unit, negative) — Planned
- AC5 → `tests/feature/components_reconcile.test.mjs::R5_unmodeled_bounds_are_sane` (unit) — Planned
- AC6 → `tests/feature/league_profile.test.mjs::espn_ppr_default_pass_td_is_four` (unit) — Planned
- AC7 → `tests/web/web.spec.mjs::scoring_page_labels_component_basis` (e2e) — Planned
- **Coverage: 7/7 = 100%.** Types: unit(node:test), e2e(Playwright), data(validate_data).

**Traceability:** `app/league-profile.js`, `tests/feature/components_reconcile.test.mjs`,
`scripts/validate_data.py`, `app/views/scoring.js`.

---

### R19-E2-S3 — My league's points are computed from components, never scaled off PPR · Est: M
**As** a Manager **I want** every custom number built by adding up my league's actual rules
against a real stat line **so that** I can trust a number I am about to spend a first-round
pick on.

**Acceptance criteria** (Given/When/Then):
- **R19-E2-S3-AC1 — the sum, not a ratio** — Given a connected profile, When a player's
  points are computed, Then they equal `Σ (component_i × table_i)` over the modeled keys —
  and **no code path** multiplies `proj_points` by a scoring ratio to approximate a custom
  total.
- **R19-E2-S3-AC2 — worked example, checkable by hand** — Given a QB with 4 200 passing
  yards, 380 completions, 30 passing TDs and 10 INTs, When scored under Omilia-US, Then he
  gains **+60.0** from `pass_td` (30 × 2.0 over ESPN-PPR's 4.0) and **+190.0** from
  `pass_cmp` (380 × 0.5) versus the same components under ESPN-PPR — arithmetic a manager
  can verify on paper.
- **R19-E2-S3-AC3 — the identity holds under future weights** — Given non-zero signal
  weights, When components and `proj_points` are both recomputed, Then R1 still passes:
  the identity is **weight-invariant**, because the same scalar multiplies every category.
- **R19-E2-S3-AC4 — bands and AI± compose, they do not stack twice** — Given a custom
  total, When `low`/`high` render, Then they scale by `custom/ppr` through the existing
  `scoreRatio` mechanism and the AI± ratio composes on top **once**, with `low ≤ proj ≤
  high` preserved.
- **R19-E2-S3-AC5 — the weekly split needs no new formula** — Given `weeklyPoints(entry,
  seasonAdj, seasonPpr)`, When a custom season total is passed in, Then it flows through
  **unchanged** — the function is already ratio-based and scoring-agnostic, and this story
  must not alter it.
- **R19-E2-S3-AC6 — the custom board is deterministic** — Given the same profile and the
  same pool, When any surface ranks players, Then the order is **identical across runs**,
  with ties broken exactly as today (points desc, then `gsis_id` asc) — a manager comparing
  two sessions must never see two different boards from the same inputs.

**Tasks:**
- [ ] R19-E2-S3-T1 — Implement `classifyKeys(table)` → `{modeled, unmodeled}` computed from the harvest map, never authored.
- [ ] R19-E2-S3-T2 — Wire `scoreComponents` into `adjustedPoints` (R19-E1-S4-T1) as the only custom-scoring path.
- [ ] R19-E2-S3-T3 — Add a source-level assertion that no view multiplies `proj_points` by a custom ratio.
- [ ] R19-E2-S3-T4 — Preserve `low ≤ proj ≤ high` under the composed `scoreRatio × aiRatio`.
- [ ] R19-E2-S3-T5 — Add the worked QB example as a fixture-driven unit case.
- [ ] R19-E2-S3-T6 — Reuse today's tie-break (points desc, then `gsis_id` asc) on the custom path and assert run-to-run determinism.

**QA coverage:**
- AC1 → `tests/feature/components_reconcile.test.mjs::custom_total_is_a_sum_not_a_ratio` (unit, source assertion) — Planned
- AC2 → `tests/feature/components_reconcile.test.mjs::omilia_qb_worked_example` (unit) — Planned
- AC3 → `tests/feature/components_reconcile.test.mjs::identity_holds_at_nonzero_weights` (unit) — Planned
- AC4 → `tests/feature/team_logic.test.mjs::bands_compose_once_under_custom_scoring` (unit, **added**) — Planned
- AC5 → `tests/feature/weekly_contract.test.mjs` green **unmodified** (unit) — Existing
- AC6 → `tests/feature/team_vor.test.mjs::custom_board_is_deterministic` (unit, **added**) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test).

**Traceability:** `app/league-profile.js`, `app/team-logic.js`, `app/views/players.js`.

---

### R19-E2-S4 — "My QB rankings rise sharply because of per-completion scoring" · Est: M
**As** a Manager in a 6-point-TD, half-point-per-completion league **I want** the app to
show me how much more my QBs are actually worth **so that** I stop drafting them like it's
a standard PPR league.

**Acceptance criteria** (Given/When/Then):
- **R19-E2-S4-AC1 — the raw-points effect is large and visible** — Given Omilia-US is
  connected, When **Players** paints, Then QB season totals rise by roughly **+145 on
  average** (max ≈ +286) versus ESPN-PPR, driven by `pass_cmp 0.5` and the 6-point passing
  TD, and the top of the raw-points list becomes QB-dominated.
- **R19-E2-S4-AC2 — the draft board is VOR, and it moves less** — Given the same profile,
  When the **Team** draft board ranks by VOR, Then the shift is a **few slots, not a
  revolution**: replacement-level QB rises with the pool (≈ 241.6 → ≈ 495.4), so the best QB
  moves from roughly 14th to roughly **9th** overall. The app must show the honest VOR
  effect, not the raw-points headline.
- **R19-E2-S4-AC3 — the two views never contradict each other** — Given both surfaces, When
  a manager reads a QB's raw points on Players and his draft rank on Team, Then the page
  explains in one line that the ranking is value-over-replacement, so "he scores the most
  points" and "he is not the first pick" are both true and both visible.
- **R19-E2-S4-AC4 — the per-completion contribution is attributable** — Given a QB card
  under a connected profile, When expanded, Then the per-category contribution breakdown
  shows `pass_cmp` as its own line in points, so the manager can see *why* the number moved.
- **R19-E2-S4-AC5 — non-QBs barely move** — Given the same profile, When RB/WR/TE totals are
  compared to ESPN-PPR, Then they change only through the keys that actually differ
  (`rec_td` / `rush_td` are already 6.0; `rec` is already 1.0), and the app does not present
  a re-ranking where none exists.
- **R19-E2-S4-AC6 — the auction agrees** — Given the same profile, When the auction values
  paint, Then QB dollars rise consistently with their VOR shift, not with their raw-points
  shift.

**Tasks:**
- [ ] R19-E2-S4-T1 — Add the per-category contribution breakdown to the player card (profile-only surface).
- [ ] R19-E2-S4-T2 — Add the one-line "ranked by value over replacement" explainer where raw points and draft rank disagree.
- [ ] R19-E2-S4-T3 — Add fixture-driven assertions for the QB mean/max delta and for the non-QB near-invariance.
- [ ] R19-E2-S4-T4 — Add the replacement-QB shift assertion (per-position replacement rises with the pool) to `tests/feature/team_vor.test.mjs` (**add only**).
- [ ] R19-E2-S4-T5 — Add an e2e walk: connect Omilia-US → Players shows QB-heavy raw list → Team shows the modest VOR shift.

**QA coverage:**
- AC1 → `tests/feature/components_reconcile.test.mjs::omilia_qb_totals_rise` (unit) — Planned
- AC2 → `tests/feature/team_vor.test.mjs::omilia_qb_vor_shift_is_a_few_slots` (unit, **added**) — Planned
- AC3 → `tests/web/web.spec.mjs::raw_points_and_vor_rank_are_both_explained` (e2e) — Planned
- AC4 → `tests/web/web.spec.mjs::player_card_shows_pass_cmp_contribution` (e2e) — Planned
- AC5 → `tests/feature/components_reconcile.test.mjs::non_qb_totals_move_only_on_changed_keys` (unit) — Planned
- AC6 → `tests/feature/auction.test.mjs::qb_dollars_track_vor_not_raw_points` (unit, **added**) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/views/players.js`, `app/views/team.js`, `app/team-logic.js`,
`app/auction.js`.

---

### R19-E2-S5 — The mock-draft record remembers which rules it was made under · Est: S
**As** a Manager who mock-drafts before the season **I want** each saved mock stamped with
the league it was drafted under **so that** a draft made under my league's rules is never
later graded as if it were plain PPR.

**Acceptance criteria** (Given/When/Then):
- **R19-E2-S5-AC1 — every new lock is stamped** — Given a completed mock under a connected
  profile, When it is written to `nfl2026.mocklocks.v1`, Then it carries
  `{league_id, profile_hash, teams, roster_positions}`.
- **R19-E2-S5-AC2 — old locks are honestly typed, not upgraded** — Given a lock with no
  stamp, When read, Then it is treated as a **pre-Rel19 ESPN-PPR** lock and labelled as
  such — never silently attributed to the currently connected league.
- **R19-E2-S5-AC3 — mismatched shape warns** — Given `nfl2026.team.v1` was built under a
  different shape than the one now connected, When the **Team** tab loads, Then it warns
  that the saved roster was built for a different league shape.
- **R19-E2-S5-AC4 — comparisons across profiles are refused, not fudged** — Given two locks
  with different `profile_hash` values, When the record view lists them, Then it does not
  present a head-to-head score comparison between them.
- **R19-E2-S5-AC5 — the stamp carries no secret** — Given the stamp, When inspected, Then it
  contains only public league facts, and no league id is written to analytics or to any
  committed file.

**Tasks:**
- [ ] R19-E2-S5-T1 — Implement `profileHash(profile)` over the effective table plus shape.
- [ ] R19-E2-S5-T2 — Stamp new mock locks; leave existing records untouched and typed as PPR.
- [ ] R19-E2-S5-T3 — Add the shape-mismatch warning to the Team tab.
- [ ] R19-E2-S5-T4 — Suppress cross-profile head-to-head comparisons in the record view.
- [ ] R19-E2-S5-T5 — Cover stamping, the unstamped-legacy path and the mismatch warning in `tests/feature/league_profile.test.mjs`.

**QA coverage:**
- AC1 → `tests/feature/league_profile.test.mjs::mock_locks_are_stamped` (unit) — Planned
- AC2 → `tests/feature/league_profile.test.mjs::unstamped_lock_is_ppr` (unit) — Planned
- AC3 → `tests/web/web.spec.mjs::team_warns_on_shape_mismatch` (e2e) — Planned
- AC4 → `tests/feature/league_profile.test.mjs::cross_profile_locks_not_compared` (unit) — Planned
- AC5 → `tests/feature/league_profile.test.mjs::stamp_is_public_only` (unit, source assertion) — Planned
- **Coverage: 5/5 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/league-store.js`, `app/views/team.js`.

---

## EPIC R19-E3 · My league's shape drives value, not a 12-team assumption
**Owner:** P3 (engines + surfaces)
**Answers:** Q3 (league shape through VOR / auction / ADP)
**Status:** 🔴 Not started

### Goal
Team count, starter count, flex composition and roster caps are what make a player valuable.
Rel19 makes those real: replacement level, VOR, best-pick-now, ADP value flags and auction
dollars all read the connected league's shape. With no league connected, the arithmetic is
byte-for-byte what it is today.

### Why it matters
Right now "10 teams" is a fact the app cannot act on: `replacementLevel()` computes
replacement **per roster**, as if the league had one team, so team count has no effect on
VOR at all. Meanwhile the auction engine computes it **league-wide**. Shipping custom
scoring against that would produce confidently wrong VOR — telling a 10-team manager with
9 starters to draft as if he were in a 12-team, 7-starter league.

---

### R19-E3-S1 — "My league is 10 teams with 9 starters, so replacement level and auction dollars change" · Est: L
**As** a Manager in a 10-team league **I want** replacement level and auction dollars
computed from *my* league's size and starting requirements **so that** the draft advice
reflects how scarce a position actually is at my table.

**Acceptance criteria** (Given/When/Then):
- **R19-E3-S1-AC1 — team count finally matters** — Given Omilia-US is connected, When
  `replacementLevel(pool, weeklyById, mode, 'RB', shape)` is called, Then it returns the
  **league-wide** replacement — the `(round(demand × 10))`-th best RB — not the per-roster
  `ranked[demand + extra]` the app uses today.
- **R19-E3-S1-AC2 — no profile, no change, byte for byte** — Given no connected profile,
  When `replacementLevel` is called with the `shape` argument **absent**, Then it executes
  today's exact code path and all 13 assertions in `tests/feature/team_vor.test.mjs` pass
  **unmodified**.
- **R19-E3-S1-AC3 — the two engines finally agree** — Given a connected profile, When
  `team-logic`'s `replacementLevel` and `auction.js`'s `fairDollars` compute replacement for
  the same position on the same pool, Then they produce the **same** value from the **same**
  fractional flex share derived from `shape.flex` — closing the divergence for profile
  users while leaving the default path alone.
- **R19-E3-S1-AC4 — 9 starters, not 7** — Given the connected shape, When starter demand is
  computed, Then it is `{QB:1, RB:2, WR:2, TE:1, K:1, DEF:1}` plus one `FLEX` over
  `[RB,WR,TE]` — nine starting slots, and the replacement index moves accordingly for every
  position.
- **R19-E3-S1-AC5 — auction dollars move with it** — Given the same profile, When the
  auction paints, Then `fairDollars` uses the connected shape, budget conservation still
  holds exactly (the room absorbs the full budget, every bid ≥ $1, `planBudget` sums
  exactly), and a 10-team/9-starter case is asserted alongside the existing 12-team one.
- **R19-E3-S1-AC6 — market dollars are NOT re-scored** — Given the same profile, When
  `marketDollars` is computed, Then it is **unchanged**: it is ADP-derived, ADP is the
  market's PPR consensus, and re-scoring it would be inventing data. The BAIT/TARGET spread
  between our custom dollars and the PPR market is the useful output.
- **R19-E3-S1-AC7 — the 12-team auction curve is disclosed, not silently reused** — Given a
  non-12-team league, When the auction surface renders, Then it states that `MARKET_DECAY`
  is fitted to the classic 12-team/$200 curve, rather than presenting the market column as
  if it were league-specific.

**Tasks:**
- [ ] R19-E3-S1-T1 — Add a **trailing optional** `shape` argument to `replacementLevel`, `vorScore`, `bestPickNow`, `recommend`, `recommendV2`, `slotEligible`, `fitScore`, `neediestOpenSlot`; absent ⇒ today's arithmetic, byte for byte.
- [ ] R19-E3-S1-T2 — Implement the shared `flexShareFor(pos, shape)` fractional share from `shape.flex` eligibility and use it in **both** `team-logic.js` and `auction.js`.
- [ ] R19-E3-S1-T3 — Accept the profile shape where `rosterShape(rosterConfig)` is called in `app/auction.js`.
- [ ] R19-E3-S1-T4 — Re-export `STARTER_SLOTS` / `BENCH_SLOTS` / `SLOT_ORDER` / `STARTER_DEMAND` / `LINEUP_SLOTS` / `MODELED` / `POSITION_CAPS` / `STARTER_CUTOFFS` as `DEFAULT_SHAPE` with **today's values**.
- [ ] R19-E3-S1-T5 — Pass `teams × starterDemand` as `opts.cutoffs` to `rankByRos` (`ros.js:112` already reads it — **no signature change to `app/ros.js`**).
- [ ] R19-E3-S1-T6 — Add the 10-team/9-starter cases to `team_vor.test.mjs` and `auction.test.mjs` (**add only, never edit an existing assertion**), plus the two-engines-agree test.
- [ ] R19-E3-S1-T7 — Add the `MARKET_DECAY` caveat line to the auction surface for non-12-team leagues.

**QA coverage:**
- AC1 → `tests/feature/team_vor.test.mjs::replacement_is_league_wide_under_shape` (unit, **added**) — Planned
- AC2 → `tests/feature/team_vor.test.mjs` all 13 green **unmodified** (unit) — Existing
- AC3 → `tests/feature/team_vor.test.mjs::team_logic_and_auction_agree_under_shape` (unit, **added**) — Planned
- AC4 → `tests/feature/team_vor.test.mjs::omilia_starter_demand_is_nine_slots` (unit, **added**) — Planned
- AC5 → `tests/feature/auction.test.mjs::ten_team_nine_starter_budget_conservation` (unit, **added**) — Planned
- AC6 → `tests/feature/auction.test.mjs::market_dollars_unchanged_under_profile` (unit, **added**) — Planned
- AC7 → `tests/web/web.spec.mjs::auction_discloses_twelve_team_market_curve` (e2e) — Planned
- **Coverage: 7/7 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/team-logic.js`, `app/auction.js`, `app/ros.js` (caller only),
`tests/feature/team_vor.test.mjs`, `tests/feature/auction.test.mjs`.

---

### R19-E3-S2 — My roster caps and my keeper draft, not the app's defaults · Est: M
**As** a Manager whose league allows 5 RBs, 2 QBs and a **3-round keeper draft** **I want**
the draft room to obey those limits **so that** it stops recommending a player I am not
allowed to roster and stops planning 13 rounds I do not have.

**Acceptance criteria** (Given/When/Then):
- **R19-E3-S2-AC1 — caps come from the league** — Given Omilia-US, When the draft room
  enforces caps, Then it uses `positionCaps {QB:2, RB:5, WR:5, TE:3, K:2, DEF:2}` from
  Sleeper's `position_limit_*`, not the hard-coded `POSITION_CAPS {QB:2, DEF:1, DST:1, K:1}`.
- **R19-E3-S2-AC2 — the default caps are untouched** — Given no profile, When caps are
  read, Then `POSITION_CAPS` keeps today's exact values and `team_rel2.test.mjs`'s 11
  assertions pass **unmodified**; the profile case is **added** alongside them.
- **R19-E3-S2-AC3 — rounds ≠ roster size** — Given `draft_rounds: 3` with `max_keepers: 1`,
  When the draft room plans, Then it plans **3 rounds** and says "3-round keeper draft" —
  hard-coding `rounds = rosterSize` would be wrong for the owner's own league.
- **R19-E3-S2-AC4 — auction caps extend to K and DEF** — Given a connected shape with K/DEF
  slots, When `teamNeedsPos` evaluates capacity, Then its caps map covers K and DEF; today
  it hard-codes QB/RB/WR/TE only (`auction.js:161-166`) and would let a room draft
  unlimited kickers.
- **R19-E3-S2-AC5 — draft-sim opponents keep drafting by ADP** — Given a simulated draft
  under a connected profile, When opponents pick, Then they pick by **ADP**, unchanged. The
  ADP room is the benchmark; an opponent that magically knew my custom scoring would flatter
  our own engine.
- **R19-E3-S2-AC6 — the classic 13-slot shape survives** — Given `rosterShape()` and
  `ROSTER_BOUNDS` extended with `k`/`def` bounds defaulting to **0**, When
  `DEFAULT_ROSTER` is used, Then it still yields the classic 13-slot shape and
  `draft_sim.test.mjs`'s 15 assertions pass **unmodified**.

**Tasks:**
- [ ] R19-E3-S2-T1 — Thread `shape.positionCaps` through `team-logic.js`'s cap check with `POSITION_CAPS` as the default.
- [ ] R19-E3-S2-T2 — Extend `teamNeedsPos`'s caps map in `app/auction.js` for K/DEF.
- [ ] R19-E3-S2-T3 — Extend `rosterShape()` / `ROSTER_BOUNDS` with `k`/`def` defaulting to 0 and assert `DEFAULT_ROSTER` still yields 13 slots.
- [ ] R19-E3-S2-T4 — Use `shape.draftRounds` (and surface `maxKeepers`) in the draft room instead of roster size.
- [ ] R19-E3-S2-T5 — Add profile-case assertions to `team_rel2.test.mjs` and `draft_sim.test.mjs` (**add only**).

**QA coverage:**
- AC1 → `tests/feature/team_rel2.test.mjs::caps_come_from_profile` (unit, **added**) — Planned
- AC2 → `tests/feature/team_rel2.test.mjs` all 11 green **unmodified** (unit) — Existing
- AC3 → `tests/web/web.spec.mjs::draft_room_plans_three_keeper_rounds` (e2e) — Planned
- AC4 → `tests/feature/auction.test.mjs::team_needs_pos_covers_k_and_def` (unit, **added**) — Planned
- AC5 → `tests/feature/draft_sim.test.mjs::opponents_still_draft_by_adp` (unit, **added**) — Planned
- AC6 → `tests/feature/draft_sim.test.mjs` all 15 green **unmodified** (unit) — Existing
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/team-logic.js`, `app/auction.js`, `app/draft-sim.js`,
`app/views/team.js`.

---

### R19-E3-S3 — The lineup optimizer solves my league's slots, and still proves itself · Est: M
**As** a Manager **I want** the optimizer to fill *my* nine slots, including a heterogeneous
flex **so that** the "optimal lineup" it shows me is optimal for my league and not for a
default one.

**Acceptance criteria** (Given/When/Then):
- **R19-E3-S3-AC1 — the shape drives the slots** — Given a connected profile, When
  `bestLineup(players, shape)` runs, Then it fills the shape's starters in the shape's
  order; with `shape` **absent** it fills `LINEUP_SLOTS` exactly as today.
- **R19-E3-S3-AC2 — the greedy proof stays true** — Given heterogeneous flex slots, When the
  optimizer fills them, Then dedicated slots fill first and flex slots fill **in increasing
  order of eligibility breadth** (`RFLEX`/`WRFLEX` before `FLEX` before `SFLEX`), and that
  ordering rule is written verbatim into the module docstring — it is the only thing keeping
  the greedy proof valid.
- **R19-E3-S3-AC3 — the self-check still passes untouched** — Given `__selftest()` in
  `app/lineup.js`, When the gate runs, Then it passes **unmodified**, along with all 5
  assertions in `tests/feature/lineup.test.mjs`.
- **R19-E3-S3-AC4 — SUPER_FLEX does not silently exclude QBs** — Given a league with
  `SUPER_FLEX`, When flex demand is spread, Then it keys off `shape.flex` and includes QB —
  today's hard-coded `{RB:.45, WR:.45, TE:.10}` would silently drop it.
- **R19-E3-S3-AC5 — IDP slots are surfaced, never dropped** — Given a league with
  `IDP_FLEX` / `DL` / `LB` / `DB` slots, When the shape normalizes, Then those slots land in
  `shape.unsupported` and are shown on the Scoring page as unsupported — never silently
  removed from the roster the manager sees.
- **R19-E3-S3-AC6 — availability survives the refactor** — Given Rel17's `playable:false`
  demotion and forced-start warnings, When the shape refactor lands, Then all 21 assertions
  in `tests/feature/availability_app.test.mjs` pass and the availability tuple extends to
  K/DEF slots.

**Tasks:**
- [ ] R19-E3-S3-T1 — Add the trailing optional `shape` to `bestLineup(players, shape)`, defaulting to `LINEUP_SLOTS`.
- [ ] R19-E3-S3-T2 — Implement heterogeneous flex fill in increasing eligibility-breadth order; document the rule in the module docstring.
- [ ] R19-E3-S3-T3 — Key `flexShare` off `shape.flex` in both engines (shared with R19-E3-S1-T2).
- [ ] R19-E3-S3-T4 — Route `IDP_*` slots into `shape.unsupported` and render them on the Scoring page.
- [ ] R19-E3-S3-T5 — Add profile-shape lineup cases to `tests/feature/lineup.test.mjs` and `availability_app.test.mjs` (**add only**).

**QA coverage:**
- AC1 → `tests/feature/lineup.test.mjs::bestLineup_honours_profile_shape` (unit, **added**) — Planned
- AC2 → `tests/feature/lineup.test.mjs::flex_fills_in_eligibility_breadth_order` (unit, **added**) — Planned
- AC3 → `tests/feature/lineup.test.mjs` all 5 + `__selftest()` green **unmodified** (unit) — Existing
- AC4 → `tests/feature/lineup.test.mjs::superflex_includes_qb` (unit, **added**) — Planned
- AC5 → `tests/feature/league_profile.test.mjs::idp_slots_land_in_unsupported` (unit) — Planned
- AC6 → `tests/feature/availability_app.test.mjs` all 21 green + K/DEF tuple case (unit, **added**) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test).

**Traceability:** `app/lineup.js`, `app/team-logic.js`, `app/league-profile.js`,
`tests/feature/lineup.test.mjs`, `tests/feature/availability_app.test.mjs`.

---

### R19-E3-S4 — The draft advice stays proportionate in a 636-point league · Est: M
**As** a Manager **I want** the "stack your QB", "cover your bye" and "raise your floor"
nudges to mean the same thing in my high-scoring league **so that** the recommendations do
not quietly change character just because the numbers got bigger.

**Acceptance criteria** (Given/When/Then):
- **R19-E3-S4-AC1 — the hidden behaviour change is named** — Given `STACK_BONUS 12`,
  `BYE_COVER_BONUS 6`, `BYE_CLASH_PENALTY 10`, `FLOOR_BONUS 8`, `MATCHUP_BONUS_CAP 8`
  (`team-logic.js:47-52`), When the pool tops out at **636** under Omilia instead of
  **416.6** under ESPN-PPR, Then the release acknowledges that a flat +12 is a materially
  smaller nudge — a real behaviour change hiding inside a scoring feature.
- **R19-E3-S4-AC2 — the fix is a pool-scale normalization** — Given a connected profile,
  When `fitScore` runs, Then each points-denominated bonus is multiplied by
  `poolScale = mean(top-N adjusted) / mean(top-N ESPN-PPR)`, computed **once per render**.
- **R19-E3-S4-AC3 — the default path multiplies by a literal 1.0** — Given no connected
  profile, When `fitScore` runs, Then `poolScale` is **short-circuited to the literal value
  1.0**, not to a computed value that happens to round to 1.
- **R19-E3-S4-AC4 — the strictest test in the repo stays green, unmodified** — Given
  `tests/feature/team_logic.test.mjs`'s *"v1 fitScore is byte-for-byte frozen on the fixed
  fixture"* and *"fitScoreV2 OFF path … byte-identical to v1"*, When the gate runs, Then
  both pass **without the fixture being touched**.
- **R19-E3-S4-AC5 — doing nothing was considered and rejected** — Given the alternative of
  leaving the constants fixed and documenting the drift, When reviewed, Then it is rejected
  in writing: that is a silent behaviour change inside a feature whose entire promise is
  that nothing changes silently.
- **R19-E3-S4-AC6 — the nudge stays proportionate, and it is checkable** — Given the same
  roster under ESPN-PPR and under Omilia, When a QB/WR stack is evaluated, Then the stack
  bonus is the same **fraction** of the candidate's points in both, within a stated
  tolerance.

**Tasks:**
- [ ] R19-E3-S4-T1 — Implement `poolScale` in `app/team-logic.js` with the literal-1.0 short circuit on the default path.
- [ ] R19-E3-S4-T2 — Apply it to `STACK_BONUS`, `BYE_COVER_BONUS`, `BYE_COVER_CAP`, `BYE_CLASH_PENALTY`, `FLOOR_BONUS`, `MATCHUP_BONUS_CAP`.
- [ ] R19-E3-S4-T3 — Add the profile-case proportionality test and the literal-1.0 assertion to `tests/feature/team_logic.test.mjs` (**add only**).
- [ ] R19-E3-S4-T4 — Record the rejected "leave them fixed" alternative in `docs/backlog/DECISIONS.md`.
- [ ] R19-E3-S4-T5 — Verify the frozen fitScore fixture is untouched via `git diff` in the integration step.

**QA coverage:**
- AC1 → `docs/backlog/DECISIONS.md` entry + `tests/feature/team_logic.test.mjs::pool_scale_exists` (doc + unit) — Planned
- AC2 → `tests/feature/team_logic.test.mjs::bonuses_scale_with_pool_under_profile` (unit, **added**) — Planned
- AC3 → `tests/feature/team_logic.test.mjs::pool_scale_is_literal_one_without_profile` (unit, **added**) — Planned
- AC4 → `tests/feature/team_logic.test.mjs` frozen-fixture assertions green **unmodified** (unit) — Existing
- AC5 → `docs/backlog/DECISIONS.md` entry (doc) — Planned
- AC6 → `tests/feature/team_logic.test.mjs::stack_bonus_is_same_fraction_in_both_pools` (unit, **added**) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), doc.

**Traceability:** `app/team-logic.js`, `tests/feature/team_logic.test.mjs`,
`docs/backlog/DECISIONS.md`.

---

## EPIC R19-E4 · Nine slots — including the K and the DEF the app has never modeled
**Owner:** P3 (the 9-slot contract) then P2 (the K/DST feed)
**Answers:** Q2 (K and DST)
**Status:** 🔴 Not started

### Goal
The owner's league starts a kicker and a team defense. The app models neither, anywhere.
Rel19 does **both** things, in a deliberate order: first the **contract** — render all nine
slots and be explicit that two of them have no projection yet — then the **projection**, a
real pipeline expansion built from nflverse's named weekly columns.

### Why it matters
A 7-slot "optimal lineup" presented to a 9-starter league is the exact failure the honesty
rule exists to prevent: it looks complete and is wrong. And these are not throwaway slots —
under this league's rules a kicker projects around **190–196**, which is WR6–WR12 territory
in the same league. Ordering the contract first means a slip in the data work degrades into
a **visibly unsupported slot**, never into a silently short lineup.

---

### R19-E4-S1 — "My lineup starts a K and a DEF and the app is honest about what it can project" · Est: L
**As** a Manager whose league starts a kicker and a defense **I want** to see those slots on
every roster surface, marked honestly when the app has no number for them **so that** I am
never shown a 7-man "optimal" lineup for a 9-man league.

**Acceptance criteria** (Given/When/Then):
- **R19-E4-S1-AC1 — nine slots, always** — Given Omilia-US is connected, When the Lineup,
  roster builder, draft room and auction render, Then **all nine** starting slots are shown:
  `QB1 RB1 RB2 WR1 WR2 TE1 FLEX K1 DEF1`.
- **R19-E4-S1-AC2 — an unprojected slot says so** — Given no K/DST projections, When the K
  and DEF slots render, Then each reads **`— awaiting K/DST feed —`** with a `[why?]` link
  to the Scoring page's coverage block, and neither shows a number, a dash that could read
  as zero, or a blank.
- **R19-E4-S1-AC3 — the total is qualified** — Given two unprojected slots, When the lineup
  card totals, Then it reads **`7 of 9 slots projected`** next to the total, so the number
  can never be mistaken for a full-lineup projection.
- **R19-E4-S1-AC4 — a 7-slot "optimal" lineup is a gate failure** — Given a connected
  9-starter shape, When `bestLineup` returns, Then it returns **nine** slot entries with the
  unsupported two present-but-unfilled; returning seven is a **red gate**, not a display
  quirk.
- **R19-E4-S1-AC5 — the two warning reasons stay distinguishable** — Given Rel17's
  `warnings: [{slot, id, reason}]` channel (`app/lineup.js:93-106`), When an unsupported slot
  produces a warning, Then its `reason` is **`'unsupported_slot'`** and a test asserts it is
  never conflated with Rel17's `'no_available_alternative'` — one means *we have no model
  for this position*, the other means *you have no healthy player left*.
- **R19-E4-S1-AC6 — the optimal-lineup claim is suppressed when it would be a lie** — Given
  unfilled unsupported slots, When the view would otherwise say "already optimal", Then it
  does not — reusing the existing suppression logic at `app/views/lineup.js:133-206`.
- **R19-E4-S1-AC7 — no profile, no K/DEF anywhere** — Given no connected profile, When any
  surface renders, Then no K or DEF slot, chip, warning or row appears, and
  `MODELED = ['QB','RB','WR','TE']` still governs.

**Tasks:**
- [ ] R19-E4-S1-T1 — Extend the shape-driven slot rendering across `app/views/lineup.js`, `app/views/team.js` and the auction surface to include K/DEF slots from `shape.starters`.
- [ ] R19-E4-S1-T2 — Add the `— awaiting K/DST feed —` slot state with the `[why?]` deep link into the coverage block.
- [ ] R19-E4-S1-T3 — Add the `7 of 9 slots projected` qualifier to the lineup card total.
- [ ] R19-E4-S1-T4 — Emit `reason: 'unsupported_slot'` from `bestLineup` for present-but-unfilled slots.
- [ ] R19-E4-S1-T5 — Extend the "already optimal" suppression to cover unsupported slots.
- [ ] R19-E4-S1-T6 — Add cases to `lineup.test.mjs` and `availability_app.test.mjs` (**add only**) proving nine returned slots and the two distinguishable reasons.
- [ ] R19-E4-S1-T7 — Add the e2e nine-slot render and the `7 of 9` string to `tests/web/web.spec.mjs`.

**QA coverage:**
- AC1 → `tests/web/web.spec.mjs::lineup_shows_nine_slots_under_profile` (e2e) — Planned
- AC2 → `tests/web/web.spec.mjs::unprojected_slots_say_awaiting_feed` (e2e) — Planned
- AC3 → `tests/web/web.spec.mjs::lineup_total_reads_seven_of_nine` (e2e) — Planned
- AC4 → `tests/feature/lineup.test.mjs::bestLineup_returns_nine_slots_for_nine_starters` (unit, **added**) — Planned
- AC5 → `tests/feature/availability_app.test.mjs::unsupported_slot_distinct_from_no_alternative` (unit, **added**) — Planned
- AC6 → `tests/web/web.spec.mjs::no_already_optimal_claim_with_unsupported_slots` (e2e) — Planned
- AC7 → `tests/feature/lineup.test.mjs` + `team_vor.test.mjs` default-path assertions green **unmodified** (unit) — Existing
- **Coverage: 7/7 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/lineup.js`, `app/views/lineup.js`, `app/views/team.js`,
`app/auction.js`, `tests/feature/lineup.test.mjs`, `tests/web/web.spec.mjs`.

---

### R19-E4-S2 — The pipeline learns to project kickers and team defenses · Est: L
**As** the System **I want** to build real K and D/ST projections from nflverse weekly data
**so that** the two slots this league starts stop being holes in the board.

**Acceptance criteria** (Given/When/Then):
- **R19-E4-S2-AC1 — kicker buckets come from named columns** — Given
  `stats_player_week_{season}.csv`, When kickers are built, Then FG scoring reads
  `fg_made_0_19 / _20_29 / _30_39 / _40_49 / _50_59 / **fg_made_60_**` (note the trailing
  underscore), plus `fg_missed`, `pat_made`, `pat_missed` — covering every one of the
  league's kicker keys exactly.
- **R19-E4-S2-AC2 — ESPN's kicker statIds are forbidden as the source** — Given the
  temptation to reuse the feed already in hand, When reviewed, Then it is refused: a
  best-fit ESPN decode reconciles **two kickers to the cent and then only 33 of 42**. A
  decode that is *nearly* right is the most dangerous kind, and no unlabelled bucket statId
  may leave the `unmodeled` set without a proof against a league that prices the bonus.
- **R19-E4-S2-AC3 — defense tiers are scored per game, then summed** — Given `pts_allow_*`
  and `yds_allow_*` tiers, When D/ST are built, Then each week's points-allowed and
  yards-allowed are bucketed **per game** and summed over the season — 16 tier keys and the
  bulk of a defense's score, fully modeled. The claim that tiers hit a "season-total wall" is
  true of a season total and **false** of the weekly feed.
- **R19-E4-S2-AC4 — the same day-zero path, no new model** — Given K/DST `proj_points`, When
  computed, Then they are prior-season components scored under the **ESPN default table**
  multiplied by the same `Π applied` scalar every other position uses. Rel19 introduces no
  new projection model.
- **R19-E4-S2-AC5 — dormant, and empty rather than partial** — Given nflverse is
  unreachable, When `scripts/build_kdst.py` runs, Then it writes `{"players": []}` plus a
  `degraded` row in `pipeline_status.json` — **never a partial file.** An empty file is
  honest; a half file is a lie that passes `fetch`.
- **R19-E4-S2-AC6 — the ESPN cross-check is a report, not a gate** — Given both feeds, When
  the builder compares `|espn_default_score(nflverse_components) − kona_appliedTotal|` per
  K/DST, Then it records the delta in `pipeline_status.json` and **does not** fail the gate:
  the feeds are independent and ESPN's own K decode is unresolved, so a disagreement is
  information.

**Tasks:**
- [ ] R19-E4-S2-T1 — Create `scripts/build_kdst.py` (stdlib `csv`, guarded `requests`, same shape as `build_epa_history.py`).
- [ ] R19-E4-S2-T2 — Implement the kicker build from the named `fg_made_*` / `pat_*` columns.
- [ ] R19-E4-S2-T3 — Implement the D/ST build: `def_sacks`, `def_interceptions`, `def_tds`, `def_safeties`, `def_fumbles_forced`, `fumble_recovery_opp`, blocked kicks, `special_teams_tds`; points allowed from `nfldata/games.csv`; yards allowed from the opponent's `stats_team_week`; tiers per game.
- [ ] R19-E4-S2-T4 — Apply the day-zero `Π applied` path to K/DST `proj_points`.
- [ ] R19-E4-S2-T5 — Implement the empty-not-partial dormancy contract plus the `pipeline_status.json` degraded row and the ESPN cross-check report.
- [ ] R19-E4-S2-T6 — Add `python3 scripts/build_kdst.py --selftest` to `tests/smoke.sh`.

**QA coverage:**
- AC1 → `scripts/build_kdst.py --selftest` via `tests/smoke.sh` (smoke) — Planned
- AC2 → `tests/feature/components_reconcile.test.mjs::no_espn_bucket_statids_in_kdst_source` (unit, source assertion) — Planned
- AC3 → `scripts/build_kdst.py --selftest` per-game tier fixture (smoke) — Planned
- AC4 → `tests/feature/components_reconcile.test.mjs::kdst_use_the_day_zero_path` (unit) — Planned
- AC5 → `scripts/validate_data.py` (`OPTIONAL_DATA` + empty-shape check) (data) — Planned
- AC6 → `scripts/build_kdst.py --selftest` cross-check-is-a-report assertion (smoke) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), smoke, data(validate_data).

**Traceability:** `scripts/build_kdst.py`, `scripts/build_predictions.py`,
`scripts/validate_data.py`, `tests/smoke.sh`,
`data/contracts/kdst_projections.schema.json`, `data/contracts/kdst_components.schema.json`.

---

### R19-E4-S3 — Adding kickers must never quietly delete 74 wide receivers · Est: M
**As** the Operator **I want** K and D/ST in their own files **so that** a new position can
never push offensive players out of the board through the 300-player truncation.

**Acceptance criteria** (Given/When/Then):
- **R19-E4-S3-AC1 — separate contracts, stated as a rule** — Given the pipeline, When K/DST
  land, Then they are written to **`data/kdst_projections.json`** and
  **`data/kdst_components.json`**, and **not** into `data/player_projections.json`.
- **R19-E4-S3-AC2 — the reason, in numbers** — Given `build_predictions.py:344` writes
  `projected[:300]` sorted by points, When kickers projecting **130–195** are merged into a
  pool whose 300th player is **Noah Gray at 38.8**, Then roughly **74 offensive players**
  are silently evicted from Players, the draft board and every VOR pool. This is why the
  merge is refused.
- **R19-E4-S3-AC3 — the position enum stays narrow** — Given
  `player_projections.schema.json`, When this release lands, Then its `position` enum is
  still `["QB","RB","WR","TE"]`, so `parlay_builder`, `build_history`, `ai_estimates` and
  `ros` see no new position.
- **R19-E4-S3-AC4 — the weekly mirror is untouched** — Given
  `tests/feature/weekly_contract.test.mjs`'s *"players EXACTLY mirror
  player_projections.json (same ids, same order)"*, When the gate runs, Then all 6
  assertions pass **unmodified** — as do `real_data.test.mjs`'s pool-size and sorted-order
  assertions.
- **R19-E4-S3-AC5 — K/DST are fetched only when a league asks for them** — Given no
  connected profile, or a profile with no K/DEF slot, When the app loads, Then
  `kdst_projections.json` is **never fetched**; the getters are 404-graceful in the
  `epa_history` / `ai_insights` tradition.
- **R19-E4-S3-AC6 — D/ST is in cross-position VOR, with its incompleteness disclosed** —
  Given projected defenses, When VOR ranks across positions, Then D/ST **is included** — a
  few points of incompleteness out of ~200 is a smaller distortion than excluding a position
  the manager must actually draft — and every D/ST card carries a **`PARTIAL SCORING`** chip
  naming `def_4_and_stop`, `st_ff`, `st_fum_rec`.

**Tasks:**
- [ ] R19-E4-S3-T1 — Add `data/contracts/kdst_projections.schema.json` and `kdst_components.schema.json`; register both in `SCHEMA_FOR_DATA` **and** in `OPTIONAL_DATA`.
- [ ] R19-E4-S3-T2 — Add three 404-graceful getters to `app/data.js` (additive only), fetched only when the shape declares K/DEF.
- [ ] R19-E4-S3-T3 — Include D/ST in cross-position VOR and attach the `PARTIAL SCORING` chip.
- [ ] R19-E4-S3-T4 — Add a guard test asserting no K/DEF row ever appears in `player_projections.json`.
- [ ] R19-E4-S3-T5 — Verify the untouched-files claim with `git diff --stat` in the integration step.

**QA coverage:**
- AC1 → `tests/feature/components_reconcile.test.mjs::kdst_live_in_their_own_files` (unit) — Planned
- AC2 → `tests/feature/real_data.test.mjs` pool assertions green **unmodified** (unit) — Existing
- AC3 → `scripts/validate_data.py` schema enum check (data) — Existing
- AC4 → `tests/feature/weekly_contract.test.mjs` all 6 green **unmodified** (unit) — Existing
- AC5 → `tests/web/web.spec.mjs::kdst_not_fetched_without_profile` (e2e, network asserted) — Planned
- AC6 → `tests/feature/team_vor.test.mjs::dst_included_in_cross_position_vor_with_chip` (unit, **added**) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright), data(validate_data).

**Traceability:** `app/data.js`, `data/contracts/kdst_*.schema.json`,
`scripts/validate_data.py`, `app/team-logic.js`.

---

## EPIC R19-E5 · The app tells me what it doesn't know
**Owner:** P4 (the page) with P1 (classification) and P3 (the chips)
**Answers:** Q5 (dormancy), Q7 (self-learning boundary), the honesty rule
**Status:** 🔴 Not started

### Goal
Every state where the app has a league but not the data to score it must be **visible**,
and every scoring key the app cannot model must be **named on screen with a reason** — with
a bounded exposure where a tight bound exists and an explicit "no bound" where it does not.

### Why it matters
The dangerous version of this release is the one that ships a beautiful custom board built
on numbers it did not actually recompute. A manager cannot tell a real 636 from a
mislabelled 416 by looking. The only defence is that the app says so, loudly, on the
surface where the number appears — and refuses to blend, scale or approximate its way out
of a missing feed.

---

### R19-E5-S1 — "Component projections aren't built yet, so the app tells me instead of showing wrong numbers" · Est: M
**As** a Manager who connects a league the day the release ships **I want** the app to be
explicit that the points on screen are still ESPN-PPR **so that** I never mistake a default
board for my league's board.

**Acceptance criteria** (Given/When/Then):
- **R19-E5-S1-AC1 — D0: no profile, nothing changes** — Given no connected profile, When any
  surface renders, Then the app is byte-identical to pre-Rel19, the PPR/HALF/STD segment is
  live, and **neither** new data file is fetched.
- **R19-E5-S1-AC2 — D1: shape applies even when scoring cannot** — Given a connected profile
  and `player_components.json` returning 404, When surfaces render, Then league **shape** is
  fully applied (9 slots, 10-team replacement level, roster caps, lineup geometry) while
  **scoring stays ESPN-PPR** — two independently valuable halves, each honest alone.
- **R19-E5-S1-AC3 — the D1 banner is persistent and non-dismissable** — Given D1, When any
  player surface renders, Then a header banner reads *"Omilia-US scoring is connected but
  per-player components have not been built yet — the points below are ESPN-PPR"*, and it
  cannot be dismissed.
- **R19-E5-S1-AC4 — a screenshot cannot lie** — Given D1, When a player card renders, Then
  it carries a per-card **`PPR`** chip, so a cropped screenshot still shows which currency
  the number is in.
- **R19-E5-S1-AC5 — no blending, ever** — Given D1, When points are computed, Then there is
  **no** ratio approximation, no scaled PPR total, no partial custom blend. The measured
  error of approximating is **+145.6 mean for QBs** — precisely the fabrication the honesty
  rule forbids.
- **R19-E5-S1-AC6 — D2: offense custom, K/DEF awaiting** — Given components present and
  K/DST absent (the expected day-one state), When surfaces render, Then QB/RB/WR/TE are
  fully custom, K and DEF read `— awaiting K/DST feed —`, and the lineup total reads
  `7 of 9 slots projected`.
- **R19-E5-S1-AC7 — D4: a missing row degrades, never ranks** — Given a component row is
  missing for one player (gate-unreachable via R2, handled anyway), When that player
  renders, Then he shows PPR points with a chip, is counted in the list header, and is
  **never silently ranked as if custom**.

**Tasks:**
- [ ] R19-E5-S1-T1 — Implement the five-state resolver (D0–D4) as a pure function of `{profile, componentsPresent, kdstPresent, rowPresent}`.
- [ ] R19-E5-S1-T2 — Build the persistent non-dismissable D1 banner and the per-card `PPR` chip.
- [ ] R19-E5-S1-T3 — Split shape application from scoring application so D1 applies one without the other.
- [ ] R19-E5-S1-T4 — Add a source-level assertion that no blending/scaling path exists between a profile and PPR points.
- [ ] R19-E5-S1-T5 — Implement the D4 defensive row (PPR + chip + counted in the header).
- [ ] R19-E5-S1-T6 — Add e2e coverage for D0, D1, D2 and D4 with the data files stubbed at the network layer.

**QA coverage:**
- AC1 → `tests/feature/components_reconcile.test.mjs::R3_default_path_is_byte_identical` (unit) — Planned
- AC2 → `tests/web/web.spec.mjs::d1_applies_shape_without_scoring` (e2e, components 404) — Planned
- AC3 → `tests/web/web.spec.mjs::d1_banner_is_persistent` (e2e) — Planned
- AC4 → `tests/web/web.spec.mjs::d1_cards_carry_ppr_chip` (e2e) — Planned
- AC5 → `tests/feature/components_reconcile.test.mjs::no_blending_path_exists` (unit, source assertion) — Planned
- AC6 → `tests/web/web.spec.mjs::d2_offense_custom_kdef_awaiting` (e2e) — Planned
- AC7 → `tests/feature/team_logic.test.mjs::missing_component_row_falls_back_with_chip` (unit, **added**) — Planned
- **Coverage: 7/7 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/team-logic.js`, `app/views/{players,team,lineup,compare}.js`,
`app/data.js`.

---

### R19-E5-S2 — Every scoring rule my league pays is either scored or named as not scored · Est: M
**As** a Manager **I want** a plain list of which of my league's rules the app actually
models **so that** I know exactly how much of my scoring the number in front of me covers.

**Acceptance criteria** (Given/When/Then):
- **R19-E5-S2-AC1 — R4, nothing is silently ignored** — Given a connected profile, When keys
  are classified, Then every **non-zero** key is in `modeled ∪ unmodeled`, the two sets are
  **disjoint**, and a key that is in neither is a **red gate**.
- **R19-E5-S2-AC2 — the twelve, named** — Given Omilia-US, When the unmodeled list renders,
  Then it names exactly: `pass_cmp_40p`, `pass_td_40p`, `pass_td_50p`, `rush_40p`,
  `rush_td_40p`, `rush_td_50p`, `rec_td_40p`, `rec_td_50p`, `bonus_pass_yd_400`,
  `bonus_rush_yd_200`, `bonus_rec_yd_200`, `pass_int_td`, plus the three defensive keys
  `def_4_and_stop`, `st_ff`, `st_fum_rec` — each with a one-line reason.
- **R19-E5-S2-AC3 — unmodeled means exactly zero, never a guess** — Given an unmodeled key,
  When points are computed, Then it contributes **0.0** — never an invented per-game rate,
  never a league-average estimate.
- **R19-E5-S2-AC4 — a tight bound is shown as a range** — Given `pass_td_40p ≤ pass_td`,
  `bonus_pass_yd_400 ≤ games`, `pass_int_td ≤ pass_int` and the other bounded keys, When the
  exposure renders, Then it reads as a range such as **`+0 to +38 pts not modeled`**.
- **R19-E5-S2-AC5 — no bound is stated as "no bound"** — Given `pass_cmp_40p`, `rush_40p`,
  `def_4_and_stop`, `st_ff`, `st_fum_rec`, When the exposure renders, Then it says **"no
  bound"**. Bounding `pass_cmp_40p` by `pass_cmp` would imply ~319 points — vacuous, and it
  would read as a measurement.
- **R19-E5-S2-AC6 — the ambiguous defensive keys are parked, not guessed** — Given Sleeper's
  overlapping DEF/ST semantics (`fum_rec 2.0` vs `def_st_fum_rec 4.0`; `ff` vs `def_st_ff`
  vs `st_ff`), When classified, Then `st_ff` and `st_fum_rec` stay **unmodeled** so the
  ambiguity produces a **disclosed zero** rather than a confident wrong number. **Open
  question for the owner — do not guess.**

**Tasks:**
- [ ] R19-E5-S2-T1 — Implement `classifyKeys(table)` returning disjoint `modeled` / `unmodeled` sets computed from the harvest maps.
- [ ] R19-E5-S2-T2 — Implement `unmodeledBounds()` returning `{key, lo, hi}` or `{key, bound:'none'}` per key.
- [ ] R19-E5-S2-T3 — Render greyed unmodeled rows with `⃠ not modeled` plus the reason, inline in the scoring table (never hidden).
- [ ] R19-E5-S2-T4 — Render the bounded exposure range on the player card and the coverage block; render "no bound" where none exists.
- [ ] R19-E5-S2-T5 — Add R4 and the twelve-key naming assertions to `tests/feature/components_reconcile.test.mjs`.
- [ ] R19-E5-S2-T6 — Record the DEF/ST semantics open question in `docs/backlog/DECISIONS.md` as owner-blocked.

**QA coverage:**
- AC1 → `tests/feature/components_reconcile.test.mjs::R4_every_nonzero_key_is_classified` (unit) — Planned
- AC2 → `tests/feature/components_reconcile.test.mjs::omilia_unmodeled_set_is_exact` (unit) — Planned
- AC3 → `tests/feature/components_reconcile.test.mjs::unmodeled_keys_contribute_zero` (unit) — Planned
- AC4 → `tests/feature/components_reconcile.test.mjs::R5_bounded_keys_render_a_range` (unit) — Planned
- AC5 → `tests/web/web.spec.mjs::unbounded_keys_say_no_bound` (e2e) — Planned
- AC6 → `docs/backlog/DECISIONS.md` entry + `components_reconcile.test.mjs::st_ff_stays_unmodeled` (doc + unit) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright), doc.

**Traceability:** `app/league-profile.js`, `app/views/scoring.js`, `app/views/players.js`,
`docs/backlog/DECISIONS.md`.

---

### R19-E5-S3 — One page that tells me how much of my league the app really covers · Est: M
**As** a Manager **I want** a coverage block per position **so that** before my draft I know
whether the numbers on every other tab are complete for QBs, for kickers, for my defense.

**Acceptance criteria** (Given/When/Then):
- **R19-E5-S3-AC1 — coverage is per position, not global** — Given a connected profile, When
  the coverage block renders, Then it states per position whether scoring is `✓ full` or
  `◐ partial`, e.g. `QB RB WR TE ✓ full`, `K ✓ full`, `DEF ◐ partial — def_4_and_stop,
  st_ff, st_fum_rec not modeled`.
- **R19-E5-S3-AC2 — the count is on the page** — Given the unmodeled set, When the block
  renders, Then it reads `N non-zero keys contribute 0 — [ show them ]`, expanding to the
  named list from R19-E5-S2.
- **R19-E5-S3-AC3 — the chip follows the player, not just the page** — Given a position with
  non-zero unmodeled keys, When its cards render on **any** surface, Then they carry a
  **`PARTIAL SCORING`** chip, because the coverage block is not where a manager is standing
  when he makes the pick.
- **R19-E5-S3-AC4 — the dormant banner outranks everything** — Given D1, When the Scoring
  page renders, Then it still connects, still shows the table and still applies shape — and
  says at the very top that the points elsewhere are ESPN-PPR.
- **R19-E5-S3-AC5 — the densest surface still passes AA and still works on a phone** — Given
  the scoring table, When rendered at iPhone width, Then it collapses to one column per
  category group with a sticky category sub-header, and every new token pair passes
  `contrast_aa.test.mjs` — **extended, never relaxed**.

**Tasks:**
- [ ] R19-E5-S3-T1 — Build the coverage block from `classifyKeys` + `unmodeledBounds` (computed, never authored).
- [ ] R19-E5-S3-T2 — Add the `PARTIAL SCORING` chip to player cards across Players / Team / Lineup / Compare.
- [ ] R19-E5-S3-T3 — Implement the D1 banner precedence on the Scoring page itself.
- [ ] R19-E5-S3-T4 — Implement the iPhone-width collapse with the sticky category sub-header.
- [ ] R19-E5-S3-T5 — Add the new scoring-table token pairs to `tests/feature/contrast_aa.test.mjs` (**extend**).

**QA coverage:**
- AC1 → `tests/web/web.spec.mjs::coverage_block_is_per_position` (e2e) — Planned
- AC2 → `tests/web/web.spec.mjs::coverage_block_counts_and_expands` (e2e) — Planned
- AC3 → `tests/web/web.spec.mjs::partial_scoring_chip_on_player_cards` (e2e) — Planned
- AC4 → `tests/web/web.spec.mjs::scoring_page_banner_outranks_in_d1` (e2e) — Planned
- AC5 → `tests/feature/contrast_aa.test.mjs` (unit, **extended**) + `web.spec.mjs` iPhone-viewport case (e2e) — Planned
- **Coverage: 5/5 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/views/scoring.js`, `app/theme.css`,
`tests/feature/contrast_aa.test.mjs`, `tests/web/web.spec.mjs`.

---

### R19-E5-S4 — Custom scoring changes what I'm advised to draft — it does not retrain anything · Est: S
**As** a Manager **I want** the app to be blunt about what connecting my league does and
does not do to the model **so that** I never believe the projections got smarter when they
only got correctly denominated.

**Acceptance criteria** (Given/When/Then):
- **R19-E5-S4-AC1 — the Model tab says it plainly** — Given a connected profile, When the
  **Model** tab renders, Then it states: custom scoring does **not** retrain the Elo gate,
  does **not** change a signal weight, does **not** alter `proj_points` or any snapshot, and
  does **not** make projections more accurate — it makes them **correctly denominated**.
- **R19-E5-S4-AC2 — the promotion gate is untouched, and provably** — Given the release,
  When the gate runs, Then `data/meta.json` is unchanged, all 32 registry signals remain at
  weight **0**, and every committed projection row still carries `signals_used: []`.
- **R19-E5-S4-AC3 — nothing user-scoped writes to a shared model** — Given any profile
  action, When audited, Then no code path writes a per-user setting into the signal
  registry, `data/meta.json`, `game_predictions`, `playoff_odds`, `team_strength`,
  `model_tuning` or any snapshot the harness resolves.
- **R19-E5-S4-AC4 — what it *does* affect is listed too** — Given the same copy, When
  rendered, Then it names what genuinely changes: which players the fit engine recommends
  (VOR, best-pick-now, auction dollars, ADP value flags, lineup, Compare) and the stamped
  mock-draft record.
- **R19-E5-S4-AC5 — a component model is not a licence to change the model** — Given the
  temptation to add per-category aging, TD-rate regression or a completion model, When
  reviewed, Then it is refused for Rel19: those are **model changes** and must go through
  `scripts/promote_signals.py` at weight 0 behind the never-regress gate, not ride in on a
  scoring feature.
- **R19-E5-S4-AC6 — the third-party projection feed is display-only or absent** — Given
  Sleeper's own `/projections` endpoint returns rotowire component projections keyed by the
  exact scoring names, When considered, Then it is **not** a model input; if it appears at
  all it is a clearly attributed cross-check, the same posture as the display-only
  market-price rule.

**Tasks:**
- [ ] R19-E5-S4-T1 — Add the boundary copy to `app/views/model.js` in the exact words of SOLUTION_DESIGN §10.1.
- [ ] R19-E5-S4-T2 — Add the "what it does affect" list beside it.
- [ ] R19-E5-S4-T3 — Add a source-level assertion that no Rel19 module writes to the registry, `meta.json` or any snapshot.
- [ ] R19-E5-S4-T4 — Record the rejected model-change scope and the rotowire posture in `docs/backlog/DECISIONS.md`.
- [ ] R19-E5-S4-T5 — Add the "what a real player-level learning loop needs" note (weekly actual **components**, ~1.0–1.5 MB/season by column-count scaling — an **estimate**, not a measurement; its own baseline and its own never-regress gate) to `docs/roadmap/rel19/`.

**QA coverage:**
- AC1 → `tests/web/web.spec.mjs::model_tab_states_scoring_boundary` (e2e) — Planned
- AC2 → `tests/feature/signal_registry.test.mjs` + `real_data.test.mjs` day-zero assertions green **unmodified** (unit) — Existing
- AC3 → `tests/feature/never_regress.test.mjs::rel19_writes_no_model_state` (unit, source assertion, **added**) — Planned
- AC4 → `tests/web/web.spec.mjs::model_tab_lists_what_scoring_affects` (e2e) — Planned
- AC5 → `docs/backlog/DECISIONS.md` entry (doc) — Planned
- AC6 → `docs/backlog/DECISIONS.md` entry + `market_display.test.mjs` posture assertions green (doc + unit) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright), doc.

**Traceability:** `app/views/model.js`, `tests/feature/never_regress.test.mjs`,
`tests/feature/signal_registry.test.mjs`, `docs/backlog/DECISIONS.md`.

---

## EPIC R19-E6 · Nothing moves silently — the default path and the gate
**Owner:** P3 / P4, integrated last
**Answers:** Q6 (backward compatibility)
**Status:** 🔴 Not started

### Goal
A manager who never opens the Scoring page must not be able to tell this release shipped.
That is a mechanical property, locked by a test, not a hope — with exactly **one**
documented exception, announced in the release notes.

### Why it matters
This release touches the five engines that price every player in the app. The only thing
standing between "custom scoring" and "every number in the app quietly changed" is a
default path that **never executes the new code**, plus a gate that proves it.

---

### R19-E6-S1 — "I clear my custom profile and every number returns exactly to today's defaults" · Est: L
**As** a Manager who tries custom scoring and then disconnects **I want** the app to return
to exactly what it showed before **so that** experimenting with my league costs me nothing.

**Acceptance criteria** (Given/When/Then):
- **R19-E6-S1-AC1 — R3, byte-identical** — Given `profile == null`, When Players, Team,
  Lineup and Auction render, Then every rendered number is **byte-identical** to the
  pre-Rel19 build — compared as rendered strings, not as rounded values.
- **R19-E6-S1-AC2 — the bypass is structural, not a tolerance** — Given no profile, or a
  profile whose effective table is **byte-equal** to `ESPN_PPR_DEFAULT`, When points are
  computed, Then `player_components.json` is **not consulted at all** and
  `replacementLevel` / `fitScore` / `bestLineup` run their current arithmetic on their
  current constants. The default path never executes new code.
- **R19-E6-S1-AC3 — disconnect is one action and it is complete** — Given a connected
  profile, When I press **disconnect**, Then `nfl2026.league.v1` is deleted, the PPR/HALF/STD
  segment is re-enabled at its previously stored mode, and every surface returns to AC1's
  state without a reload.
- **R19-E6-S1-AC4 — a hand-edit back to PPR also bypasses** — Given I edit my table until it
  is byte-equal to ESPN-PPR, When surfaces render, Then `isDefaultPpr` is true and the
  bypass engages — a manager who edits their way home lands exactly home.
- **R19-E6-S1-AC5 — the template already exists** — Given `ros.test.mjs`'s *"zero-weight
  SoS/availability reproduces the raw sum EXACTLY (never-regress default)"*, When R3 is
  written, Then it follows that pattern — an existing, passing, default-is-identical lock.
- **R19-E6-S1-AC6 — rollback is one line** — Given a production problem, When the emergency
  stop is needed, Then deleting `nfl2026.league.v1` from `localStorage` (which the
  disconnect button already does) restores D0, and `git revert` of P2 → D1, of P4 → D0, with
  no migration, no data loss and no schema downgrade.

**Tasks:**
- [ ] R19-E6-S1-T1 — Implement `isDefaultPpr(profile)` as a byte-equality check over the effective table.
- [ ] R19-E6-S1-T2 — Implement the bypass in `adjustedPoints` and in every shape-taking engine entry point.
- [ ] R19-E6-S1-T3 — Write R3 in `tests/feature/components_reconcile.test.mjs`: capture pre-Rel19 rendered strings as a committed fixture, assert equality with `profile == null`.
- [ ] R19-E6-S1-T4 — Implement disconnect: clear storage, re-enable the segment at its stored mode, re-render without reload.
- [ ] R19-E6-S1-T5 — Add the e2e connect → disconnect → identical-board walk.
- [ ] R19-E6-S1-T6 — Document the rollback ladder in the release notes.

**QA coverage:**
- AC1 → `tests/feature/components_reconcile.test.mjs::R3_default_path_is_byte_identical` (unit) — Planned
- AC2 → `tests/feature/components_reconcile.test.mjs::bypass_does_not_read_components` (unit, source + behaviour) — Planned
- AC3 → `tests/web/web.spec.mjs::disconnect_restores_default_board` (e2e) — Planned
- AC4 → `tests/feature/league_profile.test.mjs::hand_edited_ppr_engages_bypass` (unit) — Planned
- AC5 → `tests/feature/ros.test.mjs` green **unmodified** (unit) — Existing
- AC6 → release-notes rollback section + `disconnect` e2e (doc + e2e) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright), doc.

**Traceability:** `app/team-logic.js`, `app/league-profile.js`, `app/league-store.js`,
`tests/feature/components_reconcile.test.mjs`.

---

### R19-E6-S2 — My scoring mode and my league never fight over the same number · Est: S
**As** a Manager **I want** one visible winner between the PPR/HALF/STD control and my
connected league **so that** I always know which rule set produced the number I am reading.

**Acceptance criteria** (Given/When/Then):
- **R19-E6-S2-AC1 — the league wins, visibly** — Given a connected profile, When the
  PPR/HALF/STD segment renders, Then it is **disabled** — not hidden — labelled
  `SCORING · OMILIA-US` with a link to the Scoring page.
- **R19-E6-S2-AC2 — the old key is preserved, not migrated** — Given `nfl2026.scoring.v1`,
  When a profile is connected, Then that key is **not** rewritten, migrated or deleted; it is
  superseded.
- **R19-E6-S2-AC3 — disconnecting restores the mode I had** — Given I was on HALF before
  connecting, When I disconnect, Then the segment re-enables at **HALF**.
- **R19-E6-S2-AC4 — `scoringAdjust` is untouched** — Given `scoringAdjust(ppr, rec, mode)`,
  When the release lands, Then its **signature and body are unchanged**, and
  `team_logic.test.mjs`'s exactness assertion (`ppr 300 / 100 rec → half 250, std 200`)
  passes **unmodified**.
- **R19-E6-S2-AC5 — one control, one number, everywhere** — Given a connected profile, When
  any surface renders points, Then no surface reads the segment mode for a custom-scored
  number, and no surface reads the profile for a default-scored one.

**Tasks:**
- [ ] R19-E6-S2-T1 — Render the segment disabled with the `SCORING · <league>` label and the deep link.
- [ ] R19-E6-S2-T2 — Preserve `nfl2026.scoring.v1` untouched; read it back on disconnect.
- [ ] R19-E6-S2-T3 — Assert `scoringAdjust`'s signature and body are unchanged (source assertion).
- [ ] R19-E6-S2-T4 — Add the precedence e2e case (connect → segment disabled → disconnect → mode restored).

**QA coverage:**
- AC1 → `tests/web/web.spec.mjs::segment_disabled_under_profile` (e2e) — Planned
- AC2 → `tests/feature/league_profile.test.mjs::scoring_v1_key_is_not_migrated` (unit) — Planned
- AC3 → `tests/web/web.spec.mjs::disconnect_restores_half_mode` (e2e) — Planned
- AC4 → `tests/feature/team_logic.test.mjs` scoringAdjust assertions green **unmodified** (unit) — Existing
- AC5 → `tests/feature/team_logic.test.mjs::precedence_is_exclusive` (unit, **added**) — Planned
- **Coverage: 5/5 = 100%.** Types: unit(node:test), e2e(Playwright).

**Traceability:** `app/views/players.js`, `app/views/team.js`, `app/league-store.js`,
`app/team-logic.js`.

---

### R19-E6-S3 — Compare finally honours scoring — the one number that legitimately changes · Est: M
**As** a Manager on HALF or STANDARD with no league connected **I want** to be told that
Compare's numbers changed **so that** a bug fix never looks like a silent re-pricing.

**Acceptance criteria** (Given/When/Then):
- **R19-E6-S3-AC1 — the defect, stated** — Given `app/views/compare.js:100`
  (`proj: Number(p.proj_points) || 0`), When reviewed, Then it is confirmed that Compare
  ignores **today's** PPR/HALF/STD toggle entirely — a pre-existing defect, not something
  Rel19 introduces.
- **R19-E6-S3-AC2 — D3 forces the fix** — Given the requirement that all player surfaces
  recalculate, When Compare renders under a connected profile, Then PROJ PTS comes from
  `adjustedPoints`, like every other surface.
- **R19-E6-S3-AC3 — it also fixes the default path, and that is a change** — Given HALF or
  STANDARD mode with **no** profile connected, When Compare renders, Then its numbers now
  honour the mode — which means they **differ** from pre-Rel19.
- **R19-E6-S3-AC4 — carved out of R3 explicitly** — Given R3's byte-identical default-path
  lock, When Compare is evaluated, Then it is an **explicitly enumerated exception** with its
  own named test — not a silent omission from R3's scope, and not a quietly relaxed
  assertion.
- **R19-E6-S3-AC5 — announced** — Given the release notes, When published, Then they carry a
  line naming this change and why it is a correction.
- **R19-E6-S3-AC6 — PPR users see nothing move** — Given PPR mode with no profile, When
  Compare renders, Then its numbers are **identical** to pre-Rel19 (the mode is a no-op at
  PPR), so the blast radius is only HALF/STD users.

**Tasks:**
- [ ] R19-E6-S3-T1 — Route `app/views/compare.js` through `adjustedPoints`.
- [ ] R19-E6-S3-T2 — Add the named Compare carve-out test alongside R3, asserting the exception is enumerated rather than implied.
- [ ] R19-E6-S3-T3 — Add the HALF/STD-changes and PPR-unchanged assertions.
- [ ] R19-E6-S3-T4 — Append the Compare e2e case to `tests/web/web.spec.mjs` (**P4-owned file — hand off from P3; see §8**).
- [ ] R19-E6-S3-T5 — Add the release-note line and a `docs/backlog/DECISIONS.md` entry.

**QA coverage:**
- AC1 → `tests/feature/components_reconcile.test.mjs::compare_defect_is_documented` (unit, source assertion) — Planned
- AC2 → `tests/web/web.spec.mjs::compare_uses_custom_scoring` (e2e) — Planned
- AC3 → `tests/web/web.spec.mjs::compare_honours_half_mode` (e2e) — Planned
- AC4 → `tests/feature/components_reconcile.test.mjs::R3_compare_carveout_is_enumerated` (unit) — Planned
- AC5 → release notes + `docs/backlog/DECISIONS.md` (doc) — Planned
- AC6 → `tests/web/web.spec.mjs::compare_unchanged_at_ppr` (e2e) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(Playwright), doc.

**Traceability:** `app/views/compare.js`, `app/team-logic.js`, `tests/web/web.spec.mjs`,
`docs/backlog/DECISIONS.md`.

---

### R19-E6-S4 — The gate ends green, on the real gate, with the locks intact · Est: M
**As** the Operator **I want** the full regression green with every named lock unmodified
**so that** I can ship this release knowing what it did and did not change.

**Acceptance criteria** (Given/When/Then):
- **R19-E6-S4-AC1 — the real gate command** — Given the release gate, When run, Then it is
  **`bash tests/run_gate.sh`** (`validate_data.py` → `smoke.sh` → `node --test
  tests/feature/*.mjs` → Playwright web + pwa), gating on **exit codes**. The brief's
  `tests/competition.test.mjs`, `tests/ux/` and `tests/integrated/` **do not exist in this
  repo** — do not create stubs to satisfy the typo.
- **R19-E6-S4-AC2 — the baseline holds and grows** — Given the completed release, When the
  gate finishes, Then it is **≥ 277 unit** and **≥ 82 E2E** (74 web + 8 pwa), all green.
- **R19-E6-S4-AC3 — the do-not-touch list** — Given the gate, When it runs, Then all of the
  following pass **unmodified**: `weekly_contract.test.mjs` (6), `real_data.test.mjs` (6),
  `ros.test.mjs` (9), `lineup.test.mjs` (5) incl. `__selftest()`, `draft_sim.test.mjs` (15),
  `team_rel2.test.mjs` (11), `team_vor.test.mjs` (13), `team_logic.test.mjs` (18) incl. the
  frozen fitScore fixture, `auction.test.mjs` (18), `availability_app.test.mjs` (21),
  `signal_registry.test.mjs`. **If one goes red, the build is wrong — do not "fix" the
  test.**
- **R19-E6-S4-AC4 — exactly zero existing assertions rewritten** — Given the diff, When
  reviewed, Then P3's test edits are **additions only**; if any existing assertion must
  change, it is escalated and justified in `docs/backlog/DECISIONS.md` before it lands.
- **R19-E6-S4-AC5 — the untouched-data proof** — Given the release, When
  `git diff --stat` is run, Then `data/player_projections.json`, `data/player_weekly.json`
  and both their schemas show **no change** attributable to Rel19's app work.
- **R19-E6-S4-AC6 — two new test files, no more** — Given the release, When the test tree is
  listed, Then exactly two new files exist — `tests/feature/league_profile.test.mjs` and
  `tests/feature/components_reconcile.test.mjs` — and every other new case is an addition to
  an existing file.
- **R19-E6-S4-AC7 — deploy gate** — Given a red gate, When a deploy is proposed, Then it is
  refused. Deploy is push to main → Netlify; the mandatory first post-deploy action is
  R19-E1-S1-AC7's production FETCH check.

**Tasks:**
- [ ] R19-E6-S4-T1 — Run `bash tests/run_gate.sh` with all four partitions on disk; gate on exit codes.
- [ ] R19-E6-S4-T2 — Diff-audit every `tests/feature/*.mjs` change for additions-only.
- [ ] R19-E6-S4-T3 — Run `git diff --stat` on the four protected data/schema paths and paste it into the release notes.
- [ ] R19-E6-S4-T4 — Update `docs/backlog/QA_COVERAGE.md` with the 25 new stories.
- [ ] R19-E6-S4-T5 — Write the release notes: the Compare carve-out, the rollback ladder, the production FETCH check, and the owner-blocked DEF/ST key question.
- [ ] R19-E6-S4-T6 — Record the corrected gate definition (no `competition.test.mjs` / `ux/` / `integrated/`) in `docs/backlog/DECISIONS.md` so the next release does not repeat it.

**QA coverage:**
- AC1 → `tests/run_gate.sh` exit code (gate) — Existing
- AC2 → `tests/run_gate.sh` full run (gate) — Planned
- AC3 → `tests/run_gate.sh` step 3 + step 4 (gate) — Existing
- AC4 → diff audit recorded in `docs/backlog/DECISIONS.md` (doc + gate) — Planned
- AC5 → `git diff --stat` in the release notes (gate) — Planned
- AC6 → `tests/run_gate.sh` step 3 file listing (gate) — Planned
- AC7 → deploy checklist, refused on red (gate) — Existing
- **Coverage: 7/7 = 100%.** Types: gate, doc.

**Traceability:** `tests/run_gate.sh`, `docs/backlog/QA_COVERAGE.md`,
`docs/backlog/DECISIONS.md`.

---

## 7. QA coverage rollup

| Epic | Stories | ACs | Automated | Coverage |
|---|---|---|---|---|
| R19-E1 · Connect my league | 5 | 31 | 30 | 96.8% |
| R19-E2 · Real component projections | 5 | 30 | 30 | 100% |
| R19-E3 · League shape drives value | 4 | 25 | 25 | 100% |
| R19-E4 · Nine slots, K and DEF | 3 | 19 | 19 | 100% |
| R19-E5 · The app tells me what it doesn't know | 4 | 24 | 24 | 100% |
| R19-E6 · Nothing moves silently | 4 | 24 | 24 | 100% |
| **Total** | **25** | **153** | **152** | **99.3%** |

> Coverage is **99.3%** against the Gate-3 ≥ 90% standard. The **single** manual AC is
> **R19-E1-S1-AC7**, the 30-second production FETCH check — irreducible by construction,
> because the one thing no sandbox can prove is whether a browser on the real domain can
> reach `api.sleeper.app`. Every other AC in this backlog maps to at least one named
> automated test.

**Test types used:** `unit` (`node --test tests/feature/*.mjs`), `e2e` (Playwright,
`tests/web/web.spec.mjs`), `data` (`scripts/validate_data.py`), `smoke` (`tests/smoke.sh`
plus the two new `--selftest` runners), `gate` (`bash tests/run_gate.sh`), `doc`
(`docs/backlog/DECISIONS.md`, release notes), `manual` (one).

**New test files (2):** `tests/feature/league_profile.test.mjs` (P1),
`tests/feature/components_reconcile.test.mjs` (P1).
**Extended, add-only:** `team_vor`, `team_logic`, `team_rel2`, `auction`, `draft_sim`,
`lineup`, `availability_app`, `never_regress` (P3); `contrast_aa`, `web.spec` (P4);
`tests/smoke.sh` (P2).
**Explicitly unmodified:** `weekly_contract.test.mjs`, `real_data.test.mjs`,
`ros.test.mjs`, `signal_registry.test.mjs`, `market_display.test.mjs`.

**The five gate tests, by name:** **R1** reconciliation 300/300 @ 0.011 (E2-S2-AC1) ·
**R2** id-set equality (E2-S2-AC3) · **R3** default path byte-identical (E6-S1-AC1) ·
**R4** every non-zero key classified (E5-S2-AC1) · **R5** unmodeled bounds sane
(E2-S2-AC5).

---

## 8. Sequencing

```
  P1 · SCORING CORE + CONTRACT  (E1-S1…S3, E1-S5, E2-S2)        ── LANDS FIRST ──┐
       app/league-profile.js · app/league-store.js · 3 schemas · 2 new test files │
                                                                                  ▼
  ┌── P2 · COMPONENT PIPELINE      (E2-S1, E4-S2, E4-S3 contracts) ──┐
  ├── P3 · ENGINES + SURFACES      (E1-S4, E2-S3…S5, E3-S1…S4,      ─┤ ── concurrent ──►  INTEGRATION
  │        E4-S1, E4-S3 app side, E5-S1, E6-S1…S3)                   │                    (E6-S4)
  └── P4 · SCORING PAGE + SHELL    (E5-S2…S4 surfaces, tabs, AA)   ──┘
```

**P1 is serialized first** — P2, P3 and P4 all import its pure scorer and its profile
shape. Pretending to four-way concurrency here would produce three agents blocked on the
same module.

**After P1, merge order is free and every ordering degrades safely:** P3 before P2 renders
`awaiting K/DST feed` slots for a pool that lacks them (harmless); P2 before P3 leaves
files nothing reads (harmless); P4 before P3 stores a profile the surfaces ignore
(harmless — that is literally state D1).

**File ownership is disjoint** per SOLUTION_DESIGN §12. Two coordination points to name
because they cross a boundary:

1. **`tests/web/web.spec.mjs` is P4-owned**, but P3's stories (E1-S4, E3-S1, E4-S1, E6-S3)
   need e2e cases in it. P3 writes the case bodies and hands them to P4 to append; P4 is
   the only agent that edits the file.
2. **`scripts/validate_data.py` is P2-owned**, but the `player_components ↔
   player_projections` id-set check (E2-S2-T6) is P1's contract. P1 specifies it; P2 lands it.

`app/ros.js` is touched by **nobody** — `ros.js:112` already reads `opts.cutoffs ||
STARTER_CUTOFFS`, so only the caller changes.

---

## 9. Explicitly out of scope for Rel19

| Item | Why | Where it goes |
|---|---|---|
| Migrating the **default** (no-profile) replacement level from per-roster to league-wide | It is the weaker definition, but with no league connected the app genuinely does not know the team count, and changing it would move every number for every user inside a feature that promises the opposite. | Its own release, with a published before/after diff |
| Closing the long-play and per-game bonus keys (`*_40p`, `bonus_*_yd_*`) | `stats_player_week` carries `passing_40` / `rushing_40` / `receiving_40` and per-game yardage, so this is cheap — but it is a new join and a new dormancy surface, and Rel19 already has two. | Rel20 |
| Decoding ESPN's unlabelled bucket statIds | A best-fit decode reconciled **2 kickers exactly and then only 33 of 42**. Forbidden until a decode is *proved* against a league whose scoring prices the bonus. | Blocked on a proof, not scheduled |
| `def_4_and_stop`, `st_ff`, `st_fum_rec` | `def_4_and_stop` needs play-by-play. `st_ff` / `st_fum_rec` are blocked on an **owner question**: Sleeper's DEF/ST key semantics overlap (`fum_rec` vs `def_st_fum_rec`; `ff` vs `def_st_ff` vs `st_ff`) and the payload does not say which fires on which event. Parked as disclosed zeros. | Owner decision, then a later release |
| Per-category aging, TD-rate regression, a real completion model | Model changes. They go through `promote_signals.py` at weight 0 behind the never-regress gate — never riding in on a scoring feature. | Behind the promotion gate |
| Player-level backtesting / grading projections under a custom table | Needs weekly actual **components**, not a weekly PPR total (~1.0–1.5 MB/season by column-count scaling — an estimate, not a measurement), plus its **own** baseline and its **own** never-regress gate. | Rel20+, building on `rel18/BACKTEST_DESIGN.md` |
| Sleeper's `/projections` (rotowire) as a model input | A third-party commercial projection. Display-only or absent, same posture as the market-price rule. | Cut as an input; permitted only as an attributed cross-check |
| IDP scoring | The 17 IDP keys are all zero in this league and IDP slots have no projection. They round-trip through the editor and surface as `unsupported`; they are not scored. | Not scheduled |
| A Netlify function proxy for Sleeper | Adds a server dependency to a deliberately static app, for a problem the header evidence says does not exist — and the paste tier already covers the failure case. | Cut |
| Pipeline-side or build-time league fetch keyed by a committed league id | Single-tenant, puts a cron between "I edited my scoring" and "the app agrees", and contradicts D1. | Cut |
