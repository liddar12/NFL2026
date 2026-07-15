# NFL2026 — Platform Thesis

**Evaluation harness first, models second.** The thing being built is not an NFL model. It is
a domain-agnostic prediction platform whose durable value is an honest, leak-safe evaluation
harness. NFL is the first adapter because it has rich public data, a fast weekly feedback loop,
and liquid markets to benchmark against. The next adapter (another sport, an election, a
commodity) reuses the same core untouched.

## Why the harness is the product

Anyone can fit a model. The hard, rare, compounding asset is a discipline that answers, every
week, without self-deception: *is this actually better, on data it could not have seen?* Models
come and go; the harness is what makes their comparison trustworthy. If the harness is honest,
a mediocre model is safe (it will be measured and cut). If the harness is dishonest, a brilliant
model is dangerous (its leakage looks like skill). So we invest in the harness first and let
models plug in behind a gate.

## The generalizable core, ranked (most to least reusable)

1. **Point-in-time snapshot store.** Every prediction is locked before the event with an
   `as_of` timestamp. This is the foundation of every honesty guarantee. 100% domain-agnostic.
2. **Estimate-vs-measured accounting.** Every row is either a flagged `estimate` or a measured
   result carrying `brier` + `log_loss`. No row can silently drift between the two. 100% reusable.
3. **Walk-forward, leak-safe evaluation.** Each event scored using only information available
   as-of its own kickoff. The validation unit is the event, never the season. 100% reusable.
4. **NEVER-REGRESS adoption gate.** New parameters replace current ones only if they beat them
   on held-out log-loss by a fixed margin (0.0015). Pure, unit-testable, domain-agnostic.
5. **Baseline gates.** Every complexity increment must beat a simpler baseline (Elo, or the
   market) or it is cut. Reusable given a domain baseline.
6. **Conformal uncertainty layer.** Split-conformal "safe sets" turn point predictions into
   honest plausible-outcome sets at 85% / 70% coverage. Reusable given a nonconformity score.
7. **Signal registry + optimizer.** A named-signal registry where everything **enters at
   weight 0** and earns weight only via the walk-forward fit. Reusable; the signal *definitions*
   are the domain-specific part.
8. **Model plug-ins** (J5L composite, market, hybrid, stacker). Least reusable — but they sit
   behind the gate, so a bad one cannot corrupt the record.

Reusability decreases as you go down the list; investment priority follows it. Everything
above the line (1–6) ships before any NFL-specific cleverness.

## NFL as the first adapter

The NFL adapter provides: the `gsis_id` / team-abbrev canonical keys, the ESPN↔nflverse
`RENAMES` map, the position-specific age curves and matchup signals, and the market feeds
(Odds API / Kalshi / Polymarket). Swapping adapters means swapping the signal definitions and
the data scrapers — the harness, the honesty rules, the never-regress gate, and the conformal
layer are carried over verbatim.

## The two surfaces are downstream

Player analytics and weekly winners/parlays are *views* on top of the harness's snapshots and
the gated models. They are deliberately downstream: the platform is correct even before either
surface has a finished visual design (which is Gate 2's job). Getting the harness honest is
prior to making anything pretty.
