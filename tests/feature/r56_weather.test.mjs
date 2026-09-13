/* tests/feature/r56_weather.test.mjs — locks for R56: the weather horizon
 * (forecast for every non-dome home inside Open-Meteo's 16-day window) and the
 * climatology fallback beyond it (stadium x calendar month means, n >= 4, with
 * the measured rule guard), as consumed by weekly_split_v2.
 *
 * What is locked, and why each is a lock rather than a description:
 *   1. THE BUILDER'S TARGETS. Open + retractable homes are fetched, domes never;
 *      a game beyond the horizon gets a climatology row only when its
 *      stadium-month has n >= 4 observed games; every row is stamped with its
 *      source; the key format is the one build_weekly and promote_signals read.
 *   2. THE GUARD IS MEASURED, NOT ASSUMED. On the committed weather_history.json
 *      the rule admission recomputes from the data: a rule that fires at the
 *      mean and was wrong more than half the time in 2023-2025 is withheld.
 *      The headline numbers docs/WEATHER_HORIZON.md states are pinned so the
 *      doc cannot drift from the data silently.
 *   3. BUILD_WEEKLY'S CONSUMPTION. Forecast rows win over climatology rows;
 *      a climatology row fires only its admitted rules; outdoor weeks are counted
 *      by the row they consumed (forecast / climatology / none), dome and
 *      retractable weeks by none; the model meta carries weather_sources.
 *   4. THE CONTRACTS ADMIT THE NEW SHAPE and the pre-R56 file still validates.
 *
 * Node built-ins only; python3 is already a fast-gate dependency (the pattern
 * is tests/feature/r51_weekly.test.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HISTORY = resolve(REPO_ROOT, 'data/weather_history.json');
const DOC = resolve(REPO_ROOT, 'docs/WEATHER_HORIZON.md');

/** Run a python3 snippet from the repo root; parse the single JSON line it prints. */
function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    input: code,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const PRELUDE = `
import json, datetime as dt
from scripts import build_weather_forecast as bf
from scripts import build_weekly as bw
`;

// ---------------------------------------------------------------------------
// 1. Builder targets, stamps, key formats.
// ---------------------------------------------------------------------------

