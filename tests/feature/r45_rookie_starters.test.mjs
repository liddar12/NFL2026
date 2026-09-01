/* tests/feature/r45_rookie_starters.test.mjs — R45 (owner's pick): the
 * rookies-only view shows depth-chart FACTS, never invented points.
 *
 * The honesty contract:
 *   - only the LATEST depth-chart snapshot, only pos_rank 1, only roster
 *     rookies (years_exp == 0);
 *   - an RB is ROLE UNSETTLED (committee/handcuff rule) — a listing is not a
 *     workload claim;
 *   - SOS rides the app's own 1..5 scale (constants pinned in sync) and is
 *     null — never 3.0 — when opponents are unrated;
 *   - the strip contains NO projection anywhere; feed failure -> None.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { renderRookieStarters } from "../../app/views/players.js";
import { SOS_ELO_PER_POINT } from "../../app/team-logic.js";

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

/* --------------------------------------------------------------- producer */

test("_rookie_starters: latest snapshot, rank-1 rookies only, RB unsettled, facts computed", () => {
  const out = py(`
from scripts.build_predictions import _rookie_starters
dc = [
    # An OLD snapshot listing a rookie QB rank 1 — must be ignored entirely.
    {"dt": "2026-08-01T00:00:00Z", "team": "AAA", "player_name": "Old Snap",
     "gsis_id": "00-9", "pos_abb": "QB", "pos_slot": "1", "pos_rank": "1"},
    # Latest snapshot:
    {"dt": "2026-09-01T00:00:00Z", "team": "AAA", "player_name": "Rook QB",
     "gsis_id": "00-1", "pos_abb": "QB", "pos_slot": "1", "pos_rank": "1"},
    {"dt": "2026-09-01T00:00:00Z", "team": "AAA", "player_name": "Rook RB",
     "gsis_id": "00-2", "pos_abb": "RB", "pos_slot": "11", "pos_rank": "1"},
    {"dt": "2026-09-01T00:00:00Z", "team": "AAA", "player_name": "Backup Rook",
     "gsis_id": "00-3", "pos_abb": "WR", "pos_slot": "1", "pos_rank": "2"},
    {"dt": "2026-09-01T00:00:00Z", "team": "AAA", "player_name": "Vet QB",
     "gsis_id": "00-4", "pos_abb": "TE", "pos_slot": "1", "pos_rank": "1"},
    {"dt": "2026-09-01T00:00:00Z", "team": "AAA", "player_name": "Rook DL",
     "gsis_id": "00-5", "pos_abb": "DL", "pos_slot": "1", "pos_rank": "1"},
]
roster = [
    {"gsis_id": "00-1", "years_exp": "0"}, {"gsis_id": "00-2", "years_exp": "0"},
    {"gsis_id": "00-3", "years_exp": "0"}, {"gsis_id": "00-5", "years_exp": "0"},
    {"gsis_id": "00-4", "years_exp": "7"}, {"gsis_id": "00-9", "years_exp": "0"},
]
# AAA plays weeks 1 and 3 (bye week 2) vs a 1550 and a 1450 team -> mean 1500 -> sos 3.0
sched = [
    {"week": 1, "home": "AAA", "away": "BBB"},
    {"week": 3, "home": "CCC", "away": "AAA"},
]
ratings = {"BBB": 1550.0, "CCC": 1450.0}
rs = _rookie_starters(sched, ratings, fetch_dc=lambda: dc, fetch_roster=lambda: roster)
def boom(): raise RuntimeError("feed down")
down = _rookie_starters(sched, ratings, fetch_dc=boom, fetch_roster=lambda: roster)
print(json.dumps({"rs": rs, "down": down}))`);
  const rs = out.rs;
  assert.equal(rs.snapshot_utc, "2026-09-01T00:00:00Z", "only the LATEST snapshot counts");
  assert.deepEqual(rs.players.map((p) => p.gsis_id).sort(), ["00-1", "00-2"],
    "rank-2, veterans, non-offence positions and stale snapshots are all out");
  const qb = rs.players.find((p) => p.gsis_id === "00-1");
  const rb = rs.players.find((p) => p.gsis_id === "00-2");
  assert.equal(qb.role_unsettled, false);
  assert.equal(rb.role_unsettled, true, "an RB listing is never a workload claim");
  assert.equal(qb.sos, 3.0, "mean opponent 1500 sits exactly at the scale midpoint");
  assert.equal(qb.bye_week, 2, "the missing week is the bye");
  assert.equal(Object.prototype.hasOwnProperty.call(qb, "proj_points"), false,
    "facts only — no projection field can exist");
  assert.equal(out.down, null, "feed failure -> None, never an empty claim");
});

test("_team_sos_and_bye: unrated opponents give sos null — unknown, never 3.0", () => {
  const out = py(`
from scripts.build_predictions import _team_sos_and_bye
facts = _team_sos_and_bye([{"week": 1, "home": "AAA", "away": "ZZZ"}], {})
print(json.dumps(facts["AAA"]))`);
  assert.equal(out.sos, null);
});

test("the producer's SOS scale constant matches the app's", () => {
  const src = readFileSync(join(REPO_ROOT, "scripts/build_predictions.py"), "utf8");
  const m = src.match(/_SOS_ELO_PER_POINT = ([\d.]+)/);
  assert.ok(m, "producer constant exists");
  assert.equal(Number(m[1]), SOS_ELO_PER_POINT,
    "one 1..5 scale across the player cards and the rookie strip");
});

/* ----------------------------------------------------------------- client */

const DOC = {
  snapshot_utc: "2026-09-01T12:20:07Z",
  players: [
    { gsis_id: "a", name: "Carnell Tate", team: "TEN", position: "WR", slot: "1",
      role_unsettled: false, sos: 2.8, bye_week: 9 },
    { gsis_id: "b", name: "Jeremiyah Love", team: "ARI", position: "RB", slot: "11",
      role_unsettled: true, sos: 3.5, bye_week: 14 },
  ],
};

test("renderRookieStarters shows the facts and NEVER a point estimate", () => {
  const html = renderRookieStarters(DOC);
  assert.match(html, /ROOKIE DEPTH-CHART STARTERS · FACTS ONLY/);
  assert.match(html, /Carnell Tate/);
  assert.match(html, /SOS 2\.8\/5/);
  assert.match(html, /BYE W9/);
  assert.match(html, /STARTER LISTED/);
  assert.match(html, /ROLE UNSETTLED/, "the RB carries the committee/handcuff mark");
  assert.match(html, /snapshot 2026-09-01/);
  assert.ok(!/\d+(\.\d+)?\s*pts/i.test(html) && !/proj_points|>PROJ</.test(html),
    "no projection, no points value, nothing invented (the why-text may SAY "
    + "the word projection; a NUMBER labelled as one is the violation)");
  assert.equal(renderRookieStarters(null), "");
  assert.equal(renderRookieStarters({ players: [] }), "");
});

test("the strip is wired behind the ROOKIES ONLY filter", () => {
  const src = readFileSync(join(REPO_ROOT, "app/views/players.js"), "utf8");
  assert.match(src, /getRookieStarters\(\)/, "fetched with the other optional feeds");
  assert.match(src, /rsEl\.hidden = !rookiesOnly/,
    "visible exactly when the rookies filter is on");
  assert.match(src, /No RANKED rookies yet/,
    "the empty ranked list explains itself instead of a generic message");
});
