/* app/views/grade.js — TEAM GRADE. Two ways in, one honest engine:
 *   1. SLEEPER LEAGUE (R42): paste your league id/URL and one LOAD press
 *      reads teams, rosters, the REAL weekly schedule and results-so-far.
 *      Completed weeks are locked as facts; future weeks are simulated on
 *      the actual matchups -> week-by-week win% + playoff/title odds
 *      conditioned on the real schedule and record.
 *      R48-C: every team's week is its BEST LEGAL LINEUP FROM THE FULL
 *      ROSTER (starters + bench, derived exactly as the LINEUP view derives
 *      a week — app/grade-weekly.js), so the bench covers byes and injuries
 *      automatically; the season sim draws each week from that week's own
 *      mean; and the page ends on PROJECTED FINAL STANDINGS — W-L, points
 *      for/against, playoff %, best-record % and title %.
 *   2. PASTE anything (site copy, typed names, JSON, HTML) — the R41 path,
 *      kept whole as the fallback for any league anywhere.
 *
 * Honesty surface (rules enforced in app/grade.js + app/grade-league.js):
 *   - unmatched lines/players are LISTED, never guessed;
 *   - a pre-draft league is a stated state (Sleeper publishes rosters and
 *     the schedule only after the draft), not a blank screen;
 *   - a week Sleeper has not published falls back to random pairing AND
 *     says so; a played game shows its RESULT, never a probability;
 *   - K/DEF are priced by the kdst contract under the league's own table,
 *     never by an offence conversion; an unfillable slot is EMPTY, never 0.0.
 *   - self-learning signals are at weight 0 and move nothing here (labelled).
 *   - ESTIMATE, everywhere, out loud. No market input anywhere.
 *
 * R52 — ONE press, ONE pass (owner RCA: LOAD sometimes painted nothing).
 *   Everything this view derives from the saved league profile lives in
 *   deriveLeagueContext(); a LOAD that changes the saved profile re-derives
 *   that context IN PLACE and carries on with the payloads it already holds —
 *   no remount, no flag, no second pass, no second player dump. A mount
 *   sequence (mountSeq) plus `isConnected` drops every late write from a
 *   superseded mount or an abandoned LOAD, so a stale load never paints into
 *   a panel the user has moved on from. See docs/GRADE_LOAD.md.
 */

import {
  getPlayerProjections, getPlayerWeekly, getScheduleFull, getGamePredictions, getMeta,
} from '../data.js';
import { projSeason, myRosterIds } from './players.js';
import { loadScoringMode, withLeagueExtras, SCORING_KEY } from '../team-logic.js';
import { scoringMode } from '../league.js';
import {
  loadProfile, rosterPositionsInPlay, saveProfile, saveLeagueId, loadLeagueId,
  isDefaultProfile, normalizeProfile,
} from '../league.js';
import {
  getKdstProjections, shapeKdst, isKdstPosition, canonKdstPosition, fedPositions,
  teamByeWeeks,
} from '../kdst.js';
import {
  buildLeague, gradeTeam, percentile, letterFor, syntheticFieldTotals,
  simulateLeague, weeklyWinTable, shapeFromRoster,
} from '../grade.js';
// R48 — the weekly-optimal season engine (app/grade-weekly.js: teamWeekPoints,
// seasonTable, simulateSeasonWeekly) is a LAZY import on the Sleeper LOAD path
// only, beside sleeper.js/grade-league.js, so the paste path and the boot graph
// are untouched. It supersedes simulateLeagueScheduled (R42) on this page; that
// pure function stays in app/grade.js for its own tests and callers.

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

function teamCard(t, grade, pctile, sim) {
  const starters = grade.starters.map((s) => (
    `<div class="gr-slot${s.empty ? ' gr-slot--empty' : ''}">`
    + `<span class="gr-pos">${esc(s.slot)}</span>`
    + (s.empty
      ? '<span class="gr-empty">EMPTY — no eligible player pasted (adds nothing)</span>'
      : `<span>${esc(s.name)}</span><span class="gr-pts">${s.pts.toFixed(1)}</span>`)
    + '</div>'
  )).join('');
  const un = t.unmatched.length
    ? '<div class="gr-unmatched"><b>NOT MATCHED (not graded, never guessed):</b> '
      + t.unmatched.map((l) => esc(l)).join(' · ') + '</div>'
    : '';
  const extra = t.note ? `<div class="gr-note">${esc(t.note)}</div>` : '';
  const simRow = sim && sim.playoff != null
    ? `<div class="gr-sim">PLAYOFFS ${pct(sim.playoff)} · TITLE ${pct(sim.title)} · `
      + `${sim.avgWins} avg wins <span class="ms-badge">ESTIMATE</span></div>`
    : '';
  return (
    '<article class="card gr-card">'
    + `<header class="gr-head"><h3>${esc(t.name)}</h3>`
    + `<span class="gr-grade">${esc(letterFor(pctile))}</span></header>`
    + `<div class="gr-total">${grade.total.toFixed(1)} projected starter pts`
    + (pctile == null ? '' : ` · ${pctile}th percentile`)
    + ` · bench ${grade.bench}</div>`
    + simRow + starters + un + extra
    + '</article>'
  );
}

/** The week-by-week schedule table. A final game is a FACT (score, no
 *  probability); a future game shows the closed-form win% from the same
 *  prior the season sim draws from. */
function weeklyTableHtml(table) {
  if (!table.length) return '';
  const rows = table.map((wk) => {
    const games = wk.unscheduled
      ? '<div class="gr-wk-game gr-wk-game--open">Sleeper has not published this week\'s '
        + 'matchups — simulated as random pairings.</div>'
      : wk.games.map((g) => (g.final
        ? `<div class="gr-wk-game"><span>${esc(g.aName)}</span>`
          + `<b>${g.aPts.toFixed(1)} — ${g.bPts.toFixed(1)}</b>`
          + `<span>${esc(g.bName)}</span><span class="gr-final">FINAL</span></div>`
        : `<div class="gr-wk-game"><span>${esc(g.aName)}</span>`
          + `<b>${pct(g.pA)} — ${pct(1 - g.pA)}</b>`
          + `<span>${esc(g.bName)}</span></div>`)).join('');
    return `<div class="gr-wk"><div class="gr-wk-label">WK ${wk.week}</div>${games}</div>`;
  }).join('');
  return '<article class="card gr-card"><header class="gr-head">'
    + '<h3>WEEK BY WEEK</h3><span class="ms-badge">ESTIMATE</span></header>'
    + rows + '</article>';
}

