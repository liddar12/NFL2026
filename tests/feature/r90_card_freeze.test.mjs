/* tests/feature/r90_card_freeze.test.mjs — R90/F12: a weekly parlay archive is no
 * longer mutable until the last game ends. It freezes CARD BY CARD, each at its own
 * earliest relevant kickoff.
 *
 * The archive used to replace an open week's whole `parlays` list on any content
 * change and freeze only when every game was FINAL, so a Thursday card could be
 * rewritten on Friday — after Thursday's result was known — with history keeping
 * timestamps alone. Locked here, through the CLI on fixtures in a temp data dir:
 *
 *   1. card_id is a short hash of the card's ORDERED LEG IDENTITY: reordering legs
 *      leaves it alone, changing scope, game or a leg moves it, and parlay_id (the
 *      rank) is not part of it.
 *   2. a Thursday card freezes while the week stays open, and is then carried
 *      forward verbatim; the rebuild may neither replace nor remove it.
 *   3. a Friday rebuild that changes that game's card rank appends a NEW card_id;
 *      the frozen one is intact and still first.
 *   4. a card for a game that has not kicked off still replaces its predecessor.
 *   5. a prop selection names a player, so its game comes from the R58 leg ledger;
 *      without the ledger the card cannot be placed and is never frozen.
 *   6. the week still closes when every game is FINAL, and a closed week is never
 *      rewritten.
 *   7. a fresh clone with the OLD archive shape (no card_id) is upgraded on the
 *      next refresh — the id is stamped and nothing else moves.
 *   8. idempotence: a second run over the same inputs writes zero bytes.
 *   9. the committed archives validate, carry a card_id on every card, and the
 *      consumers that join by parlay_id (scripts/replay_lab.py, build_review) are
 *      still clean.
 *
 * Node built-ins only; the CLI through spawnSync, the pure core through `python3 -`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FX = 'tests/fixtures/r73';
const PY_ENV = { ...process.env, PYTHONPATH: REPO_ROOT };
const SCHED = `${FX}/schedule_open.json`;
const CLOSED = `${FX}/schedule_closed.json`;
const LEDGER = `${FX}/ledger_wk1.json`;

const load = (p) => JSON.parse(readFileSync(resolve(REPO_ROOT, p), 'utf8'));
const unstamped = (cards) => cards.map(({ card_id, frozen_utc, ...rest }) => rest);
const ids = (cards) => cards.map((c) => c.parlay_id);

function runPy(code) {
  const out = execFileSync('python3', ['-'], { cwd: REPO_ROOT, env: PY_ENV, input: code, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

function archive(dataDir, parlays, now, { schedule = SCHED, ledger = LEDGER, extra = [] } = {}) {
  const args = ['scripts/build_parlay_archive.py', '--data', dataDir, '--parlays', parlays,
    '--schedule', schedule, '--now', now, ...(ledger ? ['--ledger', ledger] : []), ...extra];
  const r = spawnSync('python3', args, { cwd: REPO_ROOT, env: PY_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/* G1 (AAA v BBB) kicks off 2026-09-13T17:00Z; G2 (CCC v DDD) 2026-09-14T00:15Z. */
const WK1 = (dir) => join(dir, 'parlays', '2026_wk01.json');
const THU = `${FX}/parlays_wk1_thu.json`;
const FRI = `${FX}/parlays_wk1_fri.json`;

test('card_id is the ordered leg identity: leg order and rank are not part of it', () => {
  const r = runPy(`
import json
from scripts import build_parlay_archive as pa
card = {"parlay_id": "G1-g1", "scope": "game", "game_id": "G1",
        "legs": [{"market": "moneyline", "selection": "AAA ML"},
                 {"market": "spread", "selection": "AAA -3"}]}
rev = dict(card, parlay_id="G1-g4", legs=list(reversed(card["legs"])))
print(json.dumps({
  "same_reordered": pa.card_id(card) == pa.card_id(rev),
  "rank_free": "G1-g1" not in pa.card_identity(card),
  "other_game": pa.card_id(card) != pa.card_id(dict(card, game_id="G2")),
  "other_scope": pa.card_id(card) != pa.card_id(dict(card, scope="week")),
  "other_leg": pa.card_id(card) != pa.card_id(dict(card, legs=card["legs"][:1])),
  "stamped_next_to_parlay_id": list(pa.with_card_id(card))[:2],
  "stable": pa.card_id(card) == pa.card_id(json.loads(json.dumps(card))),
  "len": len(pa.card_id(card))}))`);
  assert.equal(r.same_reordered, true, 'reordered legs are the same bet');
  assert.equal(r.rank_free, true, 'the rank is not part of the identity');
  assert.deepEqual([r.other_game, r.other_scope, r.other_leg], [true, true, true]);
  assert.deepEqual(r.stamped_next_to_parlay_id, ['parlay_id', 'card_id']);
  assert.equal(r.stable, true);
  assert.equal(r.len, 12);
});

