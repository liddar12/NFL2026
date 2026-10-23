// Lean pilot, checkpoint 1 — official inactive confirmation + T-90 withholding
// (scripts/inactive_confirmation.py). Shadow only: the module is pure, nothing
// in the pipeline, workflows or app references it, and the pilot is disabled.
//
// Acceptance, per the owner (2026-10-19): distinguish confirmed active,
// confirmed inactive and unknown/stale; withhold provisional props at T-90
// until VALID confirmation; never treat an empty or failed feed — or ESPN's
// didNotPlay flags — as confirmation; unknown stays unknown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: ROOT, input: code, encoding: 'utf8', env: { ...process.env, PYTHONPATH: ROOT },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const PRELUDE = `
import json, datetime as dt
from scripts import inactive_confirmation as ic
T = lambda s: dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
G = {"game_id": "401873008", "home": "SF", "away": "WAS", "kickoff_utc": "2026-10-20T00:15Z"}
REG = frozenset({"test_official_v1"})
def ev(**kw):
    base = {"source_profile": "test_official_v1", "game_id": "401873008", "home": "SF", "away": "WAS",
            "kickoff_utc": "2026-10-20T00:15Z", "team": "SF", "posted_utc": "2026-10-19T22:46:00Z",
            "fetched_utc": "2026-10-19T22:50:00Z", "complete": True,
            "inactive_ids": ["3126486", "111"], "active_ids": ["222", "333"], "raw_sha256": "a" * 64}
    base.update(kw)
    return {k: v for k, v in base.items() if v != "__drop__"}
`;

test('the clock: provisional before T-90, withheld (unknown) from T-90 without evidence, closed at kickoff', () => {
  const r = runPy(`${PRELUDE}
out = {}
for label, now in [("t90_minus_1s", "2026-10-19T22:44:59Z"), ("t90", "2026-10-19T22:45:00Z"),
                   ("kick_minus_1s", "2026-10-20T00:14:59Z"), ("kick", "2026-10-20T00:15:00Z"),
                   ("after", "2026-10-20T03:00:00Z")]:
    out[label] = ic.player_state("222", "SF", G, T(now), [], REG)
print(json.dumps(out))`);
  assert.deepEqual(r.t90_minus_1s, ['provisional', 'before_checkpoint']);
  assert.deepEqual(r.t90, ['unknown_or_stale', 'no_evidence']);
  assert.deepEqual(r.kick_minus_1s, ['unknown_or_stale', 'no_evidence']);
  assert.deepEqual(r.kick, ['closed', 'kicked_off']);
  assert.deepEqual(r.after, ['closed', 'kicked_off']);
});

test('valid official evidence distinguishes confirmed active, confirmed inactive and not listed', () => {
  const r = runPy(`${PRELUDE}
now = T("2026-10-19T22:55:00Z")
print(json.dumps({pid: ic.player_state(pid, "SF", G, now, [ev()], REG) for pid in ("3126486", "222", "999")}))`);
  assert.deepEqual(r['3126486'], ['confirmed_inactive', 'official_inactive']);
  assert.deepEqual(r['222'], ['confirmed_active', 'official_active']);
  assert.deepEqual(r['999'], ['unknown_or_stale', 'not_on_official_lists']);
});

test('every refusal is named and leaves the player unknown — never confirmed', () => {
  const r = runPy(`${PRELUDE}
