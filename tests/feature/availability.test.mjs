/* tests/feature/availability.test.mjs — Rel17 BUILD-A: the pipeline half of player
 * availability (scripts/availability.py, scripts/injury_duration.py,
 * scripts/build_weekly.py, scripts/scrape/espn.py).
 *
 * Drives the PURE python through `python3 -` (the weekly_injury.test.mjs pattern:
 * python3 is already a fast-gate dependency, no network, no committed-data churn),
 * plus a handful of direct reads of the committed data files.
 *
 * WHAT THIS PROTECTS, in league terms:
 *   - a player on IR does not sit at the top of my start/sit list as if he were
 *     healthy (F1/F3), and his season projection is not still 100% of a full year
 *     he will not play (F2);
 *   - a player who is merely QUESTIONABLE keeps his full season total — a Wednesday
 *     practice designation is not an IR stash, and treating it as one would be a new
 *     bug, not a fix;
 *   - the tool never invents a return date. "Out 6-12 months" per one report becomes
 *     "at least 4 weeks, league minimum", never "back in week 9";
 *   - the bye week and the missing-on-IR week stay distinguishable, so the lineup
 *     card can say BYE for one and IR for the other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

const read = (rel) =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const SETUP = `
import json, sys
sys.path.insert(0, ".")
from scripts import availability as av
from scripts import injury_duration as dur
from scripts import build_weekly as bw

def g(wk, home, away):
    return {"week": wk, "home": home, "away": away}

# SFX plays weeks 1, 3, 4, 5, 6 -- week 2 is a BYE, so a 2-week absence must block
# weeks 1 and 3, not weeks 1 and 2.
SCHED = [g(1, "SFX", "DAL"), g(2, "DAL", "GBX"), g(3, "DAL", "SFX"),
         g(4, "SFX", "GBX"), g(5, "GBX", "SFX"), g(6, "SFX", "DAL")]
PROJ = [
    {"gsis_id": "p1", "name": "Hurt Guy", "team": "SFX", "proj_points": 200.0},
    {"gsis_id": "p2", "name": "Fine Guy", "team": "DAL", "proj_points": 150.0},
]
ELOS = {"SFX": 1580.0, "DAL": 1470.0, "GBX": 1500.0}
KW = dict(receptions_by_id={}, season=2026, updated_utc="2026-07-17T00:00:00Z")

def doc(rows):
    return bw.build_weekly_document(PROJ, SCHED, ELOS, injuries=rows, **KW)

def inj(status, detail=None, player="Hurt Guy", team="SFX"):
    return {"team": team, "player": player, "status": status, "detail": detail}
`;

/* ------------------------------------------------------------------ vocabulary */

test('ONE canonical vocabulary: every real feed spelling maps, unknown stays unknown',
  () => {
    const out = runPy(`${SETUP}
print(json.dumps({
  "codes": list(av.CODES),
  "week": sorted(av.WEEK_CLASS),
  "season": sorted(av.SEASON_CLASS),
  # every spelling observed in a real feed, across all three feeds
  "espn_site": [av.normalize_status(s) for s in
      ["Active", "Questionable", "Doubtful", "Out", "Injured Reserve", "Suspension",
       "Physically Unable to Perform", "Non-Football Injury"]],
  "espn_kona": [av.normalize_status(s) for s in
      ["injury_reserve", "day_to_day", "probable"]],
  "nflverse":  [av.normalize_status(s) for s in ["Out", "Doubtful", "Questionable"]],
  "unknown":   [av.normalize_status(s) for s in [None, "", "  ", "Wobbly", "PUPPY"]],
  "min_weeks": av.MIN_WEEKS_OUT,
}))
`);
    assert.deepEqual(out.codes,
      ['ACTIVE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT', 'IR', 'PUP', 'NFI', 'SUSPENDED'],
      'the canonical vocabulary drifted');
    assert.deepEqual(out.week, ['DOUBTFUL', 'OUT', 'QUESTIONABLE'],
      'week class = the short-term designations, season total preserved');
    assert.deepEqual(out.season, ['IR', 'NFI', 'PUP', 'SUSPENDED'],
      'season class = the long-term absences, season total reduced');
    assert.deepEqual(out.espn_site,
      ['ACTIVE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT', 'IR', 'SUSPENDED', 'PUP', 'NFI']);
    assert.deepEqual(out.espn_kona, ['IR', 'QUESTIONABLE', 'ACTIVE']);
    assert.deepEqual(out.nflverse, ['OUT', 'DOUBTFUL', 'QUESTIONABLE']);
    // The defect this release exists to fix: an unrecognised status used to become
    // "healthy" by omission. It must now be visibly nothing.
    assert.deepEqual(out.unknown, [null, null, null, null, null],
      'an unmapped status MUST be null — never silently ACTIVE');
    assert.equal(out.min_weeks, 4, 'the documented NFL IR/PUP floor is four games');
  });

