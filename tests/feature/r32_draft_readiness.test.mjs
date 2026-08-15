/* tests/feature/r32_draft_readiness.test.mjs — R33 draft-readiness pass, five days out.
 *
 * THE ROOT CAUSE (task 1). data/player_projections.json stamped `team` from the
 * PRIOR season's kona pull, whose player objects are frozen at that season's
 * rosters. Every offseason mover therefore showed his old team in the app, got
 * the wrong 2026 bye/schedule split, seeded props for the wrong slate, and broke
 * the (team, name) injury join — the incident R32 papered over with a name-only
 * fallback. The fix: espn_players.fetch_current_pro_teams pulls the DRAFT
 * season's id->proTeamId map and assemble_records stamps `team` from it, falling
 * back to the historical id ONLY when the current one is missing/unmapped, and
 * loudly (stderr count) when it does.
 *
 * The player ids and proTeamIds below are REAL, verified live 2026-08-15 against
 * both kona endpoints: seasons/2025 returns Evans 27 (TB) / Kirk 34 (HOU) /
 * Waller 15 (MIA) — exactly the stale teams in the committed pool — while
 * seasons/2026 returns 25 (SF) / 25 (SF) / 29 (CAR). The committed fixtures
 * carry neither espn team ids nor any kona payload, so this test drives the pure
 * assembly step (assemble_records) with those verified values rather than
 * pretending an offline fetch happened.
 *
 * Also pinned here (tasks 2-3): the kalshi zero-row status logic both layers
 * deep, the espn_results_2026 "why is this 0" note, and validate_data's rule-4
 * copy of the R32 name fallback (with both ambiguity guards).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** Run a python3 snippet from the repo root; parse the single JSON line it prints. */
function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    input: code,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

/* Shared fixture: verified-live ids. Teams map shape = espn.fetch_teams() output
 * (only espn_id is read by assemble_records). Pool rows carry the PRIOR-season
 * proTeamId exactly as fetch_fantasy_pool(2025) returns them. */
const SETUP = `
import io, json, sys
from contextlib import redirect_stderr
sys.path.insert(0, ".")
from scripts.scrape import espn_players as ep

TEAMS = {ab: {"espn_id": i} for ab, i in
         {"SF": 25, "TB": 27, "CAR": 29, "MIA": 15, "HOU": 34, "KC": 12}.items()}

def pool_row(eid, name, pro_team_id):
    return {"espn_id": eid, "name": name, "position": "WR",
            "pro_team_id": pro_team_id, "injury_status": None,
            "prior_season_points": 100.0, "receptions": 50.0,
            "completions": 0.0, "pass_attempts": 0.0}

POOL = [
    pool_row("16737",   "Mike Evans",     27),  # 2025: TB
    pool_row("3895856", "Christian Kirk", 34),  # 2025: HOU
    pool_row("2576925", "Darren Waller",  15),  # 2025: MIA
    pool_row("111",     "Stay Guy",       12),  # KC then, KC now
    pool_row("222",     "Absent Guy",     27),  # not in the current-season pool
    pool_row("333",     "Cut Guy",        15),  # current proTeamId 0 = free agent
]
CURRENT = {"16737": 25, "3895856": 25, "2576925": 29, "111": 12, "333": 0}

def assemble(current):
    err = io.StringIO()
    with redirect_stderr(err):
        recs = ep.assemble_records(POOL, {}, TEAMS, current)
    return {r["name"]: r["team"] for r in recs}, err.getvalue()
`;

test('the three movers stamp their CURRENT team from the current-season map', () => {
  const r = runPy(`${SETUP}
teams, err = assemble(CURRENT)
print(json.dumps({"teams": teams, "err": err}))
`);
  // The R32 incident trio, by the verified current ids: never TB/HOU/MIA again.
  assert.equal(r.teams['Mike Evans'], 'SF');
  assert.equal(r.teams['Christian Kirk'], 'SF');
  assert.equal(r.teams['Darren Waller'], 'CAR');
  assert.equal(r.teams['Stay Guy'], 'KC', 'a non-mover must be unaffected');
});

test('the historical team is a FALLBACK only, and every fallback is loud on stderr', () => {
  const r = runPy(`${SETUP}
teams, err = assemble(CURRENT)
print(json.dumps({"teams": teams, "err": err}))
`);
  // Absent from the current pool -> keeps the prior team rather than vanishing.
  assert.equal(r.teams['Absent Guy'], 'TB');
  // Currently a free agent (proTeamId 0, unmapped) -> same fallback, same reason.
  assert.equal(r.teams['Cut Guy'], 'MIA');
  // Both fallbacks are COUNTED AND NAMED on stderr — a silent fallback is how the
  // original defect stayed invisible for a season.
  assert.match(r.err, /fell back to the PRIOR-season team for 2 player\(s\)/);
  assert.match(r.err, /Absent Guy/);
  assert.match(r.err, /Cut Guy/);
});

