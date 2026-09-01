/* app/views/grade.js — TEAM GRADE. Paste your team — or your whole league —
 * as anything (site copy, typed names, JSON, HTML) and get an honest grade
 * from OUR projections, plus playoff/title odds when a full league is pasted.
 *
 * Honesty surface (every rule enforced in app/grade.js, tested in the gate):
 *   - unmatched lines are LISTED, never guessed into a player;
 *   - one team  -> grade + percentile vs a synthetic snake-draft field built
 *     from OUR ranking (no ADP, no market);
 *   - 4+ teams -> Monte Carlo season with a DOCUMENTED variance prior and a
 *     stated random-schedule assumption. ESTIMATE, everywhere, out loud.
 *   - K/DEF lines match but are not graded (separate contract; said on card).
 */

import { getPlayerProjections, getPlayerWeekly } from '../data.js';
import { projSeason, myRosterIds } from './players.js';
import { loadScoringMode } from '../team-logic.js';
import {
  buildLeague, gradeTeam, percentile, letterFor, syntheticFieldTotals,
  simulateLeague, DEFAULT_SHAPE,
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
    + simRow + starters + un
    + '</article>'
  );
}

export default async function mountGrade(el) {
  el.innerHTML = '<div class="state state--loading">Loading grade engine…</div>';
  const [projRes, weeklyRes] = await Promise.allSettled([
    getPlayerProjections(), getPlayerWeekly(),
  ]);
  if (projRes.status !== 'fulfilled') {
    el.innerHTML = '<div class="state">Grades unavailable — the projection feed did not load.</div>';
    return;
  }
  const pool = projRes.value.players || [];
  const weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
  const weeklyById = new Map(((weekly && weekly.players) || []).map((p) => [String(p.gsis_id), p]));
  const scoring = loadScoringMode();
  // ONE scoring conversion app-wide: the same projSeason PLAYERS ranks with.
  const projOf = (p) => projSeason(p, weeklyById.get(String(p.gsis_id)), scoring);

  el.innerHTML =
    '<section class="card">'
    + '<h2>TEAM GRADE <span class="ms-badge">ESTIMATE</span></h2>'
    + '<p class="m-explain">Paste your team — or every team in your league — in any '
    + 'shape: copied site text, typed names, JSON, HTML. Separate teams with a blank '
    + 'line; a first line that is not a player becomes that team\'s name. Grades come '
    + 'from OUR projections in your active scoring mode; no market input.</p>'
    + '<textarea id="gr-input" class="gr-input" rows="10" '
    + 'placeholder="My Team:\nJosh Allen\nBijan Robinson\n…\n\nRival Team:\n…"></textarea>'
    + '<button type="button" id="gr-go" class="btn">PARSE &amp; GRADE</button>'
    + '<div id="gr-out"></div>'
    + '<div class="gr-assumptions">Assumptions, out loud: lineup shape '
    + `${esc(Object.entries(DEFAULT_SHAPE).map(([k, v]) => `${k}×${v}`).join(' '))} `
    + '(K/DEF excluded — separate contract); single team is ranked against a synthetic '
    + 'snake-draft field built from OUR ranking; 4+ teams runs a 2,000-season Monte '
    + 'Carlo with weekly sd = max(22% of mean, 12) — a documented prior, not a fit — '
    + 'and a RANDOM weekly schedule because your league\'s real schedule is not pasted. '
    + 'Every number here is an ESTIMATE.</div>'
    + '</section>';

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
    const graded = league.teams.map((t) => ({ t, grade: gradeTeam(t.players, projOf) }));
    const totals = graded.map((g) => g.grade.total);
    const field = graded.length >= 4
      ? totals
      : syntheticFieldTotals(pool, projOf);
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
