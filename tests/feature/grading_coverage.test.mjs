import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { inspectGrading, inspectGradingDirectory } from '../../scripts/validate_grading.mjs';

const script = fileURLToPath(new URL('../../scripts/validate_grading.mjs', import.meta.url));
const season = 2032;
const atdDirs = { week: 'atd_cards', game: 'atd_game_cards', my: 'atd_my_cards' };
const receiptPath = (dir, week) => `${dir}/${season}_wk${String(week).padStart(2, '0')}.json`;
const kickoff = (week) => `2032-09-0${week + 2}T17:00:00Z`;
const generated_utc = '2032-09-04T23:00:00Z';
const game = (id, week, home, away, status = 'STATUS_FINAL') => ({
  game_id: id, week, home, away, status, kickoff_utc: kickoff(week),
});
const moneyline = (game_id, team, side = 'home') => ({ game_id, team, side,
  market: 'moneyline', selection: `${team} ML` });
const touchdown = (game_id, team, gsis_id = 'p1') => ({ game_id, team, gsis_id,
  market: 'anytime_td', selection: `${gsis_id} anytime TD` });
const fullFinal = { home_score: 21, away_score: 14 };
const schedule = { season, updated_utc: '2032-09-04T22:00:00Z', games: [
  game('G1', 1, 'AAA', 'BBB'), game('G2', 2, 'CCC', 'DDD'),
  game('G3', 3, 'EEE', 'FFF', 'STATUS_SCHEDULED'),
] };

function fixture() {
  const records = {};
  const data = {
    facts: { season, excluded: [], generated_utc, grading_policy: 'event_bound_v1', weeks: {} },
    schedule: structuredClone(schedule), excludedGames: [],
    myScores: { season, generated_utc, cards: [], weeks: [] },
    atdScores: { season, generated_utc, cards: [], graded: 0 },
    readRecord: (path) => records[path], records,
  };
  for (const week of [1, 2]) {
    const g = data.schedule.games[week - 1];
    data.facts.weeks[week] = { games: { [g.game_id]: { h: g.home, a: g.away, k: g.kickoff_utc, hs: 21, as: 14 } },
      players: { p1: { y: null, td: 1 } }, players_by_game: { [g.game_id]: { p1: { y: null, td: 1 } } } };
    const myLeg = moneyline(g.game_id, g.home);
    const atdLeg = touchdown(g.game_id, g.home);
    records[receiptPath('my_cards', week)] = { season, week, cards: [{ card_id: 'my-card', locked: true, legs: [myLeg] }] };
    data.myScores.cards.push({ week, card_id: 'my-card', result: 'hit', legs: [{ ...myLeg, result: 'hit', actual: fullFinal }] });
    data.myScores.weeks.push({ week, graded: 1 });
    for (const [scope, dir] of Object.entries(atdDirs)) {
      records[receiptPath(dir, week)] = { season, week, cards: [{ card_id: 'atd-card', legs: [atdLeg] }] };
      data.atdScores.cards.push({ week, scope, card_id: 'atd-card', result: 'hit', legs: [{ ...atdLeg, result: 'hit', actual: { tds: 1 } }] });
      data.atdScores.graded += 1;
    }
  }
  return data;
}

function audit(data) {
  return inspectGrading({ ...data, receiptPaths: Object.keys(data.records) });
}

function assertPass({ my, atd, coverage }) {
  assert.deepEqual(my.mismatches, []);
  assert.deepEqual(atd.mismatches, []);
  assert.deepEqual(coverage.failures, []);
  assert.deepEqual(coverage.my.mismatches, []);
  assert.deepEqual(coverage.atd.mismatches, []);
}

test('an omitted MY grade and a whole omitted ATD week fail while the remaining rows agree', () => {
  const data = fixture();
  assertPass(audit(data));
  data.myScores.cards.shift();
  data.myScores.weeks.shift();
  data.atdScores.cards = data.atdScores.cards.filter(({ week }) => week === 2);
  data.atdScores.graded = data.atdScores.cards.length;
  const report = audit(data);
  assert.equal(report.my.compared, 1);
  assert.equal(report.atd.compared, 3);
  assert.deepEqual(report.my.mismatches, []);
  assert.deepEqual(report.atd.mismatches, []);
  assert.match(report.coverage.my.mismatches.join('\n'), /my_cards\/2032_wk01.json\/my-card: missing grade card/);
  assert.match(report.coverage.my.mismatches.join('\n'), /week 1: missing MY grade summary/);
  for (const dir of Object.values(atdDirs)) {
    assert.ok(report.coverage.atd.mismatches.some((message) => message.startsWith(`${dir}/2032_wk01.json/atd-card: missing grade card`)));
  }
});