test('a Thursday card freezes while the week stays open; Friday appends instead of overwriting', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r90-freeze-'));
  try {
    // Thursday morning, nothing has kicked off: a plain create, nothing frozen.
    archive(tmp, THU, '2026-09-13T07:00:00Z');
    const a = load(WK1(tmp));
    assert.equal(a.closed, false);
    assert.ok(a.parlays.every((c) => c.frozen_utc === undefined), 'nothing has started');
    const byId = Object.fromEntries(a.parlays.map((c) => [c.parlay_id, c.card_id]));

    // Reordered legs, same bets, still before kickoff: the ids do not move.
    archive(tmp, `${FX}/parlays_wk1_thu_reordered.json`, '2026-09-13T12:00:00Z');
    const rr = load(WK1(tmp));
    assert.deepEqual(Object.fromEntries(rr.parlays.map((c) => [c.parlay_id, c.card_id])), byId,
      'reordering legs is not a new card');
    assert.equal(rr.parlays[0].legs[0].market, 'spread', 'the rebuild did replace them');

    // 20:00Z — G1 has kicked off (17:00), G2 has not (Sunday 00:15).
    const out = archive(tmp, FRI, '2026-09-13T20:00:00Z');
    assert.match(out, /wk 1 refreshed/);
    assert.match(out, /wk 1 4 card\(s\) frozen/);
    const f = load(WK1(tmp));
    assert.equal(f.closed, false, 'the week is still open');
    const frozen = f.parlays.filter((c) => c.frozen_utc);
    const live = f.parlays.filter((c) => !c.frozen_utc);
    assert.deepEqual(ids(f.parlays), ['G1-g1', 'week-1', 'week-2', 'G1-g1', 'G2-g1', 'week-3'],
      'carried-forward frozen cards first, in their archived order, then the rebuild');
    assert.deepEqual(ids(frozen), ['G1-g1', 'week-1', 'week-2', 'G1-g1']);
    assert.deepEqual(unstamped(f.parlays.slice(0, 3)),
      unstamped(rr.parlays.filter((c) => ['G1-g1', 'week-1', 'week-2'].includes(c.parlay_id))),
      'a frozen card is the archived copy, verbatim');
    assert.ok(frozen.every((c) => c.frozen_utc === '2026-09-13T20:00:00Z'));

    // the rank change: the same parlay_id over different legs is a NEW card
    const newG1 = f.parlays.filter((c) => c.parlay_id === 'G1-g1')[1];
    assert.notEqual(newG1.card_id, byId['G1-g1'], 'a new bet, a new id');
    assert.equal(newG1.legs[0].selection, 'BBB ML');
    assert.deepEqual(f.parlays[0].legs.map((l) => l.selection).sort(), ['AAA -3', 'AAA ML'],
      'the frozen card still holds the bet it was archived with');

    // a game that has NOT kicked off still reprices in place
    assert.deepEqual(ids(live), ['G2-g1', 'week-3']);
    const g2 = live.find((c) => c.parlay_id === 'G2-g1');
    assert.equal(g2.legs[0].implied_prob, 0.58, 'the Sunday card takes the rebuild');
    assert.equal(g2.card_id, byId['G2-g1'], 'same bet, same id');
    assert.equal(f.history.at(-1).frozen, 4, 'the refresh says how many cards it froze');
    assert.deepEqual(f.history.map((h) => h.updated_utc),
      ['2026-09-13T08:00:00Z', '2026-09-13T09:00:00Z', '2026-09-13T19:30:00Z']);

    // idempotence: the same inputs again write nothing at all
    const raw = readFileSync(WK1(tmp));
    const again = archive(tmp, FRI, '2026-09-13T21:00:00Z');
    assert.match(again, /wk 1 unchanged/);
    assert.ok(readFileSync(WK1(tmp)).equals(raw), 'a second run writes zero bytes');

    // the week still closes when every game is FINAL, and is then never rewritten
    const closing = archive(tmp, FRI, '2026-09-15T11:00:00Z', { schedule: CLOSED });
    assert.match(closing, /wk 1 closed/);
    const c = load(WK1(tmp));
    assert.equal(c.closed, true);
    assert.deepEqual(unstamped(c.parlays), unstamped(f.parlays), 'closing changes the flag, never the cards');
    assert.ok(c.parlays.every((x) => x.frozen_utc), 'every game has kicked off by the close');
    const rawClosed = readFileSync(WK1(tmp));
    archive(tmp, FRI, '2026-09-16T11:00:00Z', { schedule: CLOSED });
    assert.ok(readFileSync(WK1(tmp)).equals(rawClosed), 'a closed week is never rewritten');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a prop selection is placed by the R58 leg ledger; unplaceable cards are never frozen', () => {
  const r = runPy(`
import json
from scripts import build_parlay_archive as pa
games = json.load(open("${SCHED}"))["games"]
kicks, teams = pa.week_kickoffs(games, 1)
legs = pa.ledger_game_index(json.load(open("${LEDGER}")), 1)
cards = {c["parlay_id"]: c for c in json.load(open("${THU}"))["parlays"]}
fmt = lambda m: m.strftime("%Y-%m-%dT%H:%MZ") if m else None
print(json.dumps({
  "game": fmt(pa.earliest_kickoff(cards["G1-g1"], kicks, teams, legs)),
  "by_team": fmt(pa.earliest_kickoff(cards["week-1"], kicks, teams, legs)),
  "by_ledger": fmt(pa.earliest_kickoff(cards["week-2"], kicks, teams, legs)),
  "sunday_only": fmt(pa.earliest_kickoff(cards["week-3"], kicks, teams, legs)),
  "no_ledger": pa.earliest_kickoff(cards["week-2"], kicks, teams, {}),
  "ledger_rows": len(legs)}))`);
  assert.equal(r.game, '2026-09-13T17:00Z', 'a game card is its own game');
  assert.equal(r.by_team, '2026-09-13T17:00Z', 'a week card is the earliest game its legs name');
  assert.equal(r.by_ledger, '2026-09-13T17:00Z', 'the ledger places the prop that names a player');
  assert.equal(r.sunday_only, '2026-09-14T00:15Z', 'a card wholly in the Sunday game is still live');
  assert.equal(r.no_ledger, null, 'unplaceable is unknown, never started');
  assert.equal(r.ledger_rows, 3);
});

