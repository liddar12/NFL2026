# R85 local parlay acceptance repair

Status: local working tree only. No push, merge, deployment, historical rewrite,
or model promotion. Builds on the existing R83/R84 work without discarding it.

## Owner's clarified objective

MY should build custom parlays with the highest model-predicted chance of hitting,
using the prediction/learning data available to it. The owner did not choose
lower-probability difficulty bands or payout-driven ranking. Preserve conviction
ranking, model/market separation, and existing evaluation/promotion safeguards.
The beam search is a heuristic over the eligible pool, not a proof of a global
optimum or a guarantee that the card will hit.

## Repairs

- Shared card footer uses a two-column grid with the payout on its own full-width,
  wrapping row. Head badges can wrap rather than escaping narrow cards.
- GAME/WEEK/MY show a shared `$100 stake → $X simulated gross` explanation next
  to the net-profit label. A settled loss shows $0 gross; a push shows $100 gross;
  unavailable prices do not become invented returns.
- MY explicitly discloses the current model-derived prop comparison assumption
  (`model probability × 1.045`, capped), and why high-hit-probability selections
  have small simulated returns. No artificial multiplier or -110 quote was added.
- MY's hit probability now includes a percent sign and is no longer colored red
  because of negative simulated EV. It remains distinct from that pricing metric.
- A regression changes every comparison price while keeping model probabilities
  fixed and verifies that MY's card selections, ordering and probabilities do
  not change. No difficulty bands were added.
- The incident's $30.56 net is retained as an independently pinned regression
  example: $130.56 gross includes the original $100 stake. The display change
  does not turn this assumption into a sportsbook quote.

## Verification record

Four new browser regressions were run before the CSS fix: **all four failed**.
After the fix, **all four passed**. They inspect footer element/text boundaries
inside padded card bounds, plus sibling overlap, rather than relying on document
scroll width. They cover GAME/WEEK/MY at 320, 375, 402, 820, 1100, 1280, 1440 and
1600px, plus large/graded amounts and doubled text sizes.

Source: `tests/web/r85_parlay_acceptance.spec.mjs` and
`tests/feature/r85_parlay_acceptance.test.mjs`.

Visual evidence was captured and inspected with complete footers visible:

- `/private/tmp/nfl2026-r85-week-desktop.png`
- `/private/tmp/nfl2026-r85-week-phone.png`
- `/private/tmp/nfl2026-r85-my-six-phone.png`
- `/private/tmp/nfl2026-r85-my-six-final.png` (final percentage display)

**Final full gate: PASS, exit code 0.** All 1,702 feature tests, four model gates,
and 289 browser/PWA/performance tests passed together. Data validation and smoke
checks also passed. Evidence: `/private/tmp/nfl2026-r85-verified-gate.log`.
`git diff --check` and JavaScript syntax checks passed. This Mac uses the
installed Python 3.12.9 and Chromium 1223 override. A preliminary targeted
feature run accidentally used Apple's Python shim and failed the existing
Python-dependent R84 lock test on the Xcode license; the gate uses the installed
Python instead. No model thresholds or acceptance tests were weakened.

The first full run (`/private/tmp/nfl2026-r85-gate.log`) passed before the final
percent-sign/ranking-regression additions. The next run
(`/private/tmp/nfl2026-r85-final-gate.log`) correctly failed two legacy browser
assertions expecting `35CONVICTION` instead of `35%CONVICTION`; 16 dependent
performance tests did not run. Only that expected label was updated: the
independent 35% correlation oracle and its selection/identity assertions remain
unchanged. Do not cite that intermediate run as green.

Browser-verification skills were used to inspect the complete user flow, not
just successful navigation. MY's schedule, correlation and pool JSON requests
returned HTTP 200; selecting DET produced ten cards. The final six-leg footer
showed `59% CONVICTION`, `-23.1% SIM EV`, `+$31`, and
`$100 stake → $130.56 simulated gross if hit`. The browser error log was empty.
This is a static-JSON flow; no new backend API or training endpoint was added.
Visual checks used Chromium desktop/mobile emulation, not native iOS Safari.
Doubled text-size regression coverage is not a claim of native browser zoom
or platform-wide accessibility certification.

## Learning/data limits — not repaired by CSS or money copy

MY consumes `leg_pool.json`: player-week projections and game probabilities are
converted into historically calibrated prop probabilities by `build_leg_pool.py`.
The browser combines eligible legs using `parlay_backtest.json` event-correlation
parameters. It does not train a new model on each search or invoke an LLM for
numeric prediction. The repository's learning mechanisms have separate gates
and promotion policies; they are not a uniform continuously self-promoting AI.

This patch does not claim every potentially useful signal is integrated, that
fresh upstream data was fetched, or that custom-card probability calibration is
fully validated. The earlier R82 pipeline/learning findings remain open. Real
sportsbook-combination prices are still unavailable; simulated dollar amounts
must not be treated as executable quotes or realized betting returns.
