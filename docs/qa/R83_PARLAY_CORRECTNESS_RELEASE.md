# R83 — Parlay correctness, release 1

Status: local implementation; **not deployed**. Production approval is still required.

The owner selected critical correctness fixes first, delivered in smaller tested
releases. This is the first increment, not completion of the whole RCA backlog.
Review baseline and remote main checked during this work:
`886b5bb40e68e90f6074489723fbe4c3703c0935` (R82).

## Scope and evidence

| Finding | This release | Remaining |
|---|---|---|
| F01 — lost game side | Preserve public `side` through serialization; resolve legacy game legs from matching event/team identity; refuse conflicting or unresolved client legs with a visible count. | Broader event-cutoff and provenance contracts are separate. |
| F02 — mixed-card correlation | Group legs by event, use the existing within-event estimator, then multiply independent event groups. Search and displayed card probability use the same path. Mixed cards are labeled `MIXED GAMES`. | The within-event estimator's 3+ leg limitation below still applies. |
| F03 — invalid joint probabilities | Correct both Python and JS two-leg Fréchet bounds to `[max(0,p+q−1), min(p,q)]`. | **Not fully fixed:** the sequential estimator for 3+ legs in one event remains order-dependent. No new joint model was fitted or claimed validated. |

Reproduction on the committed pool: BUF ML (home, 0.6527) with Jared Goff
125+ pass yards (away, 0.808), event `401872932`, now combines to
**0.5086288271654137**, versus the RCA's 0.5461343728345863 with side lost.
All **29 of 29** committed game legs remain available through the legacy adapter.
Individual model probabilities and price columns are unchanged by this adapter.

An independent mixed-card regression uses probabilities .8 and .6 in one event,
default rho .1, and .7 in another. Its expected joint is
`(.8*.6 + .1*sqrt(.8*.2*.6*.4)) * .7 = .3497171425595858`, not .336.
The browser test checks the displayed 35 rather than the old 34.

## Boundaries preserved

- No forecast snapshots, archives, model tuning, current data artifacts or outcome
  records are rewritten. Only schemas under `data/contracts/` change.
- Current and archived Parlay schemas both accept optional public `side`; old
  archives remain valid. New generated pool rows preserve/recover side.
- Legacy client recovery requires the **same event and team** and an unambiguous
  home/away side. Another week's player row cannot supply the side.
- Unknown game legs are withheld with a visible warning, not assigned default
  positive correlation. Conflicting producer identity fails explicitly.
- No market price enters the model probability, no coefficients or promotion
  policies change, and no never-regress threshold is lowered.
- The UI remains vanilla JS/PWA; no dependency or framework is added.

## Regression and browser evidence

New `tests/feature/r83_parlay_correctness.test.mjs` covers the Python → JSON → pool
→ JS round trip, current/archived schema acceptance, legacy recovery, cross-event
and conflicting-identity refusal, production-shaped pool generation, mixed 2+1
and 2+2 cards, search/display agreement, and Python/JS bounds including certainty.
All five initial regression tests failed on the original code before the fix.
The suite now contains six tests (the producer compatibility test was added next).

New `tests/web/r83_parlay_correctness.spec.mjs` drives the actual MY UI against
new and legacy pool fixtures and verifies the missing-identity warning.
`parlay_props.test.mjs` now explicitly requires a valid public side while continuing
to reject internal underscore fields; its previous allowlist rejected the intended
new contract. No behavioral gate was disabled.

Interactive browser verification used the browser-verification skills to trace
the complete local flow: Parlay → MY → pool load → Jared Goff search → ten cards.
Desktop and 402×874 mobile views rendered; mixed cards were readable; no page
errors were detected. Local server requests for app/data assets returned 200.
This is Chromium mobile emulation, **not** an actual iOS Safari check.

Full gate result: **PASS, exit code 0**, all eight steps in one invocation:
data validation, smoke, **1,691 feature tests**, all four model gates, and
**282 browser/PWA/performance tests** (including the three new browser tests).
`git diff --check` also passed. The first run caught the old allowlist and
was also blocked by sandbox permissions starting the browser server. Those are
recorded separately from the final authorized run; an initial failure is not
being represented as a passing gate.

Reproduce the gate with the repo's supported Python/Node and installed Playwright:

```bash
bash tests/run_gate.sh
```

This Mac uses Python 3.12.9 and Node 26.7.0, versus CI's 3.11/22. Local Chromium
is selected with `PW_CHROMIUM`. The successful local command was:

```bash
PATH=/Users/jliddar/.pyenv/versions/3.12.9/bin:$PATH PW_CHROMIUM='/Users/jliddar/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' bash tests/run_gate.sh
```

It ran with permission for the local browser server. Complete local log:
`/private/tmp/nfl2026-r83-gate-verified.log`; initial failing run:
`/private/tmp/nfl2026-r83-gate.log`. Screenshots:
`/private/tmp/nfl2026-r83-parlays.png` and
`/private/tmp/nfl2026-r83-my-mobile.png`. These are local evidence, not published
site assets. The full gate must pass on the exact merge candidate before
deployment, and current main must be rechecked because data crons can advance it.

## Release / rollback

No push or production deployment has occurred. The working branch is
`codex/r83-parlay-correctness`. The two commits are: additive schema compatibility,
then runtime fixes/tests. It descends from the separate R82 review-document
commit; publish only these scoped commits onto current main without accidentally
including the review evidence bundle if that bundle is not intended for the site.

After approval: synchronize current main, apply the scoped fix, rerun the gate
if the candidate differs, push without force, wait for Netlify, and verify the
deployed JS/data flow. Do not treat a successful push as a verified deploy.

Rollback is a **revert of the runtime-fix commit**, then a normal push:
`git revert <runtime-fix-commit> && git push origin main`. Leave the separate
additive schema commit in place: later pipeline runs may have emitted optional
side fields, which must remain accepted even after the runtime rollback. There
is no data migration to undo. Never rewrite history or erase cron data.

## Still open in the selected critical scope

Next increments must address the remaining F03 joint-estimator issue and F04–F07
pricing/provenance/payout/cutoff issues; F08–F13 prediction locks, leak-safe fitting,
effective parameter replay/preservation, immutable card history and historical
Slate display; and F14–F17 refresh, navigation stalls and pipeline publication.
The detailed risk/acceptance criteria remain in the R82 review,
`docs/qa/CODEX_REVIEW_R82_FOR_CLAUDE.md` on the separate `codex/r82-review`
branch (that evidence bundle is not part of this release).

This release must not be described as making every displayed EV/payout executable,
validating a new multi-leg probability model, repairing all historical predictions,
or completing the critical review findings.
