# NFL2026 — independent review of R87 … R91

Date: 2026-09-20. Repository: `liddar12/NFL2026`.
Baseline: `d6702e8422ad24460649c146e921a9e7580c6547` (main, "R91: the adopted QB-out signal fires
in season (#96)"). Range under review: `git log --oneline 18dd795..d6702e8` — R87 (same-game pairs,
MY cards recorded and graded, gameday graph), R88 (race-safe publish, per-stage status), R89 (MY
type-ahead + emptyReason), R90 (refit merge, archive freeze, slate truth, parlays first screen),
R91 (injury overlay, depth-chart primary passer), plus the 15 interleaved data commits.

The reviewer did not build any of this. Every reproduction below was run against a clean checkout of
`d6702e8` (`git clone --shared` + `git checkout d6702e8`), never against the working tree, which
carries other agents' uncommitted R92 work. No repository file was modified except this one.

This is a review, not an implementation. No fix was applied, no data regenerated, nothing pushed.

## Scope and evidence

Read line by line: `scripts/models/my_cards.py`, `app/views/myparlays.js`, `app/parlay-math.js`,
`scripts/models/parlay_builder.py` (combination path), `scripts/build_my_cards.py`,
`scripts/resolve_my_cards.py`, `scripts/replay_lab.py` (`same_game_pairs`),
`scripts/publish_data.sh`, `scripts/merge_ledgers.py`, `scripts/stage.sh`,
`scripts/stage_status.py`, `scripts/build_parlay_archive.py`, `scripts/build_injury_history.py`,
`scripts/promote_signals.py::qb_out_current`, `scripts/refit.py::next_game_params`,
`app/review.js`, `app/views/slate.js`, `app/views/model.js` (stages card),
`tests/perf/budget.spec.mjs`, the three pipeline workflows, the five new contracts and the eleven
new test files. Committed data was read directly: `leg_pool.json`, `my_cards/2026_wk02.json`,
`parlays/2026_wk0{1,2}.json`, `estimates/*`, `review.json`, `snapshots/*_games_open.json`,
`injuries.json`, `depth_chart.json`, `injury_history.json`, `replay_lab.json`, `model_tuning.json`.

| Verification | Observed result |
| --- | --- |
| `python3 scripts/validate_data.py` (clean checkout) | Pass, 1.41 s |
| `bash tests/smoke.sh` | `SMOKE PASS` |
| `node --test tests/feature/r8[7-9]_*.mjs tests/feature/r9[01]_*.mjs` | **121 pass, 0 fail**, 13.7 s |
| Boot graph re-measured with the spec's own walker | 15 modules, **369,024 bytes**, depth 2 |
| `merge_ledgers.py X X X` on all six committed ledgers | Byte-identical, exit 0, six of six |
| `review.json.pick_prob` vs `snapshots/*_games_open.json` | **32 of 32 graded games match to 1e-9** |
| `replay_lab.json.same_game_pairs` re-read | 118 pairs / 18 keys / pooled 0.2034 vs 0.2570 — matches the release note |
| Publish race reproduced on a real bare remote + two clones | Six scenarios, results below |

Environment: Node v22.22.2, Python 3.11.15, git 2.x, Linux. Playwright browser specs were **not**
run (no browser in this sandbox); every browser-level claim below is read from source and from the
committed data, and is labelled as such.

P0 = silent data loss or a release that does not do what it says in production. P1 = correctness or
measurement defect to close before the affected feature is extended. P2 = resilience, honesty,
budget or test-coverage defect. No monetary loss is asserted; nothing here is a live incident.

---

## Findings

### G01 · P0 · The R91 current-week injury overlay is written once and then frozen for the rest of the week

**Evidence:** `scripts/build_injury_history.py:301-311` (release fails → `seasons_out[key] =
existing.get(key) or {}`) and `:196-208` `merge_overlay`, whose rule is
`if merged.get(team, {}).get(wk): continue`. On the failure path the "existing" 2026 season *is*
yesterday's overlay, so today's overlay is skipped for every team-week it already wrote.

Reproduction (clean checkout, `fetch_injuries_release` stubbed to raise `FeedError`, exactly the
state the committed `injury_history.json` records — it has no `2026` key at all):

```
--- RUN 1 (Wednesday: Penix listed Questionable) ---
NOTICE: 2026 injuries release not available (simulated: release refused); the current week comes from the daily report below
current week 2: 68 report row(s) from data/injuries.json, 62 without a depth-chart id, 25 team-week(s) filled
ATL wk2: [{'id': '00-0039917', 'name': 'Michael Penix Jr.', ..., 'status': 'Questionable'}, ...]

--- RUN 2 (Friday: Penix downgraded to Out) ---
current week 2: 68 report row(s) from data/injuries.json, 62 without a depth-chart id, 0 team-week(s) filled
ATL wk2 AFTER Friday report: [{'id': '00-0039917', 'name': 'Michael Penix Jr.', ..., 'status': 'Questionable'}]
```

`0 team-week(s) filled`. The Friday designation never lands, so `qb_out` never fires and CAR @ ATL
keeps the 61.4% the release exists to correct. The same hole exists on the success path for a
different reason: once the nflverse in-season release is admitted (`CURRENT_MIN_ROWS = 50`), it owns
the team-week, and the release is Wednesday's practice report while the daily ESPN report is
Friday's final designation — the stale source wins by construction.

The release's own selftest **locks this behaviour**: `scripts/build_injury_history.py:277-278`,
`assert filled2 == 0 and merged2["ATL"]["2"] == [{"id": "release"}]`.

Note: the committed `data/injury_history.json` at `d6702e8` still has `seasons` = 2021…2025 and the
pre-R91 `source` string — the R91 merge (14:59 UTC) landed after the last data commit (14:11 UTC),
so nothing in the shipped corpus has yet exercised this path. The shipped
`data/game_predictions.json` still prices ATL at **0.6141**.

**Risk:** the adopted `qb_out` family fires on whichever report happened to be on disk at the first
run of the week — typically Wednesday, when QBs are listed Questionable and the signal is defined
not to fire. The release's stated purpose ("the adopted QB-out signal fires in season") is not met
for the case it was written from.

**Fix:** make freshness, not presence, the precedence rule for the CURRENT week only. Carry a
per-team-week `as_of_utc` on the row set and let the later stamp win; keep "release wins" for every
week strictly before the current one, which is the walk-forward history the adoption was measured
on. Rebuild the current week's overlay from scratch on every run rather than filling gaps.

**Acceptance:** two consecutive runs over the same week with a changed `data/injuries.json` produce
a changed `injury_history.json`; a status downgrade Q → Out on the current week flips
`qb_out_current` for that team; a row for a week < current is never overwritten by the daily report;
the walk-forward corpus for 2021-2025 is byte-identical before and after.
**LOE: 0.5 day.**

---

### G02 · P0 · A raced publish destroys frozen archive cards and closes the week, while logging "both writers' entries kept"

**Evidence:** `scripts/merge_ledgers.py:92-103` — the `parlay_archive` shape declares
`"entries": None`, so `parlays` (the cards) is not identity-merged; it falls through to the generic
header rule at `:475-482`, `val = later.get(k)`. `scripts/publish_data.sh:138` nonetheless logs
`merged by identity (both writers' entries kept)` for the path.

Reproduction (bare remote + two clones from one base; A freezes two cards and closes the week at
`updated_utc 17:00`, B refreshes the same week at `17:05` with a different card):

```
publish: attempt 1: published 1ac0f58 to main
publish: committed 756df39: data: gameday refresh [skip actions]
CONFLICT (content): Merge conflict in data/parlays/2026_wk02.json
publish:   data/parlays/2026_wk02.json: merged by identity (both writers' entries kept)
publish: attempt 1: published 9062aac to main

=== main's archive ===
  "closed": true,
  "history": [ 10:00, 17:00, 17:05 ],
  "parlays": [ { "card_id": "c-refresh-B", "rank": 1, "legs": [ { "selection": "NE ML" } ] } ]
```

Both of A's frozen cards (`c-base` with `frozen_utc`, `c-frozen-A`) are gone. The week is now
`closed: true`, so no later rebuild restores them (`build_parlay_archive.run` step 1 returns
`action == "frozen"` and does not rewrite a closed week). `history` is merged correctly, which makes
the loss harder to see: the receipt of the run survives, its cards do not.

**Risk:** R90/F12's guarantee — "a rebuild may neither replace nor remove [a frozen card]" — holds
inside one checkout and does not survive the publish path built one release earlier. Sunday is the
first day two workflows do heavy work in one window (R87's own words), and it is also the day
freezing happens.

**Fix:** give `parlay_archive` a real `entries` spec keyed on `card_id`, with a `frozen_utc` rule:
a card frozen on either side survives verbatim; two frozen cards with one id keep the earlier
`frozen_utc`; unfrozen cards take the later document's set. Until then, remove the misleading log
line for this path.

**Acceptance:** the race above leaves `c-base`, `c-frozen-A` and `c-refresh-B` on main, with
`frozen_utc` unchanged on the two frozen ones; merging a committed archive with itself stays
byte-identical; a test in `r88_publish_race.test.mjs` covers the archive path, which today has none.
**LOE: 1 day.**

---

### G03 · P1 · `parlay_id` collides between a frozen card and a live card of the same rank; every downstream join is last-write-wins

**Evidence:** `scripts/build_parlay_archive.py:294-302` appends an incoming card whenever its
`card_id` is not among the frozen ids, and never touches `parlay_id`, which is rank-derived
(`week-2leg-1`, `401872932-g1`). `data/contracts/parlays_archive.schema.json` requires `parlay_id`
on every card and sets no uniqueness constraint. The consumers all build a Map on it:
`app/review.js:476`, `:584`, `:618`, `:680`; `scripts/build_review.py:1493`.

Reproduction — the committed week-2 archive plus one post-kickoff rebuild whose pool no longer
offers DET/BUF legs:

```
parlay_archive: wk 2 59 card(s) frozen ...
cards 83   frozen 59   DUPLICATE parlay_id: 17
  week-2leg-1 x 2  [('ff7d65b9a0ae', frozen, ['SF ML','BUF ML']), ('58ea80f1708e', live, ['SF ML'])]
  week-3leg-1 x 2  [('41b212b221d0', frozen, ['SF ML','BUF ML']), ('030cca7592a3', live, ['SF ML','SEA ML'])]
  401872932-g1 x 2 [('6eb5829691fa', frozen, ['BUF ML','J. Gibbs 60+ rush yds']), ('872d53f6d77b', frozen, ['J. Gibbs 60+ rush yds'])]
```

Ten successive post-kickoff rebuilds on the committed data:

```
rebuild  1: cards= 83 frozen= 59 dup_parlay_ids=17 bytes=106514
rebuild  5: cards=114 frozen= 87 dup_parlay_ids=21 bytes=133422
rebuild 10: cards=134 frozen= 95 dup_parlay_ids=28 bytes=145662
```

**Risk:** this is F12 verbatim — "a rank-based `parlay_id` could name a different bet" — surviving
R90 because R90 added a second id instead of retiring the first. The bucket, the money block and
the review row of one bet are applied to the other; which one wins depends on array order. The card
count also grows by ~7 cards per post-kickoff rebuild with no bound other than the rebuild count.

**Fix:** make `card_id` the join key in `build_review.py` and `app/review.js`, and either drop
`parlay_id` from the archive or make it `<card_id>` -suffixed. Add `uniqueItems`-equivalent
validation on `(parlay_id)` to `parlays_archive.schema.json` so a regression reds the gate.

**Acceptance:** after the reproduction above, no two cards in one archived week share a `parlay_id`;
`build_review` and the browser layer resolve every card by `card_id`; the validator refuses an
archive with a duplicate id.
**LOE: 1 day.**

---

### G04 · P1 · F13 (a graded game showing today's recomputation) is unfixed on the CURRENT week, which is where 15 of 16 games live for most of a week

**Evidence:** `app/review.js:393-405`. `historical = currentWeek != null && Number(week) !==
currentWeek`, and `applyHistoricalTruth` is called only `if (historical)`. The helper itself handles
"a FINAL game on a not-yet-past week" (`:361`, `if (!past && !FINAL_STATUS.test(status)) return;`)
but that branch is unreachable for the current week, because the outer guard already excluded it.
So on the current week a FINAL game gets the graded dot and the why button and does **not** get the
locked heads, `.rv-final` score or the `LOCKED … · recomputed with today's model: n%` line.

Committed data, today, week 2 is the current week (`review.json.review_through_week = 3`,
`schedule_full.json` week 2 = 1 `STATUS_FINAL` + 15 `STATUS_SCHEDULED`):

```
game 401872932  DET @ BUF  result won
  review lock : picked BUF  pick_prob 0.6527      (= snapshots/2026_wk02_games_open.json probs[0])
  schedule now: probs {'home': 0.6929, 'away': 0.3071}   status STATUS_FINAL
```

The dot grades 65.27%; the card prints 69%. In ~3 hours 15 more week-2 games go FINAL under the
same rule.

`tests/feature/r90_slate_truth.test.mjs:183` asserts the literal source line
`const historical = currentWeek != null && Number(week) !== currentWeek;` — the test pins the
expression that causes this.

**Risk:** the defect class F13 closed is live every week from Thursday night until the week rolls
over; the fix is only visible on weeks nobody is looking at.

**Fix:** drop the outer `historical` guard and let `applyHistoricalTruth` decide per card from
`isGradedRow(row)` plus `status`, which it already does. An unplayed game on any week keeps today's
forecast (`!past && !FINAL` returns early), so the "current week is untouched" intent is preserved
per game instead of per week.

**Acceptance:** with `currentWeek === week`, a card whose review row is graded renders
`data-rv-prob="locked"`, `.rv-final` and `.rv-prov`; a `STATUS_SCHEDULED` card on the same week
renders none of them; the committed DET @ BUF card shows 65%, not 69%. Replace the source-text
assertion with this behavioural one.
**LOE: 0.5 day.**

---

### G05 · P1 · A raced publish erases the other workflow's entire per-stage record, including its `last_success` carry

**Evidence:** `data/pipeline_stages.json` is a cross-workflow ledger
(`scripts/stage_status.py:114-126`, one block per workflow; `begin` resets only its own block and
re-seeds `last_success` from the file it reads). `scripts/publish_data.sh:91-99` `is_ledger()` does
not match it, so `:146-147` takes ours.

Reproduction — daily records its stages, gameday races from the same base:

```
publish: committed 1fb6249: data: gameday refresh [skip actions]
publish: attempt 1: main moved to f107f56 while this run was working; ...
CONFLICT (content): Merge conflict in data/pipeline_stages.json
publish:   data/pipeline_stages.json: regenerable, taking this run's version
validate stub: ok
publish: attempt 1: published a70089e to main
exit=0

{ "generated_utc": "2026-09-20T17:05:00Z",
  "workflows": { "gameday": { ... } } }          # "daily" is gone
```

`stage_status.py`'s docstring says the file is "runner-built and never committed from a clone" —
but it is committed (16,657 bytes at `d6702e8`, picked up by `git add data/`), and that is precisely
why the race matters. Because the next `begin` reads the wiped file, every daily stage's
`last_success_utc` regresses to `NEVER` on the MODEL card (`app/views/model.js:1549`).

**Risk:** the card R88 built to make pipeline health visible loses a whole workflow's health on the
one day both workflows run — silently, exit 0, one log line that says the opposite.

**Fix:** register a `pipeline_stages` shape in `merge_ledgers.py` keyed per workflow: a workflow
block present on either side survives; the same workflow on both sides takes the later
`run_started_utc`; `last_success` unions per stage taking the later stamp. Add the path to
`is_ledger()` in the same change (the two registries are deliberately coupled).

**Acceptance:** the race above leaves both `daily` and `gameday` on main with their own stages and
carries; `merge_ledgers.py` on the committed file with itself is byte-identical; an
`r88_publish_race` case covers it.
**LOE: 0.5 day.**

---

### G06 · P1 · A raced publish un-grades a lock receipt that `merge_ledgers.py` explicitly refuses to touch

**Evidence:** `scripts/merge_ledgers.py:120-125` refuses `data/snapshots/` outright — "a conflict
there means something else is wrong — resolve it by hand". `scripts/publish_data.sh:139-144`
resolves it anyway with `take_ours`.

Reproduction — A grades g1 from a FINAL score, B (from the same base) only adds a new lock row:

```
CONFLICT (content): Merge conflict in data/snapshots/2026_wk02_games_open.json
publish:   data/snapshots/2026_wk02_games_open.json: SNAPSHOT conflict (unexpected) -- taking this run's grading

=== main's snapshot ===
[ {"event_id":"g1", ..., "resolved": false},      # A's resolved/actual/brier are gone
  {"event_id":"g2", ..., "resolved": false} ]
```

The log says "taking this run's grading"; this run did not grade g1.

**Risk:** the lock receipts are the durable record `review.json` (`learning.graded_locks`),
`resolve_my_cards.load_finals` and `refit._collect_resolved_rows` all read. A lost grading
un-feeds the refit for that pass. It self-heals on the next `resolve_locks`, so the exposure is one
cycle — but it is exactly the class the merger refuses to guess at, resolved by guesswork one layer
up.

**Fix:** union the receipt list by `event_id`, taking `resolved: true` monotonically and the earlier
`locked_utc`; or, minimally, make a snapshot conflict a `die()` so the two components agree.

**Acceptance:** the race above keeps g1 `resolved: true` with its `actual` and `brier`, and adds g2;
the two components state one rule for `data/snapshots/`.
**LOE: 0.5 day.**

---

### G07 · P1 · "Injured Reserve" is not in the status vocabulary, so 41 of today's report rows — including a QB — are silently dropped

**Evidence:** `scripts/build_injury_history.py` `STATUSES = {'Doubtful', 'Out', 'Questionable'}`;
`overlay_current_week` drops anything else (`if pos not in POSITIONS or status not in STATUSES …
continue`). `data/contracts/injury_history.schema.json` pins the same three-value enum.

```
status vocab in data/injuries.json (800 rows):
  Counter({'Active': 646, 'Out': 58, 'Questionable': 51, 'Injured Reserve': 41, 'Doubtful': 4})
IR by position: WR 9, LB 8, CB 4, TE 4, DT 3, RB 3, S 2, OT 2, DE 2, OL 1, QB 1, LS 1, G 1
IR QBs: [('CLE', 'Dillon Gabriel')]   -> CLE rank-1 QB is Deshaun Watson
```

A player on IR is more certainly unavailable than one listed Doubtful, which does fire. No rank-1
QB is on IR today, so no committed probability moves; the WR/OT/OL/G rows feed `skill_out` and the
line report.

**Risk:** the exact failure R91 was written from — a QB who cannot play and a signal that cannot
see him — remains open for every IR designation. It will fire the first week a starter lands on IR.

**Fix:** map ESPN's status vocabulary to the canonical week-class vocabulary in one place (there is
already `scripts/…/availability.normalize_status`), admit `Injured Reserve` as `Out`, and extend the
schema enum. Assert the full observed vocabulary in the selftest so a new ESPN word reds the gate
instead of being dropped.

**Acceptance:** `overlay_current_week` on the committed `data/injuries.json` keeps 109 rows, not 68;
a rank-1 QB on IR fires `qb_out`; an unrecognised status string fails the builder loudly.
**LOE: 0.25 day.**

---

### G08 · P1 · 62 of 68 overlay rows carry `id: null`, because `data/depth_chart.json` holds QBs only

**Evidence:** `scripts/build_injury_history.py` `depth_ids()` walks every position group of
`data/depth_chart.json`, but that file contains one group:

```
depth chart positions: {'QB': 93}     (32 teams)
overlay_current_week(injuries, depth_chart, 2) -> kept 68, unresolved 62, 25 team-weeks
unresolved by position: DT 14, WR 13, G 11, OT 8, RB 6, DE 6, TE 3, C 1
e.g. ('BAL','WR','Zay Flowers','Out'), ('BAL','DT','Nnamdi Madubuike','Out')
```

Only QBs resolve. The other 62 rows are written into `injury_history.json` with a null id.
`skill_out_current` (`scripts/promote_signals.py:2328+`) keys its shares by player id, so every
id-less row is inert; the same rows also enter the file the walk-forward corpus reads.

`qb_out_current` is correctly guarded (`and r.get("id")` when building `outs`, and `if _hp and …` at
`scripts/build_predictions.py:835`), so a null id can never fire a spurious signal — verified.

**Risk:** the release note says the overlay makes "the walked-forward history and the live week …
one file the signal reads" (plural). For every signal but `qb_out` the live week is 91% unusable,
and the file now looks populated, which is worse than empty for a future reader.

**Fix:** resolve ids against a roster source that covers every position (`player_projections.json`
carries name/team/position; `player_weekly.json` carries `gsis_id`), or state in the document that
only QB rows carry ids and count them per position in the build log.

**Acceptance:** `unresolved` is 0 for the positions the adopted families read; the build log prints
resolved/unresolved per position; a row that cannot be resolved is counted, not silently written.
**LOE: 0.5 day.**

---

### G09 · P2 · A run that fails hard publishes no stage record at all, so the MODEL card can never show a failed run

**Evidence:** `data/pipeline_stages.json` reaches main only through the last step of each workflow
(`daily.yml:242-243`, `gameday.yml:236-237`, `backtest.yml:179-180`), and neither that step nor the
contract gate above it carries `if: always()`. `tests/feature/r88_stage_status.test.mjs:269-308`
scopes the wrapper requirement to the steps *between* the install and `Validate data contracts`, and
asserts at `:308` that "the contract gate must stay unwrapped and unchanged".

So: a step without `continue-on-error` fails → the job stops → validate and publish never run →
the run's whole `pipeline_stages` block is discarded with the runner. The card then shows the last
**green** run, every stage `OK`. `stageChip` has a `FAILED` state
(`app/views/model.js:1505-1515`) that production can only reach for a step that is both wrapped and
`continue-on-error: false` *and* in a run that nonetheless completed — which the workflow shape
makes impossible.

The gameday YAML still carries the pre-R88 comment "F17's per-stage last-success / skipped-reason
watermarks remain out of scope" (`gameday.yml:218-220`).

**Risk:** F17's acceptance criterion ("a resolver outage is visible in final health") is met for
`continue-on-error` steps and unmet for the more serious case. A contract-gate failure — the most
common hard failure in this repo — leaves no trace in the product at all.

**Fix:** publish the stage record on failure too. Either add a dedicated `if: always()` step that
commits only `data/pipeline_stages.json` through the same race-safe path, or wrap the contract gate
and the publish and make the final commit `if: always()`. Delete the stale gameday comment.

**Acceptance:** a workflow run whose middle step exits non-zero lands a `pipeline_stages.json` on
main in which that stage reads `FAILED`; the MODEL card shows it; `data/` is otherwise untouched by
that commit.
**LOE: 0.5 day.**

---

### G10 · P2 · A week card whose prop legs are absent from the leg ledger never freezes and is replaced after kickoff

**Evidence:** `scripts/build_parlay_archive.py:242-264`. A week-scope card finds its games through
`ledger_games[(market, selection)]`, else through `by_team[selection.split(" ")[0]]` — which
resolves `"SF ML"` and never resolves `"M. Wilson 20+ rec yds"`. No game → `moments` empty → `None`
→ `started()` false → not frozen → `merge_frozen` drops it and keeps the rebuild's card.

```
earliest_kickoff for an all-prop week card absent from the ledger: None
after a rebuild a day later: cards kept = ['y']   frozen = 0
```

`docs/PARLAY_HISTORY.md` states such a card "simply does not freeze". The consequence is stronger
than that: the archived record of what was offered is destroyed, days after every game finished.

Exposure today is zero — all 66 cards in `data/parlays/2026_wk02.json` resolve a kickoff. The
ordering makes the window real, though: `build_parlay_archive.py` runs before
`build_parlay_ledger.py` in both workflows (`daily.yml:124` vs `:192`, `gameday.yml:134` vs `:173`),
so the first archive pass of a new week always sees an empty ledger index for that week.

**Fix:** an unplaceable card is unknown, not live — refuse to replace it. Carry it forward verbatim
and count it under a `frozen_reason: "kickoff unknown"`, or resolve prop legs through
`gsis_id → player_weekly` instead of the ledger so the join does not depend on step order.

**Acceptance:** a week card with no resolvable kickoff survives a rebuild; the build log names how
many cards could not be placed; the count is 0 on the committed week.
**LOE: 0.5 day.**

---

### G11 · P2 · A PUSH card is scored as a failed prediction in `hit_rate`, log-loss and Brier while its money is positive

**Evidence:** `scripts/resolve_my_cards.py:_block` — `all_hit` counts `bucket == "all_hit"` and
`pairs = [(r["model"], r["bucket"] == "all_hit")]` feeds `log_loss` / `brier`. `parlay_bucket`
returns `push` when a void leg sits beside hits, and `parlay_money` settles a push at the product of
the hit legs' decimals.

```
card: moneyline on a tied game (void) + a winning moneyline, model 0.30
result void   bucket push   money {'net_fair': 81.82, 'net_vig2': 78.25}
block  {'graded': 1, 'all_hit': 0, 'hit_rate': 0.0, 'log_loss': 0.3567, 'brier': 0.09,
        'net_fair': 81.82, 'roi_fair': 0.8182}
```

The same card returns +$81.82 and scores as a miss. A void leg is the book refunding a leg, not the
model being wrong, so it should leave the card out of the calibration denominator.

**Risk:** small today (NFL ties and exact pushes are rare) but `data/my_card_scores.json` is meant to
be the learning loop's view of MY, and `hit_rate` disagreeing in sign with `roi_fair` is the kind of
discrepancy that gets read as a bug in the money instead.

**Fix:** exclude `push` cards from `pairs` (calibration is over cards that were fully settled), keep
them in `graded` and in the money, and name the split in the document's `rule`.

**Acceptance:** a push card contributes to `net_fair` and to `graded` but not to `log_loss`,
`brier` or `hit_rate`'s denominator; the `rule` string says so.
**LOE: 0.25 day.**

---

### G12 · P2 · A player traded mid-week is pending forever, with the reason visible only as a count

**Evidence:** `scripts/resolve_my_cards.py:151-153` builds the stats reference as
`{"home": leg["team"], "away": leg["team"]}` — the player's team *as the card was offered*.
`scripts/resolve_parlay_legs.py:150-154` filters `r["team"] in teams`. A stats row carrying the new
team yields `cands == []` → `no_stat_line` → `pending`. A pending card is never written to `cards[]`
(by design, `resolve_my_cards.py:39-43`), so the only trace is `weeks[].pending`.

This is the tighter filter the docstring intends; the review notes it only because it is permanent,
not transient, and because `resolve_parlay_legs` uses the wider game-level filter for the same
player, so the two records can disagree about the same man.

**Fix:** widen the fallback to the game's two teams when the team-narrow lookup returns nothing, and
record the widening in the leg's reason; or key the join on `gsis_id`, which the recorded leg
already carries (`data/my_cards/2026_wk02.json` legs have `gsis_id` on every prop).

**Acceptance:** a prop whose stats row names a different team resolves by `gsis_id`; a genuinely
missing stat line still reads `pending`, never `miss`.
**LOE: 0.25 day.**

---

### G13 · P2 · MY cards on disk are 68% larger and carry 62% more cards than the release note states, and the whole tree is published to Netlify

**Evidence:** release note R87: "900 cards (300 per dial, 30 of 32 seeds, 180 per leg count), 900
locked … 2.08 MB per week at indent 2 — ~37 MB a season".

```
data/my_cards/2026_wk02.json  3,491,730 bytes   1,456 cards   1,456 locked
per dial: longshot 731, safe 368, even 357
13 runs on file; cards_added per run: 900, 129, 113, 0, 6, 31, 0, 0, 0, 75, 195, 0, 7
```

Each pool regeneration adds cards because the key is `(dial, seed, sorted selections)` and the
selections move with the pool. Week 2 is not over.

Git history cost is small — 12 blobs, 33.4 MiB raw, **1.0 MiB packed on disk** (append-only JSON
deltas well); `size-pack` is 24.32 MiB total. The deploy cost is not: `netlify.toml` sets
`publish = "."` with a pass-through redirect for `/data/*`, so every week file is uploaded and
publicly served, while the app fetches only `my_card_scores.json` (3,819 bytes) — `my_cards/` is not
on the contract allowlist. At the current trajectory that is ~60 MB of deploy payload by week 18
that nothing reads.

**Fix:** decide the sizing explicitly (the release note calls it "an open sizing decision"). Options:
store the record compact (`separators=(",",":")`, ~40% smaller, and `merge_ledgers` already supports
a `compact` shape); drop `mu`/`line`/`position` from the leg record, which the resolver re-derives;
or exclude `data/my_cards/` from the publish with a `[[headers]]`/ignore rule and keep it a git-only
artifact.

**Acceptance:** a written decision in `docs/MY_CARDS.md` with the measured per-week figure; if it
stays published, a budget assertion on the per-week byte size that reds when it is exceeded.
**LOE: 0.5 day.**

---

### G14 · P2 · The boot budget has zero module headroom and a stale note; the first typed miss in MY costs 1.10 MB

**Evidence:** re-measured with `tests/perf/budget.spec.mjs`'s own `staticGraph` walker on the clean
checkout:

```
modules 15   bytes 369,024   maxDepth 2
BOOT_MODULE_CEILING = 15   ->  headroom 0 modules
BOOT_BYTE_CEILING  = 376,500 ->  headroom 7,476 bytes
```

The comment on `BOOT_MODULE_CEILING` still reads `// measured 14 (R51: parlays view lazy)`, and the
R90 note repeats "the module count is unchanged". The count is 15 at both `18dd795` and `d6702e8`,
so R90's statement is true and R51's is stale — the next boot module reds the gate with no warning
in the file that says so.

The R90 note also attributes the release's growth to "2,082 bytes in two boot modules and nothing
else". Over the full range the growth is 3,565 bytes: `app/views/slate.js` +1,806,
`app/render.js` +276 (both R90) and `app/data.js` +1,483 (R87/R88 contract getters). `app/data.js`
is a boot module, so every lazily-used feed's getter is paid for on every route.

R90/F19's lazy identity join fetches `player_weekly.json` (846,990 bytes) and
`player_projections.json` (258,095 bytes) — **1,105,085 bytes** — on the first typed name the pool
cannot price, to render one sentence. The "zero fetches on a cold load" property is asserted; the
size of the fetch that does happen is not.

**Fix:** update the `BOOT_MODULE_CEILING` note to the measurement and state the zero headroom;
serve the identity join from a small purpose-built document (name, team, position, `this_week`
playability, `projected` — a few tens of KB) rather than the two full feeds; add a byte assertion
for lazily-fetched contracts to the budget spec.

**Acceptance:** the budget spec's comments match the measurement; the MY miss path fetches under
100 KB; a new lazily-fetched contract over a stated size reds the budget.
**LOE: 0.5 day.**

---

### G15 · P2 · The only verdict `same_game_pairs` reports pools 18 keys with different rhos, while every key is "insufficient"

**Evidence:** `scripts/replay_lab.py:625-641` `pair_verdict` refuses a verdict below `min_n = 20`.
`joint_block` is called for the pooled row with the same function and `n = 118`, so the pooled row
gets a real verdict; `rho_shipped` is set to `null` there precisely because the pairs "do not share
one rho".

```
pooled: n 118  observed 0.2034  independent 0.2484  shipped 0.2570
        rho_shipped null  rho_live -0.1884  delta -0.0536  ci90 [-0.1098, 0.0069]  verdict "consistent"
18 key rows, every verdict "insufficient", n from 1 to 10
refused_by_reason: {'same_side_game_pair': 20}
cards: n 34, all_hit 0.3235 vs shipped mean 0.3022, ci90 [-0.1001, 0.1534], "consistent"
```

Every number reproduces the release note exactly. The concern is the inference, not the arithmetic:
a pooled CI over a mixture of same-side and opposing keys with rho from +0.10 to −0.10 can read
"consistent" while individual keys are wrong in opposite directions —
`moneyline|qb_pass_yds|opposing` already has `observed_joint 0.0` and a CI entirely below zero
(`[-0.2398, -0.1522]`) at n = 5.

The pair population is "every unordered pair of resolved locked legs sharing a (week, game_id)"
minus R74. It does not apply the product's other card rules (one leg per player, one leg per
selection), so it can include pairs no card could contain. On today's ledger that is 0 same-player
prop pairs and 0 moneyline+moneyline pairs, so the current measurement is unaffected — the
population is wider than the product by construction, not in fact.

