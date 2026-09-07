import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScheduleInsights, type ScheduleRunInsight } from './scheduleInsights.js';
import type { ScheduledTrigger } from './scheduler.js';

const schedule = (id: string, overrides: Partial<ScheduledTrigger> = {}): ScheduledTrigger => ({
  id,
  tenantId: 'tenant-a',
  userId: 'user-a',
  sessionId: `session-${id}`,
  title: `日程 ${id}`,
  input: '生成行业简报',
  mode: 'analyze',
  cadence: { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' },
  intervalSeconds: 86_400,
  enabled: true,
  nextRunAt: '2026-09-03T01:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  failureCount: 0,
  ...overrides,
});

const run = (id: string, tokens: number, status: NonNullable<ScheduleRunInsight['evidenceSummary']>['status'] = 'unverified', sourced = true): ScheduleRunInsight => ({
  id,
  status: 'completed',
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:10:00.000Z',
  durationMs: 600_000,
  tokens: { total: tokens },
  evidenceSummary: { schemaVersion: 2, status, execution: status === 'partial' ? 'partial' : 'completed', acceptance: 'not-recorded', evidenceStatus: sourced ? 'supported' : 'unverified' },
});

test('builds bounded future occurrences and identifies overloaded windows', () => {
  const insights = buildScheduleInsights({
    schedules: [schedule('a', { mode: 'build' }), schedule('b', { mode: 'build' }), schedule('c')],
    now: new Date('2026-09-03T00:00:00.000Z'),
    days: 2,
    capacityLimit: 4,
  });
  assert.equal(insights.occurrences.length, 6);
  assert.equal(insights.capacity.peakLoad, 5);
  assert.equal(insights.capacity.overloadedWindows, 2);
  assert.equal(insights.conflicts[0]?.scheduleIds.length, 3);
  assert.equal(insights.occurrences[0]?.capacity, 'overloaded');
  assert.ok(insights.suggestions.some((item) => item.kind === 'capacity_conflict' && item.proposedCadence));
});

test('health suggestions are evidence based and have stable confirmation ids', () => {
  const target = schedule('health');
  const runs = [
    run('new-2', 30_000, 'partial', false),
    run('new-1', 28_000, 'unverified', false),
    run('old-2', 5_000),
    run('old-1', 6_000),
  ];
  const first = buildScheduleInsights({ schedules: [target], runsBySchedule: { health: runs }, now: new Date('2026-09-03T00:00:00.000Z') });
  const second = buildScheduleInsights({ schedules: [target], runsBySchedule: { health: runs }, now: new Date('2026-09-03T00:05:00.000Z') });
  assert.ok(first.suggestions.some((item) => item.kind === 'cost_spike' && item.recommendedAction === 'reschedule'));
  assert.ok(first.suggestions.some((item) => item.kind === 'quality_decline' && item.recommendedAction === 'pause'));
  assert.deepEqual(first.suggestions.map((item) => item.id), second.suggestions.map((item) => item.id));
});

test('legacy verification labels and missing data never create a trustworthy quality baseline', () => {
  const target = schedule('legacy');
  for (const evidenceSummary of [{ status: 'verified' as const }, undefined]) {
    const insights = buildScheduleInsights({
      schedules: [target], runsBySchedule: { legacy: [
        run('new-2', 2_000, 'partial', false), run('new-1', 2_000, 'unverified', false),
        { ...run('old-2', 2_000), evidenceSummary }, { ...run('old-1', 2_000), evidenceSummary },
      ] }, now: new Date('2026-09-03T00:00:00.000Z'),
    });
    assert.equal(insights.suggestions.some((item) => item.kind === 'quality_decline'), false);
  }
});

test('traceable or explicitly accepted completed results retain the current delivery baseline', () => {
  const target = schedule('current');
  for (const evidenceSummary of [
    run('source', 2_000).evidenceSummary,
    { ...run('acceptance', 2_000, 'unverified', false).evidenceSummary!, acceptance: 'accepted' as const },
  ]) {
    const insights = buildScheduleInsights({
      schedules: [target], runsBySchedule: { current: [
        { ...run('new-2', 2_000), evidenceSummary }, { ...run('new-1', 2_000), evidenceSummary },
        run('old-2', 2_000), run('old-1', 2_000),
      ] }, now: new Date('2026-09-03T00:00:00.000Z'),
    });
    assert.equal(insights.suggestions.some((item) => item.kind === 'quality_decline'), false);
  }
});

test('acceptance cannot turn incomplete execution into a reusable quality baseline', () => {
  const target = schedule('incomplete');
  const acceptedPartial = { ...run('old-2', 2_000, 'partial').evidenceSummary!, acceptance: 'accepted' as const };
  const insights = buildScheduleInsights({
    schedules: [target], runsBySchedule: { incomplete: [
      run('new-2', 2_000, 'partial', false), run('new-1', 2_000, 'unverified', false),
      { ...run('old-2', 2_000), evidenceSummary: acceptedPartial }, { ...run('old-1', 2_000), evidenceSummary: acceptedPartial },
    ] }, now: new Date('2026-09-03T00:00:00.000Z'),
  });
  assert.equal(insights.suggestions.some((item) => item.kind === 'quality_decline'), false);
});

test('dead-letter recovery is proposed but never applied by the analyzer', () => {
  const target = schedule('dead', { enabled: false, failureCount: 5, lastRunStatus: 'dead-letter', deadLetteredAt: '2026-09-02T02:00:00.000Z' });
  const insights = buildScheduleInsights({ schedules: [target], now: new Date('2026-09-03T00:00:00.000Z') });
  assert.equal(insights.occurrences.length, 0);
  assert.equal(insights.suggestions[0]?.recommendedAction, 'resume');
  assert.equal(target.enabled, false);
});

test('high-frequency schedules are bounded and expose truncation', () => {
  const target = schedule('interval', {
    cadence: { kind: 'interval', intervalSeconds: 15, timezone: 'Asia/Shanghai' },
    intervalSeconds: 15,
    nextRunAt: '2026-09-03T00:00:15.000Z',
  });
  const insights = buildScheduleInsights({ schedules: [target], now: new Date('2026-09-03T00:00:00.000Z'), days: 1 });
  assert.equal(insights.occurrences.length, 64);
  assert.equal(insights.range.truncated, true);
});