test('without a current-team map the old behaviour is byte-for-byte intact', () => {
  // The R32 apply_to_records discipline: standalone/backtest callers that do not
  // pass the map must see exactly the pre-R33 records — stale teams and all.
  const r = runPy(`${SETUP}
teams, err = assemble(None)
print(json.dumps({"teams": teams, "err": err}))
`);
  assert.deepEqual(r.teams, {
    'Mike Evans': 'TB', 'Christian Kirk': 'HOU', 'Darren Waller': 'MIA',
    'Stay Guy': 'KC', 'Absent Guy': 'TB', 'Cut Guy': 'MIA',
  });
  assert.equal(r.err, '', 'no map means no fallback warnings — nothing changed');
});

test('build_predictions actually wires current_season into the live pipeline', () => {
  // The guarantee above is worthless if the one real caller keeps the old call.
  const bp = read('scripts/build_predictions.py');
  assert.match(bp,
    /build_player_records\(PRIOR_SEASON,\s*teams,\s*\n?\s*current_season=SEASON\)/,
    'build_predictions must pass current_season=SEASON, or the shipped pool keeps '
    + "last season's teams and the whole R33 fix is a dead code path");
});

test('R32 name-fallback stays in place as the safety net (not removed by R33)', () => {
  const bw = read('scripts/build_weekly.py');
  const bp = read('scripts/build_predictions.py');
  assert.match(bw, /lookup_report|by_name/,
    'build_weekly must keep the name-only fallback for the drift window');
  assert.match(bp, /index_report_by_name/,
    'the projection path must keep the name-only fallback too');
});

/* ==========================================================================
   TASK 2 — kalshi zero-row status, both layers, driven not assumed
   ========================================================================== */

test('kalshi-shaped ok/0 input comes out degraded on the next run (R30b logic)', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.build_predictions import market_feed_record
from scripts.build_markets import source_record

shipped = json.load(open("data/market_prices.json"))["sources"]["kalshi"]
out = {
  # Layer 1: the builder itself refuses ok on 0 rows.
  "builder": source_record(0),
  # Layer 2: belt-and-braces in build_predictions, driven with the EXACT source
  # block shipped in the committed (pre-R30b) market_prices.json.
  "shipped_block": market_feed_record(shipped, "2026-08-15T00:00:00Z"),
  "shipped_rows": shipped.get("rows"),
}
print(json.dumps(out))
`);
  assert.equal(r.builder.status, 'degraded',
    'build_markets.source_record must refuse ok for a 0-row kalshi pull');
  assert.ok(r.builder.note, 'and must say why');
  // The committed market_prices.json really is the pre-R30b shape (ok, rows 0) —
  // if a future refresh changes it, this test still proves the mapping holds.
  if (r.shipped_rows === 0) {
    assert.equal(r.shipped_block.status, 'degraded',
      'the shipped ok/0 kalshi block must map to degraded, never ride through as ok');
    assert.ok(r.shipped_block.note,
      'the downgrade must carry a reason the MODEL tab can show');
  }
});

test('pipeline_status contract accepts the new note field (R29 lesson: declare it)', () => {
  const schema = JSON.parse(read('data/contracts/pipeline_status.schema.json'));
  const feed = schema.properties.feeds.additionalProperties;
  assert.equal(feed.additionalProperties, false,
    'strict by design — which is exactly why note must be declared here');
  assert.equal(feed.properties.note.type, 'string');
  assert.ok(!(feed.required || []).includes('note'),
    'note is optional: absent when there is nothing to explain');
});

test('espn_results_2026 explains a zero instead of shipping silent ok/0', () => {
  const bp = read('scripts/build_predictions.py');
  assert.match(bp, /if not finals_cur:/,
    'the zero-finals case must be handled explicitly');
  assert.match(bp, /0 regular-season finals[\s\S]{0,200}excluded by design/,
    'the note must state BOTH facts: season not started, preseason excluded by '
    + 'design — preseason results never feed Elo, actuals, or scoring');
});

/* ==========================================================================
   validate_data rule 4 mirrors the R32 fallback (or the gate reds on honesty)
   ========================================================================== */

test('rule 4 accepts a mover matched by unique report name, guards both ambiguities', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts import validate_data as vd

def outcome(mutate):
    w, p, i = vd._fixture(blocked=4, weeks_out=4)
    p["players"][0]["team"] = "TB"   # the pool lags; the SF report row stands
    mutate(w, p, i)
    try:
        vd.check_weekly_availability(w, p, i)
        return "ok"
    except vd.ValidationError:
        return "red"

out = {
  "mover": outcome(lambda w, p, i: None),
  "two_report_teams": outcome(lambda w, p, i: i["injuries"].append(
      {"team": "DAL", "player": "AJ Hurt", "status": "Questionable",
       "availability": "QUESTIONABLE"})),
  "dup_pool_name": outcome(lambda w, p, i: p["players"].append(
      {"gsis_id": "espn-2", "name": "A.J. Hurt", "team": "GB",
       "proj_points": 50.0})),
}
print(json.dumps(out))
`);
  assert.equal(r.mover, 'ok',
    'an honest availability block joined by the R32 fallback must not red the gate');
  assert.equal(r.two_report_teams, 'red',
    'a report name on two teams is ambiguous — matching either would stamp a guess');
  assert.equal(r.dup_pool_name, 'red',
    'a pool-duplicated name never falls back — a wrong injury is worse than a missed one');
});
