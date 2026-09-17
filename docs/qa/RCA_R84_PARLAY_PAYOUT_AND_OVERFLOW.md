# R84 RCA: small MY payouts, overflowing GAME/WEEK cards, and missed acceptance

Date: 2026-09-17. Prepared by Codex for the owner and Claude.

Follow-up: the owner subsequently authorized fixes and clarified that MY must
retain highest-model-hit-chance selection. See the
[R85 local repair and verification record](R85_PARLAY_ACCEPTANCE_FIX.md).
The RCA below preserves the incident's original state and findings.

## Conclusion and accountability

The owner's report is substantiated. I verified implementation consistency but
did not adequately verify the product experience. I retained a synthetic pricing
policy without showing its actual output distribution for acceptance, lengthened
money labels without validating their layout, and overstated the browser evidence
as “no horizontal overflow.” Those are failures in my implementation review and
release-readiness assessment, not a failure by the owner to describe the problem.

There are two distinct causes:

1. **MY's small returns are a pricing/selection-design problem, not a missing
   multiplier.** The builder selects very high-probability alternate lines and
   derives their assumed prices from those same probabilities. The reported
   approximately $31 profit is reproducible. The arithmetic is internally
   consistent; its relevance to an actual wager is unestablished.
2. **Card overflow is a confirmed layout regression.** Longer R84 labels are
   placed in an unwrapped flex footer with a non-wrapping payout. At a 1440px
   viewport, payout text extends **42.55px beyond 318px GAME/WEEK cards**.
   Document-wide overflow tests still pass.

**Disposition:** these findings reopen parlay acceptance. A green existing gate
is not sufficient to call this preview visually accepted or pricing-product
accepted. This investigation changes documentation only, not application code,
tests, generated data, main, or a deployment.

## Baseline and evidence

- Local preview: `http://127.0.0.1:4321/#/parlays`.
- Branch: `codex/r83-parlay-correctness`; HEAD `d2ffa48`, plus the existing
  uncommitted R84 implementation. This is not an audit of an independently
  fetched live deployment or proof of production's current state.
- Inspected both supplied HEIC screenshots, converted to PNG for reading without
  changing the originals. First: MY/DET, showing small two-/three-leg returns.
  Second: WEEK/five-leg, showing overflowing payout labels.
- Reproduced WEEK/five-leg values **+$443 / +$495 / +$346** in Chromium and
  measured the actual footer bounds. Screenshot:
  `/private/tmp/nfl2026-rca-week-footer.png`.
- Rebuilt MY/DET at the screenshot time, `2026-09-17T20:43:50Z`, from local
  `leg_pool.json`, `schedule_full.json`, and `parlay_backtest.json`.
- Pool generated `2026-09-17T17:59:51Z`; SHA-256:
  `87517207bb5941d2d6a097a072ef53b5b540320f98d9f3ea03272a3a762d7ad4`.
- Measured three modes at seven widths; no page runtime exceptions. Runtime
  success did not establish layout correctness.
- Machine-readable results: [RCA_R84_EVIDENCE.json](RCA_R84_EVIDENCE.json).
  Read-only reproduction: [probes/r84-parlay-rca.mjs](probes/r84-parlay-rca.mjs).
  With the local server running and Playwright installed, run
  `node docs/qa/probes/r84-parlay-rca.mjs`; set `PW_CHROMIUM` if the installed
  browser needs an explicit executable path. It prints evidence, not a passing
  regression assertion. Money is pinned to screenshot time; browser geometry
  uses the current preview and can change as data/events change.

The diagnostic/browser skills guided local reproduction and boundary measurement.
No sportsbook request, purchase, deployment, or external data write was involved.

## RCA 1 — why a $100 MY card shows only about $31 profit

### Actual data flow

`leg_pool.json` supplies calibrated model probabilities for alternate yardage
thresholds. `poolLegs()` maps them through `legFromPool()`;
`impliedFromModel()` assigns an assumed comparison probability. `buildCards()`
ranks compatible combinations by model hit probability. `scoreCard()` converts
the product of comparison probabilities into hypothetical net profit;
`renderCard()` labels it `$100 SIM NET`.

Relevant code:

