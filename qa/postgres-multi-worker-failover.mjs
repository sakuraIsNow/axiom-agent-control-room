import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { PostgresTaskStore } from '../server/runtime/postgresTaskStore.ts';

const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();
if (!connectionString) {
  console.log('SKIP: AXIOM_TEST_DATABASE_URL is not configured; PostgreSQL failover was not exercised.');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = resolve(root, 'qa', 'fixtures', 'postgres-lease-worker.mjs');
const leaseMs = 1_500;
const tenantId = `qa-failover-${randomUUID()}`;
const firstStore = new PostgresTaskStore(connectionString);
const secondStore = new PostgresTaskStore(connectionString);
const inspectionPool = new Pool({ connectionString, max: 2 });
const children = new Set();
let task;

const waitForMessage = (child, acceptedTypes, timeoutMs = 10_000) => new Promise((resolveMessage, rejectMessage) => {
  const timeout = setTimeout(() => {
    cleanup();
    rejectMessage(new Error(`Timed out waiting for worker message: ${acceptedTypes.join(', ')}`));
  }, timeoutMs);
  const onMessage = (message) => {
    if (!message || !acceptedTypes.includes(message.type)) return;
    cleanup();
    if (message.type === 'error') rejectMessage(new Error(message.message));
    else resolveMessage(message);
  };
  const onExit = (code, signal) => {
    cleanup();
    rejectMessage(new Error(`Worker exited before reporting ${acceptedTypes.join(', ')} (${code ?? signal ?? 'unknown'}).`));
  };
  const cleanup = () => {
    clearTimeout(timeout);
    child.off('message', onMessage);
    child.off('exit', onExit);
  };
  child.on('message', onMessage);
  child.once('exit', onExit);
});

const spawnWorker = (workerId) => {
  const child = fork(fixture, [workerId, String(leaseMs)], {
    cwd: root,
    env: { ...process.env, AXIOM_TEST_DATABASE_URL: connectionString },
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  return child;
};

const waitForExit = (child, timeoutMs = 10_000) => new Promise((resolveExit, rejectExit) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
  const timeout = setTimeout(() => rejectExit(new Error('Timed out waiting for worker process to exit.')), timeoutMs);
  child.once('exit', () => {
    clearTimeout(timeout);
    resolveExit();
  });
});

await Promise.all([firstStore.initialize(), secondStore.initialize()]);
try {
  task = await firstStore.createTask({
    tenantId,
    userId: 'qa-owner',
    sessionId: `session-${randomUUID()}`,
    title: 'PostgreSQL multi-worker failover acceptance',
    input: 'Use a precomputed plan so this test never calls a model.',
    mode: 'analyze',
    idempotencyKey: `failover-${randomUUID()}`,
    plan: {
      summary: 'Failover test plan',
      routingReason: 'Precomputed acceptance fixture',
      steps: [{
        id: 'failover-step',
        title: 'Complete after lease recovery',
        role: 'analyst',
        objective: 'Verify that only the lease winner can complete the task.',
        dependsOn: [],
        acceptanceCriteria: ['Exactly one terminal event is persisted.'],
      }],
    },
  });
  await firstStore.appendEvent(task, { type: 'task.created', payload: { source: 'postgres-failover-qa' } });
  await firstStore.appendEvent(task, { type: 'task.queued', payload: {} });

  const workerAId = `worker-a-${randomUUID()}`;
  const workerA = spawnWorker(workerAId);
  const claimA = await waitForMessage(workerA, ['claim', 'error']);
  assert.equal(claimA.taskId, task.id, 'Worker A must claim the fixture task.');

  const earlyProbe = spawnWorker(`worker-early-${randomUUID()}`);
  const earlyClaim = await waitForMessage(earlyProbe, ['claim', 'error']);
  assert.equal(earlyClaim.taskId, null, 'Another worker must not claim a live lease.');
  await waitForExit(earlyProbe);

  workerA.kill();
  await waitForExit(workerA);
  const leaseBeforeExpiry = await inspectionPool.query(
    'SELECT lease_owner, lease_expires_at FROM tasks WHERE id = $1',
    [task.id],
  );
  assert.equal(leaseBeforeExpiry.rows[0]?.lease_owner, workerAId, 'A crashed worker must not release its lease gracefully.');

  const expiresAt = new Date(leaseBeforeExpiry.rows[0].lease_expires_at).getTime();
  await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(0, expiresAt - Date.now()) + 150));

  const contenders = [spawnWorker(`worker-b-${randomUUID()}`), spawnWorker(`worker-c-${randomUUID()}`)];
  const claims = await Promise.all(contenders.map((child) => waitForMessage(child, ['claim', 'error'])));
  const winners = claims.map((claim, index) => ({ claim, child: contenders[index] })).filter(({ claim }) => claim.taskId === task.id);
  const losers = claims.map((claim, index) => ({ claim, child: contenders[index] })).filter(({ claim }) => claim.taskId === null);
  assert.equal(winners.length, 1, 'Exactly one contender must claim the expired lease.');
  assert.equal(losers.length, 1, 'The losing contender must observe no claimable task.');
  await waitForExit(losers[0].child);

  const winner = winners[0];
  assert.equal(await firstStore.renewLease(task.id, workerAId, leaseMs), false, 'The stale owner must not renew the new lease.');
  await firstStore.releaseLease(task.id, workerAId);
  const ownerAfterStaleRelease = await inspectionPool.query('SELECT lease_owner FROM tasks WHERE id = $1', [task.id]);
  assert.equal(ownerAfterStaleRelease.rows[0]?.lease_owner, winner.claim.workerId, 'The stale owner must not release the winner lease.');

  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? firstStore : secondStore).appendEvent(task, {
    type: 'human.note',
    payload: { index, source: index % 2 === 0 ? 'store-a' : 'store-b' },
  })));

  winner.child.send({ type: 'complete' });
  const completed = await waitForMessage(winner.child, ['completed', 'error']);
  assert.equal(completed.renewed, true, 'The winner must retain and renew its lease.');
  await waitForExit(winner.child);

  const finalTask = await secondStore.getTask(task.id, tenantId);
  assert.equal(finalTask?.status, 'completed');
  assert.equal(finalTask?.result, `completed-by:${winner.claim.workerId}`);
  const events = await firstStore.getEvents(task.id);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
  assert.equal(new Set(events.map((event) => event.sequence)).size, events.length);
  assert.equal(events.filter((event) => event.type === 'task.completed').length, 1);

  console.log(JSON.stringify({
    ok: true,
    processCrashRecovery: true,
    exclusiveClaim: true,
    staleOwnerFenced: true,
    continuousEventSequence: true,
    completedEvents: 1,
    eventCount: events.length,
  }));
} finally {
  for (const child of children) child.kill();
  await Promise.all([...children].map((child) => waitForExit(child).catch(() => undefined)));
  if (task) await firstStore.deleteTask(task.id, tenantId).catch(() => false);
  await Promise.all([firstStore.close(), secondStore.close(), inspectionPool.end()]);
}
