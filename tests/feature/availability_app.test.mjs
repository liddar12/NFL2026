/* tests/feature/availability_app.test.mjs — REL17 app-side availability, locked.
 *
 * PURE node:test over the pure modules (app/availability.js, app/lineup.js). No
 * DOM, no fetch, no browser — this runs inside the FAST gate.
 *
 * What these lock, in fantasy terms:
 *   - a manager NEVER auto-starts a player who can't play while a warm body is
 *     available (F3), and when there is no warm body the app SAYS SO;
 *   - a duration is never invented and never shown without provenance (F5);
 *   - "4+ WKS · LEAGUE MIN" and "3 WKS · REPORT" can never be confused;
 *   - a deploy whose player_weekly.json predates the availability pipeline renders
 *     byte-identically to today (the degrade-honestly rule).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availabilityOf, renderAvailChip, AVAIL_CODES, __selftest,
} from '../../app/availability.js';
import { bestLineup, startSitSwaps } from '../../app/lineup.js';

/** A player_weekly.json-shaped row. `avail` rides on the WEEK, per the contract. */
function weekly(availability, blockedWeeks = []) {
  const blocked = new Set(blockedWeeks);
  const weeks = [];
  for (let wk = 1; wk <= 18; wk += 1) {
    const w = { wk, opp: 'SEA', home: wk % 2 === 0, bye: wk === 8, pts: wk === 8 ? 0 : 5.5 };
    if (blocked.has(wk)) { w.pts = 0.0; w.avail = false; }
    weeks.push(w);
  }
  const row = { gsis_id: 'espn-1', receptions_prior: 0.0, weeks };
  if (availability) row.availability = availability;
  return row;
}

test('availability self-check passes', () => {
  assert.equal(__selftest(), true);
});

test('the canonical vocabulary is exactly the eight codes', () => {
  assert.deepEqual([...AVAIL_CODES], [
    'ACTIVE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT', 'IR', 'PUP', 'NFI', 'SUSPENDED',
  ]);
});

/* ---- Degrade honestly: an older deploy must render exactly as today --------- */

test('no availability block at all → no chip, playable, nothing rendered', () => {
  const a = availabilityOf(weekly(null), 3, 3);
  assert.equal(a.playable, true);
  assert.equal(a.status, null);
  assert.equal(a.label, '');
  assert.equal(renderAvailChip(a), '');
  assert.equal(renderAvailChip(a, { sm: true }), '');
});

test('a null/undefined weekly row is safe and playable', () => {
  for (const row of [null, undefined, {}, { weeks: null }]) {
    const a = availabilityOf(row, 1, 1);
    assert.equal(a.playable, true, 'absent data is never rendered as a claim');
    assert.equal(renderAvailChip(a), '');
  }
});

test('ACTIVE renders no chip — a badge on every healthy player is noise', () => {
  const a = availabilityOf(weekly({ status: 'ACTIVE', class: 'week' }), 1, 1);
  assert.equal(a.playable, true);
  assert.equal(renderAvailChip(a), '');
});

test('an UNKNOWN status is not treated as ACTIVE and is not invented into a label', () => {
  // Vocabulary drift is caught loudly at the pipeline gate; the app must not
  // fabricate a badge for a code it does not know, but MUST still honour the
  // applied consequence the pipeline wrote on the week.
  const a = availabilityOf(weekly({ status: 'RESERVE/COVID', class: 'season' }, [1, 2]), 1, 1);
  assert.equal(a.label, '', 'no label we cannot back');
  assert.equal(a.playable, false, 'the blocked week still benches him');
});

/* ---- R2 — the ambiguous IR (Ricky Pearsall): the proof we never guess ------- */

