/* app/views/players.js — the PLAYERS view (#/players).
 *
 * Fetches season player projections and paints one .card.player per player,
 * with a .posfilter chip row (ALL/QB/RB/WR/TE) that filters the list entirely
 * client-side (no re-fetch). Empty/error states render a .state message.
 *
 * Weekly layer (degrades gracefully): player_weekly.json adds
 *   - a PPR/HALF/STD .scoreseg in the header. Conversion is EXACT via
 *     receptions_prior: half = ppr − 0.5·rec, std = ppr − rec (season);
 *     interval ends + weekly points scale by season_adj/season_ppr.
 *     Persisted in localStorage nfl2026.scoring.v1 (TEAM tab reads the same).
 *   - a per-card WEEKS toggle (.p-expand) that lazily injects the 18-cell
 *     .wkstrip at the CURRENT scoring mode.
 *
 * REL2 layers (all optional — each hides itself if its feed 404s on an older
 * deploy, view never blanks):
 *   - AI TREND chip per card (player_history/ai_insights trajectory): up/down
 *     with real pts/yr when measured, "AI EST" when age-curve estimated.
 *   - STRENGTH OF SCHEDULE 1.0–5.0 per card (team_strength + weekly opponents).
 *   - a .aiseg BASE/AI+ toggle (shared nfl2026.ai.v1 with the TEAM tab): AI+ ON
 *     re-ranks the list by an AI-adjusted projection (proj × (1+trajectory_adj),
 *     bounded ±25%) and shows the per-player AI delta — so the AI's effect is
 *     visible on the numbers, not just the team-builder recos.
 *   - a .sortseg (PROJ / TREND / SOS) with a direction arrow.
 *
 * R21-B2 adds a SECOND adornment row per card (own its markup here — render.js
 * is integrator-owned, so the card string is composed, never edited):
 *   - a FANTASY-PLAYOFF SoS chip (app/playoffs.js) over the weeks THIS league's
 *     playoffs actually run, with byes called out as their own chip because a
 *     bye and a hard opponent are different problems. A null report renders as
 *     nothing at all — never a neutral-looking 0.
 *   - the MARKET auction price beside our own auction price, carrying the
 *     app's existing "MARKET · DISPLAY ONLY" badge verbatim. The market number
 *     is read from data/adp.json and displayed; it is never an input to a
 *     projection, a weight or a sort (validate_data.py MARKET_PRICE_FIELDS).
 */

import {
  getPlayerProjections, getPlayerWeekly, getAiInsights,
  getPlayerHistory, getTeamStrength, getGamePredictions, getAdp,
} from '../data.js';
import { renderPlayerCard, renderScoreSeg, renderWeekStrip } from '../render.js';
import { strengthOfSchedule, trendLabel } from '../team-logic.js';
import { rosPoints, gamesLeft } from '../ros.js';
import { playoffSos, playoffWindow } from '../playoffs.js';
import { loadProfile } from '../league.js';
import { fairDollars, DEFAULT_BUDGET } from '../auction.js';
import { rosterShape } from '../draft-sim.js';
/* R25-F3 — THE BOOT EDGE.
 *
 * ourDollars() below needs exactly one export from the TEAM view:
 * cfgFromProfile, the profile -> draft-simulator shape bridge. It is still
 * imported rather than re-derived — the price sheet here MUST agree with the
 * draft room's, and two hand-rolled translations of one league is exactly how
 * the two tabs came to disagree (see the note on ourDollars) — but it is no
 * longer imported STATICALLY.
 *
 * Measured problem: `import { cfgFromProfile } from './team.js'` put
 * views/team.js + sleeper.js + kdst.js + mocks.js (4 modules, 302,637 bytes)
 * into the STATIC graph of this module, and app/main.js imports this module
 * eagerly. So every route — slate, parlays, model, lineup, compare, none of
 * which price anything — had to fetch, parse and evaluate the whole team
 * builder before the router could mount, and main.js's deliberate lazy
 * `await import('./views/team.js')` bought nothing.
 *
 * Cutting the edge alone, though, only moves the cost: with team.js gone from
 * the boot graph, the first visit to #/team pays its own 2-wave round trip and
 * regresses ~98 ms (measured). So the module is ALSO warmed once the boot is
 * over — see teamModule()/the idle warm below. A module-scope `import()` was
 * measured as the alternative and rejected: a dynamic import is not discovered
 * at parse time like a static one, so it starts LATER than the edge it replaced
 * — team.js still shipped on all seven routes and #/team still regressed 21%.
 */
let _teamMod = null;
/** The TEAM view module, fetched at most once per session. */
function teamModule() {
  if (!_teamMod) _teamMod = import('./team.js');
  return _teamMod;
}
// Warm it AFTER the boot, never during it: requestIdleCallback runs once the
// first route has painted, so this costs the critical path nothing, and by the
// time a human can tap TEAM or PLAYERS the module is already in the registry —
// which is what keeps the edge-cut from becoming a #/team regression. The
// timeout bounds the wait on a busy thread; setTimeout covers Safari, which has
// no requestIdleCallback. Failures are ignored here: this is only a warm-up,
// and the real consumer (mountPlayers) reports a genuine load failure itself.
(() => {
  const warm = () => { teamModule().catch(() => {}); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 2000 });
  else setTimeout(warm, 800);
})();

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

const SCORING_KEY = 'nfl2026.scoring.v1';
const SCORING_SET = new Set(['ppr', 'half', 'std']);
const AI_KEY = 'nfl2026.ai.v1'; // shared with the TEAM tab — one AI+ preference