test('every status in the committed data/injuries.json normalizes', () => {
  const out = runPy(`${SETUP}
rows = json.load(open("data/injuries.json"))["injuries"]
bad = sorted({r["status"] for r in rows if av.normalize_status(r["status"]) is None})
print(json.dumps({"rows": len(rows), "unmapped": bad,
                  "counts": av.counts(rows)}))
`);
  assert.deepEqual(out.unmapped, [],
    'an ESPN spelling the vocabulary does not know reached the committed feed — ' +
    'add it to scripts/availability.py rather than letting it read as healthy');
  assert.ok(out.rows > 0);
  assert.ok(!('UNMAPPED' in out.counts), 'counts must carry no UNMAPPED bucket');
});

/* ------------------------------------------------------------- duration parsing */

test('the duration parser has ZERO false positives on the real 800-row feed', () => {
  const out = runPy(`${SETUP}
rows = json.load(open("data/injuries.json"))["injuries"]
hits = []
for r in rows:
    d = dur.parse_duration(r["detail"], status=av.normalize_status(r["status"]))
    if d:
        hits.append({"team": r["team"], "player": r["player"], "status": r["status"],
                     "season": d["out_for_season"], "weeks": d["weeks_out"],
                     "conf": d["confidence"], "has_evidence": bool(d["evidence"])})
# The same rows read WITHOUT the status gate -- the gate's own blast radius.
ungated = sum(1 for r in rows if dur.parse_duration(r["detail"], status=None))
print(json.dumps({"hits": hits, "ungated": ungated}))
`);
  // Every parse must be gate-eligible and must be able to quote its own source.
  for (const h of out.hits) {
    assert.ok(['Out', 'Injured Reserve', 'Suspension'].includes(h.status),
      `${h.player}: a duration was parsed from a ${h.status} row`);
    assert.equal(h.conf, 'explicit', `${h.player}: a parse is always explicit`);
    assert.ok(h.has_evidence, `${h.player}: a claimed duration must quote the report`);
    assert.ok(h.season || (h.weeks >= 1 && h.weeks <= 17),
      `${h.player}: implausible weeks_out ${h.weeks}`);
  }
  // NOT an exact count. data/injuries.json is a LIVE feed the daily cron rewrites,
  // so pinning "exactly 12 durations" reds the gate every time a player is
  // activated off IR — a false alarm in a repo whose discipline is "never deploy
  // red". The zero-false-positive guarantee lives in the per-hit property
  // assertions above (gate-eligible status + explicit confidence + quotable
  // evidence + plausible weeks), which hold at ANY feed size. These two keep the
  // parser honest without coupling to today's snapshot.
  assert.ok(out.hits.length > 0,
    'the real feed should state at least one duration; zero would mean the parser '
    + 'died silently and the property loop above passed vacuously');
  const seasonN = out.hits.filter((h) => h.season).length;
  const weeksN = out.hits.filter((h) => h.weeks !== null).length;
  assert.equal(seasonN + weeksN, out.hits.length,
    'every parsed duration is either season-ending or a week count — never both, never neither');
  // The gate is load-bearing, not belt-and-braces: ungated, the same corpus yields
  // durations for players who are healthy (blurbs about a TEAMMATE or LAST season).
  assert.ok(out.ungated > out.hits.length,
    'the status gate must be demonstrably suppressing real false positives');
});

