// Subscription rules and access tokens. Pure functions, no I/O.
import { createHmac, timingSafeEqual } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
// Keep premium for a few days after a failed renewal while Paystack retries.
export const GRACE_DAYS = 3;
const STATUS_RANK = { active: 4, attention: 3, 'non-renewing': 2, completed: 1, cancelled: 0 };

// Is this subscriber premium right now?
export function entitlement(record, now = Date.now()) {
  if (!record || !record.periodEnd) return { premium: false, status: record?.status || 'none' };
  const end = new Date(record.periodEnd).getTime();
  let premium = false;
  if (record.status === 'active') premium = end + GRACE_DAYS * DAY_MS > now;
  else if (record.status === 'non-renewing') premium = end > now;
  else if (record.status === 'attention') premium = end + GRACE_DAYS * DAY_MS > now;
  return { premium, status: record.status, periodEnd: record.periodEnd, plan: record.planCode };
}

// Of a customer's Paystack subscriptions, pick the one that matters for our plans.
export function pickSubscription(subs, planCodes) {
  return subs
    .filter((s) => planCodes.includes(s.plan?.plan_code))
    .sort((a, b) => (STATUS_RANK[b.status] ?? -1) - (STATUS_RANK[a.status] ?? -1)
      || new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
}

export function periodFromInterval(paidAt, interval) {
  const days = { daily: 1, weekly: 7, monthly: 31, quarterly: 92, biannually: 183, annually: 366 }[interval] || 31;
  return new Date(new Date(paidAt).getTime() + days * DAY_MS).toISOString();
}

// Access token: base64url(email) + "." + HMAC. Status is always looked up
// server-side, so the token only proves which customer the browser belongs to.
export function signToken(email, secret) {
  const id = Buffer.from(email).toString('base64url');
  const mac = createHmac('sha256', secret).update(email).digest('base64url');
  return `${id}.${mac}`;
}

export function readToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [id, mac] = token.split('.');
  const email = Buffer.from(id, 'base64url').toString();
  const expected = createHmac('sha256', secret).update(email).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? email : null;
}
