#!/usr/bin/env bash
# smoke.sh — cheap, fast structural checks. Second step of the regression gate.
#
# Confirms: the key files exist, every data/*.json parses, and a handful of core
# invariants hold. Stdlib only (python3 for JSON parsing/asserts; no jq, no npm).
# Fails loudly and immediately on the first problem.
set -euo pipefail

# Resolve repo root from this script's location so cwd doesn't matter.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

echo "smoke: checking key files exist"
required_files=(
  "package.json"
  "scripts/validate_data.py"
  "data/meta.json"
  "data/player_projections.json"
  "data/game_predictions.json"
  "data/parlays.json"
  "data/pipeline_status.json"
  "data/model_tuning.json"
  "data/fixtures/teams.json"
  "data/fixtures/players_sample.json"
  "data/fixtures/games_sample.json"
  "data/snapshots/.gitkeep"
  "data/fixtures/backtest_weekly/weekly_actuals.json"
  "data/fixtures/backtest_weekly/games_meta.json"
)
for f in "${required_files[@]}"; do
  [ -f "$f" ] || fail "missing required file: $f"
done

echo "smoke: pipeline math selftests (fixture-driven, never write data/)"
python3 scripts/build_epa_history.py --selftest || fail "epa_history selftest"
python3 -m scripts.promote_signals --selftest || fail "promote_signals selftest"
python3 scripts/build_weather_history.py --selftest || fail "weather selftest"
python3 scripts/build_weather_forecast.py --selftest || fail "weather forecast selftest"
python3 scripts/build_market_baseline.py --selftest || fail "baseline selftest"
python3 scripts/build_injury_history.py --selftest || fail "injury selftest"
python3 scripts/availability.py --selftest || fail "availability selftest"
python3 scripts/injury_duration.py --selftest || fail "injury duration selftest"
python3 scripts/build_weekly.py --selftest || fail "weekly split selftest"
python3 scripts/validate_data.py --selftest || fail "availability invariant selftest"
python3 scripts/build_player_usage.py --selftest || fail "usage selftest"
python3 scripts/build_player_usage_history.py --selftest || fail "usage history selftest"
python3 scripts/build_player_usage_weekly.py --selftest || fail "usage weekly selftest"
python3 scripts/build_preseason.py --selftest || fail "preseason selftest"
python3 scripts/backtest_player.py --selftest || fail "player backtest selftest"
python3 scripts/build_backtest_corpus.py --selftest || fail "backtest corpus selftest"
python3 scripts/build_game_context.py --selftest || fail "game context selftest"
python3 scripts/build_dvp_positional.py --selftest || fail "dvp positional selftest"
python3 scripts/build_scheme_history.py --selftest || fail "scheme history selftest"
python3 scripts/build_kdst.py --selftest || fail "kdst projection selftest"
# R49 — the learning ledger + the display-only Sleeper builder (pure cores).
python3 scripts/build_sleeper_projections.py --selftest || fail "sleeper projections selftest"
python3 scripts/build_estimate_ledger.py --selftest || fail "estimate ledger selftest"
python3 scripts/resolve_estimates.py --selftest || fail "resolve estimates selftest"
# R58 — the parlay-leg ledger and its resolver (pure cores).
python3 scripts/build_parlay_ledger.py --selftest || fail "parlay ledger selftest"
python3 scripts/resolve_parlay_legs.py --selftest || fail "resolve parlay legs selftest"
# R87 — the same discipline applied to the cards MY PARLAYS offers: the record
# (first-sight lock, idempotent per pool) and its resolver (pure cores).
python3 scripts/build_my_cards.py --selftest || fail "my cards record selftest"
python3 scripts/resolve_my_cards.py --selftest || fail "resolve my cards selftest"
python3 scripts/fit_player_signals.py --selftest || fail "player signal fit selftest"
# R51 — weekly split v2 + parlay repricing: the two never-regress backtests and
# the runner-side corpus refresher (pure cores, offline).
python3 scripts/backtest_weekly.py --selftest || fail "weekly backtest selftest"
# R70 — the line report and the measure-only line-injury cascade backtest.
python3 scripts/build_line_report.py --selftest || fail "line report selftest"
python3 scripts/backtest_lines.py --selftest || fail "lines backtest selftest"
# R92 — the measure-only backup-QB cascade backtest (player side).
python3 scripts/backtest_backup_qb.py --selftest || fail "backup qb backtest selftest"
# R71 — the post-game review builder and its optional narrative layer.
python3 scripts/build_review.py --selftest || fail "post-game review selftest"
python3 scripts/build_review_narrative.py --selftest || fail "review narrative selftest"
# R73 — the per-week parlay archive + index.
python3 scripts/build_parlay_archive.py --selftest || fail "parlay archive selftest"
python3 scripts/backtest_parlay.py --selftest || fail "parlay backtest selftest"
# R76 — the MY PARLAYS leg pool: its own calibration gate and the pool builder.
python3 scripts/backtest_leg_pool.py --selftest || fail "leg pool calibration selftest"
python3 scripts/build_leg_pool.py --selftest || fail "leg pool builder selftest"
# R81 — the measure-only parlay replay lab (pure core; adopts nothing).
python3 scripts/replay_lab.py --selftest || fail "replay lab selftest"
python3 scripts/build_backtest_weekly_corpus.py --selftest || fail "backtest corpus refresher selftest"
# R88 — the per-stage pipeline record and the scripts/stage.sh wrapper it is
# written through (the selftest spawns the wrapper with `true` and `false`, so it
# also proves the command's exit code survives the bookkeeping).
python3 scripts/stage_status.py --selftest || fail "stage status selftest"
# R92 — the QB DEPTH CASCADE (measure only). Its walk-forward substrate is
# proved here on a synthetic fixture with hand-worked answers (lag, replacement
# pooling, cap_gap, the cascade arithmetic). The other two R92 selftests are
# already above in this list and now cover it too: promote_signals' asserts the
# family's pure penalty/delta — the code build_predictions actually prices with
# — and validate_data's reds the qb_depth_backtest contract four ways.
# Neither touches data/ and neither reaches the network.
python3 scripts/backtest_qb_depth.py --selftest || fail "qb depth backtest selftest"
# R94 — DOES RAIN MATTER (measure only). Three selftests, each proving the one
# thing that would make the measurement dishonest if it stopped holding.
# build_wet_rates' proves the play-level rate corpus: a renamed upstream column
# raises instead of reading as zeros, a mid-build fetch failure writes NOTHING
# and names the remedy, and the hand-worked aggregate pools numerators rather
# than averaging per-game rates. backtest_weather's proves the power stage is
# BLIND — permuting the held-out season's outcomes leaves the power table
# byte-identical while perturbing a training outcome moves it — and that the
# artifact it writes still carries adopted:false with no family registered.
# archive_weather_forecast's proves the append-only archive: a re-run adds zero
# rows, a climatology row is refused at the door, and an already-archived
# observation is never rewritten when upstream changes its mind.
# None of the three reaches the network and none writes under data/.
python3 scripts/build_wet_rates.py --selftest || fail "wet rates corpus selftest"
python3 scripts/backtest_weather.py --selftest || fail "weather backtest selftest"
python3 scripts/archive_weather_forecast.py --selftest || fail "weather forecast archive selftest"
# R52 — the dead-code inventory scanner (report-only; the gate never deletes code).
python3 scripts/audit_dead_code.py --selftest || fail "dead-code scanner selftest"