test('an early miss settles a partial card while hits with unknown legs and future cards stay pending', () => {
  const data = fixture();
  const partial = game('GP', 2, 'GGG', 'HHH', 'STATUS_IN_PROGRESS');
  data.schedule.games.push(partial);
  data.facts.weeks[2].games.GP = { h: partial.home, a: partial.away, k: partial.kickoff_utc };
  const miss = moneyline('G2', 'DDD', 'away');
  const unstarted = touchdown('GP', 'GGG');
  const hit = moneyline('G2', 'CCC');
  const offers = data.records[receiptPath('my_cards', 2)].cards;
  offers.push({ card_id: 'early-miss', locked: true, legs: [miss, unstarted] });
  offers.push({ card_id: 'still-open', locked: true, legs: [hit, unstarted] });
  offers.push({ card_id: 'unlocked', locked: false, legs: [hit] });
  data.records[receiptPath('my_cards', 3)] = { season, week: 3,
    cards: [{ card_id: 'early-offer', locked: true, legs: [moneyline('G3', 'EEE')] }] };
  data.myScores.cards.push({ week: 2, card_id: 'early-miss', result: 'miss', legs: [
    { ...miss, result: 'miss', actual: fullFinal }, { ...unstarted, result: 'pending', actual: null },
  ] });
  data.myScores.weeks[1].graded += 1;
  const report = audit(data);
  assertPass(report);
  assert.equal(report.coverage.my.expected, 3);
  assert.equal(report.coverage.my.pending, 2);
  assert.equal(report.coverage.my.unlocked, 1);
  data.myScores.cards.pop();
  assert.match(audit(data).coverage.my.mismatches[0], /early-miss: missing grade card \(expected miss\)/);
});

test('missing FINAL fixtures and event-bound player evidence cannot turn deleted rows into ordinary pending cards', () => {
  const data = fixture();
  data.myScores.cards = data.myScores.cards.filter(({ week }) => week !== 2);
  data.myScores.weeks.pop();
  data.atdScores.cards = data.atdScores.cards.filter(({ week }) => week !== 1);
  data.atdScores.graded = data.atdScores.cards.length;
  delete data.facts.weeks[1].players_by_game.G1.p1;
  delete data.facts.weeks[2];
  const { failures } = audit(data).coverage;
  assert.match(failures.join('\n'), /week 1\/G1\/p1: event-bound player evidence is missing/);
  assert.match(failures.join('\n'), /week 2\/G2: bet facts are missing the scheduled fixture with FINAL evidence/);
});

test('explicit unknowns stay pending and a prior settled leg generates a transition diagnostic', () => {
  const data = fixture();
  data.priorFacts = structuredClone(data.facts);
  data.facts.weeks[1].players_by_game.G1.p1 = { y: null, td: null, reason: 'player_game_mismatch' };
  data.atdScores.cards = data.atdScores.cards.filter(({ week }) => week !== 1);
  data.atdScores.graded = data.atdScores.cards.length;
  const report = audit(data);
  assertPass(report);
  assert.equal(report.coverage.atd.pending, 3);
  assert.match(report.coverage.priorTransitions.join('\n'), /G1.*previously settled, now withheld \(player_game_mismatch\)/);
  data.facts.weeks[1].players_by_game.G1.p1.reason = 'arbitrary';
  assert.match(audit(data).coverage.failures.join('\n'), /withheld both outcomes without a recognized reason/);
});

test('malformed clocks invalidate fixture and legacy comparison boundaries', () => {
  const data = fixture();
  data.facts.generated_utc = 'not an instant';
  data.schedule.updated_utc = '2032-09-04T22:00:00';
  data.review = { season, generated_utc: '2032-13-04T23:00:00Z', weeks: {} };
  data.atdScores.generated_utc = null;
  const { failures } = audit(data).coverage;
  for (const artifact of ['bet_facts.json', 'schedule_full.json', 'review.json', 'ATD scores']) {
    assert.ok(failures.some((failure) => failure.startsWith(`${artifact}: invalid `)), artifact);
  }
});

