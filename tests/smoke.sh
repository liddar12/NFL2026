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

# pipeline_status: honestly degraded (not 'ok'), at least one non-ok feed.
ps = load("data/pipeline_status.json")
if ps["health"] == "ok":
    problems.append("pipeline_status health is 'ok' but the example must be honest/degraded")
if not any(f["status"] != "ok" for f in ps["feeds"].values()):
    problems.append("pipeline_status has no non-ok feed")

# model_tuning: the NEVER-REGRESS example must be a non-adoption.
mt = load("data/model_tuning.json")
if mt["adopted"] is not False:
    problems.append("model_tuning.adopted must be False (the example is a non-adoption)")

# parlays: >=3 game (sample) and >=3 week.
parlays = load("data/parlays.json")["parlays"]
game_n = sum(1 for p in parlays if p["scope"] == "game" and p.get("game_id") == "2026_01_BAL_KC")
week_n = sum(1 for p in parlays if p["scope"] == "week")
if game_n < 3:
    problems.append(f"only {game_n} sample-game parlays (need >=3)")
if week_n < 3:
    problems.append(f"only {week_n} week parlays (need >=3)")

if problems:
    for p in problems:
        print("  * " + p, file=sys.stderr)
    sys.exit(1)
print("smoke: all core invariants hold")
PY

echo "SMOKE PASS"