echo "smoke: parsing every data/*.json (recursively)"
# Every JSON under data/ must parse. A parse error here is a hard stop.
while IFS= read -r -d '' json; do
  python3 -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" "$json" \
    || fail "invalid JSON: $json"
done < <(find data -name '*.json' -print0)

echo "smoke: canonical JSON write convention (QA-D9)"
# The repo's ONE on-disk convention (CLAUDE.md): ensure_ascii=True, indent=2,
# trailing newline, NO sort_keys. Scope: top-level data/*.json — the surface the
# crons rewrite and commit, where a non-canonical write turns every cron diff
# into churn and a data-conflict merge into manual reconstruction. contracts/
# and fixtures/ are hand-authored compact files the pipeline never rewrites;
# reformatting them would be cosmetic churn (and snapshots are append-only
# lock records). An allowlist entry needs a reason: these are the deliberately
# COMPACT (separators, no indent) multi-hundred-KB history feeds whose builders
# write them tight because indent=2 would inflate every cron commit ~25%.
python3 - <<'PY' || fail "canonical JSON write convention"
import glob, json, sys

ALLOW = {  # path -> reason (all: compact-writer, size-driven; builder named)
    "data/epa_history.json": "build_epa_history.py compact writer, 1.4 MB",
    "data/game_context.json": "build_game_context.py compact writer, 3.2 MB",
    "data/injury_history.json": "build_injury_history.py compact writer, 553 KB",
    "data/kdst_weekly_history.json": "build_kdst_history.py compact writer, 194 KB (348 KB at indent=2, 1.8x) — the R55 gate corpus, cron-rewritten",
    "data/market_baseline.json": "build_market_baseline.py compact writer, 38 KB",
    "data/player_usage.json": "build_player_usage.py compact writer, 80 KB",
    "data/player_usage_history.json": "build_player_usage_history.py compact writer, 236 KB",
    "data/player_usage_weekly.json": "build_player_usage_weekly.py compact writer, 2.3 MB",
    "data/preseason_form.json": "build_preseason.py compact writer (standalone, unwired)",
    "data/ros_backtest.json": "backtest scripts' compact writer",
    "data/sleeper_projections.json": "build_sleeper_projections.py compact writer, ~2.3 MB (3.97 MB at indent=2; display-only, lazily fetched)",
    "data/sleeper_index.json": "build_sleeper_projections.py compact writer, ~148 KB — fetched by LINEUP's automatic roster sync on a phone, every byte is cellular",
    "data/weather_forecast.json": "build_weather_forecast.py compact writer",
    "data/weather_history.json": "build_weather_history.py compact writer, 77 KB",
}

