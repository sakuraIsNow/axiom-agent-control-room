import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryScheduler, MAX_SCHEDULE_FAILURES, ScheduleHealthActionConflictError, scheduleHealthState } from './scheduler.js';

const input = (overrides: Partial<Parameters<InMemoryScheduler['upsert']>[0]> = {}) => ({
  tenantId: 'tenant-a',
  userId: 'user-a',
  sessionId: 'session-a',
  title: '健康检查',
  input: '检查服务状态',
  mode: 'analyze' as const,
  intervalSeconds: 60,
  enabled: true,
  nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  ...overrides,
});

const tick = (scheduler: InMemoryScheduler) => (scheduler as unknown as { tick(): Promise<void> }).tick();
const forceDue = (scheduler: InMemoryScheduler, id: string) => {
  const items = (scheduler as unknown as { items: Map<string, { nextRunAt: string }> }).items;
  const item = items.get(id);
  if (item) item.nextRunAt = new Date(Date.now() - 1_000).toISOString();
};

test('failed schedule backs off and stores a bounded error', async () => {
  const scheduler = new InMemoryScheduler(async () => { throw new Error('provider unavailable'); });
  const created = await scheduler.upsert(input());
  await tick(scheduler);
  const [failed] = await scheduler.list('tenant-a');
  assert.equal(failed?.id, created.id);
  assert.equal(failed?.failureCount, 1);
  assert.equal(failed?.lastRunStatus, 'failed');
  assert.equal(failed?.enabled, true);
  assert.equal(failed?.lastError, 'provider unavailable');
  assert.ok(Date.parse(failed?.nextRunAt ?? '') > Date.now());
});

test('successful retry clears failure count and records success', async () => {
  let shouldFail = true;
  const scheduler = new InMemoryScheduler(async () => {
    if (shouldFail) throw new Error('temporary failure');
  });
  const created = await scheduler.upsert(input());
  await tick(scheduler);
  shouldFail = false;
  forceDue(scheduler, created.id);
  await tick(scheduler);
  const [succeeded] = await scheduler.list('tenant-a');
  assert.equal(succeeded?.failureCount, 0);
  assert.equal(succeeded?.lastRunStatus, 'success');
  assert.equal(succeeded?.lastError, undefined);
});

test('schedule enters dead letter after the failure limit and stops running', async () => {
  let calls = 0;
  const scheduler = new InMemoryScheduler(async () => { calls += 1; throw new Error('permanent failure'); });
  const created = await scheduler.upsert(input());
  for (let attempt = 0; attempt < MAX_SCHEDULE_FAILURES; attempt += 1) {
    forceDue(scheduler, created.id);
    await tick(scheduler);
  }
  const [deadLetter] = await scheduler.list('tenant-a');
  assert.equal(calls, MAX_SCHEDULE_FAILURES);
  assert.equal(deadLetter?.failureCount, MAX_SCHEDULE_FAILURES);
  assert.equal(deadLetter?.lastRunStatus, 'dead-letter');
  assert.equal(deadLetter?.enabled, false);
  forceDue(scheduler, created.id);
  await tick(scheduler);
  assert.equal(calls, MAX_SCHEDULE_FAILURES);
});

test('resume clears dead letter state and only allows the owning tenant', async () => {
  const scheduler = new InMemoryScheduler(async () => { throw new Error('permanent failure'); });
  const created = await scheduler.upsert(input());
  for (let attempt = 0; attempt < MAX_SCHEDULE_FAILURES; attempt += 1) {
    forceDue(scheduler, created.id);
    await tick(scheduler);
  }
  assert.equal(await scheduler.resume(created.id, 'tenant-b'), null);
  const resumed = await scheduler.resume(created.id, 'tenant-a');
  assert.equal(resumed?.enabled, true);
  assert.equal(resumed?.failureCount, 0);
  assert.equal(resumed?.lastRunStatus, undefined);
  assert.equal(resumed?.deadLetteredAt, undefined);
});