now = T("2026-10-19T22:55:00Z")
cases = {
  "unregistered_source":   ev(source_profile="someone_else_v1"),
  "observation_only_source": ev(source_profile="espn_core_roster_didnotplay_v1"),
  "game_identity_mismatch/game_id": ev(game_id="401873007"),
  "game_identity_mismatch/home": ev(home="WAS"),
  "game_identity_mismatch/kickoff": ev(kickoff_utc="2026-10-20T00:15:00Z"),
  "team_not_in_game":      ev(team="DAL"),
  "outside_window/posted_before_t90": ev(posted_utc="2026-10-19T22:44:00Z"),
  "outside_window/fetched_after_kick": ev(fetched_utc="2026-10-20T00:16:00Z"),
  "future_evidence":       ev(fetched_utc="2026-10-19T22:56:00Z"),
  "lease_expired":         (ev(fetched_utc="2026-10-19T22:50:00Z"), T("2026-10-19T23:05:01Z")),
  "incomplete_list/false": ev(complete=False),
  "incomplete_list/string": ev(complete="true"),
  "incomplete_list/missing": ev(complete="__drop__"),
  "empty_list/inactive":   ev(inactive_ids=[]),
  "empty_list/active":     ev(active_ids=[]),
  "ids_malformed/int":     ev(inactive_ids=[3126486]),
  "ids_malformed/alpha":   ev(active_ids=["abc"]),
  "ids_malformed/dup":     ev(active_ids=["222", "222"]),
  "lists_overlap":         ev(active_ids=["222", "111"]),
  "raw_evidence_missing":  ev(raw_sha256=None),
  "clock_malformed":       ev(fetched_utc="yesterday"),
}
out = {}
for label, e in cases.items():
    e, at = e if type(e) is tuple else (e, now)
    ok, reason = ic.validate_evidence(e, G, at, REG)
    out[label] = [ok, reason, ic.player_state("222", e.get("team", "SF"), G, at, [e], REG)[0]]
print(json.dumps(out))`);
  for (const [label, [ok, reason, state]] of Object.entries(r)) {
    assert.equal(ok, false, label);
    assert.equal(reason, label.split('/')[0], label);
    assert.ok(state === 'unknown_or_stale', `${label}: ${state}`);
  }
});

test('the 15-minute lease: exactly 15 min still confirms, one second more does not', () => {
  const r = runPy(`${PRELUDE}
e = ev(posted_utc="2026-10-19T22:45:00Z", fetched_utc="2026-10-19T22:50:00Z")
print(json.dumps([ic.player_state("222", "SF", G, T(t), [e], REG) for t in ("2026-10-19T23:05:00Z", "2026-10-19T23:05:01Z")]))`);
  assert.deepEqual(r[0], ['confirmed_active', 'official_active']);
  assert.deepEqual(r[1], ['unknown_or_stale', 'lease_expired']);
});

test('two valid lists that disagree leave the player unknown; the other team list never applies', () => {
  const r = runPy(`${PRELUDE}
now = T("2026-10-19T22:55:00Z")
a = ev(fetched_utc="2026-10-19T22:50:00Z")
b = ev(fetched_utc="2026-10-19T22:52:00Z", inactive_ids=["222"], active_ids=["3126486", "333"])
other = ev(team="WAS", inactive_ids=["777"], active_ids=["222"])
print(json.dumps({"conflict": ic.player_state("222", "SF", G, now, [a, b], REG),
                  "other_team_only": ic.player_state("222", "SF", G, now, [other], REG)}))`);
  assert.deepEqual(r.conflict, ['unknown_or_stale', 'conflicting_evidence']);
  assert.deepEqual(r.other_team_only, ['unknown_or_stale', 'no_evidence']);
});

test('production registry is EMPTY: on the real pool inside T-90 nothing confirms and every rung is withheld', () => {
  const r = runPy(`${PRELUDE}
pool = json.load(open("data/leg_pool.json"))
sched = json.load(open("data/schedule_full.json"))
games = [g for g in sched["games"] if g["week"] == pool["week"]]
g0 = sorted([g for g in games if any(p["game_id"] == g["game_id"] for p in pool["players"])],
            key=lambda g: g["kickoff_utc"])[0]
now = ic.checkpoint(g0) + dt.timedelta(minutes=10)
a = ic.assess(pool, games, now, {g0["game_id"]: [ev(game_id=g0["game_id"], home=g0["home"], away=g0["away"],
              kickoff_utc=g0["kickoff_utc"], team=g0["home"], source_profile="espn_core_roster_didnotplay_v1")]})