test('the forecast builder targets every non-dome home and stamps every row with its source', () => {
  const r = runPy(`${PRELUDE}
from scripts.scrape.stadiums import STADIUMS
now = dt.datetime(2026, 9, 8, 12, 0, tzinfo=dt.timezone.utc)
sched = {"season": 2026, "games": [
  {"week": 1, "home": "GB", "away": "CHI", "kickoff_utc": "2026-09-10T00:20Z", "status": "STATUS_SCHEDULED"},
  {"week": 1, "home": "ARI", "away": "SEA", "kickoff_utc": "2026-09-13T20:05Z", "status": "STATUS_SCHEDULED"},
  {"week": 1, "home": "DET", "away": "MIN", "kickoff_utc": "2026-09-13T17:00Z", "status": "STATUS_SCHEDULED"},
  {"week": 13, "home": "GB", "away": "DET", "kickoff_utc": "2026-12-06T18:00Z", "status": "STATUS_SCHEDULED"},
  {"week": 13, "home": "ARI", "away": "LAR", "kickoff_utc": "2026-12-06T21:05Z", "status": "STATUS_SCHEDULED"},
  {"week": 14, "home": "CLE", "away": "PIT", "kickoff_utc": "2026-12-13T18:00Z", "status": "STATUS_SCHEDULED"},
]}
def hourly(home):
    return {"time": ["2026-09-10T00:00", "2026-09-13T20:00"], "temperature_2m": [18.0, 33.0],
            "wind_speed_10m": [26.0, 7.0], "precipitation": [0.0, 0.0]}
finals, hist = {}, {}
for i, (season, temp, wind) in enumerate([(2021, -3.0, 10.0), (2022, 1.0, 14.0), (2023, -2.0, 10.0), (2024, 1.0, 12.0), (2025, -2.0, 14.0)]):
    finals.setdefault(season, []).append({"week": 13, "home": "GB", "away": "CHI", "kickoff_utc": f"{season}-12-05T18:00Z"})
    hist[f"{season}|13|GB|CHI"] = {"temp_c": temp, "wind_kph": wind, "precip_mm": 0.0}
for season in (2023, 2024, 2025):
    finals.setdefault(season, []).append({"week": 14, "home": "CLE", "away": "PIT", "kickoff_utc": f"{season}-12-12T18:00Z"})
    hist[f"{season}|14|CLE|PIT"] = {"temp_c": 1.0, "wind_kph": 30.0, "precip_mm": 0.0}
doc, stats = bf.build_document(sched, now, hourly, hist, finals, generated_utc="2026-09-08T12:00:00Z")
print(json.dumps({
  "doc": doc, "stats": stats,
  "non_dome": sorted(bf.NON_DOME_HOMES), "roofs": sorted({s["roof"] for s in bf.NON_DOME_HOMES.values()}),
  "n_open": sum(1 for s in STADIUMS.values() if s["roof"] == "open"),
  "n_retractable": sum(1 for s in STADIUMS.values() if s["roof"] == "retractable"),
  "n_dome": sum(1 for s in STADIUMS.values() if s["roof"] == "dome"),
  "forecast_days": bf.FORECAST_DAYS, "min_n": bf.CLIMATOLOGY_MIN_N,
  "url_days": "forecast_days=16" in bf.FORECAST_URL,
}))`);
  assert.deepEqual(r.roofs, ['open', 'retractable']);
  assert.equal(r.non_dome.length, r.n_open + r.n_retractable);
  assert.deepEqual([r.n_open, r.n_retractable, r.n_dome], [21, 5, 6], 'the settled stadium table');
  assert.ok(r.non_dome.includes('ARI') && r.non_dome.includes('DAL'), 'retractable homes are fetched');
  assert.ok(!r.non_dome.includes('DET'), 'domes are never a target');
  assert.equal(r.forecast_days, 16);
  assert.equal(r.min_n, 4);
  assert.equal(r.url_days, true);
  const { doc, stats } = r;
  assert.deepEqual(Object.keys(doc).sort(), ['climatology', 'games', 'generated_utc', 'source', 'sources']);
  assert.deepEqual(doc.games, {
    '2026|1|GB|CHI': { wind_kph: 26.0, temp_c: 18.0, precip_mm: 0.0, source: 'forecast', fetched_utc: '2026-09-08T12:00:00Z' },
    '2026|1|ARI|SEA': { wind_kph: 7.0, temp_c: 33.0, precip_mm: 0.0, source: 'forecast', fetched_utc: '2026-09-08T12:00:00Z' },
  }, 'inside the horizon: open AND retractable rows, stamped forecast + fetched_utc');
  assert.deepEqual(doc.climatology, {
    '2026|13|GB|DET': { temp_c: -1.0, wind_kph: 12.0, source: 'climatology', n: 5, month: 12, rules: ['cold', 'wind'] },
  }, 'beyond the horizon: the stadium-month mean with n >= 4; CLE (n = 3) and ARI (no history) are absent');
  assert.deepEqual(stats, { scheduled: 5, forecast: 2, climatology: 1, absent: 2, fetch_calls: 2, fetch_failed: 0, beyond_horizon: 3 });
  assert.deepEqual(doc.sources.counts, { scheduled: 5, forecast: 2, climatology: 1, absent: 2 });
  assert.equal(doc.sources.forecast_days, 16);
  assert.equal(doc.sources.climatology_min_n, 4);
  assert.equal(doc.sources.climatology_skipped_lt_min_n, 1);
  for (const key of [...Object.keys(doc.games), ...Object.keys(doc.climatology)]) {
    assert.match(key, /^2026\|\d+\|[A-Z]{2,3}\|[A-Z]{2,3}$/, `key format season|week|HOME|AWAY: ${key}`);
    const home = key.split('|')[2];
    assert.ok(r.non_dome.includes(home), `${key}: the third segment is the non-dome HOME`);
  }
});

test('the horizon is 16 days counting today; the past and day 17 are outside', () => {
  const r = runPy(`${PRELUDE}
now = dt.datetime(2026, 9, 8, 12, 0, tzinfo=dt.timezone.utc)
print(json.dumps({
  "today": bf.within_horizon("2026-09-08T20:00Z", now),
  "day16": bf.within_horizon("2026-09-23T23:59Z", now),
  "day17": bf.within_horizon("2026-09-24T00:20Z", now),
  "past": bf.within_horizon("2026-09-08T11:59Z", now),
  "none": bf.within_horizon(None, now),
}))`);
  assert.deepEqual(r, { today: true, day16: true, day17: false, past: false, none: false });
});