test('a prior receipt inventory detects removal of its whole scope even alongside the score rows', () => {
  const data = fixture();
  data.priorReceiptPaths = Object.keys(data.records);
  for (const week of [1, 2]) delete data.records[receiptPath('atd_game_cards', week)];
  data.atdScores.cards = data.atdScores.cards.filter(({ scope }) => scope !== 'game');
  data.atdScores.graded = data.atdScores.cards.length;
  const report = audit(data);
  assert.deepEqual(report.atd.mismatches, []);
  assert.deepEqual(report.coverage.atd.mismatches, []);
  assert.equal(report.coverage.failures.filter((failure) => failure.startsWith('atd_game_cards/')).length, 2);
});

test('prior first-offered terms and identities survive changes to an existing receipt file', () => {
  const data = fixture();
  const myPath = receiptPath('my_cards', 1);
  const atdPath = receiptPath('atd_cards', 1);
  const first = data.records[myPath].cards[0];
  first.first_seen_utc = '2032-09-01T13:00:00Z';
  first.model = 0.65;
  const prior = structuredClone(data.records);
  prior[myPath].cards[0].locked = false;
  data.priorReceiptPaths = Object.keys(prior);
  data.readPriorRecord = (path) => prior[path];
  first.label = 'Updated display label';
  assertPass(audit(data));

  first.model = 0.68;
  first.first_seen_utc = '2032-09-02T13:00:00Z';
  first.legs[0].side = 'away';
  data.records[atdPath].cards = [];
  data.atdScores.cards = data.atdScores.cards.filter(({ scope, week }) => scope !== 'week' || week !== 1);
  data.atdScores.graded = data.atdScores.cards.length;
  const { failures } = audit(data).coverage;
  assert.match(failures.join('\n'), /immutable offer terms changed \(model, first_seen_utc\)/);
  assert.match(failures.join('\n'), /immutable offer leg 1 terms changed \(side\)/);
  assert.match(failures.join('\n'), /atd_cards\/2032_wk01.json\/atd-card: immutable offer receipt missing/);
});

test('fixture completeness follows the matching frozen review rather than newer schedule status', () => {
  const data = fixture();
  const source = 'ESPN grading capture immutable generation';
  data.facts.source = `finals: ${source}; stats: frozen fixture`;
  data.review = { season, generated_utc, sources: { finals: source }, weeks: {
    1: { games: [{ ...data.schedule.games[0], final: fullFinal }] },
    2: { games: [{ ...data.schedule.games[1], final: fullFinal }] },
    3: { games: [{ ...data.schedule.games[2] }] },
  } };
  data.schedule.games[2].status = 'STATUS_FINAL';
  data.records[receiptPath('my_cards', 3)] = { season, week: 3,
    cards: [{ card_id: 'future-card', locked: true, legs: [moneyline('G3', 'EEE')] }] };
  assertPass(audit(data));
  delete data.facts.weeks[1].games.G1.hs;
  delete data.facts.weeks[1].games.G1.as;
  assert.match(audit(data).coverage.failures.join('\n'), /week 1\/G1: bet facts lost FINAL evidence/);
});

test('published event-bound policy and same-fixture FINAL evidence survive coordinated omissions', () => {
  const data = fixture();
  data.priorFacts = structuredClone(data.facts);
  data.schedule.games[0].status = 'STATUS_SCHEDULED';
  data.myScores.cards.shift();
  data.myScores.weeks.shift();
  data.atdScores.cards = data.atdScores.cards.filter(({ week }) => week !== 1);
  data.atdScores.graded = data.atdScores.cards.length;
  delete data.facts.grading_policy;
  delete data.facts.weeks[1];
  const { failures } = audit(data).coverage;
  assert.match(failures.join('\n'), /event-bound grading policy is required/);
  assert.match(failures.join('\n'), /week 1\/G1: bet facts are missing the scheduled fixture with FINAL evidence/);
});

test('an explicit frozen correction can withhold an unverified legacy final, while verified history cannot disappear', () => {
  const data = fixture();
  data.priorFacts = structuredClone(data.facts);
  const source = 'ESPN grading capture correction fixture';
  data.facts.source = `finals: ${source}; stats: fixture`;
  const game = data.schedule.games[0];
  data.review = { season, generated_utc, sources: { finals: source }, weeks: {
    1: { games: [{ ...game, status: 'STATUS_POSTPONED', final: null, final_source: null }] },
  } };
  delete data.facts.weeks[1];
  data.myScores.cards.shift();
  data.myScores.weeks.shift();
  data.atdScores.cards = data.atdScores.cards.filter(({ week }) => week !== 1);
  data.atdScores.graded = data.atdScores.cards.length;
  assertPass(audit(data));
  data.priorReview = { season, weeks: { 1: { games: [{ ...game, final: fullFinal, final_source: 'espn_final' }] } } };
  assert.match(audit(data).coverage.failures.join('\n'), /week 1\/G1: bet facts are missing the scheduled fixture with FINAL evidence/);
});

