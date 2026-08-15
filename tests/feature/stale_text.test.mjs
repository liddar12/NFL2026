/* tests/feature/stale_text.test.mjs — THE STALE-TEXT AUDIT.
 *
 * WHY THIS FILE EXISTS. Three defects reached the owner in one afternoon, all
 * the same shape and none caught by a gate that was otherwise green:
 *
 *   1. R27 made K and DEF draftable and left the settings card and the import
 *      report saying "the draft simulator does not draft them".
 *   2. The card claimed "the 13-slot roster panel on this page is still fixed"
 *      — untrue since R19 made the panel shape-driven, and visibly false once a
 *      K/DEF league rendered K and DEF slots.
 *   3. The Sleeper import told the user that fgm_50_59, yds_allow_* and the
 *      rest "contribute 0 to every projected total". True of the offensive
 *      projection path; FALSE for K/DST, which app/kdst.js scores under the
 *      league's own table. Measured: those rules move a defence by up to 16
 *      points and reorder 29 of 32.
 *
 * A fourth appeared while fixing the second: the replacement sentence said a
 * K/DEF league "has to come in through the Sleeper import", which stopped being
 * true within the same release when the K and DEF counters shipped.
 *
 * The unit tests all passed each time, because they assert what the CODE does.
 * Nothing asserted what the app SAYS about what it does. That gap is this file.
 *
 * WHAT THIS CAN AND CANNOT CATCH. It cannot read English. What it can do is
 * pin the specific claims that have already gone stale, and fail when a claim
 * and the behaviour it describes disagree in a way that IS mechanically
 * checkable — a capability list that must match an exported constant, a
 * limitation that must not survive the feature that removed it. Every entry
 * below is a claim that was FALSE IN PRODUCTION, not a hypothetical.
 *
 * HOW TO ADD ONE. When a release changes behaviour, find the sentence that
 * describes the old behaviour and add it here as a dead claim. The cost of an
 * entry is one line; the cost of missing one is the owner finding it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { DRAFTABLE_TOKENS, cfgFromProfile } from '../../app/views/team.js';
import { ROSTER_BOUNDS } from '../../app/draft-sim.js';
import { normalizeProfile } from '../../app/league.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

/* Source files that speak to the user. Comments are stripped before matching:
 * a comment EXPLAINING why a claim was retired is exactly what we want people
 * to write, and must not itself trip the audit. */
const USER_FACING = [
  'app/views/team.js', 'app/views/players.js', 'app/views/lineup.js',
  'app/views/compare.js', 'app/views/model.js', 'app/views/slate.js',
  'app/views/parlays.js', 'app/sleeper.js', 'app/kdst.js',
];

/** Source with // line comments and block comments removed. */
function prose(path) {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* ==========================================================================
   1. DEAD CLAIMS — sentences that were true once and are not any more
   ========================================================================== */

/* NOTE — "the simulator does not draft them" is deliberately NOT banned here,
 * and the first draft of this file got that wrong. The sentence is still TRUE
 * for genuinely undraftable carried tokens (an unusual second flex, an IDP
 * slot), so banning the string would have forced a real message to be deleted.
 * The defect was never the sentence; it was K and DEF being in the list it
 * describes. That invariant is asserted directly below, which is both stricter
 * and honest about what actually went wrong. */
const DEAD_CLAIMS = [
  {
    text: '13-slot roster panel',
    retired: 'R19 made the roster panel shape-driven; R27 made it visibly so',
    because: 'the panel renders whatever slots the league seats, including K and DEF',
  },
  {
    text: 'has to come in through the Sleeper',
    retired: 'R28 — the K and DEF roster counters shipped',
    because: 'a hand-built league can now seat a kicker without any import',
  },
  {
    text: 'its shape knows no K/DEF',
    retired: 'R27 — rosterShape gained k/def',
    because: 'the draft simulator seats and prices both',
  },
];

test('no user-facing file repeats a claim the app has retired', () => {
  for (const claim of DEAD_CLAIMS) {
    for (const file of USER_FACING) {
      assert.ok(!prose(file).includes(claim.text),
        `${file} still says "${claim.text}" — retired by ${claim.retired}, `
        + `because ${claim.because}. If the behaviour came BACK, delete the `
        + `entry from DEAD_CLAIMS with a note; do not weaken this assertion.`);
    }
  }
});

/* ==========================================================================
   2. CLAIMS THAT MUST TRACK A CONSTANT
   ========================================================================== */

test('a draftable position is NEVER reported as one the simulator will not draft', () => {
  /* The invariant behind the first defect, asserted where it actually lives.
   * `carried` is the list both the settings card and the import report
   * describe as "kept on your league profile but the draft simulator does not
   * draft them". Anything DRAFTABLE_TOKENS claims the room can draft must
   * therefore never appear in it — for any league shape, not just the one that
   * happened to be tested. */
  const shapes = [
    ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN'],
    ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST', 'BN', 'BN'],
    ['QB', 'QB', 'RB', 'WR', 'TE', 'SUPER_FLEX', 'K', 'BN', 'BN'],
    ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'BN'],
  ];
  for (const roster_positions of shapes) {
    const { carried } = cfgFromProfile(normalizeProfile({
      shape: { teams: 10, roster_positions: [...roster_positions] },
    }));
    for (const token of carried) {
      assert.ok(!DRAFTABLE_TOKENS.includes(token) && token !== 'DST',
        `${token} is draftable, but [${roster_positions.join(',')}] reports it as `
        + 'carried — which is what tells the user their kicker will not be drafted '
        + 'while the room drafts it');
    }
  }
});

