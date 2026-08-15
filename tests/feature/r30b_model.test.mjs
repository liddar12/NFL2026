/* tests/feature/r30b_model.test.mjs — R30b: MODEL + PARLAYS honesty fixes, locked.
 *
 * Five verified R30 findings, each pinned here against the COMMITTED data files
 * (they are the real fixtures — no hypothetical shapes):
 *
 *   1. BACKTEST NaN (model.js topTrials/backtestCard). history[] archives
 *      trials from DIFFERENT searches: the legacy signal_promotion entry ships
 *      {venue_scale, cold_scale, log_loss} trials with no hfa/revert/k, and its
 *      0.6369 beat every real grid trial — so the highlighted "best" row read
 *      "hfa NaN · rev NaN · k NaN". topTrials now admits only full-grid trials;
 *      a knob absent from an admitted row renders an em dash, never NaN.
 *
 *   2. APPLIED incumbent shown as plain RETAINED (gateCard/familyRows) and
 *      absent from ADOPTED PARAMETERS (paramsCard). entry.incumbent_families
 *      names the family in production (qb_out, scale 75 — build_predictions.py
 *      shifts hfa_elo by it); it must wear its own chip and list its params +
 *      stored caveat ("95% CI spans zero") where adopted params are listed.
 *
 *   3. Parlays legend called MODEL EV a "placeholder until live odds" after the
 *      live odds feed was wired and R30a made IMPL the book's real de-vigged
 *      price on game lines. The legend's claims are cross-checked against
 *      data/parlays.json below so the words and the numbers cannot drift apart
 *      silently again.
 *
 *   4. SEASON LOCKS read `tuning.resolved_locks`, a key no producer writes, so
 *      "grading active" was unreachable. resolvedLockCount now reads the count
 *      the pipeline DOES write (refit.py's n_resolved on refit-shaped
 *      game_params entries) and must NEVER count the backtest entries whose
 *      n_resolved is the 2022-2025 historical corpus.
 *
 *   5. The blanket ESTIMATE pill contradicted card bodies that say MEASUREMENT
 *      ONLY. Stamps are per-card now: projections wear ESTIMATE, reports of
 *      observed results wear MEASURED, never both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  topTrials, familyRows, latestPromotion, resolvedLockCount,
  backtestCard, paramsCard, gateCard, locksCard,
} from '../../app/views/model.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const load = (p) => JSON.parse(readFileSync(join(REPO_ROOT, p), 'utf8'));
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');
/** Source with comments stripped — a comment EXPLAINING a retired claim must
 * not itself trip the audit (same convention as stale_text.test.mjs). */
const prose = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const TUNING = load('data/model_tuning.json');
const PARLAYS = load('data/parlays.json');

const GRID_KEYS = ['hfa_elo', 'hfa', 'revert', 'k'];
const isGridTrial = (t) => {
  const hfa = Number(t.hfa_elo != null ? t.hfa_elo : t.hfa);
  return Number.isFinite(hfa) && Number.isFinite(Number(t.revert))
    && Number.isFinite(Number(t.k));
};
const allTrials = (TUNING.history || [])
  .flatMap((h) => (Array.isArray(h && h.trials) ? h.trials : []));

/* ==========================================================================
   1. BACKTEST — the NaN best row
   ========================================================================== */

test('the committed history really mixes trial grids (the bug is reproducible)', () => {
  // If either side of this vanishes, the filter under test is no longer
  // exercised by real data and this suite must be pointed at whatever shape
  // replaced it — loudly, not by silently passing on an empty premise.
  const grid = allTrials.filter(isGridTrial);
  const foreign = allTrials.filter((t) => !isGridTrial(t));
  assert.ok(grid.length > 0, 'no hfa/revert/k grid trials in committed history');
  assert.ok(foreign.length > 0,
    'no foreign-grid trials (e.g. venue_scale/cold_scale) left in committed '
    + 'history — the NaN reproduction is gone; re-point this suite');
  // The trap that made the NaN row the HIGHLIGHTED one: a foreign trial
  // outscores every grid trial, so a reader that admits it crowns it "best".
  const bestForeign = Math.min(...foreign.map((t) => Number(t.log_loss)));
  const bestGrid = Math.min(...grid.map((t) => Number(t.log_loss)));
  assert.ok(bestForeign < bestGrid,
    'foreign trial no longer outscores the grid — update this comment, the '
    + 'filter is still required either way');
});

