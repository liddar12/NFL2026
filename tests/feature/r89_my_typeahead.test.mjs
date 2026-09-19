/* tests/feature/r89_my_typeahead.test.mjs — the MY PARLAYS seed search, and the
 * empty state that has to explain itself.
 *
 * WHAT WAS BROKEN, MEASURED. The seed box was a native <datalist>, so the only
 * input it accepted was an EXACT option name: "goff", "aaron jones" and
 * "j allen" each added nothing and cleared the field, and on iPhone Safari the
 * native popup is unreliable enough that the search read as dead. 16 of the 214
 * pooled players carry a suffix nobody types ("James Cook III"), and on a Friday
 * the box still offered the 17 players on DET and BUF — whose game was final —
 * then answered "No upcoming card is available for those names" without ever
 * saying why.
 *
 * Both halves of the fix are PURE and tested here; the DOM (keyboard, tap,
 * overlay) is tests/web/r89_my_typeahead.spec.mjs, because a list that behaves
 * on paper and not under a thumb is the bug we are fixing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { emptyReason, matchSeeds } from '../../app/views/myparlays.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = readFileSync(join(ROOT, 'app/views/myparlays.js'), 'utf8');
/* The CODE, with the block comments stripped: the header of myparlays.js quotes
 * both the <datalist> it removed and the sentence it replaced, and a source
 * check that reads its own explanation as a regression is worse than no check. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
const CSS = readFileSync(join(ROOT, 'app/theme.css'), 'utf8');
const HIG = readFileSync(join(ROOT, 'app/theme-hig.css'), 'utf8');

/* The option set seedOptions() produces, in miniature: suffixes, a hyphen and a
 * period inside a name, a diacritic name, and the teams. Fictional names, so the
 * ranking is asserted against the RULE rather than against today's pool. */
const P = (id, name, team, position) => ({ kind: 'player', id, name, team, position });
const T = (name) => ({ kind: 'team', id: `team:${name}`, name });
const OPTIONS = [
  P('p1', 'Jared Goff', 'DET', 'QB'),
  P('p2', 'Josh Allen', 'BUF', 'QB'),
  P('p3', 'Keenan Allen', 'IND', 'WR'),
  P('p4', 'Allen Jarrett', 'MIN', 'TE'),
  P('p5', 'James Cook III', 'BUF', 'RB'),
  P('p6', 'Aaron Jones Sr.', 'MIN', 'RB'),
  P('p7', 'Justin Jefferson', 'MIN', 'WR'),
  P('p8', 'Marvin Harrison Jr.', 'ARI', 'WR'),
  P('p9', 'Amon-Ra St. Brown', 'DET', 'WR'),
  P('p10', 'Tomás Ramírez', 'ARI', 'K'),
  P('p11', 'Arian Smith', 'MIN', 'WR'),
  T('ARI'), T('BUF'), T('DET'), T('MIN'),
];
const names = (q, limit) => matchSeeds(OPTIONS, q, limit).map((o) => o.name);

/* ==========================================================================
   1. THE THREE QUERIES THE OWNER REPORTED, AND THE SUFFIX NAMES
   ========================================================================== */

test('a surname alone finds the player — the datalist needed the whole name', () => {
  assert.equal(names('goff')[0], 'Jared Goff');
  assert.equal(names('GOFF')[0], 'Jared Goff', 'case cannot matter');
  assert.equal(names(' goff ')[0], 'Jared Goff', 'nor can stray spaces');
});

test('a suffix nobody types is dropped from the NAME, both ways round', () => {
  // 16 of 214 pooled players carry one. Typing it must still work, because the
  // four MY browser specs seed with the exact committed name.
  assert.equal(names('aaron jones')[0], 'Aaron Jones Sr.');
  assert.equal(names('Aaron Jones Sr.')[0], 'Aaron Jones Sr.');
  assert.equal(names('cook')[0], 'James Cook III');
  assert.equal(names('James Cook III')[0], 'James Cook III');
  assert.equal(names('james cook')[0], 'James Cook III');
});

