/* app/sleeper-proj.js — SLEEPER'S OWN PROJECTIONS, display-only (R49).
 *
 * data/sleeper_projections.json is Sleeper's non-AI weekly projection table
 * (weeks 1-18 of stat lines per player), captured by the daily runner and
 * reduced to the players this app can address. This module is the ONLY reader.
 * Everything it produces is a NUMBER TO SHOW BESIDE OURS — it never becomes an
 * input to a projection, a weight, a sort or a lineup (owner's decision; the
 * contract itself carries display_only:true and this module refuses a doc that
 * does not).
 *
 * PRICING. Sleeper publishes pts_ppr/pts_std convenience totals; they are kept
 * in `raw` for reference and never shown as the headline. Every week is
 * re-priced EXACTLY under the saved league's scoring table — the same
 * per-stat arithmetic app/league.js applyScoring does (only keys present in
 * BOTH the stat line and the table count) — so a Sleeper number and OUR number
 * on the same card are in the same units. One profile normalisation per
 * shape, not one per week: a full doc is ~250 players x 18 weeks.
 *
 * HONESTY:
 *   - a week Sleeper does not project is null, never 0 (a bye and "no row"
 *     are both null here — the display shows an em dash, never 0.0);
 *   - a player without an app_id cannot be matched to a card; he is counted
 *     in coverage and otherwise ignored — never matched by name guess;
 *   - `season` is the sum of the weeks Sleeper DID project, null when none;
 *   - gapReason() names a cause only when the data shows one.
 *
 * Fetch is promise-cached and 404-graceful like app/kdst.js. It lives here
 * (not app/data.js) so the contract is fetched LAZILY by the views that show
 * it, after their first paint, never inside a mount's Promise.allSettled.
 */

import { normalizeProfile, applyScoring } from './league.js';

/** Site-root path of the contract (mirrors the runner's output path). */
export const SLEEPER_PROJ_PATH = '/data/sleeper_projections.json';

/** Regular-season week count the `weeks` array is sized to. */
export const WEEKS = 18;

/** The gap (as a fraction of the Sleeper number) past which a reason is owed. */
export const GAP_THRESHOLD = 0.20;

/* --------------------------------------------------------------------------
 * Fetch — promise-cached for the session, null on 404 / parse error
 * ------------------------------------------------------------------------ */

let inflight = null;

/**
 * Load the contract. Resolves to the parsed doc, or NULL when the file is
 * absent (404 is a normal state — the runner may not have produced it yet),
 * unreadable, or the network failed. NEVER rejects. A 404 is cached for the
 * session (asking again will not make the file appear); a network/parse
 * failure is evicted so a later call can retry.
 */
export function getSleeperProjections({ force = false } = {}) {
  if (!force && inflight) return inflight;
  const p = fetch(SLEEPER_PROJ_PATH, { credentials: 'same-origin' })
    .then((res) => {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`[sleeper-proj] HTTP ${res.status}`);
      return res.json();
    })
    .catch(() => {
      if (inflight === p) inflight = null;
      return null;
    });
  inflight = p;
  return p;
}

/** Drop the cached promise (tests / a forced refresh). */
export function clearSleeperCache() { inflight = null; }

/* --------------------------------------------------------------------------
 * Shaping
 * ------------------------------------------------------------------------ */

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Price one stat line under an already-normalised scoring table: exactly
 * applyScoring's rule (keys present in BOTH, finite on both sides) without
 * re-normalising the profile per call. Locked equal to applyScoring in
 * tests/feature/r49_sleeper_display.test.mjs.
 */
function priceLine(stats, scoring, keys) {
  let total = 0;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(stats, key)) continue;
    const v = num(stats[key]);
    if (v === null) continue;
    total += v * scoring[key];
  }
  return total;
}

/**
 * Shape the contract for display under a league profile.
 *
 * Returns {
 *   ok, generated_utc, season, display_only,
 *   byAppId:     Map<app_id, entry>     — the cards' key (pool gsis_id / kdst id)
 *   bySleeperId: Map<sleeper_id, entry> — for callers holding Sleeper ids
 *   coverage:    { players, matched }   — rows in the doc / rows with an app_id
 * }
 * entry = { sleeper_id, app_id, name, position, team,
 *           weeks: Array(18) number|null  (league-priced; null = no row),
 *           season: number|null           (sum of priced weeks; null = none),
 *           projectedWeeks: number,
 *           raw: { pts_ppr: Array(18) number|null } }
 *
 * A null/absent/invalid doc, or one not marked display_only, yields ok:false
 * with empty maps — the caller renders nothing Sleeper-related.
 */
