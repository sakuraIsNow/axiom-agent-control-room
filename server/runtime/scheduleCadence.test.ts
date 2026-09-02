import assert from 'node:assert/strict';
import test from 'node:test';
import { nextRunAtForCadence, normalizeScheduleCadence, scheduleCadenceSchema } from './scheduleCadence.js';

test('daily cadence keeps the same Asia/Shanghai wall-clock time without drift', () => {
  const cadence = scheduleCadenceSchema.parse({ kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' });
  assert.equal(nextRunAtForCadence(cadence, new Date('2026-09-02T00:59:59.000Z')), '2026-09-02T01:00:00.000Z');
  assert.equal(nextRunAtForCadence(cadence, new Date('2026-09-02T01:00:37.000Z')), '2026-09-03T01:00:00.000Z');
});

test('weekly cadence selects the next configured weekday', () => {
  const cadence = scheduleCadenceSchema.parse({ kind: 'weekly', timeOfDay: '18:30', weekdays: [1, 3, 5], timezone: 'Asia/Shanghai' });
  // 2026-09-02 is Wednesday. The same-day occurrence has passed, so Friday is next.
  assert.equal(nextRunAtForCadence(cadence, new Date('2026-09-02T11:00:00.000Z')), '2026-09-04T10:30:00.000Z');
});

test('once cadence has no next occurrence after it runs', () => {
  const cadence = scheduleCadenceSchema.parse({ kind: 'once', runAt: '2026-09-03T01:00:00.000Z', timezone: 'Asia/Shanghai' });
  assert.equal(nextRunAtForCadence(cadence, new Date('2026-09-03T01:00:00.000Z')), null);
});

test('legacy interval input remains compatible', () => {
  const cadence = normalizeScheduleCadence({ intervalSeconds: 90 });
  assert.deepEqual(cadence, { kind: 'interval', intervalSeconds: 90, timezone: 'Asia/Shanghai' });
  assert.equal(nextRunAtForCadence(cadence, new Date('2026-09-02T00:00:00.000Z')), '2026-09-02T00:01:30.000Z');
});

test('invalid wall-clock and timezone values are rejected', () => {
  assert.equal(scheduleCadenceSchema.safeParse({ kind: 'daily', timeOfDay: '25:00', timezone: 'Asia/Shanghai' }).success, false);
  assert.equal(scheduleCadenceSchema.safeParse({ kind: 'daily', timeOfDay: '09:00', timezone: 'Mars/Olympus' }).success, false);
});