test('topTrials on the committed data: every knob finite, best is a real grid row', () => {
  const rows = topTrials(TUNING.history, 10);
  assert.ok(rows.length > 0, 'no trials returned from committed history');
  for (const r of rows) {
    assert.ok(Number.isFinite(r.hfa) && Number.isFinite(r.revert)
      && Number.isFinite(r.k) && Number.isFinite(r.log_loss),
    `non-finite knob leaked into the parameter-grid card: ${JSON.stringify(r)}`);
  }
  const bestGrid = Math.min(...allTrials.filter(isGridTrial)
    .map((t) => Number(t.log_loss)));
  assert.equal(rows[0].log_loss, bestGrid,
    'the highlighted best row must be the best REAL grid trial, not a trial '
    + 'from some other search');
});

test('backtestCard renders no NaN and highlights a fully-labeled best row', () => {
  const html = backtestCard(TUNING);
  assert.ok(!/NaN/.test(html),
    'BACKTEST card prints NaN — a number-shaped lie about a search that was '
    + 'never run; absent knobs must render an em dash with the why in a title');
  const best = /<div class="bt-row bt-row--best">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(best, 'no highlighted best row rendered');
  assert.match(best[1], /hfa [\d.]+ · rev [\d.]+ · k [\d.]+/,
    'the best row must name all three knobs with real numbers');
});

test('SHAPE-DRIFT GUARD: a trial carrying part of the grid is a bug, not a filter case', () => {
  /* The fix filters out trials carrying NONE of the grid (a different search's
   * business). A trial carrying SOME of hfa/revert/k is a different animal —
   * a producer drifted its key names — and silently filtering it would hide
   * real backtest rows from the card. Fail loudly instead. */
  for (const t of allTrials) {
    const present = GRID_KEYS.filter((k) => t[k] != null);
    if (present.length === 0) continue;             // foreign grid: fine
    assert.ok(isGridTrial(t),
      `history trial carries part of the param grid (${present.join(',')}) but `
      + `not a full finite hfa/revert/k triple: ${JSON.stringify(t)} — a `
      + 'producer key drifted; fix the producer or teach topTrials the new '
      + 'shape, do not let the filter silently eat it');
  }
});

/* ==========================================================================
   2. APPLIED INCUMBENT — gate chip + adopted parameters
   ========================================================================== */

test('familyRows marks exactly the incumbent_families as incumbent (committed data)', () => {
  const entry = latestPromotion(TUNING.history);
  assert.ok(entry, 'no format-2 promotion entry in committed history');
  assert.ok(Array.isArray(entry.incumbent_families)
    && entry.incumbent_families.includes('qb_out'),
  'qb_out is no longer the recorded incumbent — update this suite AND the '
    + 'ADOPTED PARAMETERS assertions to whatever is applied now');
  const rows = familyRows(entry);
  const qb = rows.find((r) => r.family === 'qb_out');
  assert.ok(qb, 'qb_out missing from the gate rows');
  assert.equal(qb.incumbent, true, 'the applied family must be flagged incumbent');
  for (const r of rows) {
    if (r.family === 'qb_out') continue;
    assert.equal(r.incumbent, false,
      `${r.family} flagged incumbent but is not in entry.incumbent_families`);
  }
});

test('familyRows: an entry without incumbent_families flags nobody (legacy-safe)', () => {
  const rows = familyRows({
    adopted_family: null,
    families: [{ family: 'rest', best: { log_loss: 0.63 }, improvement: 0, trials: [{}] }],
  });
  assert.equal(rows[0].incumbent, false);
});