problems = []
for path in sorted(glob.glob("data/*.json")):
    raw = open(path, "rb").read()
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    canonical = (json.dumps(doc, ensure_ascii=True, indent=2) + "\n").encode("utf-8")
    if raw != canonical and path not in ALLOW:
        problems.append(f"{path}: not in the canonical write style "
                        f"(ensure_ascii=True, indent=2, trailing newline, no "
                        f"sort_keys) and not allowlisted — fix the writer, or "
                        f"add a REASONED allowlist entry")
    elif raw == canonical and path in ALLOW:
        problems.append(f"{path}: allowlisted as compact but is actually "
                        f"canonical — remove the stale entry so the allowlist "
                        f"stays honest")
for p in problems:
    print("  * " + p, file=sys.stderr)
sys.exit(1 if problems else 0)
PY

echo "smoke: core invariants"
# One consolidated python check keeps the interpreter startup cost to a single call.
python3 - <<'PY' || fail "core invariant check failed"
import json, sys

def load(p):
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)

problems = []

# 32 teams, valid roofs.
teams = load("data/fixtures/teams.json")["teams"]
if len(teams) != 32:
    problems.append(f"teams.json has {len(teams)} teams, expected 32")
roofs = {"indoor", "outdoor", "retractable"}
for t in teams:
    if t["roof"] not in roofs:
        problems.append(f"team {t['abbrev']} bad roof {t['roof']!r}")

# meta.json: 32 signals, all 0.0.
weights = load("data/meta.json")["weights"]
if len(weights) != 32:
    problems.append(f"meta.weights has {len(weights)} entries, expected 32")
