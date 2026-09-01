/* app/grade-weekly.js — R48-C: WEEKLY-OPTIMAL season engine for the GRADE
 * tab's Sleeper league loader. Pure module: no DOM, no fetch, no clock.
 *
 * Owner's spec, verbatim intent: "the bench should be substituted and used to
 * maximize the points for each team throughout all the matchups and the last
 * thing it should show is the final likely standings with estimated points
 * for and against and who will win regular season and the playoffs."
 *
 * Three jobs:
 *   1. teamWeekPoints — ONE team, ONE week: build the [{id,pos,pts,onBye,
 *      playable}] rows for the FULL roster (starters + bench) exactly the way
 *      the LINEUP view (app/views/lineup.js playerRow) derives them, then
 *      seat the best legal lineup with app/lineup.js bestLineup. A bench
 *      player covers a starter's bye or injury automatically because the
 *      optimizer sees the whole roster, not Sleeper's starters list.
 *   2. seasonTable — every team, every regular-season week, reusing (1).
 *   3. simulateSeasonWeekly — Monte Carlo on the league's REAL schedule with
 *      each week's OWN projected mean (a bye week is a low week, not season/17),
 *      locked FINAL games counted as facts, unscheduled weeks paired at random
 *      exactly as app/grade.js simulateLeagueScheduled does, and the same
 *      seeded playoff bracket (6 slots -> two byes). Reports wins, losses,
 *      points for/against, playoff odds, best-record odds and title odds.
 *
 * Honesty rules (owner policy, enforced here):
 *   - absent is never 0: a slot nobody can fill is EMPTY and adds nothing;
 *     a player with no projection for the week is listed in `noProjection`,
 *     never priced at 0.0 as if that were a forecast;
 *   - K/DEF points come from the kdst index (the league's own scoring on the
 *     contract's stat line), never from an offence conversion of proj_points;
 *     the contract has NO weekly split, so a K/DEF week is season ÷ games and
 *     the caller must SAY so;
 *   - no market input anywhere; self-learning signals are at weight 0 and
 *     move nothing here — the view labels that;
 *   - seeded RNG (mulberry32) so the same inputs give the same season.
 */

import { bestLineup, canonPosition } from './lineup.js';
import { scoringAdjust, weeklyPoints, extraPtsOf } from './team-logic.js';
import { availabilityOf } from './availability.js';
import { mulberry32, SD_FRAC, SD_MIN } from './grade.js';

/** Positions priced by the kdst contract, never by the offence conversion. */
const KDST_POS = new Set(['K', 'DEF']);

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

/** A pool/roster record's id — the two spellings in use across data/. */
function idOf(p) {
  const v = p.gsis_id != null ? p.gsis_id : (p.player_id != null ? p.player_id : p.id);
  return String(v == null ? '' : v);
}

/**
 * One team's best legal lineup for ONE week, from its FULL roster.
 *
 *   rosterPlayers: pool records [{gsis_id, name, position, proj_points, ...}]
 *                  — starters AND bench, as crosswalked by the loader.
 *   week:          the NFL week number.
 *   profile:       the league profile (geometry + scoring); omitted -> DEFAULT.
 *   weeklyById:    Map<id, player_weekly entry> already stamped by
 *                  withLeagueExtras(profile) — the caller's job, one place.
 *   kdstIndex:     shapeKdst(doc, profile) — K/DEF rows priced under the league.
 *   feeds:         fedPositions(kdstIndex) — which slots bestLineup may fill.
 *   availability:  optional (weeklyRow, week) -> {playable}; defaults to
 *                  availabilityOf(weeklyRow, week, currentWk).
 *   scoring:       'ppr' | 'half' | 'std' (loadScoringMode()); default 'ppr'.
 *   currentWk:     the live week (an OUT designation is this-week news).
 *   byeByTeam:     Map<TEAM, byeWeek> from teamByeWeeks(schedule) — the only
 *                  bye source a K/DEF row has. Absent -> no bye claims.
 *
 * Returns { week, total, lineup, rows, byeCount, byes, unavailable,
 *           noProjection, empty }.
 */