test('IR with no parsed duration reads "4+ WKS · LEAGUE MIN", never a bare 4', () => {
  const row = weekly({
    status: 'IR', class: 'season', weeks_out: 4, out_for_season: false,
    confidence: 'rule', evidence: null, season_points_lost: 20.87,
  }, [1, 2, 3, 4]);
  const a = availabilityOf(row, 1, 1);
  assert.equal(a.playable, false);
  assert.equal(a.durText, '· 4+ WKS', 'the + separates the league floor from a report');
  assert.equal(a.provText, 'LEAGUE MIN');
  assert.equal(a.confidence, 'rule');
  assert.match(a.title, /league minimum 4 games; no return date reported/);
  assert.match(a.phrase, /is on IR, out at least 4 more weeks/);
  const html = renderAvailChip(a, { sm: true });
  assert.match(html, /av-chip--out/);
  assert.match(html, />IR</);
  assert.match(html, /av-prov--min/);
  assert.ok(!/av-prov--report/.test(html), 'a rule floor must never claim REPORT');
  // Week 9 — off the blocked list. He starts again with no chip-driven benching.
  assert.equal(availabilityOf(row, 9, 1).playable, true);
});

/* ---- R1 — the season-ending stash (REPORT provenance) ---------------------- */

test('out_for_season reads "· SEASON" with REPORT provenance and quotes the report', () => {
  const evid = 'Brazzell will officially miss his entire rookie season due to the LCL tear.';
  const a = availabilityOf(weekly({
    status: 'IR', class: 'season', weeks_out: null, out_for_season: true,
    confidence: 'explicit', evidence: evid,
  }, [1, 2, 3]), 1, 1);
  assert.equal(a.durText, '· SEASON', 'SEASON beats a number — never "· 17 WKS"');
  assert.equal(a.provText, 'REPORT');
  assert.equal(a.evidence, evid);
  assert.match(a.phrase, /is on IR for the season/);
  assert.match(renderAvailChip(a), /av-prov--report/);
});

/* ---- R3 — the suspension with a stated length ------------------------------ */

test('an explicit 3-game suspension reads "3 WKS · REPORT" — no "+" and no "at least"', () => {
  const row = weekly({
    status: 'SUSPENDED', class: 'season', weeks_out: 3, out_for_season: false,
    confidence: 'explicit', evidence: 'set to miss the first three games of the 2026 regular season',
  }, [1, 2, 3]);
  const a = availabilityOf(row, 2, 2);
  assert.equal(a.label, 'SUSP');
  assert.equal(a.durText, '· 3 WKS');
  assert.equal(a.provText, 'REPORT');
  assert.match(a.phrase, /is suspended for 3 more weeks/);
  assert.ok(!/at least/.test(a.phrase), '"at least" is reserved for the rule floor');
  assert.match(a.title, /Suspended — 3 games per league announcement/);
  // Week 4 onward he is startable again — and the chip is GONE. A 3-game ban is a
  // fact about weeks 1-3; "⊘ SUSP · 3 WKS" beside a week-4 row that projects real
  // points would say "he can't play" about a week he can.
  const back = availabilityOf(row, 4, 2);
  assert.equal(back.playable, true);
  assert.equal(back.applies, false);
  assert.equal(renderAvailChip(back, { sm: true }), '', 'no chip once the ban is served');
  assert.equal(back.status, 'SUSPENDED', 'the underlying fact is still readable');
});

test('a suspension of unknown length is flagged but zeroes nothing', () => {
  const a = availabilityOf(weekly({ status: 'SUSPENDED', class: 'season' }), 1, 1);
  assert.equal(a.label, 'SUSP');
  assert.equal(a.durText, '', 'no length announced means no number, ever');
  assert.equal(a.provText, '');
  assert.equal(a.playable, true, 'we do not know how long — we do not block weeks');
  assert.match(a.title, /length not announced/);
  // ...but it must still be VISIBLE. A season-class flag that blocked nothing
  // cannot silently vanish just because no week carries avail:false.
  assert.equal(a.applies, true);
  assert.match(renderAvailChip(a), /av-chip--out/);
});

