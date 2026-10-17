/* Browser acceptance for saved model state. Approval pins here are explicitly
 * synthetic UI fixtures, NOT a real approval or a fitted-quality assertion.
 * The actual producer/owner/fitter round trip is week6_period_return.test.mjs.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const created = '2026-10-16T20:00:00Z';
const fixture = JSON.parse(execFileSync('python3', ['-B', '-'], {
  cwd: new URL('../..', import.meta.url), encoding: 'utf8', input: `import json
from scripts import build_leg_pool as B
from tests.fixtures.period_return import inputs
i,s,_,_=inputs(6,'${created}',n=24,tag='browser-display')
p=B.build(i)
i['pool_backtest']['live_2026']={'applied':True,'adjustment':{'a':.3,'b':1.1},
 'receipt_policy':p['learning_receipt_policy'],'base_model_version':p['base_model_version']}
print(json.dumps({'pool':B.build(i),'schedule':s}))
` }));
const H = (c) => `sha256:${c.repeat(64)}`;
function displayPool() {
  const p = structuredClone(fixture.pool);
  p.calibration_return = { version: 2, action: 'approve', scope_id: H('1'), candidate_id: H('2'),
    artifact_id: H('3'), owner_head_event_id: H('4'), application_context_id: H('5'),
    expires_utc: '2026-10-17T05:00:00Z',
    evidence_basis: 'retrospective_refitting_policy_not_fixed_artifact_prospective_validation' };
  const { action: _, ...context } = p.calibration_return;
  for (const player of p.players) for (const rung of player.rungs) {
    rung.learning_receipt.input_context.calibration_return = { ...context };
    rung.learning_receipt.source_timestamps.return_schedule = created;
  }
  return p;
}

async function openMy(page, pool) {
  // Only Date.now changes: the resume test exercises the real registered
  // listener, rather than depending on a particular Playwright clock version.
  await page.addInitScript(({ initial }) => {
    window.__learningFixtureNow = initial;
    Date.now = () => window.__learningFixtureNow;
  }, { initial: Date.parse(created) + 1000 });
  await page.route('**/data/leg_pool.json*', (r) => r.fulfill({ json: pool }));
  await page.route('**/data/schedule_full.json*', (r) => r.fulfill({ json: fixture.schedule }));
  await page.goto('/#/parlays');
  await page.locator('.scopeseg [data-seg="my"]').click();
  await expect(page.locator('#mp-input')).toBeVisible();
}

test('MY shows the consumed versions at mobile width, expires on resume, and leaves moneylines available', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const p = displayPool();
  const player = p.players.find((row) => row.rungs.some((r) => Math.abs(r.model_prob - .5) <= .1));
  expect(player).toBeTruthy();
  await openMy(page, p);
  const status = page.locator('#mp-learning');
  await expect(status).toContainText('Owner-selected correction in saved pool');
  await status.locator('summary').click();
  await expect(status).toContainText(p.base_model_version);
  await expect(status).toContainText(p.calibration_return.artifact_id);
  await expect(status).toContainText('current owner authority and live pipeline health are not checked');
  const bounds = await status.boundingBox();
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
  const overflow = await status.evaluate((node) => [...node.querySelectorAll('dd')]
    .some((dd) => dd.scrollWidth > dd.clientWidth + 1));
  expect(overflow).toBe(false);
  await page.screenshot({ path: info.outputPath('my-saved-correction-mobile.png') });
  await page.locator('#mp-input').fill(player.player);
  await page.locator('#mp-input').press('Enter');
  await expect(page.locator('.mp-card').first()).toBeVisible();
  await expect(page.locator('.mp-card').first()).toContainText(player.player);
  await page.evaluate((expires) => {
    window.__learningFixtureNow = Date.parse(expires);
    document.dispatchEvent(new Event('visibilitychange'));
  }, p.calibration_return.expires_utc);
  await expect(status).toContainText('Approval expired — MY props withheld');
  await expect(page.locator('.mp-card')).toHaveCount(0);
  await expect(page.locator('#mp-list')).toContainText('Refresh the pool before using MY yardage props');
  await page.locator('.mp-seeds [data-drop]').click();
  await page.locator('#mp-input').fill(player.player);
  await expect(page.locator('#mp-suggest .est').first()).toHaveText('PROP MODEL HELD');
  await page.locator('#mp-input').fill(player.team);
  await page.locator('#mp-input').press('Enter');
  await expect(page.locator('.mp-card').first()).toBeVisible();
  const names = await page.locator('.mp-card .leg-nm').allTextContents();
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((name) => name.endsWith(' ML'))).toBe(true);
  await page.locator('.scopeseg [data-seg="game"]').click();
  await expect(status).toBeHidden();
  expect(errors).toEqual([]);
});

test('inconsistent display metadata holds props, never displays an unrelated proposal as applied', async ({ page }) => {
  const p = displayPool();
  p.calibration_return.artifact_id = H('9');
  await openMy(page, p);
  const status = page.locator('#mp-learning');
  await expect(status).toContainText('MY prop correction withheld');
  await expect(status).not.toContainText(H('9'));
});

test('an old pool without receipts reports unknown, not a functioning self-learning loop', async ({ page }) => {
  const p = structuredClone(fixture.pool);
  for (const player of p.players) for (const rung of player.rungs) delete rung.learning_receipt;
  await openMy(page, p);
  await expect(page.locator('#mp-learning')).toContainText('Learning version unavailable');
  await expect(page.locator('#mp-learning')).not.toContainText('Owner-selected correction');
});