/* ---------------------------------------------------------- R49 estimates
 * OURS · SCENARIO · SLEEPER on the league cards and the standings. Sleeper's
 * numbers are Sleeper's own projections priced under THIS league's scoring
 * (app/sleeper-proj.js) — shown for comparison, never an input; the SCENARIO
 * sum is the self-learning candidate for the same starters. Where an engine
 * lacks a player, that player contributes nothing and the cell says n/N.
 * The Sleeper doc is fetched lazily AFTER the league paints and only the
 * affected cells are repainted; 404 (no file yet) leaves them hidden. */

const round1 = (n) => Math.round(n * 10) / 10;

/** "+3%" / "−12%" / '' — the other engine relative to OURS. */
function deltaTxt(ours, other) {
  if (ours == null || other == null) return '';
  const a = Number(ours);
  const b = Number(other);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return '';
  const raw = ((b - a) / Math.abs(a)) * 100;
  const pct = Math.round(Math.abs(raw)); // symmetric: −37.5 -> −38
  return pct === 0 ? '0%' : `${raw > 0 ? '+' : '−'}${pct}%`;
}

/**
 * The SCENARIO sum for a team's season-optimal starters: each starter's
 * candidate priced exactly as its shipped number was (sleeper-proj
 * scenarioOf on the starter's own OURS points). Starters with no candidate
 * add nothing and are reported in covered/total. null when none carries one
 * (older data). Pure.
 */
export function scenarioTeamSum(players, starters, mod, weeklyById, which = 'scenario') {
  // R49 follow-up — which='gated' sums the gate-conforming number instead
  // (candidate mode: OURS is the scenario, GATED replaces the SCENARIO sum).
  const priceOf = which === 'gated' ? mod.gatedOf : mod.scenarioOf;
  const byId = new Map((players || []).map((p) => [String(p.gsis_id), p]));
  const live = (starters || []).filter((st) => st && !st.empty && st.id != null);
  let points = 0;
  let covered = 0;
  let approx = false;
  for (const st of live) {
    const rec = byId.get(String(st.id));
    if (!rec || rec.kdst) continue;
    const w = weeklyById instanceof Map ? weeklyById.get(String(st.id)) : null;
    const extra = w && Number.isFinite(Number(w.extra_pts)) ? Number(w.extra_pts) : 0;
    const sc = priceOf(rec, { shipped: st.pts, extra });
    if (!sc) continue;
    points += sc.points;
    covered += 1;
    if (sc.approx) approx = true;
  }
  if (!covered) return null;
  return { points: round1(points), covered, total: live.length, approx };
}

/**
 * Sleeper's sums for one team: the season (same starters as the season-optimal
 * list), every weekly lineup, and the regular-season PF (sum of the weekly
 * sums). Each carries covered/total so the view can say "8/9 projected". Pure.
 */
export function sleeperTeamSummary(mod, idx, starters, weeks) {
  const ids = (starters || []).filter((st) => st && !st.empty && st.id != null).map((st) => String(st.id));
  const season = mod.sumSleeper(idx.byAppId, ids, null);
  const wkRows = (weeks || []).map((d) => {
    const wids = d.lineup.geometry.map((g) => d.lineup.slots[g.slot]).filter(Boolean).map(String);
    return { week: d.week, ...mod.sumSleeper(idx.byAppId, wids, d.week) };
  });
  const scored = wkRows.filter((r) => r.points != null);
  return {
    season,
    weeks: wkRows,
    pf: {
      points: scored.length ? round1(scored.reduce((sum, r) => sum + r.points, 0)) : null,
      covered: wkRows.reduce((sum, r) => sum + r.covered, 0),
      total: wkRows.reduce((sum, r) => sum + r.total, 0),
    },
  };
}

/** The card's OURS · SCENARIO line with the (hidden until it lands) SLEEPER cell. */
export function renderTeamEstimate({ ours, scenario, gated, mode, teamIndex }) {
  const o = Number(ours);
  const candidateMode = mode === 'candidate';
  let html = `<div class="gr-est">OURS <b>${Number.isFinite(o) ? o.toFixed(1) : '—'}</b>`
    + (candidateMode ? ' (scenario)' : '');
  const alt = candidateMode ? gated : scenario;
  if (alt && alt.points != null && Number.isFinite(Number(alt.points))) {
    html += ` · ${candidateMode ? 'GATED' : 'SCENARIO'} <b>${alt.approx ? '≈' : ''}${Number(alt.points).toFixed(1)}</b>`
      + ` ${deltaTxt(o, alt.points)} · ${alt.covered}/${alt.total} ${candidateMode ? 'gated' : 'candidates'}`;
  }
  html += `<span class="gr-est-sl" data-team="${teamIndex}" hidden></span></div>`;
  return html;
}

/** Repaint ONLY the Sleeper cells once the doc has landed. `teams` is
 *  [{ ours, starters, weeks }] in card order. */
function fillSleeperCells(out, mod, idx, teams) {
  teams.forEach((t, i) => {
    const sum = sleeperTeamSummary(mod, idx, t.starters, t.weeks);
    const cell = out.querySelector(`.gr-est-sl[data-team="${i}"]`);
    if (cell) {
      const s = sum.season;
      cell.innerHTML = s.points == null
        ? ' · SLEEPER <b>—</b> · 0/' + s.total + ' projected'
        : ` · SLEEPER <b>${s.points.toFixed(1)}</b> ${deltaTxt(t.ours, s.points)}`
          + ` · ${s.covered}/${s.total} projected`;
      cell.hidden = false;
    }
    sum.weeks.forEach((wk) => {
      const c = out.querySelector(`.gr-est-wk[data-team="${i}"][data-wk="${wk.week}"]`);
      if (!c) return;
      c.textContent = wk.points == null
        ? `SLEEPER — · 0/${wk.total}`
        : `SLEEPER ${wk.points.toFixed(1)} · ${wk.covered}/${wk.total}`;
      c.hidden = false;
    });
    const tr = out.querySelector(`.gr-standings tbody tr[data-team="${i}"]`);
    if (tr && !tr.querySelector('.gr-est-pf')) {
      const pf = sum.pf;
      const txt = pf.points == null ? '—' : pf.points.toFixed(1);
      const cov = pf.covered === pf.total ? '' : ` (${pf.covered}/${pf.total})`;
      tr.insertAdjacentHTML('beforeend',
        `<td class="gr-est-pf" title="Sleeper's points for OUR weekly optimal starters, regular season; ${pf.covered}/${pf.total} starter-weeks projected">${txt}${cov}</td>`);
    }
  });
  const head = out.querySelector('.gr-standings thead tr');
  if (head && !head.querySelector('.gr-est-th')) {
    head.insertAdjacentHTML('beforeend', '<th class="gr-est-th">SLEEPER PF</th>');
  }
}

