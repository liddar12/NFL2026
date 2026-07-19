# UI/UX Audit — REL11 (2026-07-18)

Full page-by-page + component review at 402px (iPhone) and 1366x1024 (13" iPad),
screenshots archived from the live build. Priorities: P1 usability/perf, P2
clarity/affordance, P3 polish. AC = acceptance criteria; every DONE item has a
regression lock.

| # | Page | Finding | Priority | Status |
|---|------|---------|----------|--------|
| 1 | Players | Unbounded list rendered ~90,000px tall on phone (300+ cards, heavy DOM, unusable scroll) | P1 | DONE — top-60 cap + SHOW MORE (step 60, remaining count); filters reset the cap. AC: initial paint <= 60 cards; SHOW MORE extends; e2e-locked |
| 2 | Slate | Internal jargon leak: "MODEL - ELO_PRIOR" (snake_case) on every card | P1 | DONE — humanized ("ELO PRIOR"); renderer strips underscores. AC: no underscore labels; e2e-locked |
| 3 | Slate | Kickoff line orphan-wraps ("SUN - 1:00 PM / ET") next to long venues | P1 | DONE — time nowrap + venue ellipsis, flex min-width discipline. AC: one-line meta at 402px |
| 4 | Slate | Favored team not scannable — both probability heads equal weight | P1 | DONE — .ph--fav (ink + 800) on the winning side. AC: exactly one fav per card; e2e-locked |
| 5 | Slate | Week chip rail scrolls with no affordance (WK 6 cut mid-chip) | P2 | DONE — right-edge fade gradient on .wkbar |
| 6 | All | No visible keyboard focus on chips/buttons/selects | P2 | DONE — global :focus-visible outline (brand, 2px offset) |
| 7 | All | Motion not gated for vestibular users | P3 | DONE — prefers-reduced-motion kill switch |
| 8 | Slate | Day-of-week repeats on every card; no day section grouping | P2 | DEFERRED — grouping headers interact with week-count e2e locks; slate view refactor scheduled Rel11.1 |
| 9 | Team (phone) | Idle draft card pushes roster below the fold | P2 | DEFERRED — collapsed idle state must not break ds-start locks; Rel11.1 |
| 10 | Model | Card order: calibration sits below locks; intro line missing | P3 | DEFERRED — Rel11.1 |
| 11 | Parlays | Leg rows readable but per-card ESTIMATE repetition heavy | P3 | DEFERRED — shared legend treatment with #2 follow-up |

## REL11.1 addendum (2026-07-18, user-reported)

The REL11 phone pass covered slate/players deeply but audited TEAM primarily at
iPad width (its declared target form factor) — the finder's phone rendering
slipped through. Root cause recorded so the split-audit gap doesn't recur:
every future audit sweeps EVERY page at BOTH widths, plus an automated
clipped-text scan (scrollWidth > clientWidth) per tab.

| # | Page | Finding | Priority | Status |
|---|------|---------|----------|--------|
| 12 | Team (phone) | Finder rows crammed name/meta/pts/TAKE/ADD into one line — names clipped to ~10 chars ("Christian Mc...") while roster slots above breathe | P1 | DONE — under 720px rows stack: name+pts line, meta+actions line; best-pick rows same. AC: .cd-name untruncated at 402px, ADD below name; e2e-locked |
| 13 | Parlays | Leg names ellipsized under the odds cluster ("J. Smith-Njigba 60+ rec yd...") — primary content lost | P1 | DONE — leg names wrap to a second line at phone width. AC: zero clipped .leg-nm at 402px; e2e-locked |
| 14 | All | No automated guard against horizontal page overflow | P2 | DONE — per-tab overflow sweep lock at 402px (all five routes) |

Sweep result after fixes: zero clipped text on players/parlays/team/model; the
only remaining ellipsis is the slate venue name (#3's intentional design —
tertiary info truncates so kickoff time never wraps).

## REL11.2 addendum (2026-07-19, user-directed)

Owner rule: every Team-page player list shares the roster-slot rhythm, and the
bye week is listed on every player row.

| # | Page | Finding | Priority | Status |
|---|------|---------|----------|--------|
| 15 | Team | Player lists (finder, best-pick, reco) each had their own density/typography - finder was mono 12px on a different surface than the slot cards | P1 | DONE - one rhythm: slot-card surface + padding, 14px bold sans names, 8px gaps, stacked two-line rows at ALL widths (the single-line iPad grid clipped the bye). AC: cand bg == slot bg, 14px/700 names; e2e-locked |
| 16 | Team | Bye week not visible on finder/best-pick/reco rows (only on filled slots or via BYE sort) | P1 | DONE - "BYE W#" on every player row in all three lists. AC: every finder row meta matches /BYE W\d+/; e2e-locked |
