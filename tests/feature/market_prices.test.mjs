/* tests/feature/market_prices.test.mjs — the market scoreboard contract +
 * the DISPLAY-ONLY policy, locked.
 *
 * data/market_prices.json (scripts/build_markets.py): Kalshi + Polymarket
 * prices joined to OUR schedule. USER POLICY under test here:
 *   - display_only is pinned true and the note says never-weighted;
 *   - validate_data.check_meta_weights REJECTS any non-zero market-signal
 *     weight (the permanent MARKET_DISPLAY_ONLY pin);
 *   - pure joining helpers (ticker date parse, de-vig) behave exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const doc = JSON.parse(
  readFileSync(new URL('../../data/market_prices.json', import.meta.url), 'utf8'));

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

test('market_prices.json is pinned display-only with an explicit policy note', () => {
  assert.equal(doc.display_only, true);
  assert.match(doc.note, /DISPLAY ONLY/i);
  assert.match(doc.note, /never weighted/i);
});

test('sources carry honest statuses and row counts', () => {
  for (const src of ['kalshi', 'polymarket']) {
    assert.ok(doc.sources[src], `${src} source present`);
    /* R30b added the third state this assertion predated: a REACHABLE feed
     * that delivered zero usable rows is 'degraded' — not 'ok' (a 0-row write
     * is never silently ok) and not 'down' (the feed answered). This test
     * allowed only the binary, so the first honest 'degraded' kalshi ever
     * shipped turned the gate red for telling the truth. A degraded source
     * must SAY WHY — the note is what the MODEL tab shows. */
    assert.ok(['ok', 'degraded', 'down'].includes(doc.sources[src].status),
      `${src} status ${doc.sources[src].status} is outside the vocabulary`);
    if (doc.sources[src].status === 'degraded') {
      assert.ok(String(doc.sources[src].note || '').length > 0,
        `${src} is degraded with no note — the downgrade must say why`);
    }
    assert.equal(typeof doc.sources[src].rows, 'number');
  }
});

test('every emitted price is a real probability in (0,1)', () => {
  for (const [gid, srcs] of Object.entries(doc.games)) {
    for (const row of Object.values(srcs)) {
      for (const key of ['home_prob', 'away_prob']) {
        if (row[key] != null) {
          assert.ok(row[key] > 0 && row[key] < 1, `${gid} ${key} in (0,1)`);
        }
      }
    }
  }
  for (const src of ['kalshi', 'polymarket']) {
    for (const r of doc.futures[src]) {
      assert.ok(r.prob > 0 && r.prob < 1, `${src} ${r.team} prob in (0,1)`);
      assert.equal(typeof r.team, 'string');
    }
  }
});

test('polymarket futures are de-vigged (sum ~1 when the full field is priced)', () => {
  const rows = doc.futures.polymarket;
  if (rows.length >= 30) {
    const sum = rows.reduce((a, r) => a + r.prob, 0);
    assert.ok(Math.abs(sum - 1) < 0.05, `de-vigged field sums to ${sum}`);
  }
});

test('kalshi ticker date parsing is exact (pure)', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.scrape.kalshi_nfl import parse_game_ticker
print(json.dumps({
  "ok": parse_game_ticker("KXNFLGAME-26SEP14DENKC"),
  "bad": parse_game_ticker("NOPE"),
}))
`);
  assert.deepEqual(r.ok, ['2026-09-14', 'DENKC']);
  assert.equal(r.bad, null);
});

test('Kalshi dollar fields and legacy cents yield equivalent probabilities', () => {
  const prices = runPy(`
import json
from scripts.scrape.kalshi_nfl import price_of
cases = [
    {"last_price_dollars": "0.5925"},
    {"last_price": 59},
    {"last_price_dollars": "1.0000"},
    {"last_price_dollars": "0", "yes_bid_dollars": "0.5800", "yes_ask_dollars": "0.5900"},
    {"yes_bid": 58, "yes_ask": 59},
    {"last_price_dollars": "NaN", "yes_bid_dollars": "0.6100", "yes_ask_dollars": "0.5900"},
]
print(json.dumps([price_of(case) for case in cases]))
`);
  assert.deepEqual(prices, [0.5925, 0.59, null, 0.585, 0.585, null]);
});

test('polymarket de-vig normalizes and refuses zero-sum fields (pure)', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.scrape.polymarket_nfl import devig
rows = devig([{"name": "A", "prob": 0.2}, {"name": "B", "prob": 0.6}])
print(json.dumps({"rows": rows, "empty": devig([])}))
`);
  assert.equal(r.rows[0].prob + r.rows[1].prob, 1);
  assert.ok(Math.abs(r.rows[1].prob - 0.75) < 1e-9);
  assert.deepEqual(r.empty, []);
});

