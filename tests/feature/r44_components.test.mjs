/* tests/feature/r44_components.test.mjs — R44: every league scoring rule a
 * verified component feeds reprices QB/RB/WR/TE, through the ONE extra_pts
 * slot R29 threaded app-wide.
 *
 * The honesty contract:
 *   - extract_components() is SELF-VERIFYING against ESPN's own appliedStats
 *     arithmetic — a row that fails ships NOTHING (never a zero-filled line);
 *   - the delta is league_value(components) - what ESPN's own table paid for
 *     exactly those ids, so unmapped ids (receptions, return TDs) cancel by
 *     construction and a catch is never priced twice;
 *   - the DEFAULT profile prices no delta (unconfigured users byte-identical);
 *   - bonus counts are MEASURED games (cumulative thresholds), ambiguous
 *     names dropped, feed failure -> absent, never zero.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { componentDelta, withLeagueExtras, extraPtsOf } from "../../app/team-logic.js";
import { normalizeProfile } from "../../app/league.js";

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

/* ------------------------------------------------- producer: extraction */

test("extract_components: verified line in, correct keys and base out; doubt in, None out", () => {
  // R44b contract: the kona view carries no appliedStats (measured live), so
  // verification is REPRODUCTION — valuing the raw stats under ESPN's default
  // PPR table must land on ESPN's own appliedTotal within 1.0.
  const out = py(`
from scripts.scrape.espn_players import extract_components
good = {
    # 160+120-20+20+12 (mapped) + 5 rec + 3 rec_yd = 300 — ESPN's own arithmetic.
    "appliedTotal": 300.0,
    "stats": {"0": 520, "1": 350, "3": 4000, "4": 30, "20": 10,
              "23": 40, "24": 200, "25": 2, "53": 5, "58": 8, "42": 30},
}
# The same stat line with a total our table cannot reproduce — a scored id we
# do not know about (e.g. a fumble-return TD). Must ship NOTHING, not a guess.
unknown_id = dict(good, appliedTotal=306.0)
no_stats = {"appliedTotal": 100.0, "stats": {}}
print(json.dumps({
    "good": extract_components(good),
    "unknown_id": extract_components(unknown_id),
    "no_stats": extract_components(no_stats),
    "none": extract_components(None),
}))`);
  const g = out.good;
  assert.ok(g, "the verified entry extracts");
  // rec (53) must NOT be a component and its value must NOT be in base.
  assert.equal(g.components.rec, undefined, "receptions never enter the component line");
  assert.equal(g.components.pass_td, 30);
  assert.equal(g.components.pass_cmp, 350);
  assert.equal(g.components.rec_tgt, 8);
  // base = mapped ids under the default table: 160+120-20+20+12+3 — not rec's 5.
  assert.equal(g.base_applied_pts, 295.0);
  assert.equal(out.unknown_id, null,
    "a total the known table cannot reproduce means an id we have wrong -> no claim");
  assert.equal(out.no_stats, null);
  assert.equal(out.none, null);
});

test("_bonus_games_by_name: cumulative thresholds, ambiguity dropped, failure absent", () => {
  const out = py(`
from scripts.build_predictions import _bonus_games_by_name
rows = [
    {"player_display_name": "Big Arm", "player_id": "00-1", "season_type": "REG",
     "passing_yards": 425.0},
    {"player_display_name": "Big Arm", "player_id": "00-1", "season_type": "REG",
     "passing_yards": 310.0},
    {"player_display_name": "Big Arm", "player_id": "00-1", "season_type": "POST",
     "passing_yards": 500.0},                       # playoffs never count
    {"player_display_name": "Two Guys", "player_id": "00-2", "season_type": "REG",
     "rushing_yards": 150.0},
    {"player_display_name": "Two Guys", "player_id": "00-3", "season_type": "REG",
     "rushing_yards": 210.0},                       # same name, different player
]
ok = _bonus_games_by_name(fetch=lambda: rows)
def boom(): raise RuntimeError("feed down")
print(json.dumps({"ok": ok, "down": _bonus_games_by_name(fetch=boom)}))`);
  assert.deepEqual(out.ok["Big Arm"], { bonus_pass_yd_300: 2, bonus_pass_yd_400: 1 },
    "a 425-yard game counts for BOTH thresholds; the playoff game for neither");
  assert.equal(out.ok["Two Guys"], undefined, "an ambiguous name is dropped, never guessed");
  assert.deepEqual(out.down, {}, "feed failure -> absent for everyone, never zero");
});