**Fix:** either suppress the pooled verdict (report the pooled numbers with
`verdict: "insufficient"` until at least one key clears `min_n`), or state on the card that the
pooled row is a heterogeneous mixture and is not evidence about any one rho. Apply the card rules to
the pair population so what is measured is what could be sold.

**Acceptance:** the MODEL card's REPLAY LAB section does not present a pooled verdict as a
per-rho verdict; the pair population documents which of the builder's rules it applies.
**LOE: 0.5 day.**

---

### G16 · P2 · 29 assertions across the five releases test implementation text, including one that pins the expression causing G04

**Evidence:** counted by file (`assert.match` / `assert.ok` against a `readFileSync` of a source
module):

```
r87_my_cards_record.test.mjs  6     r89_my_typeahead.test.mjs  7
r90_slate_truth.test.mjs     14     r91_qb_out_live.test.mjs   2
```

Representative:

- `r90_slate_truth.test.mjs:183` — `assert.match(review, /const historical = currentWeek != null && Number\(week\) !== currentWeek;/)`. This asserts the source line, not the behaviour, and it is the line responsible for G04. Fixing G04 reds this test.
- `r87_my_cards_record.test.mjs:177` — `assert.match(SRC, /const prev = el\.querySelector\('\.mp-record'\);[\s\S]{0,80}prev\.remove\(\)/)` — a regex over 80 characters of source to express "the record is not painted twice".
- `r89_my_typeahead.test.mjs:280` — `assert.match(SRC, /e\.preventDefault\(\);\n\s*commit\(/)` — pins a newline.