export function shapeSleeper(doc, profile) {
  const out = {
    ok: false, generated_utc: null, season: null, display_only: false,
    byAppId: new Map(), bySleeperId: new Map(),
    coverage: { players: 0, matched: 0 },
  };
  if (!isObj(doc) || !Array.isArray(doc.players)) return out;
  if (doc.display_only !== true) return out; // never show a doc that claims to be more
  const p = normalizeProfile(profile);
  const scoring = p.scoring;
  const keys = Object.keys(scoring).filter((k) => Number.isFinite(Number(scoring[k])));

  out.ok = true;
  out.display_only = true;
  out.generated_utc = typeof doc.generated_utc === 'string' ? doc.generated_utc : null;
  out.season = num(doc.season);

  for (const row of doc.players) {
    if (!isObj(row)) continue;
    out.coverage.players += 1;
    const weeks = new Array(WEEKS).fill(null);
    const ppr = new Array(WEEKS).fill(null);
    let seasonSum = 0;
    let projected = 0;
    const src = isObj(row.weeks) ? row.weeks : {};
    for (let w = 1; w <= WEEKS; w++) {
      const line = src[String(w)];
      if (!isObj(line)) continue;
      const pts = priceLine(line, scoring, keys);
      weeks[w - 1] = round2(pts);
      ppr[w - 1] = num(line.pts_ppr);
      seasonSum += pts;
      projected += 1;
    }
    const entry = {
      sleeper_id: row.sleeper_id == null ? null : String(row.sleeper_id),
      app_id: row.app_id == null ? null : String(row.app_id),
      name: row.name == null ? '' : String(row.name),
      position: row.position == null ? '' : String(row.position).toUpperCase(),
      team: row.team == null ? '' : String(row.team).toUpperCase(),
      weeks,
      season: projected ? round2(seasonSum) : null,
      projectedWeeks: projected,
      raw: { pts_ppr: ppr },
    };
    if (entry.sleeper_id) out.bySleeperId.set(entry.sleeper_id, entry);
    if (entry.app_id) {
      out.coverage.matched += 1;
      out.byAppId.set(entry.app_id, entry);
    }
  }
  return out;
}

/** One shaped entry's league-priced points for `week` (1-18), or null. */
export function sleeperWeek(entry, week) {
  const w = Number(week);
  if (!entry || !Array.isArray(entry.weeks) || !Number.isFinite(w)) return null;
  if (w < 1 || w > entry.weeks.length) return null;
  const v = entry.weeks[w - 1];
  return Number.isFinite(v) ? v : null;
}

/**
 * Rest-of-season under Sleeper: the sum of priced weeks >= fromWeek. null
 * when Sleeper projects none of them (never 0 for "no rows").
 */
export function rosSleeper(entry, fromWeek) {
  const from = Math.max(1, Math.round(Number(fromWeek) || 1));
  if (!entry || !Array.isArray(entry.weeks)) return null;
  let sum = 0;
  let n = 0;
  for (let w = from; w <= entry.weeks.length; w++) {
    const v = entry.weeks[w - 1];
    if (!Number.isFinite(v)) continue;
    sum += v;
    n += 1;
  }
  return n ? round2(sum) : null;
}

/**
 * Sum one league-priced Sleeper week (or the season, week=null) over a set of
 * app ids — a lineup, a roster. Returns { points, covered, total }: `points`
 * is the sum over the players Sleeper projects, `covered` how many of the
 * `total` ids that is. A player Sleeper lacks contributes NOTHING and is
 * reported in the coverage instead — the caller prints "8/9 projected".
 * points is null when covered is 0.
 */
export function sumSleeper(byAppId, ids, week = null) {
  const list = Array.isArray(ids) ? ids.filter((id) => id != null) : [];
  let points = 0;
  let covered = 0;
  for (const id of list) {
    const e = byAppId instanceof Map ? byAppId.get(String(id)) : null;
    const v = week == null ? (e ? e.season : null) : sleeperWeek(e, week);
    if (!Number.isFinite(v)) continue;
    points += v;
    covered += 1;
  }
  return { points: covered ? round2(points) : null, covered, total: list.length };
}

/* --------------------------------------------------------------------------
 * Comparison helpers (pure)
 * ------------------------------------------------------------------------ */

/**
 * Signed percentage of `other` relative to `ours` ((other - ours) / ours),
 * rounded to a whole percent; null when either side is absent or OURS is 0.
 * "Deltas vs OURS" — the same reading for SCENARIO and SLEEPER.
 */
