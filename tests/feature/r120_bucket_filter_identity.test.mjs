/* tests/feature/r120_bucket_filter_identity.test.mjs — R120: the PARLAYS bucket
 * filter keeps a card by the bucket its own chip paints.
 *
 * data-ci #155 (red from 2026-10-09 10:27Z): the TB @ DAL slate was re-picked,
 * so rank id 401872980-g1 names two bets — in the week-5 review the bet that
 * held the rank and went ALL HIT (D. Prescott 225+ pass yds + G. Pickens 60+ rec
 * yds), on today's slate DAL ML + B. Irving 60+ rush yds, PARTIAL. The filter
 * looked the bucket up by parlay_id, found the ALL HIT row, and kept the card;
 * the chip, matched by the card's identity (R112), painted PARTIAL · LOSS under
 * the ALL HIT filter.
 *
 * Locked here: parlayBucketResolver resolves a card through the same row the
 * chip painter uses (identity first, rank id only as the fallback, refused when
 * the row's legs name a different bet), and the view filters through it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const review = await import(pathToFileURL(join(ROOT, 'app', 'review.js')).href);

const leg = (selection, result, market = 'moneyline') => ({ market, selection, result });
const NOW = {   // today's card for the rank: its own row is PARTIAL
  parlay_id: '401872980-g1', card_id: 'bbb', scope: 'game', game_id: '401872980',
  legs: [leg('DAL ML', 'hit'), leg('B. Irving 60+ rush yds', 'miss', 'player_rush_yds')],
  bucket: 'partial', result: 'miss',
};
const WAS = {   // the bet that held the rank before the re-pick: ALL HIT
  parlay_id: '401872980-g1', card_id: 'aaa', scope: 'game', game_id: '401872980',
  legs: [leg('D. Prescott 225+ pass yds', 'hit', 'player_pass_yds'),
         leg('G. Pickens 60+ rec yds', 'hit', 'player_rec_yds')],
  bucket: 'all_hit', result: 'hit',
};
// The ALL HIT row comes last, so a parlay_id-keyed map hands it to the rank.
const DOC = { weeks: { 5: { parlays: [NOW, WAS] } } };
const card = (row, stamped = true) => {
  const c = { parlay_id: row.parlay_id, scope: row.scope, game_id: row.game_id,
              legs: row.legs.map(({ market, selection }) => ({ market, selection })) };
  if (stamped) c.card_id = row.card_id;
  return c;
};

test('R120: the rank-keyed map is the collision (precondition)', () => {
  assert.equal(review.parlayBucketMap(5, DOC).get('401872980-g1'), 'all_hit',
    'by parlay_id the re-picked card borrows the ALL HIT of the bet that held its rank');
});

test('R120: the resolver gives each card the bucket of its OWN row', () => {
  const of = review.parlayBucketResolver(5, DOC);
  assert.equal(of(card(NOW)), 'partial', 'today\'s card is PARTIAL, as its chip paints');
  assert.equal(of(card(WAS)), 'all_hit', 'the bet that hit is still ALL HIT');
  assert.equal(of(card(NOW, false)), undefined,
    'an unstamped card falls back to the rank id, and the rank\'s row names another bet: no bucket, never a borrowed one');
  assert.equal(of(null), undefined);
  assert.equal(review.parlayBucketResolver(9, DOC)(card(NOW)), undefined, 'no week block -> no bucket');
});

test('R120: a review written before rows carried card_id still resolves by rank when the legs match', () => {
  const legacy = { weeks: { 5: { parlays: [{ ...WAS, card_id: undefined }] } } };
  const of = review.parlayBucketResolver(5, legacy);
  assert.equal(of(card(WAS)), 'all_hit', 'stamped card, unstamped row: rank fallback, same legs');
  assert.equal(of(card(NOW)), undefined, 'same rank, different legs: refused');
});

test('R120: the PARLAYS view filters buckets through the resolver, not by parlay_id', () => {
  const src = readFileSync(join(ROOT, 'app', 'views', 'parlays.js'), 'utf8');
  assert.match(src, /reviewMod\.parlayBucketResolver\(selWeek\)/);
  assert.match(src, /bucketOf\(p\) === activeBucket/);
  assert.doesNotMatch(src, /bucketOf\.get\(String\(p\.parlay_id\)\)/,
    'a bucket looked up by rank id is the R120 defect');
});
