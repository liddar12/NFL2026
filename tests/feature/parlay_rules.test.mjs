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
// The slate the parlays must cover is whatever game_predictions.json carries —
// derived, not hardcoded, so the invariant holds for fixture AND real data.
const gamesDoc = JSON.parse(
  readFileSync(new URL("../../data/game_predictions.json", import.meta.url), "utf8"),
);
const slateIds = new Set(gamesDoc.games.map((g) => g.game_id));

test("parlays file has the expected envelope", () => {
  assert.equal(doc.season, 2026);
  assert.equal(doc.week, gamesDoc.week, "parlays week must match the slate week");
  assert.ok(Array.isArray(parlays) && parlays.length > 0);
});

test(">= 3 parlays scope='game' for EVERY game on the slate", () => {
  const perGame = new Map();
  for (const p of parlays) {
    if (p.scope === "game") perGame.set(p.game_id, (perGame.get(p.game_id) || 0) + 1);
  }
  for (const gid of slateIds) {
    assert.ok(
      (perGame.get(gid) || 0) >= 3,
      `expected >=3 game parlays for ${gid}, got ${perGame.get(gid) || 0}`,
    );
  }
});

test("every game-scope parlay references a game that exists on the slate", () => {
  for (const p of parlays) {
    if (p.scope !== "game") continue;
    assert.ok(
      slateIds.has(p.game_id),
      `parlay ${p.parlay_id} references unknown game_id ${p.game_id} — ` +
        `parlays and game_predictions have drifted apart`,
    );
  }
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
