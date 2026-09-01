/* app/views/grade.js — TEAM GRADE. Two ways in, one honest engine:
 *   1. SLEEPER LEAGUE (R42): paste your league id/URL and one LOAD press
 *      reads teams, rosters, the REAL weekly schedule and results-so-far.
 *      Completed weeks are locked as facts; future weeks are simulated on
 *      the actual matchups -> week-by-week win% + playoff/title odds
 *      conditioned on the real schedule and record.
 *   2. PASTE anything (site copy, typed names, JSON, HTML) — the R41 path,
 *      kept whole as the fallback for any league anywhere.
 *
 * Honesty surface (rules enforced in app/grade.js + app/grade-league.js):
 *   - unmatched lines/players are LISTED, never guessed;
 *   - a pre-draft league is a stated state (Sleeper publishes rosters and
 *     the schedule only after the draft), not a blank screen;
 *   - a week Sleeper has not published falls back to random pairing AND
 *     says so; a played game shows its RESULT, never a probability;
 *   - K/DEF match but are not graded (separate contract; said on card).
 *   - ESTIMATE, everywhere, out loud. No market input anywhere.
 */

import { getPlayerProjections, getPlayerWeekly } from '../data.js';
import { projSeason, myRosterIds } from './players.js';
import { loadScoringMode, withLeagueExtras, SCORING_KEY } from '../team-logic.js';
import { scoringMode } from '../league.js';
import {
  loadProfile, rosterPositionsInPlay, saveProfile, saveLeagueId, loadLeagueId,
  isDefaultProfile, normalizeProfile,
} from '../league.js';
import {
  getKdstProjections, shapeKdst, isKdstPosition, canonKdstPosition,
} from '../kdst.js';
import {
  buildLeague, gradeTeam, percentile, letterFor, syntheticFieldTotals,
  simulateLeague, simulateLeagueScheduled, weeklyWinTable, shapeFromRoster,
} from '../grade.js';

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
      ? '<span class="gr-empty">EMPTY — no eligible player pasted (0.0)</span>'
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

/* --------------------------------------------------------------- Sleeper */

/* R47 — a LOAD on this tab is a league sync for the WHOLE session: the
 * league's settings are saved (profile + scoring lock + league id) exactly
 * as TEAM's SYNC NOW saves them, then this view remounts so its shape, pool
 * and pricing are the league's before grading. `pendingAutoload` carries the
 * LOAD across that remount so the user presses nothing twice. */
let pendingAutoload = false;

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

