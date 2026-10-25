// Core gas-level logic. Pure functions, shared by the browser app and the tests.
//
// LPG is stored as a liquid under pressure, so pressure stays roughly constant
// until the cylinder is almost empty. Weight is the only reliable measure:
//   gas remaining = gross weight - tare weight (the "TW" stamped on the collar).

// Common Nigerian cylinder sizes. Tare weights are typical values only —
// always prefer the TW stamped on your own cylinder.
export const CYLINDERS = [
  { id: '3kg', label: '3 kg', capacity: 3, typicalTare: 5 },
  { id: '5kg', label: '5 kg', capacity: 5, typicalTare: 7.5 },
  { id: '6kg', label: '6 kg', capacity: 6, typicalTare: 8.5 },
  { id: '12.5kg', label: '12.5 kg', capacity: 12.5, typicalTare: 14.5 },
  { id: '25kg', label: '25 kg', capacity: 25, typicalTare: 23 },
  { id: '50kg', label: '50 kg', capacity: 50, typicalTare: 43 },
];

const DAY_MS = 24 * 60 * 60 * 1000;
// A rise bigger than this between readings is treated as a refill.
const REFILL_JUMP_KG = 0.5;

export function findCylinder(id) {
  return CYLINDERS.find((c) => c.id === id) || null;
}

export function gasRemaining(grossKg, tareKg, capacityKg) {
  const raw = grossKg - tareKg;
  const kg = Math.min(Math.max(raw, 0), capacityKg);
  return {
    kg,
    percent: capacityKg > 0 ? (kg / capacityKg) * 100 : 0,
    // A reading well outside 0..capacity usually means a wrong tare or a bad weighing.
    suspicious: raw < -0.3 || raw > capacityKg * 1.05,
  };
}

export function levelStatus(percent, lowThreshold = 20) {
  if (percent <= 5) return 'empty';
  if (percent <= lowThreshold) return 'low';
  if (percent <= 50) return 'half';
  return 'good';
}

// Readings since the most recent refill, oldest first.
// Each reading is { t: epoch ms, gasKg: number }.
export function currentCycle(readings) {
  const sorted = [...readings].sort((a, b) => a.t - b.t);
  let start = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].gasKg - sorted[i - 1].gasKg > REFILL_JUMP_KG) start = i;
  }
  return sorted.slice(start);
}

// Least-squares usage rate in kg/day over the current cycle, or null if
// there is not yet enough history to say.
export function usageRate(readings) {
  const cycle = currentCycle(readings);
  if (cycle.length < 2) return null;
  const span = cycle[cycle.length - 1].t - cycle[0].t;
  if (span < DAY_MS / 4) return null;

  const xs = cycle.map((r) => (r.t - cycle[0].t) / DAY_MS);
  const ys = cycle.map((r) => r.gasKg);
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = num / den;
  return slope < 0 ? -slope : 0;
}

// Predict when the cylinder runs out, based on the latest reading and usage rate.
export function forecast(readings, now = Date.now()) {
  const rate = usageRate(readings);
  const cycle = currentCycle(readings);
  if (rate === null || rate === 0 || cycle.length === 0) {
    return { ratePerDay: rate, daysLeft: null, emptyDate: null };
  }
  const last = cycle[cycle.length - 1];
  const daysSinceLast = (now - last.t) / DAY_MS;
  const daysLeft = Math.max(last.gasKg / rate - daysSinceLast, 0);
  return {
    ratePerDay: rate,
    daysLeft,
    emptyDate: new Date(now + daysLeft * DAY_MS),
  };
}

export function refillCost(gasKg, capacityKg, pricePerKg) {
  return Math.max(capacityKg - gasKg, 0) * pricePerKg;
}