test('a fresh clone with the OLD archive shape is upgraded: card_id stamped, nothing else touched', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r90-upgrade-'));
  try {
    archive(tmp, THU, '2026-09-13T07:00:00Z');
    const stamped = load(WK1(tmp));
    // roll the file back to the pre-R90 shape, exactly as a clone of an older commit
    const old = { ...stamped, parlays: unstamped(stamped.parlays) };
    writeFileSync(WK1(tmp), `${JSON.stringify(old, null, 2)}\n`);
    const out = archive(tmp, `${FX}/parlays_wk2.json`, '2026-09-16T12:00:00Z');
    assert.match(out, /wk 1 upgraded .* \(card_id stamped on 5 card\(s\); nothing else touched\)/);
    const up = load(WK1(tmp));
    assert.deepEqual(unstamped(up.parlays), old.parlays, 'the cards themselves are untouched');
    assert.deepEqual([up.archived_utc, up.updated_utc, up.history, up.closed],
      [old.archived_utc, old.updated_utc, old.history, old.closed], 'an upgrade is not a refresh');
    assert.deepEqual(up.parlays.map((c) => c.card_id), stamped.parlays.map((c) => c.card_id),
      'the same ids the writer would have stamped');
    assert.ok(up.parlays.every((c) => c.frozen_utc === undefined), 'an upgrade freezes nothing');
    // and it happens once
    const raw = readFileSync(WK1(tmp));
    archive(tmp, `${FX}/parlays_wk2.json`, '2026-09-16T13:00:00Z');
    assert.ok(readFileSync(WK1(tmp)).equals(raw), 'an upgraded archive is upgraded once');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('committed archives: every card identified, frozen cards explain themselves, contracts green', () => {
  const index = load('data/parlays/index.json');
  const parlays = load('data/parlays.json');
  const schedule = load('data/schedule_full.json');
  const kickoff = Object.fromEntries(schedule.games.map((g) => [String(g.game_id), g.kickoff_utc]));
  for (const week of index.weeks) {
    const doc = load(week.path);
    assert.ok(doc.parlays.length > 0, `${week.path} has cards`);
    for (const card of doc.parlays) {
      assert.equal(typeof card.card_id, 'string', `${week.path} ${card.parlay_id} card_id`);
      assert.match(card.card_id, /^[0-9a-f]{12}$/);
      if (card.frozen_utc !== undefined) assert.equal(typeof card.frozen_utc, 'string');
      // a frozen GAME card names a game whose kickoff really has passed
      if (card.frozen_utc && card.game_id) {
        assert.ok(Date.parse(kickoff[String(card.game_id)]) <= Date.parse(card.frozen_utc),
          `${card.parlay_id} froze at or after its kickoff`);
      }
    }
    assert.equal(new Set(doc.parlays.map((c) => c.card_id)).size, doc.parlays.length,
      `${week.path}: one id per card`);
    // the open week: every card parlays.json built is either live or already frozen
    if (Number(week.week) === Number(parlays.week) && !doc.closed) {
      const identity = (c) => JSON.stringify([c.scope, c.game_id ?? null,
        c.legs.map((l) => `${l.market}|${l.selection}`).sort()]);
      const archived = new Set(doc.parlays.map(identity));
      for (const card of parlays.parlays) assert.ok(archived.has(identity(card)), card.parlay_id);
    }
  }
  const r = spawnSync('python3', ['scripts/validate_data.py'], { cwd: REPO_ROOT, env: PY_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok\s+parlays\/\d{4}_wk\d{2}\.json\s+vs parlays_archive\.schema\.json/);
});

test('the consumers that join by parlay_id ignore the new keys: selftests exit 0', () => {
  for (const args of [['scripts/build_parlay_archive.py', '--selftest'],
    ['scripts/replay_lab.py', '--selftest'], ['scripts/build_review.py', '--selftest']]) {
    const r = spawnSync('python3', args, { cwd: REPO_ROOT, env: PY_ENV, encoding: 'utf8' });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}\n${r.stdout.slice(-600)}`);
  }
});
