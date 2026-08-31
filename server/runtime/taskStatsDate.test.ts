import assert from 'node:assert/strict';
import test from 'node:test';
import { dateKeyInTimeZone, fillTaskStatsDaily, recentDateKeys, runtimeTimeZone } from './taskStatsDate.js';

test('daily task statistics use the configured business day and include today', () => {
  const now = Date.parse('2026-08-25T16:30:00.000Z');
  assert.equal(dateKeyInTimeZone(now, 'Asia/Shanghai'), '2026-08-26');
  assert.deepEqual(recentDateKeys(3, now, 'Asia/Shanghai'), [
    '2026-08-24',
    '2026-08-25',
    '2026-08-26',
  ]);

  assert.deepEqual(fillTaskStatsDaily([
    { date: '2026-08-25', totalTokens: 420, estimatedCostUsd: 0.0042 },
  ], 3, now, 'Asia/Shanghai'), [
    { date: '2026-08-24', totalTokens: 0, estimatedCostUsd: 0 },
    { date: '2026-08-25', totalTokens: 420, estimatedCostUsd: 0.0042 },
    { date: '2026-08-26', totalTokens: 0, estimatedCostUsd: 0 },
  ]);
});

test('invalid time zone configuration falls back to Asia/Shanghai', () => {
  const previous = process.env.AXIOM_TIME_ZONE;
  process.env.AXIOM_TIME_ZONE = 'not-a-time-zone';
  try {
    assert.equal(runtimeTimeZone(), 'Asia/Shanghai');
  } finally {
    if (previous === undefined) delete process.env.AXIOM_TIME_ZONE;
    else process.env.AXIOM_TIME_ZONE = previous;
  }
});
