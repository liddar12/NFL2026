/* tests/feature/r88_publish_race.test.mjs — the publish race (F16).
 *
 * Every pipeline workflow ends by putting data/ on main, and until R88 it did so
 * with a loop that could not work: commit locally, then retry a fast-forward-only
 * pull and a push, five times. A fast-forward pull is impossible the moment the
 * other side also has a commit from the common base — which is the ordinary case
 * here, because daily and backtest share a concurrency group but gameday does
 * not, and the owner can land code on main at any moment. The loop then burned
 * its five tries and threw a good, validated generation away with exit 1.
 *
 * scripts/publish_data.sh replaces it by re-creating this run's data commit on
 * the new head. That is only safe if the conflict rules are exactly right, and
 * "exactly right" is different per file:
 *
 *   * a REGENERABLE artifact takes OURS — this run rebuilt it from the newest
 *     inputs, so ours is the newest valid version. During a rebase "ours" is
 *     stage 3, NOT stage 2; getting that backwards publishes the other run's
 *     output under this run's name, silently. Scenario (b) proves the stage.
 *   * an APPEND-ONLY LEDGER takes NEITHER side: both writers' entries are real,
 *     and dropping either is the exact data loss F16 warns about. It is merged
 *     by identity, and when both sides recorded the same key the EARLIER first
 *     sight wins, because first sight is what locks the as-made numbers.
 *   * a conflict OUTSIDE data/ is not resolved at all. A pipeline commit touches
 *     no code, so that is a collision no rule here should paper over.
 *
 * And the two properties that make the whole thing safe to run unattended: an
 * invalid merged tree is never published (the rebase is abandoned instead), and
 * failure is bounded and loud rather than infinite and quiet.
 *
 * Everything below runs against a real bare remote and two real clones in a
 * temporary directory — never this repository — with a trivial stand-in for the
 * contract gate, because the toy tree is three files, not the real corpus. That
 * the DEFAULT gate is the real scripts/validate_data.py is asserted separately.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLISH = join(ROOT, 'scripts/publish_data.sh');
const MERGE = join(ROOT, 'scripts/merge_ledgers.py');
const PUBLISH_SRC = readFileSync(PUBLISH, 'utf8');

const T0 = '2026-09-18T10:00:00Z';   // the base generation
const TA = '2026-09-19T10:00:00Z';   // clone A's generation
const TB = '2026-09-19T11:00:00Z';   // clone B's generation (later)

/* ---------- tiny process helpers ---------------------------------------- */

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${cwd}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
};

/** Run the real publish script in a toy checkout. Never in this repository. */
const publish = (cwd, message, env = {}) => {
  assert.ok(!cwd.startsWith(ROOT), 'the test must never publish from the real repo');
  const r = spawnSync('bash', [PUBLISH, message], {
    cwd, encoding: 'utf8',
    env: {
      ...process.env,
      PUBLISH_BACKOFF_S: '0',
      PUBLISH_VALIDATE_CMD: 'python3 tools/validate_stub.py',
      ...env,
    },
  });
  return { ...r, out: `${r.stdout}${r.stderr}` };
};

/* ---------- the toy data tree ------------------------------------------- */