test('configured exclusions drop only all-excluded cards and real voids still settle', () => {
  const data = fixture();
  const excluded = game('GX', 2, 'III', 'JJJ');
  data.schedule.games.push(excluded);
  data.excludedGames = [{ season, game_id: 'GX' }];
  data.facts.excluded = ['GX'];
  const offers = data.records[receiptPath('my_cards', 2)].cards;
  const voidLeg = moneyline('GX', 'III');
  offers.push({ card_id: 'fully-excluded', locked: true, legs: [voidLeg] });
  const push = { ...moneyline('G2', 'CCC'), market: 'spread', line: -7, selection: 'CCC -7' };
  offers.push({ card_id: 'push-and-excluded', locked: true, legs: [push, voidLeg] });
  data.myScores.cards.push({ week: 2, card_id: 'push-and-excluded', result: 'void', legs: [
    { ...push, result: 'void', reason: 'push', actual: fullFinal },
    { ...voidLeg, result: 'void', reason: 'excluded_game', actual: null },
  ] });
  data.myScores.weeks[1].graded += 1;
  const report = audit(data);
  assertPass(report);
  assert.equal(report.coverage.my.excluded, 1);
  data.facts.excluded.push('G1');
  assert.match(audit(data).coverage.failures.join('\n'), /excluded games differ from the configured exclusions/);
});

test('legacy facts may include outcomes for games that had not kicked off when scores were generated', () => {
  const data = fixture();
  const policy = data.facts.grading_policy;
  for (const scores of [data.myScores, data.atdScores]) {
    scores.generated_utc = '2032-09-04T16:00:00Z';
    scores.cards = scores.cards.filter(({ week }) => week === 1);
  }
  data.myScores.weeks.pop();
  data.atdScores.graded = data.atdScores.cards.length;
  delete data.facts.grading_policy;
  assertPass(audit(data));
  data.facts.grading_policy = policy;
  assert.match(audit(data).coverage.my.mismatches.join('\n'), /2032_wk02.json\/my-card: missing grade card/);
  assert.match(audit(data).coverage.atd.mismatches.join('\n'), /2032_wk02.json\/atd-card: missing grade card/);
});

test('duplicate grade rows are rejected and identical card IDs remain legal across weeks and scopes', () => {
  const data = fixture();
  assertPass(audit(data));
  data.atdScores.cards.push(data.atdScores.cards[0]);
  data.records[receiptPath('my_cards', 2)].cards.push(data.records[receiptPath('my_cards', 2)].cards[0]);
  const report = audit(data);
  assert.match(report.atd.mismatches.join('\n'), /duplicate score card/);
  assert.match(report.coverage.failures.join('\n'), /duplicate receipt inventory card/);
});

test('directory inspection distinguishes confirmed preseason emptiness from missing schedule evidence', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'grading-coverage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, doc) => {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  };
  write('bet_facts.json', { season, generated_utc, grading_policy: 'event_bound_v1', excluded: [], weeks: {} });
  write('my_card_scores.json', { season, generated_utc, cards: [], weeks: [] });
  write('atd_card_scores.json', { season: null, generated_utc, cards: [], graded: 0 });
  write('my_cards/2031_wk01.json', { season: 2031, week: 1, cards: [{ card_id: 'old-offer' }] });
  const scheduled = game('FUTURE', 1, 'AAA', 'BBB', 'STATUS_SCHEDULED');
  scheduled.kickoff_utc = '2032-09-10T17:00:00Z';
  write('schedule_full.json', { season, updated_utc: generated_utc, games: [scheduled] });
  const run = () => spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  const empty = run();
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /0\/0 gradeable cards from 0 receipts/);
  rmSync(join(dir, 'schedule_full.json'));
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /schedule_full.json: .*fixture inventory/);
});

test('shipped facts cover every gradeable MY and ATD receipt in the current data', () => {
  const report = inspectGradingDirectory();
  assert.deepEqual(report.failures, []);
  assertPass(report);
  for (const family of ['my', 'atd']) {
    assert.ok(report.coverage[family].expected > 0);
    assert.equal(report.coverage[family].expected, report.coverage[family].matched);
  }
});
