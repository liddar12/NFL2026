/* tests/feature/r78_model_lock.test.mjs — R78: the MODEL tab passphrase gate
 * and the PLAYOFF ODDS "as of" line.
 *
 * PURE node:test. NO browser, NO dependencies — this runs inside the FAST gate
 * (`node --test tests/feature/*.mjs`). Node 22 exposes globalThis.crypto.subtle,
 * which is the same API app/views/model.js uses, so sha256Hex is testable here
 * exactly as it runs in the browser.
 *
 * WHAT THIS LOCKS, AND WHAT IT DOES NOT CLAIM. The gate is OBSCURITY, NOT
 * SECURITY: the site is static, /data/*.json stays world-readable, and anyone
 * can set the unlock key from devtools. These tests assert the VIEW hides, the
 * locked render fetches nothing, and the plaintext passphrase never lands in
 * the repo — not that the model data is protected, because it is not.
 *
 * The plaintext is unknown to this test BY DESIGN. Rather than spell it out to
 * assert its absence (which would put it in the repo, the exact thing the rule
 * forbids), the last test scans every short quoted literal in the module and
 * hashes it: if any of them is the passphrase, the digest gives it away.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  MODEL_LOCK_KEY, MODEL_PASS_SHA256, sha256Hex, isModelUnlocked, renderLockCard,
  playoffsCard, asofLine, emptyMarketNote,
} from '../../app/views/model.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL_SRC = readFileSync(join(REPO_ROOT, 'app/views/model.js'), 'utf8');

/* ==========================================================================
   1 · sha256Hex — the same digest the browser computes
   ========================================================================== */

test('sha256Hex matches the known SHA-256 of "abc"', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  // Lowercase hex, 64 chars, zero-padded bytes — the empty string is the
  // canonical padding check (its digest starts with e3b0…).
  const empty = await sha256Hex('');
  assert.equal(empty, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.match(empty, /^[0-9a-f]{64}$/);
});

/* ==========================================================================
   2 · isModelUnlocked — only the exact digest unlocks; a throw is LOCKED
   ========================================================================== */

/** Minimal Storage stand-in. `throws: true` models private mode / blocked
 * storage, where getItem raises instead of returning null. */
function fakeStorage(entries = {}, { throws = false } = {}) {
  return {
    getItem(k) {
      if (throws) throw new Error('storage blocked');
      return Object.prototype.hasOwnProperty.call(entries, k) ? entries[k] : null;
    },
  };
}

test('isModelUnlocked is true only for the exact stored digest', () => {
  assert.equal(MODEL_LOCK_KEY, 'nfl2026.model.unlock.v1');
  assert.match(MODEL_PASS_SHA256, /^[0-9a-f]{64}$/);

  assert.equal(isModelUnlocked(fakeStorage({ [MODEL_LOCK_KEY]: MODEL_PASS_SHA256 })), true);
});

test('isModelUnlocked reads wrong / missing / throwing storage as LOCKED', () => {
  assert.equal(isModelUnlocked(fakeStorage({ [MODEL_LOCK_KEY]: 'nope' })), false);
  // The pre-R78 front-of-site flag is a DIFFERENT key with a different value —
  // it must never unlock the MODEL tab.
  assert.equal(isModelUnlocked(fakeStorage({ [MODEL_LOCK_KEY]: '1' })), false);
  assert.equal(isModelUnlocked(fakeStorage({ 'nfl2026.unlock.v1': '1' })), false);
  assert.equal(isModelUnlocked(fakeStorage({})), false);
  assert.equal(isModelUnlocked(fakeStorage({}, { throws: true })), false);
  assert.equal(isModelUnlocked(null), false);
  assert.equal(isModelUnlocked(undefined), false);
});

/* ==========================================================================
   3 · renderLockCard — the locked view, and what it must NOT contain
   ========================================================================== */