test('the draftable-position list and the roster counters agree', () => {
  // The card offers a counter for every position the simulator can draft, and
  // no counter for one it cannot. When these drift, one of them is lying to
  // the user about what their league can express.
  const src = read('app/views/team.js');
  for (const token of DRAFTABLE_TOKENS) {
    const key = token.toLowerCase();
    assert.ok(ROSTER_BOUNDS[key],
      `${token} is draftable but has no ROSTER_BOUNDS entry, so the settings `
      + 'card cannot offer a counter for it');
    assert.ok(new RegExp(`stepper\\('${key}'`).test(src),
      `${token} is draftable and bounded, but the ROSTER grid renders no `
      + `counter for it — a league cannot say it seats one`);
  }
});

/* ==========================================================================
   3. THE IMPORT REPORT MUST NAME THE PATH IT MEANS
   ========================================================================== */

test('an unfed scoring rule says WHICH projection it does not feed', () => {
  /* THE THIRD DEFECT. app/sleeper.js told the user a carried rule "adds
   * nothing to a projected total" — full stop, no qualification. For the
   * offensive path that is true. For K/DST it is false: app/kdst.js recomputes
   * every stat line under the league's own scoring, so fgm_50_59, fgm_60p and
   * the whole yds_allow ladder ARE applied. Measured against Omilia-US: the
   * defence sheet moves -17.85 to +16.18 points and 29 of 32 ranks change.
   *
   * So the message must scope itself. This asserts the qualifier exists rather
   * than trying to grade English: an unscoped absolute is what caused the bug.
   */
  const src = prose('app/sleeper.js');
  const claimsNothing = /adds nothing to a projected total/.test(src);
  if (claimsNothing) {
    assert.ok(/player projection|offensive|player_projections|skill-position/i.test(src),
      'app/sleeper.js tells the user a carried rule adds nothing to "a projected '
      + 'total" without saying WHICH projection. K and D/ST are scored from the '
      + 'league\'s own table by app/kdst.js, so the unqualified claim is false '
      + 'for exactly the two positions whose rules dominate that list.');
  }
});

/* ==========================================================================
   4. A PARTIAL NUMBER MUST STILL SAY IT IS PARTIAL
   ========================================================================== */

test('kdst partial scoring is still declared, not quietly dropped', () => {
  // The counterpart to the audit above: kdst.js is allowed to omit components
  // it cannot model, but only while it keeps SAYING so. This is the mechanism
  // that makes the corrected import message honest rather than merely softer.
  const src = read('app/kdst.js');
  assert.ok(/omittedKeys/.test(src) && /partial/.test(src),
    'app/kdst.js must keep marking entries whose scoring is incomplete — the '
    + 'import report now points at this behaviour instead of claiming the '
    + 'rules do nothing at all');
});

/* ==========================================================================
   5. R29 — EVERY SURFACE PRICES THE SAME PLAYER THE SAME WAY
   ========================================================================== */

