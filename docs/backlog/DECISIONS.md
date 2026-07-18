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

## 2026-07-17 — 5-yr history + trajectory, learning-loop wiring, environment model, Fit Engine v2 (AI toggle)
**Decision:** (1) 5-year player history (`scripts/scrape/espn_history.py` -> `scripts/build_history.py`
-> `data/player_history.json`, 300 players): per-season lines plus an OLS trajectory slope and an
age-curve residual, so a player's raw trend is separated from expected age decline. `trajectory.source`
is `measured` only with >=3 real seasons, else `ai_estimated`; the history contract stays LOUD if the
measured count drops below the floor. (2) LEARNING LOOP now wired end-to-end: `scripts/resolve_locks.py`
grades any locked snapshot whose game is FINAL (STATUS-gated, idempotent no-op otherwise) and
`scripts/refit.py` grid-searches game params against the resolved locks, adoption NEVER-REGRESS gated
(margin 0.0015) with every trial archived in `data/model_tuning.json`. Both run as the first two steps of
daily.yml and gameday.yml. `build_predictions` reads adopted `game_params` (defaults are byte-identical to
elo.py incumbents today) and chains 2026 FINAL results onto the reverted 2025 priors via
`rate_season(..., initial_ratings=priors)` (no-op with zero 2026 finals). (3) Environment model
(`scripts/scrape/stadiums.py` + `scripts/build_environment.py` -> `data/environment_model.json`): HFA,
turf-vs-grass, dome-vs-open, cold-weather, and international-bias effects MEASURED from 1,359 FINAL games
(2021-2025) joined to 698 Open-Meteo kickoff-hour weather rows. EVERY effect enters at weight 0 /
`params.applied=false` — recorded, not yet trusted; the optimizer must earn each weight. (4) Fit Engine v2
(`fitScoreV2` in `app/team-logic.js`) adds trajectory + cold-context terms with provenance in every reason
string, gated behind a per-device AI on/off toggle (`app/views/team.js`, localStorage `nfl2026.ai.v1`,
default OFF; BASE path is byte-identical to v1). AI estimates (`scripts/ai_estimates.py` ->
`data/ai_insights.json`) are default-off, each field `{value, source, why}` with |value|<=0.25, always
labeled `AI EST` in the UI.
**Findings (recorded at weight 0, predictive only once earned):** international designated-home won
58.3% of 24 games (avg margin +0.58 -> +31 Elo tilt, thin n); cold (<32F open-air) tilts cold-home teams
positive (BUF +0.195, NE +0.154, CHI +0.068); 5-yr venue HFA spreads wide (BUF 82.9%/+12.4, KC 73.8%,
GB 70.7% vs ARI 31.7%, NYJ 35.7%); grass homes 56.6% vs turf 51.5% (confounded with team quality);
dome teams in outdoor cold negligible (+0.067, n=11).
**Rationale:** User asked to improve the Fit Engine with agentic/generative estimates behind a toggle, and
to look at HFA / turf-grass / dome-open / cold-weather / international bias. Everything measured is admitted
at zero weight so no unproven signal moves a prediction until it beats the incumbent under NEVER-REGRESS.
**Status:** adopted. Gate at 92 unit + 19 e2e, all green.

