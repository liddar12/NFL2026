# FINAL participation candidate profile — revision 1

October 16, 2026, 2:32 a.m. America/Chicago (CDT). Local source/mechanics only;
not activated.

This extends the existing architecture without changing scrapers, workflows,
generated data, player projections, eligibility, models or the live site.
S017-T2/T3 empirical acceptance is **not** established by this implementation.

## What is implemented

- `scripts/capture_final_participation.py`: immutable exact-byte one-game capture
  with a caller-injected transport, verification and explicit local save/load.
- `scripts/shadow_participation_guard.py`: pure diagnostic comparison against
  existing verified raw outcome-history captures and a pinned decision context.
- `tests/feature/week6_final_participation.test.mjs`: synthetic candidate-body
  fixtures and actual parser/persistence/guard calls, not retained provider wire.
- `tests/feature/week6_final_participation_adversarial.test.mjs`: independent
  identity-local quarantine, source-reference injection, exact cutoff, raw JSON
  ambiguity and resealed authority-claim checks.

Every main decision is `held_unknown`, `shadow_signal: null`, `weight: 0`.
Even an explicit DNP diagnostic cannot prove this was the true previous completed
applicable game, establish medical status, or authorize next-game withholding.
No authenticated owner decision, learning acceptance, adoption or activation is
implemented here.

## Provider profile status and fixed endpoints

`profile_status = repository_inferred_unverified` and
`source_authority_authenticated = false` are immutable metadata. The repository's
existing `scripts/scrape/espn.py` uses a core competition document, competitor
`team.$ref` and `roster.$ref`, and roster `entries[].playerId/didNotPlay`.
No genuine raw paginated FINAL core-roster response is retained locally.

Therefore **there is no HTTP transport and no `--fetch` option**. The following
core URL/body shapes are a strict candidate profile, not a claim that a provider
response has been sampled, documented independently or will satisfy the profile.
Missing/unsupported page fields fail closed. Before enabling any real fetch,
retain and review genuine endpoint/body/pagination evidence and add parity tests.

Code constructs only these source URLs; JSON references never authorize a fetch:

| Profile | Code-owned HTTPS endpoint |
| --- | --- |
| `espn_scoreboard_v1` | Existing ESPN NFL scoreboard with exact `dates`, regular-season `seasontype=2`, and `week` |
| `espn_core_competition_candidate_v1` | `sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{game}/competitions/{game}` |
| `espn_core_team_candidate_v1` | Same fixed core origin/path prefix, `teams/{team_id}` |
| `espn_core_game_roster_candidate_v1` | Same fixed core prefix, `events/{game}/competitions/{game}/competitors/{team_id}/roster?limit=100&page={page}` |

IDs are canonical positive decimal ESPN IDs, at most 15 digits. No name matching,
GSIS conversion, supplied URL following, arbitrary host, redirect or credentials
are implemented. References must match the expected fixed path; only the
optional fixed `lang=en` / `region=us` reference-query values are recognized.
The callback receives freshly created, code-owned scalar source specifications.
It is explicitly trusted application code and can perform caller-owned I/O; the
capture module cannot authenticate where an injected callback obtained bytes.

## Exact capture contract

`capture(season, week, game_id, *, fetcher, clock=...)` receives callbacks returning
`(200, headers_ignored, raw_bytes)`. No retry silently changes a capture vintage.

The returned graph has exactly `{manifest, observations, raw_objects}`.

- `raw_objects[sha256]`: original bytes, never normalized provider content.
- Each immutable observation contains `version`, `kind`, exact `spec`,
  `raw_sha256`, `raw_bytes`, `fetch_started_utc`, `observed_utc`,
  `provider_issued_utc: null`, `source_authority_authenticated: false`, and its
  canonical `observation_id` hash.
- The manifest contains `version`, `kind`, `season`, `week`, `game_id`,
  `started_utc`, `completed_utc`, ordered observation IDs in `sources`, derived
  `audit`, fixed profile/authentication/coverage labels, and canonical `capture_id`.
- The audit reports row and malformed/duplicate counts plus quarantined player
  IDs/teams. `page_inventory` means only
  `declared_pages_checked_not_provider_completeness`.

`verify_capture(bundle)` recomputes specs, clocks, bytes/hashes, source closure,
pagination, identities and audit. `save_capture(bundle, out_dir)` writes immutable
`objects/{hash}.bin`, `observations/{hash}.json`, then `captures/{hash}.json` last.
`load_capture(manifest_path)` reads and verifies that exact graph; neither load nor
an exact save retry observes/refetches/restamps it. Output roots overlapping
repository `data/`, or redirected through user-selected symlinks, are refused.

