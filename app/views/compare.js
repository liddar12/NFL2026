/* app/views/compare.js — HEAD-TO-HEAD COMPARE (route #/compare?a=<id>&b=<id>).
 *
 * Phase 2 of the roadmap. A pairwise surface: pick two players and see every
 * decision-relevant metric side by side with the edge called out. It invents
 * nothing — every number already exists in the committed contracts and is read
 * through existing pure helpers (strengthOfSchedule, trendLabel, rosPoints).
 * Stateless + deep-linkable: the two picks live in the hash query, so a
 * comparison is shareable and survives reload with no login and no storage.
 *
 * Each side is either a chosen player or an inline finder. Choosing a player
 * rewrites the hash, which the router replays — no local paint state to drift.
 *
 * REL17 — AVAILABILITY is the FIRST metric row, above PROJ PTS: a manager
 * comparing two WRs for a flex spot needs "one of them is on IR" before he needs
 * a 0.4-point projection edge. Both columns always render the row so the centre
 * rail stays aligned; an available player is plain muted ACTIVE text, not a chip.
 * PROJ PTS remains the full-season HEALTHY prior by design — so an unavailable
 * player carries a one-line hint saying exactly that, and RoS VALUE is named as
 * the availability-adjusted number. Where a duration was parsed from a real team
 * report, the sentence itself is quoted; where it is only the league's rule floor
 * there is deliberately NO quote, because there is nothing to quote.
 *
 * R19-B5 — UNPROJECTED POSITIONS. K and DEF/DST have no projection feed yet, and
 * `Number(p.proj_points) || 0` would render that absence as a confident 0.0 — a
 * fabricated number that also loses every edge chip it appears in. Those cells
 * read "not projected yet" instead, and the centre rail falls back to its n/a
 * chip because there is genuinely nothing to compare.
 *
 * R21-B3 — PLAYOFF SoS. The season-long SoS row averages all 18 weeks, which is
 * the wrong question for a head-to-head: a manager choosing between two players
 * is choosing who wins him the weeks that decide his season. A second row reads
 * app/playoffs.js over the league's OWN playoff window (LeagueProfile
 * shape.playoff_week_start — never a hardcoded 14) and the centre rail gets the
 * same edge chip every other metric has. app/playoffs.js returns NULL, not a
 * neutral 3.0, when a player has no rated game in that window, so the row says
 * "no playoff-window data" in words and the rail says which side is missing
 * rather than crowning a winner over an absence.
 *
 * R21-B3 also fixes the WINNER GLYPH. `◀`/`▶` describe the >=561px layout, where
 * the two players sit left and right of the rail. Below 560px .cmp-grid collapses
 * to ONE column and the players STACK — A above the rail, B below it — so a left
 * arrow pointed at nothing. Both glyph pairs are emitted and the media query
 * picks one; no resize listener, no JS layout guess, and `display:none` keeps the
 * hidden pair out of innerText and out of the accessibility tree.
 *
 * R24-B — three carried findings, all of them about the SHELL rather than the
 * numbers (every value on this page is byte-for-byte what it was):
 *   1. THE CENTRE RAIL SHARES THE ROWS IT ANNOTATES. It used to be a separate
 *      column offset by a fixed `padding-top: 62px`, so a 45px chip beside a 35px
 *      metric row drifted ~10px per row: measured at 1366px the top chip sat 34px
 *      ABOVE its row's centre and the bottom chip 26px BELOW it — nearer the NEXT
 *      row than its own — and PLAYOFF SoS (R21-B3) made it one row worse. The
 *      columns and the rail are subgrids of ONE grid now (wide layout only), and
 *      the row count is READ OFF the rendered column into --cmp-rows, so adding a
 *      metric row cannot silently un-align the rail again.
 *   2. THE FINDERS HAVE NAMES. Two search boxes shared one placeholder, which is
 *      not an accessible name at all; each carries a visible <label for> now.
 *   3. THE "change" CONTROL IS A 44px TARGET. The pill is the inner span; the
 *      button around it is the target.
 * NOT changed, deliberately: the winner glyph already emits both orientations
 * (R21-B3) and .cmp-name is already 19px/800 large text, so those two carried
 * findings were re-checked against this source and did not reproduce.
 */