/** One roster row's honesty tag: BYE / OUT / NO PROJECTION / SEASON AVG. */
function rowTag(r) {
  if (r.onBye) return ' <span class="gr-tag">BYE</span>';
  if (!r.playable) return ' <span class="gr-tag">OUT</span>';
  if (!r.projected) return ' <span class="gr-tag">NO PROJECTION</span>';
  if (r.seasonAvg) return ' <span class="gr-tag">SEASON AVG</span>';
  return '';
}

/**
 * R52 — one week of the per-week view: STARTERS (slot · name · pts) then
 * BENCH (name · pts). A seated player whom Sleeper lists on its bench carries
 * SUB when `sleeperStarters` (the app ids of Sleeper's own starters, from the
 * roster payload) is known; when it is not, nothing is marked. An unfillable
 * slot is EMPTY and adds nothing. Pure string builder.
 */
export function weekLineupHtml(d, { teamIndex, sleeperStarters } = {}) {
  const rowById = new Map(d.rows.map((r) => [r.id, r]));
  const seated = new Set();
  const canMarkSub = sleeperStarters instanceof Set;
  const slots = d.lineup.geometry.map((g) => {
    const id = d.lineup.slots[g.slot];
    const r = id ? rowById.get(id) : null;
    if (!r) {
      return `<div class="gr-slot gr-slot--empty"><span class="gr-pos">${esc(g.slot)}</span>`
        + '<span class="gr-empty">EMPTY — nobody on the roster can fill this slot</span></div>';
    }
    seated.add(r.id);
    const sub = canMarkSub && !sleeperStarters.has(String(r.id))
      ? ' <span class="gr-tag gr-tag--sub" title="Sleeper lists this player on the bench">SUB</span>'
      : '';
    return `<div class="gr-slot"><span class="gr-pos">${esc(g.slot)}</span>`
      + `<span>${esc(r.name)}${sub}${rowTag(r)}</span>`
      + `<span class="gr-pts">${r.projected ? r.pts.toFixed(1) : '—'}</span></div>`;
  }).join('');
  const bench = d.rows.filter((r) => !seated.has(r.id)).map((r) => (
    `<div class="gr-slot gr-slot--bench"><span class="gr-pos">BN</span>`
    + `<span>${esc(r.name)}${rowTag(r)}</span>`
    + `<span class="gr-pts">${r.projected ? r.pts.toFixed(1) : '—'}</span></div>`
  )).join('');
  return `<div class="gr-week"><div class="gr-week-head"><span>WK ${d.week}</span>`
    + (teamIndex == null ? '' : `<span class="gr-est-wk" data-team="${teamIndex}" data-wk="${d.week}" hidden></span>`)
    + `<b>${d.total.toFixed(1)}</b></div>`
    + '<div class="gr-week-sub">STARTERS</div>' + slots
    + '<div class="gr-week-sub">BENCH</div>'
    + (bench || '<div class="gr-slot gr-slot--bench"><span class="gr-empty">nobody on the bench</span></div>')
    + '</div>';
}

/**
 * R48 — the Sleeper-league team card. The letter grade stays; the number under
 * it is the season total of WEEKLY optimal lineups (the bench substituted every
 * week) — the number the standings use — and the disclosure is the per-week
 * view (starters, bench, SUB). An unfillable slot reads EMPTY — never a
 * fabricated 0.0; a player with no projection shows an em dash.
 * R52 — the header says what the number IS; the season-optimal starters (a
 * different lineup, whose sum the standings do NOT use) sit in their own fold
 * with the R49 OURS · SCENARIO · SLEEPER line that prices exactly them.
 */
function leagueTeamCard(t, info) {
  const {
    seasonTotal, pctile, bench, sim, weeks, weekCount, grade, teamIndex, scenario, gated, mode,
    sleeperStarters,
  } = info;
  const seasonStarters = grade && Array.isArray(grade.starters) ? grade.starters : [];
  const starterCount = seasonStarters.length;
  const starterHtml = seasonStarters.map((st) => (
    `<div class="gr-slot${st.empty ? ' gr-slot--empty' : ''}">`
    + `<span class="gr-pos">${esc(st.slot)}</span>`
    + (st.empty
      ? '<span class="gr-empty">EMPTY — nobody on the roster can fill this slot</span>'
      : `<span>${esc(st.name)}</span><span class="gr-pts">${st.pts.toFixed(1)}</span>`)
    + '</div>'
  )).join('');
  const simRow = sim && sim.playoff != null
    ? `<div class="gr-sim">PLAYOFFS ${pct(sim.playoff)} · TITLE ${pct(sim.title)} · `
      + `${sim.avgWins} avg wins · PF ${sim.pf.toFixed(1)} / PA ${sim.pa.toFixed(1)} `
      + '<span class="ms-badge">ESTIMATE</span></div>'
    : '';
  const weekHtml = weeks.map((d) => weekLineupHtml(d, { teamIndex, sleeperStarters })).join('');
  const un = t.unmatched.length
    ? '<div class="gr-unmatched"><b>NOT MATCHED (not graded, never guessed):</b> '
      + t.unmatched.map((l) => esc(l)).join(' · ') + '</div>'
    : '';
  const extra = t.note ? `<div class="gr-note">${esc(t.note)}</div>` : '';
  return (
    '<article class="card gr-card gr-card--team">'
    + `<header class="gr-head"><h3>${esc(t.name)}</h3>`
    + `<span class="gr-grade">${esc(letterFor(pctile))}</span></header>`
    + '<div class="gr-sub">WEEKLY-OPTIMAL TOTAL · best legal lineup each week, bench substituted</div>'
    + `<div class="gr-total"><b>${seasonTotal.toFixed(1)}</b> projected season pts from weekly optimal lineups`
    + (pctile == null ? '' : ` · ${pctile}th percentile`)
    + ` · bench ${bench}</div>`
    + simRow
    + `<details class="gr-weeks"><summary>Week by week · starters, bench and SUBs · ${weekCount} weeks`
    + (sleeperStarters instanceof Set ? '' : ' · SUB not marked (Sleeper\'s starters unknown)')
    + '</summary>'
    + weekHtml + '</details>'
    // R49's OURS · SCENARIO · SLEEPER line prices the season-optimal starters
    // and stays on the card (a display-only comparison); the starters it
    // prices are one tap away, labelled as NOT the standings number.
    + '<div class="gr-sub">SEASON-OPTIMAL STARTERS · one fixed lineup all season · NOT what the standings use</div>'
    + renderTeamEstimate({ ours: grade ? grade.total : null, scenario, gated, mode, teamIndex })
    + `<details class="gr-season"><summary>Season-optimal starters · ${starterCount} slots · not the standings number</summary>`
    + starterHtml + '</details>'
    + un + extra
    + '</article>'
  );
}

