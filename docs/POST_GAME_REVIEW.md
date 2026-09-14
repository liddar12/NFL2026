# Post-game review (R71) — `data/review.json`

After a game is FINAL and a week's stat lines are published, the app shows what the
model predicted, what happened, and — measured from the model's own inputs and the
actual stat line — why. Builder: `scripts/build_review.py`. Contract:
`data/contracts/review.schema.json` (inlined, no `$ref`). Reader: `app/review.js`
(lazy import from the SLATE and PARLAYS views; `renderPlayerReview(gsisId, week)` for
PLAYERS). Selftests: `python3 scripts/build_review.py --selftest`,
`python3 scripts/build_review_narrative.py --selftest`.

## The contract

```
{season, generated_utc, sources: {...}, notes: [...],
 weeks: {"1": {
   games:   [{game_id, home, away, kickoff_utc, picked, pick_prob,
              final: {home_score, away_score, winner} | null, status, final_source,
              result: "won"|"lost"|null, brier, why: {source:"measured", summary, reasons[]},
              narrative?: {text, source:"ai_narrative", generated_utc, why_hash}}],
   parlays: [{parlay_id, scope, game_id, result: "hit"|"miss"|"pending"|"void",
              legs: [{selection, market, game_id, result, actual, why}]}],
   players: [{gsis_id, name, position, team, week, projected, low, high, actual,
              verdict: "over"|"under"|"met"|"dnp", delta,
              why: {source:"measured", summary, reasons:[{factor, points, text}],
                    expected_basis, unattributed, omitted[]}, narrative?}],
   summary: {picks: {n, won, pct, brier}, parlays: {n, hit, miss, pending, legs_n, legs_hit},
             players: {n, over, under, met, dnp, band_coverage}}}}}
```

Every value is traceable to a committed input or the fetched stat line (`sources`
names each input and its timestamp). **Absent is null, never 0.**

## Rules

**Status gate.** A game produces a result only when (a) an ESPN row with a FINAL
status (`STATUS_FINAL` / `STATUS_FINAL_OVERTIME`, `scripts.scrape.espn.FINAL_STATUSES`)
carries both scores (`final_source: "espn_final"`), or (b) the week's lock file holds
a graded receipt (`resolved` + `actual`), which `scripts/resolve_locks.py` writes only
for a FINAL game (`final_source: "lock_receipt"` — winner known, score `null`). Live,
halftime and 0-0 scheduled stubs never grade anything. A tie is ungradable against a
2-way pick and stays `result: null`.

**The predicted team is the lock's own `probs`** (`data/snapshots/<season>_wkNN_games_open.json`,
as-made, immutable) — never the live probs in `game_predictions.json`. `brier` is the
lock's receipt when present, else `scripts.harness.metrics.brier` over the same vector.

**Player verdict (owner decision).** `met` when `low <= actual <= high` (the calibrated
week band from `estimate_scores.json`); `over` when `actual > high`; `under` when
`actual < low`; `dnp` when the resolver flagged the row `dnp` — then `actual` and
`delta` are `null`. A player row exists only when `estimate_scores.resolved` has the
player-week; a player with no actual row has no review row.

**Parlays.** Leg outcomes enter through ONE adapter, `leg_outcomes_from_ledger(doc)`,
which reads partition C's `data/parlay_leg_scores.json` (`resolved[]` rows with `hit`,
`unresolved[]` rows with a `reason`), keyed `(week, game_id, market, selection)`.
`hit` → `hit`, `false` → `miss`, unresolved → `pending` with the reason, unresolved
`push`/`tie` → `void`. A moneyline leg also grades directly from the game review
(finals / lock receipt) when the ledger has not resolved it; spread and prop legs grade
only through the ledger. A parlay is `pending` until every leg is graded, then `miss`
if any leg missed, `void` if a push/tie remains among otherwise-hit legs, else `hit`.
Parlays are reviewed from `parlays.json` while it holds the week; once it moves on, the
week's parlay rows are carried forward from the previous `review.json` and re-graded.

## The measured why

`source: "measured"` — deterministic over committed inputs, byte-identical on re-run,
no model call (the same provenance contract as `scripts/ai_estimates.py`).

**Players.** Expected week components = the player's season stat components
(`player_weekly.json` `league_components` + `receptions_prior`, the inputs the weekly
split was built from) × (locked `shipped` / season projection). Against the nflverse
stat line (`stats_player_week_<season>.csv`):

| factor | measure |
|---|---|
| `touchdowns` | 4 × (pass TD − exp) + 6 × (rush TD − exp) + 6 × (rec TD − exp) |
| `volume` | per unit (pass attempts / carries / targets): (attempts − exp) × expected pts per attempt |
| `efficiency` | per unit: attempts × (actual pts per attempt − expected pts per attempt) |
| `turnovers` | −2 × (INT − exp) − 2 × (fumbles lost − exp) |
| `two_point` | 2 × (2-pt conversions − exp) |
| `model_factor` | what the weekly split applied this week vs an even split of the playable weeks (DvP × Elo tilt × weather × venue, combined) |
| `availability` | injury-report status (`injuries.json`, as-of stamped); DNP = the whole projection |
| `game_script` | the final margin when a score is on file (context, no points) |

