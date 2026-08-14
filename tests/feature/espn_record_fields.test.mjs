/* tests/feature/espn_record_fields.test.mjs — a stat collected must be a stat delivered.
 *
 * THE BUG THIS EXISTS FOR. R28 taught scripts/scrape/espn_players.py to read
 * ESPN's statId 1 (completions) and scripts/build_predictions.py to consume it,
 * shipped with a fully green gate, and delivered NOTHING: build_player_records
 * between them rebuilds each record field by field and did not copy it across.
 *
 * Every layer degraded politely, which is exactly why nobody noticed:
 *
 *   build_predictions   r.get("completions", 0.0)   -> missing key reads as 0
 *   build_weekly        omits a zero by design      -> no key emitted
 *   the shipped feed    byte-identical to before    -> validate_data green
 *   the app             prices 0 x rate = 0 points  -> no visible change
 *
 * A no-op that looks precisely like a working feature is the worst shape a bug
 * can take: it survives a green gate, a green CI, and a prod verification that
 * checks the code shipped rather than the data moved.
 *
 * WHAT THIS ASSERTS. Every per-player stat fetch_fantasy_pool bothers to
 * collect must appear in the record build_player_records hands downstream.
 * Static, because the real fetch needs the network — but the defect was static
 * too: a key present in one dict literal and absent from another.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(join(REPO_ROOT, 'scripts/scrape/espn_players.py'), 'utf8');

/** The keys of the dict literal that follows `marker`, to its closing brace. */
function dictKeysAfter(marker) {
  const at = SRC.indexOf(marker);
  assert.ok(at > 0, `could not find ${marker} in espn_players.py`);
  const body = SRC.slice(at, SRC.indexOf('})', at));
  return new Set([...body.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]));
}

/* Identity/plumbing keys are renamed or derived on the way through, so they are
 * exempt by name. Everything else is a measured stat and must survive. */
const RENAMED = new Set(['espn_id', 'pro_team_id', 'name', 'position', 'injury_status']);

test('every stat the ESPN pool collects survives into the player record', () => {
  const collected = dictKeysAfter('pool.append({');
  const delivered = dictKeysAfter('records.append({');

  const lost = [...collected].filter((k) => !RENAMED.has(k) && !delivered.has(k));
  assert.deepEqual(lost, [],
    `espn_players.py collects ${lost.join(', ')} from ESPN and build_player_records `
    + 'drops it, so every consumer downstream reads a missing key as zero and the '
    + 'feed comes out byte-identical — a silent no-op, not a failure. Add the key '
    + 'to records.append({...}) or stop collecting it.');
});

test('completions and attempts specifically reach the record (R28 regression)', () => {
  // Named explicitly because this is the pair that was actually lost, and a
  // generic test can be weakened by loosening RENAMED without anyone noticing.
  const delivered = dictKeysAfter('records.append({');
  assert.ok(delivered.has('completions'),
    'completions are read from statId 1 and must reach build_predictions, or the '
    + 'league scoring pass_cmp prices every quarterback at zero extra points');
  assert.ok(delivered.has('pass_attempts'),
    'pass_attempts is what keeps the statId pairing reproducible downstream');
});

test('build_predictions still reads the key this file guarantees', () => {
  // The other half of the contract: the guarantee above is worthless if the
  // consumer renames what it looks for.
  const bp = readFileSync(join(REPO_ROOT, 'scripts/build_predictions.py'), 'utf8');
  assert.match(bp, /r\.get\("completions"/,
    'build_predictions must read "completions" from the record');
  assert.match(bp, /completions_by_id=completions_by_id/,
    'and pass it to build_weekly_document');
});
