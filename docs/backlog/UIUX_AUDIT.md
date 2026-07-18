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