test('an initial plus a surname matches, and does not drag in the wrong Allen', () => {
  assert.equal(names('j allen')[0], 'Josh Allen');
  assert.equal(names('j. allen')[0], 'Josh Allen');
  assert.equal(names('j goff')[0], 'Jared Goff');
  // "j" prefixes neither of Keenan Allen's tokens, so he is not a match at all
  assert.ok(!names('j allen').includes('Keenan Allen'));
  // ...but plain "allen" reaches every Allen there is
  const allen = names('allen');
  for (const who of ['Josh Allen', 'Keenan Allen', 'Allen Jarrett']) {
    assert.ok(allen.includes(who), `"allen" missed ${who}`);
  }
});

test('a team is seedable by its abbreviation, ahead of any player it matches', () => {
  assert.equal(names('ari')[0], 'ARI');
  assert.equal(names('ARI')[0], 'ARI');
  assert.ok(names('ari').includes('Arian Smith'), 'the player still matches, behind it');
});

test('diacritics and punctuation are normalised away, not required', () => {
  assert.equal(names('tomas ramirez')[0], 'Tomás Ramírez');
  assert.equal(names('ramirez')[0], 'Tomás Ramírez');
  assert.equal(names('Tomás')[0], 'Tomás Ramírez');
  assert.equal(names('amon ra st brown')[0], 'Amon-Ra St. Brown');
  assert.equal(names('st brown')[0], 'Amon-Ra St. Brown');
});

/* ==========================================================================
   2. THE RANKING, TIER BY TIER
   ========================================================================== */

test('exact beats a prefix of the name, which beats a later token', () => {
  // "jo": Josh Allen is a prefix of the whole name (tier 3); Aaron Jones Sr.
  // matches only on a later token (tier 5).
  assert.deepEqual(names('jo'), ['Josh Allen', 'Aaron Jones Sr.']);
  // "arian": the exact name (tier 1) cannot be beaten by a longer name that
  // merely starts with it.
  assert.equal(names('arian smith')[0], 'Arian Smith');
});

test('every-token match ranks by WHICH token matched first', () => {
  // Both match on every token. Josh Allen's first token answers the query's
  // first token (tier 4); Allen Jarrett's does not (tier 5).
  assert.deepEqual(names('j allen'), ['Josh Allen', 'Allen Jarrett']);
});

test('a substring that is no token prefix still matches, last', () => {
  assert.deepEqual(names('ones'), ['Aaron Jones Sr.'],
    '"ones" prefixes no token in "aaron jones sr" — only the substring rule finds it');
  // both match only inside a later token, so they tie and sort A->Z
  assert.deepEqual(names('arr'), ['Allen Jarrett', 'Marvin Harrison Jr.'],
    'substring inside a later token');
});

test('ties break A to Z, so the order never depends on the pool\'s own order', () => {
  const allen = names('allen');
  assert.deepEqual(allen.filter((n) => n !== 'Josh Allen'), ['Allen Jarrett', 'Keenan Allen'],
    'Josh Allen is tier 3 (prefix of the name); the other two tie and sort A->Z');
  const shuffled = matchSeeds([...OPTIONS].reverse(), 'allen').map((o) => o.name);
  assert.deepEqual(shuffled, allen, 'the input order must not reach the output');
});

/* ==========================================================================
   3. LIMIT, EMPTY, AND NO MATCH
   ========================================================================== */

test('the list is capped, at eight by default', () => {
  assert.equal(matchSeeds(OPTIONS, 'a', 3).length, 3);
  assert.equal(matchSeeds(OPTIONS, 'a', 1).length, 1);
  assert.ok(matchSeeds(OPTIONS, 'a').length <= 8, 'the default cap is eight rows');
  // and the cap keeps the BEST rows, not the first ones it happened to see
  assert.deepEqual(matchSeeds(OPTIONS, 'j allen', 1).map((o) => o.name), ['Josh Allen']);
});