Bounds: scoreboard body 4 MiB; each core body 1 MiB; eight pages / 800 rows per
team; 100 rows per page; 64 MiB summed source-reference bytes per capture. JSON
and metadata have separate depth/node/string bounds. Failed or unsupported
captures do not produce a completed successful manifest. Partial saved immutable
objects after a filesystem failure are not a completed capture or a learning ACK.

## Evidence meaning

The scoreboard is observed first. Existing strict normalization must identify the
exact season/week/regular-season game, two canonical teams and explicit
`STATUS_FINAL` / `STATUS_FINAL_OVERTIME` with valid integer final scores. Core
competition/team references must agree. Contradictory provided period/status
metadata is refused. All declared roster pages and row counts must agree.

`explicit_dnp(bundle, bare_espn_id, canonical_team)` returns direct negative
diagnostic evidence only for exactly one unquarantined row whose raw
`didNotPlay` is the **boolean `true`**. Numeric/string truthiness is not accepted.
Duplicate IDs across pages or teams quarantine that identity; an unlocatable
malformed row quarantines its team. An independent well-identified neighbor can
still retain its diagnostic evidence.

A false or absent flag, a missing player, an empty roster, partial pages, zero
offensive snaps, a missing box-score row and generic `Active` are never `played`
or medical clearance. No normalized roster membership is described as a complete
participation inventory. `provider_coverage` remains `unknown`.

Local `fetch_started_utc` / `observed_utc` record the callback boundary. They are
not provider issue timestamps, actual game-finish timestamps or proof of upstream
freshness. Missing `provider_issued_utc` and `game_finish_utc` remain null.

## Shadow guard boundary

`evaluate(outcome_history, final_roster_captures, decision_context, *, clearance=None)`
uses an existing verified raw outcome-capture graph. The exact context fields are
`version`, `kind`, `season`, `week`, bare `espn_id`, `team`, `decision_utc`,
`target_game_id`, `kickoff_utc`, and canonical `context_id`. Context pins are
caller-supplied integrity claims, not authenticated calendar/roster authority.

The target scheduled game, team, week and kickoff must match supplied raw history,
be known by the decision cutoff, and begin after that cutoff. The tool selects
the latest **known** FINAL for the same team with an earlier kickoff and FINAL
observation no later than the cutoff. It does not search older games for a DNP
when the newer known FINAL has no roster capture. Its matching roster capture
must be complete locally by the cutoff and agree on game/season/week/teams/kickoff.
At most 18 roster captures and 64 MiB total raw objects across all supplied
history/captures are processed.

The result can expose `direct_dnp_observed: true` and exact observation IDs/clocks,
but main `shadow_signal` remains null because actual prior-game inventory and
applicability are not independently established. Missing, ambiguous, wrong-team,
future, live or unsupported evidence stays held/unknown. This is not a complete
frozen eligibility replay and cannot measure false-positive withholding yet.

`clearance` is deliberately unsupported: client `verified`, `Active`, narrative,
practice participation or claimed `cleared_to_play` cannot clear or authorize a
guard. A future genuine structured primary clearance profile needs independently
reviewed semantics, exact identity/game scope, newer provider issue/version
authority and raw evidence before any corresponding policy can be added.

## Operator experience and remaining gates

```sh
python3 scripts/capture_final_participation.py --season 2026 --week 5 --game-id 401872994
```

This prints only a dry-run plan. It reads no environment credential, performs no
network call and writes no output. Saving/fetching is not exposed by this CLI.
Python callers may explicitly provide fixture/application callbacks and local
output paths; this is not scheduled or wired into production.

Still required: genuine FINAL roster/pagination captures; applicable complete
prior-game/roster history and exact crosswalks where needed; primary clearance
authority; frozen pre-decision population replay with independent subsequent
participation labels; false-positive and unknown-coverage reporting; independent
review and owner authorization before any serving integration. None is replaced
by these mechanics tests or Git timestamps.

## Local verification

Root focused rerun: 14 tests passed, none skipped, exit 0. Runtime sources were
unchanged during the run: capture SHA-256 `d448eeb18bb20ed5f1e1d82176b4d59aff3af291e2a44845203d557f0e289f81`;
guard `8c8c41baf2363252902f87a8910a403f0f7f146595a508e5412dd7629c3c07c2`.
The author test's executable-line trace exceeded 96% for capture and covered
100% of guard lines. These measurements are not branch coverage, genuine wire
profile verification, frozen historical replay or browser/release acceptance.

Log: `/private/tmp/nfl-final-participation14-root-20261016.log`. Neither new
module is called by an existing scraper, producer or scheduled workflow.