nonzero = {k: v for k, v in weights.items() if v != 0.0}
if nonzero:
    problems.append(f"meta.weights has non-zero day-zero weights: {nonzero}")

# pipeline_status: health must mirror the WORST CONFIGURED feed status exactly
# (honesty: never rosier than reality, and no stale "degraded" once every feed
# is ok). 'unconfigured' = not turned on (needs a key) — excluded from the
# roll-up and surfaced separately by the UI as "awaiting config".
ps = load("data/pipeline_status.json")
order = {"ok": 0, "stale": 1, "degraded": 2, "down": 3}
configured = [f["status"] for f in ps["feeds"].values() if f["status"] != "unconfigured"]
worst = max(configured, key=lambda x: order[x]) if configured else "degraded"
if ps["health"] != worst:
    problems.append(f"pipeline_status health {ps['health']!r} != worst configured feed status {worst!r}")

# model_tuning: the NEVER-REGRESS example must be a non-adoption.
mt = load("data/model_tuning.json")
if mt["adopted"] is not False:
    problems.append("model_tuning.adopted must be False (the example is a non-adoption)")

# parlays: >=3 game-scope for EVERY game on the current slate, and >=3 week.
# The slate is derived from game_predictions.json (never a hardcoded fixture id).
parlays = load("data/parlays.json")["parlays"]
slate = {g["game_id"] for g in load("data/game_predictions.json")["games"]}
per_game = {}
for p in parlays:
    if p["scope"] == "game":
        per_game[p["game_id"]] = per_game.get(p["game_id"], 0) + 1
short = {g: per_game.get(g, 0) for g in slate if per_game.get(g, 0) < 3}
if short:
    problems.append(f"slate games with <3 parlays: {short}")
week_n = sum(1 for p in parlays if p["scope"] == "week")
if week_n < 3:
    problems.append(f"only {week_n} week parlays (need >=3)")

# REL17 — THE SINGLE CHECK THAT STOPS THIS BUG CLASS RECURRING.
# Every `status` in data/injuries.json must normalize to a canonical availability
# code. The whole release exists because build_weekly.INJURY_MULT silently
# multiplied every status it did not recognise by 1.0, so "Injured Reserve" and
# "Suspension" projected as fully healthy. A feed that invents a new spelling now
# reds the gate here instead of quietly defaulting 11 unavailable players to fit.
# We also assert the COMMITTED enrichment agrees with the current vocabulary, so a
# stale injuries.json cannot outlive a vocabulary change.
from scripts.availability import VOCAB_VERSION, counts, normalize_status  # noqa: E402
inj_doc = load("data/injuries.json")
if inj_doc.get("vocab_version") != VOCAB_VERSION:
    problems.append(f"injuries.json vocab_version {inj_doc.get('vocab_version')!r} != "
                    f"scripts/availability.VOCAB_VERSION {VOCAB_VERSION}")
unmapped = sorted({r["status"] for r in inj_doc["injuries"]
                   if normalize_status(r["status"]) is None})
if unmapped:
    problems.append(f"injuries.json statuses that do not normalize to a canonical "
                    f"availability code: {unmapped}")
stale = [r["player"] for r in inj_doc["injuries"]
         if r.get("availability") != normalize_status(r["status"])]
if stale:
    problems.append(f"{len(stale)} injuries.json row(s) whose committed "
                    f"`availability` disagrees with normalize_status(status), "
                    f"e.g. {stale[:3]}")
recount = counts(inj_doc["injuries"])
if inj_doc.get("counts") != recount:
    problems.append(f"injuries.json counts {inj_doc.get('counts')} != recomputed "
                    f"{recount}")

if problems:
    for p in problems:
        print("  * " + p, file=sys.stderr)
    sys.exit(1)
print("smoke: all core invariants hold")
PY

echo "SMOKE PASS"