import {
  getPlayerProjections, getPlayerWeekly, getTeamStrength, getPlayerHistory,
  getGamePredictions,
} from '../data.js';
import { teamTint, renderTrendChip } from '../render.js';
import { strengthOfSchedule, trendLabel, withLeagueExtras } from '../team-logic.js';
import { availabilityOf, renderAvailChip } from '../availability.js';
import { isProjectedPosition } from '../lineup.js';
import { rosPoints, nextBye } from '../ros.js';
import { playoffSos } from '../playoffs.js';
import { loadProfile } from '../league.js';

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const fix1 = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(1) : '—');

/** Parse a/b out of the hash query (#/compare?a=..&b=..). */
function parsePicks() {
  const hash = window.location.hash || '';
  const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const params = new URLSearchParams(q);
  return { a: params.get('a') || '', b: params.get('b') || '' };
}

/** Rewrite the hash query, preserving the other side. Router replays it. */
function setPick(side, id, picks) {
  const next = { ...picks, [side]: id };
  const q = new URLSearchParams();
  if (next.a) q.set('a', next.a);
  if (next.b) q.set('b', next.b);
  window.location.hash = `#/compare${q.toString() ? `?${q}` : ''}`;
}

export default async function mountCompare(el) {
  el.innerHTML = '<div class="state state--loading">Loading compare…</div>';
  const [projRes, weeklyRes, strRes, histRes, predsRes] = await Promise.allSettled([
    getPlayerProjections(), getPlayerWeekly(), getTeamStrength(), getPlayerHistory(),
    getGamePredictions(),
  ]);
  if (projRes.status !== 'fulfilled') {
    el.innerHTML = '<div class="state">Compare unavailable — the projection feed did not load.</div>';
    return;
  }
  const players = (projRes.value && Array.isArray(projRes.value.players)) ? projRes.value.players : [];
  const byId = new Map(players.map((p) => [String(p.gsis_id), p]));
  const weekly = (weeklyRes.status === 'fulfilled' && weeklyRes.value && Array.isArray(weeklyRes.value.players))
    ? weeklyRes.value.players : [];
  const weeklyRaw = new Map(weekly.map((w) => [String(w.gsis_id), w]));
  const teamStrength = (strRes.status === 'fulfilled' && strRes.value && strRes.value.ratings) ? strRes.value : null;
  const historyMap = (histRes.status === 'fulfilled' && histRes.value && histRes.value.players)
    ? histRes.value.players : null;
  // Current week: RoS value and the "next bye" must be measured from HERE, not
  // week 1, or mid-season they overstate remaining value and show past byes.
  let currentWk = 1;
  if (predsRes.status === 'fulfilled' && predsRes.value && predsRes.value.week != null) {
    const w = Number(predsRes.value.week);
    if (Number.isFinite(w)) currentWk = Math.min(18, Math.max(1, Math.round(w)));
  }

  // The playoff window is the LEAGUE's, not a constant: a Sleeper import that
  // starts playoffs in week 14 must widen this row without touching this file.
  // loadProfile() returns DEFAULT_PROFILE when nothing is saved, so an untouched
  // install reads weeks 15-17 and every other number on this page is unchanged.
  const profile = loadProfile();
  /* R29 — THIS LEAGUE's own scoring rules, stamped onto the weekly entries once,
   * so every conversion below prices the same player identically without
   * threading a rate through eight signatures.
   *
   * It MUST sit after loadProfile(). The first cut of this put it beside the
   * map construction twenty lines up, where `profile` is still in its temporal
   * dead zone — which did not price leagues at zero, it threw a ReferenceError
   * and took the whole COMPARE view down. Caught by the REL17 availability
   * spec, whose .cmp-grid never appeared. */
  const weeklyById = withLeagueExtras(weeklyRaw, profile);

  const picks = parsePicks();
  // Same player on both sides is not a comparison — it diffs to all-"even" and
  // fires a bogus "same bye" warning. Drop the duplicate so the B column shows
  // a finder, and prompt for a different second player.
  const samePlayer = !!(picks.a && picks.b && picks.a === picks.b);
  if (samePlayer) picks.b = '';

  function metricsFor(id) {
    const p = byId.get(id);
    if (!p) return null;
    const w = weeklyById.get(id);
    const traj = historyMap && historyMap[id] ? historyMap[id].trajectory : null;
    const pos = String(p.position || '').toUpperCase();
    // R19-B5 — a K or a DEF has NO projection feed. `Number(x) || 0` would turn
    // that absence into a confident 0.0 sitting next to a real WR's 14.2, which
    // is the worst kind of wrong: a fabricated number that loses every edge chip
    // it appears in. Null means "no number exists", and the column says so.
    const projected = isProjectedPosition(pos);
    return {
      id,
      name: p.name || id,
      pos,
      team: p.team || '',
      projected,
      proj: projected ? Number(p.proj_points) || 0 : null,
      avail: availabilityOf(w, currentWk, currentWk),
      ros: (projected && w && Array.isArray(w.weeks)) ? rosPoints(w.weeks, currentWk) : null,
      sos: (w && teamStrength) ? strengthOfSchedule(w, teamStrength) : null,
      // NULL when the player has no rated, non-bye game inside the window. Kept
      // null all the way to the markup — never coerced to a mid-scale 3.0.
      psos: (w && teamStrength) ? playoffSos(w, teamStrength, profile) : null,
      bye: (w && Array.isArray(w.weeks)) ? nextBye(w.weeks, currentWk) : null,
      trend: traj ? trendLabel(traj) : null,
      trendVal: traj && Number.isFinite(Number(traj.slope_pts_per_yr)) ? Number(traj.slope_pts_per_yr) : null,
    };
  }

  const A = picks.a ? metricsFor(picks.a) : null;
  const B = picks.b ? metricsFor(picks.b) : null;

  const colA = colHtml('a', A);
  const colB = colHtml('b', B);
  // R24 — THE RAIL SHARES THE ROWS IT ANNOTATES. The centre column used to be
  // pushed down by a fixed `padding-top: 62px` and then run its own box model, so
  // every chip that was taller than the metric row beside it pushed the next one
  // further out of true: measured at 1366px the top chip sat 34px ABOVE its row's
  // centre and the bottom chip 26px BELOW it — closer to the next row than to its
  // own — and each metric row added since made it worse. The columns and the rail
  // now share ONE grid (CSS subgrid, wide layout only), so chip N is IN row N by
  // construction. The row count is read off the rendered column rather than
  // hardcoded in CSS, so adding a metric row cannot silently un-align the rail.
  const metricRows = (colA.match(/class="cmp-metric/g) || []).length;
  const aligned = !!(A && B) && metricRows > 0;

  el.innerHTML =
    '<header class="view-head">'
      + '<h1 class="view-title">COMPARE</h1>'
      + '<span class="view-sub">HEAD-TO-HEAD · <span class="est">ESTIMATE</span></span>'
    + '</header>'
    + `<div class="cmp-grid${aligned ? ' cmp-grid--aligned' : ''}"`
      + `${aligned ? ` style="--cmp-rows:${metricRows}"` : ''}>`
      + colA
      + '<div class="cmp-mid" id="cmp-mid"></div>'
      + colB
    + '</div>'
    + (samePlayer
      ? '<div class="state">That’s the same player on both sides — pick a different second player to compare.</div>'
      : (A && B ? '' : '<div class="state">Pick two players to see the head-to-head.</div>'));

  // Edge chips down the centre when both sides are chosen.
  if (A && B) {
    el.querySelector('#cmp-mid').innerHTML = midHtml(A, B);
  }

  // Wire the two inline finders (delegated).
  wireFinders(el, players, picks);
}

/**
 * The centre rail: ONE edge chip per metric row, in the SAME order colHtml()
 * emits those rows. Extracted (R21-B3) so the two orderings live next to each
 * other and a unit test can assert they still line up — a rail that drifts out
 * of order silently mislabels every chip below the drift.
 */
export function midHtml(A, B) {
  return (
    availEdge(A.avail, B.avail)
    + edge('PROJ', A.proj, B.proj, 'high')
    + edge('RoS', A.ros, B.ros, 'high')
    + edge('TREND', A.trendVal, B.trendVal, 'high')
    + edge('SoS', A.sos, B.sos, 'low')
    + playoffEdge(A.psos, B.psos)
    + byeEdge(A.bye, B.bye)
  );
}

/** One player column: identity + metric values, or an inline finder. */
export function colHtml(side, m) {
  if (!m) {
    // R24 — A REAL ACCESSIBLE NAME PER SIDE. Both finders carried the SAME
    // placeholder and nothing else, so a screen reader announced "search edit"
    // twice with no way to tell the A slot from the B slot — and a placeholder is
    // not an accessible name at all (it disappears the moment you type). The
    // label is a visible <label> tied to the input by id, so the name is the same
    // string a sighted user reads, and it names the side the way the layout does:
    // FIRST / SECOND, which is true both side-by-side and stacked.
    const ord = side === 'a' ? 'FIRST' : 'SECOND';
    const id = `cmp-find-${esc(side)}`;
    return (
      `<div class="cmp-col cmp-col--empty" data-side="${side}">`
      + `<label class="cmp-find-lbl" for="${id}">${ord} PLAYER</label>`
      + `<input class="cmp-find" id="${id}" data-side="${side}" type="search" `
        + `placeholder="Search player…" autocomplete="off" />`
      + `<div class="cmp-results" data-side="${side}"></div>`
      + '</div>'
    );
  }
  const row = (label, val) => `<div class="cmp-metric"><span class="cmp-lbl">${label}</span><span class="cmp-v">${val}</span></div>`;
  // A position with no feed says so, in words, once — never a dash that reads as
  // "zero" and never a number nobody computed.
  //
  // R24-B, ON THE RECORD: this branch is UNREACHABLE with the shipped data.
  // data/player_projections.json contains QB/RB/WR/TE only (0 K, 0 DEF, 0 DST),
  // so isProjectedPosition() is true for every player the finder can offer. It is
  // a guard for the day a K/DST feed reaches THIS contract — not a capability.
  // Compare does not "handle kickers" today and release copy must not say it does.
  const noFeed = `<span class="cmp-noproj" style="font-weight:600;color:var(--muted)">not projected yet</span>`;
  return (
    `<div class="cmp-col" data-side="${side}">`
    + `<div class="cmp-id"><span class="cmp-name" style="color:${teamTint(m.team)}">${esc(m.name)}</span>`
      + `<span class="cmp-pos">${esc(m.pos)} · ${esc(m.team)}</span>`
      // R24 — the 44px minimum touch target. The control was an ~18px pill; the
      // pill is now the INNER span (unchanged to look at) and the button around
      // it is the full-height target, so the thing you can hit is the thing the
      // project's own rule measures.
      + `<button type="button" class="cmp-swap" data-side="${side}" data-act="cmp-clear">`
        + '<span class="cmp-swap-pill">change</span></button></div>'
    + availRow(m.avail)
    + row('PROJ PTS', m.projected ? fix1(m.proj) : noFeed)
    + row('RoS VALUE', m.projected ? (m.ros == null ? '—' : fix1(m.ros)) : noFeed)
    + row('TREND', m.trend ? renderTrendChip(m.trend) : '—')
    + row('SoS', m.sos == null ? '—' : `${fix1(m.sos)} <span class="cmp-hint">1 easy · 5 hard</span>`)
    + playoffRow(m.psos)
    + row('BYE', m.bye == null ? '—' : `W${m.bye}`)
    + evidenceHtml(m.avail)
    + '</div>'
  );
}

/* --------------------------------------------------------------------------
 * R21-B3 — FANTASY-PLAYOFF SoS
 *
 * Exported PURE so the fast gate can prove the markup with no browser — the
 * pattern app/views/model.js and app/views/players.js already use.
 * ------------------------------------------------------------------------ */

/**
 * The PLAYOFF SoS metric row for one side, from an app/playoffs.js report.
 *
 * `report` is NULL whenever the player has no rated, non-bye game inside the
 * league's playoff window (no weekly rows, no team_strength, an all-bye window,
 * an unrated slate). That renders as the SENTENCE "no playoff-window data" —
 * the same treatment R19-B5 gave an unprojected K — and never as an em dash
 * (reads as zero) or a mid-scale 3.0 (reads as "average schedule"). The row is
 * rendered either way so the two columns and the centre rail stay row-aligned.
 *
 * The number is report.rating: 1.0 easiest .. 5.0 hardest, measured against
 * this player's OWN season average, so it answers "does his schedule get harder
 * when it matters?" rather than restating the season-long SoS row above it.
 * report.abs_rating — the window's ABSOLUTE difficulty on the same scale — rides
 * in the hint after the band word, because that is the reading playoffEdge()
 * compares and a verdict computed from a number the page never shows cannot be
 * checked by the person reading it.
 */
export function playoffRow(report) {
  const lbl = '<span class="cmp-lbl">PLAYOFF SoS</span>';
  if (!report) {
    return `<div class="cmp-metric cmp-metric--posos">${lbl}`
      + '<span class="cmp-v"><span class="cmp-noproj" style="font-weight:600;color:var(--muted)">'
      + 'no playoff-window data</span></span></div>';
  }
  const wk = report.window;
  const span = `W${esc(wk.start)}-${esc(wk.end)}`;
  // A bye inside the window is a DIFFERENT fact from a hard opponent and is
  // reported as its own clause, never folded into the difficulty number.
  const byes = report.byes
    ? ` · ${esc(report.byes)} bye`
    : '';
  const pts = Number(report.pts_per_game);
  const swing = Number.isFinite(pts) && pts !== 0
    ? `${pts > 0 ? '+' : ''}${pts.toFixed(2)} pts/game`
    : 'no swing';
  const title =
    `Weeks ${wk.start}-${wk.end} — this league's fantasy playoffs. `
    + `Mean opponent Elo ${report.playoff_elo} over ${report.games} `
    + `game${report.games === 1 ? '' : 's'} vs this player's own season average `
    + `${report.season_elo}: ${report.elo_diff > 0 ? '+' : ''}${report.elo_diff} Elo, `
    + `${swing} at the app's fixed 25 Elo per point. `
    + (report.byes ? `${report.byes} bye week in the window. ` : '')
    + (report.unrated
      ? `${report.unrated} window game skipped — opponent has no rating. ` : '')
    + (Number.isFinite(Number(report.abs_rating))
      ? `Absolute window difficulty ${fix1(report.abs_rating)} of 5 — that is the `
        + 'reading the centre chip compares, because a self-relative number is a '
        + 'different ruler for each player. '
      : '')
    + 'Schedule lens only: never applied to a projection.';
  // The ABSOLUTE reading rides in the hint beside the band word. It is what the
  // centre rail's winner verdict is computed from, so it has to be visible: a
  // chip that compares a number the page never prints is unauditable.
  const absTxt = Number.isFinite(Number(report.abs_rating))
    ? ` · ABS ${fix1(report.abs_rating)}`
    : '';
  return (
    `<div class="cmp-metric cmp-metric--posos">${lbl}`
    + `<span class="cmp-v" title="${esc(title)}">${fix1(report.rating)} `
    + `<span class="cmp-hint">${esc(report.label)} · ${span}${byes}${absTxt}</span></span></div>`
  );
}

/**
 * Centre edge chip for PLAYOFF SoS. Lower difficulty = easier slate = better, so
 * it borrows edge()'s 'low' direction and prints the same "N easier" phrasing the
 * season SoS chip uses.
 *
 * IT COMPARES `abs_rating`, NOT `rating` — R21 fix. app/playoffs.js is explicit
 * that `rating` is measured against each player's OWN season average: it answers
 * "does HIS schedule get harder when it matters?". Two such numbers are two
 * different rulers, and setting them against each other is not a comparison of
 * two playoff schedules at all — it crowned the wrong player on 3.1% of pairs
 * over the committed data. `abs_rating` is the window's raw difficulty on the
 * same 1-5 scale for both sides, which is the only reading a head-to-head
 * verdict can honestly rest on. The columns still headline `rating` (that is the
 * question that row answers per player), so both readings appear on screen and
 * the chip's own tooltip names the one it compared.
 *
 * A missing report on EITHER side is not a win for the other side: it is an
 * absence, and app/playoffs.js is explicit that null means "no reading", not
 * "neutral". The chip says which case it is instead of crowning anybody.
 */
export function playoffEdge(a, b) {
  const abs = (r) => (r && Number.isFinite(Number(r.abs_rating)) ? Number(r.abs_rating) : null);
  const av = abs(a);
  const bv = abs(b);
  if (av !== null && bv !== null) {
    return edge('PLAYOFF', av, bv, 'low',
      `Compared on ABSOLUTE playoff-window difficulty (${av.toFixed(1)} vs ${bv.toFixed(1)} `
      + 'on the 1-5 scale). The number each column headlines is that player\'s window '
      + 'measured against his OWN season average, which is a different ruler per player '
      + 'and cannot decide a head-to-head.');
  }
  const why = (av === null && bv === null) ? 'no window data' : 'one side only';
  return `<div class="cmp-edge cmp-edge--na">PLAYOFF<br><span class="cmp-even">${why}</span></div>`;
}

/**
 * The winner glyph, in BOTH orientations, with CSS choosing one.
 *
 * At >=561px .cmp-grid is `1fr auto 1fr` — A left, rail centre, B right — and a
 * left/right arrow is correct. At <=560px the grid collapses to one column and
 * the players STACK (A above the rail, B below), where the same arrow points at
 * nothing. Emitting both and letting the existing 560px breakpoint hide one
 * keeps the decision in the layer that owns the layout; no resize listener, no
 * JS measurement, and the hidden span is display:none so it stays out of
 * innerText and out of the accessibility tree.
 */
export function winGlyph(aWins) {
  return (
    '<span class="cmp-arrow">'
    + `<span class="cmp-arrow--wide">${aWins ? '◀' : '▶'}</span>`
    + `<span class="cmp-arrow--tall">${aWins ? '▲' : '▼'}</span>`
    + '</span>'
  );
}

/**
 * AVAILABILITY row — always rendered on both sides so the centre rail stays
 * row-aligned. Available = plain muted ACTIVE text (no chip, no green: a badge on
 * every healthy player is noise). Unavailable = the shared .av-chip plus the hint
 * that resolves the PROJ-next-to-IR question before it reads as a bug.
 */
function availRow(a) {
  const chip = renderAvailChip(a);
  if (!chip) {
    return '<div class="cmp-metric cmp-metric--avail"><span class="cmp-lbl">AVAILABILITY</span>'
      + '<span class="cmp-v cmp-avail-ok">ACTIVE</span></div>';
  }
  const hint = a.playable === false
    ? ' <span class="cmp-hint">PROJ is a full-season healthy prior — RoS VALUE is the availability-adjusted number.</span>'
    : '';
  return '<div class="cmp-metric cmp-metric--avail"><span class="cmp-lbl">AVAILABILITY</span>'
    + `<span class="cmp-v">${chip}${hint}</span></div>`;
}

/**
 * The report sentence that produced the duration — the payoff for a scraped
 * detail that used to be thrown away. Quoted, never paraphrased, clamped to 3
 * lines by CSS. Rendered ONLY for confidence "explicit": a league-rule floor has
 * no report behind it, and inventing a sentence there would be fabrication.
 */
function evidenceHtml(a) {
  if (!a || !a.applies || a.confidence !== 'explicit' || !a.evidence) return '';
  return '<div class="cmp-evid"><span class="cmp-evid-lbl">WHY · TEAM REPORT</span>'
    + `“${esc(a.evidence)}”</div>`;
}

/** Centre edge chip for availability — who can actually play this week. */
function availEdge(a, b) {
  const ap = !(a && a.playable === false);
  const bp = !(b && b.playable === false);
  if (ap && bp) return '<div class="cmp-edge cmp-edge--even">AVAIL<br><span class="cmp-even">even</span></div>';
  if (!ap && !bp) return '<div class="cmp-edge cmp-edge--warn">AVAIL<br><span class="cmp-even">⚠ neither</span></div>';
  return `<div class="cmp-edge">AVAIL<br><span class="cmp-win cmp-win--${ap ? 'a' : 'b'}">`
    + `${winGlyph(ap)} plays</span></div>`;
}

/**
 * Centre edge chip for a numeric metric. dir 'high' = higher wins, 'low' = lower
 * is easier/cheaper. `title`, when given, is the hover explanation of WHAT was
 * compared — needed whenever the compared reading is not the number the columns
 * print in their headline cell.
 */
function edge(label, a, b, dir, title) {
  const av = Number(a); const bv = Number(b);
  // The tooltip rides on the INNER span, never on the wrapper: the wrapper's
  // opening tag is the rail's structural signature and adding attributes to it
  // breaks anything reading the chip order.
  const tip = title ? ` title="${esc(title)}"` : '';
  if (!Number.isFinite(av) || !Number.isFinite(bv)) return `<div class="cmp-edge cmp-edge--na">${label}</div>`;
  const diff = av - bv;
  const eps = 1e-6;
  if (Math.abs(diff) < eps) return `<div class="cmp-edge cmp-edge--even">${label}<br><span class="cmp-even"${tip}>even</span></div>`;
  const aWins = dir === 'high' ? diff > 0 : diff < 0;
  const mag = Math.abs(Math.round(diff * 10) / 10);
  const word = dir === 'low' ? 'easier' : '';
  return (
    `<div class="cmp-edge">${label}<br>`
    + `<span class="cmp-win cmp-win--${aWins ? 'a' : 'b'}"${tip}>${winGlyph(aWins)} ${mag} ${word}</span>`
    + '</div>'
  );
}

function byeEdge(a, b) {
  if (a == null || b == null) return '<div class="cmp-edge cmp-edge--na">BYE</div>';
  if (a === b) return '<div class="cmp-edge cmp-edge--warn">BYE<br><span class="cmp-even">⚠ same</span></div>';
  return '<div class="cmp-edge cmp-edge--even">BYE<br><span class="cmp-even">differ</span></div>';
}

/* R25-F3 — MOUNT RETENTION.
 *
 * wireFinders delegates on `el`, which is app/main.js's PERMANENT #view node:
 * renderRoute() resolves the same element on every navigation and never tears a
 * view down. And this view remounts constantly BY DESIGN — setPick() above
 * rewrites the hash and lets the router replay the view, so every player a user
 * picks is a fresh mount. Measured on the shipped code: +2.0 live listeners per
 * mount, forever, plus whatever each abandoned closure pins.
 *
 * The stale handlers are not merely idle. They all still fire, and the `input`
 * one re-runs the whole-pool substring filter and rewrites the SAME results box
 * (it resolves the box from `el` at call time, not from its own mount), so one
 * keystroke costs N times the work after N picks. What it renders is unaffected
 * — every copy computes identical HTML from the same module-cached players
 * array — which is why this shows up as slowness rather than as a wrong screen.
 *
 * The listeners have to stay on `el`: the finder inputs and the result buttons
 * live inside markup mountCompare replaces wholesale, so there is no stable
 * inner node to delegate on the way players.js can use #players-list. So each
 * mount's registrations are tied to an AbortController instead and the previous
 * mount's are aborted here — a teardown, with no change to the emitted DOM.
 */
let _finderAbort = null;

function wireFinders(el, players, picks) {
  if (_finderAbort) _finderAbort.abort();
  _finderAbort = new AbortController();
  const { signal } = _finderAbort;
  el.addEventListener('input', (e) => {
    const input = e.target.closest('.cmp-find');
    if (!input) return;
    const side = input.dataset.side;
    const q = (input.value || '').trim().toLowerCase();
    const box = el.querySelector(`.cmp-results[data-side="${side}"]`);
    if (!box) return;
    if (!q) { box.innerHTML = ''; return; }
    const hits = players.filter((p) => `${p.name} ${p.team} ${p.position}`.toLowerCase().includes(q)).slice(0, 8);
    box.innerHTML = hits.map((p) => (
      `<button type="button" class="cmp-hit" data-act="cmp-pick" data-side="${side}" data-id="${esc(String(p.gsis_id))}">`
      + `${esc(p.name)} <span class="cmp-hit-meta">${esc(String(p.position).toUpperCase())} · ${esc(p.team)}</span></button>`
    )).join('') || '<div class="cmp-none">No match.</div>';
  }, { signal });
  el.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-act="cmp-pick"]');
    if (pick) { setPick(pick.dataset.side, pick.dataset.id, picks); return; }
    const clr = e.target.closest('[data-act="cmp-clear"]');
    if (clr) { setPick(clr.dataset.side, '', picks); }
  }, { signal });
}
