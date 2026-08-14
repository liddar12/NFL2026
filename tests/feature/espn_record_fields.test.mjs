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
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const SRC = read('scripts/scrape/espn_players.py');

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

/* ==========================================================================
   THE CONTRACT MUST ACCEPT WHAT THE BUILDER WRITES
   ========================================================================== */

test('player_weekly.schema.json accepts completions_prior (R29 pipeline failure)', () => {
  /* WHAT HAPPENED. R29 merged with a fully green gate and then FAILED THE
   * PIPELINE: build_weekly wrote completions_prior for 52 quarterbacks,
   * player_weekly.schema.json has additionalProperties:false and had never
   * heard of the key, and validate_data rejected the document — so the run died
   * before committing and prod kept the old, completion-free feed.
   *
   * WHY THE LOCAL GATE COULD NOT CATCH IT. validate_data checks the data file
   * ON DISK, and the committed player_weekly.json has no completions_prior at
   * all: the field only appears after a live ESPN fetch, which the sandbox
   * cannot perform. So the schema was never once tested against a document
   * that actually contained the thing it rejects. A gate that only ever sees
   * yesterday's data cannot validate tomorrow's field.
   *
   * The fix is to assert the CONTRACT directly, against a document shaped the
   * way the builder really writes one, rather than waiting for a fetch to
   * produce it.
   */
  const schema = JSON.parse(read('data/contracts/player_weekly.schema.json'));
  const item = schema.properties.players.items;

  assert.equal(item.additionalProperties, false,
    'this schema is strict by design — which is exactly why a new field must be '
    + 'declared here in the same change that starts writing it');
  assert.ok(item.properties.completions_prior,
    'build_weekly writes completions_prior; the contract must accept it, or the '
    + 'pipeline fails validation and never commits');
  assert.equal(item.properties.completions_prior.type, 'number');
  assert.ok(!(item.required || []).includes('completions_prior'),
    'it is OMITTED when zero or unknown — requiring it would fail every '
    + 'non-passer and contradict the builder');
});

test('every key build_weekly can emit is declared in the contract', () => {
  // The general form: whatever row keys build_weekly.py assigns must all be
  // known to a schema that forbids anything else. Catches the next field too,
  // not just this one.
  const src = read('scripts/build_weekly.py');
  const schema = JSON.parse(read('data/contracts/player_weekly.schema.json'));
  const declared = new Set(Object.keys(schema.properties.players.items.properties));

  /* PLAYER-ROW keys only. The first cut matched any 8-space-indented dict key
   * and swept in the document's own top-level fields (season, updated_utc) and
   * the availability sub-object's (applied, unavailable, ...), none of which
   * live in players[].items — a test that reports work it is not doing is
   * worse than no test. So: the `row = { ... }` literal, plus every explicit
   * row["key"] = assignment. */
  const emitted = new Set();
  const literal = src.match(/row = \{([\s\S]*?)\n {8}\}/);
  if (literal) for (const m of literal[1].matchAll(/"([a-z_]+)":/g)) emitted.add(m[1]);
  for (const m of src.matchAll(/row\["([a-z_]+)"\]\s*=/g)) emitted.add(m[1]);
  assert.ok(emitted.has('receptions_prior') && emitted.has('completions_prior'),
    'the extraction must actually find the row keys, or this test proves nothing');

  const undeclared = [...emitted].filter((k) => !declared.has(k));
  assert.deepEqual(undeclared, [],
    `build_weekly.py can emit ${undeclared.join(', ')}, which player_weekly.schema.json `
    + 'does not declare while forbidding additional properties — the pipeline would '
    + 'write it, validate_data would reject the document, and the run would fail '
    + 'AFTER doing all its work');
});
