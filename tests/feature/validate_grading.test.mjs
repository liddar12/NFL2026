import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectGrading } from '../../scripts/validate_grading.mjs';

const script = fileURLToPath(new URL('../../scripts/validate_grading.mjs', import.meta.url));
const season = 2032;
const week = 8;
const myPath = 'my_cards/2032_wk08.json';
const atdPaths = { week: 'atd_cards', game: 'atd_game_cards', my: 'atd_my_cards' };

function fixture() {
  const player = { game_id: 'G1', gsis_id: 'p1', team: 'BBB' };
  const yards = { ...player, market: 'rb_rush_yds', line: 59.5, selection: 'B. Back 60+ rush yds',
    learning_receipt: { receipt_id: 'yards-receipt' } };
  const spread = { market: 'spread', line: -7, selection: 'AAA -7', game_id: 'G1', team: 'AAA', side: 'home' };
  const td = { ...player, market: 'anytime_td', selection: 'B. Back anytime TD' };
  const facts = { season, grading_policy: 'event_bound_v1', weeks: { [week]: {
    games: { G1: { h: 'AAA', a: 'BBB', hs: 24, as: 17 } },
    players_by_game: { G1: { p1: { y: [0, 72, 5], td: 2 } } },
    players: { p1: { y: [0, 72, 5], td: 2 } },
  } } };
  const records = { [myPath]: { season, week, cards: [{ card_id: 'my-card', legs: [yards, spread] }] } };
  const myScores = { season, cards: [{ card_id: 'my-card', week, legs: [
    { market: yards.market, selection: yards.selection, line: yards.line, receipt_id: 'yards-receipt', result: 'hit', actual: 72 },
    { market: spread.market, selection: spread.selection, result: 'void', actual: { away_score: 17, home_score: 24 }, reason: 'push' },
  ] }] };
  const atdScores = { season, cards: Object.entries(atdPaths).map(([scope, path]) => {
    records[`${path}/2032_wk08.json`] = { season, week, cards: [{ card_id: 'atd-card', legs: [td] }] };
    return { card_id: 'atd-card', week, scope, legs: [
      { market: td.market, selection: td.selection, result: 'hit', actual: { tds: 2 } },
    ] };
  }) };
  return { facts, myScores, atdScores, records, readRecord: (path) => records[path] };
}

test('grading parity joins season, week and all ATD scopes to locked terms', () => {
  assert.deepEqual(inspectGrading(fixture()), {
    my: { compared: 2, mismatches: [] }, atd: { compared: 3, mismatches: [] },
  });
});

test('reports both families when the outcome agrees but actuals or void reasons differ', () => {
  const data = fixture();
  data.myScores.cards[0].legs[0].actual = 71;
  data.myScores.cards[0].legs[1].reason = 'excluded_game';
  data.atdScores.cards[0].legs[0].actual = { tds: 1 };
  const { my, atd } = inspectGrading(data);
  assert.equal(my.mismatches.length, 2);
  assert.match(my.mismatches[0], /actual":71.*actual":72/);
  assert.match(my.mismatches[1], /excluded_game.*push/);
  assert.equal(atd.mismatches.length, 1);
  assert.match(atd.mismatches[0], /"tds":1.*"tds":2/);
});

test('event-bound pending must agree while legacy facts may settle a prior pending leg', () => {
  const data = fixture();
  const scored = data.myScores.cards[0].legs[0];
  scored.result = 'pending';
  scored.actual = null;
  assert.match(inspectGrading(data).my.mismatches[0], /pending.*hit/);
  delete data.facts.grading_policy;
  delete data.facts.weeks[week].players_by_game;
  assert.deepEqual(inspectGrading(data).my.mismatches, []);
});

test('rejects duplicate cards and legs, mismatched seasons and terms, and missing joins', () => {
  const cases = [
    [(d) => { d.myScores.season -= 1; }, /score season.*does not match/],
    [(d) => { d.records[myPath].season -= 1; }, /receipt season, week or cards differ/],
    [(d) => { d.records[myPath].cards.push(d.records[myPath].cards[0]); }, /duplicate receipt card/],
    [(d) => { d.myScores.cards.push(d.myScores.cards[0]); }, /duplicate score card/],
    [(d) => { delete d.records[myPath]; }, /cannot read receipt record/],
    [(d) => { d.myScores.cards[0].legs[1] = d.myScores.cards[0].legs[0]; }, /no unique corresponding receipt leg/],
    [(d) => { d.myScores.cards[0].legs[0].line += 1; }, /terms differ.*line/],
    [(d) => { d.records[myPath].cards[0].legs[0].season = season - 1; }, /terms differ/],
    [(d) => { d.records[myPath].cards[0].legs[0].slip_result = 'hit'; }, /bypasses grading/],
    [(d) => { delete d.facts.weeks[week].players_by_game; }, /missing .*players_by_game/],
  ];
  for (const [mutate, expected] of cases) {
    const data = fixture();
    mutate(data);
    assert.match(inspectGrading(data).my.mismatches.join('\n'), expected);
  }
  const data = fixture();
  const path = 'atd_cards/2032_wk08.json';
  const { legs } = data.records[path].cards[0];
  legs.push({ ...legs[0] });
  assert.match(inspectGrading(data).atd.mismatches.join('\n'), /no unique corresponding receipt leg/);
});

test('CLI requires positive MY and ATD coverage from the selected data directory', () => {
  const data = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'grading-parity-'));
  function write(file, doc) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  try {
    for (const [path, doc] of Object.entries(data.records)) write(path, doc);
    write('bet_facts.json', data.facts);
    write('my_card_scores.json', data.myScores);
    write('atd_card_scores.json', data.atdScores);
    const run = () => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    const pass = run();
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /MY grading: 2 legs compared.*\nATD grading: 3 legs compared/);
    write('atd_card_scores.json', { season, cards: [] });
    const fail = run();
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /ATD: expected at least one comparable leg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