// Sort modes: which value orders the list. Direction toggles per click.
const SORTS = [
  { key: 'proj', label: 'PROJ' },
  { key: 'ros', label: 'ROS' },
  { key: 'trend', label: 'TREND' },
  { key: 'sos', label: 'SOS' },
];

/** Read the persisted scoring mode; unknown/unreadable values fall to ppr. */
function loadScoring() {
  try {
    const v = localStorage.getItem(SCORING_KEY);
    return SCORING_SET.has(v) ? v : 'ppr';
  } catch (err) {
    return 'ppr'; // storage blocked (private mode) — session default
  }
}

/** Persist the scoring mode; storage failures are non-fatal (display still flips). */
function saveScoring(mode) {
  try {
    localStorage.setItem(SCORING_KEY, mode);
  } catch (err) {
    /* storage blocked — the in-memory mode still drives the render */
  }
}

/** Read the shared AI+ preference (default OFF). */
function loadAiPref() {
  try {
    return localStorage.getItem(AI_KEY) === 'on';
  } catch (err) {
    return false;
  }
}

/** Persist the shared AI+ preference; failures are non-fatal. */
function saveAiPref(on) {
  try {
    localStorage.setItem(AI_KEY, on ? 'on' : 'off');
  } catch (err) {
    /* storage blocked — in-memory flag still drives the render */
  }
}

/**
 * Season points under a scoring mode. EXACT conversion via prior-season
 * receptions: half = ppr − 0.5·rec, std = ppr − rec. ppr passes through.
 */
function seasonAdjust(ppr, receptions, mode) {
  const rec = Number(receptions) || 0;
  if (mode === 'half') return ppr - 0.5 * rec;
  if (mode === 'std') return ppr - rec;
  return ppr;
}

/** Paint a plain .state message (empty / error). */
function stateMsg(el, text) {
  el.innerHTML = `<div class="state">${text}</div>`;
}

/* --------------------------------------------------------------------------
 * R21-B2 — playoff-SoS chip + market auction value (pure, exported for tests)
 * ------------------------------------------------------------------------ */