test('a season-class chip rides the BLOCKED weeks, not the whole season', () => {
  const row = weekly({
    status: 'IR', class: 'season', weeks_out: 4, confidence: 'rule',
  }, [1, 2, 3, 4]);
  for (const wk of [1, 4]) {
    const a = availabilityOf(row, wk, 1);
    assert.equal(a.applies, true, `week ${wk} is blocked`);
    assert.equal(a.playable, false);
  }
  for (const wk of [5, 12]) {
    const a = availabilityOf(row, wk, 1);
    assert.equal(a.applies, false, `week ${wk} is past the absence`);
    assert.equal(a.playable, true);
    assert.equal(renderAvailChip(a, { sm: true }), '');
  }
});

test('a duration with no provenance is DROPPED — a bare number is the F5 failure', () => {
  const a = availabilityOf(weekly({ status: 'IR', class: 'season', weeks_out: 6 }), 1, 1);
  assert.equal(a.weeksOut, null);
  assert.equal(a.durText, '');
  assert.ok(!/av-prov/.test(renderAvailChip(a)));
  assert.ok(!/6/.test(renderAvailChip(a)), 'no number survives without its provenance');
});

/* ---- Week-class codes stay the manager's call ------------------------------ */

test('QUESTIONABLE / DOUBTFUL are the watch tone and remain PLAYABLE', () => {
  for (const [code, label] of [['QUESTIONABLE', 'Q'], ['DOUBTFUL', 'D']]) {
    const a = availabilityOf(weekly({ status: code, class: 'week' }), 5, 5);
    assert.equal(a.label, label);
    assert.equal(a.tone, 'watch');
    assert.equal(a.playable, true, 'start/sit on a Q is the manager\'s judgement');
    assert.match(renderAvailChip(a, { sm: true }), /av-chip--watch/);
  }
});

test('OUT blocks THIS week only — it is a designation, not a duration', () => {
  const row = weekly({ status: 'OUT', class: 'week' });
  assert.equal(availabilityOf(row, 7, 7).playable, false, 'ruled out this week');
  assert.equal(availabilityOf(row, 8, 7).playable, true, 'a future week is not blocked by an OUT');
  assert.equal(availabilityOf(row, 7, 7).title, 'Ruled out this week');
  assert.equal(availabilityOf(row, 7, 7).durText, '', 'an OUT never carries a duration');
});

/* ---- Chip markup / accessibility ------------------------------------------ */

test('every chip spells the code out in title and hides its glyph from AT', () => {
  const a = availabilityOf(weekly({ status: 'PUP', class: 'season' }), 1, 1);
  const html = renderAvailChip(a);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /title="Physically Unable to Perform[^"]*"/);
  assert.match(html, />PUP</, 'the CODE TEXT is the primary carrier, not the color');
});

test('chip HTML escapes its evidence-free fields — no injection through a feed', () => {
  const a = availabilityOf(weekly({ status: '<img src=x>', class: 'season' }), 1, 1);
  assert.equal(renderAvailChip(a), '', 'an unknown code renders nothing at all');
});

/* ---- F3 — the optimizer never silently auto-starts an unavailable player ---- */

const ROSTER = () => ([
  { id: 'qb', pos: 'QB', pts: 21 },
  { id: 'rbStar', pos: 'RB', pts: 18 }, { id: 'rbIR', pos: 'RB', pts: 12.4, playable: false },
  { id: 'rbScrub', pos: 'RB', pts: 4 },
  { id: 'wrA', pos: 'WR', pts: 15 }, { id: 'wrB', pos: 'WR', pts: 13 },
  { id: 'wrBench', pos: 'WR', pts: 6 },
  { id: 'te', pos: 'TE', pts: 8 },
]);

