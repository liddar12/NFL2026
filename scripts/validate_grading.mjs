/* Check MY and ATD grades against the browser's facts and offer receipts.
 * Receipt inventory determines which cards should appear in the grade feeds.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { gradeLeg } from '../app/bets.js';

const ROOT_DATA = fileURLToPath(new URL('../data/', import.meta.url));
const EXCLUDED_GAMES = fileURLToPath(new URL('../config/excluded_games.json', import.meta.url));
const ATD_RECORDS = { week: 'atd_cards', game: 'atd_game_cards', my: 'atd_my_cards' };
const RECORD_DIRS = ['my_cards', ...Object.values(ATD_RECORDS)];
const RECEIPT_FIELDS = ['game_id', 'gsis_id', 'line', 'side', 'season', 'direction', 'comparison_operator'];
const OFFER_CARD_TERMS = ['dial', 'seed', 'mode', 'n_legs', 'earliest_kickoff_utc', 'model', 'model_prob',
  'implied', 'payout', 'break_even_american'];
const OFFER_LEG_TERMS = [...RECEIPT_FIELDS, 'market', 'selection', 'team', 'week', 'nflverse_id',
  'model_prob', 'implied_prob', 'price_source', 'priced', 'learning_receipt'];
const RESULTS = new Set(['hit', 'miss', 'void', 'pending']);
const PLAYER_MARKETS = new Set(['anytime_td', 'qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds']);
const FINAL_STATUSES = new Set(['STATUS_FINAL', 'STATUS_FINAL_OVERTIME']);
// Withholding reasons produced by player_outcomes for a verified fixture,
// plus the recorded identity conflict detected by build_bet_facts.
const FINAL_PLAYER_UNKNOWNS = new Set([
  'ambiguous', 'identity_conflict', 'identity_position_conflict', 'identity_unverified',
  'identity_unverified_team_change', 'missing_stat_value', 'no_stat_line', 'player_game_mismatch',
  'player_unidentified', 'receipt_team_mismatch', 'recorded_identity_conflict', 'snap_count_unknown',
  'source_game_conflict', 'source_game_invalid', 'source_team_conflict', 'week_not_published',
]);

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const validWeek = (week) => Number.isInteger(week) && week >= 1 && week <= 22;
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const instant = (value) => typeof value === 'string' && ZONED_TIME.test(value) ? Date.parse(value) : NaN;
const recordPath = (dir, season, week) => `${dir}/${season}_wk${String(week).padStart(2, '0')}.json`;
const recordDir = (family, scope) => family === 'MY' ? 'my_cards'
  : (Object.hasOwn(ATD_RECORDS, scope) && ATD_RECORDS[scope]);
const validScore = (score) => Number.isInteger(score) && score >= 0;
const hasFullScore = (game) => validScore(game?.hs) && validScore(game?.as);
const hasFinal = (game) => hasFullScore(game) || ['home', 'away'].includes(game?.w);
const hasCapture = (facts) => typeof facts.source === 'string' && facts.source.startsWith('finals: ESPN grading capture ');

function matchingLeg(receipt, scored) {
  if (!receipt) return false;
  if (scored.receipt_id != null) return scored.receipt_id === receipt.learning_receipt?.receipt_id;
  return receipt.market === scored.market && receipt.selection === scored.selection
    && (scored.game_id == null || scored.game_id === receipt.game_id)
    && (scored.gsis_id == null || scored.gsis_id === receipt.gsis_id);
}

function inspectScores(facts, scores, family, readRecord, emptyAtdSeason) {
  const report = { compared: 0, mismatches: [] };
  const flag = (message) => report.mismatches.push(message);
  if (!Array.isArray(scores?.cards)) {
    flag(`${family} score document lacks its cards array`);
    return report;
  }
  const season = scores.season;
  if (emptyAtdSeason && season === null && !scores.cards.length) return report;
  if (!Number.isInteger(season) || season !== facts?.season) {
    flag(`${family} score season ${season} does not match bet-facts season ${facts?.season}`);
    return report;
  }

  const eventBound = facts.grading_policy === 'event_bound_v1';
  const seenCards = new Set();
  const rows = [];
  for (const score of scores.cards) {
    const { week, scope, card_id: id } = score ?? {};
    const dir = recordDir(family, scope);
    if (!dir || !validWeek(week) || typeof id !== 'string' || !id
        || (score?.season != null && score.season !== season)) {
      flag(`invalid ${family} score identity ${JSON.stringify({ season: score?.season ?? season, week, scope, id })}`);
      continue;
    }
    const path = recordPath(dir, season, week);
    const cardKey = `${path}/${id}`;
    if (seenCards.has(cardKey)) {
      flag(`${cardKey}: duplicate score card`);
      continue;
    }
    seenCards.add(cardKey);
    rows.push({ score, path, cardKey });
  }

  // Keep a single parsed receipt book in memory even for score feeds that
  // interleave weeks or scopes.
  rows.sort((a, b) => a.path.localeCompare(b.path));
  let currentPath;
  let byId;
  for (const { score, path, cardKey } of rows) {
    const { week, card_id: id } = score;
    if (path !== currentPath) {
      currentPath = path;
      byId = new Map();
      try {
        const doc = readRecord(path);
        if (doc.season !== season || doc.week !== week || !Array.isArray(doc.cards)) {
          flag(`${path}: receipt season, week or cards differ from the expected ${season} week ${week} record`);
        } else {
          for (const card of doc.cards) {
            if (byId.has(card?.card_id)) {
              flag(`${path}/${card?.card_id}: duplicate receipt card`);
              byId.set(card?.card_id, null);
            } else {
              byId.set(card?.card_id, card);
            }
          }
        }
      } catch (error) {
        flag(`${path}: cannot read receipt record (${error.message})`);
      }
    }
    const receipt = byId.get(id);
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

function indexReviewFixtures(review, season) {
  const fixtures = new Map();
  if (review?.season === season && isObject(review.weeks)) {
    for (const [week, block] of Object.entries(review.weeks)) {
      for (const row of Array.isArray(block?.games) ? block.games : []) {
        if (row?.game_id) fixtures.set(String(row.game_id), { ...row, week: Number(week) });
      }
    }
  }
  return fixtures;
}

function indexFixtures(schedule, review, facts, priorFacts, priorReview, flag) {
  const byId = new Map();
  const byTeam = new Map();
  if (schedule?.season !== facts.season || !Array.isArray(schedule?.games)) {
    flag(`schedule_full.json: expected fixture inventory for season ${facts.season}`);
    return { byId, byTeam };
  }
  // A live schedule refresh can postdate the frozen observation. Its status
  // cannot fill in a game the grading capture could not verify.
  const captured = hasCapture(facts);
  const reviewSource = review?.sources?.finals;
  const matchingCapture = captured && review?.season === facts.season && reviewSource
    && facts.source.startsWith(`finals: ${reviewSource}; stats:`);
  if (captured && !matchingCapture) flag('review.json: missing FINAL fixture evidence from the bet-facts grading capture');
  const factsAsOf = instant(facts.generated_utc);
  const scheduleAsOf = instant(schedule.updated_utc);
  const reviewAsOf = instant(review?.generated_utc);
  if (!Number.isFinite(scheduleAsOf)) flag('schedule_full.json: invalid updated_utc');
  if (review?.season === facts.season && !Number.isFinite(reviewAsOf)) flag('review.json: invalid generated_utc');
  if (review?.season === facts.season && !isObject(review.weeks)) flag('review.json: missing fixture weeks map');
  const useReviewStatus = Number.isFinite(reviewAsOf) && (matchingCapture || (!captured && reviewAsOf <= factsAsOf));
  const useScheduleStatus = !captured && scheduleAsOf <= factsAsOf;
  const reviewedFixtures = indexReviewFixtures(review, facts.season);
  const previouslyReviewed = indexReviewFixtures(priorReview, facts.season);
  for (const live of schedule.games) {
    if (!isObject(live)) {
      flag('schedule_full.json: invalid fixture in schedule inventory');
      continue;
    }
    const id = String(live.game_id ?? '');
    const { week } = live;
    if (!id || !validWeek(week) || !live.home || !live.away || live.home === live.away
        || (live.season != null && live.season !== facts.season) || byId.has(id)) {
      flag(`schedule_full.json: invalid or duplicate fixture ${id} in week ${week}`);
      continue;
    }
    const reviewed = reviewedFixtures.get(id);
    const sameTeams = reviewed?.week === week && reviewed.home === live.home && reviewed.away === live.away;
    // For a matching capture, review carries the frozen schedule's kickoff.
    const fixture = matchingCapture && sameTeams ? reviewed : live;
    const kickoff = instant(fixture.kickoff_utc);
    if (!Number.isFinite(kickoff)) flag(`schedule_full.json: invalid kickoff for fixture ${id} in week ${week}`);
    const sameKickoff = instant(reviewed?.kickoff_utc) === kickoff;
    const reviewFinal = sameTeams && sameKickoff && FINAL_STATUSES.has(reviewed.status) ? reviewed.final : null;
    const scheduleFinal = useScheduleStatus && FINAL_STATUSES.has(live.status);
    const final = (useReviewStatus || scheduleFinal) ? reviewFinal : null;
    const previous = priorFacts?.season === facts.season ? priorFacts.weeks?.[week]?.games?.[id] : null;
    const prior = previouslyReviewed.get(id);
    const verifiedPrior = prior?.week === week && prior.home === fixture.home && prior.away === fixture.away
      && instant(prior.kickoff_utc) === kickoff && prior.final_source === 'espn_final' && FINAL_STATUSES.has(prior.status)
      && validScore(prior.final?.home_score) && validScore(prior.final?.away_score);
    // A current capture explicitly reporting non-FINAL may correct a score
    // that was never backed by a verified review. Missing status is unknown.
    const corrected = matchingCapture && sameTeams && sameKickoff && typeof reviewed.status === 'string'
      && reviewed.status.startsWith('STATUS_') && !FINAL_STATUSES.has(reviewed.status)
      && reviewed.final === null && reviewed.final_source === null;
    const priorFullScore = verifiedPrior || (!corrected && hasFullScore(previous) && previous.h === fixture.home
      && previous.a === fixture.away && instant(previous.k) === kickoff);
    const row = { ...fixture, id, kickoff, final, priorFullScore,
      knownFinal: scheduleFinal || Boolean(final) || priorFullScore };
    byId.set(id, row);
    for (const team of [row.home, row.away]) {
      const key = `${week}/${team}`;
      byTeam.set(key, byTeam.has(key) ? null : row);
    }
  }
  return { byId, byTeam };
}

function inspectLegEvidence(leg, week, facts, fixtures, flag) {
  const id = leg.game_id == null ? null : String(leg.game_id);
  const team = leg.team || leg.selection.split(' ')[0];
  const fixture = id == null ? fixtures.byTeam.get(`${week}/${team}`) : fixtures.byId.get(id);
  if (!fixture || fixture.week !== week) {
    flag(`week ${week}/${id ?? team}: missing independent fixture evidence for offer receipt`);
    return fixture;
  }
  const factsWeek = facts.weeks[week];
  const game = factsWeek?.games?.[fixture.id];
  const label = `week ${week}/${fixture.id}`;
  if ((fixture.knownFinal || factsWeek) && !isObject(game)) {
    flag(`${label}: bet facts are missing the scheduled fixture${fixture.knownFinal ? ' with FINAL evidence' : ''}`);
  } else if (game) {
    const k = fixture.kickoff;
    if (game.h !== fixture.home || game.a !== fixture.away || instant(game.k) !== k) {
      flag(`${label}: bet facts fixture identity differs from the schedule or captured review`);
    }
    if ((fixture.knownFinal && !hasFinal(game)) || (fixture.priorFullScore && !hasFullScore(game))) {
      flag(`${label}: bet facts lost FINAL evidence`);
    }
    if (validScore(fixture.final?.home_score) && validScore(fixture.final?.away_score)
        && (game.hs !== fixture.final.home_score || game.as !== fixture.final.away_score)) {
      flag(`${label}: bet facts score differs from the verified FINAL review`);
    }
    if (hasFinal(game) && k > instant(facts.generated_utc)) flag(`${label}: bet facts show a FINAL before kickoff`);
  }
  if (facts.grading_policy === 'event_bound_v1' && factsWeek && !isObject(factsWeek.players_by_game)) {
    flag(`week ${week}: event-bound facts are missing the players_by_game map`);
  }
  // The event-bound producer writes a row for every recorded player/fixture,
  // even when the row can only describe why it withheld an outcome.
  if (facts.grading_policy === 'event_bound_v1' && (fixture.knownFinal || hasFinal(game))
      && PLAYER_MARKETS.has(leg.market) && id != null && leg.gsis_id != null) {
    const row = factsWeek?.players_by_game?.[id]?.[leg.gsis_id];
    if (!isObject(row) || !Object.hasOwn(row, 'y') || !Object.hasOwn(row, 'td')) {
      flag(`${label}/${leg.gsis_id}: event-bound player evidence is missing from the FINAL fixture`);
    } else if (row.y == null && row.td == null && !FINAL_PLAYER_UNKNOWNS.has(row.reason)) {
      flag(`${label}/${leg.gsis_id}: event-bound facts withheld both outcomes without a recognized reason`);
    }
  }
  return fixture;
}

function cardResult(legs) {
  if (legs.includes('miss')) return 'miss';
  if (legs.includes('pending')) return 'pending';
  return legs.includes('void') ? 'void' : 'hit';
}

function checkPriorReceiptCards(path, cards, prior, flag) {
  if (prior == null) return;
  if (!Array.isArray(prior.cards)) {
    flag(`${path}: prior receipt inventory has no cards array`);
    return;
  }
  const current = new Map(cards.map((card) => [card?.card_id, card]));
  for (const old of prior.cards) {
    const id = old?.card_id;
    const key = `${path}/${id}`;
    const card = current.get(id);
    if (!card) {
      flag(`${key}: immutable offer receipt missing from the candidate`);
      continue;
    }
    const seen = instant(old.first_seen_utc);
    const candidateSeen = instant(card.first_seen_utc);
    const changedCard = OFFER_CARD_TERMS.filter((field) => old[field] != null
      && !isDeepStrictEqual(old[field], card[field]));
    if (Number.isFinite(seen) && !(candidateSeen <= seen)) changedCard.push('first_seen_utc');
    if (old.locked === true && card.locked !== true) changedCard.push('locked');
    if (changedCard.length) flag(`${key}: immutable offer terms changed (${changedCard.join(', ')})`);
    if (!Array.isArray(old.legs) || !Array.isArray(card.legs) || old.legs.length !== card.legs.length) {
      flag(`${key}: immutable offer leg inventory differs from the prior receipt`);
      continue;
    }
    for (const [i, leg] of old.legs.entries()) {
      const changedLeg = OFFER_LEG_TERMS.filter((field) => leg && Object.hasOwn(leg, field)
        && !isDeepStrictEqual(leg[field], card.legs[i]?.[field]));
      if (changedLeg.length) flag(`${key}: immutable offer leg ${i + 1} terms changed (${changedLeg.join(', ')})`);
    }
  }
}

function inspectCoverage({ facts, myScores, atdScores, readRecord, receiptPaths, schedule, review,
  excludedGames, priorFacts, priorReview, priorReceiptPaths = [], readPriorRecord }) {
  const failures = new Set();
  const flag = (message) => failures.add(message);
  const result = () => ({ offered: 0, unlocked: 0, excluded: 0, pending: 0, expected: 0, matched: 0, mismatches: [] });
  const my = result();
  const atd = result();
  const priorTransitions = new Map();
  const report = { my, atd, failures: [], priorTransitions: [] };
  if (!Number.isInteger(facts?.season) || !isObject(facts.weeks)) {
    flag('bet_facts.json: missing season or weeks map');
    report.failures = [...failures];
    return report;
  }
  const { season } = facts;
  if (facts.grading_policy !== 'event_bound_v1' && (hasCapture(facts)
      || (priorFacts?.season === season && priorFacts.grading_policy === 'event_bound_v1'))) {
    flag('bet_facts.json: event-bound grading policy is required for this generation');
  }
  const factsAsOf = instant(facts.generated_utc);
  if (!Number.isFinite(factsAsOf)) flag('bet_facts.json: invalid generated_utc');
  const currentReceiptPaths = new Set(receiptPaths);
  for (const path of priorReceiptPaths) {
    if (path.split('/')[1]?.startsWith(`${season}_wk`) && !currentReceiptPaths.has(path)) {
      flag(`${path}: immutable receipt inventory missing from the candidate`);
    }
  }
  if (!Array.isArray(excludedGames) || !excludedGames.every((row) => row?.game_id)) {
    flag('excluded_games.json: missing configured game inventory');
  }
  const configured = Array.isArray(excludedGames) ? excludedGames.filter((row) => row?.game_id) : [];
  const configuredIds = new Set(configured.map((row) => String(row.game_id)));
  const publishedExclusions = new Set(Array.isArray(facts.excluded) ? facts.excluded.map(String) : []);
  if ([...publishedExclusions].some((id) => !configuredIds.has(id)) || configured.some((row) =>
    (row.season == null || row.season === season) && !publishedExclusions.has(String(row.game_id)))) {
    flag('bet_facts.json: excluded games differ from the configured exclusions');
  }
  const trustedFacts = { ...facts, excluded: [...configuredIds] };
  const fixtures = indexFixtures(schedule, review, trustedFacts, priorFacts, priorReview, flag);
  const scored = new Map();
  for (const [family, scores] of [['MY', myScores], ['ATD', atdScores]]) {
    if (scores && !Number.isFinite(instant(scores.generated_utc))) flag(`${family} scores: invalid generated_utc`);
    for (const row of Array.isArray(scores?.cards) ? scores.cards : []) {
      const dir = recordDir(family, row?.scope);
      if (dir && validWeek(row?.week) && row?.card_id) {
        scored.set(`${recordPath(dir, season, row.week)}/${row.card_id}`, row);
      }
    }
  }
  const expected = new Set();
  const myWeeks = new Map();
  for (const path of currentReceiptPaths) {
    const [dir, name] = path.split('/');
    const week = Number(name?.match(/^\d{4}_wk(\d{2})\.json$/)?.[1]);
    if (!RECORD_DIRS.includes(dir) || !validWeek(week) || path !== recordPath(dir, season, week)) {
      flag(`${path}: invalid receipt inventory path for season ${season}`);
      continue;
    }
    let doc;
    try {
      doc = readRecord(path);
    } catch (error) {
      flag(`${path}: cannot read receipt inventory (${error.message})`);
      continue;
    }
    if (doc?.season !== season || doc.week !== week || !Array.isArray(doc.cards)) {
      flag(`${path}: receipt inventory season, week or cards differ from ${season} week ${week}`);
      continue;
    }
    checkPriorReceiptCards(path, doc.cards, readPriorRecord?.(path), flag);
    const isMy = dir === 'my_cards';
    const family = isMy ? my : atd;
    const scores = isMy ? myScores : atdScores;
    const cutoff = instant(scores?.generated_utc);
    const legacyLaterFacts = !facts.grading_policy && factsAsOf > cutoff;
    const known = new Set();
    for (const card of doc.cards) {
      const id = card?.card_id;
      const key = `${path}/${id}`;
      if (typeof id !== 'string' || !id || !Array.isArray(card.legs) || !card.legs.length) {
        flag(`${key}: receipt inventory card has no identity or legs`);
        continue;
      }
      if (known.has(id)) {
        flag(`${key}: duplicate receipt inventory card`);
        continue;
      }
      known.add(id);
      family.offered += 1;
      if (card.legs.every((leg) => leg?.game_id != null && configuredIds.has(String(leg.game_id)))) {
        family.excluded += 1;
        continue;
      }
      if (isMy && card.locked !== true) {
        if (card.locked !== false) flag(`${key}: MY receipt has no recorded lock state`);
        family.unlocked += 1;
        continue;
      }
      const results = card.legs.map((leg) => {
        if (typeof leg?.selection !== 'string' || !leg.selection || typeof leg.market !== 'string' || leg.slip_result != null
            || (leg.season != null && leg.season !== season) || (leg.week != null && leg.week !== week)) {
          flag(`${key}: receipt leg has invalid terms or identity`);
          return 'pending';
        }
        if (leg.game_id != null && configuredIds.has(String(leg.game_id))) return 'void';
        const fixture = inspectLegEvidence(leg, week, trustedFacts, fixtures, flag);
        // Legacy facts may postdate the score feed. A game that had yet to
        // kick off could not have settled its legs in that older feed.
        if (legacyLaterFacts && fixture?.kickoff >= cutoff) return 'pending';
        const terms = { ...leg, season, week };
        try {
          const got = gradeLeg(terms, trustedFacts);
          if (got.result === 'pending' && priorFacts?.season === season && gradeLeg(terms, priorFacts).result !== 'pending') {
            const label = `week ${week}/${leg.game_id ?? leg.team} ${leg.market} ${leg.selection}`;
            priorTransitions.set(label, `${label}: previously settled, now withheld (${got.reason})`);
          }
          return got.result;
        } catch (error) {
          flag(`${key} ${leg.market} ${leg.selection}: cannot grade from bet facts (${error.message})`);
          return 'pending';
        }
      });
      const outcome = cardResult(results);
      if (outcome === 'pending') {
        family.pending += 1;
        continue;
      }
      expected.add(key);
      family.expected += 1;
      if (isMy) myWeeks.set(week, (myWeeks.get(week) ?? 0) + 1);
      const row = scored.get(key);
      if (!row) {
        family.mismatches.push(`${key}: missing grade card (expected ${outcome})`);
      } else {
        family.matched += 1;
        if (row.result !== outcome) family.mismatches.push(`${key}: recorded card result ${row.result} differs from ${outcome}`);
      }
    }
  }
  for (const key of scored.keys()) {
    if (expected.has(key)) continue;
    const family = key.startsWith('my_cards/') ? my : atd;
    family.mismatches.push(`${key}: unexpected grade card for a pending, excluded, unlocked or missing receipt`);
  }
  if (Array.isArray(myScores?.weeks)) {
    const summarized = new Set();
    for (const row of myScores.weeks) {
      const week = row?.week;
      if (!validWeek(week) || summarized.has(week) || row.graded !== (myWeeks.get(week) ?? 0)) {
        my.mismatches.push(`week ${week}: MY grade summary differs from receipt coverage`);
      }
      summarized.add(week);
    }
    for (const week of myWeeks.keys()) {
      if (!summarized.has(week)) my.mismatches.push(`week ${week}: missing MY grade summary`);
    }
  }
  if (Number.isInteger(atdScores?.graded) && atdScores.graded !== atd.expected) {
    atd.mismatches.push(`ATD graded total ${atdScores.graded} differs from ${atd.expected} gradeable offer receipts`);
  }
  return { ...report, failures: [...failures], priorTransitions: [...priorTransitions.values()] };
}

export function inspectGrading({ facts, myScores, atdScores, readRecord, receiptPaths, ...evidence }) {
  const coverage = receiptPaths && inspectCoverage({ facts, myScores, atdScores, readRecord, receiptPaths, ...evidence });
  return {
    my: inspectScores(facts, myScores, 'MY', readRecord),
    atd: inspectScores(facts, atdScores, 'ATD', readRecord, coverage?.atd.offered === 0),
    ...(coverage && { coverage }),
  };
}

export function inspectGradingDirectory(dataDir = ROOT_DATA, priorEvidence = {}) {
  const checkedReceipts = new Set();
  const changedReceipts = new Map();
  function readRecord(path) {
    const raw = readFileSync(join(dataDir, path));
    if (!checkedReceipts.has(path)) {
      const prior = priorEvidence.readDifferentReceipt?.(path, raw);
      if (prior) changedReceipts.set(path, prior);
      checkedReceipts.add(path);
    }
    return JSON.parse(raw.toString('utf8'));
  }
  const failures = [];
  function read(path, optional = false) {
    try {
      return readRecord(path);
    } catch (error) {
      if (!optional || error.code !== 'ENOENT') failures.push(`${path}: ${error.message}`);
      return null;
    }
  }
  let excludedGames;
  try {
    excludedGames = JSON.parse(readFileSync(EXCLUDED_GAMES, 'utf8')).games;
  } catch (error) {
    failures.push(`excluded_games.json: ${error.message}`);
  }
  const facts = read('bet_facts.json');
  const receiptPaths = [];
  for (const dir of RECORD_DIRS) {
    try {
      for (const name of readdirSync(join(dataDir, dir)).sort()) {
        if (name.startsWith(`${facts?.season}_wk`) && name.endsWith('.json')) receiptPaths.push(`${dir}/${name}`);
      }
    } catch (error) {
      // The builders do not create a record directory until the first offer.
      if (error.code !== 'ENOENT') failures.push(`${dir}: cannot enumerate receipt inventory (${error.message})`);
    }
  }
  const report = inspectGrading({
    facts,
    myScores: read('my_card_scores.json'),
    atdScores: read('atd_card_scores.json'),
    readRecord,
    receiptPaths,
    schedule: read('schedule_full.json'),
    review: read('review.json', true),
    excludedGames,
    ...priorEvidence,
    readPriorRecord(path) {
      const prior = changedReceipts.get(path);
      changedReceipts.delete(path);
      return prior;
    },
  });
  return { ...report, failures };
}

function readPriorEvidence(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('--prior-ref requires a full commit SHA');
  const git = (args) => execFileSync('git', args, { cwd: dirname(ROOT_DATA), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git(['cat-file', '-t', sha]).trim() !== 'commit') throw new Error('--prior-ref must identify a commit');
  const files = git(['ls-tree', '-r', sha, '--', 'data/bet_facts.json', 'data/review.json',
    ...RECORD_DIRS.map((dir) => `data/${dir}/`)]).split('\n');
  const receipts = new Map();
  let priorFacts = null;
  let priorReview = null;
  for (const file of files) {
    const match = file.match(/^\d+ blob ([0-9a-f]{40})\t(data\/.+)$/);
    if (!match) continue;
    const [, blob, name] = match;
    if (name === 'data/bet_facts.json') priorFacts = JSON.parse(git(['cat-file', 'blob', blob]));
    else if (name === 'data/review.json') priorReview = JSON.parse(git(['cat-file', 'blob', blob]));
    else if (/^data\/[^/]+\/\d{4}_wk\d{2}\.json$/.test(name)) receipts.set(name.slice('data/'.length), blob);
  }
  return {
    priorFacts,
    priorReview,
    priorReceiptPaths: [...receipts.keys()],
    readDifferentReceipt(path, raw) {
      const old = receipts.get(path);
      if (!old) return null;
      // A matching Git blob needs no second parse of a large receipt book.
      const hash = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
      return hash === old ? null : JSON.parse(git(['cat-file', 'blob', old]));
    },
  };
}

function main(args) {
  let dataDir;
  let priorEvidence;
  try {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '--prior-ref' && priorEvidence === undefined) {
        priorEvidence = readPriorEvidence(args[++i]);
      } else if (!arg.startsWith('-') && !dataDir) {
        dataDir = arg;
      } else {
        throw new Error('usage: node scripts/validate_grading.mjs [data-directory] [--prior-ref <commit-sha>]');
      }
    }
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const report = inspectGradingDirectory(dataDir, priorEvidence);
  const { coverage } = report;
  const failures = [...report.failures, ...coverage.failures];
  let failed = failures.length > 0;
  for (const message of failures.slice(0, 10)) console.error(message);
  for (const [key, grade] of Object.entries({ my: report.my, atd: report.atd })) {
    const family = key.toUpperCase();
    const { expected, matched, offered, pending, unlocked, excluded, mismatches } = coverage[key];
    const problems = [...grade.mismatches, ...mismatches];
    console.log(`${family} grading: ${grade.compared} legs compared, ${problems.length} mismatches, `
      + `${matched}/${expected} gradeable cards from ${offered} receipts (${pending} pending, ${unlocked} unlocked, ${excluded} excluded)`);
    for (const message of problems.slice(0, 10)) console.error(`${family}: ${message}`);
    if (problems.length) failed = true;
  }
  for (const message of coverage.priorTransitions.slice(0, 10)) console.warn(message);
  if (coverage.priorTransitions.length) {
    console.warn(`${coverage.priorTransitions.length} previously settled receipt terms are now withheld`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