test('a hedge, a range, or somebody else\'s injury never becomes a return date', () => {
  const out = runPy(`${SETUP}
cases = {
  "hedged":        dur.parse_duration("He could miss the entire season.", status="IR"),
  "no_timetable":  dur.parse_duration("There is no timetable for his return.", status="IR"),
  "range_months":  dur.parse_duration('One report suggested "6-12 months".', status="IR"),
  "range_weeks":   dur.parse_duration("He is sidelined 2 to 4 weeks.", status="OUT"),
  "teammate":      dur.parse_duration(
      "Kirk steps into a larger role with Ricky Pearsall (knee, ir) out for the season.",
      status="QUESTIONABLE"),
  "last_season":   dur.parse_duration(
      "Watson has now fully recovered from the biceps injury that forced him to miss "
      "the entirety of the 2025 campaign.", status="QUESTIONABLE"),
  "plain_weeks":   dur.parse_duration("He is sidelined 3 weeks.", status="OUT"),
  "plain_season":  dur.parse_duration("He is out for the season.", status="IR"),
}
print(json.dumps({k: (v and {"s": v["out_for_season"], "w": v["weeks_out"]})
                  for k, v in cases.items()}))
`);
  for (const k of ['hedged', 'no_timetable', 'range_months', 'range_weeks',
                   'teammate', 'last_season']) {
    assert.equal(out[k], null,
      `${k}: the parser invented a duration the report never stated`);
  }
  // ...while the unambiguous forms still parse, so the caution is not just "return
  // null always".
  assert.deepEqual(out.plain_weeks, { s: false, w: 3 });
  assert.deepEqual(out.plain_season, { s: true, w: null });
});

/* ------------------------------------------------ the two mechanics, kept apart */

test('QUESTIONABLE keeps the full season total; IR actually REDUCES it', () => {
  const out = runPy(`${SETUP}
q = doc([inj("Questionable")])["players"][0]
r = doc([inj("Injured Reserve", "No timetable has been set.")])["players"][0]
print(json.dumps({
  "q_class": q["availability"]["class"],
  "q_sum": round(sum(w["pts"] for w in q["weeks"]), 6),
  "q_blocked": sum(1 for w in q["weeks"] if w.get("avail") is False),
  "r_class": r["availability"]["class"],
  "r_sum": round(sum(w["pts"] for w in r["weeks"]), 6),
  "r_blocked": sum(1 for w in r["weeks"] if w.get("avail") is False),
  "r_lost": r["availability"]["season_points_lost"],
}))
`);
  // A Wednesday designation is start/sit news, not a season-long absence.
  assert.equal(out.q_class, 'week');
  assert.equal(out.q_blocked, 0, 'a questionable player misses no week outright');
  assert.ok(Math.abs(out.q_sum - 200.0) <= 0.09,
    `week-shaping must PRESERVE the season total (got ${out.q_sum})`);
  // An IR stash must stop carrying a full season of points. This is F2.
  assert.equal(out.r_class, 'season');
  assert.equal(out.r_blocked, 4, 'IR with no stated duration blocks the league floor');
  // 5 scheduled games in the fixture, 4 blocked -> 1/5 of the season survives.
  assert.ok(Math.abs(out.r_sum - 200.0 * 1 / 5) <= 0.09,
    `unavailability must REDUCE the season total pro-rata (got ${out.r_sum})`);
  assert.ok(out.r_lost > 0, 'season_points_lost must record the reduction');
});