**Risk:** these pass on a refactor that breaks the behaviour and fail on a refactor that preserves
it. The R90 case is worse than neutral: it locks a defect.

**Fix:** replace each with a DOM- or function-level assertion. Several are cheap — G04's is
`applySlateReview` over a fixture with `currentWeek === week` and a graded row.

**Acceptance:** no assertion in the five new feature files matches against module source text
except for the deliberate YAML/shell-shape assertions in `r87_gameday_graph` and `r88_stage_status`,
which are testing the workflow files themselves.
**LOE: 0.5 day.**

---

### G17 · P2 · Roadmap claims in R87…R91 with no test behind them

Listed because each is a number or property the release note states as fact and nothing re-checks.

| Claim | Where | State |
| --- | --- | --- |
| "900 cards … 2.08 MB per week … ~37 MB a season" | R87 | Untested; **already 1,456 cards / 3.49 MB** (G13) |
| "every pipeline step in daily, gameday and backtest runs through `scripts/stage.sh`" | R88 | 57 wrapped `run:` steps; the contract gate and the publish are deliberately unwrapped and the test asserts they stay so (G09) |
| pipeline_stages / snapshots / parlay-archive behaviour under a publish race | R88 | No case in `r88_publish_race.test.mjs` (G02, G05, G06) |
| `git rebase --skip` path (`publish_data.sh:187-191`) | R88 | Reachable and correct — verified by hand below; no test |
| "the committed week-2 archive froze 19 cards … a second run writes zero bytes" | R90 | 19 frozen confirmed in the committed file; second run byte-identical confirmed; the *number* is not asserted anywhere |
| "first card top 733px against a tabbar at 817px" | R90 | Locked by `r90_parlays_ux.spec.mjs` (browser spec not run here) |
| "47 team-weeks with QB listings" | R91 | Offline on the committed inputs the count is **25** (week 2 only); reaching 47 requires the nflverse release, which is not reproducible here |
| "release team-weeks never overridden, the overlay fills what the release lacks" | R91 | Tested — and the test locks the defect (G01) |
| ESPN status vocabulary coverage | R91 | Untested; `Injured Reserve` silently dropped (G07) |
| overlay id resolution rate | R91 | Untested; 62/68 unresolved (G08) |

