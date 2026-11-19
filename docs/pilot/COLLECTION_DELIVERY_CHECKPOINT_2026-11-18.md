# Disabled collection delivery checkpoint

November 18, 2026, 4:45 p.m. CST (America/Chicago). Codex owns this checkpoint.
Local source only: no GitHub push, hosted write, migration, deployment or activation.

## Scope

The standalone NFL clients now target reviewed engine
`5e68953989b95731503d9e909ede7d4279b2a570`. The config remains `enabled: false`,
`serving_mode: shadow`. No daily/gameday workflow or app path invokes these clients.
The only modified workflow is the existing read-only test canary's exact engine pin.

- Forecast preparation freezes a generation in an explicit private workspace;
  delivery retains an outbox and validated acknowledgments. Replaying delivery
  does not rebuild from today's mutable pool or change its first observation time.
- Publication registration requires a publisher receipt bound to its run and
  attempt, and the frozen pool must match the exact published Git commit.
  Fallback mismatches are refused. No-op/unchanged publication can read an existing
  registration but cannot create fresh publication evidence. The independent
  worker's actual public HTTP observation remains the publication authority.
- Outcome exporters support the current ordered capture plan, including optional
  roster evidence. Roster-bearing facts must retain its original provenance.
  Did-not-play inference also requires independent game/snap evidence. Incomplete
  or mismatched facts remain withheld; they are not converted to losses.
- Historical engine `889e147e` is readable only with its independently measured
  code fingerprint. Current execution refuses the old pin before import. This
  compatibility does not upgrade old evidence or authorize an old engine to run.
- The production-reference guard includes the new standalone clients and forbids
  new callers in its checked app/scripts/workflow paths. It is a bounded static
  check, not a general proof of runtime non-reachability.

## Acceptance performed locally

All results below exited 0. Tests use synthetic clocks, local fixtures and local
adapters unless explicitly described otherwise; none establishes hosted operation.

| Check | Result |
| --- | --- |
| Seven focused pin, history, capture, canary and availability suites | 71 passed, zero skips |
| Outcome v1/v2 exporter suites with actual pinned engine | 31 passed |
| Pinned engine delivery/application/label tests using current NFL checkout | 64 passed |
| Publication queue contract tests | 18 passed |
| Actual local ASGI/SQLite intake and publication integration | 10 passed |
| Current pool intake through the local application | 1,008/1,008 receipts accepted; four source-object ACKs and one generation ACK |
| Repeated delivery of that same generation | Zero transport calls; 1,008 original publication-plan members retained |

The current-pool rehearsal used a temporary private workspace and an in-memory
hosted boundary. It is not an independently observed public-serving cohort.
The test suite was rerun after extending the explicit standalone-tool allowlist;
the initial pin run's guard failure remains visible in its retained log.

Reproduce the publication checks from this checkout with an environment containing
the engine's test dependencies:

```sh
python3 tests/pilot_queue_publication.py --nfl-checkout . --engine-checkout ../SelfLearning-qualified-jobs-20261118
python3 tests/pilot_hosted_publication.py --nfl-checkout . --engine-checkout ../SelfLearning-qualified-jobs-20261118
```

Run the outcome feature files with `SELFLEARNING_CHECKOUT` pointing to that engine;
the file-feedback suites use `SELFLEARN_CHECKOUT`. These deliberately explicit
inputs must not silently resolve a different editable Python package.

## Remaining release work

1. Reconcile the separately tested current-main NFL grading/publication repair.
   Preserve all newly offered cards. Complete the full gate and exact-source CI.
2. Publish a reachable, paired engine/NFL source version. Verify hosted migrations,
   scoped intake/worker access and private durable storage. Retaining only an
   expiring GitHub Actions artifact is insufficient for the original journal/outbox.
3. Wire forecast delivery and publication handoff to the successful publisher,
   then schedule the independent worker and final-outcome capture/application.
   Exercise real interruption, duplicate and correction recovery after restart.
4. Assemble evaluation inputs from authoritative journal/publication records.
   Do not silently truncate a cohort to the generic job's size limits. Preserve
   exclusions and first-publication times. MY yardage support does not establish
   moneyline, anytime-TD or Game/Week joint-probability support.
5. Evaluate a frozen candidate on untouched periods using trustworthy labels,
   clustered uncertainty, position checks and fallback tests. An adopted correction
   must be traceable in served probabilities before claiming it is in use.

Cloud rollout and the first scoped correction activation remain separate owner
decisions after concrete acceptance evidence. Henry can monitor delivery and
freshness once his service connections are verified; he does not bypass the
evaluation rule. No new betting-accuracy improvement is claimed here.