test('a season-long absence zeroes the weeks and does NOT renormalize them away', () => {
  const out = runPy(`${SETUP}
d = doc([inj("Out", "He will miss the rest of the season.")])["players"][0]
a = d["availability"]
print(json.dumps({
  "status": a["status"], "cls": a["class"], "season": a["out_for_season"],
  "weeks_out": a["weeks_out"], "conf": a["confidence"],
  "evidence": a["evidence"], "lost": a["season_points_lost"],
  "sum": sum(w["pts"] for w in d["weeks"]),
  "blocked": sum(1 for w in d["weeks"] if w.get("avail") is False),
}))
`);
  // An ESPN "Out" whose own text says season-ending is a long-term absence wearing a
  // short-term label. Class is DATA, not a lookup on the status string.
  assert.equal(out.status, 'OUT', 'the raw designation is still OUT');
  assert.equal(out.cls, 'season', 'the report text promotes the MECHANIC');
  assert.equal(out.season, true);
  assert.equal(out.weeks_out, null, 'out_for_season carries no week count');
  assert.equal(out.conf, 'explicit');
  assert.ok(out.evidence, 'a promotion must be able to quote the sentence that did it');
  assert.equal(out.sum, 0, 'a player who will not play again scores 0, not 100%');
  assert.equal(out.lost, 200.0, 'the whole projection must leave the model');
  assert.equal(out.blocked, 5, 'every scheduled week is blocked');
});

test('an unknown-length suspension blocks NOTHING and claims nothing', () => {
  const out = runPy(`${SETUP}
d = doc([inj("Suspension", "No length was announced.")])
p = d["players"][0]
print(json.dumps({
  "block": p["availability"],
  "blocked": sum(1 for w in p["weeks"] if w.get("avail") is False),
  "sum": round(sum(w["pts"] for w in p["weeks"]), 6),
  "model": "availability" in d["model"],
}))
`);
  // We do not know how long. Honest data beats a convenient guess: flag him on the
  // card, take nothing off his projection.
  assert.deepEqual(out.block, { status: 'SUSPENDED', class: 'season' },
    'a flagged-but-unblocked row must claim no duration and no points lost');
  assert.equal(out.blocked, 0);
  assert.ok(Math.abs(out.sum - 200.0) <= 0.09);
  assert.equal(out.model, false,
    'model.availability counts players actually blocked, and nobody was');
});

test('the league floor is stamped "rule", never presented as a measurement', () => {
  const out = runPy(`${SETUP}
floor = doc([inj("Injured Reserve", "The team offered no update.")])["players"][0]
told = doc([inj("Suspension", "He is set to miss the first three games.")])["players"][0]
print(json.dumps({
  "floor_conf": floor["availability"]["confidence"],
  "floor_weeks": floor["availability"]["weeks_out"],
  "floor_evidence": floor["availability"]["evidence"],
  "told_conf": told["availability"]["confidence"],
  "told_weeks": told["availability"]["weeks_out"],
  "told_evidence": bool(told["availability"]["evidence"]),
}))
`);
  assert.equal(out.floor_conf, 'rule',
    'a floor must be labelled a floor so the UI can say "at least 4"');
  assert.equal(out.floor_weeks, 4);
  assert.equal(out.floor_evidence, null,
    'a rule row has no report to quote — it must not borrow one');
  assert.equal(out.told_conf, 'explicit');
  assert.equal(out.told_weeks, 3, 'a stated three-game suspension blocks three weeks');
  assert.equal(out.told_evidence, true);
});

test('a bye week and a cannot-play week stay distinguishable', () => {
  const out = runPy(`${SETUP}
p = doc([inj("Injured Reserve", "No update.")])["players"][0]
print(json.dumps([{"wk": w["wk"], "bye": w["bye"], "pts": w["pts"],
                   "avail": w.get("avail", "absent")} for w in p["weeks"][:6]]))
`);
  const bye = out.find((w) => w.bye);
  assert.equal(bye.wk, 2, 'SFX byes in week 2 in the fixture');
  assert.equal(bye.avail, 'absent',
    'a bye is NOT an availability block — the lineup card must say BYE, not IR');
  // The four blocked weeks skip the bye: 1, 3, 4, 5.
  assert.deepEqual(out.filter((w) => w.avail === false).map((w) => w.wk), [1, 3, 4, 5]);
  for (const w of out.filter((w) => w.avail === false)) {
    assert.equal(w.pts, 0, `wk${w.wk}: a blocked week must carry 0 points`);
  }
});

