// real_data.test.mjs — locks the N2 (real player projections) + P1 (snapshot
// lock) behavior introduced when the pipeline went live on ESPN data.
//
// These assertions run against the COMMITTED data files, so the gate catches a
// pipeline regression (short pull, drifted shape, dishonest lock) before deploy.
// Node built-ins only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

const TEAMS = new Set([
  "ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB",
  "HOU","IND","JAX","KC","LV","LAC","LAR","MIA","MIN","NE","NO","NYG","NYJ",
  "PHI","PIT","SF","SEA","TB","TEN","WAS",
]);
const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

// ---------------------------------------------------------------------------
// N2 — real player projections.
// ---------------------------------------------------------------------------
const proj = read("../../data/player_projections.json");

test("player projections carry a real league-sized pool (>=150 players)", () => {
  // The fixture era had 8 sample players; the real feed carries hundreds. A
  // sudden shrink means a silent short pull (the loud-feeds failure mode).
  assert.ok(
    proj.players.length >= 150,
    `expected >=150 real players, got ${proj.players.length}`,
  );
});

test("every projection row is well-formed and internally consistent", () => {
  const seen = new Set();
  for (const p of proj.players) {
    assert.ok(TEAMS.has(p.team), `${p.name}: bad team ${p.team}`);
    assert.ok(POSITIONS.has(p.position), `${p.name}: bad position ${p.position}`);
    assert.ok(p.gsis_id && !seen.has(p.gsis_id), `${p.name}: duplicate/empty id`);
    seen.add(p.gsis_id);
    assert.ok(
      p.low <= p.proj_points && p.proj_points <= p.high,
      `${p.name}: interval [${p.low}, ${p.high}] must contain proj ${p.proj_points}`,
    );
    assert.ok(p.proj_points > 0, `${p.name}: non-positive projection`);
  }
});

test("projections are sorted best-first (stable presentation contract)", () => {
  for (let i = 1; i < proj.players.length; i++) {
    assert.ok(
      proj.players[i - 1].proj_points >= proj.players[i].proj_points,
      `sort violated at index ${i}`,
    );
  }
});

test("day-zero honesty: no player signal claims weight it has not earned", () => {
  // meta.json weights are all 0.0 until the optimizer earns them in, so no
  // projection row may claim an applied signal. When weights first move, this
  // test must be UPDATED alongside meta.json — that is the audit trail.
  const meta = read("../../data/meta.json");
  const anyWeight = Object.values(meta.weights).some((w) => w !== 0);
  if (!anyWeight) {
    for (const p of proj.players) {
      assert.deepEqual(
        p.signals_used, [],
        `${p.name} claims signals ${p.signals_used} while all weights are 0.0`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// P1 — the point-in-time snapshot lock.
// ---------------------------------------------------------------------------
const snapDir = fileURLToPath(new URL("../../data/snapshots/", import.meta.url));

test("an opening game lock exists for the current slate week", () => {
  const games = read("../../data/game_predictions.json");
  const lock = `${games.season}_wk${String(games.week).padStart(2, "0")}_games_open.json`;
  assert.ok(
    existsSync(snapDir + lock),
    `missing ${lock} — predictions are being served without a point-in-time lock`,
  );
});

test("every snapshot row is an honest, measurable, unresolved-or-scored lock", () => {
  const files = readdirSync(snapDir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 1, "no snapshot files at all");
  for (const f of files) {
    const rows = JSON.parse(readFileSync(snapDir + f, "utf8"));
    assert.ok(Array.isArray(rows) && rows.length > 0, `${f}: empty snapshot`);
    for (const r of rows) {
      // Locked game rows are measurable predictions: estimate=false + a probs
      // vector that sums to ~1. The honesty contract: brier/log_loss appear
      // ONLY on resolved measurable rows.
      assert.equal(r.estimate, false, `${f}:${r.event_id} lock must be measurable`);
      assert.ok(Array.isArray(r.probs), `${f}:${r.event_id} lock needs probs`);
      const sum = r.probs.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) < 0.02, `${f}:${r.event_id} probs sum ${sum}`);
      if (!r.resolved) {
        assert.ok(r.brier == null, `${f}:${r.event_id} unresolved row carries brier`);
        assert.ok(r.log_loss == null, `${f}:${r.event_id} unresolved row carries log_loss`);
      } else {
        assert.equal(typeof r.brier, "number", `${f}:${r.event_id} resolved row needs brier`);
        assert.equal(typeof r.log_loss, "number", `${f}:${r.event_id} resolved row needs log_loss`);
      }
    }
  }
});