## 2026-07-17 — REL2: visible AI+, QB cap, trend + strength-of-schedule, finder/reco sort, named byes
**Decision:** Second feature release from prod review. (1) AI+ is now VISIBLE: on the TEAM
recos each pick shows a base->AI+ score delta (recommendV2 carries the v1 `base` score) plus a
one-line explainer of what AI+ optimizes (5-yr trajectory, cold-weather, stack synergy -> weekly
ceiling / playoff odds); and AI+ now also re-ranks the PLAYERS list by an AI-adjusted projection
(proj x (1 + trajectory_adj), bounded +/-25%) with the per-player delta shown, so "nothing changes
when I toggle AI" is fixed on both surfaces. (2) Fit-engine POSITION CAPS (app/team-logic.js
POSITION_CAPS = QB 2, DEF/DST/K 1): recommend()/recommendV2() drop capped-position candidates, so
no 3rd QB is ever proposed for a bench slot; the finder disables a capped ADD with a "<POS> FULL"
label. DEF/K caps are ready but no K/DEF slots are added (still unmodeled -> no fabricated numbers).
(3) Per-player STRENGTH OF SCHEDULE 1.0 (easiest) - 5.0 (hardest), one decimal: strengthOfSchedule()
maps mean opponent Elo around the 1500 mean at a fixed, documented sensitivity (SOS_ELO_PER_POINT=25),
fed by a new data/team_strength.json (the exact Elo ratings build_predictions already priced games
with, published + contract + validator mapping; bootstrap file reconstructed from committed game
probabilities, residual <0.06 Elo, and overwritten byte-exact by the next cron). (4) AI TREND chip
per player card (up/down/flat + pts/yr, "5-YR" when measured / "AI EST" when age-curve estimated),
from player_history/ai_insights via trendLabel(). (5) FINDER + RECO SORT/FILTER: finder gains a
position filter and PTS/TREND/BYE sort buttons with a direction arrow; recos gain BEST FIT / BEST
AVAIL sort (recommend sort option). (6) Named byes: the starters summary lists WHO is on bye each
week (team + name), clashes (>=2) keep the warn styling, singles are info chips. All new signals stay
labeled ESTIMATE; the AI multiplier is bounded and never touches game_predictions or meta weights.
**Rationale:** Direct prod-review feedback. The AI layer existed but was invisible and confined to
recos; the fixes make its effect legible AND honest (bounded, provenance-labeled) without inventing
new weight for unproven signals. SoS reuses measured Elo so it can never disagree with the game model.
**Status:** adopted. Gate at 106 unit + 27 e2e (both web and standalone-PWA), validate + smoke green.
Also fixed a latent red on main: tests/feature/real_data.test.mjs now routes the gameday cron's
archived game_predictions.<ts>.json snapshots out of the lock-honesty scan (same two-family split as
the Rel1 validator fix; the archive is a dict, not a lock array).

## 2026-07-17 — REL3: enriched roster line, draft board, glossary, iPad layout, 2-7 leg parlays
**Decision:** Third feature release from prod review. (1) ROSTER LINE ENRICHMENT: an added
player's slot now shows the same context as the finder — trend arrow, strength-of-schedule, and
bye week — on a `.sp-meta` line, not just the current-week points. (2) GLOSSARY: a `<details>`
legend on the TEAM tab (and an inline one on PARLAYS) defines PROJ / TREND / SoS / BYE / AI+ / TAKEN
and states what the sort arrows mean (▼ descending high→low, ▲ ascending low→high). (3) DRAFT BOARD:
a per-player TAKE/TAKEN toggle (persisted localStorage nfl2026.taken.v1) marks players drafted by
other managers; the fit engine reads an availablePool() = projections minus taken, so recommendations
re-optimize instantly from the remaining players. A HIDE/SHOW TAKEN finder control switches between
greying taken players and removing them. (4) iPad 13" RESPONSIVE: a >=820px breakpoint (progressive
enhancement — phones untouched) centers + caps the content, turns the team builder into a two-column
grid (build column beside a sticky reco+summary), lays the roster out 2-up (3-up >=1200px), and turns
the players/parlays lists into an auto-fill card grid — far less vertical scrolling on a big screen.
(5) PARLAY LEG SELECTOR: parlay_builder gains build_week_parlays_multi — cross-game week parlays
bucketed by leg count 2..7 (a few per count, ranked most-likely-to-hit; distinct games per parlay),
and the PARLAYS view gains a 2..7-leg selector built from the counts present in the active scope.
Same-game parlays stay <=3 legs (one game fields ~3 markets); the >=3/game and >=3/week invariants
hold (the 2-leg week bucket covers the week floor, with a fallback to the old builder on tiny slates).
**Rationale:** Direct prod-review feedback. Draft support makes the fit engine usable in a live draft
(its headline purpose); the enriched line + glossary close the "what does this mean / where's the
context" gap; the iPad layout matches how it will actually be used on a 13" screen; the leg selector
turns the parlay engine into the 2-7 leg tool requested. No new unproven weight enters the model.
**Status:** adopted. Gate at 109 unit + 33 e2e (web + standalone PWA), validate + smoke green.