**Fix:** convert the numeric claims into assertions where they are cheap (frozen-card count, overlay
resolution rate, per-week my_cards bytes) and delete the ones that are one-time measurements from
the note's factual voice.
**LOE: 0.5 day.**

---

## Summary

| # | P | Title | LOE |
| --- | --- | --- | --- |
| G01 | P0 | R91 current-week injury overlay frozen at first write; a Friday downgrade never reaches the model | 0.5 d |
| G02 | P0 | Raced publish destroys frozen archive cards and closes the week, logging "both writers' entries kept" | 1 d |
| G03 | P1 | `parlay_id` collides between a frozen and a live card; 17 duplicates after one rebuild | 1 d |
| G04 | P1 | F13 unfixed on the current week; DET @ BUF shows 69% against a 65.27% lock | 0.5 d |
| G05 | P1 | Raced publish erases the other workflow's stage record and `last_success` carry | 0.5 d |
| G06 | P1 | Raced publish un-grades a lock receipt that `merge_ledgers` refuses to touch | 0.5 d |
| G07 | P1 | "Injured Reserve" outside the status vocabulary; 41 rows dropped, one a QB | 0.25 d |
| G08 | P1 | 62/68 overlay rows have `id: null`; `depth_chart.json` is QB-only | 0.5 d |
| G09 | P2 | A hard-failed run publishes no stage record, so the MODEL card can never show one | 0.5 d |
| G10 | P2 | A week card absent from the leg ledger never freezes and is replaced after kickoff | 0.5 d |
| G11 | P2 | A PUSH card scores as a miss in hit rate / log-loss / Brier while its money is positive | 0.25 d |
| G12 | P2 | A traded player's prop is pending forever (team-narrowed stats join) | 0.25 d |
| G13 | P2 | my_cards 3.49 MB / 1,456 cards vs 2.08 MB / 900 claimed; whole tree published to Netlify | 0.5 d |
| G14 | P2 | Boot budget at 15/15 modules with a stale note; the MY miss path fetches 1.10 MB | 0.5 d |
| G15 | P2 | The only `same_game_pairs` verdict pools 18 keys with different rhos | 0.5 d |
| G16 | P2 | 29 source-text assertions, one of which pins the expression causing G04 | 0.5 d |
| G17 | P2 | Ten roadmap claims with no test behind them | 0.5 d |