export function teamWeekPoints({
  rosterPlayers, week, profile, weeklyById, kdstIndex, feeds, availability,
  scoring = 'ppr', currentWk = null, byeByTeam = null,
}) {
  const wk = Number(week);
  const byId = weeklyById instanceof Map ? weeklyById : new Map();
  const kdstById = kdstIndex && kdstIndex.byId instanceof Map ? kdstIndex.byId : new Map();
  const availOf = typeof availability === 'function'
    ? availability
    : (w, weekNum) => availabilityOf(w, weekNum, currentWk);

  const rows = [];
  const byes = [];
  const unavailable = [];
  const noProjection = [];

  for (const p of (Array.isArray(rosterPlayers) ? rosterPlayers : [])) {
    if (!p) continue;
    const id = idOf(p);
    if (!id) continue;
    const pos = canonPosition(p.position != null ? p.position : p.pos);

    if (KDST_POS.has(pos)) {
      // The kdst index is the ONLY price for a K/DEF row. proj_points on the
      // pool record is the same number for display, but it is never converted
      // here — a kicker must not ride the offence scoring path.
      const e = kdstById.get(id);
      if (!e) {
        noProjection.push(id);
        rows.push({
          id, name: p.name || id, pos, pts: 0, onBye: false, playable: true,
          projected: false, seasonAvg: false,
        });
        continue;
      }
      const bye = byeByTeam instanceof Map ? byeByTeam.get(String(e.team || '').toUpperCase()) : undefined;
      const onBye = Number.isFinite(bye) && Number(bye) === wk;
      if (onBye) byes.push(id);
      if (e.unscored) noProjection.push(id);
      rows.push({
        id, name: e.name || p.name || id, pos,
        pts: (onBye || e.unscored) ? 0 : (Number(e.weeklyPoints) || 0),
        onBye, playable: true, projected: !e.unscored,
        // FLAT PER-GAME AVERAGE (season ÷ games) — the contract has no weekly
        // split. The view says so beside every such row.
        seasonAvg: true,
      });
      continue;
    }

    // Offence: the LINEUP view's derivation, verbatim in spirit —
    // scoringAdjust(season) -> weeklyPoints(redistributed) -> this week's index,
    // byes hard 0, an unavailable player 0 for the week (never silently started).
    const w = byId.get(id) || null;
    const weeks = w && Array.isArray(w.weeks) ? w.weeks : null;
    const idx = weeks ? weeks.findIndex((x) => Number(x && x.wk) === wk) : -1;
    const entry = idx >= 0 ? weeks[idx] : null;
    const onBye = Boolean(entry && entry.bye === true);
    const av = availOf(w, wk) || {};
    const playable = av.playable !== false;
    const ppr = Number(p.proj_points);
    const adj = scoringAdjust(ppr, w ? w.receptions_prior : 0, scoring, extraPtsOf(w));
    const converted = weeklyPoints(w, adj, ppr);
    const projected = idx >= 0;
    if (!projected) noProjection.push(id);
    if (onBye) byes.push(id);
    if (!playable) unavailable.push(id);
    const pts = (onBye || !playable || !projected) ? 0 : (Number(converted[idx]) || 0);
    rows.push({ id, name: p.name || id, pos, pts, onBye, playable, projected, seasonAvg: false });
  }

  const lineup = bestLineup(
    rows.map((r) => ({ id: r.id, pos: r.pos, pts: r.pts, onBye: r.onBye, playable: r.playable })),
    profile, { feeds },
  );
  // A slot nobody could fill. It holds no one and adds nothing — EMPTY, not 0.0.
  const empty = lineup.geometry.filter((g) => !lineup.slots[g.slot]).map((g) => g.slot);

  return {
    week: wk,
    total: lineup.total,
    lineup,
    rows,
    byeCount: byes.length,
    byes,
    unavailable,
    noProjection,
    empty,
  };
}

