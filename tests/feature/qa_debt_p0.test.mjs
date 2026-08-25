/* tests/feature/qa_debt_p0.test.mjs — QA-D1 + QA-D2: the wc2026 stale-shell
 * postmortem, finally guarded.
 *
 * The 2026-08-15 coverage measurement found the two deploy-surface files that
 * postmortem depends on — sw.js (pure cache-purger) and _headers (the ONLY
 * freshness control, because the SW deliberately caches nothing) — asserted by
 * zero tests. Eight ✅-story acceptance criteria stood between a well-meaning
 * offline-support commit (or a relaxed /data/* TTL) and users scoring off
 * day-old projections behind a fresh-looking timestamp. These are those eight.
 *
 * Closes: P7-S3-AC1..AC4, P9-S6-AC1..AC4 (QA-D1-AC3: this file runs under
 * `node --test` with node: builtins only — no npm install, no browser).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/* ==========================================================================
   QA-D1 — sw.js stays a pure cache-purger, provably
   ========================================================================== */

test('sw.js registers NO fetch handler — the wc2026 stale-shell bug stays dead', () => {
  const sw = read('sw.js');
  assert.ok(
    !/addEventListener\(\s*['"]fetch['"]/.test(sw) && !/\bonfetch\s*=/.test(sw),
    'sw.js grew a fetch handler. A caching service worker is how the wc2026 '
    + 'stale-shell postmortem happened: users ran up-to-a-day-old JS after a '
    + 'deploy because the SW served a stale shell. Freshness is controlled by '
    + '_headers ONLY. If real offline support is wanted, it needs its own '
    + 'design review — not this commit.',
  );
});

test('sw.js activate path purges nfl26-* caches and claims clients', () => {
  const sw = read('sw.js');
  assert.match(sw, /addEventListener\(\s*['"]activate['"]/,
    'the activate handler is the purge path — it must exist');
  assert.match(sw, /startsWith\(\s*['"]nfl26-['"]\s*\)/,
    'the purge must target every cache this app ever created (nfl26-* prefix)');
  assert.match(sw, /caches\.delete\(/,
    'a prior install that cached files must stop serving them on next visit');
  assert.match(sw, /clients\.claim\(\)/,
    'without clients.claim() open tabs keep their old controller and the '
    + 'purge waits for every tab to close');
});

test('SW registration is best-effort and cannot block first paint (P7-S3-AC3)', () => {
  const main = read('app/main.js');
  const reg = main.match(/function registerServiceWorker\(\) \{[\s\S]*?\n\}/);
  assert.ok(reg, 'registerServiceWorker present in app/main.js');
  assert.match(reg[0], /addEventListener\(\s*['"]load['"]/,
    'registration waits for window load — it must never sit on the paint path');
  assert.match(reg[0], /\.catch\(/,
    'registration failure is a console warning, never an uncaught rejection');
});

/* ==========================================================================
   QA-D2 — the _headers freshness matrix is pinned
   ========================================================================== */

/** Parse Netlify _headers: path lines at column 0, indented "Name: value"
 *  lines under them. Comments (#) and blanks ignored. */
function parseHeaders(src) {
  const blocks = new Map(); // path -> { name -> value }
  let current = null;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) {
      current = {};
      blocks.set(line, current);
    } else if (current) {
      const m = line.match(/^\s+([A-Za-z0-9-]+):\s*(.+)$/);
      assert.ok(m, `unparseable _headers line: "${raw}"`);
      current[m[1]] = m[2];
    }
  }
  return blocks;
}

test('_headers: app code and manifest revalidate in the background (deploys land in minutes)', () => {
  const blocks = parseHeaders(read('_headers'));
  for (const path of ['/app/*', '/manifest.webmanifest']) {
    assert.equal(
      blocks.get(path)?.['Cache-Control'],
      'public, max-age=120, stale-while-revalidate=600',
      `${path} freshness changed. The SW caches nothing, so this header is the `
      + 'ONLY thing standing between a deploy and a tab running day-old JS. '
      + 'If the numbers must move, move them deliberately: update this pin and '
      + 'the reasoning in _headers in the same commit.',
    );
  }
});

test('_headers: /data/* always revalidates; the shell and SW are never served stale', () => {
  const blocks = parseHeaders(read('_headers'));
  assert.equal(
    blocks.get('/data/*')?.['Cache-Control'],
    'public, max-age=0, stale-while-revalidate=120',
    '/data/* relaxed. Crons rewrite these files; a long TTL silently serves '
    + 'last week\'s projections behind a fresh-looking timestamp.',
  );
  for (const path of ['/index.html', '/sw.js']) {
    assert.equal(
      blocks.get(path)?.['Cache-Control'],
      'public, max-age=0, must-revalidate',
      `${path} must update promptly after a deploy — it bootstraps everything else`,
    );
  }
});

test('_headers: static art is immutable — the one place hard caching is correct', () => {
  const blocks = parseHeaders(read('_headers'));
  for (const path of ['/icons/*', '/assets/*']) {
    assert.equal(blocks.get(path)?.['Cache-Control'],
      'public, max-age=31536000, immutable',
      `${path} content never changes under the same name`);
  }
});

test('_headers: the /* block carries all four baseline security headers', () => {
  const site = parseHeaders(read('_headers')).get('/*');
  assert.ok(site, '_headers must open with a /* block');
  assert.equal(site['X-Frame-Options'], 'DENY');
  assert.equal(site['X-Content-Type-Options'], 'nosniff');
  assert.equal(site['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(site['Permissions-Policy'],
    'camera=(), microphone=(), geolocation=(), payment=()');
});
