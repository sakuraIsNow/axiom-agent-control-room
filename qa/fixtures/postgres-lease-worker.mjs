import { PostgresTaskStore } from '../../server/runtime/postgresTaskStore.ts';

const [workerId, leaseMsRaw] = process.argv.slice(2);
const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();
if (!connectionString || !workerId) throw new Error('Worker fixture requires AXIOM_TEST_DATABASE_URL and a worker id.');
const leaseMs = Number(leaseMsRaw);
if (!Number.isFinite(leaseMs) || leaseMs < 500) throw new Error('Worker fixture lease must be at least 500 ms.');

const store = new PostgresTaskStore(connectionString);
await store.initialize();
const task = await store.claimNextTask(workerId, leaseMs);
process.send?.({ type: 'claim', workerId, taskId: task?.id ?? null });

if (!task) {
  await store.close();
  process.exit(0);
}

let closing = false;
const close = async (code = 0) => {
  if (closing) return;
  closing = true;
  await store.close().catch(() => undefined);
  process.exit(code);
};

process.on('message', async (message) => {
  if (!message || message.type !== 'complete' || closing) return;
  try {
    const renewed = await store.renewLease(task.id, workerId, leaseMs);
    if (!renewed) throw new Error('The winning worker lost its lease before completion.');
    await store.appendEvent(task, {
      type: 'agent.started',
      agentId: workerId,
      payload: { stepId: 'failover-step', recovered: true },
    });
    const current = await store.getTask(task.id, task.tenantId);
    if (!current) throw new Error('Claimed task disappeared before completion.');
    await store.updateTask(task.id, { status: 'completed', result: `completed-by:${workerId}` }, current.revision);
    await store.appendEvent(task, {
      type: 'task.completed',
      agentId: workerId,
      payload: { recovered: true, result: `completed-by:${workerId}` },
    });
    await store.releaseLease(task.id, workerId);
    process.send?.({ type: 'completed', workerId, taskId: task.id, renewed });
    await close(0);
  } catch (error) {
    process.send?.({ type: 'error', workerId, message: error instanceof Error ? error.message : String(error) });
    await close(1);
  }
});

process.on('disconnect', () => void close(0));
setInterval(() => undefined, 1_000).unref();