P0 2 · P1 6 · P2 9 · total 17.

Suggested order: G01 and G07/G08 together (one file, one afternoon, and they are why R91 does not
do what it says); then G02/G05/G06 together (one merge registry, one publish rule); then G03 and
G04, which are the two places a user can read a wrong number today.

---

## Open questions for the owner

1. **Which source wins for the current week's injury report?** The daily ESPN report is fresher; the
   nflverse release is the substrate the walk-forward adoption was measured on. Making the report win
   for the current week means the live signal and the backtest read different sources for the same
   week. That is a modelling decision, not a bug fix. (G01)
2. **Is `data/pipeline_stages.json` a ledger or an artifact?** It is per-workflow state committed to
   a shared file. If it should be a ledger it needs a merge shape (G05); if it should be an artifact
   it should not be committed at all and the MODEL card should read it from somewhere else.
3. **Does a frozen card survive a publish race?** R90 says a rebuild may never replace one; R88 says
   a conflict outside the registered ledgers takes the replaying run's version. They cannot both
   hold for `data/parlays/`. (G02)
4. **Should `parlay_id` exist at all?** `card_id` is now the identity. Keeping a rank-derived id as
   the join key is the thing F12 was raised about. (G03)
5. **my_cards sizing.** 1,456 cards and 3.49 MB at week 2, on a public static deploy, for a feed
   nothing fetches. Keep as-is, compact, trim the leg record, or stop publishing it? (G13)
