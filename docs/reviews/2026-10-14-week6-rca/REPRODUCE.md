# Evidence and reproduction

Revision 1 — October 14, 2026, 2:10 p.m. CDT (America/Chicago).

All NFL calculations use `fb8830ae35f1e11d3f589b435e303b719886e3e7`. The owner's original checkout was on `audit/v00-reconcile-current-main` at `d217cfe9`, 185 commits behind this fetched main. It was not updated or cleaned. The isolated audited worktree was `/private/tmp/nfl2026-week6-rca.XeN3HY`.

The report is saved in the original checkout's `docs/reviews/2026-10-14-week6-rca/` so it is accessible to the owner and another local coding session. It is not committed or pushed. Source locations in the report refer to the pinned newer tree, not the older working branch.

## Contents

| File | What it establishes |
|---|---|
| `evidence/metrics.json` | Current review counts, original archive metadata, MY clean-contract comparisons and concentration |
| `evidence/provenance.json` | Every inspected archived card's earliest Git combination/price-vector occurrence; fixed pre-first-game and pre-Sunday snapshots, including whether already started |
| `evidence/learning.json` | Actual base/served/double-calibration chain, adoption history, reporting chronology and fixed-leg coefficient counterfactual |
| `evidence/portfolio.json` | Exact shared-game outcome enumeration for the saved Week 5 and Week 6 18-card sets |
| `evidence/injuries_2026-10-14.json` | Frozen public-source status comparison at approximately 1:54 p.m. CDT, joined by canonical ID |
| `evidence/live_hashes.json` | Nine live Netlify asset HTTP/hash comparisons at 2:02:17 p.m. CDT |
| `evidence/verification.json` | CI and local checks observed during the audit; scope and limitations |
| `evidence/CLAUDE_PEER_REVIEW.md` | Final reconciled read-only Claude Code review, with two remaining wording corrections explicitly noted |
| `evidence/manifest.json` | SHA-256 and byte sizes of package files other than the manifest itself |
| `diagnostics/` | Read-only repository analysis scripts; only metrics/provenance write generated outputs inside this review package |

No credentials, private environment variables or raw CLI authentication output are included. Player status evidence is from the public ESPN response. The package contains generated recommendation records, not actual sportsbook tickets.

## Reproduce on an isolated baseline

Use Python 3.12 (the audit used 3.12.9), Node with built-in `fetch`, Git with full repository history, and access to the private repository if required. Python calculations use the standard library and import the pinned repository's own graders/builders without invoking their pipelines.

```bash
bundle_dir="/Users/jliddar/code/NFL2026/docs/reviews/2026-10-14-week6-rca"
audit_checkout=$(mktemp -d /tmp/nfl2026-week6-replay.XXXXXX)
git -C /Users/jliddar/code/NFL2026 worktree add --detach "$audit_checkout" fb8830ae35f1e11d3f589b435e303b719886e3e7
PYTHONDONTWRITEBYTECODE=1 python3 "$bundle_dir/diagnostics/audit_metrics.py" "$audit_checkout"
PYTHONDONTWRITEBYTECODE=1 python3 "$bundle_dir/diagnostics/audit_provenance.py" "$audit_checkout"
PYTHONDONTWRITEBYTECODE=1 python3 "$bundle_dir/diagnostics/audit_learning.py" "$audit_checkout"
PYTHONDONTWRITEBYTECODE=1 python3 "$bundle_dir/diagnostics/audit_portfolio.py" "$audit_checkout"
node "$bundle_dir/diagnostics/audit_live.mjs" "$audit_checkout"
node "$bundle_dir/diagnostics/audit_injuries.mjs" "$audit_checkout"
python3 "$bundle_dir/diagnostics/validate_evidence.py"
```

The Python model/provenance scripts assert the pinned HEAD. Inspect tracked modifications as well if reusing a worktree. Metrics/provenance regenerate their JSON in this package; the other scripts print JSON to stdout. The live and injury checks perform public GETs only. They are new observations, not expected to reproduce frozen October 14 values after the source/deployment changes. Do not overwrite frozen evidence and then present it as the earlier capture.

The manifest validates the delivered package; intentionally regenerating or editing a file can change its hash. `validate_evidence.py` independently checks headline arithmetic, cohort eligibility, known probability-chain values and evidence file hashes. It does not establish causal model skill or replace the NFL regression suite.

## Important method boundaries

- Full Git history was searched for matching scope/game/selection identity and exact archived leg model/implied-price vectors. Commit timestamps establish repository availability, not a user receipt or hosting publication time.
- Fixed cohorts are the last committed Week slate before the week's first kickoff. Pre-Sunday alternatives are included in JSON but often contain already-started games; they must not be relabeled entirely fresh offers.
- Game winners and recorded prop outcomes are those in the pinned review/score artifacts. This is not an independent play-by-play regrading of every player statistic.
- Owner exclusions are evaluated separately from original winners. A reduced-leg settlement is legitimate but not the original binary all-hit contract.
- MY metrics exclude every void/pending card for the clean comparison. This is a conditional sample and many cards share legs/games. Thousands of cards do not imply thousands of independent observations.
- The portfolio calculation assumes different game outcomes are independent and uses saved model probabilities; repeated selections share one outcome. Its probabilities are conditional model diagnostics, not calibrated truth.
- Learning code imports run pure analysis helpers. The reconstructed slate comparison keeps offered legs/features fixed; it does not rerun entire historical candidate selection.
- Public Netlify hashes verify only the listed assets at the stated time. The separate custom hostname was not verified by that check.
- The SelfLearning repository was inspected for integration and roadmap status; its existing local changes were not altered. No cloud database or deployed engine health audit is implied.

## Independent verification sources

- [Audited source tree](https://github.com/liddar12/NFL2026/tree/fb8830ae35f1e11d3f589b435e303b719886e3e7)
- [Data regression CI, 38586365537](https://github.com/liddar12/NFL2026/actions/runs/38586365537)
- [Latest audited producer, 38585561479](https://github.com/liddar12/NFL2026/actions/runs/38585561479)
- [First failed injury refresh, 38180920617](https://github.com/liddar12/NFL2026/actions/runs/38180920617)
- [Weekly backtest, 38417084908](https://github.com/liddar12/NFL2026/actions/runs/38417084908)
- [Public injury source](https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries)

No release was performed by this RCA. A future implementer must inspect then-current main, reconcile concurrent work, and obtain/act within the implementation and deployment scope of that task.