/** HTML-escape before interpolating (the local helper every view carries). */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One-decimal fixed number (mirrors render.js's fix1). */
const fix1 = (n) => Number(n).toFixed(1);

/**
 * Whole dollars ("$34"), the same rounding the TEAM tab's draft room uses.
 *
 * With ONE correction: a real price below half a dollar rounds to "$0", and "$0"
 * reads as free — which is exactly the claim an unpriced player must never make.
 * A positive price under a dollar renders "<$1", so "cheap" and "not priced"
 * stay visibly different readings.
 */
export function priceLabel(n) {
  const v = Math.round(Number(n));
  return v < 1 ? '<$1' : `$${v}`;
}

/**
 * The MARKET · DISPLAY ONLY badge, byte-identical to the one app/views/model.js
 * emits for market SIGNALS and app/render.js emits on the game market strip.
 * Reused verbatim on purpose: the app must have exactly ONE way of saying "this
 * number is a market price and it never moves anything we predict".
 * tests/feature/players_view.test.mjs asserts it still matches model.js's.
 */
export const MARKET_BADGE =
  '<span class="ms-badge" title="Market prices are never weighted into '
  + 'predictions (user policy)">MARKET · DISPLAY ONLY</span>';

/**
 * RATING_BANDS label -> tone class. Easiest/Easy read as a break, Hard/Hardest
 * as a cost, Neutral as neither. The WORD carries the meaning; the tone is
 * reinforcement, never the only carrier (same rule as the SoS meter).
 */
export function playoffTone(label) {
  if (label === 'Easiest' || label === 'Easy') return 'easy';
  if (label === 'Hard' || label === 'Hardest') return 'hard';
  return 'even';
}

/**
 * The BYE-inside-the-playoff-window chip, or '' when there is no bye in the
 * window. Deliberately a SEPARATE chip with its own shape (pill + warn border)
 * rather than a shade of the difficulty chip: "you have no game that week" is a
 * different problem from "you have a hard game that week", and the two must not
 * be readable as points on one scale.
 */
export function renderPlayoffByes(report) {
  if (!report || !report.byes) return '';
  const wk = report.window;
  const weeks = (report.schedule || []).filter((s) => s.bye).map((s) => `W${s.wk}`);
  const list = weeks.length ? weeks.join(' ') : `${report.byes} WEEK`;
  const title =
    `Bye inside your playoff window (weeks ${wk.start}-${wk.end}): `
    + `${weeks.length ? weeks.join(', ') : `${report.byes} week`}. `
    + 'This player scores 0 that week whoever the opponent is — only '
    + `${report.games} of ${wk.weeks} playoff weeks are games. `
    + 'The difficulty rating beside this chip is measured over the games only.';
  return (
    `<span class="posos-bye" title="${esc(title)}">`
      + '<span class="pb-glyph" aria-hidden="true">⊘</span>'
      + `<span class="pb-txt">BYE ${esc(list)}</span>`
      + `<span class="pb-n">${esc(report.games)}/${esc(wk.weeks)} GAMES</span>`
    + '</span>'
  );
}

/**
 * The fantasy-playoff strength-of-schedule chip for one playoffSos() report.
 *
 * NULL RENDERS AS ABSENT. A player with no weekly rows, no rated opponent in
 * the window, or an all-bye window has no reading at all — emitting a 0, a
 * dash-in-a-meter or a mid-scale "3.0" would read as "average schedule", which
 * is a claim the data does not support.
 *
 * Difficulty is relative to the player's OWN season average (report.rating), so
 * the chip answers "does it get harder when it matters?". The number is the
 * accessible source of truth, the band word says it in English, and the meter
 * is a redundant graphic — the same three-carrier rule as .p-sos.
 */
export function renderPlayoffSos(report) {
  if (!report) return '';
  const wk = report.window;
  const tone = playoffTone(report.label);
  const filled = Math.max(1, Math.min(5, Math.round(Number(report.rating))));
  const segs = [1, 2, 3, 4, 5].map((i) => (
    `<span class="po-seg${i <= filled ? ` po-seg--on po-seg--${tone}` : ''}"></span>`
  )).join('');
  const pts = Number(report.pts_per_game);
  const swing = pts === 0
    ? 'no swing'
    : `${pts > 0 ? '+' : ''}${pts.toFixed(2)} pts/game`;
  const title =
    `Weeks ${wk.start}-${wk.end} — your league's fantasy playoffs. `
    + `Mean opponent Elo ${report.playoff_elo} over ${report.games} `
    + `game${report.games === 1 ? '' : 's'} vs this player's own season average `
    + `${report.season_elo}: ${report.elo_diff > 0 ? '+' : ''}${report.elo_diff} Elo, `
    + `${swing} at the app's fixed 25 Elo per point. `
    + (report.byes ? `${report.byes} bye week in the window. ` : '')
    + (report.unrated
      ? `${report.unrated} window game skipped — opponent has no rating. ` : '')
    + 'Schedule lens only: never applied to a projection.';
  return (
    `<span class="p-posos p-posos--${tone}" title="${esc(title)}">`
      + `<span class="posos-lbl">PLAYOFF W${esc(wk.start)}-${esc(wk.end)}</span>`
      + `<span class="posos-num">${esc(fix1(report.rating))}</span>`
      + `<span class="posos-word">${esc(report.label)}</span>`
      + `<span class="posos-meter" aria-hidden="true">${segs}</span>`
    + '</span>'
    + renderPlayoffByes(report)
  );
}

/**
 * OUR auction price beside the MARKET's, or '' when we have neither.
 *
 *   ours         our dollars (app/auction.js fairDollars — VOR from OUR projections)
 *   auction      data/adp.json auction_value AS PUBLISHED (ESPN kona
 *                ownership.auctionValueAverage)
 *   teams        our league's team count (the profile's), for the title
 *   budget       OUR budget — the one OURS is denominated in, and the one the
 *                market price is restated into
 *   board        the market board's own league size, for the title
 *   boardBudget  the budget ESPN's published board is denominated in, or null
 *                when ESPN publishes none
 *
 * R24 FIX — WHOSE BUDGET IS THIS. `budget` used to be the MARKET board's
 * auction_budget while the title called it "your league (N teams, $B budget)":
 * one sentence, two different leagues. The draft-board cell in
 * app/views/team.js has always done this correctly — it prices OURS in the
 * user's budget and RESTATES the market number into it — so this cell now does
 * the same thing, and the title says which number was restated and from what.
 * With ESPN's board on the same $200 the app defaults to, the rescale is x1 and
 * every rendered price is byte-for-byte what it was.
 *
 * The market number is DISPLAY ONLY and carries MARKET_BADGE whenever the cell
 * renders — including when the price is missing — so a market column can never
 * appear on this card without the policy label attached to it. The badge lives
 * INSIDE the AUC cell (R24): as a flat sibling of both cells it read as a label
 * on the whole row, disclaiming this app's own OURS price along with the
 * market's. An unpriced player shows an em dash, never $0: ESPN publishing no
 * price is not a price.
 */
export function renderValue({ ours, auction, teams, budget, board, boardBudget } = {}) {
  const o = Number(ours);
  const raw = Number(auction);
  const ourBudget = Number(budget) > 0 ? Number(budget) : DEFAULT_BUDGET;
  // No published budget means the market price is in unknown dollars: it is
  // shown exactly as published and NOT restated, because a rescale we cannot
  // justify is a number we made up.
  const pubBudget = Number(boardBudget) > 0 ? Number(boardBudget) : null;
  const scale = pubBudget ? ourBudget / pubBudget : 1;
  const a = raw * scale;
  const haveOurs = Number.isFinite(o) && o > 0;
  const haveMkt = Number.isFinite(a) && a > 0;
  if (!haveOurs && !haveMkt) return '';
  const oursSentence = haveOurs
    ? `OURS ${priceLabel(o)} is this app's own auction price: value over replacement `
      + `from our projections, allocated across your league (${teams} teams, `
      + `$${ourBudget} budget).`
    : 'OURS is blank: this player is not on the draft board we price, so we have '
      + 'no auction price of our own for them.';
  const mktSentence = haveMkt
    ? `AUC ${priceLabel(a)} is the MARKET's price — ESPN's average winning bid on a `
      + `${board}-team board`
      + (pubBudget
        ? (scale === 1
          ? `, published on a $${pubBudget} budget.`
          : `, published as ${priceLabel(raw)} on a $${pubBudget} budget and restated `
            + `here in your $${ourBudget}.`)
        : ', on a board whose budget ESPN does not publish — so it is shown as '
          + 'published, not restated in your budget.')
    : 'AUC is blank: ESPN publishes no auction value for this player. That is a '
      + 'missing price, not a price of zero.';
  const title = `${oursSentence} ${mktSentence} The market price is shown for `
    + 'comparison only. It is never an input to a projection, a weight, or this '
    + "list's sort order.";
  return (
    `<span class="p-val" title="${esc(title)}">`
      + '<span class="pv-cell">'
        + '<span class="pv-lbl">OURS</span>'
        + (haveOurs
          ? `<span class="pv-us">${esc(priceLabel(o))}</span>`
          : '<span class="pv-us pv-none">—</span>')
      + '</span>'
      + '<span class="pv-cell pv-cell--mkt">'
        + '<span class="pv-lbl">AUC</span>'
        + (haveMkt
          ? `<span class="pv-mkt">${esc(priceLabel(a))}</span>`
          : '<span class="pv-mkt pv-none">—</span>')
        + MARKET_BADGE
      + '</span>'
    + '</span>'
  );
}

/**
 * The anchor renderPlayerCard() puts the conformal band behind. The R21-B2 row
 * is SPLICED in front of it rather than appended to render.js's own .p-adorn —
 * app/render.js is integrator-owned and this view may not edit it.
 */
const CARD_ANCHOR = '<div class="interval">';

/**
 * Compose a rendered card with an extra adornment row. If render.js ever stops
 * emitting the anchor the card is returned untouched: an integrator-side change
 * must cost this view its two chips, never the whole players list.
 */
export function withExtraRow(cardHtml, extras) {
  if (!extras) return cardHtml;
  const i = String(cardHtml).indexOf(CARD_ANCHOR);
  if (i < 0) return cardHtml;
  return `${cardHtml.slice(0, i)}<div class="p-adorn p-adorn--value">${extras}</div>${cardHtml.slice(i)}`;
}

/** A compact glossary so no acronym or arrow is ever unexplained; the same
 * collapsible <details> pattern the TEAM tab uses, owned locally (render.js is
 * integrator-owned, and this view's markup is its own). Static markup, placed
 * once under the view header. */
function renderLegend(opts = {}) {
  const wk = opts.window;
  const poRange = wk ? `W${wk.start}-${wk.end}` : '';
  return (
    '<details class="legend legend--players">' +
      '<summary>WHAT DO THESE MEAN?</summary>' +
      '<div class="legend-body">' +
        '<span class="legend-item"><b>PROJ</b> projected season points (your scoring mode)</span>' +
        '<span class="legend-item"><b>TREND</b> 5-yr trajectory — <span class="cd-trend--up">▲</span> improving, <span class="cd-trend--down">▼</span> declining</span>' +
        '<span class="legend-item"><b>SOS</b> strength of schedule, 1.0 easiest to 5.0 hardest</span>' +
        (wk
          ? `<span class="legend-item"><b>PLAYOFF ${esc(poRange)}</b> the same 1.0-5.0 scale over YOUR league's playoff weeks, measured against this player's own season average — 1.0 means it gets easier when it matters. Blank means we have no reading, not an average one.</span>`
            + '<span class="legend-item"><b>⊘ BYE</b> a bye INSIDE the playoff window — that week scores 0 no matter the matchup, which is a different problem from a hard opponent</span>'
          : '') +
        (opts.hasValue
          ? '<span class="legend-item"><b>OURS / AUC</b> our own auction price (value over replacement from our projections) beside the market\'s — AUC is ESPN\'s average winning bid, shown for comparison only and never used to make a number</span>'
          : '') +
        '<span class="legend-item"><b>BYE</b> the week this player has no game (scores 0)</span>' +
        '<span class="legend-item"><b>AI+</b> AI re-rank by 5-yr trajectory (bounded ±25%, labeled ESTIMATE)</span>' +
        '<span class="legend-item"><b>▼ / ▲</b> sort direction: ▼ descending (high→low), ▲ ascending (low→high)</span>' +
      '</div>' +
    '</details>'
  );
}

/** Build the position filter chip row. `active` is the selected position. */
function filterRow(active) {
  const chips = POSITIONS.map((pos) => {
    const on = pos === active;
    return (
      `<button type="button" class="pf-chip${on ? ' pf-chip--active' : ''}" ` +
        `data-pos="${pos}" aria-pressed="${on ? 'true' : 'false'}">${pos}</button>`
    );
  }).join('');
  return `<div class="posfilter" role="group" aria-label="Filter by position">${chips}</div>`;
}

/** The BASE/AI+ segmented toggle (shared pattern with the TEAM tab). */
function aiSegRow(on) {
  const btn = (label, active, val) => (
    `<button type="button" data-ai="${val}"` +
      `${active ? ' class="aiseg--active"' : ''} aria-pressed="${active ? 'true' : 'false'}">` +
      `${label}</button>`
  );
  return (
    '<div class="aiseg" role="group" aria-label="AI projection mode">' +
      `${btn('BASE', !on, 'off')}${btn('AI+', on, 'on')}` +
    '</div>'
  );
}

/** The inner buttons of the sort control (active one shows a ▼/▲ arrow). */
function sortChips(activeKey, dir) {
  return SORTS.map((s) => {
    const on = s.key === activeKey;
    const arrow = on ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    return (
      `<button type="button" class="sort-chip${on ? ' sort-chip--active' : ''}" ` +
        `data-sort="${s.key}" aria-pressed="${on ? 'true' : 'false'}">${s.label}${arrow}</button>`
    );
  }).join('');
}

/** The sort control wrapper. */
function sortRow(activeKey, dir) {
  return `<div class="sortseg" role="group" aria-label="Sort players">${sortChips(activeKey, dir)}</div>`;
}

/**
 * Mount the players view. Renders the header + controls + full list once, then
 * rewires chip/seg/expand clicks against data held in closure — no network
 * happens on filter, scoring, sort, or AI toggle changes.
 */
export default async function mountPlayers(el) {
  el.innerHTML = '<div class="state state--loading">Loading players…</div>';

  // Projections required; everything else optional (allSettled) so a missing
  // weekly/insight/history/strength file never blanks the view.
  const [projRes, weeklyRes, aiRes, histRes, strRes, predRes, adpRes, teamModRes] = await Promise.allSettled([
    getPlayerProjections(),
    getPlayerWeekly(),
    getAiInsights(),
    getPlayerHistory(),
    getTeamStrength(),
    getGamePredictions(),
    getAdp(),
    // The TEAM module, for cfgFromProfile — see the R25-F3 note at the top of
    // this file. Requested in the SAME allSettled as the contracts so that on a
    // cold deep-link to this route, where the idle warm has not fired yet, its
    // round trip overlaps the data fetches instead of serializing after them.
    teamModule(),
  ]);
  if (projRes.status !== 'fulfilled') {
    stateMsg(el, 'Players unavailable — the projection feed did not load.');
    return;
  }
  if (teamModRes.status !== 'fulfilled') {
    // No silent fallback: the price sheet MUST come from the same bridge the
    // draft room uses, so a missing module is reported, never approximated.
    stateMsg(el, 'Players unavailable — the pricing module did not load.');
    return;
  }
  const { cfgFromProfile } = teamModRes.value;
  const data = projRes.value;
  const weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;

  const players = (data && Array.isArray(data.players)) ? data.players : [];
  if (players.length === 0) {
    stateMsg(el, 'No player projections yet.');
    return;
  }

  // gsis_id -> weekly entry ({receptions_prior, weeks[18]}). Empty map ==
  // weekly layer off (hide scoreseg + WEEKS toggles, PPR-only).
  const weeklyById = new Map();
  if (weekly && Array.isArray(weekly.players)) {
    weekly.players.forEach((w) => weeklyById.set(String(w.gsis_id), w));
  }
  const hasWeekly = weeklyById.size > 0;

  // AI insights ({players:{id:{trajectory_adj,...}}}) — only real when populated.
  const aiInsights = (aiRes.status === 'fulfilled' && aiRes.value
    && aiRes.value.players && Object.keys(aiRes.value.players).length > 0)
    ? aiRes.value.players : null;
  // player_history fallback for trend when a player has no ai_insights entry.
  const history = (histRes.status === 'fulfilled' && histRes.value && histRes.value.players)
    ? histRes.value.players : null;
  const teamStrength = (strRes.status === 'fulfilled' && strRes.value && strRes.value.ratings)
    ? strRes.value : null;
  const hasAi = aiInsights !== null || history !== null; // trend feed present?

  // Current week for rest-of-season math: the pipeline's week from
  // game_predictions (defaults to 1 preseason -> RoS == full-season remaining).
  let currentWk = 1;
  if (predRes.status === 'fulfilled' && predRes.value && predRes.value.week != null) {
    const w = Number(predRes.value.week);
    if (Number.isFinite(w)) currentWk = Math.min(18, Math.max(1, Math.round(w)));
  }

  /* ---- R21-B2 layers (both optional; each hides itself when its feed is
   * absent, exactly like the REL2 layers above) --------------------------- */

  // THIS league decides which weeks are the playoffs. No profile saved ->
  // DEFAULT_PROFILE (weeks 15-17); an imported Sleeper league moves the window.
  const profile = loadProfile();
  // Taken from the module, never restated here, so the legend's week range and
  // the chips' week range cannot drift apart.
  const playoffWk = playoffWindow(profile);

  // data/adp.json: the drafter market. `auction_value` is a MARKET PRICE —
  // DISPLAY ONLY (validate_data.py MARKET_PRICE_FIELDS). It is read here to be
  // shown and to give our own price something to sit beside; it never reaches
  // model(), sortVal() or any number this view computes.
  const adpDoc = (adpRes.status === 'fulfilled' && adpRes.value
    && Array.isArray(adpRes.value.players)) ? adpRes.value : null;
  // OUR budget: the dollars OURS is denominated in. The LeagueProfile carries no
  // budget field, so this is the app default — the SAME default the TEAM tab's
  // draft room opens on (app/views/team.js draftCfg.budget), which is what makes
  // one player cost one price across the two tabs.
  const OUR_BUDGET = DEFAULT_BUDGET;
  // The MARKET board's own budget, or null when ESPN publishes none. This is
  // never used to price OURS — it is only what the market number is restated
  // FROM. (Before R24 it was used for both, so OURS was quoted in ESPN's
  // dollars under a tooltip that called them the user's.)
  const marketBoardBudget = adpDoc && Number(adpDoc.auction_budget) > 0
    ? Number(adpDoc.auction_budget) : null;
  const marketBoardTeams = adpDoc && Number.isFinite(Number(adpDoc.league_size))
    ? Number(adpDoc.league_size) : 12;
  // id -> auction_value. A null/0/absent price is NOT recorded: "ESPN does not
  // price this player" must stay distinguishable from "$0".
  const auctionById = new Map();
  if (adpDoc) {
    adpDoc.players.forEach((r) => {
      if (!r || r.gsis_id == null || r.auction_value == null) return;
      const v = Number(r.auction_value);
      if (Number.isFinite(v) && v > 0) auctionById.set(String(r.gsis_id), v);
    });
  }
  const hasValue = auctionById.size > 0;

  let scoring = hasWeekly ? loadScoring() : 'ppr';
  const PAGE = 60;              // initial cards + SHOW MORE step (phone perf)
  let shownCap = 60;
  let active = 'ALL';
  let aiOn = hasAi ? loadAiPref() : false;
  let sortKey = 'proj';
  let sortDir = 'desc';

  /** trajectory_adj insight for a player id (ai_insights first, else history). */
  function trajFor(id) {
    if (aiInsights && aiInsights[id] && aiInsights[id].trajectory_adj) {
      return aiInsights[id].trajectory_adj;
    }
    if (history && history[id] && history[id].trajectory) return history[id].trajectory;
    return null;
  }

  /** Bounded AI multiplier from trajectory_adj.value (±0.25); 1 when absent. */
  function aiRatio(id) {
    const t = aiInsights && aiInsights[id] ? aiInsights[id].trajectory_adj : null;
    const v = t && Number.isFinite(Number(t.value)) ? Number(t.value) : 0;
    const clamped = Math.max(-0.25, Math.min(0.25, v));
    return 1 + clamped;
  }

  const head =
    '<header class="view-head">' +
      '<h1 class="view-title">PLAYER PROJECTIONS</h1>' +
      `<span class="view-sub">${data.season != null ? data.season : ''} · SEASON POINTS</span>` +
    '</header>';

  /**
   * Build the render model for a player at the current scoring mode + AI mode.
   * Returns { player (scaled), weekly, trend, sos, aiDelta }.
   *  - scoring rescale: whole card scales by season_adj/season_ppr (ppr==0 -> 1)
   *  - AI+ ON: proj/interval further scale by the bounded AI ratio; aiDelta =
   *    (aiProj − baseProj) so the number visibly moves and the delta is shown.
   */
  function model(p) {
    const id = String(p.gsis_id);
    const w = weeklyById.get(id);
    const ppr = Number(p.proj_points);
    const scoreAdj = (w && scoring !== 'ppr') ? seasonAdjust(ppr, w.receptions_prior, scoring) : ppr;
    const scoreRatio = ppr > 0 ? scoreAdj / ppr : 1;
    const r = aiOn ? aiRatio(id) : 1;
    const proj = scoreAdj * r;
    const player = {
      ...p,
      proj_points: proj,
      low: Number(p.low) * scoreRatio * r,
      high: Number(p.high) * scoreRatio * r,
    };
    const trend = trendLabel(trajFor(id));
    const sos = sosOf(id);
    const aiDelta = aiOn ? (proj - scoreAdj) : null;
    return { player, weekly: !!w, trend, sos, aiDelta };
  }

  // Strength-of-schedule never changes for the life of the mount (weekly +
  // teamStrength are static), so memoize it: the SoS sort otherwise recomputes
  // the same value O(n log n) times per paint across ~450 players.
  const _sosCache = new Map();
  function sosOf(id) {
    if (_sosCache.has(id)) return _sosCache.get(id);
    const v = teamStrength ? strengthOfSchedule(weeklyById.get(id), teamStrength) : null;
    _sosCache.set(id, v);
    return v;
  }

  // Rest-of-season value (remaining-week projection sum) — static per mount, so
  // memoized like SoS. null when this player has no weekly data. Bye excluded.
  const _rosCache = new Map();
  function rosOf(id) {
    if (_rosCache.has(id)) return _rosCache.get(id);
    const w = weeklyById.get(id);
    const v = (w && Array.isArray(w.weeks))
      ? { points: rosPoints(w.weeks, currentWk), gamesLeft: gamesLeft(w.weeks, currentWk) }
      : null;
    _rosCache.set(id, v);
    return v;
  }

  // Fantasy-playoff SoS report per player — static per mount (weekly, strength
  // and the league profile are all fixed here), so memoized like SoS above.
  // A player with no weekly row / no rated window game caches a null and the
  // chip renders as absent.
  const _poCache = new Map();
  function playoffOf(id) {
    if (_poCache.has(id)) return _poCache.get(id);
    const v = teamStrength
      ? playoffSos(weeklyById.get(id), teamStrength, profile) : null;
    _poCache.set(id, v);
    return v;
  }

  // OUR auction price sheet, per scoring mode. Deliberately the SAME inputs the
  // TEAM tab's draft room uses — the ADP board rows that carry a gsis_id, priced
  // by scoring-adjusted season points over the league profile's roster — so a
  // player costs the same dollars on both surfaces instead of two engines
  // disagreeing about one number. (tests/feature/players_view.test.mjs proves
  // the equality against createAuction()'s own fair map on the committed data.)
  //
  // Priced from OUR points only: the market's dollars sit BESIDE this number on
  // the card, never inside it. AI+ deliberately does not move it either — the
  // draft room does not apply AI, and a price sheet that shifted with a display
  // toggle would be a different number on every screen.
  //
  // R21 FIX — THE SHAPE ARGUMENT. This used to hand fairDollars the raw
  // LeagueProfile while the draft room handed it rosterShape(draftCfg), and
  // app/auction.js reads `shape.size` when it has one and falls back to
  // geometry.all.length when it does not. For a league whose roster_positions
  // include K and DEF those two disagree (15 vs 13), which moves poolN, which
  // moves `spread`, which moves EVERY dollar on the sheet — so the Sleeper
  // leagues this release imports saw a different OURS price on PLAYERS than on
  // TEAM for the same player. Both call sites now build the shape the same way,
  // from the same bridge, so they cannot drift again.
  const _ourShape = rosterShape(cfgFromProfile(profile).cfg);
  const _projById = new Map(players.map((p) => [String(p.gsis_id), p]));
  const _ourCache = new Map();
  function ourDollars(mode) {
    if (_ourCache.has(mode)) return _ourCache.get(mode);
    let map = new Map();
    const pool = adpDoc
      ? adpDoc.players.filter((r) => r && r.gsis_id != null)
      : [];
    if (pool.length) {
      const adjOf = (r) => {
        const id = String(r.gsis_id);
        const p = _projById.get(id);
        if (!p) return 0;                  // on the board, not in our projections
        const w = weeklyById.get(id);
        const ppr = Number(p.proj_points);
        return (w && mode !== 'ppr') ? seasonAdjust(ppr, w.receptions_prior, mode) : ppr;
      };
      map = fairDollars(pool, adjOf, profile.shape.teams, OUR_BUDGET, _ourShape);
    }
    _ourCache.set(mode, map);
    return map;
  }

  /** The R21-B2 adornment row for one player id, or '' when neither half has
   * anything honest to say. */
  function extraRow(id) {
    const po = renderPlayoffSos(playoffOf(id));
    const val = renderValue({
      ours: ourDollars(scoring).get(id),
      auction: auctionById.get(id),
      teams: profile.shape.teams,
      budget: OUR_BUDGET,
      board: marketBoardTeams,
      boardBudget: marketBoardBudget,
    });
    return po + val;
  }

  /** Sort key value for a player under the active sort. */
  function sortVal(p) {
    const id = String(p.gsis_id);
    if (sortKey === 'trend') {
      const t = trajFor(id);
      const tl = t ? trendLabel(t) : null;
      // Rank by the signed adjustment magnitude+direction: use ai value if
      // present, else slope; flat/absent sinks to the middle (0).
      if (t && Number.isFinite(Number(t.value))) return Number(t.value);
      if (tl && Number.isFinite(Number(tl.slope_pts_per_yr))) return Number(tl.slope_pts_per_yr);
      return 0;
    }
    if (sortKey === 'sos') {
      const s = sosOf(id);
      return s == null ? -Infinity : s; // players without SoS sink on desc
    }
    if (sortKey === 'ros') {
      const r = rosOf(id);
      return r == null ? -Infinity : r.points; // no weekly data sinks on desc
    }
    // proj: honor the AI-adjusted number when AI+ is on (matches the display).
    //
    // R25-F3 measured, and REJECTED, a narrower `projPoints(p)` here that
    // returned the same double without model()'s object spread / trendLabel /
    // sosOf — on the theory that decorating all ~300 players to render only
    // shownCap of them was the cost. It is not: A/B over 360 repaints per arm
    // moved the ALL+PROJ repaint 10.3 -> 10.0 ms on iPad and 9.9 -> 9.9 ms on
    // phone, inside the run-to-run band, because paintList's own string
    // building is 9.4 ms of the ~10 ms and the decorate pass is ~0.2 ms of it.
    // Left as model() rather than keeping a second copy of the arithmetic in
    // sync for no measurable gain.
    return model(p).player.proj_points;
  }

  // Render the card list for the active filter + sort into #players-list.
  function paintList() {
    const base = (active === 'ALL'
      ? players
      : players.filter((p) => String(p.position).toUpperCase() === active));
    // Decorate–sort–undecorate: compute each player's sort key ONCE (n calls),
    // then sort by the cached number — instead of recomputing sortVal (which can
    // do SoS/trend/model work) O(n log n) times inside the comparator.
    const filtered = base
      .map((p) => ({ p, sv: sortVal(p) }))
      .sort((a, b) => {
        const d = b.sv - a.sv;
        const signed = sortDir === 'asc' ? -d : d;
        return signed || (String(a.p.gsis_id) < String(b.p.gsis_id) ? -1 : 1);
      })
      .map((x) => x.p);
    const listEl = el.querySelector('#players-list');
    if (!listEl) return;
    // Render cap: an unbounded list painted a ~90k-px page on phones. Show the
    // top slice and let SHOW MORE extend it; filters/sorts reset the cap.
    const capped = filtered.slice(0, shownCap);
    const more = filtered.length - capped.length;
    listEl.innerHTML = capped.length
      ? capped.map((p) => {
          const id = String(p.gsis_id);
          const m = model(p);
          // Show the RoS value chip when ranking by rest-of-season, so the sort
          // is legible (you see the number you sorted on), not just re-ordered.
          const ros = sortKey === 'ros' ? rosOf(id) : null;
          return withExtraRow(renderPlayerCard(m.player, {
            weekly: m.weekly, trend: m.trend, sos: m.sos, aiDelta: m.aiDelta, ros,
          }), extraRow(id));
        }).join('')
        + (more > 0
          ? `<button type="button" class="load-more" data-act="show-more">SHOW ${Math.min(more, PAGE)} MORE <span class="cd-meta">(${more} remaining)</span></button>`
          : '')
      : '<div class="state">No players at that position.</div>';
  }

  el.innerHTML =
    head +
    renderLegend({ window: teamStrength && hasWeekly ? playoffWk : null, hasValue }) +
    (hasWeekly ? renderScoreSeg(scoring) : '') +
    (hasAi ? aiSegRow(aiOn) : '') +
    filterRow(active) +
    sortRow(sortKey, sortDir) +
    (hasAi && aiOn
      ? '<div class="ai-note">AI+ re-ranks by 5-yr trajectory — projection ×(1±25%). Trend + SoS labeled per card. ESTIMATE.</div>'
      : '') +
    '<div id="players-list" class="card-list"></div>';
  paintList();

  // Wire the filter chips (event delegation on the filter row).
  const pf = el.querySelector('.posfilter');
  if (pf) {
    pf.addEventListener('click', (e) => {
      const btn = e.target.closest('.pf-chip');
      if (!btn) return;
      active = btn.dataset.pos;
      shownCap = PAGE;
      pf.querySelectorAll('.pf-chip').forEach((c) => {
        const on = c === btn;
        c.classList.toggle('pf-chip--active', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      paintList();
    });
  }

  // Wire the sort control. Clicking a new key selects it (desc); clicking the
  // active key toggles direction. The node persists — only its inner buttons
  // are repainted, so the single listener stays live.
  const ss = el.querySelector('.sortseg');
  if (ss) {
    ss.addEventListener('click', (e) => {
      const btn = e.target.closest('.sort-chip');
      if (!btn) return;
      const key = btn.dataset.sort;
      if (key === sortKey) {
        sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        sortKey = key;
        sortDir = 'desc';
      }
      ss.innerHTML = sortChips(sortKey, sortDir);
      paintList();
    });
  }

  // Wire the scoring seg (only rendered when weekly data exists).
  const seg = el.querySelector('.scoreseg');
  if (seg) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-scoring]');
      if (!btn) return;
      const mode = btn.dataset.scoring;
      if (!SCORING_SET.has(mode) || mode === scoring) return;
      scoring = mode;
      saveScoring(mode);
      seg.querySelectorAll('button[data-scoring]').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('scoreseg--active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      paintList();
    });
  }

  // Wire the AI+ toggle (only rendered when a trend feed exists). Flipping it
  // re-ranks + re-scales the projections and shows/hides the explainer note.
  const aiSeg = el.querySelector('.aiseg');
  if (aiSeg) {
    aiSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ai]');
      if (!btn) return;
      const on = btn.dataset.ai === 'on';
      if (on === aiOn) return;
      aiOn = on;
      saveAiPref(on);
      aiSeg.querySelectorAll('button[data-ai]').forEach((b) => {
        const act = (b.dataset.ai === 'on') === on;
        b.classList.toggle('aiseg--active', act);
        b.setAttribute('aria-pressed', act ? 'true' : 'false');
      });
      // Toggle the explainer note without a full re-render.
      let note = el.querySelector('.ai-note');
      if (on && !note) {
        const anchor = el.querySelector('.sortseg') || el.querySelector('.posfilter');
        if (anchor) {
          anchor.insertAdjacentHTML('afterend',
            '<div class="ai-note">AI+ re-ranks by 5-yr trajectory — projection ×(1±25%). '
            + 'Trend + SoS labeled per card. ESTIMATE.</div>');
        }
      } else if (!on && note) {
        note.remove();
      }
      paintList();
    });
  }

  // Wire SHOW MORE. Delegated on #players-list, NOT on `el`.
  //
  // R25-F3 — MOUNT RETENTION. `el` is the router's permanent #view element:
  // app/main.js resolves the same node on every navigation and never tears a
  // view down, so a listener registered on it outlives its mount forever. That
  // one listener's closure captures this whole mount scope (players,
  // weeklyById, the _sos/_ros/_po/_our caches, ...), which in turn keeps the
  // four control-row nodes and their listeners reachable — measured at +5.0
  // live listeners, +32 retained Nodes and +0.085 MiB per visit to this tab,
  // perfectly linear over 10 visits and growing without bound.
  // #players-list is created fresh by the innerHTML write above and is dropped
  // by the next mount's write, so the same delegation costs nothing permanent.
  // The SHOW MORE button is always inside #players-list (paintList emits it
  // there), so the click still reaches this handler by bubbling, unchanged.
  const listEl = el.querySelector('#players-list');
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="show-more"]');
      if (!btn) return;
      shownCap += PAGE;
      paintList();
    });
  }

  // Wire the per-card WEEKS toggles (delegation on the persistent list node).
  if (listEl && hasWeekly) {
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.p-expand');
      if (!btn) return;
      const card = btn.closest('.card.player');
      if (!card) return;
      const open = btn.getAttribute('aria-expanded') === 'true';
      let strip = card.querySelector('.wkstrip');
      if (!open && !strip) {
        const p = players.find((pl) => String(pl.gsis_id) === card.dataset.gsis);
        const w = weeklyById.get(card.dataset.gsis);
        if (!p || !w) return; // no weekly row — leave the card collapsed
        // Match the card's displayed ratio (scoring × AI) so the strip agrees.
        const ppr = Number(p.proj_points);
        const scoreAdj = scoring !== 'ppr' ? seasonAdjust(ppr, w.receptions_prior, scoring) : ppr;
        const scoreRatio = ppr > 0 ? scoreAdj / ppr : 1;
        const ratio = scoreRatio * (aiOn ? aiRatio(card.dataset.gsis) : 1);
        btn.insertAdjacentHTML('afterend', renderWeekStrip(w.weeks, ratio));
        strip = card.querySelector('.wkstrip');
      }
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (strip) strip.style.display = open ? 'none' : '';
    });
  }
}
