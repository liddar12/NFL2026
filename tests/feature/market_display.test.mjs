/* tests/feature/market_display.test.mjs — the market strip + health config
 * note render helpers, locked.
 *
 * renderMarketStrip: '' when no market prices (cards byte-unchanged), both
 * sources + the DISPLAY ONLY badge when priced. renderHealth: old signature
 * output unchanged (backward compat); 'unconfigured' feeds surface as
 * "awaiting config" without coloring health.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarketStrip, renderHealth } from '../../app/render.js';

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
