/* tests/feature/players_view.test.mjs — R21-B2 PLAYERS view chips, locked.
 *
 * app/views/players.js exports pure render helpers (no DOM at import time), the
 * same pattern app/views/model.js uses so the fast gate can prove UI markup
 * without a browser:
 *   playoffTone(label)        RATING_BANDS label -> tone class
 *   renderPlayoffSos(report)  the fantasy-playoff SoS chip ('' for null)
 *   renderPlayoffByes(report) the bye-in-the-window chip ('' when no bye)
 *   renderValue({...})        our auction price beside the MARKET's
 *   withExtraRow(card, extra) splice the row into a rendered player card
 *   MARKET_BADGE              the DISPLAY-ONLY badge, reused not reinvented
 *
 * What this file is here to prevent:
 *   1. a null playoff reading rendering as a neutral-looking number,
 *   2. a bye in the playoff window reading as a point on the difficulty scale,
 *   3. an unpriced player rendering as $0,
 *   4. a market price appearing without the DISPLAY-ONLY badge, or a SECOND
 *      badge convention being invented alongside the app's existing one,
 *   5. our auction price disagreeing with the TEAM tab's draft room,
 *   6. the extra row changing a card that has nothing extra to say.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  MARKET_BADGE, playoffTone, priceLabel, renderPlayoffSos, renderPlayoffByes,
  renderValue, withExtraRow,
} from '../../app/views/players.js';
import { marketBadge } from '../../app/views/model.js';
import { renderPlayerCard } from '../../app/render.js';
import {
  playoffSos, playoffSosById, RATING_BANDS,
} from '../../app/playoffs.js';
import { normalizeProfile } from '../../app/league.js';
import { fairDollars, createAuction, DEFAULT_BUDGET } from '../../app/auction.js';
import { cfgFromProfile } from '../../app/views/team.js';
import { rosterShape } from '../../app/draft-sim.js';
import { rosterGeometry } from '../../app/team-logic.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = join(REPO_ROOT, 'data');
const load = (p) => JSON.parse(readFileSync(join(DATA, p), 'utf8'));
const SRC = readFileSync(join(REPO_ROOT, 'app/views/players.js'), 'utf8');

const RATINGS = { A: 1600, B: 1400, C: 1500, D: 1550 };
const WEEKS = [
  { wk: 1, opp: 'D', home: true, bye: false, pts: 11 },
  { wk: 14, opp: 'A', home: true, bye: false, pts: 10 },
  { wk: 15, opp: null, home: false, bye: true, pts: 0 },
  { wk: 16, opp: 'B', home: false, bye: false, pts: 12 },
  { wk: 17, opp: 'C', home: true, bye: false, pts: 14 },
];
const PROFILE_14 = { shape: { playoff_week_start: 14 } };
const REPORT = playoffSos(WEEKS, { ratings: RATINGS }, PROFILE_14);

/* ---- the DISPLAY-ONLY badge: reused verbatim, never re-invented ----------- */

test('MARKET_BADGE is byte-identical to the badge app/views/model.js emits', () => {
  // model.js prefixes a space; the badge element itself must match exactly.
  assert.ok(
    marketBadge('kalshi').includes(MARKET_BADGE),
    `players.js badge diverged from model.js:\n  players: ${MARKET_BADGE}\n  model:   ${marketBadge('kalshi')}`,
  );
  assert.match(MARKET_BADGE, /class="ms-badge"/);
  assert.match(MARKET_BADGE, /MARKET · DISPLAY ONLY/);
});

test('players.js does not invent a second display-only badge class', () => {
  // The only badge ELEMENT this view emits is the shared .ms-badge one.
  assert.deepEqual(SRC.match(/<span class="[a-z0-9 -]*badge[a-z0-9 -]*"/g),
    ['<span class="ms-badge"']);
});

/* ---- playoff SoS chip ----------------------------------------------------- */

