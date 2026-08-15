# Vendored skills — emilkowalski/skills

Source: https://github.com/emilkowalski/skills
Vendored at upstream commit `78761e1` (2026-08-10), on 2026-08-14, at the
owner's request: *"Install the skills here, specifically apple ... use always."*

## Why these are COMMITTED and not installed globally

This project is developed from ephemeral cloud containers. `~/.claude/skills/`
does not survive a container restart — and this session has already lost its
working tree twice. A skill that has to be re-fetched by hand before every
session is a skill that will silently stop being used.

Committing them to the repo makes them part of the project the same way
`CLAUDE.md` is: whatever machine the repo is cloned onto, the skills are there.

## What is here, and what actually applies to THIS app

NFL2026 is a **vanilla-JS, no-build PWA** — no React, no bundler, no component
library. That rules several of these out, and it is worth saying so rather than
leaving a future reader to discover it:

| skill | applies here? |
|---|---|
| `apple-design` | **YES — the one requested.** Apple's fluid-interface design translated to CSS / Pointer Events / rAF. Directly usable. |
| `animate` | yes — motion craft, framework-agnostic principles |
| `animation-vocabulary` | yes — shared language for describing motion |
| `improve-animations` | yes |
| `review-animations` | yes |
| `find-animation-opportunities` | yes |
| `emil-design-eng` | mostly — general design-engineering judgement |
| `prototype` | partly — assumes a faster scaffold than this repo has |
| `pick-ui-library` | **no** — this app deliberately has no UI library |
| `ask-sonner` | **no** — Sonner is a React toast library |

The animation skills lean on spring libraries (Motion / Framer Motion). Those
are npm React packages and MUST NOT be added here — the no-build rule is not
negotiable. Take the physics and the principles; implement them in CSS
transitions, Web Animations, or hand-rolled rAF springs.

## Updating

    git clone --depth 1 https://github.com/emilkowalski/skills.git
    cp -r skills/skills/* <repo>/.claude/skills/

Record the new upstream commit in this file when you do.
