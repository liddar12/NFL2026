/* app/views/model.js — the MODEL tab (#/model): model transparency dashboard.
 *
 * The analytics ARE the product, so they get a first-class surface:
 *   .m-params    the ADOPTED game params vs the shipped defaults + provenance
 *   .m-backtest  incumbent vs adopted log-loss/Brier + top-10 trial bars
 *   .m-locks     in-season lock grading status, counted from the refit
 *                archive (honest day-zero message until a lock grades)
 *   .m-signals   the 32-signal weight table; market signals carry a
 *                "MARKET · DISPLAY ONLY" badge (mirrors the validator policy)
 *   .m-playoffs  simulated playoff/division/conference/champion odds (OUR
 *                model only) with Kalshi/Polymarket SB futures alongside,
 *                labeled display-only — the scoreboard, never an input.
 *   .m-weekly-gate  R51: the weekly-split candidate vs incumbent never-regress
 *                record (data/weekly_backtest.json) — OMITTED when absent.
 *   .m-parlay-gate  R51: moneyline yardstick, spread edge test, props
 *                calibration, leg correlations (data/parlay_backtest.json) —
 *                OMITTED when absent; AWAITING when present without a verdict.
 *   R53/R54: both gate cards carry an optional LIVE 2026 row (the record's
 *                `live_2026` block: measured on resolved 2026 weeks, never part
 *                of the verdict) and the LEARNING RECORD shows the three scored
 *                series once a 2026 week has resolved.
 *
 * Every card degrades to a .state message when its feed is absent (older
 * deploy) — the view never blanks. Pure helpers exported for unit tests.
 */

import {
  getMeta, getModelTuning, getPlayoffOdds, getMarketPrices, getPipelineStatus, loadJson,
} from '../data.js';

// R51: the two never-regress records behind the WEEKLY SPLIT GATE and PARLAY
// GATE cards (scripts/backtest_weekly.py, scripts/backtest_parlay.py). Optional
// feeds: they resolve to NULL on a 404 or a parse error instead of rejecting —
// a missing file renders NOTHING, never a placeholder. They live here, not in
// app/data.js, so the boot graph does not pay for a lazy view's feeds.
export const loadWeeklyBacktest = (opts) => loadJson('/data/weekly_backtest.json', opts).catch(() => null);
export const loadParlayBacktest = (opts) => loadJson('/data/parlay_backtest.json', opts).catch(() => null);
// R81 — the measure-only REPLAY LAB record (scripts/replay_lab.py). Same
// resolve-to-null-on-404 contract as the two above: absent means the card says
// so, never a placeholder number. Nothing this file reads is ever adopted.
export const loadReplayLab = (opts) => loadJson('/data/replay_lab.json', opts).catch(() => null);
import { teamTint } from '../render.js';

/** Signals pinned display-only by validate_data.py MARKET_DISPLAY_ONLY —
 * hardcoded mirror so the UI badge and the gate policy can never diverge
 * silently (the signal_registry test locks the registry itself). */
export const MARKET_SIGNALS = Object.freeze([
  'market_spread', 'market_moneyline', 'market_total',
  'odds_api', 'kalshi', 'polymarket',
]);

/** Shipped defaults (scripts/models/elo.py) the adopted params are shown against. */
const DEFAULTS = Object.freeze({ hfa_elo: 65.0, revert: 0.33, k: 20.0 });

/** HTML-escape untrusted-ish text before interpolating into a template. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---- R78: the MODEL tab passphrase gate -------------------------------------
 * OBSCURITY, NOT SECURITY — stated plainly so nobody mistakes it for access
 * control. This is a public static site with no server: /data/*.json stays
 * world-readable, this module ships to every visitor, and anyone who opens
 * devtools can set the unlock key by hand. The gate hides the VIEW so the
 * MODEL section is not something a casual visitor stumbles into; it protects
 * nothing at the HTTP layer and must never be described as if it did. (Real
 * protection would be Netlify password protection in front of the origin.)
 *
 * Only the SHA-256 of the owner's passphrase lives here — the plaintext is
 * never written into the repo, in code, tests, comments or docs. Rotating the
 * passphrase is a one-line edit to the digest below (every unlocked browser
 * re-locks, because the stored value IS the digest).
 */
export const MODEL_LOCK_KEY = 'nfl2026.model.unlock.v1';
export const MODEL_PASS_SHA256 = '4fed76b87cf8b056da33b210b23e8f4f93e9c955d56faf7e3ae3bbb57704f50b';

/** Lowercase hex SHA-256 of `text`. Needs a secure context (crypto.subtle);
 * Node 22 exposes the same API on globalThis.crypto, so this is unit-testable. */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text == null ? '' : text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True iff this browser has already unlocked. A storage that throws (private
 * mode, blocked cookies) or is absent reads as LOCKED — never as unlocked. */
export function isModelUnlocked(storage) {
  try {
    return storage.getItem(MODEL_LOCK_KEY) === MODEL_PASS_SHA256;
  } catch (_) {
    return false;
  }
}

/** The view header, shared by the locked and unlocked renders so the tab keeps
 * its identity (and its title) whichever one is painted. */
const MODEL_HEAD =
  '<header class="view-head">' +
    '<h1 class="view-title">MODEL</h1>' +
    '<span class="view-sub">WHAT THE AI HAS LEARNED · FULL TRANSPARENCY</span>' +
  '</header>';

/** The locked view: the MODEL header plus one card carrying the passphrase
 * form. `msg` (optional) paints an alert line under it. Pure — unit-tested. */
export function renderLockCard(msg) {
  return MODEL_HEAD +
    '<section class="card mcard m-lock">' +
      '<div class="m-explain">This section is for the owner. Enter the passphrase.</div>' +
      '<form class="m-lock-form">' +
        '<input class="mp-input" type="password" name="pass" ' +
          'autocomplete="current-password" aria-label="Passphrase" placeholder="Passphrase">' +
        '<button type="submit" class="mp-btn">UNLOCK</button>' +
      '</form>' +
      (msg ? `<div class="m-lock-msg" role="alert">${esc(msg)}</div>` : '') +
    '</section>';
}

/** Percent with one decimal ("15.0%"); '—' for non-finite. */
export function fmtPct(p) {
  const n = Number(p);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
}

/**
 * Top `n` distinct PARAMETER-GRID trials from model_tuning history by log-loss
 * (best first). `history` is model_tuning.json history[]: entries may carry
 * trials[] each {hfa_elo|hfa, revert, k, log_loss}. Non-numeric log_loss rows
 * dropped.
 *
 * ONLY trials carrying the full hfa/revert/k grid qualify. The history also
 * archives trials from OTHER searches with entirely different knobs — the
 * committed legacy signal_promotion entry (promote_signals.py, 2026-07) ships
 * trials shaped {venue_scale, cold_scale, log_loss} with no hfa/revert/k at
 * all — and its 0.6369 beat the best real grid trial, so reading those rows
 * here is exactly what rendered the highlighted best row as
 * "hfa NaN · rev NaN · k NaN" (R30b). A trial from a different grid is a
 * different card's business, not an hfa/revert/k row with holes in it.
 * Pure — unit-tested directly.
 */
