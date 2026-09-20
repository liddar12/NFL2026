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
 *
 * 2026-09-20 bought the SECOND half of that rule. Late on the Sunday of week 2,
 * fourteen of sixteen games had kicked off and only IND @ KC and NYG @ LAR were
 * left. The derived seed held — but seven r86 assertions hard-coded to "ten
 * cards / five eyebrows" went red on main's committed data with no code change,
 * because R83 caps a card at two legs from any ONE game, so two unplayed games
 * can only build a 4-leg card and MY correctly painted 6 cards under 3 eyebrows.
 * Measured that afternoon: seeding one upcoming team, two, three or all four
 * produced the IDENTICAL 6 cards, because the builder already fills every
 * non-seed leg from the whole upcoming pool. The seed was never the ceiling.
 * The rule that bought: derive the SHAPE of the list from the slate the same
 * way the seed is derived — never hard-code a count that the calendar decides.
 * See UPCOMING_GAMES / EXPECTED_CARDS / EXPECTED_BANDS at the foot of this file.
 */
import { readFileSync } from 'node:fs';

const POOL = JSON.parse(readFileSync(new URL('../../data/leg_pool.json', import.meta.url), 'utf8'));
const SCHEDULE = JSON.parse(readFileSync(new URL('../../data/schedule_full.json', import.meta.url), 'utf8'));

const week = Number(POOL.week);
const upcoming = new Set();
const upcomingGames = [];
for (const g of SCHEDULE.games || []) {
  if (Number(g.week) !== week || g.status !== 'STATUS_SCHEDULED') continue;
  if (!(Date.parse(g.kickoff_utc) > Date.now())) continue;
  upcomingGames.push(g);
  upcoming.add(g.home); upcoming.add(g.away);
}
const byTeam = new Map();
for (const row of POOL.players || []) {
  if (!upcoming.has(row.team)) continue;
  if (!byTeam.has(row.team)) byTeam.set(row.team, []);
  byTeam.get(row.team).push(row);
}
const ranked = [...byTeam.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

/* WHEN THE WEEK IS OVER, SAY SO — DO NOT THROW.
 *
 * Between the last game of a week kicking off and the pipeline publishing the
 * next week's pool, NO game is upcoming: MY has nothing to offer, by design
 * (`upcomingLegs` admits only a scheduled game with a future kickoff). This
 * file used to throw at import in that window, which does not fail the MY tests
 * honestly — it fails EVERY test in all five importing specs, including the
 * ghost-click tap tests that are the only coverage of a real user-facing bug,
 * and it fails them with a module-load error rather than a stated reason.
 *
 * So the window is reported instead. Each spec skips on SKIP_REASON, which
 * names the real condition, and a reader of a skipped run learns that the slate
 * is finished rather than that the suite is broken. SKIP_REASON is '' whenever
 * any game is upcoming, so it cannot quietly disable these tests on a live
 * slate: if it ever fires while a game is still to be played, that is a bug in
 * the derivation, not a thin week.
 */
const OVER = !ranked.length;

/** '' while any game is still to be played; otherwise why MY can offer nothing. */
export const SKIP_REASON = OVER
  ? `no week-${week} game is still upcoming in data/schedule_full.json, so MY offers nothing `
    + '(the slate is finished and the next week\'s pool has not been published yet)'
  : '';

/** The team abbreviation to type into #mp-input. null once the week is over. */
export const SEED_TEAM = OVER ? null : ranked[0][0];
/** A pooled player on that team (a pool row: gsis_id, player, team, rungs…). */
export const SEED_PLAYER = OVER ? null : ranked[0][1][0];
/** Every pool row for the seed team. */
export const SEED_ROWS = OVER ? [] : ranked[0][1];

/* THE SHAPE OF THE MY LIST IS THE SHAPE OF WHAT IS LEFT OF THE SLATE.
 *
 * MY offers two cards at each leg count from 2 to 6 — ten cards, five "N LEGS"
 * eyebrows — but only when the slate can supply a 6-leg card, and R83 caps a
 * card at TWO legs from any one game (the same-game correlation adjustment is
 * validated pairwise only; see app/views/myparlays.js `compatible`). A card can
 * therefore never be longer than 2 x (upcoming games), so the list tops out at
 * 2*G - 1 bands and twice that many cards.
 *
 * 2026-09-20, late Sunday of week 2: fourteen of sixteen games had kicked off,
 * two were left (IND @ KC, NYG @ LAR), and MY built 6 cards under 3 eyebrows.
 * Seven r86 assertions hard-coded to "ten cards / five eyebrows" went red with
 * no code change — the same shape of failure the derived seed above was written
 * for. Measured that afternoon: seeding one upcoming team, two, three or all
 * four produced the identical 6 cards / 3 bands, because the builder already
 * fills the non-seed legs from every upcoming game in the pool. The seed was
 * never the ceiling; the number of unplayed GAMES is.
 *
 * So the counts are derived here too, from the same committed data, and the
 * specs assert the exact number this slate can build. This is not a relaxed
 * bound: on a full slate it still demands ten cards and five eyebrows, and it
 * fails just as loudly if MY offers nine.
 */
const LEG_COUNTS = ['2 LEGS', '3 LEGS', '4 LEGS', '5 LEGS', '6 LEGS'];

/** Week-`week` games that have not kicked off — the whole ceiling on card size. */
export const UPCOMING_GAMES = upcomingGames.length;
/** How many "N LEGS" eyebrows MY can paint on this slate (five on a full one). */
export const EXPECTED_BANDS = Math.min(2 * UPCOMING_GAMES - 1, LEG_COUNTS.length);
/** Two cards per band. */
export const EXPECTED_CARDS = 2 * EXPECTED_BANDS;
/** The eyebrows, in order. */
export const EXPECTED_BAND_TEXT = LEG_COUNTS.slice(0, EXPECTED_BANDS);