test("check_component_lines: co-presence, extraction drift and cmp>att all red", () => {
  const out = py(`
from scripts.validate_data import check_component_lines, ValidationError
def probs(players):
    try:
        check_component_lines({"players": players})
        return []
    except ValidationError as e:
        return str(e).splitlines()[1:]
half = [{"gsis_id": "a", "league_components": {"pass_td": 30}}]
drift = [{"gsis_id": "b", "completions_prior": 350.0, "base_applied_pts": 1.0,
          "league_components": {"pass_cmp": 340.0}}]
impossible = [{"gsis_id": "c", "base_applied_pts": 1.0,
               "league_components": {"pass_cmp": 500, "pass_att": 400}}]
clean = [{"gsis_id": "d", "completions_prior": 350.0, "base_applied_pts": 292.0,
          "league_components": {"pass_cmp": 350.0, "pass_att": 520, "pass_td": 30}}]
print(json.dumps({"half": len(probs(half)), "drift": len(probs(drift)),
                  "impossible": len(probs(impossible)), "clean": len(probs(clean))}))`);
  assert.equal(out.half, 1, "components without base_applied_pts is a half-claim");
  assert.equal(out.drift, 1, "completions_prior vs pass_cmp drift is caught");
  assert.equal(out.impossible, 1, "pass_cmp > pass_att is caught");
  assert.equal(out.clean, 0);
});

/* --------------------------------------------------- client: the delta */

const OMILIA_ISH = normalizeProfile({
  name: "Omilia-ish",
  scoring: {
    pass_yd: 0.04, pass_td: 6, pass_int: -2, pass_cmp: 0.5,
    rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6,
    fum_lost: -2, bonus_pass_yd_400: 5,
  },
  shape: { teams: 10 },
});

const QB_ENTRY = {
  receptions_prior: 0,
  completions_prior: 350,
  league_components: {
    pass_yd: 4000, pass_td: 30, pass_int: 10, pass_cmp: 350, pass_att: 520,
    rush_yd: 200, rush_td: 2,
  },
  base_applied_pts: 292, // 160 + 120 - 20 + 20 + 12 under ESPN default PPR
  bonus_games: { bonus_pass_yd_400: 2 },
};

test("componentDelta prices EVERY component-fed rule against the ESPN base", () => {
  // league: 160 + 30x6 + 10x(-2) + 350x0.5 + 20 + 12 = 527; +2 bonus games x5 = 537.
  assert.equal(componentDelta(QB_ENTRY, OMILIA_ISH), 537 - 292);
  assert.equal(componentDelta({ receptions_prior: 0 }, OMILIA_ISH), null,
    "no verified line -> null (unknown), never 0");
  // A rogue 'rec' in the components must not price (belt-and-braces).
  const withRec = {
    ...QB_ENTRY,
    league_components: { ...QB_ENTRY.league_components, rec: 90 },
  };
  assert.equal(componentDelta(withRec, OMILIA_ISH), componentDelta(QB_ENTRY, OMILIA_ISH),
    "receptions stay on the mode toggle — never in the delta");
});

test("withLeagueExtras: default profile prices nothing; a saved league prices the full delta", () => {
  const map = new Map([["q", QB_ENTRY]]);
  const untouched = withLeagueExtras(map, null);
  assert.equal(extraPtsOf(untouched.get("q")), 0,
    "an unconfigured user's numbers must be byte-identical");
  const priced = withLeagueExtras(map, OMILIA_ISH);
  assert.equal(extraPtsOf(priced.get("q")), 245,
    "6-pt pass TDs, completions and the 400-yd bonus all land in ONE extra_pts");
  // The R29 fallback still works for a player without a component line.
  const noComps = new Map([["q", { completions_prior: 350 }]]);
  assert.equal(extraPtsOf(withLeagueExtras(noComps, OMILIA_ISH).get("q")), 175,
    "pass_cmp-only fallback: narrower, never wrong");
});

/* ---------------------------------------------------------------- wiring */

test("GRADE rides the same league extras as every other surface", () => {
  const view = readFileSync(join(REPO_ROOT, "app/views/grade.js"), "utf8");
  assert.match(view, /withLeagueExtras\(weeklyRaw, profile\)/,
    "GRADE was the one view missing R29's stamping — never again");
});

test("the component fields survive the weekly build only as a verified pair", () => {
  const src = readFileSync(join(REPO_ROOT, "scripts/build_weekly.py"), "utf8");
  assert.match(src,
    /_comp and _comp\.get\("components"\) and _comp\.get\("base_applied_pts"\) is not None/,
    "league_components and base_applied_pts are stamped together or not at all");
  const bp = readFileSync(join(REPO_ROOT, "scripts/build_predictions.py"), "utf8");
  assert.match(bp, /components_by_id=components_by_id/,
    "the component map must actually reach build_weekly_document");
});