test('playoffTone covers every RATING_BANDS label and nothing else', () => {
  const seen = RATING_BANDS.map((b) => [b.label, playoffTone(b.label)]);
  assert.deepEqual(seen, [
    ['Easiest', 'easy'],
    ['Easy', 'easy'],
    ['Neutral', 'even'],
    ['Hard', 'hard'],
    ['Hardest', 'hard'],
  ]);
  // Anything unrecognised falls to the uncommitted tone, never to easy/hard.
  assert.equal(playoffTone(null), 'even');
  assert.equal(playoffTone('Nonsense'), 'even');
});

test('a NULL playoff reading renders as ABSENT — no zero, no neutral chip', () => {
  for (const empty of [null, undefined, 0, false, '']) {
    assert.equal(renderPlayoffSos(empty), '', `${String(empty)} rendered a chip`);
  }
  // The honest null path is real on live data: a player with no weekly rows.
  assert.equal(renderPlayoffSos(playoffSos(null, { ratings: RATINGS }, PROFILE_14)), '');
  // ...and an all-bye window, which is emphatically not "average difficulty".
  const allBye = playoffSos(
    [{ wk: 1, opp: 'A', bye: false, pts: 5 }, { wk: 14, opp: null, bye: true, pts: 0 }],
    { ratings: RATINGS }, PROFILE_14,
  );
  assert.equal(allBye, null);
  assert.equal(renderPlayoffSos(allBye), '');
});