async function loadSleeperLeague(idText, pool, projOf, shape, out, remount) {
  out.innerHTML = '<div class="state state--loading">Reading your league from Sleeper — '
    + 'rosters, schedule and its player list (several MB)…</div>';
  // Lazy on purpose: none of this rides the paste path or the boot path.
  const [sleeper, gradeLeague, draftLive] = await Promise.all([
    import('../sleeper.js'), import('../grade-league.js'), import('../draft-live.js'),
  ]);
  const leagueRes = await sleeper.fetchSleeperLeague(idText);
  if (!leagueRes.ok) {
    out.innerHTML = `<div class="state">${esc(leagueRes.error.message)}</div>`;
    return;
  }
  const meta = gradeLeague.leagueMeta(leagueRes.payload);
  // R47 — save the league for every tab FIRST (pre-draft leagues carry their
  // settings already); if the saved profile changed, remount so this view's
  // shape/pool/pricing are the league's, then continue the load automatically.
  const synced = await syncLeagueSettings(sleeper, idText);
  if (synced.changed && typeof remount === 'function') {
    pendingAutoload = true;
    remount();
    return;
  }
  if (meta.preDraft) {
    out.innerHTML = `<div class="state">“${esc(meta.name)}” is ${esc(meta.status)} on Sleeper. `
      + 'Rosters and the weekly schedule appear once your draft has run — load again after '
      + 'it. Until then, the paste box below grades any lineup you give it.</div>';
    return;
  }
  const teamsRes = await sleeper.importSleeperTeams(idText);
  if (!teamsRes.ok || !teamsRes.teams.length) {
    out.innerHTML = `<div class="state">${esc((teamsRes.error && teamsRes.error.message)
      || 'Sleeper returned no teams for that league.')}</div>`;
    return;
  }
  const dumpRes = await draftLive.getJson(
    draftLive.PLAYER_INDEX_URL, undefined, draftLive.INDEX_TIMEOUT_MS,
  );
  if (!dumpRes.ok) {
    out.innerHTML = '<div class="state">Sleeper\'s player list did not load '
      + `(${esc(dumpRes.error)}), so rosters cannot be matched to our projections. `
      + 'Try again, or use the paste box below.</div>';
    return;
  }
  const index = sleeper.buildSleeperPlayerIndex(dumpRes.payload).index;

  const endWeek = (meta.playoffWeekStart || 14) - 1;
  const weekNums = Array.from({ length: endWeek }, (_, i) => i + 1);
  const matchupWeeks = await Promise.all(weekNums.map(async (wk) => {
    const res = await sleeper.fetchSleeperMatchups(idText, wk);
    const mapped = res.ok ? sleeper.mapMatchups(res.payload, wk) : { matchups: [] };
    return { week: wk, matchups: mapped.matchups };
  }));

  const poolById = new Map(pool.map((p) => [String(p.gsis_id), p]));
  const graded = teamsRes.teams.map((team) => {
    const cw = sleeper.crosswalkPlayerIds(team.players, pool, { index });
    const { players, missing } = gradeLeague.poolPlayersFor(cw.resolved, poolById);
    const unres = cw.unresolved.filter((u) => u.code !== 'empty_slot');
    const kdef = unres.filter((u) => u.code === 'position_not_projected'
      && (u.sleeper_position === 'K' || u.sleeper_position === 'DEF'));
    const real = unres.filter((u) => !kdef.includes(u));
    return {
      team,
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
  const simTeams = graded.map((g) => ({
    name: g.team.label, weeklyMean: g.grade.total / 17,
  }));
  const sims = simulateLeagueScheduled(simTeams, weeks, {
    playoffSlots: meta.playoffTeams || null,
  });
  const table = weeklyWinTable(simTeams, weeks);
  const totals = graded.map((g) => g.grade.total);

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
  problems.forEach((p) => notes.push(p));

  out.innerHTML =
    `<div class="gr-note">“${esc(meta.name)}” loaded: ${graded.length} teams, `
    + `${notes.length} note(s) below.</div>`
    + graded.map((g, i) => teamCard(
      { name: g.team.label, unmatched: g.unmatched, note: g.note },
      g.grade, percentile(g.grade.total, totals), sims[i],
    )).join('')
    + weeklyTableHtml(table)
    + `<div class="gr-assumptions">${notes.map((n) => esc(n)).join(' ')}</div>`;
}

/* ----------------------------------------------------------------- mount */

export default async function mountGrade(el) {
  el.innerHTML = '<div class="state state--loading">Loading grade engine…</div>';
  const [projRes, weeklyRes] = await Promise.allSettled([
    getPlayerProjections(), getPlayerWeekly(),
  ]);
  if (projRes.status !== 'fulfilled') {
    el.innerHTML = '<div class="state">Grades unavailable — the projection feed did not load.</div>';
    return;
  }
  const offencePool = projRes.value.players || [];
  const weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
  const weeklyRaw = new Map(((weekly && weekly.players) || []).map((p) => [String(p.gsis_id), p]));
  const scoring = loadScoringMode();

  /* R43 — the CONNECTED LEAGUE decides the lineup shape, and when it fields
   * K/DEF/DST those positions join the pool as contract rows whose numbers
   * app/kdst.js has already recomputed under the league's OWN scoring table.
   * No saved league -> DEFAULT shape, offence-only pool, exactly as before. */
  const profile = loadProfile();
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
  if (kdstSeatTokens.length) {
    let kdstDoc = null;
    try { kdstDoc = await getKdstProjections(); } catch (err) { kdstDoc = null; }
    const kdstIndex = shapeKdst(kdstDoc, profile);
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
  const pool = kdstRows.length ? offencePool.concat(kdstRows) : offencePool;

  // ONE scoring conversion app-wide: the same projSeason PLAYERS ranks with —
  // except a K/DEF contract row, whose number is ALREADY the league's own
  // (app/kdst.js applyScoring) and must not ride the offence conversion.
  const projOf = (p) => (p.kdst
    ? (Number(p.proj_points) || 0)
    : projSeason(p, weeklyById.get(String(p.gsis_id)), scoring));

  el.innerHTML =
    '<section class="card">'
    + '<h2>MY SLEEPER LEAGUE <span class="ms-badge">ESTIMATE</span></h2>'
    + '<p class="m-explain">Paste your league id or URL and LOAD reads every team, the '
    + 'REAL weekly schedule and results-so-far from Sleeper. Played weeks are locked as '
    + 'facts; future weeks are simulated on the actual matchups — week-by-week win% plus '
    + 'playoff and title odds that move as real results land. Grades come from OUR '
    + 'projections in your active scoring mode; no market input.</p>'
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
    + '<div class="gr-assumptions">Assumptions, out loud: lineup shape '
    + `${esc(Object.entries(shape).map(([k, v]) => `${k}×${v}`).join(' '))} `
    + (starterTokens.length
      ? '(from your saved league'
        + (kdstRows.length ? '; K/DEF graded under your league\'s own scoring table). '
          : '). ')
      : '(no league saved — the default shape; connect your league on TEAM to grade '
        + 'your real slots, K/DEF included). ')
    + (kdstNote ? `${esc(kdstNote)} ` : '')
    + 'Single team is ranked against a synthetic '
    + 'snake-draft field built from OUR ranking; 4+ teams runs a 2,000-season Monte '
    + 'Carlo with weekly sd = max(22% of mean, 12) — a documented prior, not a fit. '
    + 'The paste path has no schedule, so its weekly pairings are RANDOM; the Sleeper '
    + 'loader above uses your real one. Every number here is an ESTIMATE.</div>'
    + '</section>';

  const leagueOut = el.querySelector('#gr-league-out');
  el.querySelector('#gr-load').addEventListener('click', () => {
    const idText = el.querySelector('#gr-league-id').value.trim();
    if (!idText) {
      leagueOut.innerHTML = '<div class="state">Paste your Sleeper league id or URL first.</div>';
      return;
    }
    loadSleeperLeague(idText, pool, projOf, shape, leagueOut, () => mountGrade(el)).catch((err) => {
      leagueOut.innerHTML = `<div class="state">League load failed: ${esc(err && err.message)}</div>`;
    });
  });
  // R47 — the remembered league prefills the box; after a settings sync the
  // load continues on its own.
  const remembered = loadLeagueId();
  if (remembered) {
    el.querySelector('#gr-league-id').value = remembered;
    if (pendingAutoload) {
      pendingAutoload = false;
      loadSleeperLeague(remembered, pool, projOf, shape, leagueOut, () => mountGrade(el))
        .catch((err) => {
          leagueOut.innerHTML = `<div class="state">League load failed: ${esc(err && err.message)}</div>`;
        });
    }
  }

  const out = el.querySelector('#gr-out');
  el.querySelector('#gr-go').addEventListener('click', () => {
    const text = el.querySelector('#gr-input').value;
    if (!text.trim()) {
      out.innerHTML = '<div class="state">Nothing pasted yet.</div>';
      return;
    }
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
