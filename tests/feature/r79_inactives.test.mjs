/* tests/feature/r79_inactives.test.mjs — R79 GAME-DAY INACTIVES, the gate's
 * first source.
 *
 * R77 gated on injury status and the QB depth chart. Neither sees a healthy
 * scratch, an RB/WR/TE listed inactive without a report status, or a QB1 who
 * is a surprise inactive. ESPN's per-competition roster carries the posted
 * list as `didNotPlay`, keyed by the ESPN athlete id the projection pool
 * spells `espn-<id>` — an exact join, no name matching. This file locks:
 *
 *   espn.parse_game_roster            -> didNotPlay is the marker, ids exact
 *   build_predictions.games_in_inactive_window -> kickoff-3h until FINAL
 *   build_predictions._inactives_doc  -> one entry per game, failures recorded
 *   build_weekly.this_week_gate       -> reason `inactive` first; QB1 inactive
 *                                        promotes QB2; a bye / FINAL team is
 *                                        never gated; a list naming a team the
 *                                        pool disagrees with gates nobody
 *   validate_data                     -> rule 9 (no silent inactive), the
 *                                        inactive-reason orphan rule, the
 *                                        summary counts, the contract
 *   players.js gateTag                -> WK n · INACTIVE
 *
 * Node built-ins only; the Python cores run through `python3 -`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gateTag } from '../../app/views/players.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/* The R77 synthetic world plus a posted inactive list for the SFX @ DAL game
 * in week 3: DAL RB (healthy, no report row) and SFX QB One (the healthy
 * starter) are scratched. */
const SETUP = `
import json, sys, copy, datetime as dt
sys.path.insert(0, ".")
from scripts import availability as av
from scripts.build_weekly import (build_weekly_document, build_factors, inactive_ids,
                                  load_inactives, _fixture)
from scripts.scrape.espn import parse_game_roster
from scripts.build_predictions import games_in_inactive_window, _inactives_doc
SCHED_BY_TEAM, ELOS, SCHED = _fixture()
FX = lambda: build_factors(2026, None, None, None)
PROJ = [
  {"gsis_id": "espn-1", "name": "QB One",   "team": "SFX", "position": "QB", "proj_points": 300.0},
  {"gsis_id": "espn-2", "name": "QB Two",   "team": "SFX", "position": "QB", "proj_points": 120.0},
  {"gsis_id": "espn-3", "name": "QB Three", "team": "SFX", "position": "QB", "proj_points": 40.0},
  {"gsis_id": "espn-4", "name": "Hurt RB",  "team": "SFX", "position": "RB", "proj_points": 200.0},
  {"gsis_id": "espn-5", "name": "Q WR",     "team": "SFX", "position": "WR", "proj_points": 150.0},
  {"gsis_id": "espn-8", "name": "DAL QB",   "team": "DAL", "position": "QB", "proj_points": 250.0},
  {"gsis_id": "espn-9", "name": "DAL RB",   "team": "DAL", "position": "RB", "proj_points": 180.0},
]
DEPTH = {"season": 2026, "updated_utc": "2026-09-16T12:34:22Z", "source": "fixture",
  "positions": ["QB"], "counts": {"teams": 2, "rows": 4}, "teams": {
  "SFX": {"snapshot": "s", "QB": [
     {"rank": 1, "name": "QB One",   "gsis_id": None, "espn_id": "1"},
     {"rank": 2, "name": "QB Two",   "gsis_id": None, "espn_id": "2"},
     {"rank": 3, "name": "QB Three", "gsis_id": None, "espn_id": "3"}]},
  "DAL": {"snapshot": "s", "QB": [{"rank": 1, "name": "DAL QB", "gsis_id": None, "espn_id": "8"}]}}}
INJ = [
  {"team": "SFX", "player": "Hurt RB", "status": "Out"},
  {"team": "SFX", "player": "Q WR",    "status": "Questionable"},
]
INACT = {"season": 2026, "week": 3, "updated_utc": "2026-09-17T21:30:00Z",
  "source": "fixture", "window_hours": 3.0,
  "counts": {"games": 1, "failed": 0, "players": 3},
  "games": [{"game_id": "G3", "home": "DAL", "away": "SFX", "kickoff_utc": "2026-09-18T00:15Z",
             "status": "STATUS_SCHEDULED", "fetched_utc": "2026-09-17T21:30:00Z",
             "inactive": {"DAL": [{"espn_id": "9", "name": "D. RB"}],
                          "SFX": [{"espn_id": "1", "name": "Q. One"},
                                  {"espn_id": "4", "name": "H. RB"}]}}],
  "failed": []}
def build(inj=INJ, wk=3, depth=DEPTH, skip=(), proj=PROJ, inact=INACT):
    return build_weekly_document(proj, SCHED, ELOS, {}, 2026, "2026-09-17T21:30:00Z",
                                 injuries=inj, factors=FX(), this_week=wk,
                                 first_week=wk if wk else 1, depth_chart=depth,
                                 gate_skip_teams=skip, inactives=inact)
def by_id(doc):
    return {p["gsis_id"]: p for p in doc["players"]}
def wkrow(p, wk):
    return next(w for w in p["weeks"] if w["wk"] == wk)
def emit(obj):
    print(json.dumps(obj))
`;

