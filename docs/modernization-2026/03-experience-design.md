# Experience and UI specification

## Product promise

Help a Sleeper manager understand this week's lineup, the settings behind its points and the evidence behind a recommendation. Research and learning are available without displacing that weekly job. Keep J5L/NFL2026 branding and the existing model independence from market prices.

The interactive prototype implements the proposed navigation and representative states with fixtures. It is a design artifact, not a replacement production client. Its desktop sidebar becomes a five-item bottom navigation on phones. Settings remain a contextual destination under My League.

## Navigation and feature preservation

| Destination | Primary question | Existing capabilities retained during migration |
| --- | --- | --- |
| My League | Who should I start, and what should I review? | Team roster, weekly lineup, matchup, waivers, season outlook; contextual links to League and Grade |
| Players | Which available player improves my roster? | Player search, position filters, player detail, two-player Compare, projection/signal explanations |
| NFL | What is happening in this week's games? | Slate, game projections, game detail and later live display |
| Research | Does this specific market match a defensible estimate? | Parlays, Markets, calibration and a later paper decision journal |
| Learning | What was recorded, resolved and improved? | Estimate history, model evidence, accuracy and proposal review |

Preserve old hashes through an explicit alias map. The existing Team/draft workflow remains accessible through My League → Draft room during draft season. Move Grade under season outlook only after partial-coverage rules are enforced. Keep league standings and matchup detail one tap from My League. Do not delete legacy screens until capability parity is demonstrated. The prototype demonstrates the main path; draft room, full standings, historical charts and waiver execution are not implemented in it.

First visit opens a brief Sleeper setup: enter username or league ID; select season/league; choose own roster; review scoring and identity coverage; continue to My League. Store that choice locally initially. Reconnection and league switching do not clear historical forecast records. Show setup again only when the saved context is invalid. Sleeper connection is a read operation; lineup suggestions never imply a successful write to Sleeper.

## Screen contracts

### My League

Order: league/week context; scoring and sync health; matchup estimate; highest-priority lineup decision; starters and bench; waiver suggestions with both weekly gain and rest-of-season cost. Keep one primary action per card. An injury or bye can outrank a small projected gain.

Every total uses the current scoring version and a visible completeness status. A partial D/ST makes the aggregate partial. An unmatched player stays on the roster with an unavailable estimate. Suppress affected letter grades and precise title odds until their prerequisites pass; do not insert zero points for missing data. Weekly versus season estimates are explicitly named. The prototype's swap action previews and undoes a local lineup only.

### Players

Search is always visible. Position, available/on-roster and week are the first filters; advanced filters expand separately. Show name, team/position, availability, league-adjusted estimate, coverage and why the player is relevant. Compare exactly two compatible projections with the same week, horizon and scoring policy. The detail sheet exposes applied scoring components, input as-of, model version and honest uncertainty method. Empty search offers a clear reset. Preserve keyboard focus when filters update results.

### NFL

Group games by week and state: scheduled, live, delayed/postponed, final and corrected. A scheduled matchup cannot resemble a live score. Show source timestamp and stale state beside scores. State whether probabilities include a tie or are conditional on no tie. Final display is separate from eligibility for the outcome resolver. A network outage retains the last valid display with a stale reason.

### Research

Start with event/market identity and model probability. Show exact legs and explain impossible or nested events before offering a combination. Separate a hypothetical payout calculator from a verified book quote. Production EV needs an eligible probability estimate, matching combined quote, expiry and settlement policy. Missing, stale, unmatched or unverified quotes disable actionable EV and any stake recommendation. The prototype includes no betting or paper-journal write.

Markets display single-game, season-series and other scopes distinctly. A season-series contract is excluded from a game probability comparison. Historical paper returns require archived actual combined odds and settlement revisions. Avoid celebratory colors or strong confidence wording for model-only examples.

### Learning