## 2026-07-17 — REL4: learning loop ADOPTS, game-script validated, odds+props, VOR draft AI, O-line, injury-aware weekly
**Decision:** (1) FIRST REAL PARAMETER ADOPTION. scripts/backtest.py walk-forward backtests the Elo
game model on 1,084 real FINAL games (2022-2025, leak-free predict-before-update), 45-trial grid over
hfa x revert x k, NEVER-REGRESS gated: candidate hfa=45 / revert=0.45 / k=25 beat the incumbent
(mean log-loss 0.6409 -> 0.6369, margin 0.0015 cleared) and was ADOPTED into data/model_tuning.json
game_params — every 2026 game probability now prices with the fitted params (all 16 slate probs moved,
e.g. SEA-NE 0.651 -> 0.610). All 45 trials archived in history. (2) GAME-SCRIPT THEORY VALIDATED
(descriptively, 272 FINAL 2025 games): winners out-rush losers +7.5 att (30.6 vs 23.1) and attempt
FEWER passes (-4.0); winner-minus-loser rush-share gap +0.101, correlation with margin +0.249;
blowout winners rush-share 0.536 vs 0.482 in one-score games; garbage time confirmed — teams trailing
>= 14 entering Q4 (n=89) score 7.15 Q4 pts vs their own 2.51/quarter pace (+4.64 uplift) with a 59.6%
Q4-TD-proxy rate. Recorded in data/game_script.json at weight 0 / applied=false with an explicit
causation caveat (winners-run conflates cause and clock-kneeling effect). (3) REAL ODDS WIRED:
scripts/scrape/odds_api.py (The Odds API v4, pairwise de-vig, renames-matched to our game ids);
build_predictions consumes it when ODDS_API_KEY is set, degrades loudly to model seeds when not.
(4) PLAYER-PROP LEGS: top QB/RB/WR per game (qb_pass_yds 225+, rb_rush_yds 60+, wr_rec_yds 60+ seeds,
win-prob-shaded probs clamped [0.35,0.65], estimate-labeled) flow through build_game_parlays — parlay
markets now span ML/spread/total/props. (5) INJURY-AWARE WEEKLY: Out 0.55 / Doubtful 0.7 /
Questionable 0.9 on the first 3 non-bye weeks, renormalized so the season total is EXACTLY preserved
(28 of the top 300 shaped this run; model.injury_shape records it). (6) ROOKIE ESTIMATES: 0-season
players get documented year-2-delta priors (WR +0.06 / RB +0.04 / QB +0.03 / TE +0.02, ai_estimated).
(7) DRAFT VOR: team-logic replacementLevel/vorScore/bestPickNow (FLEX-aware demand, deterministic);
the TEAM tab paints a BEST PICK NOW strip from the taken-filtered pool with scarcity warnings.
(8) O-LINE COMPOSITE: 32 teams from live ESPN rosters (weight/age/experience/continuity z-blend;
nflverse snap refinement on the runner; NYG/PHI/ARI strongest, PIT/MIA/MIN weakest this run) ->
data/oline_composite.json feeding the registered weight-0 ol_composite_vs_dl signal. (9) Players view
gained the WHAT-DO-THESE-MEAN legend; pipeline_status now written LAST so odds/game-script/oline
feeds are in it; weekly cadence: every daily/gameday run refreshes rosters, injuries, oline,
insights, so SoS/Trend/fit inputs track personnel changes automatically.
**Rationale:** Rel4 user asks: explanations everywhere, weekly-updating AI data, validate the
win-run/lose-pass theory, and roadmap items 1-8. The backtest adoption is the learning loop's first
real earn — fitted on resolved history through the same gate in-season refits will use.
**Status:** adopted. Gate at 152 unit + 36 e2e, validate + smoke green. Odds feed stays degraded
until ODDS_API_KEY is set (manual handoff documented in the PR).

