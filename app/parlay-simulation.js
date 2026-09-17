// Display-only simulation. Never a model input or an executable sportsbook quote.
export const SIMULATION_NOTE = 'SIMULATION · multiply 1/IMPL for each leg; no same-game book adjustment. Net excludes the $100 stake. IMPL may be assumed, fair, or unverified—not an executable quote.';

/** Plain text, fixed $100 stake; never describes a simulation as a placed bet. */
export function simulationBreakdown(money) {
  const net = money?.net_fair;
  if (typeof net !== 'number' || !Number.isFinite(net)) return '$100 stake · simulated return unavailable';
  const dollars = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$100 stake → ${dollars(100 + net)} simulated gross${money.kind === 'potential' ? ' if hit' : ''}`;
}

export function legKey(leg) {
  return JSON.stringify([leg.market, leg.selection]);
}

export function matchingLegs(card, review) {
  const legs = card?.legs || [];
  const graded = review?.legs || [];
  const byKey = new Map(graded.map((leg) => [legKey(leg), leg]));
  if (!legs.length || legs.length !== graded.length || byKey.size !== graded.length
      || new Set(legs.map(legKey)).size !== legs.length) return null;
  const matched = legs.map((leg) => byKey.get(legKey(leg)));
  return matched.every(Boolean) ? matched : null;
}

/** Null is unavailable, never a made-up -110 price. A loss still loses the stake. */
export function simulateMoney(legs, outcomes = null) {
  const settled = outcomes && outcomes.length === legs.length
    && outcomes.every((l) => ['hit', 'miss', 'void'].includes(l.result));
  const kind = settled ? 'settled' : 'potential';
  let decimal = 1;
  let available = legs.length > 0;
  legs.forEach((leg, i) => {
    if (outcomes?.[i]?.result === 'void') return;
    const ip = leg.implied_prob;
    if (typeof ip !== 'number' || !Number.isFinite(ip) || ip <= 0 || ip > 1) available = false;
    else decimal /= ip;
  });
  const lost = settled && outcomes.some((l) => l.result === 'miss');
  const net = lost ? -100 : available ? Math.round(10000 * (decimal - 1)) / 100 : null;
  return { kind, net_fair: net, net_vig2: null,
    assumed_price_legs: legs.filter((l) => l.price_source !== 'book_quote').length,
    simulation: true };
}