test('an empty query suggests nothing — 246 rows is not a suggestion', () => {
  for (const q of ['', '   ', null, undefined, '...']) {
    assert.deepEqual(matchSeeds(OPTIONS, q), [], `"${q}" must suggest nothing`);
  }
});

test('a query nothing answers returns [] so the view can say so', () => {
  assert.deepEqual(matchSeeds(OPTIONS, 'Nobody Whatsoever'), []);
  assert.deepEqual(matchSeeds(OPTIONS, 'zzzz'), []);
  assert.deepEqual(matchSeeds([], 'goff'), []);
  assert.deepEqual(matchSeeds(null, 'goff'), []);
});

/* ==========================================================================
   4. THE EMPTY STATE SAYS WHICH GAME, AND WHAT IT IS DOING
   ========================================================================== */

const NOW = Date.parse('2026-09-19T12:00:00Z');
const GAMES = [
  { game_id: 'g1', away: 'DET', home: 'BUF', status: 'STATUS_FINAL', kickoff_utc: '2026-09-18T00:15Z' },
  { game_id: 'g2', away: 'MIN', home: 'CHI', status: 'STATUS_IN_PROGRESS', kickoff_utc: '2026-09-19T11:00Z' },
  { game_id: 'g3', away: 'SEA', home: 'ARI', status: 'STATUS_SCHEDULED', kickoff_utc: '2026-09-20T20:25Z' },
  { game_id: 'g4', away: 'NYG', home: 'LAR', status: 'STATUS_SCHEDULED', kickoff_utc: '2026-09-19T11:00Z' },
  { game_id: 'g5', away: 'CLE', home: 'TB', status: 'STATUS_POSTPONED', kickoff_utc: '2026-09-20T17:00Z' },
];
/* Only the three fields emptyReason reads: who owns the leg, whose team it is,
 * and which game it belongs to. */
const leg = (owner, team, game_id) => ({ owner, team, game_id });
const LEGS = [
  leg('p1', 'DET', 'g1'), leg('team:BUF', 'BUF', 'g1'),
  leg('p6', 'MIN', 'g2'),
  leg('p11', 'MIN', 'g4'),
  leg('p10', 'ARI', 'g3'),
  leg('p12', 'CLE', 'g5'),
];
const SEED = { p1: P('p1', 'Jared Goff', 'DET', 'QB'), p6: P('p6', 'Aaron Jones Sr.', 'MIN', 'RB'),
  p10: P('p10', 'Tomás Ramírez', 'ARI', 'K'), p11: P('p11', 'Arian Smith', 'MIN', 'WR'),
  p12: P('p12', 'Cleve Barker', 'CLE', 'TE'), BUF: T('BUF') };

test('a finished game is named, with its state and the week the next cards come', () => {
  assert.equal(
    emptyReason([SEED.p1], LEGS, GAMES, 2, NOW),
    'Jared Goff: DET @ BUF is final; cards are built only for games that have not '
    + "kicked off, and DET's next cards arrive with the week 3 pool.",
  );
});

test('a game in progress says so, and so does a kickoff the feed has not caught up with', () => {
  assert.equal(
    emptyReason([SEED.p6], LEGS, GAMES, 2, NOW),
    'Aaron Jones Sr.: MIN @ CHI is in progress; cards are built only for games that '
    + "have not kicked off, and MIN's next cards arrive with the week 3 pool.",
  );
  // g4 is still STATUS_SCHEDULED but kicked off an hour ago — started, not final.
  assert.match(emptyReason([SEED.p11], LEGS, GAMES, 2, NOW), /NYG @ LAR is in progress;/);
});