test('the chip states the window, the 1-5 number and the band word in text', () => {
  const html = renderPlayoffSos(REPORT);
  assert.match(html, /PLAYOFF W14-17/);                 // the weeks it covers
  assert.match(html, /<span class="posos-num">\d\.\d</); // one decimal, like .p-sos
  assert.match(html, new RegExp(`>${REPORT.label}<`));   // the reading in English
  // Meaning is never colour-only: strip every class and the reading survives.
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.match(text, /PLAYOFF W14-17/);
  assert.match(text, new RegExp(REPORT.label));
  // The meter is decoration and is hidden from assistive tech.
  assert.match(html, /class="posos-meter" aria-hidden="true"/);
  assert.equal((html.match(/class="po-seg/g) || []).length, 5);
});

test('the chip tone follows the band, and the meter fill follows the tone', () => {
  const easy = renderPlayoffSos({
    ...REPORT, rating: 1.2, label: 'Easiest', pts_per_game: 0.7,
  });
  const hard = renderPlayoffSos({
    ...REPORT, rating: 4.6, label: 'Hardest', pts_per_game: -0.7,
  });
  assert.match(easy, /p-posos--easy/);
  assert.match(easy, /po-seg--easy/);
  assert.doesNotMatch(easy, /po-seg--hard/);
  assert.match(hard, /p-posos--hard/);
  assert.match(hard, /po-seg--hard/);
  assert.doesNotMatch(hard, /po-seg--easy/);
});

test('the chip explains the number instead of asserting it, and disclaims use', () => {
  const html = renderPlayoffSos(REPORT);
  assert.match(html, /Mean opponent Elo/);
  assert.match(html, /own season average/);
  assert.match(html, /25 Elo per point/);
  assert.match(html, /never applied to a projection/);
});

/* ---- the BYE chip: a different problem, drawn differently ----------------- */

test('no bye in the window renders no bye chip at all', () => {
  const noBye = playoffSos(
    WEEKS.filter((w) => !w.bye), { ratings: RATINGS }, PROFILE_14,
  );
  assert.equal(noBye.byes, 0);
  assert.equal(renderPlayoffByes(noBye), '');
  assert.doesNotMatch(renderPlayoffSos(noBye), /posos-bye/);
  assert.equal(renderPlayoffByes(null), '');
});

test('a bye in the window gets its OWN chip, not a point on the 1-5 scale', () => {
  assert.equal(REPORT.byes, 1);
  const bye = renderPlayoffByes(REPORT);
  assert.match(bye, /BYE W15/);              // which week, by name
  assert.match(bye, /3\/4 GAMES/);           // 3 games out of a 4-week window
  // Structurally separate from the difficulty chip: its own element, its own
  // class family, and it is NOT nested inside .p-posos.
  assert.match(bye, /^<span class="posos-bye"/);
  assert.doesNotMatch(bye, /p-posos/);
  assert.doesNotMatch(bye, /po-seg/);
  const full = renderPlayoffSos(REPORT);
  assert.ok(full.indexOf('</span><span class="posos-bye"') > 0,
    'the bye chip must be a sibling of the difficulty chip, not inside it');
  // The difficulty number is measured over the GAMES only — say so.
  assert.match(bye, /scores 0 that week/);
  assert.match(bye, /measured over the games only/);
});

/* ---- our price vs the market's ------------------------------------------- */

const VAL = { teams: 12, budget: 200, board: 12 };

test('renderValue is empty when we have neither price', () => {
  assert.equal(renderValue({ ...VAL }), '');
  assert.equal(renderValue({ ...VAL, ours: null, auction: null }), '');
  assert.equal(renderValue(), '');
});

test('priceLabel never prints $0 — a sub-dollar price reads "<$1"', () => {
  // ESPN really does price deep bench players below a dollar (data/adp.json has
  // auction_value 0.29 etc). Math.round would turn those into "$0", which reads
  // as FREE and is indistinguishable from "we have no price".
  assert.equal(priceLabel(34), '$34');
  assert.equal(priceLabel(61.81), '$62');
  assert.equal(priceLabel(1), '$1');
  assert.equal(priceLabel(0.9), '$1');
  assert.equal(priceLabel(0.49), '<$1');
  assert.equal(priceLabel(0.29), '<$1');
  // Every positive auction value on the committed board formats without a $0.
  const priced = load('adp.json').players
    .map((r) => r.auction_value).filter((v) => v != null && v > 0);
  assert.ok(priced.length > 100, 'board too small to judge');
  for (const v of priced) assert.notEqual(priceLabel(v), '$0');
});

test('an unpriced player renders an em dash, never $0', () => {
  const html = renderValue({ ...VAL, ours: 34, auction: null });
  assert.match(html, /class="pv-mkt pv-none">—</);
  assert.doesNotMatch(html, /\$0/);
  assert.match(html, /ESPN publishes no auction value/);
  assert.match(html, /missing price, not a price of zero/);
  // A literal 0 from a bad feed is treated as absent too, not printed.
  const zero = renderValue({ ...VAL, ours: 34, auction: 0 });
  assert.match(zero, /pv-none/);
  assert.doesNotMatch(zero, /\$0/);
});

test('the market price never renders without the DISPLAY-ONLY badge', () => {
  for (const opts of [
    { ours: 34, auction: 62 },
    { ours: 34, auction: null },
    { ours: null, auction: 62 },
  ]) {
    const html = renderValue({ ...VAL, ...opts });
    assert.notEqual(html, '');
    assert.ok(html.includes(MARKET_BADGE), `no badge for ${JSON.stringify(opts)}`);
    assert.equal((html.match(/ms-badge/g) || []).length, 1);
  }
});

test('our price and the market price are labelled, distinct and comparable', () => {
  const html = renderValue({ ...VAL, ours: 34, auction: 61.81 });
  assert.match(html, /<span class="pv-lbl">OURS<\/span><span class="pv-us">\$34</);
  assert.match(html, /<span class="pv-lbl">AUC<\/span><span class="pv-mkt">\$62</);
  // Both are the same currency on the same budget — the title says whose is
  // whose. (Apostrophes arrive HTML-escaped: the title is escaped, not raw.)
  assert.match(html, /this app&#39;s own auction price/);
  assert.match(html, /the MARKET&#39;s price/);
  assert.match(html,
    /never an input to a projection, a weight, or this list&#39;s sort order/);
});

test('the auction price is READ for display only — one call site, no sort/model use', () => {
  // The only read of the market price in this view feeds renderValue().
  const reads = SRC.match(/auctionById\.get\([^)]*\)/g) || [];
  assert.deepEqual(reads, ['auctionById.get(id)']);
  assert.match(SRC, /auction: auctionById\.get\(id\),/);
  // It must not appear inside the projection model or the sort key.
  const body = (name) => {
    const start = SRC.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} not found`);
    return SRC.slice(start, SRC.indexOf('\n  }\n', start));
  };
  for (const fn of ['model', 'sortVal']) {
    const src = body(fn);
    assert.doesNotMatch(src, /auction/i, `${fn}() references auction data`);
    assert.doesNotMatch(src, /\badp\b/i, `${fn}() references ADP data`);
  }
});

/* ---- R24-C · whose budget, and what the badge disclaims ------------------- */

test('R24-C: the "your league" budget in the tooltip is OUR budget, not the board\'s', () => {
  /* THE DEFECT: `budget` was the MARKET board's data/adp.json auction_budget,
   * and OURS was priced in it — while the very same sentence called it "your
   * league (N teams, $B budget)". One sentence, two different leagues. The
   * draft-board cell in app/views/team.js has always priced OURS in the user's
   * budget and RESTATED the market number into it; this locks the card to the
   * same convention. */
  const html = renderValue({
    ours: 34, auction: 62, teams: 10, budget: 100, board: 12, boardBudget: 200,
  });
  // The "your league" clause carries OUR budget, never the board's.
  assert.match(html, /allocated across your league \(10 teams, \$100 budget\)/);
  assert.doesNotMatch(html, /your league \(10 teams, \$200 budget\)/);
  // The market price is restated into our dollars, and the title says so with
  // BOTH numbers — a silently rescaled market price would be its own lie.
  assert.match(html, /<span class="pv-mkt">\$31</);
  assert.match(html,
    /published as \$62 on a \$200 budget and restated here in your \$100/);
});

test('R24-C: a same-budget board is not "restated", and an unpublished one is not rescaled', () => {
  // Board budget == ours: no rescale, and the title says plainly where the
  // market number was published rather than implying a conversion happened.
  const same = renderValue({
    ours: 34, auction: 62, teams: 12, budget: 200, board: 12, boardBudget: 200,
  });
  assert.match(same, /<span class="pv-mkt">\$62</);
  assert.match(same, /published on a \$200 budget\./);
  assert.doesNotMatch(same, /restated here in your/);

  // ESPN publishes no budget: the price is shown AS PUBLISHED and the title
  // says the denomination is unknown. Inventing a rescale factor here would be
  // inventing the number it produces.
  const unknown = renderValue({
    ours: 34, auction: 62, teams: 12, budget: 100, board: 12, boardBudget: null,
  });
  assert.match(unknown, /<span class="pv-mkt">\$62</);
  assert.match(unknown, /budget ESPN does not publish/);
  assert.doesNotMatch(unknown, /restated here in your/);
  // ...and OURS is still described in OUR budget, which we do know.
  assert.match(unknown, /\(12 teams, \$100 budget\)/);
});

test('R24-C: the view prices OURS in OUR budget and only RESTATES the market from the board\'s', () => {
  // Source-level, because the defect was a single argument at one call site.
  assert.match(SRC, /const OUR_BUDGET = DEFAULT_BUDGET;/,
    'OURS must be denominated in the app budget the TEAM tab draft room opens on');
  assert.match(SRC,
    /fairDollars\(pool, adjOf, profile\.shape\.teams, OUR_BUDGET, _ourShape\)/,
    'the OURS price sheet must be built on OUR budget, not the market board\'s');
  assert.match(SRC, /budget: OUR_BUDGET,/);
  assert.match(SRC, /boardBudget: marketBoardBudget,/);
  // The board budget must reach renderValue ONLY as boardBudget — never as the
  // budget OURS is priced in.
  assert.doesNotMatch(SRC, /budget: marketBoardBudget/);
  assert.doesNotMatch(SRC, /\bmarketBudget\b/,
    'the single "market budget doubles as our budget" variable must be gone');
});

test('R24-C: on the committed board the fix is byte-for-byte — no number moved', () => {
  // BACKWARD COMPATIBILITY. data/adp.json is published on the same $200 the app
  // defaults to, so the rescale is x1 and every price the card renders today is
  // the price it rendered before the fix. If the board ever moves off $200 this
  // test says so rather than letting the change ride in silently.
  const adp = load('adp.json');
  assert.equal(Number(adp.auction_budget), DEFAULT_BUDGET);
  const before = { ours: 34, auction: 61.81, teams: 12, budget: DEFAULT_BUDGET, board: 12 };
  const after = { ...before, boardBudget: Number(adp.auction_budget) };
  const strip = (h) => h.replace(/ title="[^"]*"/, '');   // prose changed; prices did not
  assert.equal(strip(renderValue(after)), strip(renderValue(before)));
  assert.match(renderValue(after), /<span class="pv-us">\$34</);
  assert.match(renderValue(after), /<span class="pv-mkt">\$62</);
});

test('R24-C: the DISPLAY-ONLY badge is INSIDE the AUC cell, never a sibling of OURS', () => {
  /* THE DEFECT: the badge was a flat sibling of BOTH .pv-cell elements, so it
   * read as a label on the whole row — disclaiming this app's own OURS price
   * alongside the market's — and could wrap onto its own line away from the
   * number it disclaims. It must be structurally attached to the AUC cell. */
  for (const opts of [
    { ours: 34, auction: 62 },
    { ours: 34, auction: null },
    { ours: null, auction: 62 },
  ]) {
    const html = renderValue({ ...VAL, ...opts });
    const cells = html.match(/<span class="pv-cell[^"]*">.*?<\/span><\/span>/s);
    // The badge sits after the AUC value and before that cell closes.
    assert.match(html,
      /<span class="pv-cell pv-cell--mkt"><span class="pv-lbl">AUC<\/span><span class="pv-mkt[^"]*">[^<]*<\/span><span class="ms-badge"/,
      `badge not inside the AUC cell for ${JSON.stringify(opts)}`);
    assert.ok(cells, 'the value row must still be built from .pv-cell elements');
    // The OURS cell must close BEFORE the badge opens — the badge can never be
    // read as labelling our own price.
    const oursClose = html.indexOf('</span><span class="pv-cell pv-cell--mkt">');
    assert.ok(oursClose > 0 && oursClose < html.indexOf('ms-badge'));
    // Still exactly one badge, and still the shared verbatim one.
    assert.equal((html.match(/ms-badge/g) || []).length, 1);
    assert.ok(html.includes(MARKET_BADGE));
  }
});

/* ---- R24-C · one visual convention for OURS vs the market ----------------- */

/** Last-wins declaration lookup for a bare class selector in app/theme.css. */
function cssFinal(selector, prop) {
  const css = readFileSync(join(REPO_ROOT, 'app/theme.css'), 'utf8');
  const rules = css.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  let out = null;
  for (const [, sel, body] of rules) {
    const list = sel.split(',').map((s) => s.trim().split(/\s+/).pop());
    if (!list.includes(selector)) continue;
    const m = [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))];
    if (m.length) out = m[m.length - 1][1].trim();
  }
  return out;
}

test('R24-C: the player card and the draft board rank OURS vs AUC the same way', () => {
  /* THE DEFECT: the two surfaces that show these same two numbers inverted each
   * other's hierarchy. On the card the DISPLAY-ONLY market price was the
   * brightest ink and our own price the tinted, recessive one; on the draft
   * board it was the other way round. Under the MARKET-DISPLAY-ONLY policy the
   * app's own price is the one that should dominate, so the board's convention
   * is the one both surfaces keep. */
  assert.equal(cssFinal('.cv-us', 'color'), 'var(--ink)');
  assert.equal(cssFinal('.cv-mkt', 'color'), 'var(--muted)');
  assert.equal(cssFinal('.pv-us', 'color'), cssFinal('.cv-us', 'color'),
    'OURS must be the dominant ink on the player card, as it is on the board');
  assert.equal(cssFinal('.pv-mkt', 'color'), cssFinal('.cv-mkt', 'color'),
    'the DISPLAY-ONLY market price must not outrank our own price');
  // ...and the weight ordering agrees with the colour ordering on both.
  assert.equal(cssFinal('.pv-us', 'font-weight'), cssFinal('.cv-us', 'font-weight'));
  assert.equal(cssFinal('.pv-mkt', 'font-weight'), cssFinal('.cv-mkt', 'font-weight'));
  // The AUC cell holds its badge on one line — that is what binds the two.
  assert.equal(cssFinal('.pv-cell--mkt', 'flex-wrap'), 'nowrap');
  // Promoting OURS to the dominant ink must NOT drag the "no price" em dash up
  // with it: .pv-none is an earlier rule of equal specificity, so it loses on
  // source order unless it is restated at compound specificity.
  assert.equal(cssFinal('.pv-us.pv-none', 'color'), 'var(--muted)');
  assert.equal(cssFinal('.pv-mkt.pv-none', 'color'), 'var(--muted)');
  assert.equal(cssFinal('.pv-us.pv-none', 'font-weight'), '400');
});

/* ---- our price agrees with the TEAM tab's draft room ---------------------- */

test('our auction price equals the draft room fair sheet on the committed data', () => {
  const profile = normalizeProfile(null);
  const proj = load('player_projections.json');
  const adp = load('adp.json');
  const projById = new Map(proj.players.map((p) => [String(p.gsis_id), p]));

  // The view's recipe (app/views/players.js ourDollars, ppr mode).
  const pool = adp.players.filter((r) => r && r.gsis_id != null);
  const adjOf = (r) => {
    const p = projById.get(String(r.gsis_id));
    return p ? Number(p.proj_points) : 0;
  };
  // R24-C: the budget argument is OUR budget (DEFAULT_BUDGET), the same one the
  // draft room below opens on. It used to be the market board's auction_budget,
  // which happens to equal it on the committed board — so this test agreed with
  // the view either way and could not see the denomination bug.
  const mine = fairDollars(pool, adjOf, profile.shape.teams,
    DEFAULT_BUDGET, rosterShape(cfgFromProfile(profile).cfg));

  // The TEAM tab's recipe, seeded from the same profile.
  const seeded = cfgFromProfile(profile);
  const cfg = { leagueSize: 12, budget: DEFAULT_BUDGET, ...seeded.cfg };
  const room = createAuction({
    leagueSize: cfg.leagueSize,
    budget: cfg.budget,
    rosterConfig: cfg,
    boardRows: adp.players,
    adjPointsById: new Map(proj.players.map(
      (p) => [String(p.gsis_id), Number(p.proj_points)])),
    seed: 1,
  });

  assert.ok(room.fair.size > 100, 'draft-room fair sheet is too small to judge');
  assert.equal(mine.size, room.fair.size);
  const disagree = [];
  for (const [id, v] of room.fair) {
    if (mine.get(id) !== v) disagree.push(`${id}: room ${v} vs players ${mine.get(id)}`);
  }
  assert.deepEqual(disagree, [],
    'the PLAYERS tab and the draft room price the same player differently');
});

test('a K/DEF league prices identically on both tabs (the R21 shape-argument bug)', () => {
  // WHY THIS CASE: with NO profile saved, the LeagueProfile's geometry (13
  // slots) and the draft-sim shape (13 slots) happen to agree, so passing the
  // wrong object to fairDollars was invisible. Add the two slots the draft
  // simulator cannot price — K and DEF — and they disagree 15 vs 13, which
  // moves poolN, `spread`, and every dollar on the sheet. This is exactly the
  // league a Sleeper import produces.
  const proj = load('player_projections.json');
  const adp = load('adp.json');
  const projById = new Map(proj.players.map((p) => [String(p.gsis_id), p]));
  const pool = adp.players.filter((r) => r && r.gsis_id != null);
  const adjOf = (r) => {
    const p = projById.get(String(r.gsis_id));
    return p ? Number(p.proj_points) : 0;
  };
  const profile = normalizeProfile({
    shape: {
      teams: 12,
      roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
        'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    },
  });
  const seeded = cfgFromProfile(profile);
  // R27 — the fixture must still be a K/DEF league, but "K/DEF" is no longer
  // spelled as `carried`: the simulator drafts them now, so they are seats in
  // the shape. Asserting the seats keeps this guard honest instead of pinning
  // a mechanism the release deliberately retired.
  assert.equal(seeded.cfg.k, 1, 'the fixture must actually seat a kicker');
  assert.equal(seeded.cfg.def, 1, 'and a defence');
  assert.deepEqual(seeded.carried, [],
    'nothing in this league is undraftable any more');

  // PLAYERS tab and TEAM tab, each through its own entry point.
  const players = fairDollars(pool, adjOf, profile.shape.teams,
    Number(adp.auction_budget), rosterShape(seeded.cfg));
  const team = fairDollars(pool, adjOf, seeded.cfg.leagueSize,
    Number(adp.auction_budget), rosterShape(seeded.cfg));
  assert.ok(players.size > 100);
  assert.equal(players.size, team.size);
  const disagree = [];
  for (const [id, v] of team) {
    if (players.get(id) !== v) disagree.push(`${id}: team ${v} vs players ${players.get(id)}`);
  }
  assert.deepEqual(disagree, [],
    'PLAYERS and TEAM must quote one price per player for one league');

  // ...and the defect it replaces is real: handing fairDollars the raw
  // LeagueProfile (what players.js used to do) really does move the sheet, so
  // this test would have caught the bug rather than passing either way.
  //
  // R27 — THE SELF-CHECK MOVED, AND WHY. It used to run against the K/DEF
  // league above, because the draft-sim shape could not price K or DEF and came
  // out at 13 slots while the raw profile's geometry counted all 15. R27 makes
  // K and DEF draftable, so the bridge cfg is 15 too and the two now AGREE for
  // this league. That convergence is the POINT of the release, not a
  // regression — it is asserted directly below rather than left implicit.
  //
  // The defect itself is unchanged and still reachable, so the self-check moves
  // to a league ROSTER_BOUNDS clamps: four starting RBs become three in the
  // draft-sim shape while the raw profile's geometry still counts four.
  assert.equal(rosterShape(seeded.cfg).size, rosterGeometry(profile).all.length,
    'R27: a K/DEF league\'s draft-sim shape and its profile geometry must now agree');

  const clampedProfile = normalizeProfile({
    shape: {
      teams: 12,
      roster_positions: ['QB', 'RB', 'RB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
        'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
    },
  });
  const clampedCfg = cfgFromProfile(clampedProfile).cfg;
  assert.equal(clampedCfg.rb, 3, 'the fixture must actually be clamped by ROSTER_BOUNDS');
  const bridged = fairDollars(pool, adjOf, clampedProfile.shape.teams,
    Number(adp.auction_budget), rosterShape(clampedCfg));
  const rawProfileShape = fairDollars(pool, adjOf, clampedProfile.shape.teams,
    Number(adp.auction_budget), clampedProfile);
  let moved = 0;
  for (const [id, v] of bridged) if (rawProfileShape.get(id) !== v) moved += 1;
  assert.ok(moved > 0,
    'the raw-profile shape must be demonstrably different, or this test proves nothing');

  // The view reads the bridge, not a second hand-rolled translation.
  assert.match(SRC, /rosterShape\(cfgFromProfile\(profile\)\.cfg\)/,
    'app/views/players.js must build its fairDollars shape from cfgFromProfile');
});

/* ---- splicing the row into a rendered card ------------------------------- */

const CARD = {
  gsis_id: 'espn-1', name: 'Test Player', team: 'KC', position: 'RB',
  proj_points: 200.4, low: 150.2, high: 260.9, signals_used: [],
};

test('a card with nothing extra to say is byte-for-byte unchanged', () => {
  const base = renderPlayerCard(CARD, {});
  assert.equal(withExtraRow(base, ''), base);
  assert.equal(withExtraRow(base, renderPlayoffSos(null) + renderValue({ ...VAL })), base);
});

test('the extra row is spliced ahead of the conformal band, inside the card', () => {
  const base = renderPlayerCard(CARD, {});
  const extras = renderPlayoffSos(REPORT) + renderValue({ ...VAL, ours: 34, auction: 62 });
  const out = withExtraRow(base, extras);
  assert.ok(out.indexOf('class="p-adorn p-adorn--value"') > 0);
  assert.ok(out.indexOf('p-adorn--value') < out.indexOf('<div class="interval">'));
  assert.ok(out.indexOf('p-adorn--value') < out.indexOf('</article>'));
  // Nothing from the original card is lost — only the row is inserted.
  assert.equal(out.replace(/<div class="p-adorn p-adorn--value">.*?<\/div><div class="interval">/s,
    '<div class="interval">'), base);
});

test('a card render.js no longer anchors degrades to the plain card, never breaks', () => {
  const noAnchor = '<article class="card player"><div class="p-top"></div></article>';
  assert.equal(withExtraRow(noAnchor, '<span>x</span>'), noAnchor);
});

/* ---- the window comes from the league, and the bye chip fires on real data - */

test('the playoff window is the LEAGUE\'s, and byes in it are found on real data', () => {
  const weekly = load('player_weekly.json');
  const strength = load('team_strength.json');

  // Default league (playoffs start week 15): no committed player has a bye that
  // late, so no bye chip renders — absence here is a fact, not a gap.
  const dflt = playoffSosById(weekly, strength, normalizeProfile(null));
  const dfltByes = Object.values(dflt).filter((r) => r.byes > 0);
  assert.equal(dfltByes.length, 0);
  assert.equal(Object.values(dflt).filter((r) => renderPlayoffByes(r) !== '').length, 0);

  // A league whose playoffs start in week 14 pulls real byes into the window —
  // the chip is driven by the profile, not by a hardcoded week.
  const early = playoffSosById(weekly, strength,
    normalizeProfile({ shape: { playoff_week_start: 14 } }));
  const earlyByes = Object.values(early).filter((r) => r.byes > 0);
  /* This used to pin the exact count (19). That number is a fact about ONE
   * day's committed data, not about the code: R32 corrected 70 players'
   * teams to the current season, their byes moved with them, the count
   * became 16, and the gate turned red on a data refresh with no code
   * defect. The invariant this test exists for is that widening the window
   * to week 14 PULLS REAL BYES IN — the chip is profile-driven, not
   * hardcoded — so assert existence and the chip contract below, never a
   * churn-fragile count. */
  assert.ok(earlyByes.length > 0,
    'a week-14 playoff start must pull real byes into the window on this data');
  for (const r of earlyByes) {
    const chip = renderPlayoffByes(r);
    assert.match(chip, /BYE W14/);
    assert.match(chip, new RegExp(`${r.games}/4 GAMES`));
  }
  // Every report still renders a difficulty chip; none render an empty one.
  for (const r of Object.values(early)) {
    assert.notEqual(renderPlayoffSos(r), '');
  }
});
