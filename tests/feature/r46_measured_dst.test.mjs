/* tests/feature/r46_measured_dst.test.mjs — R46 (owner's pick: measure what
 * the data supports): four previously-unpriceable D/ST components are now
 * MEASURED from columns stats_team_week / games.csv really carry —
 * pts_allow (linear points allowed), ff, tkl_loss, def_pass_def — and the
 * PARTIAL SCORING disclosure shrinks by construction, never by silence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { applyScoring, normalizeProfile } from "../../app/league.js";
import { shapeKdst, omittedKeys } from "../../app/kdst.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MEASURED = ["pts_allow", "ff", "tkl_loss", "def_pass_def"];

function py(body) {
  const out = execFileSync("python3", ["-"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("the selftest build measures all four keys and declares them modelled", () => {
  const out = py(`
from scripts.build_kdst import build, MEASURED_EXTRA_DEF_KEYS
doc = build(selftest=True)
d = doc["defenses"][0]
print(json.dumps({
    "extras": list(MEASURED_EXTRA_DEF_KEYS),
    "modelled_def": doc["modelled_keys"]["DEF"],
    "stats_have": {k: (k in d["stats"]) for k in MEASURED_EXTRA_DEF_KEYS},
    "sample": {k: d["stats"].get(k) for k in MEASURED_EXTRA_DEF_KEYS},
    "unmodelled": [u["key"] for u in doc["unmodelled_keys"]],
    "st_ff_reason": next(u["reason"] for u in doc["unmodelled_keys"]
                         if u["key"] == "def_st_ff"),
}))`);
  assert.deepEqual(out.extras, MEASURED);
  for (const k of MEASURED) {
    assert.equal(out.stats_have[k], true, `${k} must be in every defense's stat line`);
    assert.ok(out.modelled_def.includes(k),
      `${k} must be DECLARED modelled — validate_data's kdst honesty rule 3 `
      + "forces the stat line and the declaration to agree");
  }
  assert.ok(out.sample.pts_allow > 0, "a defense allows points; zero would be a lie");
  assert.deepEqual(out.unmodelled, ["def_4_and_stop", "def_st_ff", "def_st_fum_rec"],
    "exactly the three genuinely-unmeasurable components remain declared");
  assert.match(out.st_ff_reason, /mis-attributed, not under-counted/,
    "ff now carries the whole-team column, so def_st_ff gets the fum_rec-style note");
});

test("committed doc: every defense's measured extras land in real-world season bands", () => {
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, "data/kdst_projections.json"), "utf8"));
  assert.ok(doc.defenses.length >= 30);
  for (const d of doc.defenses) {
    const s = d.stats;
    // Honesty bands, not pins: a value outside these means a broken join or a
    // unit error (per-game vs per-season), not a bad team.
    assert.ok(s.pts_allow >= 150 && s.pts_allow <= 600,
      `${d.team} pts_allow ${s.pts_allow} outside any real NFL season`);
    assert.ok(s.ff >= 2 && s.ff <= 40, `${d.team} ff ${s.ff}`);
    assert.ok(s.tkl_loss >= 30 && s.tkl_loss <= 160, `${d.team} tkl_loss ${s.tkl_loss}`);
    assert.ok(s.def_pass_def >= 30 && s.def_pass_def <= 160,
      `${d.team} def_pass_def ${s.def_pass_def}`);
  }
});

test("a league pricing the four keys gets real points, and the omitted list shrinks", () => {
  const profile = normalizeProfile({
    name: "Omilia-ish DST",
    scoring: {
      def_td: 6, sack: 1, int: 2, fum_rec: 2, safe: 2, blk_kick: 2,
      pts_allow: -0.1, ff: 1, tkl_loss: 0.5, def_pass_def: 0.3,
      def_2pt: 4, def_3_and_out: 0.3, // still nothing feeds these two
    },
    shape: { teams: 10 },
  });
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, "data/kdst_projections.json"), "utf8"));
  const idx = shapeKdst(doc, profile);
  const phi = [...idx.byId.values()].find((e) => e.team === "PHI" && e.pos === "DEF");
  assert.ok(phi && !phi.unscored);
  // The four measured keys must move the number: with pts_allow at -0.1 a
  // defense's total swings by ~-33 from that key alone.
  const withKeys = applyScoring(phi.stats, profile);
  const without = applyScoring(
    Object.fromEntries(Object.entries(phi.stats).filter(([k]) => !MEASURED.includes(k))),
    profile,
  );
  assert.ok(Math.abs(withKeys - without) > 10,
    "the measured keys must actually reprice the D/ST total");
  const omitted = omittedKeys(doc, phi.stats, "DEF", profile).map((o) => o.key);
  for (const k of MEASURED) {
    assert.ok(!omitted.includes(k), `${k} is measured now — it may not be listed as omitted`);
  }
  assert.ok(omitted.includes("def_2pt") && omitted.includes("def_3_and_out"),
    "keys nothing feeds stay HONESTLY listed — shrunk, never silenced");
});

test("the selftest fixture carries the new required columns", () => {
  const head = readFileSync(
    join(REPO_ROOT, "data/fixtures/kdst_sample/team_week.csv"), "utf8",
  ).split("\n")[0];
  for (const col of ["def_tackles_for_loss", "def_fumbles_forced", "def_pass_defended"]) {
    assert.ok(head.includes(col), `fixture team_week.csv must carry ${col}`);
  }
});