export function deltaPct(ours, other) {
  const a = num(ours);
  const b = num(other);
  if (a === null || b === null || a === 0) return null;
  const raw = ((b - a) / Math.abs(a)) * 100;
  return Math.sign(raw) * Math.round(Math.abs(raw)); // symmetric: −37.5 -> −38
}

/** "+23%" / "−18%" / "0%" for a deltaPct value; '' for null. */
export function fmtDelta(pct) {
  if (!Number.isFinite(pct)) return '';
  if (pct === 0) return '0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`;
}

/**
 * The one-line reason owed when OURS and Sleeper disagree by more than 20% of
 * the Sleeper number (|ours − sleeper| / max(sleeper, 1)). Inside the band:
 * ''. Absent sides get their own honest line. Outside the band the reason
 * names the ONLY cause the data can show — the documented baseline rule
 * (ctx.baselineRule, from meta.projection_baseline) — and otherwise says the
 * cause is not recorded rather than inventing one.
 */
export function gapReason(ours, sleeper, ctx = {}) {
  const a = num(ours);
  const b = num(sleeper);
  if (b === null && a === null) return 'Neither engine projects this player';
  if (b === null) return 'Sleeper does not project this player';
  if (a === null) return 'No projection on our side';
  const gap = Math.abs(a - b) / Math.max(b, 1);
  if (gap <= GAP_THRESHOLD) return '';
  const pctTxt = `${Math.round(gap * 100)}%`;
  if (ctx && typeof ctx.baselineRule === 'string' && ctx.baselineRule.trim()) {
    return `Our baseline is ${ctx.baselineRule.trim()}; Sleeper projects forward stats`
      + ` (${pctTxt} apart)`;
  }
  return `Our projection and Sleeper's are ${pctTxt} apart — different engines; `
    + 'no cause is recorded in the data';
}

/**
 * The SCENARIO number (R49 addendum): the pipeline's CANDIDATE projection —
 * the games-normalised baseline with every raw signal applied at full
 * strength, labelled candidate, NOT adopted — priced into the same units as
 * the shipped number on the card.
 *
 * `shipped` is the league-priced season number the card shows (projSeason);
 * `p.proj_points` is the shipped full-PPR base. The candidate is priced by the
 * SAME ratio (shipped ÷ base) — i.e. receptions and league-rule extras are
 * assumed to move in proportion to production. That is exact when nothing is
 * converted (PPR, no league extras) and an approximation otherwise; `approx`
 * says which so the view can mark it (≈) and the note can say so. Never a
 * raw PPR number beside a league-priced one.
 *
 * Returns null when the record carries no candidate_points (older data).
 */
export function scenarioOf(p, opts) {
  return altOf(p, 'candidate', opts);
}

/**
 * R49 follow-up — the GATED number: when the owner overrides the gate and
 * ships the SCENARIO candidate, every record keeps the previous
 * gate-conforming projection as gated_points/gated_low/gated_high. Priced
 * into the card's units exactly as scenarioOf prices the candidate. null
 * when the record carries no gated_points (gated mode / older data).
 */
export function gatedOf(p, opts) {
  return altOf(p, 'gated', opts);
}

function altOf(p, prefix, { shipped, extra = 0 } = {}) {
  const c = num(p && p[`${prefix}_points`]);
  if (c === null) return null;
  const base = num(p.proj_points);
  const s = num(shipped);
  const ratio = (base !== null && base > 0 && s !== null) ? s / base : 1;
  const lo = num(p[`${prefix}_low`]);
  const hi = num(p[`${prefix}_high`]);
  const sdRaw = (lo !== null && hi !== null && hi >= lo) ? (hi - lo) / 2 : null;
  return {
    points: round2(c * ratio),
    sd: sdRaw === null ? null : round2(sdRaw * ratio),
    ratio,
    approx: ratio !== 1 && Number(extra) !== 0,
  };
}

/**
 * R49 follow-up — WHICH number ships, from meta.projection_baseline.shipped:
 *   { mode: 'candidate' | 'gated', ownerOverride, decidedUtc, reason,
 *     backtest: { gated_mae, candidate_mae, band_coverage_after_calibration } | null,
 *     oursRule }
 * 'candidate' means proj_points IS the SCENARIO candidate (an explicit owner
 * override of the gate) and gated_* carries the gate-conforming number.
 * An absent key, or anything but 'candidate', is 'gated' — today's layout.
 * `oursRule` names the rule OURS actually follows (the candidate rule in
 * candidate mode, the shipped_rule otherwise) so a gap reason never cites
 * the wrong baseline. Pure, never throws.
 */