/** R48 — the last thing on the page: projected final standings, ordered by
 *  projected wins then points, plus the two most-likely lines. ESTIMATE. */
function standingsHtml(season) {
  if (!season || !Array.isArray(season.standings) || !season.standings.length) return '';
  const rows = season.standings.map((s) => (
    `<tr data-team="${s.index}"><td>${s.rank}</td><td>${esc(s.name)}</td>`
    + `<td>${s.wins.toFixed(1)}-${s.losses.toFixed(1)}</td>`
    + `<td>${s.pf.toFixed(1)}</td><td>${s.pa.toFixed(1)}</td>`
    + `<td>${pct(s.playoff)}</td><td>${pct(s.regSeasonTitle)}</td><td>${pct(s.title)}</td></tr>`
  )).join('');
  const top = (key) => season.teams.slice().sort((a, b) => b[key] - a[key])[0];
  const reg = top('regSeasonTitle');
  const champ = top('title');
  return '<article class="card gr-card gr-card--standings">'
    + '<header class="gr-head"><h3>PROJECTED FINAL STANDINGS · ESTIMATE</h3></header>'
    + '<div class="gr-standings-wrap"><table class="gr-standings"><thead><tr>'
    + '<th>#</th><th>TEAM</th><th>W-L</th><th>PF</th><th>PA</th>'
    + '<th>PLAYOFF</th><th>REG #1</th><th>TITLE</th></tr></thead>'
    + `<tbody>${rows}</tbody></table></div>`
    + `<div class="gr-likely">Most likely regular-season winner: ${esc(reg.name)} (${pct(reg.regSeasonTitle)})</div>`
    + `<div class="gr-likely">Most likely champion: ${esc(champ.name)} (${pct(champ.title)})</div>`
    + '</article>';
}

/* --------------------------------------------------------------- Sleeper */

/* R47 — a LOAD on this tab is a league sync for the WHOLE session: the
 * league's settings are saved (profile + scoring lock + league id) exactly
 * as TEAM's SYNC NOW saves them. R52 — the view then re-derives its own
 * context in place (deriveLeagueContext) and the SAME load carries on; no
 * remount, no pending flag. */
async function syncLeagueSettings(sleeper, idText) {
  const imported = await sleeper.importFromSleeper(idText);
  if (!imported.ok || !imported.profile) return { changed: false, name: null };
  const next = normalizeProfile(imported.profile);
  const changed = JSON.stringify(next) !== JSON.stringify(loadProfile());
  if (changed) saveProfile(next);
  const mode = scoringMode(next);
  if (mode !== 'custom') {
    try { localStorage.setItem(SCORING_KEY, mode); } catch (err) { /* session-only */ }
  }
  saveLeagueId(idText);
  try { window.dispatchEvent(new Event('nfl2026:league')); } catch (err) { /* no window */ }
  return { changed, name: next.name };
}

/** "2.1 MB" — bytes to one decimal; never a number for an unknown size. */
function mbText(bytes) {
  const b = Number(bytes);
  return Number.isFinite(b) && b >= 0 ? `${(b / 1e6).toFixed(1)} MB` : '';
}

/**
 * The Sleeper LOAD, one pass. `host` is the mount's contract:
 *   host.ctx()            the CURRENT league context (deriveLeagueContext);
 *   host.rederive()       re-derive it from the saved profile, in place;
 *   host.stale()          true once this write must be dropped (a newer
 *                         mount, a newer LOAD, or the panel left the DOM).
 * Every DOM write after an await goes through `paint`, which asks stale()
 * first. A stale load ends silently (one console.debug), never in the DOM.
 */
