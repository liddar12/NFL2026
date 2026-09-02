/**
 * R52 — the Sleeper player dump is loaded ONCE per session.
 *
 * Locks: a second call is served from the memo (one fetch, cached:true); a
 * failure is NOT memoized (the next press fetches again); force re-fetches;
 * progress is reported from a streamed body; the HTTP cache is allowed
 * (cache:'default', never 'no-store'); a timeout is a named failure, not a
 * throw; a non-dump body is refused with buildSleeperPlayerIndex's error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const sleeper = await import('../../app/sleeper.js');

const DUMP = {
  '4034': { player_id: '4034', full_name: 'Christian McCaffrey', position: 'RB', team: 'SF', espn_id: 3117251 },
  '6794': { player_id: '6794', full_name: 'Justin Jefferson', position: 'WR', team: 'MIN', espn_id: 4262921 },
};

function streamResponse(obj, { status = 200, chunks = 3 } = {}) {
  const text = JSON.stringify(obj);
  const enc = new TextEncoder().encode(text);
  const size = Math.ceil(enc.length / chunks);
  let i = 0;
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(enc.length) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= enc.length) return { done: true, value: undefined };
          const value = enc.slice(i, i + size); i += size;
          return { done: false, value };
        },
      }),
    },
    json: async () => obj,
  };
}

test('one fetch per session: the second call is the memo, force re-fetches', async () => {
  sleeper.clearSleeperPlayerIndex();
  let calls = 0; let lastInit = null;
  const fetch = async (url, init) => { calls += 1; lastInit = init; assert.equal(url, sleeper.PLAYER_INDEX_URL); return streamResponse(DUMP); };
  const a = await sleeper.loadSleeperPlayerIndex({ fetch });
  assert.equal(a.ok, true); assert.equal(a.cached, false); assert.equal(a.count, 2);
  assert.equal(lastInit.cache, 'default', 'the browser HTTP cache must be allowed to keep the 5 MB dump');
  const b = await sleeper.loadSleeperPlayerIndex({ fetch });
  assert.equal(b.ok, true); assert.equal(b.cached, true); assert.equal(calls, 1, 'second call served from the memo');
  assert.ok(b.index instanceof Map && b.index.size === 2);
  const c = await sleeper.loadSleeperPlayerIndex({ fetch, force: true });
  assert.equal(c.cached, false); assert.equal(calls, 2);
});

test('a failure is never remembered: the next press fetches again', async () => {
  sleeper.clearSleeperPlayerIndex();
  let calls = 0;
  const fetch = async () => { calls += 1; return calls === 1 ? { status: 503, headers: { get: () => null } } : streamResponse(DUMP); };
  const first = await sleeper.loadSleeperPlayerIndex({ fetch });
  assert.equal(first.ok, false); assert.equal(first.error.code, 'http_error');
  const second = await sleeper.loadSleeperPlayerIndex({ fetch });
  assert.equal(second.ok, true); assert.equal(calls, 2);
});

test('progress is reported from a streamed body, bytes and total', async () => {
  sleeper.clearSleeperPlayerIndex();
  const seen = [];
  const res = await sleeper.loadSleeperPlayerIndex({ fetch: async () => streamResponse(DUMP, { chunks: 4 }), onProgress: (p) => seen.push(p) });
  assert.equal(res.ok, true);
  assert.ok(seen.length >= 2, 'more than one progress tick');
  assert.equal(seen[seen.length - 1].bytes, res.bytes);
  assert.equal(seen[seen.length - 1].total, res.bytes, 'content-length is the total');
});

test('a timeout is a named failure, not a throw; a non-dump body is refused', async () => {
  sleeper.clearSleeperPlayerIndex();
  const hang = (url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const t = await sleeper.loadSleeperPlayerIndex({ fetch: hang, timeoutMs: 20 });
  assert.equal(t.ok, false); assert.equal(t.error.code, 'timeout');
  sleeper.clearSleeperPlayerIndex();
  const bad = await sleeper.loadSleeperPlayerIndex({ fetch: async () => streamResponse([1, 2, 3]) });
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'not_a_player_dump');
  sleeper.clearSleeperPlayerIndex();
});