- [parlay-math.js:189](../../app/parlay-math.js#L189):
  `q = clamp(p * 1.045)`. This is a chosen simulation rule, not an observed
  sportsbook price. The 4.5% factor is not evidence of any book's actual margin.
- [parlay-math.js:195](../../app/parlay-math.js#L195): prop legs explicitly carry
  `price_source: 'assumed'` and `priced: false`.
- [myparlays.js:183](../../app/views/myparlays.js#L183): candidate pool and beam
  sorted by model probability/conviction, with no user-selected risk band or
  explicit acceptance requirement for the distribution of selected lines.
- [myparlays.js:150](../../app/views/myparlays.js#L150):
  `net = 100 * (1 / product(q_i) - 1)`.

For the first reproduced six-leg card:

| Selection | Model probability | Assumed comparison probability |
| --- | ---: | ---: |
| J. Gibbs 20+ rushing yards | 87.83% | 91.78235% |
| J. Cook III 30+ rushing yards | 94.62% | 98.87790% |
| P. Nacua 40+ receiving yards | 91.72% | 95.84740% |
| K. Williams 20+ rushing yards | 91.49% | 95.60705% |
| B. Robinson 30+ rushing yards | 92.64% | 96.80880% |
| G. Pickens 20+ receiving yards | 91.04% | 95.13680% |

Their comparison-probability product is `0.7659352166270517`:

```text
assumed decimal odds = 1 / 0.7659352166270517 = about 1.30559345
stake                = $100.00
simulated gross      = $130.56
simulated net if hit = $30.56, displayed as +$31
model joint hit p    = 58.8872%
simulated EV         = -23.1173%
```

All ten generated MY/DET cards reproduce the low-return pattern:

| Legs | First card net | Second card net |
| --- | ---: | ---: |
| 2 | $10.19 | $11.29 |
| 3 | $13.82 | $14.96 |
| 4 | $18.75 | $19.05 |
| 5 | $24.21 | $25.45 |
| 6 | $30.56 | $30.59 |

There is no discovered $31 cap. The builder repeatedly chooses easy, low-yardage
lines because that maximizes its stated ranking objective. Those high model
probabilities then become high assumed comparison probabilities and low decimal
returns. Adding legs does not, by itself, imply a large payout; their prices matter.
But these are **not independently sourced prices**, so this calculation cannot
establish what a sportsbook would pay.

Scope clarification: the current MY builder supports **2–6 legs**, not seven
(`LEG_COUNTS`, line 50). The reported approximately $31 was reproduced on six
legs. WEEK has a seven-leg filter. This distinction does not invalidate the
reported usability/pricing concern.

### Deeper design problem: the simulated “edge” is circular

For independent prop legs without probability clamping, this assumption makes:

```text
EV = product(p_i) / product(1.045 * p_i) - 1
   = 1 / 1.045^n - 1
```

Thus this EV is driven by the chosen uplift and leg count, not independent price
evidence. Same-event model correlation, clamping, or different game-leg price
sources change that simplification; it should not be applied indiscriminately
to every card. Calling the result SIM is necessary disclosure, but does not make
it an independently measured opportunity or prove that the generated cards
meet the owner's intended use.

The owner approved keeping clearly labeled simulation. I treated that as enough
to retain the existing model-derived comparison policy without presenting this
concrete $10–$31 distribution. That was the missing product-acceptance step.
No unsupported “correct sportsbook payout” can be inferred from these screenshots.
Increasing a multiplier or assigning every alternate line -110 would merely
invent a more attractive number and is not an acceptable fix.

### Origin versus R84 responsibility

The conviction-only search and model-derived prop pricing predate R84. R84
clarified net-versus-gross labels and brought public-card/review simulations into
numerical alignment with the per-leg comparison assumption. It did **not**
resolve whether that assumption and candidate selection produce the intended
product. Earlier R82 findings F04–F06 had already identified pricing provenance
and inconsistent payout semantics. I closed too much of that concern through
copy changes and formula parity instead of testing the full user decision.

MY still computes its money in `scoreCard()` rather than calling the public-card
`simulateMoney()` implementation. They agree in the checked examples, but that
duplicated path remains a maintenance risk, not proof of this incident's cause.

## RCA 2 — why GAME/WEEK text escapes the cards

### Mechanism and introducing change

- [theme.css:785](../../app/theme.css#L785): `.p-foot` is one flex row with three
  children and no wrapping rule.
- [theme.css:822](../../app/theme.css#L822): `.pay` is a flex row with
  `white-space: nowrap`; its amount and longer label resist shrinking/wrapping.
- [theme.css:1613](../../app/theme.css#L1613): public-card grid allows 300px
  minimum columns. The 1320px-wide desktop canvas produces four 318px columns.
- R84 changed `$100 PAYS` into `$100 SIM NET · IF HIT` and added the payout to
  initial rendering, not only the review decoration path
  ([render.js:552](../../app/render.js#L552),
  [review.js:365](../../app/review.js#L365)). There was **no accompanying CSS
  change** in the R84 working-tree diff.
- The R82 minimum-width/layout repair is scoped to `.mp-card` / `#mp-list`,
  so it does not protect GAME/WEEK.
- `body` and `#view` use `overflow-x: hidden` (theme lines 79 and 242).
  A page-wide scrollbar check can pass while descendants overflow their cards
  or are hidden at a viewport boundary. Hiding overflow is not containment.

Measured maximum payout overhang beyond the **outer card edge**, CSS pixels:

| Viewport width | GAME | WEEK, five-leg | MY, DET |
| ---: | ---: | ---: | ---: |
| 320 | 80.55 | 80.55 | 85.20 |
| 402 | 0 | 0 | 3.20 |
| 820 | 0 | 0 | 0 |
| 1100 | 17.89 | 17.89 | 0 |
| 1280 | 0 | 0 | 0 |
| 1440 | 42.55 | 42.55 | 0 |
| 1600 | 42.55 | 42.55 | 0 |

At 1440px all 48 displayed GAME cards and all three five-leg WEEK cards fail
this boundary check. At 402px eight of ten MY cards exceed the outer edge.
At **every width above**, `document.documentElement.scrollWidth === innerWidth`.
Zero outer-edge overhang is not a full layout pass: padding intrusion, sibling
overlap, clipping, and readability need additional assertions. This measurement
isolates the reported defect; it is not comprehensive visual certification.

The viewport effect is non-monotonic: a wider viewport can introduce another
column and make each card narrower. Testing only 402px and 1280px particularly
misses the public-card failure.

## Why testing, acceptance, regression, and bug fixing missed it

The final existing gate really passed: `/private/tmp/nfl2026-r84-gate.log`
records 1,698 feature tests, four model gates, 285 browser/PWA/performance tests,
and a final green result. The failure is the **coverage and interpretation** of
that result, not evidence that those tests were never run.

| Layer | What was actually checked | What was missing |
| --- | --- | --- |
| Money unit tests | `r76_myparlays_search.test.mjs:146` verifies the same product formula against the selected inputs; R84 uses a synthetic two-leg case returning $700 | Acceptance of the input-price policy and real DET output distribution; independently specified risk/return scenarios |
| Python/JS parity | Implementations agree on math and reject unsupported same-event triples | Whether shared assumptions are suitable; two implementations can agree on an unsuitable policy |
| Browser money tests | `r75_parlay_controls.spec.mjs:35` recomputes expected results from the same source comparison probabilities; tests labels, amounts, sorting and settlement | No independent validation that those comparison probabilities are quotes or an accepted simulation scenario |
| MY functional E2E | `r76_myparlays.spec.mjs:84` checks labels and card/seed behavior | No acceptance assertion about selected line/risk distribution or meaning of the resulting money |
| Layout regressions | `r82_myparlays_layout.spec.mjs:90` checks MY row bottoms, leg-count height, leg-name fit, document width | No `.pay` containment or sibling-overlap checks; no equivalent GAME/WEEK footer matrix |
| New R84 regressions | Navigation, receipt identity, cutoff expiry, pricing arithmetic and labels | No regression covering the actual longer footer label at narrow grid breakpoints |
| Manual browser acceptance | MY/Jared Goff; desktop and phone screenshots; runtime/network checks | Prior desktop screenshot did not show the footer; mobile screenshot showed header/legend, not cards. The complete money-bearing user flow was not visually inspected |
| Model gates | Historical model/calibration and non-regression metrics | Not a sportsbook-price test, a card-generation product-acceptance test, or a UI layout test |
| Release communication | Passing counts and page-wide overflow result | Clear separation of arithmetic, geometry, pricing assumptions, product acceptance, and untested browsers |

`tests/playwright.config.mjs` uses Chromium with mobile emulation for its normal
web/PWA projects; some tests explicitly resize to desktop. This is not native
iOS Safari coverage. Safari differences were not required to cause this defect:
it reproduces in the same browser family used for testing.

### Process root causes

1. **Verification was implementation-shaped.** Expected values were derived from
   the policy being implemented, and success was interpreted as product validity.
2. **Acceptance was not expressed as a full user story.** “Choose DET, compare
   available risk/line choices, understand the simulated return, and read every
   field inside the card” was not a release-blocking scenario.
3. **Change impact was incomplete.** Longer copy in shared card/footer classes
   should have triggered GAME/WEEK/MY and breakpoint testing. The existing MY-only
   fix was treated as broader layout protection than it was.
4. **Previous defect tests were narrow.** They preserved the earlier name/row
   fixes but did not guard the full card boundary. Their names implied broader
   “foot” coverage than their assertions delivered.
5. **Evidence was overclaimed.** I reported “no horizontal overflow” from a
   document-level measure and screenshots that did not show the affected footer.
   That statement must not be treated as card-level acceptance.
6. **Bug closure conflated containment with resolution.** Labeling simulations
   honestly helped, but did not validate the generation/pricing experience.
   New arithmetic regressions did not substitute for that missing acceptance.

## Corrective plan for Claude — proposed, not implemented

Keep model probabilities independent of sportsbook markets. Do not change model
outputs, inflate payouts, remove inconvenient tests, or alter historical receipts
to make the presentation look better.

| Work item | Required acceptance / release evidence | Risk | Estimated LOE |
| --- | --- | --- | --- |
| Contain shared card footers first | Add a regression that fails on this exact copy/data; allow an intentional stacked/wrapped layout; test padded card containment, sibling separation, complete labels and no clipping in all modes | Low–medium: shared CSS may affect other cards | 0.5–1 day |
| Make the simulation policy explicit | Separate model hit probability, assumed price, net if hit, gross return, and EV; expose the chosen model-derived assumption rather than implying a book quote; show a concrete DET example for acceptance | Medium: clearer copy still needs layout design | 1–2 days |
| Define MY candidate/risk behavior before redesign | Agree model-based risk/line bands or another explicit selection objective; test multiple teams/players and low/high-probability scenarios. A higher return is not itself a correctness criterion | Medium–high: affects search and available cards | 2–4 days after product choice |
| Consolidate money paths and complete provenance | One typed pricing/simulation/settlement contract; unambiguous net/gross; exact-combination quote remains absent unless genuinely sourced; coordinate persisted builder money separately from preview adapter | High: schema/history compatibility | 2–4 days; overlaps earlier pricing work |
| Strengthen acceptance gate | Add cross-mode boundary tests, reviewed screenshots, independent financial examples, and explicit untested-platform disclosure | Medium: avoid brittle pixel-perfect tests | 1–2 days, overlaps above |

These are engineering estimates, not a deployment commitment. A real quote feed
is separate provider-dependent work, not included in these estimates. The first
recommended implementation step is the failing layout regression and responsive
footer repair; pricing presentation can be clarified without inventing new odds.
Changing MY's candidate-selection objective requires an explicit product choice.

### Required regression and acceptance matrix

- **Geometry:** GAME, WEEK and MY; 320, 375/402, 820, 1100, 1280, 1440 and 1600px;
  measure the actual containing element's padded bounds, not only the document.
  Include longest supported leg names, large/negative/unavailable money,
  pending/graded states, review decorations, and 200% zoom/text accessibility.
- **Visual evidence:** screenshots must include complete cards and footers after
  fonts/data/review updates settle. Include first and later rows, not just the
  header. Inspect the screenshots, not only their successful creation.
- **Money:** independently specified examples for net versus gross, loss,
  all-void/partial-void, pending, unavailable price and invalid inputs; verify
  card values, sorting, totals and source labels use the same selected scenario.
- **Product behavior:** pin the current DET fixture as incident evidence;
  explicitly accept or redesign its high-conviction/low-return behavior. Cover
  multiple seeds and line/risk bands. Do not assert “six/seven legs must pay at
  least $X” without an agreed pricing scenario.
- **Boundaries/provenance:** model-derived assumptions remain identifiable;
  unquoted combinations cannot become executable-book claims; same-event price
  independence remains a scenario, not a validated quote. Price changes must
  not silently retrain or contaminate model probabilities.
- **Regression proof:** demonstrate the new incident tests fail on this R84
  state, then pass after a reviewed fix. Preserve prior tests and rerun the
  full gate. Include native Safari/iOS verification if claiming support there.
- **Sign-off:** report separately what passed arithmetic, geometry, model
  validation, and product acceptance. Do not close these findings on counts alone.

## Limits and handoff

No claim is made that these model probabilities are newly validated by this
investigation, that a book accepts these combinations, or that the same outcome
exists on an independently inspected production deployment. The two symptoms
have been reproduced and traced; a complete audit of every unrelated pipeline
and AI-learning issue is outside this incident RCA and remains in the R82 review.

Application fixes have **not** been made during this RCA. Existing uncommitted
work was preserved. This report supersedes the earlier R84 document's broad
visual-readiness statement, not the factual record that its existing gate passed.