Show the active model, any owner override, retained baseline, number of eligible resolved events and latest evaluation as-of. An unknown metric displays an em dash with its reason. Zero is a measured value, not an empty-state default. The forecast log links each prediction to its source snapshot and outcome revisions. Model detail shows paired event counts and independent clusters, scoring/horizon policy, holdout and uncertainty. Proposal cards explain which prerequisites are missing; approval is absent for readers and disabled for ineligible proposals.

### League settings and coverage

Show the imported rules, roster slots, sync status, identity matches and unsupported components. List unresolved Sleeper IDs with source names; provide a review path without silently inventing projections. Scoring support is component-level, not a global “connected” badge. A rules change creates a new scoring version and invalidates incompatible cached calculations. Show when the last successful import happened, not merely when refresh was clicked.

## Shared states and content rules

| State | Display | Allowed action |
| --- | --- | --- |
| Loading first context | Short skeleton and clear status | Cancel or change league; avoid zero totals |
| Valid and complete | Points, week, scoring policy and as-of | Compare and inspect |
| Partial coverage | Numeric supported subtotal plus persistent partial marker | Inspect gaps; qualified decisions only |
| No estimate / unknown metric | Em dash and a specific reason | Resolve identity or await evidence |
| Stale feed | Retain prior value; show last success and age | Retry; no time-sensitive actionable EV |
| Conflict / changed rules | Explain incompatible versions | Refresh a complete generation |
| Dependency failure | Inline error near the affected task | Retry without losing league context |
| Example data | Permanent design-preview banner | Local reversible demonstrations only |

Use plain labels: “PPR + TE 0.5”, “Updated 12 minutes ago”, “13 players need a match”, “Quote required” and “Awaiting final results”. Avoid unexplained abbreviations and claims such as “80% confidence” without a matching method and measured evidence. Put technical provenance in detail sheets, while status and consequences remain visible in the main flow.

## Visual system

| Token | Target |
| --- | --- |
| Canvas / panels | Cool light gray canvas, white panels; navy navigation |
| Brand / action | J5L red brand accent, blue primary controls; semantic green/amber used with text |
| Typography | System sans; 16px body; 28–34px desktop titles; 24–28px phone titles; tabular numeric metrics |
| Spacing | 4px base; common 8 / 12 / 16 / 24 / 32px gaps |
| Shape | 12–16px panel radius; thin neutral border; minimal shadow |
| Layout | Wide desktop content with contextual side panel; single column on small phones |
| Controls | Minimum 44px main touch targets; visible hover, focus, disabled and pressed states |
| Navigation | Five persistent destinations; settings nested; safe-area inset for phone bottom bar |
| Motion | Short state transitions; reduced-motion preference; no decorative animation |

The prototype CSS is the executable visual reference. Production tokens should be introduced into the current stylesheet incrementally. Avoid a parallel UI framework or full-page redesign merge that makes regressions hard to isolate.

## Accessibility and device acceptance

Target WCAG 2.2 AA. Keyboard users can reach all controls, operate filters, open/close dialogs with Escape and return to the triggering control. Route changes update the document title and move focus to the main heading; in-page updates retain the active input. Announce async status once through a polite live region. Use native buttons, labels, headings, links and dialog semantics. Do not convey availability or data validity by color alone.

Validate 320, 375, 390, 768, 1024 and 1440px widths, 200% text zoom, long player/league names and loading/error states. Tables either reflow or have an intentional labeled horizontal scroll region. Check that bottom navigation does not cover actions and respects phone safe areas. Test phone Safari and installed PWA behavior, Chromium keyboard flow and reduced motion. Verify normal text contrast at least 4.5:1 and large text/control boundaries at least 3:1 as applicable. These are implementation acceptance criteria, not a claim that the prototype has passed a visual or assistive-technology audit. [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)

## Design validation status

Eleven automated DOM interaction checks pass: all routes, TE premium example, bye state, swap/undo, search/filter empty state, bounded comparison, missing/expired quote gating and hypothetical arithmetic, market-scope exclusion, learning empty states, input labels and absence of external requests. The test harness stubs dialog behavior and does not test layout, native focus trapping, screen readers or real browser rendering. Real-device visual acceptance remains a production UI release gate.