// ---------------------------------------------------------------------------
// 2. The guard is measured on the committed history, and the doc agrees.
// ---------------------------------------------------------------------------

test('climatology rule admission recomputes from weather_history.json and matches the doc headline', (t) => {
  if (!existsSync(HISTORY)) {
    t.skip('data/weather_history.json is runner-built (OPTIONAL_DATA); nothing to measure here');
    return;
  }
  const r = runPy(`${PRELUDE}
table = bf.climatology_table(bf._load_history_games(), bf._load_finals_by_season())
rows = []
for (home, month), row in sorted(table["rows"].items()):
    e = row["eval"]
    rows.append({"home": home, "month": month, "n": row["n"], "temp_c": row["temp_c"], "wind_kph": row["wind_kph"],
                 "rules": row["rules"], "eval": e})
print(json.dumps({"rows": rows, "skipped": len(table["skipped"]), "unjoined": table["unjoined"],
                  "min_n": bf.CLIMATOLOGY_MIN_N}))`);
  assert.equal(r.unjoined, 0, 'every history row joins a finals fixture row');
  assert.ok(r.rows.length > 50, 'a real climatology has dozens of stadium-months');
  let coldFires = 0;
  let windFires = 0;
  for (const row of r.rows) {
    assert.ok(row.n >= r.min_n, `${row.home}-${row.month}: n ${row.n} below the floor`);
    const e = row.eval;
    assert.equal(e.cold_fires, row.temp_c <= 0.0, `${row.home}-${row.month}: cold fires iff mean <= 0 C`);
    assert.equal(e.wind_fires, row.wind_kph >= 24.0, `${row.home}-${row.month}: wind fires iff mean >= 24 km/h`);
    coldFires += e.cold_fires ? 1 : 0;
    windFires += e.wind_fires ? 1 : 0;
    for (const rule of ['cold', 'wind']) {
      const fires = e[`${rule}_fires`];
      const wrong = e[`${rule}_wrong`];
      const admitted = row.rules.includes(rule);
      const shouldAdmit = !fires || (e.n > 0 && wrong * 2 <= e.n);
      assert.equal(admitted, shouldAdmit,
        `${row.home}-${row.month} ${rule}: fires=${fires} wrong=${wrong}/${e.n} admitted=${admitted}`);
    }
  }
  // The doc's headline (docs/WEATHER_HORIZON.md) — pinned so a refreshed
  // history that changes the picture forces the doc to be re-measured.
  assert.equal(r.rows.length, 96, 'stadium-months with n >= 4 over 2021-2025');
  assert.equal(r.skipped, 9, 'stadium-months skipped for n < 4');
  assert.equal(windFires, 0, 'no stadium-month mean reaches 24 km/h: the wind rule never fires on climatology today');
  assert.equal(coldFires, 5, 'the cold rule fires for five stadium-months');
  const withheld = r.rows.filter((row) => !row.rules.includes('cold')).map((row) => `${row.home}-${row.month}`);
  assert.deepEqual(withheld, ['CHI-12', 'GB-12'], 'cold withheld where it was wrong more than half the time');
  const doc = readFileSync(DOC, 'utf8');
  for (const needle of ['96 stadium-months', 'CHI-12', 'GB-12', 'n >= 4', '16-day', 'retractable']) {
    assert.ok(doc.includes(needle), `docs/WEATHER_HORIZON.md must state: ${needle}`);
  }
});

// ---------------------------------------------------------------------------
// 3. build_weekly consumption: precedence, admitted rules, the three counts.
// ---------------------------------------------------------------------------

