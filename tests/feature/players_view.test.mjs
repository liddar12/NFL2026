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
  const mine = fairDollars(pool, adjOf, profile.shape.teams,
    Number(adp.auction_budget), rosterShape(cfgFromProfile(profile).cfg));

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
  assert.deepEqual(seeded.carried, ['K', 'DEF'],
    'the fixture must actually carry the slots the draft simulator cannot price');

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
  const rawProfileShape = fairDollars(pool, adjOf, profile.shape.teams,
    Number(adp.auction_budget), profile);
  let moved = 0;
  for (const [id, v] of team) if (rawProfileShape.get(id) !== v) moved += 1;
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
  assert.equal(earlyByes.length, 19);
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