test('gateCard: the incumbent wears APPLIED · INCUMBENT, never the weight-0 chip', () => {
  const html = gateCard(TUNING);
  const rowFor = (family) => {
    const m = new RegExp(
      `<div class="gate-row">(?:(?!</div>)[\\s\\S])*?${family}[\\s\\S]*?</div>`,
    ).exec(html);
    assert.ok(m, `no gate row rendered for ${family}`);
    return m[0];
  };
  const qbRow = rowFor('qb_out');
  assert.match(qbRow, /APPLIED · INCUMBENT/,
    'the family in production must be distinguishable from weight-0 families');
  assert.ok(!/>RETAINED</.test(qbRow),
    'qb_out still wears the plain RETAINED chip — that chip means "candidate '
    + 'kept at weight 0", which is the opposite of applied');
  assert.match(qbRow, /title="[^"]*NEVER-REGRESS[^"]*"/,
    'the incumbent chip must explain itself (what APPLIED means, how it is '
    + 'displaced) in its title');
  // The contrast still exists: plain RETAINED chips remain for the families
  // that really are candidates kept at zero.
  assert.match(html, />RETAINED</,
    'no plain RETAINED chip left — the distinction only means something if '
    + 'both states are on screen');
  // And the card copy no longer lumps the incumbent in with "recorded at
  // weight 0".
  assert.match(html, /already in production/,
    'the m-explain must say the APPLIED · INCUMBENT family is in production, '
    + 'not a candidate kept at zero');
});

test('paramsCard lists the applied family with its scale, provenance and caveat', () => {
  const html = paramsCard(TUNING);
  const gp = TUNING.game_params;
  assert.equal(gp.qb_out && gp.qb_out.applied, true,
    'committed game_params no longer applies qb_out — re-point these pins');
  assert.match(html, /QB OUT/i, 'the applied family is absent from ADOPTED PARAMETERS');
  assert.ok(html.includes(String(gp.qb_out.scale)),
    `the applied scale (${gp.qb_out.scale}) is not shown`);
  assert.match(html, /APPLIED at prediction time/,
    'the row must say the family is applied, not merely stored');
  assert.ok(html.includes(gp.qb_out.adopted_under),
    'the adoption rule (adopted_under) is part of the provenance and must show');
  // THE CAVEAT IS THE POINT: qb_out's own record says its 95% CI spans zero.
  // Showing the number without the caveat overstates the evidence.
  assert.match(html, /CI spans zero/,
    'the stored qb_out caveat is rendered nowhere — the number without its '
    + 'uncertainty is dishonest');
  // The three scalars are still there — the family rows are additive.
  assert.match(html, /HOME FIELD \(Elo\)/);
  assert.match(html, /SEASON REVERT/);
});

/* ==========================================================================
   4. SEASON LOCKS — count only what a producer actually writes
   ========================================================================== */

test('resolvedLockCount: committed day-zero data reports 0 despite n_resolved=1084 rows', () => {
  /* THE TRAP. The committed history HAS kind:"game_params" entries carrying
   * n_resolved > 0 — but those are backtest entries (eval_seasons 2022-2025)
   * whose n_resolved counts HISTORICAL finals. Counting them would announce
   * "in-season grading active" before a single 2026 game went FINAL. */
  const backtestEntries = (TUNING.history || []).filter((h) => h
    && h.kind === 'game_params' && Array.isArray(h.eval_seasons)
    && Number(h.n_resolved) > 0);
  assert.ok(backtestEntries.length > 0,
    'no backtest game_params entries with n_resolved left in committed data — '
    + 'the trap this reader defends against is gone; re-check the shapes');
  assert.equal(resolvedLockCount(TUNING), 0,
    'day-zero data must report 0 resolved LOCKS — the 1084 are 2022-2025 '
    + 'backtest finals, not graded 2026 predictions');
  assert.match(locksCard(TUNING), /begins when 2026 games go FINAL/,
    'day zero must keep the honest not-yet message');
  assert.ok(!/grading active/.test(locksCard(TUNING)),
    'day zero must not claim grading is active');
});

