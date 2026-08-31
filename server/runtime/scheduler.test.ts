import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryScheduler, MAX_SCHEDULE_FAILURES } from './scheduler.js';

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
