# R82 review evidence

Baseline: `886b5bb40e68e90f6074489723fbe4c3703c0935`, 2026-09-17.

Report: [RCA/code review](../../qa/CODEX_REVIEW_R82_FOR_CLAUDE.md).
Handoff: [Claude starting brief](../../qa/CLAUDE_HANDOFF_R82.md).

## Offline reproductions

Run from the repository root (no network, no production writes):

```bash
node docs/reviews/2026-09-17/probe.mjs
python3 docs/reviews/2026-09-17/probe.py
```

The probes deliberately assert that defects **exist at the reviewed baseline**. Their exit 0 is not a correctness endorsement. As fixes land, convert the relevant cases into behavioral regression tests and revise expected results. The JS probe requires Node >=22 for Map.groupBy. On this Mac the working Python executable was `/Users/jliddar/.pyenv/versions/3.12.9/bin/python3`; the system executable was blocked by the Xcode license requirement.

| Artifact | Contents |
| --- | --- |
| [probe.mjs](probe.mjs) / [output](probe-js-output.json) | Lost sides, mixed-game correlation, permutation dependence, probability bounds, assumed price classified as quoted, tier dependence on price, rejected placeholder, duplicate ML, persistent cache, historical-vs-locked predictions |
| [probe.py](probe.py) / [output](probe-python-output.json) | Post-event lock scoring, nonchronological folds, persisted/refit params, synthetic price serialization, conflicting prop payouts, mutable weekly archive, unsupported narrative acceptance |
| [gate.log](gate.log) | Data/smoke + 1,685 feature tests + four model gates pass; browser step then fails to bind a sandboxed port |
| [browser-tests.log](browser-tests.log) | Successful rerun: 279 web/PWA-emulation/performance tests passed |
| [browser-observations.json](browser-observations.json) | Additional local browser observations, including deliberately delayed optional market data |
| [parlays-mobile.png](parlays-mobile.png) | Published page, 402×874; controls and glossary fill the initial viewport |
| [my-parlays-mobile.png](my-parlays-mobile.png) | MY, seed DET, 402×874; repaired R82 geometry |
| [my-parlays-desktop.png](my-parlays-desktop.png) | MY, seed DET, 1280×900 |
| [players-mobile.png](players-mobile.png) | Players BASE, 402×874 |
| [slate-history-desktop.png](slate-history-desktop.png) | Historical week 1 Slate, 1280×900 |

## Test commands used

```bash
PATH=/Users/jliddar/.pyenv/versions/3.12.9/bin:$PATH bash tests/run_gate.sh
```

After the port-binding restriction, a localhost-only server was started with explicit permission:

```bash
/Users/jliddar/.pyenv/versions/3.12.9/bin/python3 -m http.server 4321 --bind 127.0.0.1
```

Playwright's locked package expected Chromium revision 1228, which was absent. The successful rerun used the existing revision 1223:

```bash
PATH=/Users/jliddar/.pyenv/versions/3.12.9/bin:$PATH \
PW_CHROMIUM='/Users/jliddar/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
npx playwright test --config tests/playwright.config.mjs --workers=2
```

For a portable rerun, use CI's Node 22/Python 3.11 and the browser installed for the pinned Playwright package. `npm ci` installed the committed dev dependencies without changing tracked package files. Browser verification used the repository's test unlock flag in an isolated local session; no credentials were needed.

## Delayed optional-feed reproduction

In the local browser, after loading Players and unlocking via the test fixture:

```js
const data = await import('/app/data.js');
data.clearCache();
const original = window.fetch;
let release;
window.fetch = (url, options) => String(url).includes('market_prices.json')
  ? new Promise(resolve => { release = () => original(url, options).then(resolve); })
  : original(url, options);
location.hash = '#/';
for (let i = 0; i < 30 && !release; i++) {
  await new Promise(resolve => setTimeout(resolve, 50));
}
location.hash = '#/players';
await new Promise(resolve => setTimeout(resolve, 600));
console.log(location.hash, document.querySelector('#view').innerText);
window.fetch = original;
if (release) release();
```

Observed `#/players` with `Loading slate…`. The fetch replacement was restored and the request released afterward. This demonstrates head-of-line blocking for the duration of a pending optional request; it is not an assertion that a specific real provider was down.

## Limits and provenance

These are local observations of pinned code/data, not recordings from production. The available browser skill guided interactive inspection and screenshots; the repository's Playwright suite supplied the automated browser gate. The optional narrative probes used pure functions and made no model API calls. No upstream data builders, production deployment, GitHub writes, secrets, or external messaging were involved.