test('a state we cannot read is "not verified", never guessed at', () => {
  assert.match(emptyReason([SEED.p12], LEGS, GAMES, 2, NOW), /CLE @ TB is not verified;/);
  // a leg whose game is in no schedule at all
  const orphan = [leg('p99', 'KC', 'gone')];
  assert.match(emptyReason([P('p99', 'Pat Orphan', 'KC', 'QB')], orphan, GAMES, 2, NOW),
    /Pat Orphan: the game is not verified;/);
});

test('a team seed names the team, not one of its players', () => {
  assert.equal(
    emptyReason([SEED.BUF], LEGS, GAMES, 2, NOW),
    'BUF: DET @ BUF is final; cards are built only for games that have not kicked '
    + "off, and BUF's next cards arrive with the week 3 pool.",
  );
});

test('a seed that DOES have upcoming legs is told the dial, not the clock', () => {
  assert.equal(
    emptyReason([SEED.p10], LEGS, GAMES, 2, NOW),
    'No card could be built around Tomás Ramírez at this dial; try another risk setting.',
  );
});

test('several seeds produce several sentences, joined by one space', () => {
  const text = emptyReason([SEED.p1, SEED.p10], LEGS, GAMES, 2, NOW);
  assert.equal(text, `${emptyReason([SEED.p1], LEGS, GAMES, 2, NOW)} `
    + `${emptyReason([SEED.p10], LEGS, GAMES, 2, NOW)}`);
  assert.ok(!/ {2}/.test(text), 'no double spaces between sentences');
});

test('emptyReason is numbers and facts — no adjectives, no apology', () => {
  const text = emptyReason([SEED.p1, SEED.p6, SEED.p10], LEGS, GAMES, 2, NOW);
  for (const word of ['sorry', 'unfortunately', 'oops', 'unavailable', 'great', 'best']) {
    assert.ok(!text.toLowerCase().includes(word), `the empty state says "${word}"`);
  }
  assert.equal(emptyReason([], LEGS, GAMES, 2, NOW), '', 'no seeds, nothing to explain');
});

/* ==========================================================================
   5. THE MARKUP AND THE CSS (the DOM itself is the browser spec's job)
   ========================================================================== */