const writeJson = (repo, path, doc) => {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(doc, null, 2)}\n`);
};

const readJson = (repo, path) => JSON.parse(readFileSync(join(repo, path), 'utf8'));

const leg = (selection, seen, extra = {}) => ({
  season: 2026, week: 2, game_id: 'g1', market: 'moneyline', selection,
  model_prob: 0.5, seen_utc: seen, locked: true, ...extra,
});

const card = (cardId, seen, extra = {}) => ({
  card_id: cardId, dial: 'even', seed: 'ARI', model: 0.5,
  first_seen_utc: seen, locked: true, ...extra,
});

/* The week archive (G02): a card is identified by its legs' card_id, and a card
 * whose game has kicked off carries frozen_utc — the record of what was offered. */
const archiveCard = (cardId, extra = {}) => ({
  parlay_id: 'week-2leg-1', card_id: cardId,
  legs: [{ market: 'moneyline', selection: `${cardId} ML` }],
  model_ev: -0.1, ...extra,
});

/* One stage row / one workflow block of data/pipeline_stages.json (G05), written
 * exactly as scripts/stage_status.py writes them. */
const stageRow = (name, when) => ({
  name, status: 'ok', exit_code: 0, started_utc: when, finished_utc: when,
  duration_s: 1, continue_on_error: false, last_success_utc: when, note: null,
});
const wfBlock = (runId, when, stages, lastSuccess) => ({
  run_id: runId, run_started_utc: when, run_finished_utc: when,
  last_success: lastSuccess, stages,
});

/* One lock receipt row (G06): data/snapshots/*_games_open.json is a bare LIST
 * keyed by event_id, graded in place by resolve_locks. */
const receipt = (eventId, when, extra = {}) => ({
  event_id: eventId, event_type: 'game', model: 'elo_prior', estimate: false,
  as_of_utc: when, locked_utc: when, probs: [0.65, 0.35], resolved: false, ...extra,
});

const ARCHIVE = 'data/parlays/2026_wk02.json';
const STAGES = 'data/pipeline_stages.json';
const RECEIPTS = 'data/snapshots/2026_wk02_games_open.json';

/** The files the rules differ on: one regenerable, and one of every ledger shape. */
const seedTree = (repo, asOf) => {
  writeJson(repo, 'data/game_predictions.json', {           // regenerable
    generated_utc: asOf,
    games: [{ game_id: 'g1', home: 'SEA', away: 'NE', p_home: 0.61 }],
  });
  writeJson(repo, 'data/estimates/parlays_2026.json', {     // append-only ledger
    season: 2026, generated_utc: asOf, as_of_utc: asOf,
    runs: [{ as_of_utc: asOf, legs_added: 1 }],
    legs: [leg('SEA ML', asOf)],
  });
  writeJson(repo, 'data/my_cards/2026_wk02.json', {         // append-only ledger
    season: 2026, week: 2, generated_utc: asOf, pool_generated_utc: asOf,
    runs: [{ pool_generated_utc: asOf, cards_added: 1 }],
    cards: [card('base', asOf)],
  });
  writeJson(repo, ARCHIVE, {                                // week archive (G02)
    season: 2026, week: 2, updated_utc: asOf,
    parlays: [archiveCard('c-base')],
    archived_utc: asOf, closed: false,
    history: [{ updated_utc: asOf, archived_utc: asOf }],
  });
  writeJson(repo, STAGES, {                                 // cross-workflow (G05)
    generated_utc: asOf,
    workflows: { daily: wfBlock('1', asOf, [stageRow('S1', asOf)], { S1: asOf }) },
  });
  writeJson(repo, RECEIPTS, [receipt('g1', asOf)]);         // lock receipts (G06)
};

/* A stand-in for scripts/validate_data.py: it really does parse every data
 * document (so a merge that produced broken JSON reds the gate), and refuses on
 * demand so the "never publish an invalid document" path can be exercised. */
const VALIDATE_STUB = `import json, os, sys
# Toy stand-in for scripts/validate_data.py used by the publish-race test.
if "--fail" in sys.argv:
    print("validate stub: REFUSING (forced failure)", file=sys.stderr)
    sys.exit(1)
for base, _dirs, files in os.walk("data"):
    for name in files:
        if name.endswith(".json"):
            json.load(open(os.path.join(base, name), encoding="utf-8"))