/* 1 — the fetcher's parser ---------------------------------------------------- */

test('R79: parse_game_roster keeps didNotPlay entries only, by ESPN athlete id, sorted, never guessed', () => {
  const out = runPy(`${SETUP}
entries = [
  {"playerId": 100, "displayName": "Z. Last", "didNotPlay": True, "active": False},
  {"playerId": 7, "displayName": "A. First", "didNotPlay": True, "active": False},
  {"playerId": 8, "displayName": "Plays", "didNotPlay": False, "active": False},
  {"displayName": "No Id", "didNotPlay": True},
  {"playerId": "", "displayName": "Empty Id", "didNotPlay": True},
]
emit({"rows": parse_game_roster(entries), "empty": parse_game_roster([]), "none": parse_game_roster(None)})`);
  assert.deepEqual(out.rows, [{ espn_id: '7', name: 'A. First' }, { espn_id: '100', name: 'Z. Last' }]);
  assert.deepEqual(out.empty, [], 'a list not yet posted is empty, not an error');
  assert.deepEqual(out.none, []);
});

/* 2 — the window ----------------------------------------------------------------- */

test('R79: the inactives window opens at kickoff-3h, stays open while the game plays, and closes at FINAL', () => {
  const out = runPy(`${SETUP}
games = [
  {"game_id": "A", "home": "DAL", "away": "SFX", "kickoff_utc": "2026-09-18T00:15Z", "status": "STATUS_SCHEDULED"},
  {"game_id": "B", "home": "GBX", "away": "DAL", "kickoff_utc": "2026-09-20T17:00:00Z", "status": "STATUS_SCHEDULED"},
  {"game_id": "C", "home": "SFX", "away": "GBX", "kickoff_utc": "2026-09-17T17:00Z", "status": "STATUS_FINAL"},
  {"game_id": "D", "home": "SFX", "away": "GBX", "kickoff_utc": "not a date", "status": "STATUS_SCHEDULED"},
]
def at(s): return dt.datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.timezone.utc)
emit({"early": [g["game_id"] for g in games_in_inactive_window(games, at("2026-09-17T20:30Z"))],
      "open":  [g["game_id"] for g in games_in_inactive_window(games, at("2026-09-17T21:15Z"))],
      "live":  [g["game_id"] for g in games_in_inactive_window(games, at("2026-09-18T01:30Z"))],
      "sun":   [g["game_id"] for g in games_in_inactive_window(games, at("2026-09-20T14:30Z"))]})`);
  assert.deepEqual(out.early, [], '3h15m before kickoff: not yet');
  assert.deepEqual(out.open, ['A'], 'exactly 3h before: open');
  assert.deepEqual(out.live, ['A'], 'in progress: the list stays true');
  assert.deepEqual(out.sun, ['A', 'B'], 'a later game opens on its own clock; a game never marked FINAL stays open (only FINAL closes it); FINAL and unparseable never');
});

test('R79: _inactives_doc writes one entry per game in the window, records a failed fetch, and is None outside the window', () => {
  const out = runPy(`${SETUP}
games = [{"game_id": "A", "home": "DAL", "away": "SFX", "kickoff_utc": "2026-09-18T00:15Z", "status": "STATUS_SCHEDULED"},
         {"game_id": "B", "home": "GBX", "away": "DAL", "kickoff_utc": "2026-09-18T00:20Z", "status": "STATUS_SCHEDULED"}]
now = dt.datetime(2026, 9, 17, 22, 0, tzinfo=dt.timezone.utc)
def fetch(gid):
    if gid == "B":
        raise RuntimeError("boom")
    return {"home": "DAL", "away": "SFX", "inactive": {"DAL": [{"espn_id": "9", "name": "D. RB"}], "SFX": []}}
doc = _inactives_doc("2026-09-17T22:00:00Z", games, 3, now_utc=now, fetch=fetch)
swapped = _inactives_doc("t", games[:1], 3, now_utc=now, fetch=lambda g: {"home": "SFX", "away": "GBX", "inactive": {"SFX": [], "GBX": []}})
none = _inactives_doc("t", games, 3, now_utc=dt.datetime(2026, 9, 17, 12, 0, tzinfo=dt.timezone.utc), fetch=fetch)
emit({"counts": doc["counts"], "games": [g["game_id"] for g in doc["games"]],
      "failed": doc["failed"], "keys": list(doc), "week": doc["week"],
      "swapped_failed": swapped["failed"], "none": none})`);
  assert.deepEqual(out.counts, { games: 1, failed: 1, players: 1 });
  assert.deepEqual(out.games, ['A']);
  assert.deepEqual(out.failed, [{ game_id: 'B', error: 'boom' }]);
  assert.deepEqual(out.keys, ['season', 'week', 'updated_utc', 'source', 'window_hours', 'counts', 'games', 'failed']);
  assert.equal(out.week, 3);
  assert.match(out.swapped_failed[0].error, /ESPN teams SFX\/GBX != schedule DAL\/SFX/, 'a team mismatch is a failure, never a silent mis-attribution');
  assert.equal(out.none, null, 'no game in the window: nothing to state');
});

