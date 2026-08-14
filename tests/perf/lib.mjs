/* tests/perf/lib.mjs — shared harness helpers for the R25 mount-cost RCA.
 *
 * MEASUREMENT ONLY. Nothing here is imported by the app or by the gate suite
 * (tests/playwright.config.mjs testMatch only picks up web/ and pwa/ specs), so
 * this directory cannot change the 1020 unit / 168 e2e baseline.
 *
 * How a "route mount" is timed, so the numbers can be audited:
 *   t0                 = performance.now() immediately before location.hash is set
 *   mutation stream    = MutationObserver on #view {childList, subtree, characterData}
 *   mount complete     = the LAST mutation before QUIET_MS of DOM silence
 *   mountMs            = lastMutation - t0
 * Every view paints by assigning innerHTML, so the mutation stream is a faithful
 * proxy for "the view finished putting pixels on the page".
 */

export const QUIET_MS = 250;
export const BASE = 'http://127.0.0.1:4321';

export const VIEWPORTS = {
  phone: { name: 'phone-402x874', width: 402, height: 874, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  ipad: { name: 'ipad-1024x1366', width: 1024, height: 1366, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

// Two real ids out of data/player_projections.json (CMC vs Puka Nacua).
export const COMPARE_A = 'espn-3117251';
export const COMPARE_B = 'espn-4426515';

export const ROUTES = [
  ['#/', 'slate'],
  ['#/players', 'players'],
  ['#/parlays', 'parlays'],
  ['#/team', 'team'],
  ['#/lineup', 'lineup'],
  ['#/model', 'model'],
  [`#/compare?a=${COMPARE_A}&b=${COMPARE_B}`, 'compare'],
];

/** Init script: unlock the password gate + install the in-page recorder. */
export const INIT_SCRIPT = `
try { localStorage.setItem('nfl2026.unlock.v1', '1'); } catch (_) {}
(() => {
  const R = {
    longTasks: [],
    mutations: [],
    observing: false,
  };
  window.__perf = R;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        R.longTasks.push({ start: e.startTime, dur: e.duration, name: e.name });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (_) {}

  R.attach = () => {
    if (R.observing) return;
    const view = document.getElementById('view');
    if (!view) return;
    R.observing = true;
    new MutationObserver((records) => {
      const t = performance.now();
      for (const rec of records) {
        let id = '';
        let node = rec.target;
        while (node && node.nodeType === 1 && !id) { id = node.id || ''; node = node.parentNode; }
        R.mutations.push({ t, id, type: rec.type, added: rec.addedNodes ? rec.addedNodes.length : 0 });
      }
    }).observe(view, { childList: true, subtree: true, characterData: true, attributes: false });
  };
  R.reset = () => { R.longTasks.length = 0; R.mutations.length = 0; };
  document.addEventListener('DOMContentLoaded', R.attach);
  if (document.readyState !== 'loading') R.attach();
})();
`;

/** Wait until #view has been DOM-quiet for QUIET_MS; returns the mount record. */
export async function waitQuiet(page, t0, timeoutMs = 30000) {
  return page.evaluate(async ({ quiet, t0, timeoutMs }) => {
    const R = window.__perf;
    const deadline = performance.now() + timeoutMs;
    // Poll for silence rather than racing a promise so a view that paints in
    // several bursts (paintDraft/paintRoster/paintCands/...) is not cut short.
    for (;;) {
      await new Promise((r) => setTimeout(r, 25));
      const now = performance.now();
      const last = R.mutations.length ? R.mutations[R.mutations.length - 1].t : null;
      if (last != null && now - last >= quiet) break;
      if (now > deadline) break;
    }
    const muts = R.mutations.filter((m) => m.t >= t0);
    const last = muts.length ? muts[muts.length - 1].t : null;
    const res = performance.getEntriesByType('resource')
      .filter((e) => e.startTime >= t0 - 2)
      .map((e) => ({ name: e.name, start: e.startTime, end: e.responseEnd, size: e.encodedBodySize, dec: e.decodedBodySize }));
    return {
      mountMs: last == null ? null : last - t0,
      mutationCount: muts.length,
      firstMutation: muts.length ? muts[0].t - t0 : null,
      mutationsByTarget: muts.reduce((acc, m) => { acc[m.id || '(view)'] = (acc[m.id || '(view)'] || 0) + 1; return acc; }, {}),
      mutationTimeline: muts.map((m) => ({ dt: +(m.t - t0).toFixed(1), id: m.id || '(view)' })),
      longTasks: R.longTasks.filter((l) => l.start >= t0 - 2 && l.start <= (last == null ? performance.now() : last + 50))
        .map((l) => ({ dt: +(l.start - t0).toFixed(1), dur: +l.duration || +l.dur })),
      resources: res,
    };
  }, { quiet: QUIET_MS, t0, timeoutMs });
}

/** Navigate to a hash route and time the mount. */
export async function mountRoute(page, hash) {
  const res = await page.evaluate((h) => {
    // An identical hash fires no hashchange => no mount at all. Fail loudly
    // rather than silently reporting a null (or a stale) mount time.
    if ((window.location.hash || '#/') === h) return { same: true };
    window.__perf.reset();
    const t = performance.now();
    // Assign in the same task so t0 and the router kick-off are not separated
    // by an event-loop turn.
    window.location.hash = h;
    return { t };
  }, hash);
  if (res.same) throw new Error(`mountRoute: hash already ${hash} — no navigation would occur`);
  const t0 = res.t;
  const rec = await waitQuiet(page, t0);
  rec.hash = hash;
  return rec;
}

export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function pct(xs, p) {
  const a = xs.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))];
}
export function stats(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  if (!a.length) return null;
  return {
    n: a.length,
    min: +Math.min(...a).toFixed(1),
    med: +median(a).toFixed(1),
    max: +Math.max(...a).toFixed(1),
    p25: +pct(a, 25).toFixed(1),
    p75: +pct(a, 75).toFixed(1),
    all: a.map((v) => +v.toFixed(1)),
  };
}