6. **Is the pooled `same_game_pairs` verdict a claim or a summary?** It is the only verdict the block
   produces and it is over a mixture. If it is a summary, the card should not call it a verdict. (G15)
7. **Boot graph module ceiling.** 15 of 15 used. The next boot module reds the gate; is the answer to
   raise it, or to move `app/data.js`'s lazily-used getters off the boot graph? (G14)

---

## Do not fix by

- **Do not** make the current-week overlay override release team-weeks unconditionally. That lets a
  Sunday-morning report rewrite a walked-forward historical week and silently changes the corpus the
  `qb_out` adoption was measured on. Scope the freshness rule to the current week only. (G01)
- **Do not** add `data/pipeline_stages.json` or `data/parlays/` to `is_ledger()` without registering a
  matching shape in `merge_ledgers.py` first. The two registries are deliberately coupled: the merger
  refuses an unknown path with exit 2 and `publish_data.sh` turns that into `die()`, so a one-sided
  change converts a silent loss into a failed publish. (G02, G05)
- **Do not** resolve the snapshot race by deleting the `take_ours` branch and letting the rebase stop.
  An unattended cron cannot resolve a conflict by hand; either merge the receipts by `event_id` or
  fail the run explicitly with a named remedy. (G06)
- **Do not** fix the `parlay_id` collision by renumbering ranks across frozen and live cards on every
  rebuild. That reintroduces F12 — a stable-looking id naming a different bet. Retire the id as a
  join key instead. (G03)