export function shippedMode(meta) {
  const pb = meta && isObj(meta.projection_baseline) ? meta.projection_baseline : null;
  const sh = pb && isObj(pb.shipped) ? pb.shipped : null;
  const mode = sh && sh.mode === 'candidate' ? 'candidate' : 'gated';
  const rule = (k) => (pb && typeof pb[k] === 'string' && pb[k].trim() ? pb[k].trim() : null);
  return {
    mode,
    ownerOverride: Boolean(sh && sh.owner_override === true),
    decidedUtc: sh && typeof sh.decided_utc === 'string' ? sh.decided_utc : null,
    reason: sh && typeof sh.reason === 'string' ? sh.reason : '',
    backtest: sh && isObj(sh.backtest_2025) ? sh.backtest_2025 : null,
    oursRule: mode === 'candidate' ? rule('rule') : (rule('shipped_rule') || null),
  };
}

/**
 * The biggest scenario moves, from candidate_signals {name: raw_adj}
 * (fractions: -0.12 = −12%), largest magnitude first, capped to `limit`.
 * Returns [{ name, adj }]; [] when absent. Zero moves are dropped.
 */
export function scenarioMoves(p, limit = 3) {
  const sig = p && isObj(p.candidate_signals) ? p.candidate_signals : null;
  if (!sig) return [];
  return Object.keys(sig)
    .map((name) => ({ name, adj: num(sig[name]) }))
    .filter((r) => r.adj !== null && r.adj !== 0)
    .sort((a, b) => Math.abs(b.adj) - Math.abs(a.adj) || (a.name < b.name ? -1 : 1))
    .slice(0, Math.max(0, limit));
}

/** "injury −12% · teammates +6%" for scenarioMoves(); '' when none. */
export function fmtMoves(moves) {
  return (Array.isArray(moves) ? moves : []).map((m) => {
    const pct = Math.round(m.adj * 100);
    const sign = pct > 0 ? '+' : (pct < 0 ? '−' : '');
    return `${String(m.name).replace(/_/g, ' ')} ${sign}${Math.abs(pct)}%`;
  }).join(' · ');
}

/* --------------------------------------------------------------------------
 * Self-test (node --test imports this; the browser never calls it)
 * ------------------------------------------------------------------------ */

/** Cheap invariants, exported for the unit tests. */
export function __selftest() {
  const prof = normalizeProfile({ scoring: { pass_yd: 0.04, rec: 1 } });
  const doc = {
    display_only: true,
    players: [{ sleeper_id: '1', app_id: 'a', name: 'A', weeks: { 1: { pass_yd: 100, rec: 2 } } }],
  };
  const s = shapeSleeper(doc, prof);
  const e = s.byAppId.get('a');
  const ok = e && e.weeks[0] === 6 && e.weeks[1] === null && e.season === 6
    && e.weeks[0] === round2(applyScoring({ pass_yd: 100, rec: 2 }, prof));
  return { ok: Boolean(ok) };
}

/* ------------------------------------------------------------------ rows */
// Moved here from app/views/players.js (R49 follow-up): pure renderers that
// are only needed once this lazy module has landed, so the boot path does not
// carry them. `esc` / `fix1` are local on purpose (no import back into a view).
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const fix1 = (n) => Number(n).toFixed(1);

/** The anchor the estimate rows are spliced in front of: after the card's own
 * projection lines (number, adornments, conformal band), before the signals. */
const ESTIMATE_ANCHOR = '<div class="sigs">';

/**
 * Compose a rendered card with the R49 estimate rows. Same contract as
 * withExtraRow: no anchor -> the card is returned untouched, never broken.
 */
export function withEstimateRow(cardHtml, rowsHtml) {
  if (!rowsHtml) return cardHtml;
  const i = String(cardHtml).indexOf(ESTIMATE_ANCHOR);
  if (i < 0) return cardHtml;
  return `${cardHtml.slice(0, i)}${rowsHtml}${cardHtml.slice(i)}`;
}

/**
 * The compact estimate rows, PURE (unit-tested with a candidate-carrying
 * record and the absent case):
 *   line 1  OURS <season> · SCENARIO <candidate> ±<sd> <delta> · SLEEPER <season> <delta>
 *   line 2  WK n · OURS x · SCENARIO y · SLEEPER z      (this week)
 *   line 3  the biggest scenario moves (capped to three) — when any
 *   line 4  the gapReason line — when the gap exceeds 20%
 * Deltas are vs OURS. An absent SCENARIO renders nothing (older data). An
 * absent Sleeper DOC renders nothing Sleeper-related (the runner may not have
 * produced the file yet); a doc that lacks THIS player renders an em dash —
 * never 0.0. A "≈" marks a scenario scaled through league-rule extras (an
 * approximation the legend explains). Returns '' when there is nothing to say.
 */
