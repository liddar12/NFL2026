# Parlay feedback pilot operations and remaining work

Revision 5 · October 16, 2026, 8:53 p.m. America/Chicago (CDT).
Owner-selected route A. Target: Sunday, October 18, 2026, 10:00 a.m. CDT.

The first local pilot connects NFL forecasts, raw outcomes, corrections and the
shared SelfLearning evaluator through the existing Actions pipeline. It saves
complete records in Git-backed files; it does not require the new Supabase
migrations or a working Vercel connection. It remains disabled and does not
activate a model. MODEL now has a saved shadow-evaluation row; adoption/rollback,
Review integration and browser/live acceptance remain required Sunday work.

## Current implementation

Engine branch `build/nfl-feedback-runtime-20261015`:

- `0e5b697`: pure frozen-generation validator, file-feedback state, independent
  raw-source binding/correction and shared calibration evaluation. HTTP intake
  uses the same extracted validator. Original import clocks survive replay.
- `8460a71`: row-quarantine acceptance and coverage provenance. The evaluation
  clock is separate from the revision-import clock; no added microsecond or
  relaxed chronological cutoff manufactures eligibility.

NFL branch `build/week6-learning-runtime-20261015`, `903d5ff6` plus `92b2b5a0`:

- `scripts/run_parlay_feedback.py`: default-off controller, explicit exact engine
  commit, original raw capture readers, content-addressed files, writer lock
  and complete-success pointer published last.
- `.github/workflows/daily.yml`: optional pinned engine checkout and recorded
  feedback stage before review/data publication. Default-off runs record a skip.
- Read-only `--check-records`: the pointer must join its immutable files and
  original frozen source graph, without loading the engine or fitting again.
  Daily validation and the feature gate check it.
  The independently reviewed injury validator remains byte-identical.

NFL `49bcd2ac` adds three locally tested corrections:

- Every publisher attempt checks the exact selected Git commit with
  `scripts/feedback_commit_guard.py`, not mutable working-tree data. It verifies
  bounded blob identities, frozen sources and retained raw captures in a private
  temporary directory. Removing a working-tree pointer after commit cannot skip
  the check, and an uncommitted repair cannot approve a broken commit.
- The controller saves exact raw evidence in its fixed repository namespace.
  The standalone capture exporter still refuses sports-data writes. A
  checkout-shaped test exposed that using its generic save function would have
  refused a real pipeline run; the dedicated controller sink fixes that path
  without weakening the standalone protection. External captures are mirrored
  so later replay does not depend on the original scratch directory.
- MODEL distinguishes receipt vintages, unique graded legs and held-out
  comparison legs. It shows Brier/log loss only when available, preserves the
  saved evaluation timestamp after failed/skipped attempts, and keeps even a
  passing numeric gate in measure-only state. A report is not activation.

The latest focused run passes **29 tests**, zero failures/skips, exit 0. The
committed-data guard and saved-status reader reach 109/109 and 103/103 executable
lines in those local tests; this is not branch, browser or live acceptance.
Full regressions on frozen NFL `49bcd2ac` and engine `9738ead` both finish exit
**0**: **2,482 NFL feature tests** pass, zero failed/skipped, plus contracts,
smoke and all four model gates; browser step 8 skips. **1,363 core/API tests**
pass, zero skips; all **48 critical engine files exceed 90%**, with stable
source/test/tool/head identities and **8,372/8,683 = 96.4183%** executable lines.
The engine report is `docs/reviews/2026-10-16-critical48-committed-status-coverage.json`;
NFL log: `/private/tmp/nfl-committed-feedback-status-full-gate-root-20261016.log`.
The earlier baseline and red run below remain historical evidence.

### Game and MY exposure follow-up

NFL `c63f34fe` adds repeated-selection and shared-game counts on the actual shown
Game/MY cards. An exact repeated selection has an explicit card-loss count;
different player IDs, markets, lines or games do not merge by abbreviated text.
Shared games are labeled separately and do not imply one common losing result.
Incomplete identity is reported, not treated as independence. Rankings, cards,
probabilities and prices remain unchanged. MY clears the previous warning and
saved-bet targets before every repaint, including empty seeds or an empty dial.

**66 focused regressions pass**, zero failures/skips, exit 0. Three browser cases
are authored for 402/1280 px, wrapping, shown-card counts and mode/dial/seed
transitions; syntax checks pass, but browser execution remains unavailable here.
The single full NFL rerun on `c63f34fe` finishes exit **0**: **2,493 features
pass**, zero failed/skipped, contracts/smoke/four model gates pass. Browser step
8 skips, not passes. Log:
`/private/tmp/nfl-concentration-full-gate-root-20261016.log`. The earlier engine
report retains its original NFL dependency SHA; UI-only changes are not a new
core/API or live-accuracy measurement.

### Owner selected candidate scope