test('a healthy build is byte-identical to the pre-Rel17 document', () => {
  const out = runPy(`${SETUP}
b = lambda d: json.dumps(d, ensure_ascii=True, indent=2, sort_keys=False)
empty = doc([])
print(json.dumps({
  "active_same": b(doc([inj("Active", "Poised to make his pro debut this week.")])) == b(empty),
  "absent_same": b(bw.build_weekly_document(
      PROJ, SCHED, ELOS, injuries_path="/nonexistent/injuries.json", **KW)) == b(empty),
  "unknown_same": b(doc([inj("Wobbly", "Nobody knows what this means.")])) == b(empty),
  "no_keys": ("availability" not in empty["model"]
              and all("availability" not in p for p in empty["players"])
              and all("avail" not in w for p in empty["players"] for w in p["weeks"])),
}))
`);
  assert.equal(out.active_same, true, 'an all-Active report must be a clean no-op');
  assert.equal(out.absent_same, true, 'a missing injuries.json must change nothing');
  // Graceful in the consumer: unknown means no shaping AND no unavailability. The
  // loud complaint lives at the scraper and at the gate, not here.
  assert.equal(out.unknown_same, true,
    'an unmapped status must shape nothing and block nothing');
  assert.equal(out.no_keys, true, 'no availability keys on an all-healthy build');
});

/* ------------------------------------------------------- the committed artifact */

test('committed player_weekly.json: no orphan flags, and the meta adds up', () => {
  const weekly = read('../../data/player_weekly.json');
  const proj = read('../../data/player_projections.json');
  const injuries = read('../../data/injuries.json');

  const norm = (s) => String(s || '').replace(/\./g, '').toLowerCase()
    .split(/\s+/).filter(Boolean).join(' ');
  const report = new Map();
  const byName = new Map();
  const nameTeams = new Map();
  for (const r of injuries.injuries) {
    const key = `${r.team}|${norm(r.player)}`;
    if (!report.has(key)) report.set(key, []);
    report.get(key).push(r);
    const n = norm(r.player);
    if (!nameTeams.has(n)) nameTeams.set(n, new Set());
    nameTeams.get(n).add(r.team);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(r);
  }
  // R39 (2026-09-01): the R32 offseason-mover name fallback, mirrored — this
  // test joined on exact (team, name) only while the producer and validator
  // both fall back to a UNIQUE report name (availability.lookup_report;
  // validator rule 4 mirrored it in R33). The gap sat latent until a mover
  // (pool team = last season's, report team = current) carried a season IR
  // flag in a committed data run and this file called the producer's honest
  // block an orphan. Same guards as the producer: a report name on two teams
  // never matches by name, and a pool-duplicated name never falls back.
  const poolDups = new Set();
  {
    const seen = new Set();
    for (const pr of proj.players) {
      const n = norm(pr.name);
      if (seen.has(n)) poolDups.add(n);
      seen.add(n);
    }
  }
  const lookupRows = (team, name) => {
    const n = norm(name);
    const exact = report.get(`${team}|${n}`);
    if (exact) return exact;
    if (poolDups.has(n)) return undefined;
    if ((nameTeams.get(n) || new Set()).size !== 1) return undefined;
    return byName.get(n);
  };

  let blocked = 0;
  let ending = 0;
  let removed = 0;
  weekly.players.forEach((p, i) => {
    const nBlocked = p.weeks.filter((w) => w.avail === false).length;
    const a = p.availability;
    if (!a) {
      assert.equal(nBlocked, 0, `${p.gsis_id}: weeks blocked with no availability block`);
      return;
    }
    // NO ORPHAN FLAGS: the app can never show an IR badge that no feed backs.
    const rows = lookupRows(proj.players[i].team, proj.players[i].name);
    assert.ok(rows, `${p.gsis_id}: flagged ${a.status} with no row in injuries.json`);
    assert.ok(rows.some((r) => r.availability === a.status),
      `${p.gsis_id}: flagged ${a.status} but the feed says ` +
      `${rows.map((r) => r.availability).join('/')}`);

    if (a.class !== 'season') {
      assert.deepEqual(Object.keys(a).sort(), ['class', 'status'],
        `${p.gsis_id}: a week-class block must claim nothing beyond its status`);
      assert.equal(nBlocked, 0, `${p.gsis_id}: week class must block no week`);
      return;
    }
    if (!('season_points_lost' in a)) {
      assert.equal(nBlocked, 0,
        `${p.gsis_id}: weeks blocked without recording the points lost`);
      return;
    }
    // The duration statement and its applied consequence must agree — that is what
    // lets weeks[].avail stay the single carrier for blocked weeks.
    if (a.out_for_season) {
      assert.equal(nBlocked, p.weeks.filter((w) => !w.bye).length,
        `${p.gsis_id}: out for season must block every non-bye week`);
      assert.equal(a.weeks_out, null);
    } else {
      assert.equal(a.weeks_out, nBlocked,
        `${p.gsis_id}: weeks_out ${a.weeks_out} != ${nBlocked} weeks flagged avail:false`);
    }
    assert.ok(a.confidence === 'explicit' || a.confidence === 'rule');
    if (a.confidence === 'rule') {
      assert.equal(a.evidence, null, `${p.gsis_id}: a floor has no report to quote`);
    } else {
      assert.ok(a.evidence, `${p.gsis_id}: an explicit duration must quote its source`);
    }
    const sum = p.weeks.reduce((x, w) => x + w.pts, 0);
    assert.ok(Math.abs((proj.players[i].proj_points - sum) - a.season_points_lost) <= 0.05,
      `${p.gsis_id}: season_points_lost disagrees with the split`);
    blocked += 1;
    ending += a.out_for_season ? 1 : 0;
    removed += a.season_points_lost;
  });

  const meta = weekly.model.availability;
  if (blocked === 0) {
    assert.equal(meta, undefined, 'model.availability must be absent when nothing blocked');
    return;
  }
  assert.equal(meta.applied, true);
  assert.equal(meta.unavailable, blocked, 'model.availability.unavailable miscounted');
  assert.equal(meta.season_ending, ending);
  assert.equal(meta.min_weeks_rule, 4);
  assert.ok(Math.abs(meta.season_points_removed - removed) <= 0.05,
    'model.availability.season_points_removed does not match the players');
});

