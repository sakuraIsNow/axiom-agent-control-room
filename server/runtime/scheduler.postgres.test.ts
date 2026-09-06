import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { PostgresScheduler, scheduleHealthState, type ScheduledTriggerInput } from './scheduler.js';

const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();
const tick = (scheduler: PostgresScheduler) => (scheduler as unknown as { tick(): Promise<void> }).tick();
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const waitForHandler = async (promise: Promise<void>) => {
  let timer!: NodeJS.Timeout;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Schedule handler did not start.')), 5_000); })]);
  } finally { clearTimeout(timer); }
};
const input = (tenantId: string): ScheduledTriggerInput => ({
  tenantId, userId: 'owner', sessionId: 'test-session', title: 'Test schedule', input: 'Check runtime', mode: 'analyze',
  intervalSeconds: 60, enabled: true, nextRunAt: new Date(Date.now() - 60_000).toISOString(),
});

test('PostgreSQL schedule edits fence in-flight success and failure across workers', {
  skip: connectionString ? false : 'AXIOM_TEST_DATABASE_URL is not configured.',
  timeout: 30_000,
}, async () => {
  const tenantId = `schedule-edit-pg-${randomUUID()}`;
  const pool = new Pool({ connectionString, max: 1 });
  const mutations = ['pause', 'reschedule', 'resume', 'upsert', 'health-action', 'delete'] as const;
  try {
  for (const mutation of mutations) {
    for (const outcome of ['success', 'failure'] as const) {
      const entered = deferred();
      const gate = deferred();
      const first = new PostgresScheduler(connectionString!, async () => {
        entered.resolve();
        await gate.promise;
        if (outcome === 'failure') throw new Error('old handler failure');
      });
      const second = new PostgresScheduler(connectionString!, async () => undefined);
      let running: Promise<void> | undefined;
      try {
        await Promise.all([first.ready(), second.ready()]);
        const created = await first.upsert(input(tenantId));
        running = tick(first);
        await waitForHandler(entered.promise);
        const cadence = { kind: 'daily', timeOfDay: '11:45', timezone: 'Asia/Shanghai' } as const;
        if (mutation === 'pause') await second.pause(created.id, tenantId);
        if (mutation === 'reschedule') await second.reschedule(created.id, tenantId, cadence);
        if (mutation === 'resume') await second.resume(created.id, tenantId);
        if (mutation === 'delete') await second.remove(created.id, tenantId);
        if (mutation === 'upsert') await second.upsert({ ...input(tenantId), id: created.id, cadence, enabled: false, nextRunAt: '2099-01-01T00:00:00.000Z' });
        if (mutation === 'health-action') await second.applyHealthAction({
          tenantId, userId: 'owner', scheduleId: created.id, suggestionId: randomUUID(), kind: 'capacity_conflict',
          action: 'reschedule', proposedCadence: cadence, reason: 'Test schedule change', evidence: [],
          expected: scheduleHealthState(created), confirmedBy: 'owner',
        });
        const edited = await second.get(created.id, tenantId);
        if (mutation === 'delete') assert.equal(edited, null);
        else assert.equal(edited?.revision, (created.revision ?? 0) + 1);
        gate.resolve();
        await running;
        assert.deepEqual(await first.get(created.id, tenantId), edited, `${mutation} must survive old ${outcome}`);
        await second.remove(created.id, tenantId);
      } finally {
        gate.resolve();
        await running;
        try {
          await pool.query('DELETE FROM schedule_health_actions WHERE tenant_id=$1', [tenantId]);
          await pool.query('DELETE FROM schedules WHERE tenant_id=$1', [tenantId]);
        } finally { await Promise.all([first.stop(), second.stop()]); }
      }
    }
  }
  } finally { await pool.end(); }
});

test('PostgreSQL expired schedule claims cannot overwrite their replacement', {
  skip: connectionString ? false : 'AXIOM_TEST_DATABASE_URL is not configured.',
  timeout: 20_000,
}, async () => {
  const tenantId = `schedule-lease-pg-${randomUUID()}`;
  const pool = new Pool({ connectionString, max: 1 });
  const firstEntered = deferred();
  const secondEntered = deferred();
  const firstGate = deferred();
  const secondGate = deferred();
  const first = new PostgresScheduler(connectionString!, async () => { firstEntered.resolve(); await firstGate.promise; });
  const second = new PostgresScheduler(connectionString!, async () => { secondEntered.resolve(); await secondGate.promise; });
  let firstRun: Promise<void> | undefined;
  let secondRun: Promise<void> | undefined;
  try {
    await Promise.all([first.ready(), second.ready()]);
    const created = await first.upsert(input(tenantId));
    firstRun = tick(first);
    await waitForHandler(firstEntered.promise);
    const original = (await pool.query('SELECT revision,claim_token FROM schedules WHERE id=$1', [created.id])).rows[0];
    await pool.query(`UPDATE schedules SET claimed_until=NOW()-INTERVAL '1 second' WHERE id=$1`, [created.id]);
    secondRun = tick(second);
    await waitForHandler(secondEntered.promise);
    const replacement = (await pool.query('SELECT revision,claim_token FROM schedules WHERE id=$1', [created.id])).rows[0];
    assert.equal(replacement.revision, original.revision);
    assert.notEqual(replacement.claim_token, original.claim_token);
    firstGate.resolve();
    await firstRun;
    assert.deepEqual((await pool.query('SELECT revision,claim_token FROM schedules WHERE id=$1', [created.id])).rows[0], replacement);
    secondGate.resolve();
    await secondRun;
    const completed = await first.get(created.id, tenantId);
    assert.equal(completed?.lastRunStatus, 'success');
    assert.equal(completed?.revision, (created.revision ?? 0) + 1);
    const claimedUntil = (await pool.query('SELECT claimed_until,claim_token FROM schedules WHERE id=$1', [created.id])).rows[0];
    assert.deepEqual(claimedUntil, { claimed_until: null, claim_token: null });
    await second.remove(created.id, tenantId);
    assert.equal(await first.get(created.id, tenantId), null);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([firstRun, secondRun]);
    try { await pool.query('DELETE FROM schedules WHERE tenant_id=$1', [tenantId]); }
    finally { await Promise.all([first.stop(), second.stop(), pool.end()]); }
  }
});
