/* app/views/model.js — the MODEL tab (#/model): model transparency dashboard.
 *
 * The analytics ARE the product, so they get a first-class surface:
 *   .m-params    the ADOPTED game params vs the shipped defaults + provenance
 *   .m-backtest  incumbent vs adopted log-loss/Brier + top-10 trial bars
 *   .m-locks     in-season lock grading status (honest day-zero message)
 *   .m-signals   the 32-signal weight table; market signals carry a
 *                "MARKET · DISPLAY ONLY" badge (mirrors the validator policy)
 *   .m-playoffs  simulated playoff/division/conference/champion odds (OUR
 *                model only) with Kalshi/Polymarket SB futures alongside,
 *                labeled display-only — the scoreboard, never an input.
 *
 * Every card degrades to a .state message when its feed is absent (older
 * deploy) — the view never blanks. Pure helpers exported for unit tests.
 */

import {
  getMeta, getModelTuning, getPlayoffOdds, getMarketPrices, getPipelineStatus,
} from '../data.js';
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

/** Percent with one decimal ("15.0%"); '—' for non-finite. */
export function fmtPct(p) {
  const n = Number(p);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
}

/**
 * Top `n` distinct trials from model_tuning history by log-loss (best first).
 * `history` is model_tuning.json history[]: entries may carry trials[] each
 * {hfa_elo|hfa, revert, k, log_loss}. Non-numeric log_loss rows dropped.
 * Pure — unit-tested directly.
 */
export function topTrials(history, n = 10) {
  const rows = [];
  (Array.isArray(history) ? history : []).forEach((h) => {
    (Array.isArray(h && h.trials) ? h.trials : []).forEach((t) => {
      const ll = Number(t && t.log_loss);
      if (Number.isFinite(ll)) {
        rows.push({
          hfa: Number(t.hfa_elo != null ? t.hfa_elo : t.hfa),
          revert: Number(t.revert),
          k: Number(t.k),
          log_loss: ll,
        });
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
 * improvement, reason, appliable, appNote}. status: 'adopted' | 'retained' |
 * 'skipped'.
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

function paramsCard(tuning) {
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
  return (
    row('HOME FIELD (Elo)', gp.hfa_elo, DEFAULTS.hfa_elo) +
    row('SEASON REVERT', gp.revert, DEFAULTS.revert) +
    row('K (update speed)', gp.k, DEFAULTS.k) +
    `<div class="mp-src">Adopted ${esc(String(gp.adopted_utc || '').slice(0, 10))} · ${esc(gp.source || '')}</div>` +
    '<div class="m-explain">These are the fitted parameters every game probability is priced '
      + 'with — earned against real seasons through the NEVER-REGRESS gate, not hand-tuned.</div>'
  );
}

function backtestCard(tuning) {
  const hist = (tuning && Array.isArray(tuning.history)) ? tuning.history : [];
  const trials = topTrials(hist, 10);
  if (trials.length === 0) {
    return state('No backtest trials recorded yet.');
  }
  const worst = trials[trials.length - 1].log_loss;
  const best = trials[0].log_loss;
  const span = Math.max(worst - best, 1e-6);
  const bars = trials.map((t, i) => {
    // Bar length: best trial fills, others shrink with their loss gap.
    const w = 100 - ((t.log_loss - best) / span) * 60;
    return (
      `<div class="bt-row${i === 0 ? ' bt-row--best' : ''}">` +
        `<span class="bt-lbl">hfa ${esc(t.hfa)} · rev ${esc(t.revert)} · k ${esc(t.k)}</span>` +
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

function gateCard(tuning) {
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
    const chip = r.status === 'adopted'
      ? '<span class="gate-chip gate-chip--adopted">ADOPTED</span>'
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

function locksCard(tuning) {
  const resolved = Number(tuning && tuning.resolved_locks) || 0;
  if (resolved > 0) {
    return state(`${resolved} locks resolved — in-season grading active.`);
  }
  return state('In-season lock grading begins when 2026 games go FINAL: every '
    + 'pre-kickoff prediction is locked, graded against the result, and fed '
    + 'back through the same NEVER-REGRESS gate.');
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

function playoffsCard(odds, markets) {
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
    `<div class="m-explain">${esc(`Simulated from OUR fitted Elo (${(odds.sims || 0).toLocaleString()} seasons, simplified tiebreakers) — no market input. `)}` +
      'KALSHI / POLYMKT columns are the markets\' Super Bowl prices for comparison ' +
      '<span class="ms-badge">MARKET · DISPLAY ONLY</span></div>' +
    head + rows
  );
}

/* ---- mount ------------------------------------------------------------------ */

export default async function mountModel(el) {
  el.innerHTML = '<div class="state state--loading">Loading model dashboard…</div>';
  const [metaRes, tuningRes, oddsRes, mktRes, statusRes] = await Promise.allSettled([
    getMeta(), getModelTuning(), getPlayoffOdds(), getMarketPrices(), getPipelineStatus(),
  ]);
  const meta = metaRes.status === 'fulfilled' ? metaRes.value : null;
  const tuning = tuningRes.status === 'fulfilled' ? tuningRes.value : null;
  const odds = oddsRes.status === 'fulfilled' ? oddsRes.value : null;
  const markets = mktRes.status === 'fulfilled' ? mktRes.value : null;
  const status = statusRes.status === 'fulfilled' ? statusRes.value : null;

  const card = (title, body, extra) => (
    `<section class="card mcard ${extra || ''}">` +
      `<div class="m-head">${title} <span class="est">ESTIMATE</span></div>` +
      body +
    '</section>'
  );

  el.innerHTML =
    '<header class="view-head">' +
      '<h1 class="view-title">MODEL</h1>' +
      '<span class="view-sub">WHAT THE AI HAS LEARNED · FULL TRANSPARENCY</span>' +
    '</header>' +
    card('DATA FRESHNESS · FEEDS & UPDATE SCHEDULE',
      freshnessCard(status, Date.now()), 'm-fresh') +
    card('ADOPTED PARAMETERS', paramsCard(tuning), 'm-params') +
    card('BACKTEST · WALK-FORWARD', backtestCard(tuning), 'm-backtest') +
    card('PROMOTION GATE · CANDIDATE FAMILIES', gateCard(tuning), 'm-gate') +
    card('MARKET YARDSTICK · OURS vs CLOSING LINE', marketTrendCard(tuning), 'm-mkt') +
    card('CALIBRATION · PREDICTED vs ACTUAL', calibrationCard(tuning), 'm-cal') +
    card('SEASON LOCKS', locksCard(tuning), 'm-locks') +
    card('PLAYOFF ODDS — OURS vs THE MARKETS', playoffsCard(odds, markets), 'm-playoffs') +
    card('SIGNAL REGISTRY', signalsCard(meta), 'm-signals');
}