async function loadSleeperLeague(idText, out, host) {
  const paint = (html) => {
    if (host.stale()) { console.debug('grade: stale LOAD dropped'); return false; }
    out.innerHTML = html;
    return true;
  };
  if (!paint('<div class="state state--loading">Reading your league from Sleeper — '
    + 'rosters, schedule and results so far…</div>')) return;
  // Lazy on purpose: none of this rides the paste path or the boot path.
  const [sleeper, gradeLeague, gradeWeekly, sleeperProj] = await Promise.all([
    import('../sleeper.js'), import('../grade-league.js'),
    import('../grade-weekly.js'),
    import('../sleeper-proj.js'), // R49 — display-only estimates, LOAD path only
  ]);
  const leagueRes = await sleeper.fetchSleeperLeague(idText);
  if (!leagueRes.ok) {
    paint(`<div class="state">${esc(leagueRes.error.message)}</div>`);
    return;
  }
  const meta = gradeLeague.leagueMeta(leagueRes.payload);
  // R47 — save the league for every tab FIRST (pre-draft leagues carry their
  // settings already). R52 — if the saved profile changed, this view's shape,
  // pool and pricing become the league's RIGHT HERE and the load continues.
  const synced = await syncLeagueSettings(sleeper, idText);
  if (host.stale()) { console.debug('grade: stale LOAD dropped'); return; }
  if (synced.changed) await host.rederive();
  if (host.stale()) { console.debug('grade: stale LOAD dropped'); return; }
  if (meta.preDraft) {
    paint(`<div class="state">“${esc(meta.name)}” is ${esc(meta.status)} on Sleeper. `
      + 'Rosters and the weekly schedule appear once your draft has run — load again after '
      + 'it. Until then, the paste box below grades any lineup you give it.</div>');
    return;
  }
  const teamsRes = await sleeper.importSleeperTeams(idText);
  if (!teamsRes.ok || !teamsRes.teams.length) {
    paint(`<div class="state">${esc((teamsRes.error && teamsRes.error.message)
      || 'Sleeper returned no teams for that league.')}</div>`);
    return;
  }
  // R52 — the player dump is read ONCE per session (app/sleeper.js memo) and
  // streamed with a progress line; a cached hit says so.
  if (!paint('<div class="state state--loading">Reading Sleeper\'s player list… '
    + '<span id="gr-dump-progress"></span></div>')) return;
  const dumpRes = await sleeper.loadSleeperPlayerIndex({
    onProgress: ({ bytes }) => {
      if (host.stale()) return;
      const p = out.querySelector('#gr-dump-progress');
      if (p) p.textContent = mbText(bytes);
    },
  });
  if (!dumpRes.ok) {
    paint('<div class="state">Sleeper\'s player list did not load '
      + `(${esc(dumpRes.error && dumpRes.error.message)}), so rosters cannot be matched to `
      + 'our projections. Try again, or use the paste box below.</div>');
    return;
  }
  const { index } = dumpRes;
  if (!paint('<div class="state state--loading">Reading Sleeper\'s player list… '
    + `${dumpRes.cached ? 'cached' : esc(mbText(dumpRes.bytes))} · reading the schedule…</div>`)) return;

  const endWeek = (meta.playoffWeekStart || 14) - 1;
  const weekNums = Array.from({ length: endWeek }, (_, i) => i + 1);
  const matchupWeeks = await Promise.all(weekNums.map(async (wk) => {
    const res = await sleeper.fetchSleeperMatchups(idText, wk);
    const mapped = res.ok ? sleeper.mapMatchups(res.payload, wk) : { matchups: [] };
    return { week: wk, matchups: mapped.matchups };
  }));

  // R48 — the NFL schedule (K/DEF byes) and the live week (availability) ride
  // the LOAD, not the boot. Both are optional: no schedule means no bye claim
  // for a defence, no live week means week 1 — never an invented number.
  const [schedRes, predsRes, metaRes] = await Promise.allSettled([
    getScheduleFull(), getGamePredictions(),
    getMeta(), // R49 follow-up — which number OURS is (LOAD path, not the cold mount)
  ]);
  if (host.stale()) { console.debug('grade: stale LOAD dropped'); return; }
  const shipped = sleeperProj.shippedMode(metaRes.status === 'fulfilled' ? metaRes.value : null);
  const byeByTeam = teamByeWeeks(schedRes.status === 'fulfilled' ? schedRes.value : null);
  let currentWk = 1;
  if (predsRes.status === 'fulfilled' && predsRes.value && predsRes.value.week != null) {
    const w = Number(predsRes.value.week);
    if (Number.isFinite(w)) currentWk = Math.min(18, Math.max(1, Math.round(w)));
  }

  // The context is read ONCE here, after every await that could have changed
  // it, so grading, the paste path and the notes all price under one league.
  const { pool, projOf, shape, engineCtx: baseCtx } = host.ctx();
  const poolById = new Map(pool.map((p) => [String(p.gsis_id), p]));
  const graded = teamsRes.teams.map((team) => {
    const cw = sleeper.crosswalkPlayerIds(team.players, pool, { index });
    const { players, missing } = gradeLeague.poolPlayersFor(cw.resolved, poolById);
    const unres = cw.unresolved.filter((u) => u.code !== 'empty_slot');
    const kdef = unres.filter((u) => u.code === 'position_not_projected'
      && (u.sleeper_position === 'K' || u.sleeper_position === 'DEF'));
    const real = unres.filter((u) => !kdef.includes(u));
    // R52 — Sleeper's OWN starters (roster payload `starters`, Sleeper ids)
    // mapped to app ids through the same crosswalk: the SUB marker's source.
    // No starters list on the payload -> null -> nothing is marked.
    const sleeperStarterIds = Array.isArray(team.starters)
      ? new Set(team.starters.map((id) => String(id))) : null;
    const sleeperStarters = sleeperStarterIds
      ? new Set(cw.resolved.filter((r) => sleeperStarterIds.has(String(r.sleeper_id)))
        .map((r) => String(r.player_id)))
      : null;
    return {
      team,
      // EVERY resolved player — starters AND bench — is what the weekly
      // optimizer seats from (R48). gradeTeam's season-optimal lineup keeps
      // the honest bench count for the card.
      players,
      sleeperStarters,
      grade: gradeTeam(players, projOf, shape),
      unmatched: [
        ...real.map((u) => `${u.sleeper_name || u.sleeper_id} (${u.code})`),
        ...missing.map((n) => `${n} (matched id not in pool)`),
      ],
      // R43: with a saved league that scores K/DEF, those ids resolve into the
      // pool and this list is empty. It fills only when the league profile is
      // missing or prices no K/DEF stat — say the cause, not "separate contract".
      note: kdef.length
        ? `${kdef.length} K/DEF not graded — your saved league profile fields or `
          + 'prices no K/DEF. Import and save your league on the TEAM tab, then reload.' : '',
    };
  });

  const { weeks, unscheduledWeeks, problems } =
    gradeLeague.buildWeeks(matchupWeeks, teamsRes.teams.map((t) => t.roster_id),
      meta.lastScoredLeg);
  // R48 — WEEKLY OPTIMAL LINEUPS from the FULL roster, derived exactly as the
  // LINEUP view derives a week (app/grade-weekly.js), then the season sim on
  // each week's OWN mean. The bench is substituted every week, automatically.
  const engineCtx = { ...baseCtx, byeByTeam, currentWk };
  const table = gradeWeekly.seasonTable(
    graded.map((g) => ({ name: g.team.label, players: g.players })), weeks, engineCtx,
  );
  const season = gradeWeekly.simulateSeasonWeekly(
    graded.map((g) => ({ name: g.team.label })), weeks, table.map((t) => t.totals),
    { playoffSlots: meta.playoffTeams || null },
  );
  // The week-by-week table prices each matchup on THAT week's means, so it
  // cannot disagree with the season sim about what a matchup is worth.
  const wkTable = weeks.map((wk, wi) => weeklyWinTable(
    graded.map((g, ti) => ({ name: g.team.label, weeklyMean: table[ti].totals[wi] })), [wk],
  )[0]);
  const totals = table.map((t) => t.seasonTotal);
  // R49 — the SCENARIO candidate for each team's season-optimal starters
  // (null on data that carries no candidate fields).
  // In candidate mode OURS already is the scenario: the GATED sum sits beside
  // it instead (nothing is shown twice).
  const scenarioByTeam = graded.map((g) => scenarioTeamSum(
    g.players, g.grade.starters, sleeperProj, engineCtx.weeklyById,
    shipped.mode === 'candidate' ? 'gated' : 'scenario',
  ));

  const notes = [];
  if (!isDefaultProfile(loadProfile())) {
    notes.push(`League settings saved: "${meta.name}" scoring and roster shape apply on every `
      + 'tab this session (RESET ALL on TEAM clears them).');
  }
  notes.push(`Real schedule from Sleeper: weeks 1–${endWeek}`
    + (meta.playoffWeekStart ? '' : ' (playoff start missing on Sleeper — 14 assumed)')
    + `; playoffs ${meta.playoffTeams || '?'} team(s).`);
  if (meta.lastScoredLeg) {
    notes.push(`Weeks 1–${meta.lastScoredLeg} are locked as REAL results; only later `
      + 'weeks are simulated.');
  } else {
    notes.push('No week has been scored yet — the whole season is simulated on the '
      + 'real matchups.');
  }
  if (unscheduledWeeks.length) {
    notes.push(`Sleeper has not published matchups for week(s) `
      + `${unscheduledWeeks.join(', ')} — those weeks fall back to random pairings.`);
  }
  notes.push('Weekly lineups: each week seats the best legal lineup from the FULL roster '
    + '(starters and bench), so a bench player covers a bye or an unavailable starter; an '
    + 'unfillable slot is EMPTY and adds nothing. Weekly sd = max(22% of that week\'s mean, '
    + '12) — a documented prior, not a fit.');
  notes.push('SUB marks a seated player whom Sleeper lists on the bench in its CURRENT '
    + 'roster (the starters list Sleeper published at load time — it does not know past or '
    + 'future weeks). The season-optimal starters fold is one fixed lineup for the whole '
    + 'season; the standings never use its sum.');
  if (engineCtx.feeds && engineCtx.feeds.length) {
    notes.push('K/DEF have no weekly split in their projection feed, so each week is the '
      + 'season projection spread evenly across games (season ÷ 17), zeroed on the team\'s '
      + 'bye from the NFL schedule.');
  }
  if (!engineCtx.hasK) notes.push("This league fields no K slot, so no kicker is graded.");
  notes.push("AI = our projections; AI+ = priced under your league's scoring table; self-learning signals are at weight 0 until they clear never-regress, so they move nothing here yet."
    + ' No market input anywhere. Every number is an ESTIMATE.');
  notes.push("Sleeper's numbers are Sleeper's own projections priced under this league's "
    + 'scoring — shown for comparison, never an input. They appear once the daily Sleeper '
    + 'projection file exists; a player Sleeper does not project adds nothing and the cell '
    + 'reads n/N projected. SLEEPER PF in the standings is Sleeper\'s points for OUR weekly '
    + 'optimal starters over the regular season.');
  if (shipped.mode === 'candidate') {
    notes.push('OURS is the SCENARIO candidate (every raw signal applied at full strength) '
      + 'shipped by owner override of the gate'
      + (shipped.decidedUtc ? ` (decided ${String(shipped.decidedUtc).slice(0, 10)})` : '')
      + '. GATED is the number the gate would have shipped for the same starters, priced '
      + 'as OURS × (gated ÷ shipped) per player — a proportional assumption, marked ≈ when '
      + 'league-rule extras are in play. The gate keeps scoring GATED vs SCENARIO on '
      + 'resolved weeks.');
  } else if (scenarioByTeam.some(Boolean)) {
    notes.push('SCENARIO is the self-learning candidate (every raw signal applied at full '
      + 'strength, backtested, NOT adopted) for the same starters, priced as OURS × '
      + '(candidate ÷ shipped) per player — a proportional assumption, marked ≈ when '
      + 'league-rule extras are in play. It moves the shipped number only after it clears '
      + 'never-regress.');
  }
  problems.forEach((p) => notes.push(p));

  const painted = paint(
    `<div class="gr-note">“${esc(meta.name)}” loaded: ${graded.length} teams, `
    + `${notes.length} note(s) below.</div>`
    + graded.map((g, i) => leagueTeamCard(
      { name: g.team.label, unmatched: g.unmatched, note: g.note },
      {
        seasonTotal: totals[i],
        pctile: percentile(totals[i], totals),
        bench: g.grade.bench,
        grade: g.grade,
        sim: season.teams[i],
        weeks: table[i].weeks,
        weekCount: weeks.length,
        teamIndex: i,
        mode: shipped.mode,
        scenario: shipped.mode === 'candidate' ? null : scenarioByTeam[i],
        gated: shipped.mode === 'candidate' ? scenarioByTeam[i] : null,
        sleeperStarters: g.sleeperStarters,
      },
    )).join('')
    // R48b — the cards carry the detail; the week-by-week table and the
    // method notes are one tap away; the standings are the LAST thing on the
    // page (owner's spec) and never buried under either.
    + `<details class="gr-fold"><summary>Week by week · every matchup, ${weeks.length} weeks</summary>`
    + weeklyTableHtml(wkTable) + '</details>'
    + `<details class="gr-fold"><summary>How this is computed · ${notes.length} note(s)</summary>`
    + `<div class="gr-assumptions">${notes.map((n) => `<div class="gr-note">${esc(n)}</div>`).join('')}</div></details>`
    + standingsHtml(season),
  );
  if (!painted) return;

  // R49 — Sleeper's estimate lands AFTER the league has painted (idle), and
  // repaints only its own cells. A later LOAD replaces `out`'s content; the
  // token makes a stale fill a no-op instead of a mismatched one.
  const token = {};
  out._r49 = token;
  const fill = () => sleeperProj.getSleeperProjections().then((doc) => {
    if (out._r49 !== token || host.stale()) return;
    const idx = sleeperProj.shapeSleeper(doc, loadProfile());
    if (!idx.ok) return; // no file yet (404) — nothing Sleeper-related renders
    fillSleeperCells(out, sleeperProj, idx, graded.map((g, i) => ({
      ours: g.grade.total, starters: g.grade.starters, weeks: table[i].weeks,
    })));
  }).catch(() => { /* display-only: a failure paints nothing */ });
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fill, { timeout: 2000 });
  else setTimeout(fill, 400);
}

