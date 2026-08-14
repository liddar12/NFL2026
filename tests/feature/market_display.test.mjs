/* tests/feature/market_display.test.mjs — the market strip + health config
 * note render helpers, locked.
 *
 * renderMarketStrip: '' when no market prices (cards byte-unchanged), both
 * sources + the DISPLAY ONLY badge when priced. renderHealth: old signature
 * output unchanged (backward compat); 'unconfigured' feeds surface as
 * "awaiting config" without coloring health.
 *
 * R21-A3 also locks the MARKET PRICE FIELD boundary end to end: `adp` and
 * `auction_value` (ESPN kona ownership.auctionValueAverage) are display + value
 * flags ONLY. The tests below fail if either ever reaches a projection input —
 * as a fitted weight, a registered signal, a field on a projection record or its
 * contract, or a read inside the projection engine's own source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { renderMarketStrip, renderHealth } from '../../app/render.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = join(REPO_ROOT, 'data');
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Run a snippet against the repo's validator module; returns stdout. */
function py(src) {
  return execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${src}`,
  });
}

const GAME = {
  game_id: 'g1', home: 'KC', away: 'DEN',
  probs: { home: 0.61, away: 0.39 }, model: 'elo_prior', estimate: true,
};

test('renderMarketStrip returns empty for absent/empty market data', () => {
  assert.equal(renderMarketStrip(GAME, null), '');
  assert.equal(renderMarketStrip(GAME, undefined), '');
  assert.equal(renderMarketStrip(GAME, {}), '');
  // A market row with no numeric prob renders nothing either.
  assert.equal(renderMarketStrip(GAME, { kalshi: { ticker: 'X' } }), '');
});

test('renderMarketStrip shows OUR prob vs each priced source + the policy badge', () => {
  const html = renderMarketStrip(GAME, {
    kalshi: { home_prob: 0.58, ticker: 'T' },
    polymarket: { home_prob: 0.6, slug: 's' },
  });
  assert.match(html, /MODEL/);
  assert.match(html, /61\.0%/);
  assert.match(html, /KALSHI/);
  assert.match(html, /58\.0%/);
  assert.match(html, /POLYMKT/);
  assert.match(html, /60\.0%/);
  assert.match(html, /MARKET · DISPLAY ONLY/);
  assert.match(html, /never used in predictions/);
});

test('renderMarketStrip renders with a single priced source (model + one market)', () => {
  const html = renderMarketStrip(GAME, { kalshi: { home_prob: 0.55 } });
  assert.match(html, /KALSHI/);
  assert.doesNotMatch(html, /POLYMKT/);
});

test('renderHealth backward compat: no unconfigured feeds -> original wording', () => {
  const html = renderHealth({
    health: 'ok',
    feeds: { a: { status: 'ok' }, b: { status: 'ok' } },
  });
  assert.match(html, /DATA · OK/);
  assert.match(html, /all feeds ok/);
});

test('renderHealth surfaces unconfigured feeds as awaiting config, not degraded', () => {
  const html = renderHealth({
    health: 'ok',
    feeds: {
      a: { status: 'ok' },
      b: { status: 'unconfigured' },
      c: { status: 'unconfigured' },
    },
  });
  assert.match(html, /DATA · OK/);
  assert.match(html, /2 awaiting config/);
  assert.doesNotMatch(html, /stale \/ degraded/);
});

test('renderHealth still counts real degradation separately from config', () => {
  const html = renderHealth({
    health: 'degraded',
    feeds: {
      a: { status: 'ok' },
      b: { status: 'degraded' },
      c: { status: 'unconfigured' },
    },
  });
  assert.match(html, /DATA · DEGRADED/);
  assert.match(html, /1 feed stale \/ degraded/);
  assert.match(html, /1 awaiting config/);
});

/* ---- R21-A3: auction value is a MARKET PRICE — display only ---------------- */

test('validator registers adp + auction_value as market price fields', () => {
  const fields = JSON.parse(py(
    'from scripts.validate_data import MARKET_PRICE_FIELDS\n'
    + 'print(json.dumps(sorted(MARKET_PRICE_FIELDS)))\n',
  ));
  assert.deepEqual(fields, ['adp', 'auction_value']);
});

test('adp contract: auction_value declared, positive-or-null, policy documented', () => {
  const schema = load(join(DATA, 'contracts', 'adp.schema.json'));
  const item = schema.properties.players.items;
  const av = item.properties.auction_value;
  assert.ok(av, 'auction_value not declared in the adp contract');
  assert.deepEqual(av.type, ['number', 'null']);
  // $0 is a PRICE; "ESPN does not price this player" is not. The contract makes
  // a fabricated free player unrepresentable rather than merely discouraged.
  assert.ok(av.minimum > 0, 'auction_value must exclude 0 — unpriced is null, not $0');
  assert.equal(item.additionalProperties, false);
  assert.match(schema.description, /MARKET_PRICE_FIELDS/);
  assert.match(schema.description, /NEVER blended into projections/);
  // The minimal validator silently ignores exclusiveMinimum — using it here
  // would be an unenforced pin, i.e. policy by convention again.
  assert.ok(!JSON.stringify(schema).includes('exclusiveMinimum'),
    'validate_data.py does not implement exclusiveMinimum — use minimum');
});

test('data/adp.json: auction values present, positive or null, never 0', () => {
  const doc = load(join(DATA, 'adp.json'));
  const rows = doc.players;
  assert.ok(rows.length > 100, 'adp board too small to judge');
  if (!('auction_value' in rows[0])) return;   // feed degraded: board ships bare
  assert.equal(doc.auction_source, 'espn kona ownership.auctionValueAverage');
  assert.equal(doc.auction_budget, 200);
  let priced = 0;
  for (const r of rows) {
    assert.ok('auction_value' in r, `${r.name}: field missing on a priced build`);
    const v = r.auction_value;
    assert.ok(v === null || (typeof v === 'number' && v > 0),
      `${r.name}: auction_value ${v} — must be a positive price or null`);
    if (v !== null) priced += 1;
  }
  assert.ok(priced > 100, `only ${priced} priced players on the board`);
  assert.equal(doc.auction_join_rate, Number((priced / rows.length).toFixed(3)));
  // Ordering sanity: the board's top of draft is not priced below its tail.
  const top = rows.slice(0, 20).filter((r) => r.auction_value !== null)
    .map((r) => r.auction_value);
  const tail = rows.slice(-40).filter((r) => r.auction_value !== null)
    .map((r) => r.auction_value);
  assert.ok(Math.min(...top) > Math.max(...tail),
    'auction values do not track the draft board — wrong season or a bad join');
});

test('auction_value never reaches a projection input (weights, signals, records)', () => {
  const meta = load(join(DATA, 'meta.json'));
  for (const f of ['adp', 'auction_value']) {
    assert.ok(!(f in meta.weights), `${f} carries a fitted weight`);
  }
  const projSchema = load(join(DATA, 'contracts', 'player_projections.schema.json'));
  const declared = Object.keys(
    projSchema.properties.players.items.properties || {},
  );
  for (const f of ['adp', 'auction_value']) {
    assert.ok(!declared.includes(f), `${f} declared on the projection contract`);
  }
  const proj = load(join(DATA, 'player_projections.json'));
  for (const r of proj.players) {
    for (const f of ['adp', 'auction_value']) {
      assert.ok(!(f in r), `${f} leaked onto projection record ${r.gsis_id}`);
    }
  }
});

test('the projection engine source never reads a market price field', () => {
  // The engine and every signal implementation: if one of these files ever
  // mentions an auction/ADP field it is reading a market price to make a number.
  const files = [join(REPO_ROOT, 'scripts', 'models', 'player_projection.py')];
  const sigDir = join(REPO_ROOT, 'scripts', 'signals');
  for (const f of readdirSync(sigDir)) {
    if (f.endsWith('.py')) files.push(join(sigDir, f));
  }
  for (const path of files) {
    const src = readFileSync(path, 'utf8');
    assert.ok(!/auction/i.test(src), `${path} references auction data`);
    assert.ok(!/\badp\b/i.test(src), `${path} references ADP data`);
  }
});

test('the gate FAILS loudly if a market price does reach a projection', () => {
  // Not a convention check — poison each door in turn and assert the validator
  // reds. A green run here with a poisoned input would mean the pin is decorative.
  const out = py(
    'from scripts.validate_data import check_market_price_fields, ValidationError\n'
    + 'PROJ_SCHEMA = {"properties": {"players": {"items": {"properties": '
    + '{"gsis_id": {}, "proj_points": {}}}}}}\n'
    + 'GOOD = {"players": [{"gsis_id": "espn-1", "proj_points": 200.0}]}\n'
    + 'def reds(meta, proj, schema):\n'
    + '    try:\n'
    + '        check_market_price_fields(meta, proj, schema)\n'
    + '    except ValidationError:\n'
    + '        return True\n'
    + '    return False\n'
    + 'res = {\n'
    + '  "clean": reds({"weights": {}}, GOOD, PROJ_SCHEMA),\n'
    + '  "weight": reds({"weights": {"auction_value": 0.4}}, GOOD, PROJ_SCHEMA),\n'
    + '  "zero_weight": reds({"weights": {"auction_value": 0.0}}, GOOD, PROJ_SCHEMA),\n'
    + '  "adp_weight": reds({"weights": {"adp": 0.1}}, GOOD, PROJ_SCHEMA),\n'
    + '  "record": reds({"weights": {}}, {"players": [{"gsis_id": "espn-1", '
    + '"proj_points": 200.0, "auction_value": 61.8}]}, PROJ_SCHEMA),\n'
    + '  "contract": reds({"weights": {}}, GOOD, {"properties": {"players": '
    + '{"items": {"properties": {"gsis_id": {}, "auction_value": {}}}}}}),\n'
    + '}\n'
    + 'print(json.dumps(res))\n',
  );
  assert.deepEqual(JSON.parse(out), {
    clean: false,        // a legitimate build stays green
    weight: true,        // fitted weight on the price
    zero_weight: true,   // even weight 0 is a foot in the door: not a signal at all
    adp_weight: true,    // the same pin covers ADP, retro-fitted
    record: true,        // price riding on a projection record
    contract: true,      // price declared on the projection contract
  });
});
