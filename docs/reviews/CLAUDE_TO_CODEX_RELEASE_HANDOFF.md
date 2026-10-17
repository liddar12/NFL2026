# Claude → Codex release handoff: PR #174 (R133 parlay controls)

Revision 4. After Codex closed RC-01..RC-03 on `f8cca7e5`, revision 4 corrects the RC-03 probability comparison in section 2a to matched game populations. Revision 3 added the CI fix in section 4. Revision 1 written 2026-10-17 (America/Chicago afternoon) by Claude Code, at the owner's request. This is a **reviewable
checkpoint, not a release**.

- PR #174 stays **draft**. Nothing here is merged or deployed to production.
- **Release boundary (Codex, after closing RC-01..RC-03 on `f8cca7e5` with no new blocking code findings):**
  - #174 is a **UI-only** release candidate (R133 parlay controls). It is not the self-learning release.
  - [#175](https://github.com/liddar12/NFL2026/pull/175) and [SelfLearning #10](https://github.com/liddar12/SelfLearning/pull/10) stay separate. Both still need fixes and combined verification.
  - Merging or deploying #174 requires the owner's approval.
- Codex reviews the next release candidate independently.
- Claude makes **no further changes to this review candidate** until Codex has finished. Other work goes on a
  separate branch.

## 1. Identities

| Item | Value |
|---|---|
| PR under review | [NFL2026 #174](https://github.com/liddar12/NFL2026/pull/174), draft |
| Head branch | `claude/practical-heisenberg-o9zg3m` |
| Base | `main` at `28f7ac3b1dca55ecfe1e8ffc2a8dbbbe61d38d2b` (data commit, 2026-10-17); main had not moved when this was written |
| Round 1 source commit | `8c010d71a95d8c4edc310a352eec961d19c17333` (gate PASS; CI run 39041773167 success) |
| Round 2 source commit | `101e3925848e138a52d450e8c0f0db134646da2e`, reviewed by Codex as head `f31c5740` (request changes: RC-01..RC-03) |
| Round 3 fix commit | `af41d0f6e7417208e6f27b1c98f5b48f40b62ad8`: the RC-01..RC-03 fixes (local gate PASS; CI gate on its handoff head `28e29d90` aborted, see section 4) |
| **Tested source commit (round 3)** | **`0436dd4bf01b2c90cfdd86948cbd86fbbcf79c6b`**: `af41d0f6` plus the RC-03 oracle memory fix (test file only). The full gate in section 4 ran on exactly this tree. |
| Final PR head | The commit that updates **this file** (revision 4). Its only diff from `0436dd4b` is this file. Its SHA is reported separately in the PR conversation, because a file cannot name its own commit. |
| Preview URL | https://deploy-preview-174--nfl2026.netlify.app/#/parlays. Netlify builds every push, so the preview deploys the final PR head. |
| Related, separate | [NFL2026 #175](https://github.com/liddar12/NFL2026/pull/175), draft, "Sunday parlay learning pilot", branch `build/week6-learning-runtime-20261015`, head `3ea2a2279a08e6ee55a8e80a37861a6788f68108`, base `28f7ac3b` |
| Related, separate | [SelfLearning #10](https://github.com/liddar12/SelfLearning/pull/10), draft, branch `build/nfl-feedback-runtime-20261015`, head `c1bf3d4773312c99ef0f30563c791525389fd5af`, base `aa5bbaed` |

## 2. What changed and why (R133; roadmap entry in `docs/ROADMAP_2026-27.md`)

The owner raised these from week-6 screenshots and two rounds of preview review.

1. **"ALL HIT 1" sat above "No parlays in that bucket."**
   - RCA: the bucket chips painted `summary.parlays.buckets`, which counts every scope and every review row. The list shows one scope's slate.
   - The single week-6 all-hit was a GAME card (DEN ML + Smith-Njigba 60+). It came from a slate replaced before kickoff, when the TNF pick flipped to SEA at 0.5011. It is not on the current slate or the archive.
   - Fix: the chips count the **active scope's cards on the slate shown**, through the same resolver the bucket filter uses. Other graded rows of that scope go on a separate "not on this slate" line (`app/views/parlays.js` `paintBuckets`; `app/review.js` `parlayRowCount`).
2. **One leg control everywhere.** A − n + stepper replaces the 2 LEG … 7 LEG chips.
   - Published cards: ALL, then the slate's counts.
   - Built cards: 2–10 on WEEK, 2–7 on GAME.
3. **Bet types (WEEK and GAME)** replace the TD pills there. MY keeps its own TD pills and dial.
   - Chips: **PUBLISHED** (the curated, graded slate, and the default), **ALL**, **ANYTIME TD**, **PASSING**, **RUSHING**, **RECEIVING**, **MONEYLINE**.
   - Choosing kinds builds cards live from `data/leg_pool.json` (`app/bet-types.js`).
4. **Round 2 RCA: ALL and "+ MONEYLINE" read as moneyline-only cards.**
   - Each player had offered the *hardest* line still at 50%+, which put props at about 52–62%. A 65–84% moneyline therefore won every game's single slot.
   - Fix: a player offers his **most likely line**.
   - Every card is **forced to mix**: it carries min(n, kinds) different kinds.
   - When MONEYLINE is chosen (ALL included), the **two most likely moneyline-only cards** show in their own section.
   - Mixed cards sort by **MOST LIKELY** or **BIGGEST PAYOUT**.
   - Week 6, at model prices: a 7-leg ALL card is 33.0%, against 13.3% for the best moneyline-only card.
5. **Confidence.** Every leg, published and built, carries a HIGH / MED / LOW tag and a **green / yellow / red outline**, using the MY dial's lines: ≥ 0.65, ≥ 0.50, otherwise LOW.
6. **GAME.**
   - One game, picked from a **dropdown** of this week's games still to play, at 2–7 legs.
   - Rules: one leg per player, never both moneylines, R74 sides respected.
   - A pair is priced by the same-game model (`combinedGameProbs`, verified equal in tests).
   - **3–7 legs are an estimate.** Each leg is folded in with `combineTwo` at the mean measured correlation to the legs already on the card. It is labelled **"EST. MODEL HIT"** with an explanatory note.
   - The owner chose this. No backtest validates 3+ same-game legs (RCA F03).
7. **Not offered:** O/U (no game-total model) and spread (a flat 0.5).

## 2a. Codex review of `f31c5740` — findings and fixes

All three are fixed in commit **`af41d0f6`**. Each acceptance test fails on the reviewed code and passes on `af41d0f6`; the failing runs were done by stashing the fixed `app/` files over `af41d0f6`.

| Finding | Fix (`af41d0f6`) | Verification |
|---|---|---|
| **RC-01 · P1:** QUESTIONABLE warnings dropped from built cards | `typeLegs` keeps the pool row's `availability` on yardage and anytime-TD legs. `renderTypeCard` shows the existing Q chip ("Questionable — game-time decision") and "QUESTIONABLE — game-time decision" on the leg line, both **separate from** the HIGH/MED/LOW confidence tag. The card note says the chance assumes he plays. | `r133_bet_types` "RC-01" follows a real QUESTIONABLE pool player (week 6: 35 such rows, e.g. Quinshon Judkins) through `typeLegs` → `weekMixCards` → `renderTypeCard`. It asserts the Q chip, the leg-line disclosure and his confidence class all survive, and that a card without a Q player says nothing. Red on old code. |
| **RC-02 · P2:** GAME displayed 7 legs while generating 10 | `paintAtd` builds with `btMod.stepValue({ ...typeState, types }, scope, legCountsForScope())`, the exact value the stepper displays. `gameMixCards` refuses any size outside 2–7 (also 1, 8, 9, 10 and 2.5). | Unit test: WEEK 8/9/10 → GAME shows and builds 7; the builder refuses every other size. Browser test (`r101b_game_td.spec.mjs` "RC-02"): WEEK ALL at 8, 9 and 10 → GAME. Every card has 7 legs and the head says "7 LEGS". After a reload with the saved preference of 10, still 7. Red on old code ("Expected 7, Received 8"). |
| **RC-03 · P2:** MOST LIKELY discarded better cards (160-wide beam) | **WEEK is exact.** It runs a k-best dynamic programme over games with state (legs chosen, kinds covered), keeping the k best partial cards per state. That is exact for the product (additive log) objective, and only the k most likely legs of each kind per game can appear on a k-best card. **GAME is exhaustive** when there are at most 250,000 valid combinations (most 2–5-leg cases). Above that it uses a 400-wide beam, and the card says "chosen by an approximate search". | An independent brute-force oracle (plain enumeration, no DP) is compared on a real reduced instance (9 games, 3 legs each, n = 3, 5, 6, plus a skewed ML/ATD instance). The top six match exactly, probability and leg set. 9-leg comparison, **matched game populations** (revision 4 correction; revision 3 compared across populations). On the 13 games still open at review time (TNF already FINAL), the population Codex used: f31c5740's beam gives **23.6553%**, and the exact search gives **24.6707%**. That equals Codex's counterexample; it is the optimum, not an improvement on it. On the test fixture's 14 games, which forces every week-6 game open including TNF: beam 24.4674%, exact **25.5177%**. The earlier "25.5177% beats 24.6707%" compared a 14-game result with a 13-game one. The test's `>= 0.246707` assertion runs on the 14-game fixture, so it is a floor, not a matched comparison. The matched-population check is the brute-force oracle test above, plus the reproduction in section 4. 10 legs, matched: 13 games beam 20.2915% / exact 21.1625%; 14 games 21.3087% / 22.2234%. GAME at 3 legs matches an independent all-triples oracle. Timing (Node, week-6 pool): WEEK 9–10 legs ~0.3 s; GAME 4 legs ~25 ms (exact); 7 legs ~0.2 s (approximate, labelled). |

**Agreement:** I agree with all three findings and have no disagreements.

On the oracle: the brute-force comparison also passes on the old code, because the beam was exact on that small instance. The full-week bound (RC-03 test 2) is the one that catches the old search.

## 3. What is included versus separate

| Work | In #174? | Notes |
|---|---|---|
| R133 controls, built cards, bucket fix (above) | **yes** | the whole PR |
| #175 Sunday learning pilot (learning journal, period/freshness policy, as-offered record, MY generation, workflows, 90-minute withholding) | **no** | Separate draft. #174 neither reads nor writes any of it. |
| #175's `renderAsOfferedRecord` / honest "PARLAYS x/y" strip (R130) | **no** | In #174 the strip still counts every review row, a known R130 gap. #175 replaces it. |
| SelfLearning #10 engine | **no** | #174 calls no SelfLearning code. |

### Files overlapping between #174 and #175

These are computed against base `28f7ac3b`.

- **`app/views/parlays.js`** — a **textual conflict** (`git merge-tree`). Both sides edit the `import` block:
  - #174 drops `getAtdCards, getAtdGameCards` and adds `loadJson` plus a `bet-types.js` import;
  - #175 adds `summarizeConcentration, renderConcentrationRisk` to the `portfolio-risk.js` import and paints a GAME concentration note in `paintList`.
  - Resolution: keep both import sets, then confirm that #175's GAME concentration note sits beside #174's `coverageNote` line in `paintList`.
- **`app/review.js`** — merges automatically:
  - #174 adds `parlayRowCount`;
  - #175 adds `renderAsOfferedRecord` and changes `renderParlaySummary`.
- **`app/theme.css`** — merges automatically. Both sides only add rules.
- **Behaviour overlap** (no textual conflict):
  - #175 also edits `app/views/myparlays.js`, `app/portfolio-risk.js` and `app/views/mybets.js`. #174 does not touch them.
  - #175's MY TD pills keep using `app/atd-cards.js`, which #174 still imports for `breakEven` and `pctText`.
- **No overlap** with SelfLearning #10, which is a different repository.

## 4. Tests: exact commands and results on `0436dd4b`

| Command | Exit | Result |
|---|---|---|
| `bash tests/run_gate.sh` on **`0436dd4b`** (one gate at a time; port 4321) | **0** | **GATE RESULT: PASS (green)**, all 8 steps. Feature tests **2,138 pass, 0 fail**; browser E2E **364 passed, 1 skipped** |
| `node --test tests/feature/r133_bet_types.test.mjs` on `0436dd4b` | 0 | 17 pass (12 before + 5 RC tests), ~11 s |
| `node --max-old-space-size=256 --test tests/feature/r133_bet_types.test.mjs` on `0436dd4b` / on `af41d0f6` | 0 / 1 | 17 pass / heap out of memory: proves the memory fix |
| Superseded: CI `gate` on `28e29d90` (run 39053496127, job 117456661922) | 1 | feature 2,121 pass, 1 fail: `r133_bet_types.test.mjs` aborted (SIGABRT, 4 GB heap OOM) after 106 s |
| `npx playwright test --config tests/playwright.config.mjs tests/web/r101b_game_td.spec.mjs tests/web/r101c_td_modes.spec.mjs --project=web` | 0 | 8 passed (incl. RC-02) |
| Round 2, on `101e3925` (superseded) | 0 | gate PASS; feature 2,133; browser 363 passed, 1 skipped; final-head CI run 39051342080 green |

- **CI failure on `28e29d90` and its fix (`0436dd4b`):**
  - Cause: the RC-03 brute-force oracle stored every scored combination. Its ML+ATD skew instance runs to hundreds of millions, which exceeds the 4 GB CI heap. Locally it passed in about 116 s with more memory. The product code was not at fault.
  - Fix: the oracle still enumerates and scores every combination on the same instances, but keeps only the running top k. The instances and assertions are unchanged, and one assertion was added: the skew instance's card count must equal the oracle's.
- **Matched-population reproduction (revision 4):**
  - Command: `git show f31c5740:app/bet-types.js` was run beside `0436dd4b`'s module, both on `data/leg_pool.json` at the base.
  - Population A: the real `schedule_full.json` with `now = 2026-10-17T17:00Z`, giving 13 open games and 390 legs.
  - Population B: the test fixture, all 14 games forced open, 424 legs.
  - 9 legs: A gives beam 23.6553 / exact 24.6707; B gives beam 24.4674 / exact 25.5177.
  - Code and tests are unchanged in revision 4.
- **The 1 browser skip:**
  - It is the existing spread/provenance fixture test, identified by Codex. It skips because current GAME data contains no spread legs.
  - It is the same skip count as the round-1 and round-2 gates.
  - No test was added to a skip list, and none was removed, weakened or quarantined.
- **Tests changed because the owner removed a behaviour:**
  - The r101b and r101c WEEK/GAME TD-pill specs were **converted** to the bet-type chips. Their MY test is unchanged.
  - The leg-chip clicks and whole-week bucket counts in r72, r73, r85, r90, web and week6_risk now drive the stepper (`tests/web/_legstep.mjs`) and expect **scoped** counts.
- **New tests:** an R133 browser check: chips plus the off-slate line equal the scope's review rows, and tapping ALL HIT lists exactly the chip's count.
- **CI on round 1 (`8c010d71`): success.** CI on the final head is reported in the PR.

### SelfLearning #10 CI: import-path failure, unresolved in its repository

- **Failure:** `selflearn-core (pytest)` (job 117446168210) runs `python -m pytest -q` with `working-directory: packages/selflearn-core`.
  - Five test modules do `from tools import …` (`tools/` is at the repository root): `test_nfl_cohort_parity.py`, `test_nfl_review_attachment.py`, `test_nfl_review_attachment_adversarial.py`, `test_nfl_review_attachment_cli.py` and `test_nfl_review_parity.py`.
  - They fail collection with `ModuleNotFoundError: No module named 'tools'` (exit 2).
- **Reproduced locally on `c1bf3d47`:**
  - The same 5 collection errors appear.
  - With the repository root on the path, `cd packages/selflearn-core && PYTHONPATH=../.. python3 -m pytest -q` → **1,012 passed, 34 skipped, 699 subtests passed, exit 0**.
  - All 34 skips are explicit `NFL2026_CHECKOUT`-gated actual-producer parity tests. They were not added to force a pass.
- **Proposed fix, for whoever owns #10** (Claude cannot push to SelfLearning from this session), either of:
  - in `.github/workflows/ci.yml`, job `selflearn-core (pytest)`, set `env: PYTHONPATH: ${{ github.workspace }}`;
  - make `tools` importable explicitly in the package's pytest configuration.
- No test should be skipped to obtain the pass.

### #175 CI

On head `3ea2a227`, the `gate` and `e2e` checks are **failing**. #174 does not address them. They belong to #175's own review.

## 5. Learning, engine and freshness

- **Engine version/pin in #174:** none. #174 runs no learning engine and reads no SelfLearning package.
- **Learning state on main and #174 (`data/leg_pool.json`):**
  - `live_adjustment: null`;
  - `live_adjustment_status: "held: no adopted correction"`;
  - `learning_receipt_policy: base_receipt_v1`;
  - `base_model_version sha256:57685cac…`.
  - So learning is **disabled for recommendations**. Receipts are written, and nothing learned changes a price.
  - Built cards read the served `model_prob` only.
- **#175, for comparison** (not in #174): `config/selflearning_pilot.json` has `"enabled": false`, `engine_commit bba5b6d7…` and `freshness_profile provisional_before_90m_v1`.
- **Injury freshness (in production since #172):** a source older than 12 h, or for the wrong week, makes affected players' offers refused (`injury_source_state`). Points are kept (R133 round-1 fix). Built cards draw only from the pool, which already excludes refused players.
- **T-minus-90-minute withholding:** **not in #174, not in production.**
  - Production reads the inactive lists in the window before kickoff (`games_in_inactive_window`). The NFL posts them about 90 minutes out.
  - #174's built cards drop only games that are no longer `STATUS_SCHEDULED` or whose kickoff has passed.
  - The 90-minute provisional/withhold policy lives in #175. Its own pilot doc says the official-inactive recheck is still incomplete.

## 6. Recording, grading and history

- **Built cards are browser-only.** They are not recorded, not graded, not in `review.json` and not counted in buckets. Each card says so.
  - PUBLISHED cards are unchanged and graded as before.
  - Recording built cards is listed as the next step.
- **Pipeline and history preservation:**
  - #174 changes no producer, workflow or data file. Its diff is limited to `app/`, `tests/`, `docs/` and one new `tests/web/_legstep.mjs` helper.
  - It does not regenerate, rewrite or delete history.
- **Repeated-refresh evidence:** this is for main (the base #174 would ship on), since #174 adds no pipeline step.
  - Daily runs #312–#323 and gameday #176 succeeded after the #172 release.
  - every data-ci run I checked in #171–#185 was green (#175 was cancelled, superseded by #176).
  - The "[data-ci] main is red" issue stayed closed.
  - MY week-6 cards grew monotonically: 2,901 → 2,908 at the #172 release, with no loss.

## 7. Known defects, incomplete work and remaining release steps

1. The "WK n PARLAYS: x/y hit" strip still counts every review row, including replaced cards (R130; #175 addresses it).
2. **GAME 3–7 legs are an unvalidated estimate.** The label is honest, but no backtest exists. Backtest it before treating the number as a forecast.
   - **GAME card selection is approximate** when a game has more than 250,000 valid combinations (typically 6–7 legs). The card says so.
   - WEEK selection is exact (RC-03).
3. **GAME uses one moneyline per game.** The pool carries only the pick's side, so MONEYLINE alone cannot fill a GAME card. The UI says why.
4. **Built cards are not recorded or graded,** so they have no track record yet.
5. **"Most likely line" yields short-yardage legs** (e.g. 20+ rush yds at 90%+). That is high hit chance with small payouts, which is what the owner asked for. BIGGEST PAYOUT sorting does not change the lines.
6. The single browser skip is the existing spread/provenance fixture: current GAME data has no spreads.
7. **Release steps:** Codex review → address findings → owner authorization → merge (resolve the `parlays.js` import conflict if #175 lands first) → verify production → watch the next daily and data-ci runs.

## 8. Rollback

#174 is unmerged, so there is nothing to roll back. If it is merged later:

- run `git revert <merge-commit>` on `main`;
- push, and Netlify redeploys the previous app.

No data migration or pipeline change is involved. Viewers' saved chip choice (`localStorage` key `nfl2026.parlays.types.v1`) is ignored by the old code.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
