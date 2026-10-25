import {
  CYLINDERS, findCylinder, gasRemaining, levelStatus, forecast, refillCost,
} from './gas.js';
import { premium } from './premium.js';

const STORE_KEY = 'gas-level-v1';
const CIRCUMFERENCE = 2 * Math.PI * 50;
const FREE_HISTORY = 5;

const defaults = {
  cylinderId: '12.5kg',
  tare: findCylinder('12.5kg').typicalTare,
  pricePerKg: 1200,
  threshold: 20,
  scaleUrl: '',
  // Gross weights are stored so changing the tare later re-computes history.
  readings: [],
};

function load() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable (private mode); the app still works for this visit.
  }
}

let state = load();
const $ = (id) => document.getElementById(id);
const naira = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function cylinder() {
  return findCylinder(state.cylinderId) || findCylinder(defaults.cylinderId);
}

function gasReadings() {
  const cap = cylinder().capacity;
  return state.readings.map((r) => ({ t: r.t, gasKg: gasRemaining(r.gross, state.tare, cap).kg }));
}

const STATUS_TEXT = {
  good: 'Plenty of gas',
  half: 'Half or less remaining',
  low: 'Gas is running low. Plan a refill soon.',
  empty: 'Almost empty. Refill now.',
};

function render() {
  const cyl = cylinder();
  const card = document.querySelector('.gauge-card');
  const latest = state.readings[state.readings.length - 1];

  if (!latest) {
    card.removeAttribute('data-level');
    $('pct').textContent = '--%';
    $('kg').textContent = 'No reading yet';
    $('status').textContent = 'Weigh your cylinder and save a reading.';
    $('gauge-fill').style.strokeDashoffset = CIRCUMFERENCE;
    for (const id of ['days-left', 'empty-date', 'rate', 'cost']) $(id).textContent = '—';
  } else {
    const g = gasRemaining(latest.gross, state.tare, cyl.capacity);
    const level = levelStatus(g.percent, state.threshold);
    card.dataset.level = level;
    $('pct').textContent = `${Math.round(g.percent)}%`;
    $('kg').textContent = `${g.kg.toFixed(1)} of ${cyl.capacity} kg`;
    $('status').textContent = g.suspicious
      ? 'This reading looks off. Check the tare weight (TW) and cylinder size.'
      : STATUS_TEXT[level];
    $('gauge-fill').style.strokeDashoffset = CIRCUMFERENCE * (1 - g.percent / 100);

    const f = forecast(gasReadings());
    if (!premium.active) {
      for (const id of ['days-left', 'empty-date', 'rate']) $(id).replaceChildren(lockedLink());
    } else if (f.daysLeft === null) {
      $('days-left').textContent = 'Need more readings';
      $('empty-date').textContent = '—';
    } else {
      $('days-left').textContent = `${Math.round(f.daysLeft)} days`;
      $('empty-date').textContent = dateFmt.format(f.emptyDate);
    }
    if (premium.active) $('rate').textContent = f.ratePerDay ? `${f.ratePerDay.toFixed(2)} kg/day` : '—';
    $('cost').textContent = state.pricePerKg
      ? naira.format(refillCost(g.kg, cyl.capacity, state.pricePerKg))
      : '—';
  }

  const list = $('history');
  list.replaceChildren();
  if (state.readings.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = 'No readings yet.';
    list.append(li);
  }
  const shown = premium.active ? state.readings : state.readings.slice(-FREE_HISTORY);
  const hidden = state.readings.length - shown.length;
  $('history-note').hidden = hidden === 0;
  $('history-note').textContent = `${hidden} older reading${hidden === 1 ? '' : 's'} hidden. Get Premium to see your full history.`;
  $('export').hidden = !premium.active || state.readings.length === 0;
  [...shown].reverse().forEach((r) => {
    const g = gasRemaining(r.gross, state.tare, cyl.capacity);
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.textContent = timeFmt.format(new Date(r.t));
    const what = document.createElement('span');
    what.textContent = `${r.gross} kg → ${g.kg.toFixed(1)} kg gas`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Delete reading');
    del.addEventListener('click', () => {
      state.readings = state.readings.filter((x) => x !== r);
      save();
      render();
    });
    li.append(when, what, del);
    list.append(li);
  });

  $('scale-locked').hidden = premium.active;
  if (premium.active) $('scale').removeAttribute('data-locked');
  else $('scale').dataset.locked = '';
  renderPremium();
}

function lockedLink() {
  const a = document.createElement('a');
  a.href = '#premium';
  a.className = 'locked';
  a.textContent = '🔒 Premium';
  return a;
}

let selectedPlan = null;

function renderPremium() {
  const acct = premium.account;
  $('premium-off').hidden = premium.active;
  $('premium-on').hidden = !premium.active;
  if (premium.active && acct) {
    const until = acct.periodEnd ? dateFmt.format(new Date(acct.periodEnd)) : null;
    const verb = acct.status === 'non-renewing' ? 'Ends' : 'Renews';
    $('premium-detail').textContent = [acct.email, until && `${verb} ${until}`].filter(Boolean).join(' · ');
  }
}