## 2026-07-17 — POLICY: predictions are market-independent (permanent)
**Decision:** Market prices (Vegas books, Kalshi, Polymarket) are DISPLAY ONLY, forever. They are
shown next to our probabilities as the scoreboard we measure ourselves against and are NEVER an
input: no model, optimizer, fit score, parlay probability, or simulator reads them. ENFORCED, not
conventional: validate_data.py MARKET_DISPLAY_ONLY pins market_spread / market_moneyline /
market_total / odds_api / kalshi / polymarket at weight 0.0 permanently — a non-zero weight reds the
gate and nothing deploys (locked by tests/feature/market_prices.test.mjs "POLICY GATE"). The
optimizer grids (backtest/refit) structurally exclude market signals. Every market surface carries a
"MARKET · DISPLAY ONLY" badge.
**Rationale:** Owner directive: "I want my analytics and AI to be priority... using polymarket or
kalshi can be shown, but should not be included in the weighting. I want to operate independently of
Vegas for predictions." Beating the markets is the goal; blending them in would make the comparison
circular.
**Status:** adopted.

## 2026-07-17 — REL5: market scoreboard, MODEL tab, playoff simulator, nflverse aggregates, unconfigured feeds
**Decision:** (1) MARKET SCOREBOARD (display-only per the policy above): ported the wc2026 Kalshi +
Polymarket scraper patterns to NFL — scripts/scrape/kalshi_nfl.py (anonymous API, KXNFLGAME game
events + KXSB-27 champion futures, last-trade/midpoint pricing, never fabricates a dead book) and
polymarket_nfl.py (keyless Gamma, "NFL Champion 2027" de-vigged) -> build_markets.py joins onto OUR
schedule (ticker-date + canonical-abbrev matching, unmatched dropped loudly) -> data/market_prices.json.
Slate game cards gain a MODEL-vs-KALSHI-vs-POLYMKT strip when a game is priced. First real read:
Polymarket champion field has LAR 15.0% while OUR simulator says SEA 15.0% — the scoreboard works.
(2) MODEL TAB (5th tab): adopted params vs defaults, walk-forward backtest trial bars, lock-grading
status, the 32-signal registry with DISPLAY-ONLY badges (UI list mirror-locked to the validator set
by test), and the playoff-odds table with market futures alongside. (3) PLAYOFF-ODDS SIMULATOR
(scripts/simulate_season.py): deterministic 10k-season Monte Carlo from schedule_full probs (adopted
params) + Elo playoffs; simplified documented tiebreakers (h2h, division, conference, RNG);
accounting locked by test (champion sums 1, playoff 14, division 8, conference 2). Our first
future-timescale product: SEA 15.0% / JAX 8.9% / HOU 8.9% champions. (4) NFLVERSE AGGREGATES
(scripts/build_nflverse_aggregates.py): combine BENCH-PRESS joined to current OL rosters (the
composite's original strength design — build_oline folds it in as a 4th z-term when present,
3-term byte-identical otherwise) + play-by-play SCORE-STATE rush shares (game-script v2: situational
at-the-snap splits that remove the kneel-down confound). Release host 403s in the sandbox ->
selftest-fixture-verified math; the cron fills real data on the GH runner (depth-chart continuity
deferred, documented). (5) 'UNCONFIGURED' FEED STATE: schema + validator + smoke + UI distinguish
"not turned on" (odds_api awaiting its key — excluded from the health roll-up, shown as
"N AWAITING CONFIG") from real degradation. Board after this release: kalshi ok, polymarket ok,
playoff_sim ok, odds_api unconfigured; nflverse flips ok on the runner. (6) WEEKLY BACKTEST CRON
(.github/workflows/backtest.yml, Tuesdays): resolve locks -> full 45-trial grid -> NEVER-REGRESS
adoption -> commit. The learning cadence is now autonomous.
**Rationale:** Rel5 scope as approved (P1+P2+P3, MODEL tab, game winners + SB futures). Analytics
first: everything new is our own model or context for it; markets are strictly the yardstick.
**Status:** adopted. Gate at 178 unit + 41 e2e, validate + smoke green.

## 2026-07-17 — FIX: cron data commits now deploy to Netlify ([skip ci] -> [skip actions])
**Decision:** Cron data commits used "[skip ci]", which GitHub Actions AND Netlify both honor — so
every data refresh (daily, gameday scores, backtest) was committed to main but NEVER deployed to
prod; the live site only picked up data when the next feature merge triggered a build. Discovered
during Rel5 prod verification (the runner cron flipped health to ok on main while prod kept serving
the older board). Fixed by switching the three cron workflows to "[skip actions]" — a GitHub-only
skip token: the CI gate still skips data commits (no runner burn), Netlify now builds them, so prod
data is as fresh as the crons.
**Status:** adopted.

