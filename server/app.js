// HTTP handler: serves the gas app and the subscription API.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { verifyWebhookSignature } from './paystack.js';
import {
  entitlement, pickSubscription, periodFromInterval, signToken, readToken,
} from './subscriptions.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const PLANS_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_EVENTS = new Set([
  'subscription.create', 'subscription.disable', 'subscription.not_renew',
  'charge.success', 'invoice.create', 'invoice.update', 'invoice.payment_failed',
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createHandler({ paystack, store, config }) {
  const planCodes = config.planCodes;
  let plansCache = null;

  async function plans() {
    if (plansCache && Date.now() - plansCache.at < PLANS_TTL_MS) return plansCache.list;
    const list = await Promise.all(planCodes.map(async (code) => {
      const p = await paystack.getPlan(code);
      return { code, name: p.name, interval: p.interval, amount: p.amount / 100, currency: p.currency };
    }));
    plansCache = { at: Date.now(), list };
    return list;
  }

  // Refresh a subscriber's record from Paystack, which is the source of truth.
  async function sync(email, customerId, fallback = null) {
    const prev = store.get(email);
    const subs = await paystack.listSubscriptions(customerId);
    const sub = pickSubscription(subs, planCodes);
    let record;
    if (sub) {
      record = {
        customerId,
        status: sub.status,
        planCode: sub.plan.plan_code,
        subscriptionCode: sub.subscription_code,
        periodEnd: sub.next_payment_date || prev?.periodEnd || fallback?.periodEnd || null,
      };
    } else if (fallback) {
      // Paid, but Paystack hasn't created the subscription object yet.
      record = { ...prev, customerId, ...fallback };
    } else {
      record = { ...prev, customerId, status: prev?.status || 'none' };
    }
    record.syncedAt = new Date().toISOString();
    await store.put(email, record);
    return record;
  }

  function emailFromAuth(req) {
    const auth = req.headers.authorization || '';
    const email = readToken(auth.replace(/^Bearer\s+/i, ''), config.tokenSecret);
    if (!email) throw new HttpError(401, 'Not signed in');
    return email;
  }

  const routes = {
    'GET /api/plans': async () => ({ plans: await plans() }),

    'POST /api/subscribe': async ({ body }) => {
      const email = String(body.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address');
      const plan = (await plans()).find((p) => p.code === body.plan);
      if (!plan) throw new HttpError(400, 'Unknown plan');
      const tx = await paystack.initialize({
        email,
        plan: plan.code,
        amount: Math.round(plan.amount * 100),
        callbackUrl: `${config.appUrl}/`,
      });
      return { url: tx.authorization_url, reference: tx.reference };
    },

    'GET /api/verify': async ({ url }) => {
      const reference = url.searchParams.get('reference');
      if (!reference) throw new HttpError(400, 'Missing reference');
      const tx = await paystack.verify(reference);
      const planCode = typeof tx.plan === 'string' ? tx.plan : tx.plan?.plan_code || tx.plan_object?.plan_code;
      if (tx.status !== 'success') throw new HttpError(402, 'Payment was not completed');
      if (!planCodes.includes(planCode)) throw new HttpError(400, 'Payment is not for a subscription plan');
      const email = tx.customer.email.toLowerCase();
      const record = await sync(email, tx.customer.id, {
        status: 'active',
        planCode,
        periodEnd: periodFromInterval(tx.paid_at, tx.plan_object?.interval),
      });
      return { token: signToken(email, config.tokenSecret), email, ...entitlement(record) };
    },

    'GET /api/me': async ({ req }) => {
      const email = emailFromAuth(req);
      let record = store.get(email);
      const stale = !record?.syncedAt || Date.now() - new Date(record.syncedAt) > SYNC_EVERY_MS;
      if (record?.customerId && stale) record = await sync(email, record.customerId);
      return { email, ...entitlement(record) };
    },

    'POST /api/manage': async ({ req }) => {
      const record = store.get(emailFromAuth(req));
      if (!record?.subscriptionCode) throw new HttpError(404, 'No subscription to manage yet');
      const { link } = await paystack.manageLink(record.subscriptionCode);
      return { url: link };
    },

    'POST /api/paystack/webhook': async ({ req, raw }) => {
      if (!verifyWebhookSignature(raw, req.headers['x-paystack-signature'], config.secretKey)) {
        throw new HttpError(401, 'Bad signature');
      }
      const event = JSON.parse(raw.toString('utf8'));
      const customer = event.data?.customer;
      if (WEBHOOK_EVENTS.has(event.event) && customer?.email && customer?.id) {
        await sync(customer.email.toLowerCase(), customer.id);
      }
      return { received: true };
    },
  };

  async function serveStatic(res, pathname) {
    const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^([/\\])+/, '');
    const file = join(config.staticDir, rel);
    if (rel.startsWith('..') || !file.startsWith(config.staticDir + sep)) throw new HttpError(404, 'Not found');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      throw new HttpError(404, 'Not found');
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return await serveStatic(res, url.pathname);
        throw new HttpError(404, 'Not found');
      }
      const raw = await readBody(req);
      let body = {};
      if (raw.length && !url.pathname.endsWith('/webhook')) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, 'Invalid JSON');
        }
      }
      sendJson(res, 200, await route({ req, url, body, raw }));
    } catch (err) {
      const status = err.status || 502;
      if (!err.status) console.error(err);
      sendJson(res, status, { error: err.status ? err.message : 'Payment service error, please try again' });
    }
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