async function loadPlans() {
  const box = $('plans');
  try {
    const plans = await premium.plans();
    box.replaceChildren(...plans.map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'plan';
      b.setAttribute('aria-pressed', 'false');
      const price = document.createElement('strong');
      price.textContent = naira.format(p.amount);
      const per = document.createElement('small');
      per.textContent = { monthly: 'per month', annually: 'per year', weekly: 'per week', quarterly: 'per 3 months' }[p.interval] || p.interval;
      b.append(p.name, price, per);
      b.addEventListener('click', () => {
        selectedPlan = p.code;
        box.querySelectorAll('.plan').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('subscribe-form').hidden = false;
        $('sub-email').focus();
      });
      return b;
    }));
  } catch {
    box.replaceChildren();
    $('premium-msg').textContent = navigator.onLine
      ? 'Subscriptions are not available on this copy of the app.'
      : 'Connect to the internet to see Premium plans.';
  }
}

function fillSettings() {
  const sel = $('cylinder');
  sel.replaceChildren(...CYLINDERS.map((c) => new Option(c.label, c.id)));
  sel.value = state.cylinderId;
  $('tare').value = state.tare;
  $('price').value = state.pricePerKg;
  $('threshold').value = state.threshold;
  $('scale-url').value = state.scaleUrl;
}

function addReading(gross) {
  state.readings.push({ t: Date.now(), gross: Math.round(gross * 100) / 100 });
  state.readings.sort((a, b) => a.t - b.t);
  save();
  render();
  maybeNotify();
}

function maybeNotify() {
  const latest = state.readings[state.readings.length - 1];
  if (!latest || !('Notification' in window) || Notification.permission !== 'granted') return;
  const g = gasRemaining(latest.gross, state.tare, cylinder().capacity);
  const level = levelStatus(g.percent, state.threshold);
  if (level === 'low' || level === 'empty') {
    new Notification('Cooking gas is low', { body: `${g.kg.toFixed(1)} kg (${Math.round(g.percent)}%) left.` });
  }
}

$('reading-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const gross = parseFloat($('gross').value);
  if (!Number.isFinite(gross) || gross <= 0) return;
  addReading(gross);
  $('gross').value = '';
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
});

$('cylinder').addEventListener('change', () => {
  // Suggest the typical tare for the new size; the user should still check the TW stamp.
  $('tare').value = findCylinder($('cylinder').value).typicalTare;
});

$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  state.cylinderId = $('cylinder').value;
  state.tare = parseFloat($('tare').value) || cylinder().typicalTare;
  state.pricePerKg = parseFloat($('price').value) || 0;
  state.threshold = Math.min(Math.max(parseInt($('threshold').value, 10) || 20, 5), 60);
  save();
  render();
});

$('scale-read').addEventListener('click', async () => {
  if (!premium.active) return;
  const url = $('scale-url').value.trim();
  const msg = $('scale-msg');
  if (!url) {
    msg.textContent = 'Enter the address shown by your smart scale.';
    return;
  }
  state.scaleUrl = url;
  save();
  msg.textContent = 'Reading…';
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    const gross = Number(data.grossKg);
    if (!Number.isFinite(gross)) throw new Error('No weight in response');
    addReading(gross);
    msg.textContent = `Saved ${gross.toFixed(2)} kg from scale.`;
  } catch (err) {
    msg.textContent = `Could not read the scale (${err.message}). Is your phone on the scale's Wi-Fi?`;
  }
});

$('export').addEventListener('click', () => {
  const cap = cylinder().capacity;
  const rows = [['time', 'cylinder_weight_kg', 'gas_kg', 'percent']].concat(state.readings.map((r) => {
    const g = gasRemaining(r.gross, state.tare, cap);
    return [new Date(r.t).toISOString(), r.gross, g.kg.toFixed(2), g.percent.toFixed(1)];
  }));
  const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'gas-readings.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('subscribe-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedPlan) return;
  const btn = $('subscribe-btn');
  btn.disabled = true;
  $('premium-msg').textContent = 'Opening Paystack…';
  try {
    await premium.subscribe($('sub-email').value.trim(), selectedPlan);
  } catch (err) {
    $('premium-msg').textContent = err.message;
    btn.disabled = false;
  }
});

$('manage').addEventListener('click', async () => {
  try {
    location.assign(await premium.manageUrl());
  } catch (err) {
    $('premium-msg').textContent = err.status === 404
      ? 'Your subscription is still being set up. Try again in a few minutes.'
      : err.message;
  }
});

$('sign-out').addEventListener('click', () => {
  if (confirm('Remove Premium from this device? Your subscription keeps running and is not cancelled.')) {
    premium.signOut();
    render();
  }
});

$('clear').addEventListener('click', () => {
  if (state.readings.length && confirm('Delete all readings?')) {
    state.readings = [];
    save();
    render();
  }
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

fillSettings();
render();
loadPlans();
premium.refresh()
  .then(({ justSubscribed }) => {
    if (justSubscribed) $('premium-msg').textContent = 'Thank you! Premium is now active.';
  })
  .catch((err) => {
    $('premium-msg').textContent = `We couldn't confirm your payment: ${err.message}`;
  })
  .finally(render);
