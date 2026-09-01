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
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

/* R41b — the injury re-projection pass rebuilds every record fresh, so the
 * rookie stamp must be CARRIED onto the rebuilt list or the rewrite ships a
 * flagless file. Incident (2026-09-01, daily run 79): the log said
 * "349 of 395 stamped" while the committed player_projections.json carried
 * zero `rookie` fields — the second write silently undid the first. */

test("_carry_rookie_flags moves the stamp by id and leaves unknowns unknown", () => {
  const out = py(`
from scripts.build_predictions import _carry_rookie_flags
src = [
    {"gsis_id": "a", "rookie": True},
    {"gsis_id": "b", "rookie": False},
    {"gsis_id": "c"},                    # unstamped in src stays unstamped
]
dst = [{"gsis_id": "a"}, {"gsis_id": "b"}, {"gsis_id": "c"}, {"gsis_id": "d"}]
carried = _carry_rookie_flags(src, dst)
print(json.dumps({
    "carried": carried,
    "a": dst[0].get("rookie"),
    "b": dst[1].get("rookie"),
    "c_has": "rookie" in dst[2],
    "d_has": "rookie" in dst[3],
}))`);
  assert.equal(out.carried, 2);
  assert.equal(out.a, true);
  assert.equal(out.b, false);
  assert.equal(out.c_has, false, "no flag in src -> unknown stays ABSENT, never false");
  assert.equal(out.d_has, false, "an id src never saw stays unstamped");
});

test("the injury re-projection branch carries the flags before it rewrites", () => {
  const src = readFileSync(join(REPO_ROOT, "scripts/build_predictions.py"), "utf8");
  assert.match(src,
    /_carry_rookie_flags\(projected, reprojected\)\s*\n\s*projected = reprojected/,
    "the carry must happen on the reprojected list BEFORE it replaces projected "
    + "— that rewrite is what shipped the flagless file");
});
