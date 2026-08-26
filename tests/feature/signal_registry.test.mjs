// signal_registry.test.mjs — ONE source of truth for the signal registry.
//
// scripts/signals/registry.py is the registry. Until QA-D5 (2026-08-26) this
// test compared data/meta.json against an EXPECTED list pasted into this file
// (and scripts/validate_data.py carried a second pasted mirror): renaming or
// reordering a signal in registry.py redded nothing. Now the expected list is
// READ FROM THE REGISTRY on every run — set AND order — and the hardcoded
// mirrors are gone. docs/SIGNAL_REGISTRY.md's name table is compared too, so
// the doc cannot go stale silently.
//
// Node built-ins only: node:test, node:assert, node:child_process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// The registry, read from its single source of truth — never pasted here.
const REG = py(`
from scripts.signals.registry import SIGNALS
print(json.dumps({
    "names": list(SIGNALS.keys()),
    "groups": [v["group"] for v in SIGNALS.values()],
    "weights": [v["weight"] for v in SIGNALS.values()],
    "key_sets": sorted({tuple(sorted(v.keys())) for v in SIGNALS.values()}),
}))`);

const meta = JSON.parse(
  readFileSync(new URL("../../data/meta.json", import.meta.url), "utf8"),
);

test("meta.json weights carry the registry's signals — same SET and same ORDER (QA-D5-AC1/AC2)", () => {
  // deepEqual on arrays is order-sensitive: a rename OR a pure reorder in
  // registry.py (or in meta.json) reds this line. The old checks (`name in
  // weights`, `EXPECTED.includes`) were both order-blind despite the registry's
  // "in group order" contract.
  assert.deepEqual(Object.keys(meta.weights), REG.names);
});

test("every registry signal is at exactly 0.0 in meta.json (day-zero rule)", () => {
  for (const name of REG.names) {
    assert.strictEqual(meta.weights[name], 0.0,
      `signal '${name}' must be 0.0 on day zero, got ${meta.weights[name]}`);
  }
});

test("the registry's stated shape holds at the source: 19/10/3 grouping, exact key-set (QA-D5-AC5)", () => {
  const counts = {};
  for (const g of REG.groups) counts[g] = (counts[g] || 0) + 1;
  assert.deepEqual(counts, { player: 19, game: 10, market: 3 });
  assert.equal(REG.names.length, 32);
  // Grouping is contiguous and in group order: player block, then game, then market.
  assert.deepEqual(REG.groups, [
    ...Array(19).fill("player"), ...Array(10).fill("game"), ...Array(3).fill("market"),
  ]);
  // Every entry carries exactly {description, group, weight} — no drifted keys.
  assert.deepEqual(REG.key_sets, [["description", "group", "weight"]]);
});

test("docs/SIGNAL_REGISTRY.md's name table matches the registry (QA-D5-AC4)", () => {
  const doc = readFileSync(new URL("../../docs/SIGNAL_REGISTRY.md", import.meta.url), "utf8");
  const rows = [...doc.matchAll(/^\| `([a-z0-9_]+)` \| (player|game|market) \|/gm)]
    .map((m) => ({ name: m[1], group: m[2] }));
  assert.deepEqual(rows.map((r) => r.name), REG.names,
    "the doc's signal tables must list exactly the registry's names, in registry order");
  assert.deepEqual(rows.map((r) => r.group), REG.groups,
    "each doc row's group column must match the registry");
});

test("scripts/validate_data.py no longer carries a pasted signal mirror (QA-D5-AC3)", () => {
  // The validator now imports the registry; a re-pasted literal is how the
  // half-guarded drift comes back. The one allowed mention is the import line.
  const src = readFileSync(new URL("../../scripts/validate_data.py", import.meta.url), "utf8");
  assert.match(src, /from scripts\.signals\.registry import/,
    "validate_data.py must source EXPECTED_SIGNALS from the registry");
  assert.ok(!/"prior_perf",/.test(src),
    "a signal-name literal in validate_data.py means the pasted mirror is back");
});