test('resolvedLockCount surfaces a refit-shaped entry — the branch is reachable now', () => {
  // The shape scripts/refit.py actually writes once >=1 lock has resolved:
  // kind game_params + `search` (+ held-out fields), no eval_seasons, and
  // n_resolved counting resolved lock rows under data/snapshots/.
  const refitEntry = {
    generated_utc: '2026-09-09T12:00:00Z',
    kind: 'game_params',
    search: 'coarse-to-fine box refinement (scripts/refit.search_axes)',
    n_resolved: 7,
    heldout_current_loss: 0.64,
    heldout_candidate_loss: 0.641,
    adopted: false,
  };
  const tuning = { history: [refitEntry, ...(TUNING.history || [])] };
  assert.equal(resolvedLockCount(tuning), 7);
  assert.match(locksCard(tuning), /7 locks resolved — in-season grading active/);
  // Newest-first: a newer refit pass supersedes an older count.
  const newer = { ...refitEntry, generated_utc: '2026-09-16T12:00:00Z', n_resolved: 21 };
  assert.equal(resolvedLockCount({ history: [newer, refitEntry] }), 21);
});

test('the dead resolved_locks key is gone from the view code', () => {
  // grep of the whole repo found the old reader as that key's ONLY mention —
  // no producer writes it, so any read of it is dead code that keeps the
  // "grading active" message unreachable.
  assert.ok(!prose('app/views/model.js').includes('resolved_locks'),
    'app/views/model.js reads tuning.resolved_locks again — no producer '
    + 'writes that key; read refit\'s n_resolved (see resolvedLockCount)');
});

/* ==========================================================================
   5. PER-CARD STAMPS — measurements never wear ESTIMATE
   ========================================================================== */