inwin = [p for p in a["players"] if p["game_id"] == g0["game_id"]]
print(json.dumps({"registry": a["registered_official_sources"], "serving_applied": a["serving_applied"],
  "in_window_states": sorted({p["state"] for p in inwin}), "in_window_reasons": sorted({p["reason"] for p in inwin}),
  "n_in_window": len(inwin), "rungs": a["rungs"], "kind": a["kind"], "policy_id": a["policy_id"]}))`);
  assert.deepEqual(r.registry, []);
  assert.equal(r.serving_applied, false);
  assert.ok(r.n_in_window > 0, 'the chosen game has pool players');
  assert.deepEqual(r.in_window_states, ['unknown_or_stale']);
  assert.ok(r.in_window_reasons.every((x) => ['observation_only_source', 'no_evidence', 'player_id_not_espn'].includes(x)),
    JSON.stringify(r.in_window_reasons));
  assert.ok(r.rungs.withheld > 0);
  assert.match(r.policy_id, /^sha256:[0-9a-f]{64}$/);
});

test('ESPN didNotPlay observations (data/inactives.json shape) are recorded but never confirm, even inside the window', () => {
  const r = runPy(`${PRELUDE}
doc = {"games": [{"game_id": "401873008", "home": "SF", "away": "WAS", "kickoff_utc": "2026-10-20T00:15Z",
                  "fetched_utc": "2026-10-19T22:50:00Z",
                  "inactive": {"SF": [{"espn_id": "3126486", "name": "D. Samuel"}], "WAS": []}}]}
obs = ic.espn_observations(doc)["401873008"]
now = T("2026-10-19T22:55:00Z")
# even if someone registered the observation profile by mistake, the record lacks a
# posting time, completeness and an active list, so it still cannot confirm
leaky = frozenset({"espn_core_roster_didnotplay_v1"})
print(json.dumps({"n": len(obs), "profiles": sorted({o["source_profile"] for o in obs}),
  "prod": [ic.validate_evidence(o, G, now)[1] for o in obs],
  "if_registered": [ic.validate_evidence(o, G, now, leaky)[1] for o in obs],
  "state_empty_was": ic.player_state("444", "WAS", G, now, obs)}))`);
  assert.equal(r.n, 2);
  assert.deepEqual(r.profiles, ['espn_core_roster_didnotplay_v1']);
  assert.deepEqual(r.prod, ['observation_only_source', 'observation_only_source']);
  assert.ok(r.if_registered.every((x) => x && x !== null), JSON.stringify(r.if_registered));
  assert.deepEqual(r.state_empty_was, ['unknown_or_stale', 'observation_only_source']);
});

test('withhold() returns a new pool with only offerable players and never mutates its input', () => {
  const r = runPy(`${PRELUDE}
pool = {"players": [{"gsis_id": "espn-222", "team": "SF", "game_id": "401873008", "rungs": [{"line": 1}]},
                    {"gsis_id": "espn-3126486", "team": "SF", "game_id": "401873008", "rungs": [{"line": 2}]},
                    {"gsis_id": "espn-999", "team": "SF", "game_id": "401873008", "rungs": [{"line": 3}]}]}
before = json.dumps(pool, sort_keys=True)
a = ic.assess(pool, [G], T("2026-10-19T22:55:00Z"), {"401873008": [ev()]}, REG)
w = ic.withhold(pool, a)
print(json.dumps({"kept": [p["gsis_id"] for p in w["players"]], "unchanged": json.dumps(pool, sort_keys=True) == before,
                  "rungs": a["rungs"], "counts": a["state_counts"]}))`);
  assert.deepEqual(r.kept, ['espn-222']);
  assert.equal(r.unchanged, true);
  assert.deepEqual(r.rungs, { offered: 1, withheld: 2 });
  assert.equal(r.counts.confirmed_active, 1);
  assert.equal(r.counts.confirmed_inactive, 1);
  assert.equal(r.counts.unknown_or_stale, 1);
});

test('pilot config: disabled, shadow serving, engine pinned to aacb19c7; the reader refuses anything else', () => {
  const r = runPy(`
import json, os, tempfile
from scripts import pilot_config as pc
ok = pc.resolve("config/selflearning_pilot.json", {})
def refused(doc=None, env=None):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(doc or json.load(open("config/selflearning_pilot.json")), f)
    try:
        pc.resolve(f.name, env or {}); return False
    except Exception:
        return True
    finally:
        os.unlink(f.name)