/* --------------------------------------------------------- loud at the boundary */

test('the ESPN scraper REFUSES an unmapped status instead of reading it as healthy',
  () => {
    const out = runPy(`${SETUP}
from scripts.scrape import espn

payload = {"injuries": [{"team": {"abbreviation": "SF"}, "injuries": [
    {"athlete": {"displayName": "Ricky Pearsall"},
     "status": {"name": "Injured Reserve"},
     "longComment": "He is out for the season."}]}]}
espn._get_json = lambda url, params=None: payload      # no network in the gate

row = espn.fetch_injuries()[0]
payload["injuries"][0]["injuries"][0]["status"] = {"name": "Wobbly"}
try:
    espn.fetch_injuries()
    raised = None
except espn.FeedError as err:
    raised = str(err)
print(json.dumps({"row": row, "keys": list(row), "raised": raised}))
`);
    assert.deepEqual(out.keys,
      ['team', 'player', 'status', 'availability', 'availability_class', 'weeks_out',
       'out_for_season', 'confidence', 'evidence', 'detail'],
      'the enriched injuries row shape drifted from the contract');
    assert.equal(out.row.status, 'Injured Reserve',
      'ESPN\'s raw spelling must ride through verbatim — INJURY_MULT keys on it');
    assert.equal(out.row.availability, 'IR');
    assert.equal(out.row.availability_class, 'season');
    assert.equal(out.row.out_for_season, true);
    assert.ok(out.raised, 'an unmapped status must fail the feed, not default to 1.0');
    assert.match(out.raised, /availability\.py/,
      'the failure must point at the file that fixes it');
  });
