// Premium subscription state in the browser. The server (see /server) talks to
// Paystack; this module only holds the access token and the last known status.

const KEY = 'gas-premium-v1';

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

function writeCache(value) {
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable; premium lasts for this visit only.
  }
}

async function request(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`api/${path}`, {
    method,
    cache: 'no-store',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

let account = readCache();

// Offline, trust the cached status until its paid period ends.
function cachedPremium() {
  if (!account?.premium) return false;
  return !account.periodEnd || new Date(account.periodEnd).getTime() > Date.now();
}

export const premium = {
  get active() {
    return cachedPremium();
  },
  get account() {
    return account;
  },

  async plans() {
    return (await request('plans')).plans;
  },

  // Sends the browser to Paystack checkout.
  async subscribe(email, plan) {
    const { url } = await request('subscribe', { method: 'POST', body: { email, plan } });
    location.assign(url);
  },

  // Call on load: finishes a checkout redirect or refreshes the status.
  async refresh() {
    const params = new URLSearchParams(location.search);
    const reference = params.get('reference') || params.get('trxref');
    if (reference) {
      history.replaceState(null, '', location.pathname);
      const data = await request(`verify?reference=${encodeURIComponent(reference)}`);
      account = data;
      writeCache(account);
      return { justSubscribed: data.premium };
    }
    if (!account?.token) return {};
    try {
      const data = await request('me', { token: account.token });
      account = { ...account, ...data };
      writeCache(account);
    } catch (err) {
      if (err.status === 401) {
        account = null;
        writeCache(null);
      }
      // Network errors: keep the cached status.
    }
    return {};
  },

  async manageUrl() {
    return (await request('manage', { method: 'POST', token: account?.token })).url;
  },

  signOut() {
    account = null;
    writeCache(null);
  },
};
