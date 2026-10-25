import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gasRemaining, levelStatus, currentCycle, usageRate, forecast, refillCost, findCylinder,
} from './gas.js';

const DAY = 24 * 60 * 60 * 1000;

test('gas remaining is gross minus tare, clamped to capacity', () => {
  const r = gasRemaining(20.75, 14.5, 12.5);
  assert.equal(r.kg, 6.25);
  assert.equal(r.percent, 50);
  assert.equal(r.suspicious, false);

  assert.equal(gasRemaining(14, 14.5, 12.5).kg, 0);
  assert.equal(gasRemaining(30, 14.5, 12.5).kg, 12.5);
  assert.equal(gasRemaining(30, 14.5, 12.5).suspicious, true);
});

test('level status thresholds', () => {
  assert.equal(levelStatus(80), 'good');
  assert.equal(levelStatus(40), 'half');
  assert.equal(levelStatus(15), 'low');
  assert.equal(levelStatus(25, 30), 'low');
  assert.equal(levelStatus(3), 'empty');
});

test('current cycle starts after the latest refill', () => {
  const readings = [
    { t: 0, gasKg: 2 },
    { t: DAY, gasKg: 1 },
    { t: 2 * DAY, gasKg: 12.5 },
    { t: 3 * DAY, gasKg: 12 },
  ];
  assert.deepEqual(currentCycle(readings).map((r) => r.gasKg), [12.5, 12]);
});

test('usage rate needs enough history', () => {
  assert.equal(usageRate([]), null);
  assert.equal(usageRate([{ t: 0, gasKg: 6 }]), null);
  assert.equal(usageRate([{ t: 0, gasKg: 6 }, { t: 1000, gasKg: 5.9 }]), null);
});

test('usage rate and forecast for steady consumption', () => {
  const readings = [0, 1, 2, 3, 4].map((d) => ({ t: d * DAY, gasKg: 12.5 - 0.4 * d }));
  assert.ok(Math.abs(usageRate(readings) - 0.4) < 1e-9);

  const f = forecast(readings, 4 * DAY);
  assert.ok(Math.abs(f.daysLeft - 10.9 / 0.4) < 1e-9);
  assert.ok(Math.abs(f.emptyDate.getTime() - (4 * DAY + f.daysLeft * DAY)) < 1);
});

test('forecast accounts for time since the last reading', () => {
  const readings = [{ t: 0, gasKg: 6 }, { t: 2 * DAY, gasKg: 5 }];
  assert.equal(forecast(readings, 4 * DAY).daysLeft, 8);
});

test('refill cost and cylinder lookup', () => {
  assert.equal(refillCost(2.5, 12.5, 1200), 12000);
  assert.equal(findCylinder('6kg').capacity, 6);
  assert.equal(findCylinder('nope'), null);
});
