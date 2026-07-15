// parlay_rules.test.mjs — the parlay-builder invariants, locked.
//
// From data/parlays.json (owned by Agent 6, produced by parlay_builder.py):
//   * >= 3 parlays scope="game" for the sample game, AND >= 3 scope="week".
//   * correlation-awareness: any same-game (scope="game") parlay with >1 leg MUST
//     carry a non-empty correlation_note (independence is the wrong default when
//     legs share a game script). Week parlays across different games may state
//     "independent legs" but the note is still required (schema-enforced).
//
// Node built-ins only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = JSON.parse(
  readFileSync(new URL("../../data/parlays.json", import.meta.url), "utf8"),
);
const parlays = doc.parlays;
const SAMPLE_GAME = "2026_01_BAL_KC";

test("parlays file has the expected envelope", () => {
  assert.equal(doc.season, 2026);
  assert.equal(doc.week, 1);
  assert.ok(Array.isArray(parlays) && parlays.length > 0);
});

test(">= 3 parlays scope='game' for the sample game", () => {
  const gameParlays = parlays.filter(
    (p) => p.scope === "game" && p.game_id === SAMPLE_GAME,
  );
  assert.ok(
    gameParlays.length >= 3,
    `expected >=3 game parlays for ${SAMPLE_GAME}, got ${gameParlays.length}`,
  );
});

test(">= 3 parlays scope='week'", () => {
  const weekParlays = parlays.filter((p) => p.scope === "week");
  assert.ok(weekParlays.length >= 3, `expected >=3 week parlays, got ${weekParlays.length}`);
});

test("same-game multi-leg parlays carry a non-empty correlation_note", () => {
  const sameGameMultiLeg = parlays.filter(
    (p) => p.scope === "game" && p.legs.length > 1,
  );
  assert.ok(sameGameMultiLeg.length >= 1, "expected at least one same-game multi-leg parlay");
  for (const p of sameGameMultiLeg) {
    assert.ok(
      typeof p.correlation_note === "string" && p.correlation_note.trim().length > 0,
      `parlay ${p.parlay_id} must carry a non-empty correlation_note`,
    );
  }
});

test("every parlay has legs, an EV, a confidence tier and a correlation note", () => {
  const tiers = new Set(["high", "medium", "low"]);
  for (const p of parlays) {
    assert.ok(Array.isArray(p.legs) && p.legs.length >= 1, `${p.parlay_id} needs legs`);
    assert.equal(typeof p.model_ev, "number", `${p.parlay_id} needs numeric model_ev`);
    assert.ok(tiers.has(p.confidence_tier), `${p.parlay_id} bad tier ${p.confidence_tier}`);
    assert.ok(
      typeof p.correlation_note === "string" && p.correlation_note.trim().length > 0,
      `${p.parlay_id} needs a correlation_note`,
    );
    // Every leg's probabilities are valid.
    for (const leg of p.legs) {
      assert.ok(leg.implied_prob >= 0 && leg.implied_prob <= 1);
      assert.ok(leg.model_prob >= 0 && leg.model_prob <= 1);
    }
  }
});
