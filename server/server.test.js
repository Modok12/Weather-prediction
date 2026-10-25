import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHandler } from './app.js';
import { createMemoryStore } from './store.js';
import { verifyWebhookSignature } from './paystack.js';
import {
  entitlement, pickSubscription, signToken, readToken,
} from './subscriptions.js';

const DAY = 864e5;
const config = {
  secretKey: 'sk_test_fake',
  tokenSecret: 'token-secret',
  planCodes: ['PLN_month', 'PLN_year'],
  appUrl: 'https://gas.example',
  staticDir: resolve(fileURLToPath(new URL('.', import.meta.url)), '../gas-app'),
};

// Fake Paystack with a tiny bit of state.
const subsByCustomer = {};
const paystack = {
  calls: [],
  getPlan: async (code) => ({
    PLN_month: { name: 'Monthly', interval: 'monthly', amount: 50000, currency: 'NGN' },
    PLN_year: { name: 'Yearly', interval: 'annually', amount: 500000, currency: 'NGN' },
  })[code],
  initialize: async (args) => {
    paystack.calls.push(['initialize', args]);
    return { authorization_url: 'https://checkout.paystack.com/abc', reference: 'ref_1' };
  },
  verify: async (ref) => ({
    ref_ok: {
      status: 'success', plan: 'PLN_month', paid_at: new Date().toISOString(),
      plan_object: { interval: 'monthly' }, customer: { id: 7, email: 'Ada@Example.com' },
    },
    ref_abandoned: { status: 'abandoned', plan: 'PLN_month', customer: { id: 8, email: 'b@x.ng' } },
    ref_oneoff: { status: 'success', plan: null, customer: { id: 9, email: 'c@x.ng' } },
  })[ref],
  listSubscriptions: async (id) => subsByCustomer[id] || [],
  manageLink: async (code) => ({ link: `https://paystack.com/manage/${code}` }),
};

let server;
let base;
before(async () => {
  server = createServer(createHandler({ paystack, store: createMemoryStore(), config }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const api = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
};

test('entitlement rules', () => {
  const now = Date.now();
  const future = new Date(now + 5 * DAY).toISOString();
  const past = new Date(now - 5 * DAY).toISOString();
  const recent = new Date(now - 1 * DAY).toISOString();
  assert.equal(entitlement(null).premium, false);
  assert.equal(entitlement({ status: 'active', periodEnd: future }).premium, true);
  assert.equal(entitlement({ status: 'active', periodEnd: recent }).premium, true, 'grace period');
  assert.equal(entitlement({ status: 'active', periodEnd: past }).premium, false);
  assert.equal(entitlement({ status: 'non-renewing', periodEnd: future }).premium, true);
  assert.equal(entitlement({ status: 'non-renewing', periodEnd: recent }).premium, false);
  assert.equal(entitlement({ status: 'cancelled', periodEnd: future }).premium, false);
});

test('pickSubscription prefers active subscriptions on our plans', () => {
  const subs = [
    { status: 'cancelled', plan: { plan_code: 'PLN_month' } },
    { status: 'active', plan: { plan_code: 'PLN_other' } },
    { status: 'active', plan: { plan_code: 'PLN_year' }, subscription_code: 'SUB_y' },
  ];
  assert.equal(pickSubscription(subs, config.planCodes).subscription_code, 'SUB_y');
  assert.equal(pickSubscription([], config.planCodes), null);
});

test('tokens round-trip and reject tampering', () => {
  const t = signToken('ada@example.com', 's');
  assert.equal(readToken(t, 's'), 'ada@example.com');
  assert.equal(readToken(t, 'other'), null);
  const forged = `${Buffer.from('eve@x.ng').toString('base64url')}.${t.split('.')[1]}`;
  assert.equal(readToken(forged, 's'), null);
  assert.equal(readToken('garbage', 's'), null);
});

test('plans endpoint returns naira amounts', async () => {
  const { data } = await api('/api/plans');
  assert.deepEqual(data.plans.map((p) => [p.code, p.amount]), [['PLN_month', 500], ['PLN_year', 5000]]);
});

test('subscribe validates input and starts a Paystack checkout', async () => {
  assert.equal((await api('/api/subscribe', { method: 'POST', body: { email: 'bad', plan: 'PLN_month' } })).status, 400);
  assert.equal((await api('/api/subscribe', { method: 'POST', body: { email: 'a@b.ng', plan: 'PLN_x' } })).status, 400);
  const { status, data } = await api('/api/subscribe', { method: 'POST', body: { email: ' A@B.ng ', plan: 'PLN_month' } });
  assert.equal(status, 200);
  assert.equal(data.url, 'https://checkout.paystack.com/abc');
  assert.deepEqual(paystack.calls.at(-1)[1], {
    email: 'a@b.ng', plan: 'PLN_month', amount: 50000, callbackUrl: 'https://gas.example/',
  });
});

test('verify grants premium after a successful plan payment', async () => {
  assert.equal((await api('/api/verify?reference=ref_abandoned')).status, 402);
  assert.equal((await api('/api/verify?reference=ref_oneoff')).status, 400);

  const { status, data } = await api('/api/verify?reference=ref_ok');
  assert.equal(status, 200);
  assert.equal(data.premium, true);
  assert.equal(data.email, 'ada@example.com');

  const me = await api('/api/me', { token: data.token });
  assert.equal(me.data.premium, true);
  assert.equal((await api('/api/me', { token: 'nope.nope' })).status, 401);
  // No subscription code yet, so nothing to manage.
  assert.equal((await api('/api/manage', { method: 'POST', token: data.token })).status, 404);
});

test('webhooks require a valid signature and update the subscriber', async () => {
  const send = (event, sig) => {
    const raw = JSON.stringify(event);
    return api('/api/paystack/webhook', {
      method: 'POST',
      body: raw,
      headers: { 'x-paystack-signature': sig ?? createHmac('sha512', config.secretKey).update(raw).digest('hex') },
    });
  };
  const event = { event: 'subscription.create', data: { customer: { id: 7, email: 'ada@example.com' } } };
  assert.equal((await send(event, 'forged')).status, 401);

  subsByCustomer[7] = [{
    status: 'active', subscription_code: 'SUB_1', plan: { plan_code: 'PLN_month' },
    next_payment_date: new Date(Date.now() + 30 * DAY).toISOString(),
  }];
  assert.equal((await send(event)).status, 200);
  const token = signToken('ada@example.com', config.tokenSecret);
  const manage = await api('/api/manage', { method: 'POST', token });
  assert.equal(manage.data.url, 'https://paystack.com/manage/SUB_1');

  // Customer cancels and the period runs out.
  subsByCustomer[7] = [{ status: 'cancelled', subscription_code: 'SUB_1', plan: { plan_code: 'PLN_month' } }];
  await send({ event: 'subscription.disable', data: { customer: { id: 7, email: 'ada@example.com' } } });
  assert.equal((await api('/api/me', { token })).data.premium, false);
});

test('webhook signature helper', () => {
  const sig = createHmac('sha512', 'k').update('{}').digest('hex');
  assert.equal(verifyWebhookSignature(Buffer.from('{}'), sig, 'k'), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{}'), undefined, 'k'), false);
});

test('serves the app and blocks path traversal', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Gas Level/);
  const bad = await fetch(`${base}/..%2fserver%2fapp.js`);
  assert.equal(bad.status, 404);
});