/* ------------------------------------------------------- league context */

/**
 * R52 — everything this view derives from the saved league profile, in one
 * place, so a LOAD that changes the profile re-derives it IN PLACE instead of
 * remounting. Pure given its inputs (the docs are passed in, never fetched):
 *
 *   profile     loadProfile() — the saved league (or the default);
 *   offencePool projections.players;
 *   weeklyRaw   Map<id, player_weekly row> BEFORE league stamping;
 *   kdstDoc     getKdstProjections() result, or null when the league fields
 *               no K/DEF (the mount fetches it lazily, once, and reuses it);
 *   scoring     loadScoringMode() — passed in so the same inputs give the
 *               same context wherever it is called.
 *
 * Returns { shape, starterTokens, weeklyById, kdstIndex, kdstRows, kdstNote,
 *           pool, feeds, hasK, scoring, projOf, engineCtx }.
 */
export function deriveLeagueContext(profile, { offencePool, weeklyRaw, kdstDoc, scoring }) {
  const offence = Array.isArray(offencePool) ? offencePool : [];
  const mode = scoring || 'ppr';
  /* R43 — the CONNECTED LEAGUE decides the lineup shape, and when it fields
   * K/DEF/DST those positions join the pool as contract rows whose numbers
   * app/kdst.js has already recomputed under the league's OWN scoring table.
   * No saved league -> DEFAULT shape, offence-only pool, exactly as before. */
  // R44 — the SAME league-extras stamping every other surface applies (R29's
  // one-place rule; GRADE was the one view missing it, so a pass_cmp league
  // graded its quarterbacks light). Since R44 this carries the FULL component
  // delta: 6-pt passing TDs, interceptions, 2-pt, fumbles, yardage bonuses.
  const weeklyById = withLeagueExtras(weeklyRaw, profile);
  const starterTokens = ((profile && profile.shape && profile.shape.roster_positions) || [])
    .filter((t) => String(t).toUpperCase() !== 'BN');
  const shape = shapeFromRoster(starterTokens);
  const kdstSeatTokens = rosterPositionsInPlay(profile).filter(isKdstPosition);
  const kdstRows = [];
  let kdstNote = '';
  // R48 — the shaped index outlives this block: the weekly engine prices K/DEF
  // rows from it (never from an offence conversion) and `feeds` tells the
  // optimizer which slots it may fill. No kdst seat -> an empty index, no feed.
  let kdstIndex = shapeKdst(null, profile);
  if (kdstSeatTokens.length) {
    kdstIndex = shapeKdst(kdstDoc, profile);
    const usedCanon = new Set();
    for (const token of kdstSeatTokens) {
      const canon = canonKdstPosition(token);
      if (usedCanon.has(canon)) continue;
      usedCanon.add(canon);
      for (const e of kdstIndex.byPosition[canon] || []) {
        // An UNSCORED row cannot be valued under this league's table — no
        // honest number, no seat (same refusal the TEAM page makes).
        if (e.unscored) continue;
        kdstRows.push({
          gsis_id: e.id, name: e.name, team: e.team,
          position: canon, proj_points: e.seasonPoints, kdst: e,
        });
      }
    }
    if (!kdstRows.length) {
      kdstNote = kdstIndex.ok || kdstIndex.unscoredPositions.length
        ? 'Your league fields K/DEF but its scoring table prices none of their stats, '
          + 'so those slots grade as EMPTY rather than with an invented number.'
        : 'Your league fields K/DEF but the K/DEF projection feed did not load, so '
          + 'those slots grade as EMPTY this visit.';
    } else if (kdstIndex.unscoredPositions.length) {
      kdstNote = `${kdstIndex.unscoredPositions.join('/')} rows exist but your scoring `
        + 'prices none of their stats — that position grades EMPTY, never invented.';
    }
  }
  const pool = kdstRows.length ? offence.concat(kdstRows) : offence;
  // R48 — what the weekly engine needs beyond the roster: the league profile,
  // the league-stamped weekly map, the kdst index and its fed positions, the
  // scoring mode, and whether this league fields a K at all (R48-D note).
  const feeds = fedPositions(kdstIndex);
  const hasK = starterTokens.some((t) => canonKdstPosition(t) === 'K');
  const engineCtx = { profile, weeklyById, kdstIndex, feeds, scoring: mode, hasK };
  // ONE scoring conversion app-wide: the same projSeason PLAYERS ranks with —
  // except a K/DEF contract row, whose number is ALREADY the league's own
  // (app/kdst.js applyScoring) and must not ride the offence conversion.
  const projOf = (p) => (p.kdst
    ? (Number(p.proj_points) || 0)
    : projSeason(p, weeklyById.get(String(p.gsis_id)), mode));
  return {
    shape, starterTokens, weeklyById, kdstIndex, kdstRows, kdstNote, pool, feeds, hasK,
    scoring: mode, projOf, engineCtx,
  };
}