The owner selected the recommended scope on October 16: a separate explicit
approval of **one exact candidate** may cover eligible future **2026 Week 6**
refreshes. Every generation must still pass base/version, source freshness,
pre-kickoff, expiry and rollback checks. Check cutoff per offered future event:
an already played Thursday game must not block a valid Sunday refresh or receive
a rewritten forecast. A different candidate or coefficient
set needs new approval; a pipeline refresh cannot approve its own refit.
This selects the mechanism to build, not a candidate to activate or a deployment
to release. Preserve old v1 exact-generation events; add a versioned scope
contract rather than silently broadening their authority.

The ten core tests and fifteen NFL pilot tests pass locally. They include
real NFL receipt production, zero versus missing values, incomplete-history
refusal, full-cohort evaluation, correction/old-retry preservation, same-capture
rebinding after new membership, interrupted writes and isolated stdlib CLI use.
The engine checkpoint on `1468da7` passes **1,363 core/API tests**, zero skips,
exit 0; all **48 critical files exceed 90%** executable-line coverage
(8,372/8,683 = 96.4183%), with stable source/test/tool/head identities. Complete
SQL: **93 Node passed**, zero skips, and **101 Python passed / seven native-only
skipped**, exit 0. Existing dependency warnings remain.

The first full NFL gate on `903d5ff6` is preserved as **red**, exit 1: 2,450
passed, four failed, one skipped. Model gates/contracts/smoke passed; browser
step 8 skipped. The failures exposed the R88 single-line/stage-name/dependency
placement contract, source pins on the independently reviewed injury validator,
and a Git temporary-directory cleanup race. The fixture left `info/refs` and
`objects/info/packs` after its framing assertions succeeded; synthetic repos now
isolate global Git settings and disable background maintenance. Production
reader/time limits and original injury assertions were not relaxed.

All **66 focused integration tests pass** after the fixes, including R88,
original identity/adversarial checks, framing, feedback and a real local bare-Git
publication refusal/recovery test. The full corrected NFL gate on `92b2b5a0`
passes **2,468 feature tests**, zero failures/skips, contracts/smoke and all four
model gates, exit **0**. Browser step 8 skips, not passes. The paired full engine
rerun uses `1468da7`, pins NFL `92b2b5a0`, and preserves the stable coverage
figures above. Engine evidence is
`docs/reviews/2026-10-16-critical48-nfl-pilot-r2-coverage.json`; NFL gate log is
`/private/tmp/nfl-parlay-feedback-full-gate-r2-root-20261016.log`.
The first run's cross-repository skip used
`SELFLEARNING_CHECKOUT`, distinct from `SELFLEARN_CHECKOUT`; both explicit trusted
paths are supplied in the rerun. No push, hosted change or production dispatch
has occurred.

## Data authority and files

The original NFL `learning_journal` and `learning_sources` snapshots remain the
forecast authority. The controller reads every generation, checks actual frozen
pool/schedule/source bodies and retains original receipt vintages. It never
subsamples a cohort to fit an API request or replaces the first forecast with a
later, better-looking one.

The output paths are generated by the controller:

| Path below data | Purpose |
| --- | --- |
| `snapshots/learning_outcomes/objects`, `observations`, `captures` | Exact public-source capture bytes and original observation clocks |
| `snapshots/learning_feedback/states/<hash>.json` | Complete receipts, first-import clocks, generation partitions and appended outcome history |
| `snapshots/learning_feedback/evaluations/<hash>.json` | Actual shared walk-forward report and explicit retrospective/publication limits |
| `snapshots/learning_feedback/runs/<hash>.json` | State/report/input/policy/engine links |
| `learning_feedback.json` | Small replaceable pointer to a complete locally persisted run |

Every file under snapshots is immutable. Only the pointer is replaceable, under
a local writer lock and expected-prior check. An interrupted write may leave an
unreferenced immutable artifact, but cannot advance a successful pointer. The
existing race-safe publisher retains immutable snapshots; Actions temporary
files and caches are not the persistence boundary. Local persistence is not
proof that Netlify served a forecast.

The current file profile limits JSON documents/complete input graph to 128 MiB,
raw captures per run to 128 MiB, receipts to 50,000 and captures to 32. Exceeding
a limit fails visibly without advancing success; it never drops history.
All historical captures referenced by the current state must remain verifiable;
their aggregate raw replay budget is 512 MiB. The committed-tree checker has a
separate 1 GiB materialization, 20,000-file and 300-second wall budget, with at
most 128 MiB per file and tighter capture metadata/raw limits.
Indexed hosted storage remains the long-term path before this bounded pilot
outgrows its capacity. The CLI has process CPU/file-growth limits; Actions owns
the 15-minute stage wall timeout. These are not global memory or cost ceilings.
The existing export validator also retains its 3 MiB limit for each individual
forecast source/generation request. Measure the fresh full pool at release;
oversize inputs fail rather than being truncated. First-import clocks record
controller preparation, not Git/Netlify publication or a public offering time.

