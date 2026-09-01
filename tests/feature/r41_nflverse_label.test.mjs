/* tests/feature/r41_nflverse_label.test.mjs — the nflverse health label is
 * keyed on the writer's precise token, not a bare substring.
 *
 * Incident (2026-09-01): build_predictions derived the nflverse feed row by
 * sniffing the oline doc's `source` for the word "unreachable". R40's
 * per-team skip note ("ARI — roster page unreachable this run") landed in a
 * source whose snap counts had refined FINE — and nflverse reported degraded
 * on a healthy run. A dishonest-pessimistic label is still a dishonest label.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function py(body) {
  const out = execFileSync("python3", ["-"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("_nflverse_reached classifies every writer-emitted source shape correctly", () => {
  const CASES = [
    // [source string the oline writer actually emits, expected]
    ["espn_roster + nflverse_snap_counts_2025", true],
    ["espn_roster + nflverse_snap_counts_2025 (31/32 teams refined)", true],
    // R40 skip note on a HEALTHY nflverse refine — the incident case:
    ["espn_roster + nflverse_snap_counts_2025 (skipped: ARI — roster page unreachable this run) + nflverse_depth_charts", true],
    // The genuine fallback: snap counts really were unreachable.
    ["espn_roster only (nflverse snap counts unreachable; continuity = share of linemen with >= 2 yrs experience)", false],
    ["", false],
  ];
  const out = py(`
from scripts.build_predictions import _nflverse_reached
cases = json.loads('''${JSON.stringify(CASES.map(([s]) => s))}''')
print(json.dumps([_nflverse_reached(s) for s in cases]))`);
  CASES.forEach(([src, want], i) => {
    assert.equal(out[i], want, `misclassified: ${src.slice(0, 60)}`);
  });
});
