/* app/data.js — THE JSON CONTRACT READER.
 *
 * Single source of truth for loading the data/*.json contracts the pipeline
 * emits. Every UI surface reads through these getters — no page fetches raw
 * JSON on its own. Keeps the client's view of the contract in exactly one place
 * so a schema change touches one file.
 *
 * Contracts (owned/validated by other agents + scripts/validate_data.py):
 *   data/player_projections.json  per-player season projections
 *   data/game_predictions.json    per-game probability vectors
 *   data/parlays.json             built parlays (>=3/game, >=3/week)
 *   data/meta.json                fitted weights, model versions, optimizer cfg
 *   data/pipeline_status.json     per-feed health (honest, may be "degraded")
 *   data/schedule_full.json       all 272 games, all 18 weeks (week selector)
 *   data/player_weekly.json       per-player 18-week split (may be ABSENT on
 *                                 older deploys — callers MUST catch rejection)
 *   data/ai_insights.json         Fit Engine v2 AI layer (may be ABSENT on
 *                                 older deploys — callers MUST catch rejection)
 *
 * Dependency-free: uses the platform `fetch` only. No build step, no framework.
 */

import { RUNTIME_CONFIG } from './runtime-config.js';

// Absolute paths from the site root so getters work under any hash route.
const PATHS = Object.freeze({
  playerProjections: '/data/player_projections.json',
  gamePredictions: '/data/game_predictions.json',
  parlays: '/data/parlays.json',
  meta: '/data/meta.json',
  pipelineStatus: '/data/pipeline_status.json',
  scheduleFull: '/data/schedule_full.json',
  playerWeekly: '/data/player_weekly.json',
  aiInsights: '/data/ai_insights.json',
  playerHistory: '/data/player_history.json',
  teamStrength: '/data/team_strength.json',
});

// In-memory cache: path -> Promise<json>. Caching the *promise* (not just the
// resolved value) de-dupes concurrent callers so a page that asks twice on the
// same tick issues a single network request.
const cache = new Map();

/**
 * Fetch + cache one JSON contract. `_headers` sets max-age=0/must-revalidate on
 * /data/*, so the browser cache handles freshness; this cache just avoids
 * redundant in-session fetches. Pass { force: true } to bypass it.
 */
async function loadJson(path, { force = false } = {}) {
  if (!force && cache.has(path)) return cache.get(path);

  const p = fetch(path, { credentials: 'same-origin' }).then((res) => {
    if (!res.ok) {
      throw new Error(`[data] ${path} -> HTTP ${res.status}`);
    }
    return res.json();
  });

  // Store immediately (the promise) so concurrent callers share it. On failure,
  // evict so a later call can retry instead of caching a rejected promise.
  cache.set(path, p);
  p.catch(() => cache.delete(path));
  return p;
}

// Public getters — one per contract. Thin wrappers so callers never hardcode a
// path and so the getter names document the available contracts.
export const getPlayerProjections = (opts) => loadJson(PATHS.playerProjections, opts);
export const getGamePredictions = (opts) => loadJson(PATHS.gamePredictions, opts);
export const getParlays = (opts) => loadJson(PATHS.parlays, opts);
export const getMeta = (opts) => loadJson(PATHS.meta, opts);
export const getPipelineStatus = (opts) => loadJson(PATHS.pipelineStatus, opts);
export const getScheduleFull = (opts) => loadJson(PATHS.scheduleFull, opts);
// player_weekly may 404 on a deploy that predates the weekly model. loadJson
// rejects with a clear "HTTP 404" error and EVICTS the cached promise, so the
// rejection is graceful (catchable, retryable) — views degrade, never blank.
export const getPlayerWeekly = (opts) => loadJson(PATHS.playerWeekly, opts);
// ai_insights feeds the TEAM tab's opt-in AI+ toggle (Fit Engine v2). Same
// 404-graceful promise-cache pattern as player_weekly: on a deploy without the
// file the getter rejects cleanly and the view simply hides the toggle.
export const getAiInsights = (opts) => loadJson(PATHS.aiInsights, opts);
// player_history (5-yr per-season lines + trajectory) and team_strength (per-
// team Elo for strength-of-schedule) are both REL2 additions. Same 404-graceful
// promise-cache pattern: a deploy predating them rejects cleanly and the trend /
// SoS adornments simply don't render — the views never blank.
export const getPlayerHistory = (opts) => loadJson(PATHS.playerHistory, opts);
export const getTeamStrength = (opts) => loadJson(PATHS.teamStrength, opts);

/**
 * Load every contract at once. Uses allSettled so one bad feed does not blank
 * the others — the caller sees exactly which contracts resolved. This is what
 * main.js uses to prove the JSON contract end to end.
 */
export async function getAll(opts) {
  const entries = [
    ['playerProjections', getPlayerProjections],
    ['gamePredictions', getGamePredictions],
    ['parlays', getParlays],
    ['meta', getMeta],
    ['pipelineStatus', getPipelineStatus],
  ];
  const settled = await Promise.allSettled(entries.map(([, fn]) => fn(opts)));
  const out = {};
  settled.forEach((r, i) => {
    const key = entries[i][0];
    out[key] = r.status === 'fulfilled' ? r.value : { __error: String(r.reason) };
  });
  return out;
}

/** Drop all cached contracts (e.g. after a known data refresh). */
export function clearCache() {
  cache.clear();
}

// Re-export config so callers can reach liveApi/env without a second import.
export { RUNTIME_CONFIG };
