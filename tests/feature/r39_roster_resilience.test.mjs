/* tests/feature/r39_roster_resilience.test.mjs — one team's roster page must
 * not kill the daily build.
 *
 * Incident (2026-09-01, Week-1 prep): ESPN 404'd ONE team's roster page for
 * 20+ minutes and two consecutive daily runs died at fetch_roster_ages —
 * injuries, ADP and projections for all 32 teams blocked by an age enrichment
 * whose signal (age_curve) carries weight 0.0. The revised posture: a failed
 * team DEGRADES loudly (its ages absent, never fabricated), a SYSTEMIC
 * failure (> max_failed_teams pages) still hard-fails, and the volume floor
 * scales to the teams that answered. These cases drive the real Python with a
 * stubbed fetcher, per the QA-D4 pattern.
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

const HARNESS = `
from scripts.scrape import espn_players as ep
from scripts.scrape.espn import FeedError

TEAMS = {f"T{i:02d}": {"espn_id": i} for i in range(32)}

def roster(team_size=53):
    return {"athletes": [{"items": [
        {"id": f"{tid}-{n}", "age": 25} for n in range(team_size)]}
        for tid in range(1)]}

def make_get(fail_ids):
    def get_json(url):
        tid = int(url.rstrip("/roster").rsplit("/", 1)[-1])
        if tid in fail_ids:
            raise FeedError(f"ESPN GET {url} returned HTTP 404. (stub)")
        doc = {"athletes": [{"items": [
            {"id": f"{tid}-{n}", "age": 25} for n in range(53)]}]}
        return doc
    return get_json
`;

test("one failed roster page degrades that team and the pull SUCCEEDS", () => {
  const out = py(`${HARNESS}
ages = ep.fetch_roster_ages(TEAMS, get_json=make_get({22}))
missing = [k for k in ages if k.startswith("22-")]
print(json.dumps({"n": len(ages), "team22_entries": len(missing)}))`);
  assert.equal(out.team22_entries, 0, "the failed team's ages must be ABSENT, not fabricated");
  assert.equal(out.n, 31 * 53, "every answering team's ages must survive");
});

test("a systemic outage (more than max_failed_teams pages) still hard-fails", () => {
  const out = py(`${HARNESS}
try:
    ep.fetch_roster_ages(TEAMS, get_json=make_get({1, 2, 3, 4, 5}))
    print(json.dumps({"raised": False}))
except FeedError as exc:
    print(json.dumps({"raised": True, "msg": str(exc)[:80]}))`);
  assert.equal(out.raised, true, "5 failed pages is an outage, not a glitch");
  assert.match(out.msg, /5 of 32/);
});

test("the volume floor scales to the teams that answered", () => {
  // 31 answering teams delivering only 10 aged players each is a broken pull
  // even though one team legitimately failed.
  const out = py(`${HARNESS}
def tiny_get(url):
    tid = int(url.rstrip("/roster").rsplit("/", 1)[-1])
    if tid == 22:
        raise FeedError("stub 404")
    return {"athletes": [{"items": [
        {"id": f"{tid}-{n}", "age": 25} for n in range(10)]}]}
try:
    ep.fetch_roster_ages(TEAMS, get_json=tiny_get)
    print(json.dumps({"raised": False}))
except FeedError as exc:
    print(json.dumps({"raised": True, "msg": str(exc)[:80]}))`);
  assert.equal(out.raised, true);
  assert.match(out.msg, /pull looks broken/);
});

test("an all-healthy pull is unchanged: full map, no failure path", () => {
  const out = py(`${HARNESS}
ages = ep.fetch_roster_ages(TEAMS, get_json=make_get(set()))
print(json.dumps({"n": len(ages)}))`);
  assert.equal(out.n, 32 * 53);
});
