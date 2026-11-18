/* Offline parity check for recorded MY and ATD grades against the shipped facts.
 * This checks agreement between artifacts. It does not authenticate their inputs.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { gradeLeg } from '../app/bets.js';

const ROOT_DATA = fileURLToPath(new URL('../data/', import.meta.url));
const ATD_RECORDS = { week: 'atd_cards', game: 'atd_game_cards', my: 'atd_my_cards' };
const RECEIPT_FIELDS = ['game_id', 'gsis_id', 'line', 'side', 'season', 'direction', 'comparison_operator'];
const RESULTS = new Set(['hit', 'miss', 'void', 'pending']);

function matchingLeg(receipt, scored) {
  if (!receipt) return false;
  if (scored.receipt_id != null) return scored.receipt_id === receipt.learning_receipt?.receipt_id;
  return receipt.market === scored.market && receipt.selection === scored.selection
    && (scored.game_id == null || scored.game_id === receipt.game_id)
    && (scored.gsis_id == null || scored.gsis_id === receipt.gsis_id);
}

function inspectScores(facts, scores, family, readRecord) {
  const report = { compared: 0, mismatches: [] };
  const flag = (message) => report.mismatches.push(message);
  if (!Array.isArray(scores?.cards)) {
    flag(`${family} score document lacks its cards array`);
    return report;
  }
  const season = scores.season;
  if (!Number.isInteger(season) || season !== facts?.season) {
    flag(`${family} score season ${season} does not match bet-facts season ${facts?.season}`);
    return report;
  }

  const eventBound = facts.grading_policy === 'event_bound_v1';
  const seenCards = new Set();
  const records = new Map();
  for (const score of scores.cards) {
    const { week, scope, card_id: id } = score ?? {};
    const dir = family === 'MY' ? 'my_cards' : (Object.hasOwn(ATD_RECORDS, scope) && ATD_RECORDS[scope]);
    if (!dir || !Number.isInteger(week) || week < 1 || week > 22 || typeof id !== 'string' || !id
        || (score.season != null && score.season !== season)) {
      flag(`invalid ${family} score identity ${JSON.stringify({ season: score.season ?? season, week, scope, id })}`);
      continue;
    }
    const path = `${dir}/${season}_wk${String(week).padStart(2, '0')}.json`;
    const cardKey = `${path}/${id}`;
    if (seenCards.has(cardKey)) {
      flag(`${cardKey}: duplicate score card`);
      continue;
    }
    seenCards.add(cardKey);

    if (!records.has(path)) {
      const byId = new Map();
      records.set(path, byId);
      try {
        const doc = readRecord(path);
        if (doc.season !== season || doc.week !== week || !Array.isArray(doc.cards)) {
          flag(`${path}: receipt season, week or cards differ from the expected ${season} week ${week} record`);
        } else {
          for (const card of doc.cards) {
            if (byId.has(card.card_id)) {
              flag(`${path}/${card.card_id}: duplicate receipt card`);
              byId.set(card.card_id, null);
            } else {
              byId.set(card.card_id, card);
            }
          }
        }
      } catch (error) {
        flag(`${path}: cannot read receipt record (${error.message})`);
      }
    }
    const receipt = records.get(path).get(id);
    if (!Array.isArray(receipt?.legs) || !Array.isArray(score.legs)) {
      flag(`${cardKey}: score card has no unique receipt with legs`);
      continue;
    }
    if (score.legs.length !== receipt.legs.length || !receipt.legs.length) {
      flag(`${cardKey}: scored ${score.legs.length} legs for a receipt with ${receipt.legs.length} legs`);
    }

    const factsWeek = facts.weeks?.[week];
    if (eventBound && (!factsWeek?.players_by_game || Array.isArray(factsWeek.players_by_game)
        || typeof factsWeek.players_by_game !== 'object')) {
      flag(`${cardKey}: event-bound facts are missing the week ${week} players_by_game map`);
      continue;
    }

    const usedLegs = new Set();
    for (const scored of score.legs) {
      if (!scored) {
        flag(`${cardKey}: missing scored leg`);
        continue;
      }
      const label = `${cardKey} ${scored.market} ${scored.selection}`;
      const matches = receipt.legs.filter((leg) => matchingLeg(leg, scored));
      if (matches.length !== 1 || usedLegs.has(matches[0])) {
        flag(`${label}: no unique corresponding receipt leg`);
        continue;
      }
      const [leg] = matches;
      usedLegs.add(leg);
      const fields = RECEIPT_FIELDS.filter((field) => Object.hasOwn(scored, field)
        && !isDeepStrictEqual(scored[field], leg[field] ?? null));
      if (fields.length || scored.market !== leg.market || scored.selection !== leg.selection
          || (leg.season != null && leg.season !== season) || (leg.week != null && leg.week !== week)) {
        flag(`${label}: recorded leg identity or terms differ from its receipt${fields.length ? ` (${fields.join(', ')})` : ''}`);
        continue;
      }
      if (!RESULTS.has(scored.result)) {
        flag(`${label}: invalid recorded result ${scored.result}`);
        continue;
      }
      if (leg.slip_result != null) {
        flag(`${label}: receipt carries a slip result that bypasses grading from bet facts`);
        continue;
      }
      let got;
      try {
        got = gradeLeg({ ...leg, season, week }, facts);
      } catch (error) {
        flag(`${label}: cannot grade from bet facts (${error.message})`);
        continue;
      }
      report.compared += 1;
      // Legacy facts may be newer than the scores. Event-bound facts and
      // scores must agree about pending as well as settled outcomes.
      if (!eventBound && scored.result === 'pending' && got.result !== 'pending') continue;
      if (scored.result !== got.result || !isDeepStrictEqual(scored.actual, got.actual)
          || (scored.result === 'void' && scored.reason != null && scored.reason !== got.reason)) {
        const evidence = (row) => JSON.stringify({ result: row.result, actual: row.actual, reason: row.reason });
        flag(`${label}: score ${evidence(scored)} differs from bet facts ${evidence(got)}`);
      }
    }
  }
  return report;
}

export function inspectGrading({ facts, myScores, atdScores, readRecord }) {
  return {
    my: inspectScores(facts, myScores, 'MY', readRecord),
    atd: inspectScores(facts, atdScores, 'ATD', readRecord),
  };
}

export function inspectGradingDirectory(dataDir = ROOT_DATA) {
  const readRecord = (path) => JSON.parse(readFileSync(join(dataDir, path), 'utf8'));
  const failures = [];
  function read(path) {
    try {
      return readRecord(path);
    } catch (error) {
      failures.push(`${path}: ${error.message}`);
      return null;
    }
  }
  const report = inspectGrading({
    facts: read('bet_facts.json'),
    myScores: read('my_card_scores.json'),
    atdScores: read('atd_card_scores.json'),
    readRecord,
  });
  return { ...report, failures };
}

function main(dataDir) {
  const report = inspectGradingDirectory(dataDir);
  let failed = report.failures.length > 0;
  for (const message of report.failures) console.error(message);
  for (const [family, result] of Object.entries({ MY: report.my, ATD: report.atd })) {
    console.log(`${family} grading: ${result.compared} legs compared, ${result.mismatches.length} mismatches`);
    for (const message of result.mismatches.slice(0, 10)) console.error(`${family}: ${message}`);
    if (!result.compared) console.error(`${family}: expected at least one comparable leg`);
    if (!result.compared || result.mismatches.length) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv[2]);
}