test('build_weekly serves forecast rows first, climatology only where none exists, and counts by source', () => {
  const r = runPy(`${PRELUDE}
sched_by_team, elos, sched = bw._fixture()
dvp_fx, env_fx, fc_fx = bw._fixture_feeds()
flat = {"SFX": 1500.0, "DAL": 1500.0, "GBX": 1500.0}
def counts(doc, team, pos):
    f = bw.build_factors(2026, dvp_fx, env_fx, doc)
    bw.player_weeks(200.0, team, sched_by_team, flat, round_dp=None, position=pos, factors=f)
    return f, {k: v for k, v in f["counts"].items() if k.startswith("weather_")}
f_fc, c_fc = counts(fc_fx, "SFX", "WR")
f_cl, c_cl = counts(bw._fixture_climatology(), "SFX", "WR")
f_rb, c_rb = counts(bw._fixture_climatology(), "SFX", "RB")
f_rb2, _ = counts(bw._fixture_climatology(rules=("cold", "wind")), "SFX", "RB")
_, c_dome = counts(bw._fixture_climatology(), "GBX", "WR")
_, c_k = counts(bw._fixture_climatology(), "SFX", "K")
proj = [{"gsis_id": "p1", "name": "WR Guy", "team": "SFX", "position": "WR", "proj_points": 200.0}]
doc = bw.build_weekly_document(proj, sched, elos, {}, 2026, "2026-09-02T00:00:00Z", injuries=[],
                               factors=bw.build_factors(2026, dvp_fx, env_fx, bw._fixture_climatology()))
print(json.dumps({
  "forecast_only": c_fc, "with_clim": c_cl, "rb": c_rb, "dome_home": c_dome, "kicker": c_k,
  "wk6_ratio": bw.week_multiplier(f_cl, 6, "SFX", "DAL", True, "WR", flat) / bw.week_multiplier(f_fc, 6, "SFX", "DAL", True, "WR", flat),
  "wk4_ratio": bw.week_multiplier(f_cl, 4, "SFX", "GBX", True, "WR", flat) / bw.week_multiplier(f_fc, 4, "SFX", "GBX", True, "WR", flat),
  "rb_ratio": bw.week_multiplier(f_rb2, 6, "SFX", "DAL", True, "RB", flat) / bw.week_multiplier(f_rb, 6, "SFX", "DAL", True, "RB", flat),
  "meta_sources": doc["model"]["weather_sources"], "meta_counts": doc["model"]["neutral_counts"],
  "keys": list(bw.NEUTRAL_KEYS), "rules": list(bw.WEATHER_RULES),
  "withheld_cold": bw.weather_factor("QB", "open", -5.0, 0.0, rules=("wind",)),
  "withheld_wind": bw.weather_factor("RB", "open", 10.0, 40.0, rules=("cold",)),
  "absent": bw.weather_factor("RB", "open", None, None, rules=()),
}))`);
  // SFX: wk1 home (forecast), wk3 @DAL retractable, wk4 home (forecast), wk5 @GBX dome, wk6 home (no row)
  assert.deepEqual(r.forecast_only, { weather_no_forecast_weeks: 1, weather_forecast_weeks: 2, weather_climatology_weeks: 0 });
  assert.deepEqual(r.with_clim, { weather_no_forecast_weeks: 0, weather_forecast_weeks: 2, weather_climatology_weeks: 1 });
  assert.deepEqual(r.rb, { weather_no_forecast_weeks: 0, weather_forecast_weeks: 2, weather_climatology_weeks: 1 });
  assert.deepEqual(r.dome_home, { weather_no_forecast_weeks: 0, weather_forecast_weeks: 1, weather_climatology_weeks: 0 },
    'a dome-home team counts only its one open-roof away week');
  assert.deepEqual(r.kicker, { weather_no_forecast_weeks: 0, weather_forecast_weeks: 0, weather_climatology_weeks: 0 },
    'a position the weather factor does not read consumes nothing');
  assert.ok(Math.abs(r.wk6_ratio - 0.97) < 1e-12, 'the admitted cold rule fires from the climatology mean');
  assert.ok(Math.abs(r.wk4_ratio - 1.0) < 1e-12, 'a forecast row beats a shadowing climatology row');
  assert.ok(Math.abs(r.rb_ratio - 0.95) < 1e-12, 'the wind rule fires only when the row admits it');
  assert.deepEqual(r.withheld_cold, [0.97, false], 'a withheld rule is roof-only, not a missing forecast');
  assert.deepEqual(r.withheld_wind, [1.0, false]);
  assert.deepEqual(r.absent, [1.0, true], 'absent is absent');
  assert.deepEqual(r.meta_sources, { forecast_days: 16, climatology_min_n: 4 });
  assert.deepEqual(r.keys, ['dvp_neutral_weeks', 'weather_no_forecast_weeks', 'venue_flat_weeks',
    'weather_forecast_weeks', 'weather_climatology_weeks']);
  assert.deepEqual(r.rules, ['cold', 'wind']);
  assert.equal(r.meta_counts.weather_forecast_weeks, 2);
  assert.equal(r.meta_counts.weather_climatology_weeks, 1);
  assert.equal(r.meta_counts.weather_no_forecast_weeks, 0);
});