## 2026-07-18 — REL6: promotion gate verdict, draft simulator (beat-ADP benchmark), defense composite, depth continuity, RESET, UI polish
**Decision:** (1) SIGNAL PROMOTION RAN — AND THE GATE SAID NO. scripts/promote_signals.py wired
venue-specific HFA + cold-weather deltas into the Elo win probability and walk-forward backtested a
4x4 scale grid on 2022-2025 (leak-free: each season's features fit only on prior seasons; rating
updates stay flat-HFA so candidates shift pricing, never trajectories). EVERY candidate scale scored
worse than the incumbent out-of-sample (best 0.63690 = the zero-scale row); NEVER-REGRESS retained
the incumbent, all 16 trials archived in model_tuning history, and the signals stay at weight 0. The
application path (game_params.venue_hfa/cold_hfa -> per-game hfa_eff in build_predictions) is wired
and dormant, so any future adoption flows into probabilities automatically. Locked by test: the gate
must never adopt on a tie, and applied must stay false. (2) DRAFT SIMULATOR (app/draft-sim.js, pure
+ seeded): snake drafts vs a room of ADP-drafting opponents (FantasyFootballCalculator keyless feed,
89.9% joined to our pool; per-round noise sigma 2+1.25/round, need-aware incl one backup per
position, hard caps enforced) with our picks advised by adjusted points + a 150-sim survival
lookahead ("N% survives to your next pick"); result = starters-total margin vs the room average (the
BEAT-ADP score) with rank. ADP-room mocks lock to localStorage nfl2026.mocklocks.v1 as learning
records (graded when real points resolve -> fit-engine coefficient refits through NEVER-REGRESS);
the opt-in SHARK room (opponents = our engine) is a stress test excluded from the learning record.
League size 8/10/12 + slot + roster composition configurable (bounded: QB 1-2, RB/WR 2-3, TE 1-2,
FLEX 0-2, bench 4-8). ADP POLICY BOUNDARY: opponent model + value flags only, never blended into
projections. (3) DEFENSE COMPOSITE (scripts/build_defense.py): 32 teams from live ESPN rosters,
front size/experience + secondary experience z-blend (WAS/NYG/NO strongest, LV/KC/MIA weakest this
run) — the OL-vs-DL signal's other half, weight-0 pinned until in-season player-level grading can
promote a matchup term. (4) DEPTH-CHART CONTINUITY: build_oline records returning_starters_ol (last
season's week-max depth-chart OL starters still on the current roster; runner-only feed, context
metric). (5) RESET: one button, two-step confirm (arm -> wipe roster + TAKEN + draft; any other
action disarms). (6) UI POLISH: aligned candidate/best-pick grids, uniform chip heights + tap
targets, toolbar row (AI toggle + RESET), scrollable MODEL playoff table on phones, market-strip
attachment fix, draft-sim card styling. New feeds: adp + defense in pipeline_status.
**Rationale:** Rel6 items 1-4 as approved + reset + the owner's overnight directive (UI cleanup,
gate to 100%, ship unattended). The promotion "no" is the system's honesty working in public: tested
properly, recorded, not adopted.
**Status:** adopted. Gate at 194 unit + 45 e2e, validate + smoke green.

---

## REL7 — Predictive core: family promotion gate, EPA history, rest signal, calibration (2026-07-18)

