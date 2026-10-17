// R133 — the − n + leg stepper replaced the 2 LEG … 7 LEG chips on WEEK and
// GAME. Drive it to `n` ('all' or a number) the way a viewer does: one tap at a
// time, reading the count the stepper shows.
export async function setLegs(page, n) {
  const want = String(n).toUpperCase();
  const shown = page.locator('#td-controls .td-step-n');
  await shown.waitFor({ timeout: 15000 });
  for (let i = 0; i < 14; i += 1) {
    const cur = (await shown.textContent()).trim();
    if (cur === want) return;
    const curN = cur === 'ALL' ? 0 : Number(cur);
    const wantN = want === 'ALL' ? 0 : Number(want);
    await page.click(`#td-controls [data-step="${wantN > curN ? 1 : -1}"]`);
    await page.waitForFunction(([prev]) => {
      const el = document.querySelector('#td-controls .td-step-n');
      return el && el.textContent.trim() !== prev;
    }, [cur], { timeout: 5000 });
  }
  throw new Error(`leg stepper never reached ${want}`);
}

/** The bucket counts a scope's chips show: its review rows that are on the slate. */
export function scopedBuckets(rows, scope, onSlate = () => true) {
  const out = { all_hit: 0, push: 0, partial: 0, all_missed: 0, pending: 0 };
  for (const p of rows) {
    if ((p.scope === 'week' ? 'week' : 'game') !== scope || !onSlate(p)) continue;
    if (p.bucket in out) out[p.bucket] += 1;
  }
  return out;
}