base = json.load(open("config/selflearning_pilot.json"))
print(json.dumps({"ok": ok,
  "live_mode": refused({**base, "serving_mode": "live"}),
  "old_profile": refused({**base, "freshness_profile": "provisional_before_90m_v1"}),
  "half_override": refused(env={"SELFLEARN_NFL_PILOT_ENABLED": "1"}),
  "extra_key": refused({**base, "authority_id": "x"}),
  "short_sha": refused({**base, "engine_commit": "aacb19c7"})}))`);
  assert.equal(r.ok.enabled, '0');
  assert.equal(r.ok.serving_mode, 'shadow');
  assert.equal(r.ok.engine_commit, 'aacb19c73122f257449e977df40f2a2733991b2f');
  assert.equal(r.ok.freshness_profile, 'confirmed_inactives_v1');
  for (const k of ['live_mode', 'old_profile', 'half_override', 'extra_key', 'short_sha']) assert.equal(r[k], true, k);
});

test('production is unchanged: only listed offline tools and the locked test-only canary may reference pilot modules', () => {
  const hits = [];
  // Checkpoint 2 adds standalone offline tools, not a production caller. The
  // owner separately authorized ONE test-only canary workflow, whose read-only
  // command/checkout contract is locked by pilot_canary_workflow.test.mjs.
  const offline = new Set([
    'inactive_confirmation.py', 'pilot_config.py', 'pilot_capture.py',
    'learning_journal.py', 'export_learning.py', 'capture_outcome_evidence.py',
    'run_parlay_feedback.py', 'learning_history_guard.py',
  ].map(name => join('scripts', name)));
  const pilotReferences = /inactive_confirmation|pilot_config|selflearning_pilot|pilot_capture|learning_journal|export_learning|capture_outcome_evidence|run_parlay_feedback|learning_history_guard/;
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name);
      if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (!/\.(js|mjs|py|ya?ml|sh|html)$/.test(name)) continue;
      if (offline.has(rel) || rel === join('.github', 'workflows', 'selflearning-canary.yml')) continue;
      const src = readFileSync(join(ROOT, rel), 'utf8');
      if (pilotReferences.test(src)) hits.push(rel);
    }
  };
  for (const d of ['.github', 'app', 'scripts']) walk(d);
  assert.ok(!pilotReferences.test(readFileSync(join(ROOT, 'index.html'), 'utf8')));
  assert.deepEqual(hits, []);
});

/* ---------------------------------------- Codex review of #184 (2026-10-20) */

test('malformed source_profile values are a named refusal, never a crash', () => {
  const r = runPy(`${PRELUDE}
now = T("2026-10-19T22:55:00Z")
out = {}
for label, prof in (("list", []), ("dict", {}), ("int", 5), ("none", None), ("bool", True)):
    out[label] = [ic.validate_evidence(ev(source_profile=prof), G, now, REG)[1],
                  ic.player_state("222", "SF", G, now, [ev(source_profile=prof)], REG)]
print(json.dumps(out))`);
  for (const [label, [reason, state]] of Object.entries(r)) {
    assert.equal(reason, 'source_profile_malformed', label);
    assert.deepEqual(state, ['unknown_or_stale', 'source_profile_malformed'], label);
  }
});

test('ESPN never confirms: an enriched, complete ESPN record fails even when a caller registers the ESPN profile', () => {
  const r = runPy(`${PRELUDE}
now = T("2026-10-19T22:55:00Z")
leaky = frozenset({"espn_core_roster_didnotplay_v1", "test_official_v1"})
enriched = ev(source_profile="espn_core_roster_didnotplay_v1")   # every other field valid and complete
print(json.dumps({"validate": ic.validate_evidence(enriched, G, now, leaky),
                  "active": ic.player_state("222", "SF", G, now, [enriched], leaky),
                  "inactive": ic.player_state("3126486", "SF", G, now, [enriched], leaky),
                  "control": ic.player_state("222", "SF", G, now, [ev()], leaky)}))`);
  assert.deepEqual(r.validate, [false, 'observation_only_source']);
  assert.deepEqual(r.active, ['unknown_or_stale', 'observation_only_source']);
  assert.deepEqual(r.inactive, ['unknown_or_stale', 'observation_only_source']);
  assert.deepEqual(r.control, ['confirmed_active', 'official_active'], 'a registered official record still confirms');
});

test('assess() stays total: missing kickoff and malformed rows are named per player; unaffected players are still assessed', () => {
  const r = runPy(`${PRELUDE}