test('renderLockCard paints the MODEL header, one card, and the passphrase form', () => {
  const html = renderLockCard();
  assert.match(html, /<header class="view-head">/);
  assert.match(html, /<h1 class="view-title">MODEL<\/h1>/);
  // Exactly one card.
  assert.equal((html.match(/<section class="card mcard/g) || []).length, 1);
  assert.match(html, /<section class="card mcard m-lock">/);
  assert.match(html, /<form class="m-lock-form">/);
  assert.match(html, /<input class="mp-input" type="password"/);
  assert.match(html, /name="pass"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /aria-label="Passphrase"/);
  assert.match(html, /<button type="submit" class="mp-btn">UNLOCK<\/button>/);
  assert.match(html, /This section is for the owner\. Enter the passphrase\./);
});

test('the locked view carries no dashboard content and no alert without a message', () => {
  const html = renderLockCard();
  assert.ok(!html.includes('PLAYOFF ODDS'), 'the locked card must not leak the dashboard');
  assert.ok(!html.includes('m-playoffs'));
  assert.ok(!html.includes('m-lock-msg'), 'no alert div when no message is given');
  assert.ok(!html.includes('role="alert"'));
});

test('renderLockCard renders the alert div only when a message is given', () => {
  const html = renderLockCard('Wrong passphrase.');
  assert.match(html, /<div class="m-lock-msg" role="alert">Wrong passphrase\.<\/div>/);

  const secure = renderLockCard('Passphrase check needs a secure (https) page.');
  assert.match(secure, /Passphrase check needs a secure \(https\) page\./);
  // The message is escaped like every other interpolation in this module.
  assert.ok(!renderLockCard('<b>x</b>').includes('<b>x</b>'));
});

/* ==========================================================================
   4 · the plaintext passphrase is NOT in the source
   ========================================================================== */

test('app/views/model.js carries the digest, never the passphrase', async () => {
  assert.ok(MODEL_SRC.includes(MODEL_PASS_SHA256),
    'the module must pin the passphrase digest');

  // Every short quoted literal in the module (single, double and backtick),
  // hashed. This test does not know the plaintext and must never write it —
  // the digest is what identifies it. A literal that hashes to
  // MODEL_PASS_SHA256 IS the passphrase, sitting in the repo.
  const literals = new Set();
  const re = /'([^'\\\n]{4,32})'|"([^"\\\n]{4,32})"|`([^`\\\n]{4,32})`/g;
  let m = re.exec(MODEL_SRC);
  while (m) {
    literals.add(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
    m = re.exec(MODEL_SRC);
  }
  assert.ok(literals.size > 20, 'the scan found literals to check');

  for (const lit of literals) {
    assert.notEqual(await sha256Hex(lit), MODEL_PASS_SHA256,
      'a string literal in app/views/model.js hashes to MODEL_PASS_SHA256 — the '
      + 'plaintext passphrase is in the repo; remove it, only the digest may ship');
  }
});

test('mountModel gates before it fetches, and stays locked without crypto.subtle', () => {
  // The order matters more than the presence: a lock that renders after the
  // fetches has already published the model contracts to the network tab.
  const mountIdx = MODEL_SRC.indexOf('export default async function mountModel');
  assert.ok(mountIdx > 0);
  const body = MODEL_SRC.slice(mountIdx);
  const lockIdx = body.indexOf('isModelUnlocked(');
  const fetchIdx = body.indexOf('Promise.allSettled');
  assert.ok(lockIdx > 0 && fetchIdx > 0 && lockIdx < fetchIdx,
    'mountModel must check the lock BEFORE it requests any model contract');
  assert.match(body.slice(0, fetchIdx), /Passphrase check needs a secure \(https\) page\./,
    'an absent crypto.subtle must render the lock card with the secure-page message');
});

/* ==========================================================================
   5 · PLAYOFF ODDS — the "as of" line and the empty-feed sentences
   ========================================================================== */

const ODDS_FIXTURE = Object.freeze({
  updated_utc: '2026-09-16T18:48:23Z',
  sims: 10000,
  teams: {
    KC: { playoff: 0.81, division: 0.55, conference: 0.28, champion: 0.155 },
    SF: { playoff: 0.74, division: 0.48, conference: 0.24, champion: 0.121 },
  },
});

const bothMarkets = {
  futures: {
    kalshi: [{ team: 'KC', prob: 0.14 }],
    polymarket: [{ team: 'KC', prob: 0.13 }],
  },
};

test('playoffsCard renders the as-of line from updated_utc and sims', () => {
  const html = playoffsCard(ODDS_FIXTURE, bothMarkets);
  assert.match(html, /<div class="m-asof">as of <time datetime="2026-09-16T18:48:23Z">2026-09-16 18:48 UTC<\/time>/);
  assert.match(html, /refreshed on every pipeline run \(10,000 simulated seasons\)/);
  // It sits ABOVE the explanation, which is what the owner asked for.
  assert.ok(html.indexOf('m-asof') < html.indexOf('m-explain'));
  // The honesty copy and the badge survive the addition.
  assert.match(html, /no market input/);
  assert.match(html, /MARKET · DISPLAY ONLY/);
});

test('an artifact with no updated_utc says so instead of inventing a time', () => {
  const { updated_utc, ...noStamp } = ODDS_FIXTURE; // eslint-disable-line no-unused-vars
  const html = playoffsCard(noStamp, bothMarkets);
  assert.match(html, /as of — \(no timestamp in playoff_odds\.json\)/);
  assert.ok(!html.includes('<time'), 'no <time> element without a timestamp');
  // Unparseable is treated as absent — a garbage stamp is not a stamp.
  assert.match(asofLine({ updated_utc: 'soon', sims: 5 }), /no timestamp in playoff_odds\.json/);
  assert.match(asofLine({}), /\(0 simulated seasons\)/);
});

test('an empty market column says the feed was empty, per column', () => {
  // The live state today: Kalshi returned 0 rows, Polymarket returned 32.
  const kalshiEmpty = playoffsCard(ODDS_FIXTURE, {
    futures: { kalshi: [], polymarket: [{ team: 'KC', prob: 0.13 }] },
  });
  assert.match(kalshiEmpty, /KALSHI: no priced events in the latest feed\./);
  assert.ok(!kalshiEmpty.includes('POLYMKT: no priced events'));

  const polyEmpty = playoffsCard(ODDS_FIXTURE, {
    futures: { kalshi: [{ team: 'KC', prob: 0.14 }], polymarket: [] },
  });
  assert.match(polyEmpty, /POLYMKT: no priced events in the latest feed\./);
  assert.ok(!polyEmpty.includes('KALSHI: no priced events'));

  // Absent keys, and an absent futures block entirely, read as empty.
  assert.equal(emptyMarketNote({ futures: {} }),
    ' KALSHI: no priced events in the latest feed. POLYMKT: no priced events in the latest feed.');
  assert.equal(emptyMarketNote(null),
    ' KALSHI: no priced events in the latest feed. POLYMKT: no priced events in the latest feed.');
  // Both priced: no sentence at all.
  assert.equal(emptyMarketNote(bothMarkets), '');
  assert.ok(!playoffsCard(ODDS_FIXTURE, bothMarkets).includes('no priced events'));
});

test('the empty-feed sentences live inside the existing .m-explain line', () => {
  const html = playoffsCard(ODDS_FIXTURE, { futures: { kalshi: [], polymarket: [] } });
  const explain = html.slice(html.indexOf('<div class="m-explain">'));
  const end = explain.indexOf('</div>');
  assert.ok(explain.slice(0, end).includes('KALSHI: no priced events in the latest feed.'),
    'the note belongs to the card\'s explanation, not to a new paragraph');
  assert.ok(explain.slice(0, end).includes('MARKET · DISPLAY ONLY'));
});

/* ==========================================================================
   6 · the theme carries the new rules (tokens only, 44px targets)
   ========================================================================== */

test('app/theme.css styles the lock form and the as-of line with tokens only', () => {
  const css = readFileSync(join(REPO_ROOT, 'app/theme.css'), 'utf8');
  assert.match(css, /\.m-asof\s*\{/);
  assert.match(css, /\.m-lock-form\s*\{/);
  assert.match(css, /\.m-lock-msg\s*\{/);
  // .mp-btn reuses the established primary-button rule rather than restating it.
  assert.match(css, /\.lp-btn,\n\.mp-btn \{[^}]*min-height: 44px;/);
  // .mp-input already carries the 44px target the form relies on.
  assert.match(css, /\.mp-input \{[^}]*min-height: 44px;/);
});