/**
 * Every team's weekly-optimal totals over the regular season.
 *   teams: [{name, players}] — players are the pool records teamWeekPoints takes.
 *   weeks: grade-league buildWeeks().weeks — [{week, games, unscheduled}].
 *   ctx:   the teamWeekPoints inputs other than rosterPlayers/week.
 * Returns [{ name, weeks: [teamWeekPoints result], totals: number[], seasonTotal }]
 * in input order; totals[i] aligns 1:1 with weeks[i].
 */
export function seasonTable(teams, weeks, ctx) {
  const weekList = Array.isArray(weeks) ? weeks : [];
  const c = ctx || {};
  return (Array.isArray(teams) ? teams : []).map((t) => {
    const detail = weekList.map((wk) => teamWeekPoints({
      ...c, rosterPlayers: t.players, week: wk.week,
    }));
    const totals = detail.map((d) => d.total);
    return {
      name: t.name,
      weeks: detail,
      totals,
      seasonTotal: round1(totals.reduce((s, v) => s + v, 0)),
    };
  });
}

/** Box–Muller standard normal; rng() in (0,1). Mirrors app/grade.js. */
function normal(rng) {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Monte Carlo a fantasy season on the REAL schedule with WEEK-SPECIFIC means.
 *
 *   teams:        [{name}] (index = team index in `weeks`).
 *   weeks:        buildWeeks().weeks — [{week, games:[{a,b,aPts,bPts,final}],
 *                 unscheduled}].
 *   weeklyTotals: number[team][weekIndex] — seasonTable(...).map(t => t.totals).
 *                 Each week draws from ITS OWN projected mean (a bye-heavy week
 *                 is a low week), sd = max(sdFrac·mean, sdMin): the same
 *                 documented prior as simulateLeague, per week instead of per
 *                 season.
 *
 * A `final` game contributes its actual result — locked wins, losses and
 * points, nothing simulated. An `unscheduled` week pairs teams at random each
 * sim (odd team out idles), exactly as simulateLeagueScheduled. Playoffs: top
 * `playoffSlots` by wins (points tiebreak) into the same seeded bracket (6
 * slots -> seeds 1-2 bye); playoff games draw from each team's season-average
 * mean, since playoff weeks are outside the regular-season table.
 *
 * Returns { seed, sims, playoffSlots, teams: [{name, wins, losses, pf, pa,
 *   playoff, regSeasonTitle, title, avgWins}] in input order,
 *   standings: the same rows ordered by wins then pf, with rank }.
 * Every number is an ESTIMATE.
 */
export function simulateSeasonWeekly(teams, weeks, weeklyTotals, {
  sims = 2000, seed = 20260901, playoffSlots = null,
  sdFrac = SD_FRAC, sdMin = SD_MIN,
} = {}) {
  const list = Array.isArray(teams) ? teams : [];
  const n = list.length;
  const weekList = Array.isArray(weeks) ? weeks : [];
  if (n < 2) {
    const rows = list.map((t) => ({
      name: t.name, wins: null, losses: null, pf: null, pa: null,
      playoff: null, regSeasonTitle: null, title: null, avgWins: null,
    }));
    return { seed, sims, playoffSlots: null, teams: rows, standings: [] };
  }
  const slots = playoffSlots || (n >= 8 ? 6 : Math.max(2, Math.floor(n / 2)));
  const rng = mulberry32(seed);

  const means = list.map((t, i) => weekList.map((wk, w) => {
    const row = Array.isArray(weeklyTotals) ? weeklyTotals[i] : null;
    const v = Number(row && row[w]);
    return Math.max(1, Number.isFinite(v) ? v : 1);
  }));
  const sds = means.map((row) => row.map((m) => Math.max(sdFrac * m, sdMin)));
  const seasonMean = means.map((row) => (row.length
    ? Math.max(1, row.reduce((s, v) => s + v, 0) / row.length) : 1));
  const seasonSd = seasonMean.map((m) => Math.max(sdFrac * m, sdMin));
  const score = (i, w) => Math.max(0, means[i][w] + sds[i][w] * normal(rng));
  const playoffScore = (i) => Math.max(0, seasonMean[i] + seasonSd[i] * normal(rng));

  // The locked base: final games count once, outside the sim loop.
  const baseWins = new Array(n).fill(0);
  const baseLoss = new Array(n).fill(0);
  const basePf = new Array(n).fill(0);
  const basePa = new Array(n).fill(0);
  for (const wk of weekList) {
    for (const g of (wk.games || [])) {
      if (!g.final) continue;
      const ap = Number(g.aPts) || 0;
      const bp = Number(g.bPts) || 0;
      basePf[g.a] += ap; basePa[g.a] += bp;
      basePf[g.b] += bp; basePa[g.b] += ap;
      if (ap >= bp) { baseWins[g.a] += 1; baseLoss[g.b] += 1; } else { baseWins[g.b] += 1; baseLoss[g.a] += 1; }
    }
  }

  const madePlayoffs = new Array(n).fill(0);
  const bestRecord = new Array(n).fill(0);
  const wonTitle = new Array(n).fill(0);
  const winsSum = new Array(n).fill(0);
  const lossSum = new Array(n).fill(0);
  const pfSum = new Array(n).fill(0);
  const paSum = new Array(n).fill(0);

  for (let s = 0; s < sims; s++) {
    const wins = [...baseWins];
    const losses = [...baseLoss];
    const pf = [...basePf];
    const pa = [...basePa];
    const play = (a, b, w) => {
      const sa = score(a, w); const sb = score(b, w);
      pf[a] += sa; pa[a] += sb;
      pf[b] += sb; pa[b] += sa;
      if (sa >= sb) { wins[a] += 1; losses[b] += 1; } else { wins[b] += 1; losses[a] += 1; }
    };
    weekList.forEach((wk, w) => {
      if (wk.unscheduled) {
        // Sleeper has not published this week's pairings — random pairing,
        // said out loud by the caller. Odd team out idles.
        const order = [...Array(n).keys()];
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        for (let i = 0; i + 1 < order.length; i += 2) play(order[i], order[i + 1], w);
        return;
      }
      for (const g of (wk.games || [])) {
        if (g.final) continue;
        play(g.a, g.b, w);
      }
    });
    const seeds = [...Array(n).keys()]
      .sort((a, b) => wins[b] - wins[a] || pf[b] - pf[a] || a - b)
      .slice(0, slots);
    bestRecord[seeds[0]] += 1;
    for (const t of seeds) madePlayoffs[t] += 1;
    let field = seeds;
    if (slots === 6) {
      const g1 = playoffScore(field[2]) >= playoffScore(field[5]) ? field[2] : field[5];
      const g2 = playoffScore(field[3]) >= playoffScore(field[4]) ? field[3] : field[4];
      field = [field[0], field[1], g1, g2];
    }
    while (field.length > 1) {
      const nxt = [];
      for (let i = 0; i < field.length / 2; i++) {
        const a = field[i]; const b = field[field.length - 1 - i];
        nxt.push(playoffScore(a) >= playoffScore(b) ? a : b);
      }
      field = nxt;
    }
    wonTitle[field[0]] += 1;
    for (let i = 0; i < n; i++) {
      winsSum[i] += wins[i]; lossSum[i] += losses[i];
      pfSum[i] += pf[i]; paSum[i] += pa[i];
    }
  }

  const rows = list.map((t, i) => ({
    name: t.name,
    wins: round2(winsSum[i] / sims),
    losses: round2(lossSum[i] / sims),
    pf: round1(pfSum[i] / sims),
    pa: round1(paSum[i] / sims),
    playoff: round3(madePlayoffs[i] / sims),
    regSeasonTitle: round3(bestRecord[i] / sims),
    title: round3(wonTitle[i] / sims),
    avgWins: round1(winsSum[i] / sims),
  }));
  const standings = rows
    .map((r, i) => ({ ...r, index: i }))
    .sort((a, b) => b.wins - a.wins || b.pf - a.pf || a.index - b.index)
    .map((r, k) => ({ ...r, rank: k + 1 }));
  return { seed, sims, playoffSlots: slots, teams: rows, standings };
}