/* 3 — the gate ------------------------------------------------------------------ */

test('R79: the posted list gates first (any position, no report needed), QB1 inactive promotes QB2, and the file is stated in the summary', () => {
  const out = runPy(`${SETUP}
doc = build()
p = by_id(doc)
emit({"meta": doc["model"]["this_week"],
      "tw": {k: v.get("this_week") for k, v in p.items()},
      "wk3": {k: wkrow(v, 3)["pts"] for k, v in p.items()},
      "ids": inactive_ids(INACT, 3), "ids_other_week": inactive_ids(INACT, 4)})`);
  const m = out.meta;
  assert.deepEqual(m.by_reason, { inactive: 3, status: 0, depth: 1 });
  assert.equal(m.gated, 4);
  assert.equal(m.promoted, 1);
  assert.equal(m.inactives_fetched, '2026-09-17T21:30:00Z');
  // the healthy DAL RB: no report row, gated by the list alone
  assert.deepEqual(out.tw['espn-9'], { wk: 3, playable: false, reason: 'inactive', game_id: 'G3', points_lost: out.tw['espn-9'].points_lost });
  assert.ok(out.tw['espn-9'].points_lost > 0);
  assert.equal(out.wk3['espn-9'], 0);
  // Hurt RB is OUT and on the list: the list wins (reason inactive, status counted 0)
  assert.equal(out.tw['espn-4'].reason, 'inactive');
  // QB One is a surprise inactive: gated by the list; QB Two starts; QB Three still sits
  assert.equal(out.tw['espn-1'].reason, 'inactive');
  assert.deepEqual(out.tw['espn-2'], { wk: 3, playable: true, reason: 'depth_promoted', depth: 2, starter_out: 'QB One' });
  assert.ok(out.wk3['espn-2'] > 0);
  assert.equal(out.tw['espn-3'].reason, 'depth');
  assert.equal(out.tw['espn-3'].starter, 'QB Two');
  // the Q receiver is untouched
  assert.equal(out.tw['espn-5'], null);
  assert.ok(out.wk3['espn-5'] > 0);
  assert.deepEqual(out.ids, { 9: ['DAL', 'G3'], 1: ['SFX', 'G3'], 4: ['SFX', 'G3'] });
  assert.deepEqual(out.ids_other_week, {}, 'a list for another week gates nothing');
});

test('R79: no list -> R77 behaviour; a FINAL team, a bye, and a team mismatch are never gated by the list', () => {
  const out = runPy(`${SETUP}
plain = build(inact=None)
fin = build(skip=("SFX",))
wrong = copy.deepcopy(INACT); wrong["games"][0]["inactive"] = {"DAL": [{"espn_id": "1", "name": "QB One"}], "SFX": []}
mis = build(inact=wrong)
bye = build(wk=2)
emit({"plain": plain["model"]["this_week"], "plain_rb": by_id(plain)["espn-9"].get("this_week"),
      "fin": {k: (v.get("this_week") or {}).get("reason") for k, v in by_id(fin).items()},
      "mis": {k: (v.get("this_week") or {}).get("reason") for k, v in by_id(mis).items()},
      "bye": {k: (v.get("this_week") or {}).get("reason") for k, v in by_id(bye).items()}})`);
  assert.deepEqual(out.plain.by_reason, { inactive: 0, status: 1, depth: 2 });
  assert.equal(out.plain.inactives_fetched, null);
  assert.equal(out.plain_rb, null, 'the healthy DAL RB carries points without a list');
  assert.deepEqual(out.fin, { 'espn-1': null, 'espn-2': null, 'espn-3': null, 'espn-4': null, 'espn-5': null, 'espn-8': null, 'espn-9': 'inactive' },
    'SFX is FINAL: nothing on SFX is gated, the DAL list still applies');
  assert.equal(out.mis['espn-1'], null, 'the list says DAL, the pool says SFX: not ours to resolve');
  assert.equal(out.mis['espn-2'], 'depth', 'QB One stays the starter, QB Two stays gated');
  assert.equal(out.bye['espn-1'], null, 'SFX is on bye in week 2: nothing gated');
});