**Decision:** Deepen the self-learning predictive core (owner-approved slate: "Predictive core"
over pages/draft-assistant). (1) FAMILY PROMOTION GATE v2 (scripts/promote_signals.py): candidate
families — environment (venue x cold, the Rel6 grid), rest (rest-day differential from kickoff
dates, clamped ±7, Elo/day scales 1.5-6), epa_total and epa_pass (rolling EPA-margin differential,
shrunk n0=600 plays, prev-season blended, scales 200-500 Elo/unit) — each walk-forward tested
2022-2025 ON TOP of the incumbent (flat params + previously adopted families, features recomputed
leak-free). At most ONE family adopted per run, only past the 0.0015 NEVER-REGRESS margin;
--auto-adopt writes game_params, otherwise dry-run. First live run: environment all worse (matches
Rel6 exactly — refactor semantics preserved); REST improved at every scale (best 4.5 Elo/day:
0.63690 -> 0.63660, Δ+0.00030) but BELOW the margin — retained, recorded. The gate saying "real
direction, not enough evidence" is the design working. (2) EPA HISTORY (scripts/build_epa_history.py):
per team-season-week EPA sums (off/def x pass/rush) streamed from nflverse pbp releases 2021-2026;
runner-built (sandbox proxy 403s nflverse), past seasons cached immutable, current season refreshed
weekly; --selftest fixture-driven; contract + validator (optional until the bootstrap dispatch).
(3) SELF-LEARNING CRON: backtest.yml now runs resolve -> epa_history -> backtest -> promote_signals
--auto-adopt -> validate -> commit, every Tuesday. The EPA families activate the first time the
runner lands epa_history.json. (4) MODEL TAB: PROMOTION GATE card (per-family verdict chips:
ADOPTED / RETAINED / AWAITING DATA, best loss + Δ vs incumbent) and CALIBRATION card (10-bin
predicted-vs-actual walk-forward reliability, 1084 games) — the self-learning loop is now fully
visible in the product. (5) APPLICATION PATH: build_predictions applies adopted rest_hfa (schedule
rest diffs) and epa_hfa (rolling margins) per game — dormant until adoption, loud if EPA data
missing. **Rationale:** the top public models (nfelo, PFF, Sumer) price off EPA and rest; ours now
tests the same families through a stricter adoption discipline than any of them publish.
**Status:** adopted. Invariant tests (rel7_contracts) stay true before AND after any future adoption.

---

## REL9 — Auction + snake live draft room (2026-07-18)

**Decision:** One draft room, four modes (owner-approved: "Auction + snake live room" + AAV feed +
live tendencies): FORMAT (SNAKE/AUCTION) x PLAY (SIM/LIVE). (1) AUCTION ENGINE (app/auction.js,
pure+seeded): fairDollars = VOR->$ over the league budget ($1 floor, budget-adjustable 100/200/300);
marketDollars = ADP-consensus exponential price curve calibrated so the draftable pool absorbs
EXACTLY teams x budget (FFC publishes no AAV — this is a documented transform of real ADP, corrected
live by observed sales; policy boundary: market $ model opponents only). Live INFLATION = remaining
room dollars / remaining fair value after every sale. Nomination classifier: BAIT (market >=15%
over ours — nominate early, drain budgets), TARGET (ours >=15% over market — hold late, buy the
discount), NEUTRAL. ROOM LEARNING: every opponent starts at the market prior and EW-updates a
positional overpay tendency (alpha .3, clamped .6-1.6) from observed sales — my own buys never
update my profile. Opponent bid model: market x tendency x inflation x noise, capped by max bid
(budget - $1 per open slot) and need. English-auction resolution: winner = top willingness, price =
second + 1. (2) STRATEGY DIALS, live-flippable mid-draft: STARS&SCRUBS <-> BALANCED (per-slot budget
plan re-solves), PATIENT <-> AGGRESSIVE (bid ceiling +8%), ENFORCE ON/OFF (bid up players we do not
want to 85% of adjusted value so nobody steals discounts). (3) THREE-ZONE ROOM (ROOM | THE BLOCK |
MY BUILD) side-by-side >=1024px — the owner's standing directive: TEAM page optimized for 13"
iPadOS/laptops — stacked on phones. ROOM: inflation gauge, per-team budget/max-bid/needs/learned
tendencies. BLOCK: our $ / inflation-adjusted $ / market $, BAIT/TARGET chip, bid-to verdict with
credible-threat list, +/- bid steppers; LIVE mode records real sales (team + price). BUILD: budget
bar + plan vs bought. (4) SNAKE LIVE: takeOpponentPickAt records the real room's observed picks
(tap who they took); my turns keep VOR + survival advice. (5) Auction results lock to the learning
record (kind auction, sim/live tagged). **Status:** adopted. Gate 215 unit (+15) / 53 e2e (+5),
validate + smoke green. REL6 league-grid design lock updated 3 -> 5 fields (FORMAT + PLAY added).
