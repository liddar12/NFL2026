// signal_registry.test.mjs — every registry signal is present in meta.json at 0.0.
//
// The "Dominance started at 0" rule: on day zero nothing has earned weight. This
// test reads data/meta.json (owned by Agent 6, mirroring scripts/signals/registry.py)
// and asserts EVERY expected signal name is present and set to exactly 0.0, that
// the count matches, and that there are no unexpected extras. The name list here
// must match registry.py byte-for-byte.
//
// Node built-ins only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The full registry, in group order (player 19, game 10, market 3 = 32).
const EXPECTED = [
  // player
  "prior_perf", "age_curve", "injury_status", "injury_history",
  "ol_composite_vs_dl", "target_competition", "qb_accuracy_delta",
  "qb_coaching", "coordinator_change", "head_coach_change", "scheme_fit",
  "supporting_cast_delta", "one_on_one_matchup", "schedule_strength",
  "home_away", "indoor_outdoor", "weather", "rest_days", "off_field",
  // game
  "elo", "market_spread", "market_moneyline", "market_total", "j5l_composite",
  "home_field", "rest_differential", "travel", "weather_game", "injury_impact",
  // market
  "odds_api", "kalshi", "polymarket",
];

const meta = JSON.parse(
  readFileSync(new URL("../../data/meta.json", import.meta.url), "utf8"),
);

test("meta.json exposes a weights map", () => {
  assert.ok(meta.weights && typeof meta.weights === "object");
});

test("every registry signal is present at exactly 0.0", () => {
  for (const name of EXPECTED) {
    assert.ok(name in meta.weights, `missing signal '${name}'`);
    assert.strictEqual(
      meta.weights[name],
      0.0,
      `signal '${name}' must be 0.0 on day zero, got ${meta.weights[name]}`,
    );
  }
});

test("no unexpected signals leaked into the weights map", () => {
  const extra = Object.keys(meta.weights).filter((k) => !EXPECTED.includes(k));
  assert.deepEqual(extra, [], `unexpected signals: ${extra.join(", ")}`);
});

test("signal count matches exactly (32)", () => {
  assert.equal(EXPECTED.length, 32);
  assert.equal(Object.keys(meta.weights).length, EXPECTED.length);
});
