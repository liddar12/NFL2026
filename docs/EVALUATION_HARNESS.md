# NFL2026 — Evaluation Harness

The harness is the product. Its job is to answer, honestly and repeatably, *is this model
better on data it could not have seen?* Everything here is implemented under
`scripts/harness/` (snapshots, metrics, honesty, conformal) and gated by
`scripts/optimize/never_regress.py`.

## Snapshots (point-in-time, from day zero)

Every prediction is **locked before its event** and archived to `data/snapshots/`. A snapshot
row:

```json
{
  "event_id": "2026_01_KC_BAL",
  "event_type": "game",          // "game" | "player_week"
  "model": "hybrid",
  "locked_utc": "2026-09-10T00:00:00Z",
  "as_of_utc": "2026-09-10T00:00:00Z",  // the info horizon: nothing after this was used
  "probs": [0.58, 0.42],          // game: outcome vector; OR "point"+"interval" for player_week
  "estimate": false,
  "resolved": true,
  "actual": 0,                    // resolved outcome index (or measured points)
  "brier": 0.1764,
  "log_loss": 0.5447
}
```

`snapshot.py` writes and loads these; the schema is `data/contracts/snapshot.schema.json`.
The `as_of_utc` field is the leak horizon — it is the contract that no post-kickoff information
entered the prediction.

## Metrics

Implemented in `scripts/harness/metrics.py` (stdlib only). The Node feature tests
re-implement the identical tiny formulas and lock constants — they do NOT import Python, so
the formulas are chosen to be trivial to mirror.

| Metric | Fn | Use |
|---|---|---|
| Log-loss | `log_loss(y_true_idx, probs)` | **primary objective** for game outcomes. |
| Brier | `brier(y_true_idx, probs)` | proper score, reported alongside. |
| Multiclass log-loss | `multiclass_log_loss(...)` | >2-outcome events. |
| MAE | `mae(pred, actual)` | **primary objective** for player points. |
| Rank correlation | `rank_corr(pred, actual)` | Spearman; player ranking quality. |
| Calibration | `calibration_bins(probs, outcomes, n_bins=10)` | reliability curve. |

Accuracy (hit-rate) is **reported alongside, never optimized** — optimizing accuracy rewards
overconfident point-picks; log-loss / Brier reward honest probabilities.

## Estimate vs measured (the honesty invariant)

`scripts/harness/honesty.py` enforces, and a Node test locks:

- If `estimate == false` and `resolved == true` → `brier` and `log_loss` **must be present**.
- If `estimate == true` → `brier` and `log_loss` **must be absent/null**.

An estimate is a projection for an event that has not happened (or is not yet measured). A
measurement is a locked prediction scored against a resolved outcome. The two can never blur:
the UI is structurally prevented from presenting an estimate as if it were measured.

## Baseline gates

Every complexity increment must beat a **simpler baseline** on held-out log-loss or it is cut:

- Game models must beat **Elo** and the **market**.
- Player projections must beat the **prior-perf + age-curve baseline**.

If a fancy model cannot beat the market on held-out log-loss, the market is the model. No
credit for sophistication that does not measure better.

## Walk-forward, leak-safe evaluation

- Predictions are made in time order; each event is scored using only data with timestamp
  `<= as_of_utc` (its own kickoff horizon). No future rows, no full-season refits peeking ahead.
- **The validation unit is the event** (a single game or a single player-week), never the
  season. Season-level aggregates are for reporting, not for the adoption decision.
- **Shrinkage** toward the current weights regularizes small samples so early-season noise
  cannot swing weights wildly.

## Conformal layer

`scripts/harness/conformal.py` builds **split-conformal safe sets** at 85% and 70% coverage on
a held-out calibration split. The user sees a *set of plausible outcomes* with a coverage
guarantee — not a false point estimate. `conformal.test.mjs` asserts empirical coverage meets
the target on a fixed set.

## NEVER REGRESS

The adoption gate (`scripts/optimize/never_regress.py`):

```python
def should_adopt(current_loss, candidate_loss, margin=0.0015) -> bool:
    return candidate_loss < current_loss - margin
```

New parameters replace current ones **only** if they beat current on the same leak-safe set by
at least the margin. Otherwise current is kept. New signals enter at weight 0 and earn weight
only through the fit. The margin is a floor against noise-chasing; `never_regress.test.mjs`
locks the exact rule, and `data/model_tuning.json` ships an example where a tuned candidate is
**not** adopted because it failed to clear the margin. **Never lower the margin to force an
adoption** — that is the one move that quietly destroys the harness's credibility.