// ---------------------------------------------------------------------------
// 4. Contracts: the new shape validates, the pre-R56 shape still validates.
// ---------------------------------------------------------------------------

test('weather_forecast.schema.json admits stamped forecast rows, climatology and sources; the pre-R56 shape still passes', () => {
  const r = runPy(`${PRELUDE}
from scripts import validate_data as vd
schema = json.load(open("data/contracts/weather_forecast.schema.json", encoding="utf-8"))
pw = json.load(open("data/contracts/player_weekly.schema.json", encoding="utf-8"))
def errs(doc, sch):
    out = []
    vd._validate(doc, sch, "$", out)
    return out
new = {"generated_utc": "2026-09-08T12:00:00Z", "source": "x",
       "games": {"2026|1|GB|CHI": {"wind_kph": 26.0, "temp_c": 18.0, "precip_mm": 0.0, "source": "forecast", "fetched_utc": "2026-09-08T12:00:00Z"}},
       "climatology": {"2026|13|GB|DET": {"temp_c": -1.0, "wind_kph": 12.0, "source": "climatology", "n": 5, "month": 12, "rules": ["cold"]}},
       "sources": {"forecast_days": 16, "climatology_min_n": 4, "climatology_seasons": [2021, 2022, 2023, 2024, 2025],
                   "climatology_eval_seasons": [2023, 2024, 2025], "climatology_stadium_months": 96, "climatology_skipped_lt_min_n": 9,
                   "counts": {"scheduled": 5, "forecast": 2, "climatology": 1, "absent": 2}}}
old = {"generated_utc": "2026-09-08T10:39:06Z", "source": "open-meteo forecast",
       "games": {"2026|1|CAR|CHI": {"precip_mm": 0.1, "temp_c": 31.4, "wind_kph": 6.0}}}
bad_n = json.loads(json.dumps(new)); bad_n["climatology"]["2026|13|GB|DET"]["n"] = 3
bad_src = json.loads(json.dumps(new)); bad_src["climatology"]["2026|13|GB|DET"]["source"] = "guess"
bad_rule = json.loads(json.dumps(new)); bad_rule["climatology"]["2026|13|GB|DET"]["rules"] = ["snow"]
bad_fc = json.loads(json.dumps(new)); bad_fc["games"]["2026|1|GB|CHI"]["source"] = "climatology"
model_schema = pw["properties"]["model"]
meta_ok = {"name": "weekly_split_v2", "tilt_coef": 0.5, "home_coef": 0.02, "estimate": True, "notes": "n",
           "weather_sources": {"forecast_days": 16, "climatology_min_n": 4},
           "neutral_counts": {k: 0 for k in bw.NEUTRAL_KEYS}}
meta_bad = json.loads(json.dumps(meta_ok)); meta_bad["weather_sources"]["horizon"] = 1
print(json.dumps({"new": errs(new, schema), "old": errs(old, schema), "bad_n": len(errs(bad_n, schema)),
                  "bad_src": len(errs(bad_src, schema)), "bad_rule": len(errs(bad_rule, schema)), "bad_fc": len(errs(bad_fc, schema)),
                  "meta_ok": errs(meta_ok, model_schema), "meta_bad": len(errs(meta_bad, model_schema))}))`);
  assert.deepEqual(r.new, [], 'the R56 document validates');
  assert.deepEqual(r.old, [], 'the committed pre-R56 document still validates (the daily workflow regenerates it)');
  assert.ok(r.bad_n > 0, 'n < 4 is rejected by the contract');
  assert.ok(r.bad_src > 0 && r.bad_rule > 0 && r.bad_fc > 0, 'source labels and rule names are closed enums');
  assert.deepEqual(r.meta_ok, [], 'player_weekly model meta admits weather_sources and the five counts');
  assert.ok(r.meta_bad > 0, 'weather_sources is a closed shape');
});

test('the R56 selftests exit 0 offline and the builder never fetches under --selftest', () => {
  for (const script of ['scripts/build_weather_forecast.py', 'scripts/build_weather_history.py', 'scripts/build_weekly.py']) {
    const r = spawnSync('python3', [script, '--selftest'], {
      cwd: REPO_ROOT, encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: REPO_ROOT, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' },
    });
    assert.equal(r.status, 0, `${script} --selftest failed:\n${r.stdout}\n${r.stderr}`);
  }
});