## Local operator commands

Default dry run reads no credentials, opens no inputs and writes nothing:

```bash
python3 -I -S -B scripts/run_parlay_feedback.py
```

For an explicitly selected scratch `data` directory containing generated frozen
forecasts and a verified saved capture, use an exact trusted engine commit:

```bash
python3 -I -S -B scripts/run_parlay_feedback.py --execute \
  --data-dir /absolute/scratch/data \
  --capture /absolute/capture-root/captures/CAPTURE_HASH.json \
  --engine-checkout /absolute/trusted/SelfLearning \
  --engine-commit REVIEWED_FULL_40_CHARACTER_COMMIT
```

`--fetch-outcomes` additionally authorizes the existing adapter to observe public
sources for every period in the frozen journals and save exact raw evidence.
It introduces no credential or caller-provided source URL. Unavailable/nonfinal
or ambiguous evidence stays pending/withheld, never a repaired zero or loss.
Do not point a rehearsal at real production data or invent production outcomes.

To check a selected local commit without loading the shared engine or changing
checkout files:

```bash
python3 -I -S -B scripts/feedback_commit_guard.py \
  --checkout /absolute/NFL2026 \
  --expected-head EXACT_FULL_40_CHARACTER_NFL_COMMIT
```

This command writes and removes a private temporary materialization. It checks
Git data integrity, not provider authentication, public offering time or the
Netlify deployment. `--check-records` remains the working-file check used before
the pipeline commits generated records.

## Owner release steps after remaining acceptance passes

1. Review/reconcile the local NFL branch against current main and run the gates
   on the exact release revision. Latest read-only main at 8:53 p.m. CDT is
   NFL `d0f99be248003f109c9b6394feb2ab14921205cb`; engine main is still
   `aa5bbaeddca4138399a21c1894b4aed4bacb52b4`. Since the earlier `45b3cac4`,
   two commits change 51 paths, all under data; no runtime/workflow change.
   [Recorded comparison](qa/2026-10-16-2053-remote-heads.json). No newer remote
   data was imported or release-tested locally. Local code is not published.
2. Authorize publishing the reviewed engine commit to an approved branch so
   Actions can check out its full SHA. An engine-main merge is not necessary for
   that checkout and could trigger Vercel's separate production integration.
3. Authorize the NFL merge/release only after future-consumer, rollback, UI,
   freshness and end-to-end acceptance are complete. No migration is required
   for this Actions-first pilot.
4. Set repository variable `SELFLEARN_NFL_ENGINE_COMMIT` to that exact published
   40-character engine SHA. Set `SELFLEARN_NFL_PILOT_ENABLED` to `1` when the
   owner authorizes activation. The public engine checkout needs no new
   Supabase, Vercel or cross-repository secret.
5. Manually dispatch the daily workflow. Verify its feedback stage, generated
   pointer/immutable files, data-ci and actual Netlify deployment identity. Run
   a repeat/recovery check; a green GitHub job alone is not served-site proof.
6. For Sunday, target manual refresh at 8:00 a.m. CDT, data checks at 9:00 and
   go/no-go at 9:30. Continue pre-kickoff refreshes afterward; GitHub cron is
   best-effort, not a deadline guarantee.

The local data checkout currently contains zero new-format learning journals.
New production generations must create these records; old display card archives
cannot be relabeled as equivalent source-complete forecasts. A new loop can
operate while its candidate correctly remains held for insufficient multiweek
evidence.

## Remaining Sunday acceptance

1. Actual future-generation consumer plus explicit owner approval and rollback;
   candidate files/materialization drafts alone do not count. Preserve old
   receipts and the exact base/correction order. Use the owner-selected pinned
   candidate/Week 6 scope above; actual authorization, consumer and rollback
   remain to be implemented and tested.
2. Model/Review display of last success/failure, source/generation age, cohort
   size, metrics, exclusions and held/adopted state. No old success shown as a
   fresh run after failure. MODEL's saved shadow row is implemented; Review,
   subgroup comparison, manifest navigation and browser acceptance remain.
3. Browser acceptance of shared-leg/game exposure on visible recommendations;
   Week's existing panel and Game/MY's new count-only panel do not diversify
   selections, add duplicate filler or claim independent cards.
4. Complete fresh-input pipeline/served-generation acceptance, including current
   eligibility, stale feeds, missing stats, correction recovery and rollback.
   Committed-tree data validation is implemented; it does not attest that
   Netlify served that generation or authenticate the upstream provider.

Shared calibration supports MY player-yardage props only. Do not apply those
coefficients to moneyline/spread, anytime TD or joint probability. Keep R126,
R102/R106, Elo k=20, R127/weather shadow and missing rain as unknown. A functioning
loop does not establish a Week 5 accuracy improvement or promise future winners.