volume + efficiency is an exact decomposition of the yardage/reception delta. The
`reasons` list carries the top 3 numeric factors by |points| plus the context lines;
`unattributed` = delta − the shown numeric factors, so what a reader sees always
reconciles to `actual − projected`. Every line carries its numbers
(`"2 rushing TD vs 0.6 expected (+8.4)"`).

**Games.** `confidence` (pick %, lock time, model in force, estimate flag), `margin`
(final score and home margin; "blowout" at ≥ 17), `qb1_home` / `qb1_away` (the team's
highest-projected QB and his `injuries.json` status at the stamped as-of; "no
injury-report row" is reported as exactly that, not as healthy), `venue_weather` (roof
and the `weather_forecast.json` row when one exists).

**Where an expectation cannot be derived, the factor is omitted and the row's
`omitted[]` and the document's `notes[]` say so.** Known gaps: no stat line on file
(offline, or nflverse not yet published) → no touchdowns/volume/efficiency/turnovers;
no `league_components` for a player → no expectations; `player_weekly.json` stores the
combined weekly multiplier only, so DvP / weather / venue / tilt are reported combined,
never split; the game model (`elo_prior`) applies no weather factor, so the game row
reports roof and forecast as facts only; a lock receipt without an ESPN score reports
the winner and `home_score: null`.

## The P10 exception — optional AI narrative (opt-in, labeled, display-only)

The product runtime never contacts an LLM. `scripts/build_review_narrative.py` is the
one exception, and it runs only on the GitHub runner, only when BOTH
`ANTHROPIC_API_KEY` (secret) and `REVIEW_NARRATIVE_MODEL` (repository variable) are set;
otherwise it prints one line and exits 0. It POSTs the measured attribution JSON to the
Messages API (stdlib `urllib`, `temperature: 0`, the model name taken from the variable
and nowhere else) with the instruction to restate only those facts in ≤ 60 words and
never a new number. The reply is checked, not trusted: over 60 words, or any number not
present in the attribution, is rejected and nothing is written. What survives is
attached as `narrative: {text, source: "ai_narrative", generated_utc, why_hash}` and
the UI labels it **AI NARRATIVE**. `why_hash` binds it to the exact why it restates:
`build_review.py` carries a narrative forward only while the hash still matches, so it
can never outlive its facts. The measured why is the source of truth and renders
whether or not a narrative exists. If the API rejects `temperature` for the chosen
model (HTTP 400 naming it), the request is retried once without it and the run prints
`sampling: model default` — never silently.

### Manual handoff — enabling the narrative layer

1. Open the repository on GitHub → **Settings** → **Secrets and variables** → **Actions**.
2. On the **Secrets** tab click **New repository secret**. Name: `ANTHROPIC_API_KEY`.
   Secret: your Anthropic API key. Click **Add secret**. You should see
   `ANTHROPIC_API_KEY` listed under *Repository secrets*.
3. Switch to the **Variables** tab → **New repository variable**. Name:
   `REVIEW_NARRATIVE_MODEL`. Value: the exact model name you want to use. Click
   **Add variable**. You should see it under *Repository variables*.
4. **Actions** → **daily-pipeline** → **Run workflow** → **Run workflow**. In the run,
   the step *AI narrative (optional, env-gated)* should print
   `review_narrative: N calls, N written, ...` instead of `SKIPPED`.

Confirmation block:
- Secret `ANTHROPIC_API_KEY` added: yes / no
- Variable `REVIEW_NARRATIVE_MODEL` added: yes / no
- daily-pipeline step output line: ______
- Error or anything unexpected: ______

Rollback (one line): delete the `REVIEW_NARRATIVE_MODEL` repository variable — the next
run skips with exit 0 and `build_review.py` keeps only narratives whose why is unchanged
(to purge them all: `python3 scripts/build_review.py` on the runner rewrites the file;
narratives without a matching hash are dropped). To back out the whole feature:
`git revert <the R71 commit>`.

## Pipeline wiring

`gameday.yml`: `python3 scripts/build_review.py` after *Resolve locks against FINAL
scores* / *Refresh scores* (so the slate circles land inside the gameday window).
`daily.yml`: `python3 scripts/build_review.py` after `resolve_estimates.py` and the
parlay resolver, then `python3 scripts/build_review_narrative.py` with the two env
vars, `continue-on-error: true`. Smoke runs both `--selftest`s; the feature lock is
`tests/feature/r71_review.test.mjs`, the browser proof `tests/web/r71_review.spec.mjs`.
