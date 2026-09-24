/* tests/feature/r98_official_rosters.test.mjs — R98: the official roster decides
 * the team, and a player on no roster is not on the board.
 *
 * The owner saw players on the wrong team on LINEUP and on the waiver wire.
 * Measured 2026-09-24 (week 3): 24 of the 300 shipped players were on the wrong
 * team — 15 on no NFL roster at all (Russell Wilson "NYG", Nick Chubb "HOU",
 * DeAndre Hopkins "BAL") and 9 who had moved (Ertz WAS->PHI, Cooks BUF->SF,
 * Ford CLE->MIN). Every one came from R33's fallback: when the fantasy pool's
 * current proTeamId reads 0 (cut) or is missing, the PRIOR-season team was kept
 * so a draftable player was not dropped mid-signing. Right in August; in week 3
 * it projects a released player into your lineup and offers him on waivers.
 *
 * fetch_roster_ages already read all 32 official rosters every run and kept only
 * the age. R98 keeps the team too (fetch_rosters) and assemble_records lets it
 * win. Locked here, on the pure functions with a stubbed network:
 *   1. the official roster beats both the fantasy map and last season;
 *   2. a player no ANSWERING roster lists is dropped — the cut case (proTeamId 0)
 *      and the absent case alike;
 *   3. if the page of the team he would be stamped on did not answer, nothing
 *      proves he left: he keeps the old stamp and is named as unverified;
 *   4. an injured player stays — IR players are on their team's page;
 *   5. with no rosters passed, R33's behaviour is byte-for-byte unchanged, and
 *      only the LIVE build (current_season set) passes them;
 *   6. fetch_rosters returns the teams and the set that answered, and
 *      fetch_roster_ages still returns ages alone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import io, json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const SETUP = `
from contextlib import redirect_stderr
from scripts.scrape import espn_players as ep

TEAMS = {ab: {"espn_id": i} for ab, i in
         {"SF": 25, "PHI": 21, "WAS": 28, "NYG": 19, "BUF": 2, "LAC": 24, "KC": 12}.items()}

def row(eid, name, prior):
    return {"espn_id": eid, "name": name, "position": "WR", "pro_team_id": prior,
            "injury_status": None, "prior_season_points": 100.0, "receptions": 50.0,
            "completions": 0.0, "pass_attempts": 0.0}

POOL = [
    row("15835",   "Zach Ertz",      28),  # WAS last season; fantasy map 0; official PHI
    row("16731",   "Brandin Cooks",  2),   # BUF last season; fantasy map 0; official SF
    row("14881",   "Russell Wilson", 19),  # NYG last season; fantasy map 0; on NO roster
    row("999",     "Absent Guy",     19),  # not in the fantasy map at all; on no roster
    row("3123076", "David Njoku",    24),  # LAC, on IR -- still on LAC's page
    row("111",     "Stay Guy",       12),  # KC then and now
    row("777",     "Dark Page Guy",  2),   # BUF stamp, and BUF's page did not answer
]
CURRENT = {"15835": 0, "16731": 0, "14881": 0, "3123076": 24, "111": 12, "777": 2}
ROSTER_TEAMS = {"15835": "PHI", "16731": "SF", "3123076": "LAC", "111": "KC"}
ANSWERED = {"SF", "PHI", "WAS", "NYG", "LAC", "KC"}          # BUF's page failed

def assemble(rosters):
    err = io.StringIO()
    with redirect_stderr(err):
        recs = ep.assemble_records(POOL, {}, TEAMS, CURRENT, rosters)
    return {r["name"]: r["team"] for r in recs}, err.getvalue()
`;

test('R98: the official roster beats the fantasy map and last season', () => {
  const r = py(`${SETUP}
teams, err = assemble((ROSTER_TEAMS, ANSWERED))
print(json.dumps({"teams": teams, "err": err}))`);
  assert.equal(r.teams['Zach Ertz'], 'PHI', 'not WAS — the fantasy map read 0 and R33 kept last season');
  assert.equal(r.teams['Brandin Cooks'], 'SF', 'not BUF');
  assert.equal(r.teams['Stay Guy'], 'KC', 'a player who never moved is untouched');
  assert.match(r.err, /official roster moved: 2 — Brandin Cooks BUF->SF, Zach Ertz WAS->PHI/);
});

test('R98: a player no answering roster lists is dropped — cut and absent alike', () => {
  const r = py(`${SETUP}
teams, err = assemble((ROSTER_TEAMS, ANSWERED))
print(json.dumps({"teams": teams, "err": err}))`);
  assert.ok(!('Russell Wilson' in r.teams),
    'proTeamId 0 and on no roster: he must not be projected on NYG');
  assert.ok(!('Absent Guy' in r.teams), 'absent from the fantasy map and from every roster');
  assert.match(r.err, /dropped: on NO official NFL roster \(cut \/ unsigned \/ retired\): 2/);
  assert.match(r.err, /Russell Wilson \(NYG\)/);
});

test('R98: a roster page that did not answer proves nothing — the old stamp stays, named', () => {
  const r = py(`${SETUP}
teams, err = assemble((ROSTER_TEAMS, ANSWERED))
print(json.dumps({"teams": teams, "err": err}))`);
  assert.equal(r.teams['Dark Page Guy'], 'BUF',
    "BUF's page failed, so his absence from it is not evidence he left");
  assert.match(r.err, /kept UNVERIFIED: his team's roster page did not answer: 1 — Dark Page Guy \(BUF\)/);
});

test('R98: an injured player stays on the board — IR players are on their team page', () => {
  const r = py(`${SETUP}
teams, err = assemble((ROSTER_TEAMS, ANSWERED))
print(json.dumps({"teams": teams}))`);
  assert.equal(r.teams['David Njoku'], 'LAC');
});

test('R98: with no rosters passed, R33 is byte-for-byte unchanged', () => {
  const r = py(`${SETUP}
teams, err = assemble(None)
print(json.dumps({"teams": teams, "r98": "R98" in err}))`);
  assert.deepEqual(r.teams, {
    'Zach Ertz': 'WAS', 'Brandin Cooks': 'BUF', 'Russell Wilson': 'NYG', 'Absent Guy': 'NYG',
    'David Njoku': 'LAC', 'Stay Guy': 'KC', 'Dark Page Guy': 'BUF',
  });
  assert.equal(r.r98, false, 'no R98 line without rosters');
});

test('R98: only the LIVE build passes the rosters; backtest callers stay as they were', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts/scrape/espn_players.py'), 'utf8');
  assert.match(src, /ages, roster_teams, answered = fetch_rosters\(teams\)/);
  assert.match(src, /rosters = \(roster_teams, answered\) if current_season else None/,
    'a standalone/backtest caller (no current_season) must not have its pool re-stamped');
  assert.match(src, /return assemble_records\(pool, ages, teams, current, rosters\)/);
});

test('R98: fetch_rosters keeps the team and the answering set; fetch_roster_ages is unchanged', () => {
  const r = py(`
from scripts.scrape import espn_players as ep
from scripts.scrape.espn import FeedError
TEAMS = {f"T{i:02d}": {"espn_id": i} for i in range(32)}
def get_json(url):
    tid = int(url.rstrip("/roster").rsplit("/", 1)[-1])
    if tid == 22:
        raise FeedError("HTTP 404 (stub)")
    return {"athletes": [{"items": [{"id": f"{tid}-{n}", "age": 25} for n in range(53)]}]}
ages, teams, answered = ep.fetch_rosters(TEAMS, get_json=get_json)
only_ages = ep.fetch_roster_ages(TEAMS, get_json=get_json)
print(json.dumps({"n_teams": len(teams), "t05": teams.get("5-0"), "t22": teams.get("22-0"),
                  "answered": len(answered), "t22_answered": "T22" in answered,
                  "same_ages": only_ages == ages, "ages_is_dict": isinstance(only_ages, dict)}))`);
  assert.equal(r.n_teams, 31 * 53);
  assert.equal(r.t05, 'T05');
  assert.equal(r.t22, null, "a failed page contributes no team, never a guessed one");
  assert.equal(r.answered, 31);
  assert.equal(r.t22_answered, false);
  assert.equal(r.same_ages, true);
  assert.equal(r.ages_is_dict, true, 'fetch_roster_ages still returns the age map alone');
});