test('pause and reschedule preserve ownership and require explicit calls', async () => {
  const scheduler = new InMemoryScheduler(async () => undefined);
  const created = await scheduler.upsert(input({
    cadence: { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' },
    intervalSeconds: undefined,
    nextRunAt: '2026-09-04T01:00:00.000Z',
  }));
  assert.equal(await scheduler.pause(created.id, 'tenant-b'), null);
  const paused = await scheduler.pause(created.id, 'tenant-a');
  assert.equal(paused?.enabled, false);
  assert.equal(paused?.cadence.kind, 'daily');

  assert.equal(await scheduler.reschedule(created.id, 'tenant-b', { kind: 'daily', timeOfDay: '10:00', timezone: 'Asia/Shanghai' }), null);
  const changed = await scheduler.reschedule(created.id, 'tenant-a', { kind: 'daily', timeOfDay: '10:00', timezone: 'Asia/Shanghai' });
  assert.deepEqual(changed?.cadence, { kind: 'daily', timeOfDay: '10:00', timezone: 'Asia/Shanghai' });
  assert.equal(changed?.enabled, false);
});

test('confirmed health actions are atomic, auditable, replay-safe, and user-isolated', async () => {
  const scheduler = new InMemoryScheduler(async () => undefined);
  const created = await scheduler.upsert(input({
    cadence: { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' },
    intervalSeconds: undefined,
    nextRunAt: '2026-09-04T01:00:00.000Z',
  }));
  const proposal = { kind: 'daily', timeOfDay: '09:30', timezone: 'Asia/Shanghai' } as const;
  const action = {
    tenantId: created.tenantId,
    userId: created.userId,
    scheduleId: created.id,
    suggestionId: 'schedule-health:test-1',
    kind: 'capacity_conflict' as const,
    action: 'reschedule' as const,
    reason: '同一时间的执行负载过高。',
    evidence: ['预计负载 6/4'],
    proposedCadence: proposal,
    expected: scheduleHealthState(created),
    confirmedBy: created.userId,
  };

  const result = await scheduler.applyHealthAction(action);
  assert.deepEqual(result?.schedule.cadence, proposal);
  assert.deepEqual(result?.audit.before.cadence, created.cadence);
  assert.deepEqual(result?.audit.after.cadence, proposal);
  assert.equal(result?.audit.confirmedBy, created.userId);
  assert.equal((await scheduler.listHealthActions(created.tenantId, created.userId)).length, 1);
  assert.deepEqual(await scheduler.listHealthActions(created.tenantId, 'other-user'), []);
  await assert.rejects(() => scheduler.applyHealthAction(action), ScheduleHealthActionConflictError);

  const current = await scheduler.get(created.id, created.tenantId);
  assert.ok(current);
  await assert.rejects(() => scheduler.applyHealthAction({
    ...action,
    suggestionId: 'schedule-health:test-stale',
    expected: scheduleHealthState(created),
  }), ScheduleHealthActionConflictError);
  assert.deepEqual((await scheduler.get(created.id, created.tenantId))?.cadence, proposal);
});

test('deleting an in-flight in-memory schedule does not recreate it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new InMemoryScheduler(async () => gate);
  const created = await scheduler.upsert(input());
  const running = tick(scheduler);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await scheduler.remove(created.id, 'tenant-a'), true);
  release();
  await running;
  assert.deepEqual(await scheduler.list('tenant-a'), []);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`an in-flight ${outcome} cannot overwrite an edited in-memory schedule`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new InMemoryScheduler(async () => {
      await gate;
      if (outcome === 'failure') throw new Error('old failure');
    });
    const created = await scheduler.upsert(input());
    const running = tick(scheduler);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await scheduler.pause(created.id, 'tenant-a');
    const edited = await scheduler.reschedule(created.id, 'tenant-a', { kind: 'daily', timeOfDay: '11:45', timezone: 'Asia/Shanghai' });
    release();
    await running;
    assert.deepEqual(await scheduler.get(created.id, 'tenant-a'), edited);
  });
}

test('replacing a pending schedule while another runs does not execute the stale snapshot', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const scheduler = new InMemoryScheduler(async (trigger) => {
    calls.push(trigger.id);
    if (calls.length === 1) await gate;
  });
  const first = await scheduler.upsert(input());
  const second = await scheduler.upsert(input());
  const running = tick(scheduler);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const changed = await scheduler.reschedule(second.id, 'tenant-a', { kind: 'daily', timeOfDay: '12:00', timezone: 'Asia/Shanghai' });
  release();
  await running;
  assert.deepEqual(calls, [first.id]);
  assert.deepEqual(await scheduler.get(second.id, 'tenant-a'), changed);
});

test('recreating a deleted in-flight schedule with the same id fences its old completion', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new InMemoryScheduler(async () => gate);
  const created = await scheduler.upsert(input());
  const running = tick(scheduler);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await scheduler.remove(created.id, 'tenant-a');
  const replacement = await scheduler.upsert(input({ id: created.id, enabled: false, title: 'Replacement' }));
  release();
  await running;
  assert.deepEqual(await scheduler.get(created.id, 'tenant-a'), replacement);
});

test('a one-time schedule disables itself after one successful run', async () => {
  let calls = 0;
  const scheduler = new InMemoryScheduler(async () => { calls += 1; });
  const created = await scheduler.upsert(input({
    intervalSeconds: undefined,
    cadence: { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString(), timezone: 'Asia/Shanghai' },
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  }));
  await tick(scheduler);
  const completed = await scheduler.get(created.id, 'tenant-a');
  assert.equal(calls, 1);
  assert.equal(completed?.lastRunStatus, 'success');
  assert.equal(completed?.enabled, false);
  forceDue(scheduler, created.id);
  await tick(scheduler);
  assert.equal(calls, 1);
});