/** True when `profile` seats a K/DEF/DST — the only case the kdst doc is read. */
function needsKdstDoc(profile) {
  return rosterPositionsInPlay(profile).some(isKdstPosition);
}

/** The paste box's "assumptions, out loud" line for the CURRENT context. */
function assumptionsHtml(ctx) {
  return 'Assumptions, out loud: lineup shape '
    + `${esc(Object.entries(ctx.shape).map(([k, v]) => `${k}×${v}`).join(' '))} `
    + (ctx.starterTokens.length
      ? '(from your saved league'
        + (ctx.kdstRows.length ? '; K/DEF graded under your league\'s own scoring table). '
          : '). ')
      : '(no league saved — the default shape; connect your league on TEAM to grade '
        + 'your real slots, K/DEF included). ')
    + (ctx.kdstNote ? `${esc(ctx.kdstNote)} ` : '')
    + 'Single team is ranked against a synthetic '
    + 'snake-draft field built from OUR ranking; 4+ teams runs a 2,000-season Monte '
    + 'Carlo with weekly sd = max(22% of mean, 12) — a documented prior, not a fit. '
    + 'The paste path has no schedule, so its weekly pairings are RANDOM; the Sleeper '
    + 'loader above uses your real one. Every number here is an ESTIMATE.';
}

/* ----------------------------------------------------------------- mount */

// R52 — the mount sequence. Every mountGrade() bumps it; a mount whose number
// is no longer current (or whose element left the DOM) writes nothing more.
let mountSeq = 0;

