# Week-6 weather row hardening — 2026-10-18

Isolated follow-up to `9b7c4689`. Local review checkpoint only; no merge,
deployment, generated-data edits, outcome refit, adoption or new coefficient.

## Confirmed defects and fixes

1. A parseable 401-digit integer in a single hourly wind value raised
   `OverflowError` in `math.isfinite`, aborting healthy homes too. Physical
   range checks now precede floating conversion. The history parser uses the
   same guarded numeric contract; unknown rain remains `None`.
2. A 600-deep malformed game-window value was correctly refused by the live
   contract but crashed `build_factors` during its preceding `deepcopy`.
   Forecast snapshots are now detached through explicit depth/node/row limits.
   A bad row remains present with an invalid marker, so it is refused locally
   and cannot silently fall through to climatology. Invalid root metadata
   holds the document; a snapshot never upgrades a legacy/unknown contract.
   Pure valid legacy inputs, including a multi-season 893-row map, retain
   their values. The registered live contract still allows at most 512 rows.
3. The nullable history rain contract reached `float(None)` in `load_corpus`
   before downstream exclusion guards. Joined observations with any unknown or
   malformed weather field are now excluded before condition counts, treatment
   and matched-control assembly. Their keys/fields remain in `unknown_weather`.
   `rows_joined` still counts actual metadata joins. The public report includes
   `rows_unknown_weather` when positive, with the explicit no-dry-imputation
   policy. Its optional schema field preserves older known-only artifacts.

Auditable denominator: `rows_read - rows_unjoined = rows_joined`, then
`rows_joined - rows_unknown_weather - dropped_relocations = rows_kept`.
An absent legacy `rows_unknown_weather` means zero. Genuine measured zero rain
is retained. No archived weather row is rewritten.

## Acceptance evidence

`node --test tests/feature/week6_weather_row_hardening.test.mjs
tests/feature/week6_weather_binding.test.mjs tests/feature/r56_weather.test.mjs
tests/feature/r94_weather.test.mjs` — exit 0; 29 Node tests, no failures/skips.
The two Python fixture wrappers separately run 11 new adversarial cases and
22 original binding cases. Existing R56/R94 tests retain historical equality,
source immutability, multipliers, no-adoption and schema acceptance checks.

The three new regression cases were also executed with the four production
modules loaded directly from `git show 9b7c4689:scripts/<module>.py`, without
editing the app/data. All three failed on the old code as expected:

| Regression | Old error |
|---|---|
| `test_huge_wind_holds_only_bad_game_not_other_home` | `OverflowError` |
| `test_deep_bad_row_is_withheld_before_detached_weekly_snapshot` | `RecursionError` |
| `test_unknown_rain_is_explicitly_excluded_not_dry_or_unjoined` | `TypeError` |

`git diff --check` and focused Python compilation — exit 0.

## Boundaries and remaining work

The actual fresh-schedule `wind_current` call hook is owned by the Sunday
integration lane and is not modified here. `build_weekly.py` changed and its
source fingerprint must be refreshed by that lane before its source freeze.
No forecast is authenticated provider-publication evidence, no roof state is
inferred open, and no empirical accuracy improvement is claimed by these
input-reliability fixes. No full gate or browser suite was run in this lane.