now = T("2026-10-19T22:55:00Z")
NOKICK = {"game_id": "g2", "home": "DAL", "away": "GB"}           # kickoff missing
pool = {"players": [
  {"gsis_id": "00-0036", "team": "DAL", "game_id": "g2", "rungs": [{}]},      # non-ESPN, no kickoff (Codex's crash)
  {"gsis_id": "espn-555", "team": "GB", "game_id": "g2", "rungs": [{}]},      # ESPN, no kickoff
  {"gsis_id": "espn-222", "team": "SF", "game_id": "401873008", "rungs": [{}, {}]},   # unaffected, confirmed
  {"gsis_id": "espn-abc", "team": "SF", "game_id": "401873008", "rungs": "x"},        # malformed id + rungs
  "not a player", None, 7]}
a = ic.assess(pool, [G, NOKICK, "junk", None], now, {"401873008": [ev()], "g2": "not a list"}, REG)
print(json.dumps({"players": [[p["gsis_id"], p["state"], p["reason"]] for p in a["players"]],
                  "malformed": a["malformed_players"], "rungs": a["rungs"],
                  "games": [[g["game_id"], g["checkpoint_utc"]] for g in a["games"]],
                  "withheld_kept": [p["gsis_id"] for p in ic.withhold(pool, a)["players"]],
                  "junk_evidence": [[p["gsis_id"], p["reason"]] for p in ic.assess(pool, [G], now, "junk", REG)["players"]
                                    if p["game_id"] == "401873008"]}))`);
  assert.deepEqual(r.players, [
    ['00-0036', 'unknown_or_stale', 'kickoff_unknown'],
    ['espn-555', 'unknown_or_stale', 'kickoff_unknown'],
    ['espn-222', 'confirmed_active', 'official_active'],
    ['espn-abc', 'unknown_or_stale', 'player_id_not_espn'],
  ]);
  assert.equal(r.malformed, 3);
  assert.deepEqual(r.rungs, { offered: 2, withheld: 2 });
  assert.deepEqual(r.games, [['401873008', '2026-10-19T22:45:00Z'], ['g2', null]]);
  assert.deepEqual(r.withheld_kept, ['espn-222']);
  // a non-mapping evidence_by_game is no evidence, not a crash
  assert.deepEqual(r.junk_evidence, [['espn-222', 'no_evidence'], ['espn-abc', 'player_id_not_espn']]);
});

test('every evidence field accepts any JSON type without raising: refusal or confirmation, never an exception', () => {
  const r = runPy(`${PRELUDE}
now = T("2026-10-19T22:55:00Z")
bad = [None, [], {}, 5, 1.5, True, "x", ["111"], {"a": 1}]
fields = ["source_profile", "game_id", "home", "away", "kickoff_utc", "team", "posted_utc", "fetched_utc",
          "complete", "inactive_ids", "active_ids", "raw_sha256"]
crashes, confirmed = [], []
for f in fields:
    for v in bad:
        e = ev(**{f: v})
        try:
            ok, reason = ic.validate_evidence(e, G, now, REG)
            st = ic.player_state("222", "SF", G, now, [e], REG)
            if ok:
                confirmed.append([f, repr(v)])
        except Exception as exc:
            crashes.append([f, repr(v), repr(exc)])
for g in (None, [], {}, {"kickoff_utc": 5}, {"kickoff_utc": "soon"}):
    try:
        ic.player_state("222", "SF", g, now, [ev()], REG)
    except Exception as exc:
        crashes.append(["game", repr(g), repr(exc)])
print(json.dumps({"crashes": crashes, "confirmed": confirmed}))`);
  assert.deepEqual(r.crashes, []);
  // the only substitutions that leave a record valid are the fixture's own values:
  // complete=True and the inactive list ['111']; every other type is refused
  assert.deepEqual(r.confirmed, [['complete', 'True'], ['inactive_ids', "['111']"]]);
});