print("validate stub: ok")
`;

/** A bare remote plus two clones, all from one base commit. */
const makeWorld = () => {
  const root = mkdtempSync(join(tmpdir(), 'r88-publish-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);

  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '--quiet', '--initial-branch=main');
  git(seed, 'config', 'user.name', 'seed');
  git(seed, 'config', 'user.email', 'seed@example.invalid');
  mkdirSync(join(seed, 'tools'), { recursive: true });
  writeFileSync(join(seed, 'tools/validate_stub.py'), VALIDATE_STUB);
  writeFileSync(join(seed, 'app.js'), '// pipeline commits never touch this\n');
  seedTree(seed, T0);
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'base');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '--quiet', 'origin', 'main');

  const clone = (name) => {
    const dir = join(root, name);
    git(root, 'clone', '--quiet', remote, dir);
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'user.email', `${name}@example.invalid`);
    return dir;
  };
  return { root, remote, seed, a: clone('a'), b: clone('b') };
};

/** What main actually holds now. */
const readMain = (world, path) => {
  const peek = join(world.root, `peek-${Math.random().toString(36).slice(2)}`);
  git(world.root, 'clone', '--quiet', world.remote, peek);
  const doc = readJson(peek, path);
  rmSync(peek, { recursive: true, force: true });
  return doc;
};

/** One generation: append a leg + a card, and rebuild the regenerable file. */
const generate = (repo, { asOf, legSel, cardId, pHome, legSeen, cardSeen }) => {
  const legs = readJson(repo, 'data/estimates/parlays_2026.json');
  legs.generated_utc = asOf;
  legs.as_of_utc = asOf;
  legs.runs.push({ as_of_utc: asOf, legs_added: 1 });
  legs.legs.push(leg(legSel, legSeen || asOf, { model_prob: pHome }));
  writeJson(repo, 'data/estimates/parlays_2026.json', legs);

  const cards = readJson(repo, 'data/my_cards/2026_wk02.json');
  cards.generated_utc = asOf;
  cards.pool_generated_utc = asOf;
  cards.runs.push({ pool_generated_utc: asOf, cards_added: 1 });
  cards.cards.push(card(cardId, cardSeen || asOf, { model: pHome }));
  writeJson(repo, 'data/my_cards/2026_wk02.json', cards);

  writeJson(repo, 'data/game_predictions.json', {
    generated_utc: asOf,
    games: [{ game_id: 'g1', home: 'SEA', away: 'NE', p_home: pHome }],
  });
};

const cleanup = (world) => rmSync(world.root, { recursive: true, force: true });

/* ---------- static properties of the script ------------------------------ */

test('the script never forces a push and never asks for a fast-forward-only pull', () => {
  // Both were the old loop's only tools. One cannot resolve divergence; the
  // other resolves it by destroying the other writer's commit.
  assert.ok(!PUBLISH_SRC.includes('--force'), 'publish_data.sh must not force a push');
  assert.ok(!PUBLISH_SRC.includes('--ff-only'), 'publish_data.sh must not fast-forward-pull');
  assert.ok(!PUBLISH_SRC.includes('reset --hard'), 'it never discards another writer\'s work');
});

test('the DEFAULT contract gate is the real validate_data.py', () => {
  // The env var exists so this test can substitute a toy validator. If the
  // default drifted, production would publish through a gate that is not the
  // gate, and no other test would notice.
  assert.match(PUBLISH_SRC, /PUBLISH_VALIDATE_CMD:-python3 scripts\/validate_data\.py/);
  assert.match(PUBLISH_SRC, /PUBLISH_BACKOFF_S:-5/, 'the production backoff is 5s');
  assert.match(PUBLISH_SRC, /PUBLISH_ATTEMPTS:-5/, 'the production bound is 5 attempts');
});

test('merge_ledgers --selftest passes', () => {
  const r = spawnSync('python3', [MERGE, '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('merging a ledger with itself is byte-for-byte the identity (no churn)', () => {
  // A merge that reformats or reorders a file it did not change would put
  // cosmetic churn into every raced data commit.
  const out = join(mkdtempSync(join(tmpdir(), 'r88-identity-')), 'out.json');
  for (const p of ['data/estimates/parlays_2026.json', 'data/my_cards/2026_wk02.json',
                   'data/model_tuning.json', 'data/parlays/2026_wk01.json',
                   'data/parlays/2026_wk02.json', 'data/pipeline_stages.json',
                   'data/snapshots/2026_wk01_games_open.json',
                   'data/snapshots/2026_wk02_games_open.json']) {
    const src = join(ROOT, p);
    if (!existsSync(src)) continue;
    const r = spawnSync('python3', [MERGE, src, src, src, '--path', p, '--out', out],
                        { encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(out, 'utf8'), readFileSync(src, 'utf8'), `${p} changed`);
  }
});

test('an unknown ledger shape is refused with exit 2, never merged by guesswork', () => {
  const r = spawnSync('python3', [MERGE, '-', '-', '-', '--path', 'data/mystery.json',
                                  '--out', '/dev/null'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  // The *_games_open.json lock receipts ARE merged (G06); every other snapshot
  // is still refused, and the refusal says which is which.
  const snap = spawnSync('python3', [MERGE, '-', '-', '-', '--path',
                                     'data/snapshots/game_predictions.20260919T170334Z.json',
                                     '--out', '/dev/null'], { encoding: 'utf8' });
  assert.equal(snap.status, 2);
  assert.match(snap.stderr, /lock receipts/i);
});

/* ---------- (a) the ordinary case --------------------------------------- */

test('(a) clean push: no race, one commit, exit 0', () => {
  const world = makeWorld();
  try {
    generate(world.a, { asOf: TA, legSel: 'A ML', cardId: 'aaa', pHome: 0.61 });
    const r = publish(world.a, 'data: daily pipeline refresh [skip actions]');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /published/);

    assert.equal(readMain(world, 'data/game_predictions.json').generated_utc, TA);
    assert.equal(readMain(world, 'data/estimates/parlays_2026.json').legs.length, 2);
    assert.equal(git(world.a, 'log', '--oneline', 'origin/main').split('\n').length, 2);
  } finally { cleanup(world); }
});

test('(a2) nothing generated: exit 0 and no commit at all', () => {
  const world = makeWorld();
  try {
    const before = git(world.a, 'rev-parse', 'HEAD');
    const r = publish(world.a, 'data: daily pipeline refresh [skip actions]');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /No data changes to commit\./);
    assert.equal(git(world.a, 'rev-parse', 'HEAD'), before);
  } finally { cleanup(world); }
});

/* ---------- (b) two runs from the same base ------------------------------ */

test('(b) two racing generations: both ledgers keep both entries, the regenerable file is the rebasing run\'s', () => {
  const world = makeWorld();
  try {
    // A publishes first, from the base.
    generate(world.a, { asOf: TA, legSel: 'A ML', cardId: 'aaa', pHome: 0.61 });
    assert.equal(publish(world.a, 'data: gameday refresh [skip actions]').status, 0);

    // B generated from the SAME base and only now tries to publish.
    generate(world.b, { asOf: TB, legSel: 'B ML', cardId: 'bbb', pHome: 0.77 });
    const r = publish(world.b, 'data: daily pipeline refresh [skip actions]');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /main moved to/);
    assert.match(r.out, /merged by identity/);
    assert.match(r.out, /regenerable, taking this run's version/);

    const legs = readMain(world, 'data/estimates/parlays_2026.json');
    assert.deepEqual(legs.legs.map((l) => l.selection), ['SEA ML', 'A ML', 'B ML'],
                     'neither writer\'s locked leg may be dropped');
    assert.deepEqual(legs.runs.map((x) => x.as_of_utc), [T0, TA, TB],
                     'both runs[] records survive');
    assert.equal(legs.generated_utc, TB, 'the header takes the later as-of');

    const cards = readMain(world, 'data/my_cards/2026_wk02.json');
    assert.deepEqual(cards.cards.map((c) => c.card_id), ['base', 'aaa', 'bbb']);
    assert.deepEqual(cards.runs.map((x) => x.pool_generated_utc), [T0, TA, TB]);

    // THE STAGE PROOF: during a rebase ours is stage 3 (the commit being
    // replayed), not stage 2 (the head being replayed onto). B is the rebasing
    // run, so the regenerable file must be B's 0.77, never A's 0.61.
    const games = readMain(world, 'data/game_predictions.json');
    assert.equal(games.games[0].p_home, 0.77, 'the newest generation must win');
    assert.equal(games.generated_utc, TB);

    // A's commit is still on main, untouched, with A's own message.
    const log = git(world.b, 'log', '--format=%s', 'origin/main');
    assert.deepEqual(log.split('\n'), [
      'data: daily pipeline refresh [skip actions]',
      'data: gameday refresh [skip actions]',
      'base',
    ]);
  } finally { cleanup(world); }
});

/* ---------- (c) an owner code push -------------------------------------- */

test('(c) a code commit lands on main mid-run: the data commit replays onto it', () => {
  const world = makeWorld();
  try {
    generate(world.b, { asOf: TB, legSel: 'B ML', cardId: 'bbb', pHome: 0.77 });

    // The owner lands code on main while B is working.
    writeFileSync(join(world.a, 'app.js'), '// owner edit during the run\n');
    git(world.a, 'commit', '--quiet', '-am', 'app: owner edit');
    git(world.a, 'push', '--quiet', 'origin', 'main');

    const r = publish(world.b, 'data: daily pipeline refresh [skip actions]');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /main moved to/);

    const peek = join(world.root, 'peek-code');
    git(world.root, 'clone', '--quiet', world.remote, peek);
    assert.equal(readFileSync(join(peek, 'app.js'), 'utf8'), '// owner edit during the run\n',
                 'the owner\'s commit survives untouched');
    assert.equal(readJson(peek, 'data/game_predictions.json').generated_utc, TB);
    assert.equal(git(peek, 'log', '--format=%s', '-1'),
                 'data: daily pipeline refresh [skip actions]');
  } finally { cleanup(world); }
});

test('(c2) a CLEAN replay is put through the contract gate as well', () => {
  const world = makeWorld();
  try {
    // No conflicted path here (the owner touched only app.js), but the merged
    // tree still pairs this run's documents with a head it never saw. The
    // contracts check joins across files, so the gate runs either way.
    generate(world.b, { asOf: TB, legSel: 'B ML', cardId: 'bbb', pHome: 0.77 });
    writeFileSync(join(world.a, 'app.js'), '// owner edit during the run\n');
    git(world.a, 'commit', '--quiet', '-am', 'app: owner edit');
    git(world.a, 'push', '--quiet', 'origin', 'main');
    const mainBefore = git(world.a, 'rev-parse', 'origin/main');

    const r = publish(world.b, 'data: daily pipeline refresh [skip actions]',
                      { PUBLISH_VALIDATE_CMD: 'python3 tools/validate_stub.py --fail' });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /::error::.*fails the data contracts/s);

    git(world.b, 'fetch', '--quiet', 'origin', 'main');
    assert.equal(git(world.b, 'rev-parse', 'FETCH_HEAD'), mainBefore, 'main is untouched');
  } finally { cleanup(world); }
});

/* ---------- (d) the same key on both sides ------------------------------- */

const SAME = 'KC ML';

test('(d1) same leg key on both sides: the EARLIER first sight wins (it is theirs)', () => {
  const world = makeWorld();
  try {
    // A saw the leg at 09:00; B saw the same leg an hour later with a different
    // as-made price. First sight locks, so A's row is the record.
    generate(world.a, { asOf: TA, legSel: SAME, cardId: 'aaa', pHome: 0.61,
                        legSeen: '2026-09-19T09:00:00Z' });
    assert.equal(publish(world.a, 'data: gameday refresh [skip actions]').status, 0);

    generate(world.b, { asOf: TB, legSel: SAME, cardId: 'bbb', pHome: 0.77,
                        legSeen: '2026-09-19T12:00:00Z' });
    const r = publish(world.b, 'data: daily pipeline refresh [skip actions]');
    assert.equal(r.status, 0, r.out);

    const legs = readMain(world, 'data/estimates/parlays_2026.json');
    const rows = legs.legs.filter((l) => l.selection === SAME);
    assert.equal(rows.length, 1, 'one identity, one row');
    assert.equal(rows[0].seen_utc, '2026-09-19T09:00:00Z');
    assert.equal(rows[0].model_prob, 0.61, 'the as-made price of the FIRST sight');
  } finally { cleanup(world); }
});

test('(d2) same leg key, the earlier sight is OURS: the rebasing run\'s row wins', () => {
  const world = makeWorld();
  try {
    // The mirror image, so the rule cannot be "whichever side is convenient".
    generate(world.a, { asOf: TA, legSel: SAME, cardId: 'aaa', pHome: 0.61,
                        legSeen: '2026-09-19T14:00:00Z' });
    assert.equal(publish(world.a, 'data: gameday refresh [skip actions]').status, 0);

    generate(world.b, { asOf: TB, legSel: SAME, cardId: 'bbb', pHome: 0.77,
                        legSeen: '2026-09-19T08:00:00Z' });
    assert.equal(publish(world.b, 'data: daily pipeline refresh [skip actions]').status, 0);

    const rows = readMain(world, 'data/estimates/parlays_2026.json')
      .legs.filter((l) => l.selection === SAME);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seen_utc, '2026-09-19T08:00:00Z');
    assert.equal(rows[0].model_prob, 0.77);
  } finally { cleanup(world); }
});

/* ---------- (g) the week archive: frozen cards (G02) --------------------- */

test("(g) a raced refresh keeps BOTH sides' frozen cards and the newer live week", () => {
  // INDEPENDENT_REVIEW_R87_R91 G02's reproduction. A freezes two cards and closes
  // the week; B refreshes the same week a few minutes later with a card A never
  // saw. Until the archive had an identity spec the whole `parlays` list took the
  // later header and both of A's frozen cards vanished — while the log said
  // "both writers' entries kept".
  const world = makeWorld();
  try {
    const a = readJson(world.a, ARCHIVE);                    // A: freeze + close
    a.updated_utc = TA;
    a.archived_utc = TA;
    a.closed = true;
    a.parlays = [archiveCard('c-base', { frozen_utc: TA }),
                 archiveCard('c-frozen-A', { frozen_utc: TA })];
    a.history.push({ updated_utc: TA, archived_utc: TA, frozen: 2 });
    writeJson(world.a, ARCHIVE, a);
    assert.equal(publish(world.a, 'data: gameday refresh [skip actions]').status, 0);

    const b = readJson(world.b, ARCHIVE);                    // B: ordinary refresh
    b.updated_utc = TB;
    b.archived_utc = TB;
    b.parlays = [archiveCard('c-base'), archiveCard('c-refresh-B')];
    b.history.push({ updated_utc: TB, archived_utc: TB });
    writeJson(world.b, ARCHIVE, b);
    const r = publish(world.b, 'data: daily pipeline refresh [skip actions]');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /frozen cards kept/);

    const week = readMain(world, ARCHIVE);
    assert.deepEqual(week.parlays.map((c) => c.card_id),
                     ['c-base', 'c-frozen-A', 'c-refresh-B'],
                     "no frozen card may be dropped, and the newer run's card lands");
    const byId = Object.fromEntries(week.parlays.map((c) => [c.card_id, c]));
    assert.equal(byId['c-base'].frozen_utc, TA, 'the freeze stamp is untouched');
    assert.equal(byId['c-frozen-A'].frozen_utc, TA);
    assert.ok(!byId['c-refresh-B'].frozen_utc, 'a live card is still live');
    assert.equal(week.closed, true, 'a closed week never re-opens');
    assert.equal(week.updated_utc, TB, 'the header takes the later as-of');
    assert.deepEqual(week.history.map((h) => h.updated_utc), [T0, TA, TB]);
  } finally { cleanup(world); }
});

/* ---------- (h) pipeline_stages: one block per workflow (G05) ------------ */

test('(h) daily and gameday both write pipeline_stages: both blocks survive', () => {
  // G05's reproduction. The file is a CROSS-WORKFLOW ledger — stage_status.begin
  // resets only its own block — so "regenerable, taking this run's version"
  // deleted the other workflow's whole record, and the next begin re-seeded its
  // carries from the wiped file (every last_success_utc back to NEVER).
  const world = makeWorld();
  try {
    const a = readJson(world.a, STAGES);                     // the daily run
    a.generated_utc = TA;
    a.workflows.daily = wfBlock('2', TA, [stageRow('S1', TA)], { S1: T0 });
    writeJson(world.a, STAGES, a);
    assert.equal(publish(world.a, 'data: daily pipeline refresh [skip actions]').status, 0);

    const b = readJson(world.b, STAGES);                     // the gameday run
    b.generated_utc = TB;
    b.workflows.gameday = wfBlock('3', TB, [stageRow('G1', TB)], { G1: TB });
    writeJson(world.b, STAGES, b);
    const r = publish(world.b, 'data: gameday refresh [skip actions]');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /merged per workflow/);

    const doc = readMain(world, STAGES);
    assert.deepEqual(Object.keys(doc.workflows).sort(), ['daily', 'gameday'],
                     "neither workflow's block may be dropped");
    assert.equal(doc.workflows.daily.run_id, '2', "the later run's block wins");
    assert.deepEqual(doc.workflows.daily.stages.map((x) => x.name), ['S1']);
    assert.equal(doc.workflows.daily.last_success.S1, TA,
                 "the daily carry advances, it does not regress to the base's");
    assert.deepEqual(doc.workflows.gameday.stages.map((x) => x.name), ['G1']);
    assert.equal(doc.workflows.gameday.last_success.G1, TB);
    assert.equal(doc.generated_utc, TB, 'the header takes the later as-of');
  } finally { cleanup(world); }
});

/* ---------- (i) lock receipts: a grading is monotone (G06) --------------- */

test('(i) one run grades a lock receipt while the other appends: the grading survives', () => {
  // G06's reproduction. A resolves g1 against a FINAL score; B, from the same
  // base, only adds a new lock row. Taking B's file un-graded g1 and logged
  // "taking this run's grading" for a run that had graded nothing.
  const world = makeWorld();
  try {
    writeJson(world.a, RECEIPTS, [                           // A: grade g1
      receipt('g1', T0, { resolved: true, actual: 0, brier: 0.12, log_loss: 0.43 }),
    ]);
    assert.equal(publish(world.a, 'data: daily pipeline refresh [skip actions]').status, 0);

    writeJson(world.b, RECEIPTS, [receipt('g1', T0), receipt('g2', TB)]);  // B: append
    const r = publish(world.b, 'data: gameday refresh [skip actions]');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /merged by event_id/);
    assert.ok(!/taking this run's grading/.test(r.out),
              'the log must say what the run actually did');

    const rows = readMain(world, RECEIPTS);
    assert.deepEqual(rows.map((x) => x.event_id), ['g1', 'g2'],
                     "both writers' lock rows are kept");
    assert.equal(rows[0].resolved, true, 'a graded row is never un-graded');
    assert.equal(rows[0].actual, 0);
    assert.equal(rows[0].brier, 0.12);
    assert.equal(rows[0].log_loss, 0.43);
    assert.equal(rows[0].locked_utc, T0, 'the earlier lock stamp holds');
    assert.equal(rows[1].resolved, false, "the new lock is not graded by the merge");
  } finally { cleanup(world); }
});

test('(i2) a snapshot that is NOT a lock receipt aborts loudly instead of taking a side', () => {
  // The other half of the one rule: game_predictions.<ts>.json is a per-run
  // immutable file whose name is unique to its run, so two writers cannot
  // legitimately both write one. merge_ledgers.py refuses it by name; the shell
  // must agree rather than resolve it with take_ours (G06).
  const world = makeWorld();
  const SNAP = 'data/snapshots/game_predictions.20260919T170334Z.json';
  try {
    writeJson(world.a, SNAP, { generated_utc: TA, games: [{ game_id: 'g1', p_home: 0.61 }] });
    assert.equal(publish(world.a, 'data: gameday refresh [skip actions]').status, 0);
    const mainBefore = git(world.a, 'rev-parse', 'origin/main');

    writeJson(world.b, SNAP, { generated_utc: TB, games: [{ game_id: 'g1', p_home: 0.77 }] });
    const r = publish(world.b, 'data: daily pipeline refresh [skip actions]');
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /::error::conflict on the snapshot/);
    assert.match(r.out, /lock receipts/);
    assert.ok(!/taking this run's grading/.test(r.out));

    git(world.b, 'fetch', '--quiet', 'origin', 'main');
    assert.equal(git(world.b, 'rev-parse', 'FETCH_HEAD'), mainBefore, 'main is untouched');
    assert.ok(!existsSync(join(world.b, '.git/rebase-merge')), 'the rebase is abandoned');
    assert.equal(git(world.b, 'status', '--porcelain'), '', 'no debris left behind');
  } finally { cleanup(world); }
});

/* ---------- (e) an invalid merged tree ----------------------------------- */

test('(e) the contract gate fails on the merged tree: nothing is published and main is untouched', () => {
  const world = makeWorld();
  try {
    generate(world.a, { asOf: TA, legSel: 'A ML', cardId: 'aaa', pHome: 0.61 });
    assert.equal(publish(world.a, 'data: gameday refresh [skip actions]').status, 0);
    const mainBefore = git(world.a, 'rev-parse', 'origin/main');

    generate(world.b, { asOf: TB, legSel: 'B ML', cardId: 'bbb', pHome: 0.77 });
    const r = publish(world.b, 'data: daily pipeline refresh [skip actions]',
                      { PUBLISH_VALIDATE_CMD: 'python3 tools/validate_stub.py --fail' });

    assert.notEqual(r.status, 0, 'an invalid document must never be published');
    assert.match(r.out, /::error::/);
    assert.match(r.out, /fails the data contracts/);
    assert.match(r.out, /rebase aborted/);

    // main is exactly where A left it.
    git(world.b, 'fetch', '--quiet', 'origin', 'main');
    assert.equal(git(world.b, 'rev-parse', 'FETCH_HEAD'), mainBefore);

    // B's checkout is intact: no rebase in flight, and its own generation is
    // still committed and still B's.
    assert.ok(!existsSync(join(world.b, '.git/rebase-merge')));
    assert.ok(!existsSync(join(world.b, '.git/rebase-apply')));
    assert.equal(readJson(world.b, 'data/game_predictions.json').games[0].p_home, 0.77);
    assert.equal(git(world.b, 'status', '--porcelain'), '', 'no debris left behind');
  } finally { cleanup(world); }
});

/* ---------- (f) a remote that always says no ----------------------------- */

test('(f) a remote that always rejects: exactly 5 attempts, then one ::error:: and exit 1', () => {
  const world = makeWorld();
  try {
    const hook = join(world.remote, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "rejected by policy" >&2\nexit 1\n', { mode: 0o755 });

    generate(world.b, { asOf: TB, legSel: 'B ML', cardId: 'bbb', pHome: 0.77 });
    const started = Date.now();
    const r = publish(world.b, 'data: daily pipeline refresh [skip actions]');
    assert.equal(r.status, 1, r.out);

    const attempts = [...r.out.matchAll(/attempt (\d+): push rejected/g)].map((m) => m[1]);
    assert.deepEqual(attempts, ['1', '2', '3', '4', '5'], 'bounded at exactly 5');
    assert.equal((r.out.match(/::error::/g) || []).length, 1, 'one explicit failure line');
    assert.match(r.out, /could not publish data after 5 attempts/);
    // PUBLISH_BACKOFF_S=0 is honoured, so the bound costs no wall time.
    assert.ok(Date.now() - started < 20000, 'the test must not sit through the real backoff');

    // The generation is still committed locally: nothing was lost, it was just
    // not published.
    assert.equal(readJson(world.b, 'data/estimates/parlays_2026.json').legs.length, 2);
  } finally { cleanup(world); }
});

/* ---------- a conflict outside data/ ------------------------------------- */

test('a conflict outside data/ aborts loudly instead of picking a side', () => {
  const world = makeWorld();
  try {
    // Contrived on purpose: a pipeline commit never contains code. If one ever
    // does, the script must refuse rather than resolve it by rule.
    writeFileSync(join(world.a, 'app.js'), '// owner edit\n');
    git(world.a, 'commit', '--quiet', '-am', 'app: owner edit');
    git(world.a, 'push', '--quiet', 'origin', 'main');

    generate(world.b, { asOf: TB, legSel: 'B ML', cardId: 'bbb', pHome: 0.77 });
    writeFileSync(join(world.b, 'app.js'), '// conflicting pipeline edit\n');
    git(world.b, 'add', 'app.js');
    git(world.b, 'commit', '--quiet', '-m', 'app: stray code change');

    const r = publish(world.b, 'data: daily pipeline refresh [skip actions]');
    assert.notEqual(r.status, 0);
    assert.match(r.out, /::error::conflict outside data\//);
    assert.match(r.out, /app\.js/);
    assert.ok(!existsSync(join(world.b, '.git/rebase-merge')), 'the rebase is abandoned');
  } finally { cleanup(world); }
});