test('the native datalist is gone, and the input is a combobox over our listbox', () => {
  assert.ok(!/<datalist/.test(CODE), 'the <datalist> must be removed, not merely ignored');
  assert.ok(!/id="mp-opts"/.test(CODE), 'and so must its id');
  const input = /<input id="mp-input"[\s\S]*?>'/.exec(CODE);
  assert.ok(input, 'the #mp-input markup was not found');
  assert.ok(!/\blist="/.test(input[0]), 'the list= attribute is what bound it to the datalist');
  for (const attr of ['autocomplete="off"', 'role="combobox"', 'aria-autocomplete="list"',
    'aria-expanded', 'aria-controls="mp-suggest"']) {
    assert.ok(SRC.includes(attr), `#mp-input must carry ${attr}`);
  }
  assert.match(CODE, /<ul id="mp-suggest" class="mp-suggest" role="listbox"/,
    'the suggestion list must be a <ul id="mp-suggest" class="mp-suggest" role="listbox">');
  assert.match(SRC, /aria-activedescendant/, 'the active row must be announced');
  // the handles four browser specs drive MY by
  assert.ok(SRC.includes('id="mp-input"') && SRC.includes("querySelector('#mp-seeds')"));
});

test('a suggestion row is an option, carries its seed id, and flags a finished game', () => {
  const row = /function renderSeedOption\([\s\S]*?\n}/.exec(SRC);
  assert.ok(row, 'renderSeedOption was not found');
  for (const bit of ['role="option"', 'id="mp-opt-', 'data-seed="', 'aria-selected=',
    'GAME FINAL', 'class="est"']) {
    assert.ok(row[0].includes(bit), `a suggestion row must carry ${bit}`);
  }
  assert.ok(SRC.includes('No player or team matches'),
    'Enter with no match must say so rather than clear the field silently');
  // the tap has to land before the blur iOS fires under it
  assert.match(SRC, /pointerdown/, 'rows are picked on pointerdown, not click');
  // R90 renamed pick() to commit(): a tapped row now commits the earlier
  // comma-separated parts alongside it. The preventDefault is what is asserted.
  assert.match(SRC, /e\.preventDefault\(\);\n\s*commit\(/,
    'the row pointerdown must preventDefault so the input keeps focus');
});

test('paint() explains itself with emptyReason and keeps the .state element', () => {
  assert.ok(!CODE.includes('No upcoming card is available for those names'),
    'the fixed sentence is replaced, not supplemented');
  assert.match(SRC, /class="state">\$\{esc\(emptyReason\(/,
    'the empty state must be emptyReason(), escaped, inside the existing .state div');
});

/** The body of the FIRST rule whose selector matches. */
function ruleBody(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return open < 0 || close < 0 ? null : css.slice(open + 1, close);
}

test('the suggestion list overlays the cards instead of moving them', () => {
  const head = ruleBody(CSS, '.mp-head {');
  assert.match(head, /position:\s*relative/,
    '.mp-suggest is absolutely positioned against .mp-head — without this it '
    + 'would anchor to the page and float away from the input');
  const body = ruleBody(CSS, '.mp-suggest {');
  assert.ok(body, '.mp-suggest rule missing from app/theme.css');
  assert.match(body, /position:\s*absolute/);
  assert.match(body, /max-height:\s*40vh/, 'the list may never own the whole phone screen');
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /z-index:\s*20/, 'above the card grid, below the fixed tabbar (30)');
  assert.match(CSS, /\.mp-suggest:empty\s*\{[^}]*display:\s*none/,
    'an empty list must not draw a 1px box under the input');
});

test('a suggestion row clears the 44px touch target and marks the active one', () => {
  const opt = ruleBody(CSS, '.mp-opt {');
  assert.ok(opt, '.mp-opt rule missing from app/theme.css');
  assert.match(opt, /min-height:\s*44px/, 'HIG touch target — this list is driven by a thumb');
  const active = ruleBody(CSS, '.mp-opt[aria-selected="true"]');
  assert.ok(active, 'the active row has no style — the keyboard would be invisible');
  assert.match(active, /background:\s*var\(--elev\)/);
  assert.match(active, /var\(--brand\)/, 'and a bar, so it is never colour alone');
});

test('the new rules introduce no colour of their own, in either theme', () => {
  // Every AA pairing in this app is audited against the TOKENS
  // (contrast_aa.test.mjs / contrast_aa_hig.test.mjs). A literal hex here would
  // be a colour nothing measures.
  for (const [name, css] of [['theme.css', CSS], ['theme-hig.css', HIG]]) {
    for (const sel of ['.mp-suggest {', '.mp-opt {', '.mp-opt[aria-selected="true"]']) {
      const body = ruleBody(css, (name === 'theme-hig.css' ? '[data-theme="hig"] ' : '') + sel);
      if (!body) continue;
      assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body),
        `${name} ${sel} hard-codes a colour instead of using a token: ${body.trim()}`);
    }
  }
});

test('the HIG theme restates the list in its own furniture, and stays scoped', () => {
  assert.match(HIG, /\[data-theme="hig"\]\s*\.mp-suggest\s*\{/,
    'theme-hig.css must restate .mp-suggest — the default sheet is dark-only');
  assert.match(HIG, /\[data-theme="hig"\]\s*\.mp-opt\s*\{/);
  const active = ruleBody(HIG, '[data-theme="hig"] .mp-opt[aria-selected="true"]');
  assert.ok(active, 'the HIG active row must be restated: --elev is a dark-theme fill');
  assert.match(active, /var\(--hig-tint-soft\)/,
    'the HIG selected row uses the same tint fill a selected chip already uses');
});