export default async function mountGrade(el) {
  const seq = ++mountSeq;
  const gone = () => seq !== mountSeq || !el.isConnected;
  el.innerHTML = '<div class="state state--loading">Loading grade engine…</div>';
  const [projRes, weeklyRes] = await Promise.allSettled([
    getPlayerProjections(), getPlayerWeekly(),
  ]);
  if (gone()) { console.debug('grade: superseded mount dropped'); return; }
  if (projRes.status !== 'fulfilled') {
    el.innerHTML = '<div class="state">Grades unavailable — the projection feed did not load.</div>';
    return;
  }
  const offencePool = projRes.value.players || [];
  const weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
  const weeklyRaw = new Map(((weekly && weekly.players) || []).map((p) => [String(p.gsis_id), p]));

  // The K/DEF doc is read at most once per mount and only for a league that
  // seats K/DEF; a sync that adds those seats reads it then, never twice.
  let kdstDocPromise = null;
  const kdstDocFor = (profile) => {
    if (!needsKdstDoc(profile)) return Promise.resolve(null);
    if (!kdstDocPromise) kdstDocPromise = getKdstProjections().catch(() => null);
    return kdstDocPromise;
  };
  const derive = async () => {
    const profile = loadProfile();
    const kdstDoc = await kdstDocFor(profile);
    return deriveLeagueContext(profile, {
      offencePool, weeklyRaw, kdstDoc, scoring: loadScoringMode(),
    });
  };
  let ctx = await derive();
  if (gone()) { console.debug('grade: superseded mount dropped'); return; }

  el.innerHTML =
    '<section class="card">'
    + '<h2>MY SLEEPER LEAGUE <span class="ms-badge">ESTIMATE</span></h2>'
    + '<p class="m-explain">Paste your league id or URL and LOAD reads every team, the '
    + 'REAL weekly schedule and results-so-far from Sleeper. Played weeks are locked as '
    + 'facts; future weeks are simulated on the actual matchups with each team\'s best '
    + 'lineup from its FULL roster (the bench covers byes and injuries) — week-by-week '
    + 'win%, playoff and title odds, and the projected final standings with points for '
    + 'and against. Grades come from OUR projections in your active scoring mode; no '
    + 'market input.</p>'
    + '<div class="gr-league-row">'
    + '<input id="gr-league-id" class="gr-input gr-input--id" type="text" '
    + 'placeholder="Sleeper league id or URL" autocomplete="off">'
    + '<button type="button" id="gr-load" class="btn">LOAD LEAGUE</button>'
    + '</div>'
    + '<div id="gr-league-out"></div>'
    + '</section>'
    + '<section class="card">'
    + '<h2>PASTE ANY TEAMS <span class="ms-badge">ESTIMATE</span></h2>'
    + '<p class="m-explain">Or paste your team — or every team in any league — in any '
    + 'shape: copied site text, typed names, JSON, HTML. Separate teams with a blank '
    + 'line; a first line that is not a player becomes that team\'s name.</p>'
    + '<textarea id="gr-input" class="gr-input" rows="10" '
    + 'placeholder="My Team:\nJosh Allen\nBijan Robinson\n…\n\nRival Team:\n…"></textarea>'
    + '<button type="button" id="gr-go" class="btn">PARSE &amp; GRADE</button>'
    + '<div id="gr-out"></div>'
    + `<div id="gr-assume" class="gr-assumptions">${assumptionsHtml(ctx)}</div>`
    + '</section>';

  const leagueOut = el.querySelector('#gr-league-out');
  const loadBtn = el.querySelector('#gr-load');
  // R52 — one LOAD at a time per mount: a newer press supersedes an older one
  // (the older writes nothing more), and the button rests while one runs.
  let loadSeq = 0;
  const host = {
    ctx: () => ctx,
    rederive: async () => {
      ctx = await derive();
      const assume = el.querySelector('#gr-assume');
      if (assume && !gone()) assume.innerHTML = assumptionsHtml(ctx);
      return ctx;
    },
  };
  const runLoad = (idText) => {
    const mine = ++loadSeq;
    const stale = () => gone() || mine !== loadSeq || !leagueOut.isConnected;
    loadBtn.disabled = true;
    loadSleeperLeague(idText, leagueOut, { ...host, stale }).catch((err) => {
      if (stale()) return;
      leagueOut.innerHTML = `<div class="state">League load failed: ${esc(err && err.message)}</div>`;
    }).finally(() => {
      if (mine === loadSeq && !gone()) loadBtn.disabled = false;
    });
  };
  loadBtn.addEventListener('click', () => {
    const idText = el.querySelector('#gr-league-id').value.trim();
    if (!idText) {
      leagueOut.innerHTML = '<div class="state">Paste your Sleeper league id or URL first.</div>';
      return;
    }
    runLoad(idText);
  });
  // R47 — the remembered league prefills the box.
  const remembered = loadLeagueId();
  if (remembered) el.querySelector('#gr-league-id').value = remembered;

  const out = el.querySelector('#gr-out');
  el.querySelector('#gr-go').addEventListener('click', () => {
    const text = el.querySelector('#gr-input').value;
    if (!text.trim()) {
      out.innerHTML = '<div class="state">Nothing pasted yet.</div>';
      return;
    }
    // The paste grader prices under the CURRENT context — after a league
    // sync that is the league's shape, pool and scoring, not the mount's.
    const { pool, projOf, shape } = ctx;
    const league = buildLeague(text, pool);
    if (!league.teams.length) {
      out.innerHTML = '<div class="state">No teams found in that text — nothing matched '
        + 'the player pool and no team blocks were detected.</div>';
      return;
    }
    const graded = league.teams.map((t) => ({ t, grade: gradeTeam(t.players, projOf, shape) }));
    const totals = graded.map((g) => g.grade.total);
    const field = graded.length >= 4
      ? totals
      : syntheticFieldTotals(pool, projOf, 10, null, shape);
    const sims = graded.length >= 4
      ? simulateLeague(graded.map((g) => ({
        name: g.t.name,
        weeklyMean: g.grade.total / 17,
      })))
      : null;
    out.innerHTML = graded.map((g, i) => teamCard(
      g.t, g.grade, percentile(g.grade.total, field), sims ? sims[i] : null,
    )).join('')
    + (graded.length >= 4
      ? ''
      : '<div class="gr-note">Paste 4+ teams (blank-line separated) to unlock '
        + 'playoff% and title% for your whole league.</div>');
    // The MY-ROSTER convenience: note when a pasted team matches the TEAM tab.
    const mine = myRosterIds();
    if (mine.size) {
      const yours = graded.find((g) => g.t.players.some((p) => mine.has(String(p.gsis_id))));
      if (yours) out.insertAdjacentHTML('afterbegin',
        `<div class="gr-note">“${esc(yours.t.name)}” overlaps your TEAM-tab roster.</div>`);
    }
  });
}