- **Do not** fix the current-week slate by treating the whole current week as historical. For an
  unplayed game today's forecast *is* the truth, and the review layer already expresses that per game
  through `status`. (G04)
- **Do not** shrink `my_cards` by pruning old weeks or by dropping unlocked cards. The record of what
  was offered is the feature; change the encoding or the deploy, not the contents. (G13)
- **Do not** raise the boot byte ceiling again without re-reading why it moved. The pattern in the
  file is "measure, write down the cause, add ~2%"; R90 followed it. The module ceiling is the one
  with no headroom and no note. (G14)
- **Do not** delete the source-text assertions without putting behavioural ones in their place. They
  are weak tests, but removing them leaves those properties untested entirely. (G16)
- **Do not** exclude push cards from `graded` or from the money when fixing the calibration
  denominator. A push is a settled card; it is only not a *prediction outcome*. (G11)

---

## What is solid

I tried to break the following and could not. **Ledger merge identity:** every one of the six
committed ledgers — `estimates/2026.json` (392 KB, compact), `estimates/parlays_2026.json`,
`my_cards/2026_wk02.json` (3.49 MB), `model_tuning.json`, `parlays/2026_wk01.json`,
`parlays/2026_wk02.json` — merges with itself byte-for-byte, including the compact writer and the
newest-first `model_tuning` history, so a raced commit carries no cosmetic churn. **First-sight
locking is symmetric:** I ran the same-key race in both directions and the earlier `seen_utc` wins
regardless of which side is rebasing. **The `rebase --skip` path works:** I constructed a run whose
only change merges away (the other side saw the card first) and `publish_data.sh` dropped its empty
commit, pushed nothing and exited 0 — an untested path that is correct. **The lock receipts and the
review agree:** `review.json.pick_prob` equals `snapshots/*_games_open.json` `probs[picked side]` for
**all 32 graded games**, to 1e-9, with 0 games missing a lock. **`stage.sh` is honest:** it returns
the command's own exit code through `bash -e` (verified with exit 3), does not swallow output,
records stage names containing parentheses, slashes and em-dashes intact, and its
`--continue-on-error` flag agrees with the YAML `continue-on-error:` key on **every one of the 57
wrapped steps across three workflows** — I looked for drift and found none. **`qb_out` cannot
misfire:** with 62 of 68 overlay rows carrying a null id, both the `outs` builder
(`and r.get("id")`) and the application site (`if _hp and _hp in _qb_outs…`) guard it, so a missing
primary never matches a missing id. **The three R91 fires are right and the arithmetic checks out:**
ATL (Penix, depth rank 1), MIN (Murray), SEA (Darnold) fire and LV does not, because its listed QB is
rank 3 — and recomputing the Elo by hand from the committed probabilities gives 0.6141 → 0.5082,
0.5806 → 0.6807 and 0.3337 → 0.4351, matching the release note's 50.8 / 68.1 / 43.5 to a tenth of a
point. **`same_game_pairs` reproduces exactly:** 118 pairs, 18 keys, 20 R74 refusals, pooled 0.2034
vs shipped 0.2570, `rho_live` −0.1884, CI90 [−0.1098, 0.0069], 34 archived cards at 0.3235 against a
0.3022 shipped mean — and the pair key is genuinely order-independent on both tags and sides.
**The archive is idempotent:** a second `build_parlay_archive` pass over the committed data changes
the file's md5 not at all. **The MY parity port holds where it matters:** the edge cases I went
after — a `dial_legs` tie resolved on a missing `line`, a game leg with no `side`, a leg with no
`game_id` reaching `combined_game_probs`, a de-dupe key over colliding selection strings — are all
unreachable from a schema-valid pool (`line` is required and numeric, `side` is a three-value enum,
`game_id`/`team` are guarded identically on both sides, and the committed pool has 1,253 selections
with 1,253 distinct strings). **And the gate is green:** validator 1.41 s, smoke pass, 121 of 121
R87–R91 feature tests passing on a clean checkout of `d6702e8`.