/* 4 — the validator and the contract -------------------------------------------- */

test('R79: a gated document round-trips through the validator + both contracts; the inactive orphan, a silent inactive and a count drift are caught', () => {
  const out = runPy(`${SETUP}
import os
from scripts.validate_data import (ValidationError, check_weekly_availability,
                                   validate_against_schema, _load)
schema = _load(os.path.join("data", "contracts", "player_weekly.schema.json"))
in_schema = _load(os.path.join("data", "contracts", "inactives.schema.json"))
inj_doc = {"injuries": [dict(r, availability=av.normalize_status(r["status"])) for r in INJ]}
proj_doc = {"players": PROJ}
RELABEL = {"SFX": "SF", "GBX": "GB"}
def real_teams(d):
    d = copy.deepcopy(d)
    for p in d["players"]:
        for w in p["weeks"]:
            w["opp"] = RELABEL.get(w["opp"], w["opp"])
    return d
doc = build()
check_weekly_availability(doc, proj_doc, inj_doc, depth_chart=DEPTH, inactives=INACT)
validate_against_schema(real_teams(doc), schema, "player_weekly.json")
validate_against_schema(INACT, in_schema, "inactives.json")
res = {"green": True}
def red(d, why, inact=INACT):
    try:
        check_weekly_availability(d, proj_doc, inj_doc, depth_chart=DEPTH, inactives=inact)
    except ValidationError as exc:
        return str(exc)
    raise AssertionError("not caught: " + why)
# orphan: an inactive claim the file does not back
res["orphan"] = red(copy.deepcopy(doc), "inactive reason without the list", inact=None)
# silent inactive: the list names DAL RB but his gate was dropped
d = copy.deepcopy(doc); p = by_id(d)["espn-9"]; del p["this_week"]
w = wkrow(p, 3); del w["avail"]; w["pts"] = 30.0
d["model"]["this_week"]["gated"] = 3; d["model"]["this_week"]["by_reason"]["inactive"] = 2
res["silent"] = red(d, "list names him but wk3 is not gated")
# game_id drift
d = copy.deepcopy(doc); by_id(d)["espn-9"]["this_week"]["game_id"] = "G9"
res["game_drift"] = red(d, "this_week.game_id != the list's game")
# count drift
d = copy.deepcopy(doc); d["model"]["this_week"]["by_reason"]["inactive"] = 1
res["count_drift"] = red(d, "by_reason.inactive != rows")
# a pre-R79 document (no inactive key in by_reason) still validates
d = copy.deepcopy(build(inact=None)); del d["model"]["this_week"]["by_reason"]["inactive"]; del d["model"]["this_week"]["inactives_fetched"]
check_weekly_availability(d, proj_doc, inj_doc, depth_chart=DEPTH, inactives=None)
validate_against_schema(real_teams(d), schema, "player_weekly.json")
res["pre_r79_ok"] = True
# the contract rejects a list entry without an espn_id
bad = copy.deepcopy(INACT); del bad["games"][0]["inactive"]["DAL"][0]["espn_id"]
try:
    validate_against_schema(bad, in_schema, "inactives.json"); res["schema_red"] = False
except ValidationError:
    res["schema_red"] = True
emit(res)`);
  assert.equal(out.green, true);
  assert.match(out.orphan, /reason inactive but data\/inactives\.json does not name him/);
  assert.match(out.silent, /on the posted inactive list but wk3 is not gated/);
  assert.match(out.game_drift, /this_week\.game_id 'G9'/);
  assert.match(out.count_drift, /model\.this_week says/);
  assert.equal(out.pre_r79_ok, true);
  assert.equal(out.schema_red, true);
});

/* 5 — the app ------------------------------------------------------------------- */

test('R79: the PLAYERS headline reads WK n · INACTIVE with a spelled-out title', () => {
  assert.deepEqual(gateTag({ wk: 2, playable: false, reason: 'inactive', game_id: 'G', points_lost: 9.1 }),
    ['INACTIVE', 'Not playable this week — on the posted game-day inactive list']);
  assert.equal(gateTag({ wk: 2, playable: true, reason: 'inactive' }), null, 'playable is never tagged inactive');
});
