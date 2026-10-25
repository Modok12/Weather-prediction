// Minimal Paystack API client. https://paystack.com/docs/api/
import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE = 'https://api.paystack.co';

export function createPaystack(secretKey, fetchImpl = fetch) {
  async function call(method, path, body) {
    const res = await fetchImpl(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok || json.status === false) {
      throw new Error(`Paystack ${method} ${path}: ${json.message || res.status}`);
    }
    return json.data;
  }

  return {
    getPlan: (code) => call('GET', `/plan/${encodeURIComponent(code)}`),
    // With `plan` set, Paystack charges the plan amount and creates the subscription.
    initialize: ({ email, plan, amount, callbackUrl }) =>
      call('POST', '/transaction/initialize', { email, plan, amount, callback_url: callbackUrl }),
    verify: (reference) => call('GET', `/transaction/verify/${encodeURIComponent(reference)}`),
    listSubscriptions: (customerId) => call('GET', `/subscription?customer=${encodeURIComponent(customerId)}`),
    manageLink: (code) => call('GET', `/subscription/${encodeURIComponent(code)}/manage/link`),
  };
}

// Webhooks are signed with HMAC-SHA512 of the raw body using the secret key.
export function verifyWebhookSignature(rawBody, signature, secretKey) {
  if (typeof signature !== 'string') return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
