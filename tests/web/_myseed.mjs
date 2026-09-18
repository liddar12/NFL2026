/* tests/web/_myseed.mjs — a MY PARLAYS seed that is still UPCOMING.
 *
 * MY offers only legs whose game is scheduled and in the future (R84
 * `upcomingLegs`), so a seed hard-coded to one team goes dark the moment that
 * team's game kicks off: the Thursday-night team stops building cards on
 * Friday morning and every MY browser test seeded with it fails on the
 * pipeline's next data commit (2026-09-18: DET at BUF, 17 red tests, no code
 * change). The seed is therefore DERIVED from the committed pool and schedule:
 * the team with the most pooled players whose pool-week game has not kicked
 * off, judged by the real clock the app itself uses.
 */
import { readFileSync } from 'node:fs';

const POOL = JSON.parse(readFileSync(new URL('../../data/leg_pool.json', import.meta.url), 'utf8'));
const SCHEDULE = JSON.parse(readFileSync(new URL('../../data/schedule_full.json', import.meta.url), 'utf8'));

const week = Number(POOL.week);
const upcoming = new Set();
for (const g of SCHEDULE.games || []) {
  if (Number(g.week) !== week || g.status !== 'STATUS_SCHEDULED') continue;
  if (!(Date.parse(g.kickoff_utc) > Date.now())) continue;
  upcoming.add(g.home); upcoming.add(g.away);
}
const byTeam = new Map();
for (const row of POOL.players || []) {
  if (!upcoming.has(row.team)) continue;
  if (!byTeam.has(row.team)) byTeam.set(row.team, []);
  byTeam.get(row.team).push(row);
}
const ranked = [...byTeam.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
if (!ranked.length) {
  throw new Error(`no team in data/leg_pool.json has an upcoming week-${week} game in data/schedule_full.json`);
}

/** The team abbreviation to type into #mp-input. */
export const SEED_TEAM = ranked[0][0];
/** A pooled player on that team (a pool row: gsis_id, player, team, rungs…). */
export const SEED_PLAYER = ranked[0][1][0];
/** Every pool row for the seed team. */
export const SEED_ROWS = ranked[0][1];