test('an available 4.0 beats an unavailable 12.4 for the same slot', () => {
  const { slots, bench, warnings } = bestLineup(ROSTER());
  assert.equal(slots.RB1, 'rbStar');
  assert.equal(slots.RB2, 'rbScrub', 'the IR back does NOT take RB2 on points');
  assert.ok(bench.includes('rbIR'), 'he is on the bench, where a manager expects him');
  assert.deepEqual(warnings, [], 'a benched unavailable player is not a warning');
});

test('start/sit never RECOMMENDS starting an unavailable player (the F3 defect)', () => {
  const players = ROSTER();
  const current = ['qb', 'rbStar', 'rbScrub', 'wrA', 'wrB', 'te', 'rbIR']; // manager flexed the IR guy
  const { start, sit } = startSitSwaps(current, players, 4);
  assert.ok(!start.includes('rbIR'), 'moves.start can never contain an unavailable id');
  assert.ok(sit.includes('rbIR'), 'and it tells him to sit the man who cannot play');
  assert.ok(start.includes('wrBench'), 'the available WR3 is promoted into FLEX in his place');
});

test('a forced start is FILLED and FLAGGED — never empty, never silent', () => {
  // A real 12-team problem: both rostered RBs are on IR in the same week.
  const players = [
    { id: 'qb', pos: 'QB', pts: 21 },
    { id: 'rbIR1', pos: 'RB', pts: 14, playable: false },
    { id: 'rbIR2', pos: 'RB', pts: 9, playable: false },
    { id: 'wrA', pos: 'WR', pts: 15 }, { id: 'wrB', pos: 'WR', pts: 13 }, { id: 'wrC', pos: 'WR', pts: 6 },
    { id: 'te', pos: 'TE', pts: 8 },
  ];
  const { slots, warnings } = bestLineup(players);
  assert.equal(slots.RB1, 'rbIR1');
  assert.equal(slots.RB2, 'rbIR2');
  assert.equal(warnings.length, 2, 'one warning per forced slot');
  assert.deepEqual(warnings.map((w) => w.slot).sort(), ['RB1', 'RB2']);
  for (const w of warnings) assert.equal(w.reason, 'no_available_alternative');
  assert.equal(slots.FLEX, 'wrC', 'FLEX still prefers the available WR3 over an IR back');
});

test('FLEX compares on availability BEFORE points, across positions', () => {
  const { slots } = bestLineup([
    { id: 'qb', pos: 'QB', pts: 20 },
    { id: 'rb1', pos: 'RB', pts: 18 }, { id: 'rb2', pos: 'RB', pts: 16 },
    { id: 'wr1', pos: 'WR', pts: 15 }, { id: 'wr2', pos: 'WR', pts: 11 },
    { id: 'te1', pos: 'TE', pts: 7 },
    { id: 'wrHurt', pos: 'WR', pts: 12.4, playable: false }, { id: 'teOk', pos: 'TE', pts: 4 },
  ]);
  assert.equal(slots.FLEX, 'teOk', 'an available TE 4.0 outranks an unavailable WR 12.4');
});

test('rosters with NO playable flags behave exactly as before Rel17', () => {
  const players = [
    { id: 'qb', pos: 'QB', pts: 22 },
    { id: 'rbA', pos: 'RB', pts: 20 }, { id: 'rbB', pos: 'RB', pts: 15 }, { id: 'rbC', pos: 'RB', pts: 13 },
    { id: 'wrA', pos: 'WR', pts: 18 }, { id: 'wrB', pos: 'WR', pts: 11 }, { id: 'wrC', pos: 'WR', pts: 9 },
    { id: 'te', pos: 'TE', pts: 7 },
  ];
  const l = bestLineup(players);
  assert.equal(l.slots.FLEX, 'rbC');
  assert.equal(l.total, 22 + 20 + 15 + 18 + 11 + 7 + 13);
  assert.deepEqual(l.warnings, []);
  // playable:true is identical to absent.
  const l2 = bestLineup(players.map((p) => ({ ...p, playable: true })));
  assert.deepEqual(l2.slots, l.slots);
  assert.equal(l2.total, l.total);
});