test('cards that report measurements are stamped MEASURED, projections ESTIMATE, never both', () => {
  const src = prose('app/views/model.js');
  // The blanket pill is gone: the card template stamps per-card.
  assert.ok(!/m-head">\$\{title\} <span class="est">/.test(src),
    'the card template hardcodes ESTIMATE on every header again');
  // The two cards whose BODIES say MEASUREMENT ONLY must not wear ESTIMATE.
  assert.match(src, /card\('PROMOTION GATE[^\n]*'measured'\)/,
    'PROMOTION GATE body says MEASUREMENT ONLY; its header must agree');
  assert.match(src, /card\('MARKET YARDSTICK[^\n]*'measured'\)/,
    'MARKET YARDSTICK body says MEASUREMENT ONLY; its header must agree');
  // Backtest and calibration report results on real FINAL games.
  assert.match(src, /card\('BACKTEST[^\n]*'measured'\)/);
  assert.match(src, /card\('CALIBRATION[^\n]*'measured'\)/);
  // The cards that genuinely project keep the ESTIMATE pill.
  assert.match(src, /card\('PLAYOFF ODDS[^\n]*'estimate'\)/);
  assert.match(src, /card\('ADOPTED PARAMETERS[^\n]*'estimate'\)/);
  // No card wears both: the stamp map's two values are mutually exclusive.
  const est = /estimate: '([^']*)'/.exec(src);
  assert.ok(est && !/MEASURED/.test(est[1]), 'the estimate stamp mentions MEASURED');
  assert.ok(!/'measured'[^)]*'estimate'|'estimate'[^)]*'measured'/
    .test(src.replace(/\n/g, ' ').match(/const card =[\s\S]*?;/) || ''),
  'a card call passes two stamps');
});

/* ==========================================================================
   3. PARLAYS LEGEND — the words match the shipped numbers
   ========================================================================== */

test('the retired "placeholder until live odds" claim is gone from the legend', () => {
  assert.ok(!prose('app/views/parlays.js').includes('placeholder until live odds'),
    'app/views/parlays.js still calls MODEL EV a placeholder — retired when '
    + 'the live Odds API feed was wired and R30a made IMPL the book\'s real '
    + 'de-vigged price on game lines. If the feed went away, say THAT instead.');
});

test('the legend states the R30a boundary and the correlation truth', () => {
  const src = prose('app/views/parlays.js');
  assert.match(src, /never a model input/,
    'the legend must say the book price is display-only — the whole R30a point');
  assert.match(src, /no book input/,
    'the legend must say MODEL is computed without the book');
  assert.match(src, /correlation-adjusted/,
    'same-game combining uses the pairwise-rho model; the legend must say so');
  assert.match(src, /combined as independent/,
    'cross-game legs multiply as independent; the legend must say so');
});

test('DATA AGREEMENT: week parlays really are independence products (legend claim)', () => {
  // The legend says cross-game legs are combined as independent. Verify it
  // against every shipped week parlay: model_ev == prod(model)/prod(implied)-1
  // within the rounding the feed carries (probs and ev stored at 4dp).
  const weeks = PARLAYS.parlays.filter((p) => p.scope === 'week');
  assert.ok(weeks.length >= 3, 'not enough week parlays to judge');
  for (const p of weeks) {
    const model = p.legs.reduce((acc, l) => acc * l.model_prob, 1);
    const implied = p.legs.reduce((acc, l) => acc * l.implied_prob, 1);
    const ev = model / implied - 1;
    assert.ok(Math.abs(ev - p.model_ev) < 0.01,
      `${p.parlay_id}: model_ev ${p.model_ev} != independence ${ev.toFixed(4)} — `
      + 'either the builder no longer treats week legs as independent (update '
      + 'the legend) or the EV math drifted');
  }
});

test('DATA AGREEMENT: same-game EVs are correlation-adjusted, not the naive product', () => {
  // The legend (and each card's note) says same-game legs use the rho model.
  // If every game parlay's EV equalled the independence product, that claim
  // would be decoration.
  const games = PARLAYS.parlays.filter((p) => p.scope === 'game' && p.legs.length > 1);
  assert.ok(games.length >= 1, 'no multi-leg game parlays to judge');
  const adjusted = games.filter((p) => {
    const model = p.legs.reduce((acc, l) => acc * l.model_prob, 1);
    const implied = p.legs.reduce((acc, l) => acc * l.implied_prob, 1);
    return Math.abs((model / implied - 1) - p.model_ev) > 1e-3;
  });
  assert.ok(adjusted.length >= 1,
    'every game parlay EV equals the independence product — the correlation '
    + 'model is not being applied; the legend and correlation_note overclaim');
});

test('DATA AGREEMENT: legend\'s IMPL claims hold — real book game lines, vig-charged props', () => {
  const src = prose('app/views/parlays.js');
  const HOLD = 1.045; // parlay_builder._DEFAULT_HOLD = 0.045
  const gameLine = (m) => m === 'moneyline' || m === 'spread';
  let fabricatedSpreads = 0;
  let realProps = 0;
  let propLegs = 0;
  for (const p of PARLAYS.parlays) {
    for (const leg of p.legs) {
      const fabricated = Math.abs(leg.implied_prob - leg.model_prob * HOLD) <= 2e-4;
      if (leg.market === 'spread' && fabricated) fabricatedSpreads += 1;
      if (!gameLine(leg.market)) {
        propLegs += 1;
        if (!fabricated) realProps += 1;
      }
    }
  }
  // Game lines: the legend says IMPL is the book's de-vigged price there.
  assert.equal(fabricatedSpreads, 0,
    'a spread IMPL equals model*(1+hold) — that is the pre-R30a fabricated '
    + 'price, and the legend now promises a real book line on game legs');
  // Props: the legend says IMPL charges the standard vig UNTIL a prop feed
  // lands. The moment real prop prices ship, this trips — and the correct fix
  // is to update the legend sentence, exactly what a stale-text pin is for.
  assert.ok(propLegs > 0, 'no prop legs shipped — re-check the legend claims');
  if (/standard vig/.test(src)) {
    assert.equal(realProps, 0,
      `${realProps} prop legs carry a non-fabricated IMPL, but the legend still `
      + 'says prop IMPL is "our number plus the standard vig" — the prop feed '
      + 'landed; update the legend in app/views/parlays.js');
  }
});

test('every shipped correlation_note matches its scope (the legend defers to them)', () => {
  for (const p of PARLAYS.parlays) {
    if (p.scope === 'game' && p.legs.length > 1) {
      assert.match(p.correlation_note, /correlat/i,
        `${p.parlay_id}: game-scope note does not mention correlation`);
    }
    if (p.scope === 'week') {
      assert.match(p.correlation_note, /independent/i,
        `${p.parlay_id}: week-scope note does not state independence`);
    }
  }
});
