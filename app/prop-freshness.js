export function propInjuryDeadline(pool) {
  if (!pool || !Object.hasOwn(pool, 'prop_injury_expires_utc')) return Infinity;
  const value = pool.prop_injury_expires_utc;
  const deadline = typeof value === 'string' && value.endsWith('Z') ? Date.parse(value) : NaN;
  return Number.isFinite(deadline) ? deadline : -Infinity;
}

export const PROP_INJURY_HOLD = 'Player props are on hold until fresh injury data is published.';
