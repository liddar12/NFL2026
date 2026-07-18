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
)
for f in "${required_files[@]}"; do
  [ -f "$f" ] || fail "missing required file: $f"
done

echo "smoke: pipeline math selftests (fixture-driven, never write data/)"
python3 scripts/build_epa_history.py --selftest || fail "epa_history selftest"
python3 -m scripts.promote_signals --selftest || fail "promote_signals selftest"

echo "smoke: parsing every data/*.json (recursively)"
# Every JSON under data/ must parse. A parse error here is a hard stop.
while IFS= read -r -d '' json; do
  python3 -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" "$json" \
    || fail "invalid JSON: $json"
done < <(find data -name '*.json' -print0)

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

if problems:
    for p in problems:
        print("  * " + p, file=sys.stderr)
    sys.exit(1)
print("smoke: all core invariants hold")
PY

echo "SMOKE PASS"