export function topTrials(history, n = 10) {
  const rows = [];
  (Array.isArray(history) ? history : []).forEach((h) => {
    (Array.isArray(h && h.trials) ? h.trials : []).forEach((t) => {
      const ll = Number(t && t.log_loss);
      const hfa = Number(t && (t.hfa_elo != null ? t.hfa_elo : t.hfa));
      const revert = Number(t && t.revert);
      const k = Number(t && t.k);
      if (Number.isFinite(ll) && Number.isFinite(hfa)
          && Number.isFinite(revert) && Number.isFinite(k)) {
        rows.push({ hfa, revert, k, log_loss: ll });
      }
    });
  });
  rows.sort((a, b) => a.log_loss - b.log_loss
    || a.hfa - b.hfa || a.revert - b.revert || a.k - b.k);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${r.hfa}|${r.revert}|${r.k}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

/** The "MARKET · DISPLAY ONLY" badge for market signals; '' otherwise. Pure. */
export function marketBadge(signal) {
  return MARKET_SIGNALS.includes(signal)
    ? ' <span class="ms-badge" title="Market prices are never weighted into predictions (user policy)">MARKET · DISPLAY ONLY</span>'
    : '';
}

const state = (text) => `<div class="state">${text}</div>`;

/* ---- data freshness + schedules ---------------------------------------------
 * The health chip in the topbar says DEGRADED or OK and nothing else. This card
 * answers the actual question behind that chip: WHICH feed, HOW STALE, and HOW
 * OFTEN is it supposed to run. Cadence is read from `schedules` in the
 * contract, which the pipeline parses out of .github/workflows/*.yml — so what
 * is displayed here is the cron that really runs, not a hand-typed claim that
 * can drift.
 */

/** "3h ago" / "2d ago" / "—". Age is measured from the feed's last SUCCESS. */
function ago(iso, nowMs) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const mins = Math.max(0, Math.round((nowMs - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Plain-English gloss of the 5-field cron shapes this repo actually uses.
 *  Anything unrecognised falls back to the raw expression rather than a guess. */
export function cronLabel(expr) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5) return String(expr || '');
  const [min, hr, , , dow] = p;
  const at = (h) => `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')} UTC`;
  const days = dow === '*'
    ? null
    : dow.split(',').map((d) => DOW[Number(d)]).filter(Boolean).join('/');
  if (hr.startsWith('*/')) {
    const every = `every ${hr.slice(2)}h`;
    return days ? `${days}, ${every}` : every;
  }
  const hours = hr.split(',');
  const times = hours.map(at).join(' & ');
  return days ? `${days} ${times}` : `daily ${times}`;
}

function freshnessCard(status, nowMs) {
  if (!status || !status.feeds) {
    return state('Feed status unavailable — the pipeline_status contract did not load.');
  }
  const entries = Object.entries(status.feeds);
  const rank = { down: 0, degraded: 1, stale: 2, unconfigured: 3, ok: 4 };
  // Worst first: the reason the health chip is not green should be the first row.
  entries.sort((a, b) => (rank[a[1].status] ?? 9) - (rank[b[1].status] ?? 9)
    || a[0].localeCompare(b[0]));

  const rows = entries.map(([name, f]) => {
    const cls = `pf-${esc(f.status)}`;
    const last = f.status === 'unconfigured'
      ? 'awaiting config'
      : ago(f.last_success_utc, nowMs);
    return (
      '<tr>'
      + `<td class="pf-name">${esc(name)}</td>`
      + `<td><span class="pf-dot ${cls}"></span>${esc(String(f.status).toUpperCase())}</td>`
      + `<td class="pf-age">${esc(last)}</td>`
      + `<td class="pf-rows">${Number.isFinite(Number(f.rows)) ? esc(f.rows) : '—'}</td>`
      + '</tr>'
    );
  }).join('');

  const scheds = Array.isArray(status.schedules) ? status.schedules : [];
  const schedHtml = scheds.length
    ? '<table class="pf-sched"><thead><tr><th>PIPELINE</th><th>RUNS</th></tr></thead><tbody>'
      + scheds.map((s) => (
        '<tr>'
        + `<td class="pf-name">${esc(s.name)}</td>`
        + `<td>${(s.crons || []).map((c) => `<span class="pf-cron" title="${esc(c)}">${esc(cronLabel(c))}</span>`).join('')}</td>`
        + '</tr>'
      )).join('')
      + '</tbody></table>'
    : state('Schedules not published by this pipeline run.');

  const n = entries.length;
  const okN = entries.filter(([, f]) => f.status === 'ok').length;
  const unconf = entries.filter(([, f]) => f.status === 'unconfigured').length;

  return (
    `<div class="pf-sum">Overall <b>${esc(String(status.health).toUpperCase())}</b> · `
    + `${okN}/${n} feeds ok${unconf ? ` · ${unconf} awaiting config` : ''} · `
    + `status written ${esc(ago(status.generated_utc, nowMs))}</div>`
    + '<table class="pf-tbl"><thead><tr><th>FEED</th><th>STATUS</th>'
    + '<th>LAST OK</th><th>ROWS</th></tr></thead>'
    + `<tbody>${rows}</tbody></table>`
    + '<div class="pf-subhead">UPDATE SCHEDULE · parsed from the live workflow crons</div>'
    + schedHtml
  );
}

/**
 * Newest format-2 signal_promotion entry from model_tuning history, or null.
 * Pure — unit-tested directly.
 */
export function latestPromotion(history) {
  const rows = Array.isArray(history) ? history : [];
  return rows.find((h) => h && h.kind === 'signal_promotion' && h.format === 2) || null;
}

/**
 * Per-family verdict rows for the gate card: {family, status, bestLoss,
 * improvement, reason, appliable, appNote, incumbent}. status: 'adopted' |
 * 'retained' | 'skipped'.
 *
 * `incumbent` is true for a family named in entry.incumbent_families — the
 * gate's own record of which families are ALREADY APPLIED to live game
 * probabilities (qb_out today: build_predictions.py shifts hfa_elo by its
 * scale whenever a primary QB is Out). Such a family is the incumbent being
 * defended, not a candidate kept at weight 0 — rendering it with the same
 * RETAINED chip as weight-0 families told the user the one family in
 * production carried no weight (R30b).
 *
 * `appliable` mirrors the gate's own APPLIABLE set, recorded per family on the
 * entry. FALSE means the family can be measured but cannot receive pricing
 * weight at any log-loss, because nothing in the prediction pipeline reads it —
 * rendering it identically to a family that can is how the card ends up telling
 * the user the opposite of the truth. Entries written before the flag existed
 * carry no opinion (null), which renders as it always did. `appNote` carries
 * coverage.application.reason for a family whose application path is DARK
 * (scheme_matchup: no FTN charting release for the live season). Pure.
 */
export function familyRows(entry) {
  if (!entry || !Array.isArray(entry.families)) return [];
  const adopted = entry.adopted_family && entry.adopted_family.family;
  const incumbents = new Set(
    Array.isArray(entry.incumbent_families) ? entry.incumbent_families : [],
  );
  return entry.families.map((f) => {
    const app = (f.coverage && f.coverage.application) || null;
    return {
      family: f.family,
      status: f.skipped ? 'skipped' : (f.family === adopted ? 'adopted' : 'retained'),
      bestLoss: f.best ? f.best.log_loss : null,
      improvement: Number.isFinite(Number(f.improvement)) ? Number(f.improvement) : null,
      reason: f.reason || '',
      appliable: typeof f.appliable === 'boolean' ? f.appliable : null,
      appNote: (app && app.dark && app.reason) ? String(app.reason) : '',
      incumbent: incumbents.has(f.family),
    };
  });
}

/**
 * Market-yardstick trend across gate runs: one point per format-2 entry that
 * carries a market_baseline block, OLDEST-first (left→right on the chart).
 * Each point: {date, ours, market, gap}. Measurement only — the market log-loss
 * is a scoreboard the model is measured against, never an input. Pure.
 */
export function marketTrend(history) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((h) => h && h.kind === 'signal_promotion' && h.format === 2 && h.market_baseline)
    .map((h) => ({
      date: String(h.generated_utc || '').slice(0, 10),
      ours: Number(h.market_baseline.our_log_loss),
      market: Number(h.market_baseline.market_log_loss),
      gap: Number(h.market_baseline.gap),
    }))
    .filter((r) => Number.isFinite(r.ours) && Number.isFinite(r.market));
  return rows.reverse(); // history is newest-first; chart reads oldest→newest
}

/** Map values in [lo,hi] to a y in [top,bottom] (SVG y grows downward). Pure. */
function _scaleY(v, lo, hi, top, bottom) {
  if (hi <= lo) return (top + bottom) / 2;
  return bottom - ((v - lo) / (hi - lo)) * (bottom - top);
}

/* ---- card painters (pure HTML builders) ------------------------------------ */

export function paramsCard(tuning) {
  const gp = tuning && tuning.game_params;
  if (!gp) {
    return state('No adopted parameters yet — the model runs on its shipped defaults '
      + 'until a NEVER-REGRESS backtest or in-season refit earns a change.');
  }
  const row = (name, val, def) => (
    '<div class="mp-row">' +
      `<span class="mp-name">${esc(name)}</span>` +
      `<span class="mp-val">${esc(val)}</span>` +
      `<span class="mp-def">default ${esc(def)}</span>` +
    '</div>'
  );
  // Applied signal families ride in game_params as objects with applied:true
  // (qb_out today: build_predictions.py shifts hfa_elo by `scale` whenever a
  // team's primary QB is Out). They shape every live game probability exactly
  // like the three scalars do, so omitting them here — while the card claimed
  // to list "the fitted parameters every game probability is priced with" —
  // hid the one applied family and its stored caveat entirely (R30b). Their
  // "default" is off: a family not adopted applies no shift at all.
  const famKeys = Object.keys(gp)
    .filter((k) => gp[k] && typeof gp[k] === 'object' && gp[k].applied === true)
    .sort();
  const famHtml = famKeys.map((k) => {
    const f = gp[k];
    const when = String(f.adopted_utc || '').slice(0, 10);
    return (
      row(`${k.replace(/_/g, ' ').toUpperCase()} (Elo shift)`, f.scale, 'off') +
      '<div class="mp-src">APPLIED at prediction time'
        + (when ? ` · adopted ${esc(when)}` : '')
        + (f.adopted_under ? ` under ${esc(f.adopted_under)}` : '')
        + '</div>' +
      // The family's own caveat must travel with its number — qb_out's says
      // its 95% CI spans zero. Hiding it would overstate the evidence.
      (f.note ? `<div class="m-explain">${esc(f.note)}</div>` : '')
    );
  }).join('');
  return (
    row('HOME FIELD (Elo)', gp.hfa_elo, DEFAULTS.hfa_elo) +
    row('SEASON REVERT', gp.revert, DEFAULTS.revert) +
    row('K (update speed)', gp.k, DEFAULTS.k) +
    famHtml +
    `<div class="mp-src">Adopted ${esc(String(gp.adopted_utc || '').slice(0, 10))} · ${esc(gp.source || '')}</div>` +
    '<div class="m-explain">These are the fitted parameters every game probability is priced '
      + 'with'
      + (famKeys.length ? ' — the three Elo scalars plus every APPLIED signal family above' : '')
      + ' — earned against real seasons through the NEVER-REGRESS gate, not hand-tuned.</div>'
  );
}

export function backtestCard(tuning) {
  const hist = (tuning && Array.isArray(tuning.history)) ? tuning.history : [];
  const trials = topTrials(hist, 10);
  if (trials.length === 0) {
    return state('No backtest trials recorded yet.');
  }
  const worst = trials[trials.length - 1].log_loss;
  const best = trials[0].log_loss;
  const span = Math.max(worst - best, 1e-6);
  // topTrials admits only full hfa/revert/k grid trials, so every knob is
  // finite here. knob() is the belt-and-braces if that invariant ever drifts:
  // an absent knob renders an honest em dash (explained by the row title),
  // never NaN — a number-shaped lie about a search that was never run.
  const knob = (v) => (Number.isFinite(v) ? esc(v) : '—');
  const bars = trials.map((t, i) => {
    // Bar length: best trial fills, others shrink with their loss gap.
    const w = 100 - ((t.log_loss - best) / span) * 60;
    const partial = !(Number.isFinite(t.hfa) && Number.isFinite(t.revert)
      && Number.isFinite(t.k));
    const why = partial
      ? ' title="— marks a knob this trial’s search did not carry"' : '';
    return (
      `<div class="bt-row${i === 0 ? ' bt-row--best' : ''}">` +
        `<span class="bt-lbl"${why}>hfa ${knob(t.hfa)} · rev ${knob(t.revert)} · k ${knob(t.k)}</span>` +
        `<span class="bt-bar" style="width:${w.toFixed(1)}%"></span>` +
        `<span class="bt-val">${t.log_loss.toFixed(4)}</span>` +
      '</div>'
    );
  }).join('');
  return (
    '<div class="m-explain">Walk-forward log-loss on 1,000+ real FINAL games (lower is better). '
      + 'The best trial is only ADOPTED when it beats the incumbent by the NEVER-REGRESS margin.</div>' +
    bars
  );
}

export function gateCard(tuning) {
  const entry = latestPromotion(tuning && tuning.history);
  if (!entry) {
    return state('No candidate-family promotion run recorded yet — the weekly '
      + 'self-learning cron writes one every Tuesday.');
  }
  const fams = familyRows(entry);
  const rows = fams.map((r) => {
    // Exactly ONE chip per row. A family with no application path gets its own
    // verdict rather than borrowing RETAINED, which would read as "measured,
    // kept at weight 0 for now" when the truth is "cannot receive weight at all".
    // Likewise the incumbent (entry.incumbent_families): it is APPLIED to every
    // live game probability, so wearing plain RETAINED — the weight-0 chip —
    // would tell the user the one family in production carries no weight (R30b).
    // Its adopted params + caveat are listed in ADOPTED PARAMETERS.
    const chip = r.status === 'adopted'
      ? '<span class="gate-chip gate-chip--adopted">ADOPTED</span>'
      : r.incumbent
        ? '<span class="gate-chip gate-chip--adopted gate-chip--incumbent" '
          + 'title="The live incumbent: this family is currently applied to every '
          + 'game probability at prediction time (its adopted parameters are '
          + 'listed under ADOPTED PARAMETERS). It keeps its place unless a '
          + 'challenger clears the NEVER-REGRESS margin against it.'
          + '">APPLIED · INCUMBENT</span>'
        : r.appliable === false
          ? '<span class="gate-chip gate-chip--nopath" title="'
            + esc(r.appNote || r.reason
              || 'measured by the gate, but no prediction-time reader applies it')
            + '">NO PATH</span>'
          : r.status === 'skipped'
            ? '<span class="gate-chip gate-chip--skipped" title="' + esc(r.reason) + '">AWAITING DATA</span>'
            : '<span class="gate-chip">RETAINED</span>';
    const imp = r.improvement == null ? '—'
      : `${r.improvement > 0 ? '−' : '+'}${Math.abs(r.improvement).toFixed(5)}`;
    return (
      '<div class="gate-row">' +
        `<span class="gate-name">${esc(r.family)}</span>` +
        `<span class="gate-loss">${r.bestLoss == null ? '—' : r.bestLoss.toFixed(5)}</span>` +
        `<span class="gate-imp">${imp}</span>` +
        chip +
      '</div>'
    );
  }).join('');
  const noPath = fams.filter((r) => r.appliable === false);
  const dark = fams.filter((r) => r.appNote);
  const noPathNote = noPath.length
    ? '<div class="gate-note">NO PATH — measured every week, but nothing in the '
      + 'prediction pipeline reads them, so they cannot earn weight at any '
      + `log-loss until their reader is wired: ${esc(noPath.map((r) => r.family).join(', '))}. `
      + 'When one of them posts the best loss the gate records it and falls '
      + 'through to the best family it can actually apply.'
      + dark.map((r) => `<br>${esc(r.family)}: ${esc(r.appNote)}`).join('')
      + '</div>'
    : '';
  return (
    '<div class="m-explain">Every candidate signal family is walk-forward tested against the '
      + `incumbent (log-loss ${esc(Number(entry.incumbent_loss).toFixed(5))}) each week. `
      + 'A family with an application path earns pricing weight ONLY by clearing the '
      + `NEVER-REGRESS margin (${esc(entry.margin)}) — losing candidates stay recorded `
      + 'at weight 0, and families marked NO PATH are measured but cannot be applied. '
      + 'A family marked APPLIED · INCUMBENT is different: it is already in production, '
      + 'part of the very incumbent the candidates are measured against, not a '
      + 'candidate kept at zero. '
      + 'Lower loss is better; Δ shows the best trial\'s gap to the incumbent.</div>' +
    '<div class="gate-row gate-row--head">' +
      '<span class="gate-name">FAMILY</span><span class="gate-loss">BEST LOSS</span>' +
      '<span class="gate-imp">Δ LOSS</span><span>VERDICT</span></div>' +
    rows +
    noPathNote +
    (entry.market_baseline
      ? `<div class="gate-bench">MARKET YARDSTICK: our log-loss ${esc(Number(entry.market_baseline.our_log_loss).toFixed(5))} vs closing line ${esc(Number(entry.market_baseline.market_log_loss).toFixed(5))} over ${esc(entry.market_baseline.games)} games <span class="ms-badge">MEASUREMENT ONLY</span></div>`
      : '') +
    `<div class="mp-src">Last run ${esc(String(entry.generated_utc || '').slice(0, 10))} · ${esc(entry.reason || '')}</div>`
  );
}

function marketTrendCard(tuning) {
  const pts = marketTrend(tuning && tuning.history);
  if (pts.length === 0) {
    return state('No market yardstick recorded yet — the weekly gate benchmarks our '
      + 'log-loss against de-vigged closing lines once the baseline is built.');
  }
  const last = pts[pts.length - 1];
  const gapTxt = `${last.gap >= 0 ? '+' : '−'}${Math.abs(last.gap).toFixed(4)}`;
  // Single run: no line to draw yet — state the latest gap plainly.
  if (pts.length < 2) {
    return (
      '<div class="m-explain">How far our probabilities sit from the market\'s closing '
        + 'line (de-vigged), in log-loss. The market is a <b>scoreboard we measure against, '
        + 'never an input</b> — we predict independently. Lower is better; a shrinking gap '
        + 'means we\'re closing on the market.</div>' +
      `<div class="mt-single">Latest (${esc(last.date)}): ours <b>${last.ours.toFixed(5)}</b> · `
        + `market <b>${last.market.toFixed(5)}</b> · gap <b>${gapTxt}</b> `
        + '<span class="ms-badge">MEASUREMENT ONLY</span></div>'
    );
  }
  const W = 320;
  const H = 120;
  const padX = 8;
  const padY = 12;
  const all = pts.flatMap((p) => [p.ours, p.market]);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const x = (i) => padX + (i / (pts.length - 1)) * (W - 2 * padX);
  const y = (v) => _scaleY(v, lo, hi, padY, H - padY);
  const line = (key) => pts.map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const dot = (key, cls) => {
    const p = pts[pts.length - 1];
    return `<circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(p[key]).toFixed(1)}" r="3.5" class="${cls}" />`;
  };
  const svg =
    `<svg class="mt-chart" viewBox="0 0 ${W} ${H}" role="img" ` +
      `aria-label="Our log-loss versus the market closing line across ${pts.length} gate runs">` +
      `<polyline class="mt-line mt-line--mkt" points="${line('market')}" fill="none" />` +
      `<polyline class="mt-line mt-line--ours" points="${line('ours')}" fill="none" />` +
      dot('market', 'mt-dot mt-dot--mkt') + dot('ours', 'mt-dot mt-dot--ours') +
    '</svg>';
  return (
    '<div class="m-explain">How far our probabilities sit from the market\'s closing '
      + 'line (de-vigged), in log-loss, across every gate run. The market is a '
      + '<b>scoreboard we measure against, never an input</b> — we predict independently. '
      + 'Lower is better; the gap shrinking over time means we\'re closing on the market.</div>' +
    svg +
    '<div class="mt-legend">' +
      `<span class="mt-key mt-key--ours">OURS ${last.ours.toFixed(4)}</span>` +
      `<span class="mt-key mt-key--mkt">MARKET ${last.market.toFixed(4)}</span>` +
      `<span class="mt-gap">GAP ${gapTxt}</span>` +
      '<span class="ms-badge">MEASUREMENT ONLY</span>' +
    '</div>' +
    `<div class="mp-src">${esc(String(pts.length))} runs · ${esc(pts[0].date)} → ${esc(last.date)}</div>`
  );
}

function calibrationCard(tuning) {
  const entry = latestPromotion(tuning && tuning.history);
  const cal = entry && entry.calibration;
  const bins = (cal && Array.isArray(cal.bins) ? cal.bins : []).filter((b) => b && b.n > 0);
  if (bins.length === 0) {
    return state('Calibration record not available yet — produced by the weekly promotion run.');
  }
  const rows = bins.map((b) => {
    const exp = Number(b.expected);
    const act = Number(b.actual);
    return (
      '<div class="cal-row">' +
        `<span class="cal-rng">${esc((b.p_lo * 100).toFixed(0))}–${esc((b.p_hi * 100).toFixed(0))}%</span>` +
        '<span class="cal-bars">' +
          `<span class="cal-bar cal-bar--exp" style="width:${(exp * 100).toFixed(1)}%"></span>` +
          `<span class="cal-bar cal-bar--act" style="width:${(act * 100).toFixed(1)}%"></span>` +
        '</span>' +
        `<span class="cal-val">${fmtPct(act)} <span class="cal-n">n=${esc(b.n)}</span></span>` +
      '</div>'
    );
  }).join('');
  return (
    `<div class="m-explain">${esc(`Do our probabilities mean what they say? Each row buckets ${cal.n} real games (${cal.seasons}, walk-forward) by predicted home-win chance: `)}` +
      '<span class="cal-key cal-key--exp">predicted</span> vs ' +
      '<span class="cal-key cal-key--act">actual</span> win rate. ' +
      'Matched bars = honest probabilities.</div>' +
    rows
  );
}

/**
 * Count of 2026 in-season locks that have actually been graded, from the only
 * place the pipeline records it. Pure — unit-tested against the committed data.
 *
 * The card used to read `tuning.resolved_locks`, a key NO producer writes (its
 * one repo-wide mention was that reader), so "grading active" was unreachable
 * dead code (R30b). What the pipeline DOES write: scripts/refit.py fits on the
 * resolved lock rows under data/snapshots/ and archives the count as
 * `n_resolved` on a kind:"game_params" history entry — but only once at least
 * one lock has resolved (a day-zero run is a clean no-op that writes nothing).
 * Backtest entries share kind:"game_params" while THEIR n_resolved counts
 * 2022-2025 historical finals, never 2026 locks; counting those would claim
 * in-season grading is active on day zero. The shapes differ: refit entries
 * carry `search` (+ held-out fields) and no `eval_seasons`; backtest entries
 * carry `eval_seasons` and no `search`. history is newest-first and
 * resolve_locks is idempotent over all lock files, so the first matching entry
 * holds the latest running total.
 */
export function resolvedLockCount(tuning) {
  const hist = (tuning && Array.isArray(tuning.history)) ? tuning.history : [];
  let best = null;
  for (const h of hist) {
    if (h && h.kind === 'game_params' && h.search != null && !('eval_seasons' in h)) {
      const n = Number(h.n_resolved);
      if (!Number.isFinite(n) || n <= 0) continue;
      // Newest pass wins, by generated_utc: the archive interleaves backtest and
      // in-season entries and is appended per gameday pass, so position is not
      // recency (week 1 surfaced first-wins showing 1 while 10 receipts had
      // graded). A tie falls to the later entry.
      if (!best || String(h.generated_utc || '') >= String(best.generated_utc || '')) best = h;
    }
  }
  return best ? Number(best.n_resolved) : 0;
}

export function locksCard(tuning) {
  const resolved = resolvedLockCount(tuning);
  if (resolved > 0) {
    return state(`${resolved} locks resolved — in-season grading active: every `
      + 'graded lock feeds the off-grid refit behind the same NEVER-REGRESS gate.');
  }
  return state('In-season lock grading begins when 2026 games go FINAL: every '
    + 'pre-kickoff prediction is locked, graded against the result on the next '
    + 'data-cron pass, and fed back through the same NEVER-REGRESS gate. The '
    + 'count shown here comes from the refit archive, so it appears with the '
    + 'first graded lock.');
}

function signalsCard(meta) {
  const weights = (meta && meta.weights) || {};
  const names = Object.keys(weights).sort();
  if (names.length === 0) return state('Signal registry unavailable.');
  const rows = names.map((n) => (
    '<div class="sg-row">' +
      `<span class="sg-name">${esc(n)}${marketBadge(n)}</span>` +
      `<span class="sg-w">${Number(weights[n]).toFixed(1)}</span>` +
    '</div>'
  )).join('');
  return (
    '<div class="m-explain">Every candidate signal starts at weight 0.0 and must EARN weight by '
      + 'beating the incumbent model on resolved games. Market signals never can — they are '
      + 'display-only by policy.</div>' +
    rows
  );
}

/** "as of <stamp>" for the PLAYOFF ODDS card. `updated_utc` is written by the
 * season simulator on every pipeline run; an artifact without it says so rather
 * than inventing a time (absent is not "now"). Pure — unit-tested. */
export function asofLine(odds) {
  const raw = odds && odds.updated_utc;
  const t = raw ? Date.parse(raw) : NaN;
  const sims = Number(odds && odds.sims);
  const simsTxt = Number.isFinite(sims) ? sims.toLocaleString('en-US') : '0';
  const stamp = Number.isFinite(t)
    ? `as of <time datetime="${esc(raw)}">${new Date(t).toISOString().slice(0, 10)} `
      + `${new Date(t).toISOString().slice(11, 16)} UTC</time>`
    : 'as of — (no timestamp in playoff_odds.json)';
  return `<div class="m-asof">${stamp} · refreshed on every pipeline run `
    + `(${simsTxt} simulated seasons)</div>`;
}

/** " KALSHI: no priced events in the latest feed." for each market column that
 * came back with ZERO rows. An empty column is a feed fact, not a modelling
 * one, and the card has to say which — a blank column otherwise reads as
 * "the market has no opinion". Pure. */
export function emptyMarketNote(markets) {
  const f = (markets && markets.futures) || {};
  const rows = (k) => (Array.isArray(f[k]) ? f[k].length : 0);
  return [['kalshi', 'KALSHI'], ['polymarket', 'POLYMKT']]
    .filter(([key]) => rows(key) === 0)
    .map(([, label]) => ` ${label}: no priced events in the latest feed.`)
    .join('');
}

export function playoffsCard(odds, markets) {
  if (!odds || !odds.teams) {
    return state('Playoff odds unavailable — the season simulator has not run on this deploy.');
  }
  const kal = new Map(((markets && markets.futures && markets.futures.kalshi) || [])
    .map((r) => [r.team, r.prob]));
  const poly = new Map(((markets && markets.futures && markets.futures.polymarket) || [])
    .map((r) => [r.team, r.prob]));
  const teams = Object.entries(odds.teams)
    .sort((a, b) => b[1].champion - a[1].champion || (a[0] < b[0] ? -1 : 1))
    .slice(0, 12);
  const head =
    '<div class="po-row po-row--head">' +
      '<span class="po-team">TEAM</span><span>PLAYOFF</span><span>DIV</span>' +
      '<span>CONF</span><span>CHAMP</span><span>KALSHI</span><span>POLYMKT</span>' +
    '</div>';
  const rows = teams.map(([ab, t]) => (
    '<div class="po-row">' +
      `<span class="po-team" style="color:${teamTint(ab)}">${esc(ab)}</span>` +
      `<span>${fmtPct(t.playoff)}</span><span>${fmtPct(t.division)}</span>` +
      `<span>${fmtPct(t.conference)}</span><span class="po-champ">${fmtPct(t.champion)}</span>` +
      `<span class="po-mkt">${fmtPct(kal.get(ab))}</span>` +
      `<span class="po-mkt">${fmtPct(poly.get(ab))}</span>` +
    '</div>'
  )).join('');
  return (
    asofLine(odds) +
    `<div class="m-explain">${esc(`Simulated from OUR fitted Elo (${(odds.sims || 0).toLocaleString()} seasons, simplified tiebreakers) — no market input. `)}` +
      'KALSHI / POLYMKT columns are the markets\' Super Bowl prices for comparison ' +
      '<span class="ms-badge">MARKET · DISPLAY ONLY</span>' +
      esc(emptyMarketNote(markets)) + '</div>' +
    head + rows
  );
}

/* ---- R49: projection baseline + learning record -----------------------------
 * Both read data/meta.json keys the pipeline writes (projection_baseline,
 * learning_record). An older meta without them renders NOTHING — the cards are
 * omitted, not painted empty. Pure — unit-tested with and without the keys.
 */

// null/undefined is ABSENT — Number(null) is 0, and 0.000 is a number-shaped lie.
const dash = (v, digits = 2) => (v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : '—');
const pctOr = (v) => (v == null ? '—' : fmtPct(v));

/** "PROJECTION BASELINE" — the rule every shipped projection starts from. */
export function baselineCard(meta) {
  const pb = meta && meta.projection_baseline;
  if (!pb || typeof pb !== 'object') return '';
  const rule = typeof pb.rule === 'string' && pb.rule.trim() ? pb.rule.trim() : '—';
  const src = [
    Number.isFinite(Number(pb.season_games)) ? `${pb.season_games} season games` : '',
    pb.games_source ? `games from ${pb.games_source}` : '',
    pb.absence_source ? `absence from ${pb.absence_source}` : '',
    pb.changed_utc ? `changed ${String(pb.changed_utc).slice(0, 10)}` : '',
  ].filter(Boolean).join(' · ');
  const cand = pb.candidate && typeof pb.candidate === 'object' ? pb.candidate : null;
  const sigs = cand && Array.isArray(cand.signals_applied) ? cand.signals_applied : [];
  // R49 follow-up — the shipped MODE, stated plainly. 'candidate' = the
  // owner overrode the gate and OURS is the scenario; anything else keeps
  // today's text (the candidate is labelled candidate, not adopted).
  const sh = pb.shipped && typeof pb.shipped === 'object' ? pb.shipped : null;
  const candidateMode = Boolean(sh && sh.mode === 'candidate');
  let shippedHtml = '';
  if (candidateMode) {
    const bt = sh.backtest_2025 && typeof sh.backtest_2025 === 'object' ? sh.backtest_2025 : null;
    const when = sh.decided_utc ? String(sh.decided_utc).slice(0, 10) : '—';
    const by = sh.owner_override === true ? 'by owner override' : 'by the gate';
    shippedHtml =
      `<div class="mp-row"><span class="mp-name">SHIPPED</span><span class="mp-val">SCENARIO ${esc(by)}</span></div>`
      + `<div class="m-explain">SHIPPED = SCENARIO ${esc(by)} (decided ${esc(when)}): the gate keeps `
        + 'scoring GATED vs SCENARIO on resolved weeks; MAE 2025 gated '
        + `${esc(dash(bt && bt.gated_mae, 3))} · scenario ${esc(dash(bt && bt.candidate_mae, 3))}; `
        + `band calibrated to ${pctOr(bt && bt.band_coverage_after_calibration)}.</div>`
      + (sh.reason ? `<div class="mp-src">${esc(sh.reason)}</div>` : '');
  }
  return (
    '<div class="mp-row"><span class="mp-name">PROJECTION BASELINE</span>'
      + `<span class="mp-val">${esc(rule)}</span></div>`
    + (src ? `<div class="mp-src">${esc(src)}</div>` : '')
    + shippedHtml
    + (cand
      ? '<div class="mp-row"><span class="mp-name">SCENARIO CANDIDATE</span>'
        + `<span class="mp-val">${sigs.length ? esc(sigs.join(', ')) : '—'}</span></div>`
        + (cand.sd_rule ? `<div class="mp-src">band: ${esc(cand.sd_rule)}</div>` : '')
      : '')
    + (candidateMode
      ? '<div class="m-explain">OURS on PLAYERS and GRADE IS this scenario candidate — every '
        + 'raw signal applied at full strength. GATED, shown beside it, is the number the gate '
        + 'would have shipped.</div>'
      : '<div class="m-explain">Every shipped projection starts from this documented rule. '
        + 'SCENARIO (shown beside OURS on PLAYERS and GRADE) is the candidate with every raw '
        + 'signal applied at full strength — labelled candidate, not adopted.</div>')
  );
}

/** "LEARNING RECORD" — what the self-learning loop has actually scored. */
export function learningCard(meta) {
  const lr = meta && meta.learning_record;
  if (!lr || typeof lr !== 'object') return '';
  const weeks = Number(lr.weeks_resolved);
  const resolved = Number.isFinite(weeks) && weeks > 0;
  const sigs = Array.isArray(lr.signals_with_weight) ? lr.signals_with_weight.filter(Boolean) : [];
  const row = (name, val) => (
    `<div class="mp-row"><span class="mp-name">${name}</span><span class="mp-val">${val}</span></div>`
  );
  const bt = lr.backtest_2025 && typeof lr.backtest_2025 === 'object' ? lr.backtest_2025 : null;

  // R53 — once a week has resolved: the three scored series side by side, the
  // lowest MAE marked. Keys are the real learning_record keys the resolver
  // writes (mae_ppr / bias_ppr = shipped, candidate_*, gated_*): a null stays '—'.
  let seriesHtml = '';
  let proposalHtml = '';
  if (resolved) {
    const series = [
      ['SHIPPED', lr.mae_ppr, lr.bias_ppr],
      ['CANDIDATE', lr.candidate_mae_ppr, lr.candidate_bias_ppr],
      ['GATED', lr.gated_mae_ppr, lr.gated_bias_ppr],
    ];
    // null is ABSENT (Number(null) is 0, which would crown a missing series).
    const num = (m) => (m == null ? NaN : Number(m));
    const maes = series.map(([, m]) => num(m)).filter((m) => Number.isFinite(m));
    const best = maes.length ? Math.min(...maes) : null;
    const rows = series.map(([name, m, b]) => {
      const isBest = best != null && Number.isFinite(num(m)) && num(m) === best;
      return `<tr><td>${name}</td><td>${esc(dash(m, 3))}${isBest ? ' ▲' : ''}</td>`
        + `<td>${esc(signed(b, 3))}</td></tr>`;
    }).join('');
    seriesHtml = '<table class="pf-tbl"><thead><tr><th>SERIES</th><th>MAE (PPR)</th><th>BIAS</th></tr></thead>'
      + `<tbody>${rows}</tbody></table>`
      + `<div class="gate-bench">BAND COVERAGE ${pctOr(lr.band_coverage)}`
        + (lr.objective_ready === true ? ' · objective ready' : '')
        + (Number.isFinite(Number(lr.adoption_margin_mae)) ? ` · adoption margin ${esc(dash(lr.adoption_margin_mae, 2))} PPR` : '')
        + '</div>'
      + '<div class="m-explain">Scored on locked pre-kickoff estimates. SHIPPED is the number the '
        + 'app showed, CANDIDATE every raw signal at full strength, GATED the never-regress '
        + 'incumbent. Lower MAE is better (▲ marks the lowest); bias = mean(estimate − actual), '
        + 'negative means under-projected.</div>';
    // last_proposal: the latest archived fit (scripts/fit_player_signals.py
    // --propose), written into the record by the resolver; null until one exists.
    const lp = lr.last_proposal && typeof lr.last_proposal === 'object' ? lr.last_proposal : null;
    const verdictTxt = lp && typeof lp.verdict === 'string' ? lp.verdict.toUpperCase()
      : (lp && typeof lp.would_adopt === 'boolean' ? (lp.would_adopt ? 'PROPOSE' : 'RETAIN') : null);
    proposalHtml = row('LAST PROPOSAL', verdictTxt ? esc(verdictTxt) : 'none archived yet')
      + (lp
        ? `<div class="gate-note">${esc(lp.reason || '')}`
          + (Number.isFinite(Number(lp.folds)) ? ` · folds ${esc(lp.folds)}` : '')
          + ` · candidate MAE ${esc(dash(lp.candidate_mae, 3))} vs gated ${esc(dash(lp.gated_mae, 3))}`
          + ` · ${runLine(lp.generated_utc)}</div>`
        : '<div class="gate-note">The weekly fit (scripts/fit_player_signals.py --propose) has not '
          + 'archived a run on the resolved weeks yet.</div>');
  }
  return (
    row('WEEKS RESOLVED', esc(Number.isFinite(weeks) ? String(weeks) : '—'))
    + row('PLAYERS SCORED', esc(Number.isFinite(Number(lr.players_scored)) ? String(lr.players_scored) : '—'))
    + row('MAE (PPR)', resolved ? esc(dash(lr.mae_ppr)) : '—')
    + row('BIAS (PPR)', resolved ? esc(dash(lr.bias_ppr)) : '—')
    + seriesHtml
    + row('SIGNALS WITH WEIGHT', sigs.length ? esc(sigs.join(', ')) : 'none yet')
    + proposalHtml
    + (resolved
      ? ''
      : '<div class="m-explain">No 2026 week has resolved yet — nothing has been scored, '
        + 'so no signal has earned weight.</div>')
    + (bt
      ? `<div class="mp-src">BACKTEST 2025 · baseline MAE ${esc(dash(bt.baseline_mae))} · `
        + `candidate MAE ${esc(dash(bt.candidate_mae))} · band coverage ${fmtPct(bt.band_coverage)}`
        + (Number.isFinite(Number(bt.players)) ? ` · ${esc(bt.players)} players` : '')
        + '</div>'
      : '')
    + '<div class="m-explain">SCENARIO is the candidate the self-learning loop backtests; it '
      + 'moves the shipped number only after it clears never-regress.</div>'
  );
}

/* ---- R51: weekly split gate + parlay gate -----------------------------------
 * Both read a runner-built backtest record — data/weekly_backtest.json
 * (scripts/backtest_weekly.py) and data/parlay_backtest.json
 * (scripts/backtest_parlay.py) — through app/data.js loadWeeklyBacktest /
 * loadParlayBacktest, which resolve to NULL on a 404 or a parse error. Owner
 * policy, made mechanical here:
 *   - a MISSING file renders NOTHING: the painter returns '' and the mount
 *     omits the card (no placeholder shell);
 *   - a PRESENT file with no verdict renders an AWAITING state — never a
 *     borrowed ADOPTED / RETAINED, never the metrics as if they were judged;
 *   - every market number is a yardstick and wears MEASUREMENT ONLY.
 * Pure HTML builders — unit-tested with the sample docs under
 * tests/fixtures/r51/. Only classes theme.css / theme-hig.css already style
 * are used (.gate-*, .pf-tbl, .mp-src, .m-explain, .ms-badge).
 */

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Signed fixed-point with a real minus sign ("−0.150"); '—' when absent. */
const signed = (v, digits = 3) => {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const s = Math.abs(n).toFixed(digits);
  return n < 0 && Number(s) !== 0 ? `−${s}` : s;
};

/** ADOPTED / RETAINED chip for a {adopted: boolean} verdict; '' when there is none. */
export function verdictChip(verdict) {
  if (!isObj(verdict) || typeof verdict.adopted !== 'boolean') return '';
  return verdict.adopted
    ? '<span class="gate-chip gate-chip--adopted">ADOPTED</span>'
    : '<span class="gate-chip">RETAINED</span>';
}

const AWAITING_CHIP = '<span class="gate-chip gate-chip--skipped" '
  + 'title="The record is present but carries no verdict yet">AWAITING</span>';

function awaitingRow(name, sub) {
  return '<div class="gate-row">'
    + `<span class="gate-name">${esc(name)}</span><span>${esc(sub || '')}</span><span></span>`
    + AWAITING_CHIP
    + '</div>';
}

/**
 * v2 − v1 with the GOOD direction marked: ▲ moved the good way, ▼ regressed,
 * = unchanged after rounding, — when either side is missing. `pct` renders
 * the delta in percentage points ("+1.1 pp"). Pure — unit-tested directly.
 */
export function deltaText(v1, v2, { digits = 3, lowerIsBetter = false, pct = false } = {}) {
  const a = Number(v1);
  const b = Number(v2);
  if (v1 == null || v2 == null || !Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const d = pct ? 1 : digits;
  const r = Number((pct ? (b - a) * 100 : b - a).toFixed(d));
  const mark = r === 0 ? '=' : ((r < 0) === lowerIsBetter ? '▲' : '▼');
  const sign = r > 0 ? '+' : (r < 0 ? '−' : '');
  return `${sign}${Math.abs(r).toFixed(d)}${pct ? ' pp' : ''} ${mark}`;
}

const seasonsText = (arr) => (Array.isArray(arr) && arr.length ? arr.map((s) => esc(s)).join('/') : '—');
const runLine = (iso) => `Run ${esc(String(iso || '').slice(0, 10) || '—')}`;

/* ---- R53/R54: LIVE 2026 rows -------------------------------------------------
 * Both records may carry a `live_2026` block measured on resolved 2026 weeks:
 *   weekly_backtest.json  {weeks, note, shipped/gated/candidate {mae, rank_corr,
 *                          topk} | null, per_week[{week, n, ...}]} — the shipped
 *                          weekly estimate as locked before kickoff vs actual PPR;
 *   parlay_backtest.json  {weeks, legs_resolved, seed | null, calibrated | null,
 *                          refit {applied, fit_weeks, reason} | null, note}.
 * Absent key: NOTHING renders. weeks == 0: the note, honestly. The never-regress
 * verdict on each card stays on the 2023-25 corpus; LIVE is measured, not judged.
 */

const liveMetrics = (m) => (isObj(m)
  ? `MAE ${dash(m.mae, 3)} · rank corr ${dash(m.rank_corr, 3)} · top-K ${pctOr(m.topk)}`
  : '—');

/** WEEKLY SPLIT GATE's LIVE 2026 row; '' when the record has no live_2026 block. */
export function liveWeeklyHtml(live) {
  if (!isObj(live)) return '';
  const weeks = Number(live.weeks);
  if (!Number.isFinite(weeks) || weeks <= 0) {
    return `<div class="gate-note">LIVE 2026 · no week resolved yet${live.note ? ` — ${esc(live.note)}` : ''}</div>`;
  }
  const sh = isObj(live.shipped) ? live.shipped : null;
  const perWeek = Array.isArray(live.per_week) ? live.per_week.filter(isObj) : [];
  const weekTxt = perWeek.map((w) => `wk ${esc(w.week)} n ${esc(w.n)}`
    + (isObj(w.shipped) ? ` MAE ${dash(w.shipped.mae, 3)}` : '')).join(' · ');
  const others = ['gated', 'candidate'].filter((k) => isObj(live[k]))
    .map((k) => `${k.toUpperCase()} ${liveMetrics(live[k])}`).join(' · ');
  return '<div class="gate-row">'
    + '<span class="gate-name">LIVE 2026</span>'
    + `<span>${esc(weeks)} week${weeks === 1 ? '' : 's'}${Number.isFinite(Number(live.rows)) ? ` · ${esc(live.rows)} rows` : ''}</span>`
    + `<span>MAE ${dash(sh && sh.mae, 3)} · rank corr ${dash(sh && sh.rank_corr, 3)}</span>`
    + '<span></span>'
    + '</div>'
    + `<div class="gate-bench">SHIPPED ${liveMetrics(sh)}${others ? ` · ${others}` : ''}`
      + (weekTxt ? ` · ${weekTxt}` : '') + '</div>'
    + `<div class="gate-note">${esc(live.note || 'Measured on resolved 2026 weeks; the never-regress verdict above stays on the 2023-25 corpus.')}</div>`;
}

/** PARLAY GATE's LIVE 2026 row; '' when the record has no live_2026 block. */
export function liveParlayHtml(live) {
  if (!isObj(live)) return '';
  const weeks = Number(live.weeks);
  if (!Number.isFinite(weeks) || weeks <= 0) {
    return `<div class="gate-note">LIVE 2026 · no week resolved yet${live.note ? ` — ${esc(live.note)}` : ''}</div>`;
  }
  const seed = isObj(live.seed) ? live.seed : null;
  const cal = isObj(live.calibrated) ? live.calibrated : null;
  const refit = isObj(live.refit) ? live.refit : null;
  const chip = refit
    ? (refit.applied === true
      ? '<span class="gate-chip gate-chip--adopted">REFIT</span>'
      : '<span class="gate-chip">NO REFIT</span>')
    : '<span></span>';
  const legs = Number.isFinite(Number(live.legs_resolved)) ? `${esc(live.legs_resolved)} legs` : '— legs';
  const fitWeeks = refit && Array.isArray(refit.fit_weeks) && refit.fit_weeks.length
    ? ` · fit weeks ${refit.fit_weeks.map((w) => esc(w)).join('/')}` : '';
  return '<div class="gate-row">'
    + '<span class="gate-name">LIVE 2026</span>'
    + `<span>${esc(weeks)} week${weeks === 1 ? '' : 's'} · ${legs}</span>`
    + `<span>seed LL ${dash(seed && seed.log_loss, 4)} → cal ${dash(cal && cal.log_loss, 4)}</span>`
    + chip
    + '</div>'
    + `<div class="gate-bench">HIT RATE seed ${pctOr(seed && seed.hit_rate)} → calibrated ${pctOr(cal && cal.hit_rate)}${fitWeeks}</div>`
    + ((refit && refit.reason) || live.note
      ? `<div class="gate-note">${esc([refit && refit.reason, live.note].filter(Boolean).join(' · '))}</div>`
      : '');
}

/** "WEEKLY SPLIT GATE" — the candidate weekly split vs the incumbent. */
export function weeklyGateCard(doc) {
  if (!isObj(doc)) return '';
  const cand = typeof doc.model_candidate === 'string' && doc.model_candidate ? doc.model_candidate : 'candidate';
  const inc = typeof doc.model_incumbent === 'string' && doc.model_incumbent ? doc.model_incumbent : 'incumbent';
  const name = `${cand} vs ${inc}`;
  const v = doc.verdict;
  if (!isObj(v) || typeof v.adopted !== 'boolean') {
    return awaitingRow(name, 'never-regress')
      + state('AWAITING VERDICT — data/weekly_backtest.json is present but carries no '
        + 'never-regress verdict yet, so nothing on it is adopted or retained and its '
        + 'numbers are not shown as judged.');
  }
  const fx = isObj(doc.fixture) ? doc.fixture : {};
  const pool = isObj(fx.pool)
    ? Object.keys(fx.pool).map((k) => `${esc(k)} ${esc(fx.pool[k])}`).join(' · ')
    : '';
  const head = '<div class="gate-row">'
    + `<span class="gate-name">${esc(name)}</span>`
    + `<span>${seasonsText(fx.seasons_scored)}</span>`
    + `<span>${Number.isFinite(Number(fx.rows)) ? `${esc(fx.rows)} rows` : '—'}</span>`
    + verdictChip(v)
    + '</div>';

  // One row per (set, metric): v1, v2 and the delta with its good-direction mark.
  const cell = (set, key) => (isObj(set) && isObj(set.v1) && isObj(set.v2) ? [set.v1[key], set.v2[key]] : [null, null]);
  const mrow = (label, set, key, opts) => {
    const [a, b] = cell(set, key);
    const fmt = opts.pct ? pctOr : (x) => dash(x, opts.digits);
    return `<tr><td>${label}</td><td>${fmt(a)}</td><td>${fmt(b)}</td><td>${deltaText(a, b, opts)}</td></tr>`;
  };
  const sets = [['POOLED', doc.pooled], ['2025 HELD OUT', doc.held_out_2025]];
  const metricRows = sets.map(([lbl, set]) => (
    mrow(`${lbl} MAE`, set, 'mae', { digits: 3, lowerIsBetter: true })
    + mrow(`${lbl} RANK CORR`, set, 'rank_corr', { digits: 3 })
    + mrow(`${lbl} TOP-K`, set, 'topk', { pct: true })
  )).join('');
  const metricTable = '<table class="pf-tbl"><thead><tr><th>METRIC</th><th>V1</th><th>V2</th>'
    + '<th>Δ V2−V1</th></tr></thead>'
    + `<tbody>${metricRows}</tbody></table>`;

  const pp = isObj(doc.per_position) ? doc.per_position : {};
  const arrow = (a, b, digits, lowerIsBetter) => {
    const t = deltaText(a, b, { digits, lowerIsBetter });
    return `${dash(a, digits)} → ${dash(b, digits)} ${t === '—' ? '' : t.slice(-1)}`;
  };
  const posRows = ['QB', 'RB', 'WR', 'TE'].filter((k) => isObj(pp[k])).map((k) => {
    const [ma, mb] = cell(pp[k], 'mae');
    const [ra, rb] = cell(pp[k], 'rank_corr');
    return `<tr><td>${k}</td><td>${arrow(ma, mb, 3, true)}</td><td>${arrow(ra, rb, 3, false)}</td></tr>`;
  }).join('');
  const posTable = posRows
    ? '<table class="pf-tbl"><thead><tr><th>POS</th><th>MAE V1 → V2</th><th>RANK CORR V1 → V2</th></tr></thead>'
      + `<tbody>${posRows}</tbody></table>`
    : '';

  const band = isObj(doc.band) ? doc.band : null;
  const bandLine = band
    ? `<div class="gate-bench">BAND · 2025 coverage v1 ${pctOr(isObj(band.v1) ? band.v1.coverage_2025 : null)} → `
      + `v2 ${pctOr(isObj(band.v2) ? band.v2.coverage_2025 : null)} · half-width v1 `
      + `${dash(isObj(band.v1) ? band.v1.half_width_2025 : null, 2)} → v2 `
      + `${dash(isObj(band.v2) ? band.v2.half_width_2025 : null, 2)}`
      + (band.rule ? ` · ${esc(band.rule)}` : '')
      + '</div>'
    : '';
  const bs = isObj(doc.bootstrap) && isObj(doc.bootstrap.delta_mae_2025) ? doc.bootstrap.delta_mae_2025 : null;
  const bsLine = bs
    ? `<div class="gate-bench">BOOTSTRAP ΔMAE 2025 (v2 − v1) · mean ${signed(bs.mean)} · `
      + `95% [${signed(bs.lo95)}, ${signed(bs.hi95)}]`
      + (bs.blocks ? ` · ${esc(bs.blocks)} blocks` : '')
      + (Number.isFinite(Number(bs.B)) ? ` · B=${esc(bs.B)}` : '')
      + '</div>'
    : '';
  const f = isObj(doc.factors) ? doc.factors : null;
  let factorLine = '';
  if (f) {
    const dvp = isObj(f.dvp) ? f.dvp : {};
    const w = isObj(f.weather) ? f.weather : {};
    const ven = isObj(f.venue) ? f.venue : {};
    const tilt = Array.isArray(f.elo_tilt_positions) && f.elo_tilt_positions.length
      ? f.elo_tilt_positions.map((p) => esc(p)).join('/') : 'none';
    const clamp = Array.isArray(ven.rel_clamp) && ven.rel_clamp.length === 2
      ? ` (rel clamp ${signed(ven.rel_clamp[0], 1)}..${signed(ven.rel_clamp[1], 1)}` 
        + (Number.isFinite(Number(ven.shrink_n0)) ? `, shrink n0 ${esc(ven.shrink_n0)}` : '') + ')'
      : '';
    factorLine = '<div class="gate-bench">FACTORS · '
      + `DvP shrink ${dash(dvp.shrink, 2)}${dvp.source ? ` (${esc(dvp.source)})` : ''} · `
      + `Elo tilt ${tilt} · `
      + `weather × pass dome ${dash(w.pass_dome, 2)} / outdoors ${dash(w.pass_outdoors, 2)} / `
      + `cold extra ${dash(w.pass_cold_extra, 2)} at ${dash(w.cold_f, 0)}°F / `
      + `RB wind ${dash(w.rb_wind, 2)} at ${dash(w.wind_mph, 0)} mph · `
      + `venue coef ${signed(ven.coef, 3)}${clamp}`
      + '</div>';
  }
  return (
    '<div class="m-explain">The candidate weekly split measured against the incumbent on real '
      + 'FINAL player-weeks from the committed corpus, walk-forward. Lower MAE is better; higher '
      + 'rank corr and top-K are better. ▲ marks a move in the good direction, ▼ a regression. '
      + 'The candidate ships only by clearing the never-regress rule below.</div>'
    + head
    + metricTable
    + liveWeeklyHtml(doc.live_2026)
    + posTable
    + bandLine
    + bsLine
    + factorLine
    + `<div class="mp-src">NEVER-REGRESS RULE · ${esc(v.rule || '—')}</div>`
    + `<div class="gate-note">${esc(v.reason || '')}</div>`
    + (doc.season_number_rule ? `<div class="gate-note">Season numbering: ${esc(doc.season_number_rule)}</div>` : '')
    + `<div class="mp-src">${runLine(doc.generated_utc)}`
      + (pool ? ` · pool ${pool}` : '')
      + (doc.policy ? ` · ${esc(doc.policy)}` : '')
      + '</div>'
  );
}

/** "PARLAY GATE" — moneyline yardstick, spread edge test, props calibration, leg correlations. */
export function parlayGateCard(doc) {
  if (!isObj(doc)) return '';
  const ml = isObj(doc.moneyline) ? doc.moneyline : null;
  const sp = isObj(doc.spread) ? doc.spread : null;
  const pr = isObj(doc.props) ? doc.props : null;
  const co = isObj(doc.correlations) ? doc.correlations : null;
  const spVerdict = sp && (sp.verdict === 'no_edge' || sp.verdict === 'edge') ? sp.verdict : null;
  const prVerdict = pr && isObj(pr.verdict) && typeof pr.verdict.adopted === 'boolean' ? pr.verdict : null;
  if (!spVerdict || !prVerdict) {
    return awaitingRow('PARLAY LEGS', 'spread · props')
      + state('AWAITING VERDICT — data/parlay_backtest.json is present but its spread '
        + 'and/or props verdict is missing, so no leg on it is judged and its numbers '
        + 'are not shown as if they were.');
  }
  const badge = '<span class="ms-badge" title="The market is a scoreboard we measure '
    + 'against, never an input">MEASUREMENT ONLY</span>';

  // MONEYLINE — ours beside the de-vigged closing line. No verdict by contract:
  // the market row is a yardstick, so the fourth column is the badge, not a chip.
  let mlHtml = '';
  if (ml) {
    const per = isObj(ml.per_season) ? Object.keys(ml.per_season).sort() : [];
    const perTxt = per.map((s) => {
      const r = isObj(ml.per_season[s]) ? ml.per_season[s] : {};
      return `${esc(s)} ours ${dash(r.incumbent_log_loss, 4)} / market ${dash(r.market_log_loss, 4)}`;
    }).join(' · ');
    mlHtml = '<div class="gate-row">'
      + '<span class="gate-name">MONEYLINE</span>'
      + `<span>ours LL ${dash(ml.incumbent_log_loss, 4)} · Brier ${dash(ml.incumbent_brier, 4)}</span>`
      + `<span>market LL ${dash(ml.market_log_loss, 4)} · Brier ${dash(ml.market_brier, 4)}</span>`
      + badge
      + '</div>'
      + `<div class="gate-bench">n ${Number.isFinite(Number(ml.n)) ? esc(ml.n) : '—'}`
        + (perTxt ? ` · ${perTxt}` : '') + '</div>'
      + (ml.note ? `<div class="gate-note">${esc(ml.note)}</div>` : '');
  }

  // SPREAD — model cover log-loss vs a flat 0.5; the verdict is the gate's own.
  const spChip = spVerdict === 'edge'
    ? '<span class="gate-chip gate-chip--adopted">EDGE</span>'
    : `<span class="gate-chip gate-chip--nopath" title="${esc(sp.reason || 'no measured edge over a flat 0.5')}">NO EDGE</span>`;
  const bins = Array.isArray(sp.pick_hit_rate_by_conviction) ? sp.pick_hit_rate_by_conviction : [];
  const binTxt = bins.filter(isObj).map((b) => (
    `${esc(b.bin)} ${pctOr(b.hit)} (n ${Number.isFinite(Number(b.n)) ? esc(b.n) : '—'})`
  )).join(' · ');
  const spHtml = '<div class="gate-row">'
    + '<span class="gate-name">SPREAD</span>'
    + `<span>cover LL ${dash(sp.model_cover_log_loss, 4)} · Brier ${dash(sp.model_brier, 4)}</span>`
    + `<span>flat LL ${dash(sp.flat_log_loss, 4)} · σ ${dash(sp.sigma, 1)}</span>`
    + spChip
    + '</div>'
    + `<div class="gate-bench">HIT RATE BY CONVICTION (n ${Number.isFinite(Number(sp.n)) ? esc(sp.n) : '—'})`
      + (binTxt ? ` · ${binTxt}` : '') + '</div>'
    + (sp.reason ? `<div class="gate-note">${esc(sp.reason)}</div>` : '');

  // PROPS — seed vs calibrated per walk-forward fold, then the fitted calibration.
  const lines = isObj(pr.lines) ? pr.lines : {};
  const sd = isObj(pr.residual_sd) ? pr.residual_sd : {};
  const kv = (o, digits) => Object.keys(o).map((k) => `${esc(k)} ${dash(o[k], digits)}`).join(' · ');
  const folds = Array.isArray(pr.folds) ? pr.folds.filter(isObj) : [];
  const foldRows = folds.map((fd) => {
    const s = isObj(fd.seed) ? fd.seed : {};
    const c = isObj(fd.calibrated) ? fd.calibrated : {};
    const picks = (m) => (Number.isFinite(Number(m.picks)) ? esc(m.picks) : '—');
    const p60 = (m) => `${pctOr(m.hit_rate_60)} (${Number.isFinite(Number(m.picks_60)) ? esc(m.picks_60) : '—'})`;
    return '<tr>'
      + `<td>${esc(fd.season)} · fit ${seasonsText(fd.fit_seasons)}</td>`
      + `<td>${dash(s.log_loss, 4)} → ${dash(c.log_loss, 4)} ${deltaText(s.log_loss, c.log_loss, { digits: 4, lowerIsBetter: true }).slice(-1)}</td>`
      + `<td>${pctOr(s.hit_rate)} (${picks(s)}) → ${pctOr(c.hit_rate)} (${picks(c)})</td>`
      + `<td>${p60(s)} → ${p60(c)}</td>`
      + '</tr>';
  }).join('');
  const foldTable = foldRows
    ? '<table class="pf-tbl"><thead><tr><th>FOLD</th><th>LOG-LOSS SEED → CAL</th>'
      + '<th>HIT (PICKS)</th><th>&gt;0.6 HIT (PICKS)</th></tr></thead>'
      + `<tbody>${foldRows}</tbody></table>`
    : '';
  const cal = isObj(pr.calibration) ? pr.calibration : {};
  const calTxt = Object.keys(cal).filter((k) => isObj(cal[k])).map((k) => (
    `${esc(k)} a ${signed(cal[k].a)} b ${signed(cal[k].b)} c ${signed(cal[k].c)}`
    + (Array.isArray(cal[k].fit_seasons) ? ` (fit ${seasonsText(cal[k].fit_seasons)})` : '')
  )).join(' · ');
  const prHtml = '<div class="gate-row">'
    + '<span class="gate-name">PROPS</span>'
    + `<span>lines ${kv(lines, 1) || '—'}</span>`
    + `<span>residual sd ${kv(sd, 1) || '—'}</span>`
    + verdictChip(prVerdict)
    + '</div>'
    + foldTable
    + `<div class="gate-bench">CALIBRATION · ${calTxt || '—'} · DvP shrink ${dash(pr.dvp_shrink, 2)}</div>`
    + `<div class="mp-src">NEVER-REGRESS RULE · ${esc(prVerdict.rule || '—')}</div>`
    + (prVerdict.reason ? `<div class="gate-note">${esc(prVerdict.reason)}</div>` : '');

  // CORRELATIONS — measured rho per leg pair beside the prior it is shrunk toward.
  let coHtml = '';
  if (co) {
    const pairs = Array.isArray(co.pairs) ? co.pairs.filter(isObj) : [];
    const rows = pairs.map((p) => (
      `<tr><td>${esc(p.label || p.key)}</td><td>${signed(p.rho, 2)}</td>`
      + `<td>${Number.isFinite(Number(p.n)) ? esc(p.n) : '—'}</td><td>${signed(p.prior, 2)}</td></tr>`
    )).join('');
    coHtml = (rows
      ? '<table class="pf-tbl"><thead><tr><th>LEG PAIR</th><th>ρ</th><th>N</th><th>PRIOR</th></tr></thead>'
        + `<tbody>${rows}</tbody></table>`
      : '')
      + `<div class="mp-src">CORRELATIONS · default ρ ${signed(co.default_rho, 2)}`
        + (co.method ? ` · ${esc(co.method)}` : '') + '</div>';
  }
  const fx = isObj(doc.fixture) ? doc.fixture : {};
  return (
    '<div class="m-explain">Every parlay leg type measured on real FINAL games and player-weeks '
      + 'from the committed corpus. Log-loss and Brier: lower is better. The MONEYLINE market '
      + 'column is a yardstick we are measured against, never an input. SPREAD earns a verdict '
      + 'only against a flat 0.5; PROPS ship calibrated only by clearing never-regress on '
      + 'every walk-forward fold.</div>'
    + mlHtml
    + spHtml
    + prHtml
    + liveParlayHtml(doc.live_2026)
    + coHtml
    + `<div class="mp-src">${runLine(doc.generated_utc)} · seasons ${seasonsText(fx.seasons)}</div>`
    + (doc.policy ? `<div class="gate-note">${esc(doc.policy)}</div>` : '')
  );
}

/* ---- R81: REPLAY LAB · CANDIDATES vs SHIPPED ---------------------------------
 * data/replay_lab.json (scripts/replay_lab.py) replays candidate parlay rules
 * against the weeks already played, on the legs that were actually locked.
 *
 * THIS CARD CHANGES NOTHING. It is a bench report: a variant is measured and
 * printed, never adopted, and no number on it feeds a shipped leg. The verdict
 * chips deliberately do NOT reuse the ADOPTED / RETAINED vocabulary of the two
 * gate cards above, because those words describe a promotion and this card has
 * no promotion path to describe.
 *
 * Absent file, or 0 weeks replayed: an honest state line, never a placeholder.
 * Only classes theme.css already styles (.pf-tbl, .gate-chip, .gate-note,
 * .mp-src, .m-explain, .state).
 */

const REPLAY_EXPLAIN = '<div class="m-explain">Candidate parlay rules re-priced '
  + 'on the SAME locked legs the slate shipped, then the archived parlays '
  + 're-combined and re-settled at the book’s own prices. Log-loss: lower is '
  + 'better, so a negative delta is the candidate winning. A verdict is claimed '
  + 'only when the 90% paired-bootstrap CI excludes 0. Nothing on this card '
  + 'changes a shipped number — this is a measurement bench, and no variant '
  + 'here is adopted by it.</div>';

/** The chip for a replay verdict. Measurement words only — never ADOPTED. */
export function replayChip(verdict, isBaseline) {
  if (isBaseline) {
    return '<span class="gate-chip" title="The probability actually locked on the '
      + 'leg — every other row is measured against this">BASELINE</span>';
  }
  if (verdict === 'better') {
    return '<span class="gate-chip" title="Lower log-loss than shipped, 90% CI '
      + 'excludes 0. MEASURED, not adopted">BETTER</span>';
  }
  if (verdict === 'worse') {
    return '<span class="gate-chip gate-chip--nopath" title="Higher log-loss than '
      + 'shipped, 90% CI excludes 0">WORSE</span>';
  }
  if (verdict === 'same') {
    return '<span class="gate-chip gate-chip--skipped" title="The 90% CI straddles '
      + '0 — no difference was measured">SAME</span>';
  }
  return '<span class="gate-chip gate-chip--skipped" title="Nothing resolved to '
    + 'measure on">—</span>';
}

/**
 * The best selection rule in a variant's `rules` block by ROI at fair prices,
 * among the rules that actually selected something. Null when none did — an
 * empty selection has no ROI, and 0 would read as break-even.
 */
export function bestSelectionRule(rules) {
  if (!isObj(rules)) return null;
  let best = null;
  for (const name of Object.keys(rules)) {
    const r = rules[name];
    if (!isObj(r) || !Number.isFinite(Number(r.n)) || Number(r.n) <= 0) continue;
    if (!Number.isFinite(Number(r.roi_fair))) continue;
    if (best === null || Number(r.roi_fair) > Number(best.roi_fair)) {
      best = { name, ...r };
    }
  }
  return best;
}

/** "REPLAY LAB · CANDIDATES vs SHIPPED" — one row per variant. */
export function replayLabCard(doc) {
  if (!isObj(doc)) {
    return REPLAY_EXPLAIN
      + state('NOT PRESENT — data/replay_lab.json has not been written on this '
        + 'deploy yet, so there is nothing to report. The lab runs on every '
        + 'pipeline run, right after the parlay-leg resolver.');
  }
  const weeks = Array.isArray(doc.weeks_replayed) ? doc.weeks_replayed : [];
  const legs = isObj(doc.legs) ? doc.legs : {};
  const baseline = typeof doc.baseline === 'string' ? doc.baseline : 'shipped';
  const stamp = `<div class="mp-src">${runLine(doc.generated_utc)} · baseline `
    + `${esc(baseline)} · weeks ${weeks.length ? weeks.map((w) => esc(w)).join('/') : '—'}`
    + ` · ${Number.isFinite(Number(legs.resolved)) ? esc(legs.resolved) : '—'} resolved leg(s)`
    + '</div>';
  if (!weeks.length) {
    return REPLAY_EXPLAIN
      + state('0 WEEKS REPLAYED — no locked parlay leg has resolved yet, so every '
        + 'metric in the record is null. Nothing is measured here, and nothing '
        + 'is claimed.')
      + stamp;
  }
  const variants = isObj(doc.variants) ? doc.variants : {};
  const names = Object.keys(variants);
  // baseline first, then the candidates in registry order.
  names.sort((a, b) => (a === baseline ? -1 : b === baseline ? 1 : 0));
  const rows = names.map((name) => {
    const v = isObj(variants[name]) ? variants[name] : {};
    const pooled = isObj(v.legs) && isObj(v.legs.pooled) ? v.legs.pooled : {};
    const isBase = name === baseline;
    // The baseline has no CI to show: it is not being compared to anything, and
    // a [0.0000, 0.0000] there reads as a measurement of zero difference.
    const ci = !isBase && Array.isArray(pooled.ci90) && pooled.ci90.length === 2
      ? `[${signed(pooled.ci90[0], 4)}, ${signed(pooled.ci90[1], 4)}]` : '—';
    const delta = isBase ? '—'
      : deltaText(pooled.shipped_log_loss_same_legs, pooled.log_loss,
        { digits: 4, lowerIsBetter: true });
    const best = bestSelectionRule(isObj(v.parlays) ? v.parlays.rules : null);
    const roi = best
      ? `${esc(best.name)} ${fmtPct(best.roi_fair)} (n ${esc(best.n)})`
      : '—';
    return '<tr>'
      + `<td>${esc(name)}</td>`
      + `<td>${Number.isFinite(Number(pooled.n)) ? esc(pooled.n) : '—'}</td>`
      + `<td>${dash(pooled.log_loss, 4)} ${delta}</td>`
      + `<td>${ci}</td>`
      + `<td>${replayChip(v.verdict, isBase)}</td>`
      + `<td>${roi}</td>`
      + '</tr>';
  }).join('');
  const table = '<table class="pf-tbl"><thead><tr><th>VARIANT</th><th>N</th>'
    + '<th>LOG-LOSS vs SHIPPED</th><th>90% CI OF Δ</th><th>VERDICT</th>'
    + '<th>BEST RULE · ROI ON $100</th></tr></thead>'
    + `<tbody>${rows}</tbody></table>`;
  const reasons = isObj(legs.unresolved_by_reason) ? legs.unresolved_by_reason : {};
  const reasonTxt = Object.keys(reasons).sort()
    .map((k) => `${esc(k)} ${esc(reasons[k])}`).join(' · ');
  const bench = '<div class="gate-bench">LEGS · '
    + `${Number.isFinite(Number(legs.locked)) ? esc(legs.locked) : '—'} locked · `
    + `${Number.isFinite(Number(legs.resolved)) ? esc(legs.resolved) : '—'} resolved`
    + (reasonTxt ? ` · unresolved ${reasonTxt}` : '') + '</div>';
  // The first two limits are the two a reader of THIS table needs: what the lab
  // cannot replay at all, and why the ROI column moves only through selection.
  const limits = Array.isArray(doc.limits) ? doc.limits.filter((x) => typeof x === 'string') : [];
  const notes = limits.slice(0, 2).map((t) => `<div class="gate-note">${esc(t)}</div>`).join('');
  return REPLAY_EXPLAIN + table + bench + notes + stamp;
}

/* ---- mount ------------------------------------------------------------------ */

export default async function mountModel(el) {
  /* R78 — the passphrase gate, FIRST: a locked view must not fetch a single
   * model contract (the network tab is a view too). Obscurity, not security —
   * see MODEL_PASS_SHA256 above. */
  if (!isModelUnlocked(typeof localStorage === 'undefined' ? null : localStorage)) {
    const paint = (msg) => {
      el.innerHTML = renderLockCard(msg);
      const form = el.querySelector('.m-lock-form');
      const input = el.querySelector('.mp-input');
      if (input) input.focus();
      if (!form) return;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        let hex = '';
        try {
          hex = await sha256Hex((input && input.value) || '');
        } catch (_) {
          // No crypto.subtle: an insecure context or a very old browser. Say so
          // and stay locked — never fall through to an unlocked render.
          paint('Passphrase check needs a secure (https) page.');
          return;
        }
        if (hex === MODEL_PASS_SHA256) {
          try { localStorage.setItem(MODEL_LOCK_KEY, MODEL_PASS_SHA256); } catch (_) { /* session-only */ }
          mountModel(el);
        } else {
          paint('Wrong passphrase.');
        }
      });
    };
    // crypto.subtle is absent outside a secure context; the form could never
    // succeed there, so the card says why up front instead of failing silently.
    const subtle = (typeof crypto !== 'undefined' && crypto && crypto.subtle) || null;
    paint(subtle ? undefined : 'Passphrase check needs a secure (https) page.');
    return;
  }

  el.innerHTML = '<div class="state state--loading">Loading model dashboard…</div>';
  const [metaRes, tuningRes, oddsRes, mktRes, statusRes, weeklyRes, parlayRes, replayRes] =
    await Promise.allSettled([
      getMeta(), getModelTuning(), getPlayoffOdds(), getMarketPrices(), getPipelineStatus(),
      // R51 — both resolve to null when absent (never reject); null paints nothing.
      loadWeeklyBacktest(), loadParlayBacktest(),
      // R81 — the replay lab; null paints the card's honest NOT PRESENT line.
      loadReplayLab(),
    ]);
  const meta = metaRes.status === 'fulfilled' ? metaRes.value : null;
  const tuning = tuningRes.status === 'fulfilled' ? tuningRes.value : null;
  const odds = oddsRes.status === 'fulfilled' ? oddsRes.value : null;
  const markets = mktRes.status === 'fulfilled' ? mktRes.value : null;
  const status = statusRes.status === 'fulfilled' ? statusRes.value : null;
  const weeklyBacktest = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
  const parlayBacktest = parlayRes.status === 'fulfilled' ? parlayRes.value : null;
  const replayLab = replayRes.status === 'fulfilled' ? replayRes.value : null;
  // R51 — painted once; '' means the file is absent and the card is omitted.
  const weeklyHtml = weeklyGateCard(weeklyBacktest);
  const parlayHtml = parlayGateCard(parlayBacktest);

  /* Per-card stamp (R30b). The blanket ESTIMATE pill sat on every header —
   * including PROMOTION GATE and MARKET YARDSTICK, whose own bodies say
   * MEASUREMENT ONLY, so the header contradicted the content it introduced.
   * A card that PROJECTS forward (playoff sims; the adopted params that price
   * upcoming games) wears ESTIMATE. A card that REPORTS what already happened
   * (feed status, backtest/gate/yardstick/calibration results on real FINAL
   * games) wears MEASURED. A pure status/registry card wears neither. No card
   * ever wears both. */
  const STAMP = {
    estimate: ' <span class="est">ESTIMATE</span>',
    measured: ' <span class="ms-badge" title="Reports observed results on real '
      + 'FINAL games or live feed state — nothing on this card is a projection'
      + '">MEASURED</span>',
  };
  const card = (title, body, extra, stamp) => (
    `<section class="card mcard ${extra || ''}">` +
      `<div class="m-head">${title}${STAMP[stamp] || ''}</div>` +
      body +
    '</section>'
  );

  el.innerHTML =
    MODEL_HEAD +
    card('DATA FRESHNESS · FEEDS & UPDATE SCHEDULE',
      freshnessCard(status, Date.now()), 'm-fresh', 'measured') +
    card('ADOPTED PARAMETERS', paramsCard(tuning), 'm-params', 'estimate') +
    card('BACKTEST · WALK-FORWARD', backtestCard(tuning), 'm-backtest', 'measured') +
    card('PROMOTION GATE · CANDIDATE FAMILIES', gateCard(tuning), 'm-gate', 'measured') +
    card('MARKET YARDSTICK · OURS vs CLOSING LINE', marketTrendCard(tuning), 'm-mkt', 'measured') +
    card('CALIBRATION · PREDICTED vs ACTUAL', calibrationCard(tuning), 'm-cal', 'measured') +
    // R51 — the two never-regress gate records close the MEASURED cluster
    // (backtest → promotion gate → yardstick → calibration → these two) and
    // sit before the status / forward-looking cards. Both omitted when absent.
    (weeklyHtml ? card('WEEKLY SPLIT GATE · CANDIDATE vs INCUMBENT', weeklyHtml, 'm-weekly-gate', 'measured') : '') +
    (parlayHtml ? card('PARLAY GATE · MONEYLINE · SPREAD · PROPS', parlayHtml, 'm-parlay-gate', 'measured') : '') +
    // R81 — the measure-only replay bench, directly after the PARLAY GATE it
    // reports beside. ALWAYS rendered: when the file is absent the card says so
    // in one line, which is the honest state and not an omission.
    card('REPLAY LAB · CANDIDATES vs SHIPPED', replayLabCard(replayLab), 'm-replay-lab', 'measured') +
    card('SEASON LOCKS', locksCard(tuning), 'm-locks') +
    card('PLAYOFF ODDS — OURS vs THE MARKETS', playoffsCard(odds, markets), 'm-playoffs', 'estimate') +
    card('SIGNAL REGISTRY', signalsCard(meta), 'm-signals') +
    // R49 — both omitted entirely on an older meta (the painters return '').
    (baselineCard(meta) ? card('PROJECTION BASELINE', baselineCard(meta), 'm-baseline', 'estimate') : '') +
    (learningCard(meta) ? card('LEARNING RECORD', learningCard(meta), 'm-learning', 'measured') : '');
}
