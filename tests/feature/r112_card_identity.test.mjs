/* R112 — A SLATE CARD IS MATCHED TO ITS REVIEW ROW BY BET, NEVER BY RANK.
 *
 * 2026-10-04 (data-ci #78): ARI @ NYG's cards were re-ranked after kickoff.
 * The slate's g3 became NYG ML + Nabers; the review's g3 is the frozen NYG ML +
 * Brissett, and its NYG ML + Nabers row is g2. parlays.json cards carry no
 * card_id, so the money re-pricing paired rows to cards by rank, the leg check
 * refused the pair, and the card painted no grade and no $100 figure. The view
 * now stamps each slate card with the archive writer's own identity hash before
 * matching anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { cardIdOf, parlayMoneyMap, prepareParlaySimulation, reviewRowFor, stampCardIds }
  from '../../app/review.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const leg = (market, selection, implied) => ({ market, selection, implied_prob: implied, model_prob: 0.5 });
const ML = leg('moneyline', 'NYG ML', 0.6);
const NAB = leg('wr_rec_yds', 'M. Nabers 60+ rec yds', 0.55);
const BRI = leg('qb_pass_yds', 'J. Brissett 225+ pass yds', 0.5);
const SKA = leg('rb_rush_yds', 'C. Skattebo 60+ rush yds', 0.5);
const card = (pid, legs) => ({ parlay_id: pid, scope: 'game', game_id: '401872966', legs });

test('the JS identity is the archive writer\'s card_id, byte for byte', async () => {
  const c = card('401872966-g3', [ML, NAB]);
  const py = execFileSync('python3', ['-c', `import json,sys; sys.path.insert(0,'.')
from scripts.build_parlay_archive import card_id
print(card_id(json.loads(sys.argv[1])))`, JSON.stringify(c)], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(await cardIdOf(c), py);
});

test('a rank id re-used after a re-pick finds the row for ITS bet, with money', async () => {
  // the slate as rebuilt after kickoff
  const slate = [card('401872966-g2', [SKA, NAB]), card('401872966-g3', [ML, NAB])];
  await stampCardIds(slate);
  // the review: frozen rows (each stamped by the archive) + the re-pick's row
  const row = async (pid, legs) => ({ ...card(pid, legs), card_id: await cardIdOf(card(pid, legs)),
    result: 'pending', bucket: 'pending', legs: legs.map((l) => ({ ...l, result: 'pending' })) });
  const doc = { weeks: { 4: { parlays: [
    await row('401872966-g2', [ML, NAB]), await row('401872966-g3', [ML, BRI]),
    await row('401872966-g2', [SKA, NAB])] } } };
  prepareParlaySimulation(4, slate, doc);
  const money = parlayMoneyMap(4, doc);
  for (const c of slate) {
    const m = money.get(c.card_id);
    assert.ok(m && Number.isFinite(m.net_fair), `${c.parlay_id}: priced by its own bet`);
  }
  // the re-ranked g3 resolves to the NYG ML + Nabers row (the review's g2), not the review's g3
  const byId = new Map(doc.weeks[4].parlays.map((r) => [r.card_id, r]));
  const hit = reviewRowFor(byId, slate[1], null, '401872966-g3');
  assert.deepEqual(hit.legs.map((l) => l.selection), ['NYG ML', 'M. Nabers 60+ rec yds']);
  // the Brissett row has no card on the slate any more: no money borrowed from another bet
  assert.equal(doc.weeks[4].parlays[1].money, null);
});