test('Polymarket keeps the 100-event window with provider-sized pages', () => {
  const result = runPy(`
import json
from unittest.mock import patch
from scripts.scrape import polymarket_nfl as source

def page(path, params):
    assert path == "/events" and 0 < params["limit"] <= 30
    return list(range(params["offset"], params["offset"] + params["limit"]))

with patch.object(source, "_get_json", side_effect=page) as fetch:
    print(json.dumps({"events": source._nfl_events(), "calls": fetch.call_count}))
`);
  assert.deepEqual(result.events, Array.from({ length: 100 }, (_, i) => i));
  assert.equal(result.calls, 4);
});

test('Polymarket only binds active two-sided full-game moneylines to one exact matchup', () => {
  const result = runPy(`
import json
from unittest.mock import patch
from scripts import build_markets
from scripts.scrape import polymarket_nfl as source

clock = "2026-12-07T01:20:00Z"
market_clock = "2026-12-07 01:20:00+00"
moneyline = {
    "sportsMarketType": "moneyline", "active": True, "closed": False, "acceptingOrders": True,
    "gameStartTime": market_clock, "outcomes": '["Texans", "Steelers"]', "outcomePrices": '["0.485", "0.515"]',
}
event = {"slug": "nfl-hou-pit-2026-12-07", "startTime": clock, "markets": [moneyline]}
futures = [{ "groupItemTitle": team, "outcomePrices": '["0.5","0.5"]' } for team in ("Texans", "Steelers")]
events = [
    {**event, "markets": futures},
    {**event, "markets": [{**moneyline, "sportsMarketType": "first_half_moneyline"}]},
    {**event, "startTime": "2026-12-07T01:20:00"},
    {**event, "markets": [{**moneyline, "gameStartTime": "2026-12-07 01:21:00+00"}]},
    {**event, "markets": [{**moneyline, "outcomePrices": '["0.5"]'}]},
    {**event, "markets": [{**moneyline, "outcomePrices": [True, 0.5]}]},
    {**event, "markets": [{**moneyline, "closed": True}]},
    {**event, "markets": [{**moneyline, "acceptingOrders": False}]},
    {**event, "markets": [moneyline, moneyline]},
    {**event, "startTime": "2026-12-07T01:21:00Z",
     "markets": [{**moneyline, "gameStartTime": "2026-12-07 01:21:00+00"}]},
    event,
]
with patch.object(source, "_get_json", return_value=events) as fetch:
    parsed = source.fetch_game_markets()
schedule = [
    {"game_id": "old", "home": "HOU", "away": "PIT", "kickoff_utc": "2026-11-30T01:20Z"},
    {"game_id": "right", "home": "PIT", "away": "HOU", "kickoff_utc": "2026-12-06T19:20:00-06:00"},
]
names = build_markets.name_map()
matched, unmatched = build_markets.join_polymarket_games(parsed, schedule, names)
exact = parsed[-1]
wrong_team = {**exact, "prices": {"Texans": .5, "Bills": .5}}
conflict = {**exact, "slug": "conflicting-identical-match"}
duplicate = {**schedule[-1], "game_id": "ambiguous"}
print(json.dumps({
    "query": fetch.call_args.args[1], "parsed_count": len(parsed),
    "matched": matched, "unmatched": unmatched,
    "wrong_team": build_markets.join_polymarket_games([wrong_team], schedule, names),
    "conflict": build_markets.join_polymarket_games([exact, conflict, exact], schedule, names),
    "ambiguous": build_markets.join_polymarket_games([exact], [*schedule, duplicate], names),
}))
`);
  assert.equal(result.query.order, 'startDate');
  assert.equal(result.query.ascending, 'false');
  assert.equal(result.parsed_count, 2);
  assert.equal(result.unmatched, 1);
  assert.deepEqual(result.matched, {
    right: { home_prob: 0.515, away_prob: 0.485, slug: 'nfl-hou-pit-2026-12-07' },
  });
  assert.deepEqual(result.wrong_team, [{}, 1]);
  assert.deepEqual(result.conflict, [{}, 1]);
  assert.deepEqual(result.ambiguous, [{}, 1]);
});

test('POLICY GATE: a non-zero market-signal weight fails validation', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import check_meta_weights, EXPECTED_SIGNALS, ValidationError
weights = {name: 0.0 for name in EXPECTED_SIGNALS}
ok_at_zero = True
try:
    check_meta_weights({"weights": dict(weights)})
except ValidationError:
    ok_at_zero = False
weights["kalshi"] = 0.1
rejected = False
msg = ""
try:
    check_meta_weights({"weights": weights})
except ValidationError as exc:
    rejected = True
    msg = str(exc)
print(json.dumps({"ok_at_zero": ok_at_zero, "rejected": rejected, "msg": msg}))
`);
  assert.equal(r.ok_at_zero, true, 'all-zero registry passes');
  assert.equal(r.rejected, true, 'non-zero market weight must be rejected');
  assert.match(r.msg, /DISPLAY-ONLY|display-only|day-zero/i);
});