test('every view that converts season points stamps the league extras first', () => {
  /* THE R19 FAILURE MODE, GENERALISED.
   *
   * R19 loaded the league profile and did not thread it to the surfaces, so
   * saved settings reached storage and nothing else. R29 has the identical
   * shape of risk: the league's pass_cmp rate is applied by withLeagueExtras()
   * onto the weekly entries, and a view that builds its own weekly Map and
   * forgets to stamp it would quietly price that league's quarterbacks at
   * zero — while the tab next door priced them correctly. Two surfaces
   * disagreeing about the same player is worse than not pricing the rule.
   *
   * So: any view that holds a weekly map AND converts season points must call
   * withLeagueExtras. Asserted by construction rather than by remembering.
   */
  const CONVERTERS = ['app/views/players.js', 'app/views/team.js',
    'app/views/lineup.js', 'app/views/compare.js'];
  for (const f of CONVERTERS) {
    const src = read(f);
    assert.ok(/withLeagueExtras\s*\(/.test(src),
      `${f} builds a weekly map and converts season points, but never calls `
      + 'withLeagueExtras — this league\'s scoring rules would be dropped on '
      + 'this surface only, and it would disagree with every other tab');
  }
});

test('a view that stamps the league extras also READS them', () => {
  /* R30 — THE ASSERTION ABOVE WAS SATISFIABLE BY DOING NOTHING.
   *
   * It checks that withLeagueExtras is CALLED. app/views/compare.js called it
   * and then never looked at the result: no path in the file read extra_pts,
   * and the file performed no season-points conversion at all — it printed the
   * raw full-PPR proj_points under a label every other tab defines as "your
   * scoring mode". So the guard written in R29 to prevent exactly this class of
   * bug passed, for two releases, on a file that had the bug.
   *
   * A call whose return value is discarded is not wiring. Stamp and read have
   * to be asserted together, or "calls the function" is a ritual.
   */
  /* app/views/lineup.js is KNOWINGLY ABSENT from this list, and saying why is
   * the point of the exemption. It has the same inert call — R30 confirmed it —
   * but it renders WEEKLY points off wkEntry.pts, while extra_pts is a SEASON
   * total. Reading it there is not a one-line change: it needs a decision about
   * how a season-long rule is apportioned across 18 weeks and byes, which is a
   * scoring change, not a bug fix. Doing that inside a blocker release is how a
   * fix becomes a regression. Tracked as R30b in docs/qa/R30_RCA_FINDINGS.md;
   * add lineup.js back to this array in the change that lands it. */
  const CONVERTERS = ['app/views/players.js', 'app/views/team.js',
    'app/views/compare.js'];
  for (const f of CONVERTERS) {
    const src = prose(f);
    assert.ok(/extraPtsOf\s*\(|extra_pts/.test(src),
      `${f} stamps this league's scoring rules onto its weekly map with `
      + 'withLeagueExtras and then never reads extra_pts or calls extraPtsOf, '
      + 'so the stamp is discarded and the league is priced as if it had no '
      + 'extra rules — while the tab next door prices it correctly.');
  }
});

test('every surface that prints season points converts them by MODE', () => {
  /* The other half of the same defect, and the more serious half: it needs no
   * league import to trigger. COMPARE never read the scoring mode, so flipping
   * the toggle to STD changed PLAYERS and left COMPARE on full PPR — 3,914
   * pairs in the shipped pool flip order between those two tables, so the two
   * tabs could crown different winners for the same two players.
   *
   * The mode reader is now one exported function (team-logic loadScoringMode).
   * Requiring the surfaces to go through it is what stops a fourth private
   * copy drifting again — three already existed. */
  const CONVERTERS = ['app/views/players.js', 'app/views/team.js',
    'app/views/compare.js'];
  for (const f of CONVERTERS) {
    const src = prose(f);
    assert.ok(/loadScoringMode\s*\(|SCORING_KEY/.test(src),
      `${f} prints season points but never reads the persisted scoring mode, `
      + 'so it renders one scoring table while the rest of the app renders '
      + 'another — and neither number says which table it is in');
  }
});

test('there is exactly ONE season-points conversion in the app', () => {
  // app/views/players.js carried a hand-rolled copy of scoringAdjust, line for
  // line. Teaching one copy a new scoring rule and not the other ships a
  // two-tabs-disagree bug by construction, which is REL21 all over again.
  const copies = [];
  for (const f of ['app/views/players.js', 'app/views/team.js',
    'app/views/lineup.js', 'app/views/compare.js', 'app/render.js']) {
    const src = prose(f);
    // The signature of the conversion: a half/std branch on `mode`.
    if (/mode === 'half'/.test(src) && /mode === 'std'/.test(src)) copies.push(f);
  }
  assert.deepEqual(copies, [],
    `${copies.join(', ')} re-implements the season-points conversion instead of `
    + 'calling team-logic scoringAdjust(); one copy will eventually learn a '
    + 'scoring rule the other does not');
});