export function renderEstimateRow(o = {}) {
  // null/undefined is ABSENT (Number(null) is 0 — the one lie this row must
  // never tell), so every value passes through isNum before it is shown.
  const isNum = (v) => v != null && Number.isFinite(Number(v));
  const ours = isNum(o.ours) ? Number(o.ours) : null;
  const haveOurs = ours !== null;
  // R49 follow-up — mode 'candidate': OURS IS the scenario (owner override);
  // the SCENARIO cell is never shown twice, GATED takes its place (when the
  // record carries it — absent renders nothing), and the moves explain OURS.
  const candidateMode = o.mode === 'candidate';
  const sc = !candidateMode && o.scenario && isNum(o.scenario.points) ? o.scenario : null;
  const gt = candidateMode && o.gated && isNum(o.gated.points) ? o.gated : null;
  const slLoaded = o.sleeperLoaded === true;
  if (!sc && !gt && !slLoaded && !(candidateMode && o.moves)) return '';
  const delta = (v) => {
    if (!haveOurs || !isNum(v) || ours === 0) return '';
    const raw = ((Number(v) - ours) / Math.abs(ours)) * 100;
    const pct = Math.round(Math.abs(raw)); // symmetric: −37.5 -> −38, +37.5 -> +38
    return pct === 0 ? '0%' : `${raw > 0 ? '+' : '−'}${pct}%`;
  };
  const cell = (lbl, val, meta, cls) => (
    `<span class="pe-lbl">${lbl}</span>`
    + (val == null
      ? `<b class="${cls} pe-none">—</b>`
      : `<b class="${cls}">${esc(val)}</b>`)
    + (meta ? `<span class="pe-meta">${esc(meta)}</span>` : '')
  );
  const oursMeta = candidateMode
    ? ['scenario', isNum(o.oursSd) ? `±${fix1(o.oursSd)}` : ''].filter(Boolean).join(' · ')
    : '';
  let line1 = cell('OURS', haveOurs ? fix1(ours) : null, oursMeta, 'pe-us');
  if (gt) {
    const sd = isNum(gt.sd) ? `±${fix1(gt.sd)}` : '';
    line1 += cell('GATED', `${gt.approx ? '≈' : ''}${fix1(gt.points)}`,
      [delta(gt.points), sd].filter(Boolean).join(' · '), 'pe-gt');
  }
  if (sc) {
    const sd = isNum(sc.sd) ? `±${fix1(sc.sd)}` : '';
    const d = delta(sc.points);
    line1 += cell('SCENARIO', `${sc.approx ? '≈' : ''}${fix1(sc.points)}`,
      [sd, d].filter(Boolean).join(' · '), 'pe-sc');
  }
  if (slLoaded) {
    const have = isNum(o.sleeper);
    line1 += cell('SLEEPER', have ? fix1(o.sleeper) : null, have ? delta(o.sleeper) : '', 'pe-sl');
  }
  const title = (candidateMode
    ? 'OURS is the SCENARIO candidate — every raw signal applied at full strength — '
      + 'shipped by owner override of the gate, in your scoring. '
      + (gt ? 'GATED is the number the gate would have shipped, in the same units. ' : '')
    : 'OURS is this app\'s projection in your scoring. SCENARIO is the '
      + 'self-learning candidate (every raw signal applied at full strength, backtested, '
      + 'NOT adopted) in the same units. ')
    + 'SLEEPER is Sleeper\'s own projection priced under '
    + 'your scoring table — shown for comparison, never an input. Deltas are vs OURS.';
  let html = `<div class="p-est" title="${esc(title)}">${line1}</div>`;
  const wk = Number(o.week);
  if (Number.isFinite(wk) && (isNum(o.oursWk) || slLoaded)) {
    const f = (v) => (isNum(v) ? fix1(v) : '—');
    let wkLine = `WK ${wk} · OURS ${f(o.oursWk)}`;
    if (gt) wkLine += ` · GATED ${f(o.gatedWk)}`;
    if (sc) wkLine += ` · SCENARIO ${f(o.scenarioWk)}`;
    if (slLoaded) wkLine += ` · SLEEPER ${f(o.sleeperWk)}`;
    html += `<div class="p-est p-est--wk">${esc(wkLine)}</div>`;
  }
  if (sc && o.moves) html += `<div class="pe-moves">SCENARIO moves: ${esc(o.moves)}</div>`;
  if (candidateMode && o.moves) html += `<div class="pe-moves">Scenario moves in OURS: ${esc(o.moves)}</div>`;
  if (slLoaded && o.reason) html += `<div class="pe-reason">${esc(o.reason)}</div>`;
  return html;
}
