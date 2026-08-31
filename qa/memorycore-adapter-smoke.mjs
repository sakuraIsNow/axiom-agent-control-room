/** Exercise Axiom's TencentMemoryClient against a real MemoryCore Gateway. */

const endpoint = (process.env.TDAI_MEMORY_ENDPOINT ?? '').trim();
if (!endpoint) {
  console.log('SKIP: TDAI_MEMORY_ENDPOINT is not configured; MemoryCore adapter is disabled.');
  process.exit(0);
}

const { TencentMemoryClient } = await import('../server/runtime/memoryClient.ts');
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const task = {
  id: `qa-adapter-task-${suffix}`,
  runId: `qa-adapter-run-${suffix}`,
  tenantId: `qa-adapter-${suffix}`,
  userId: 'qa-adapter-user',
  sessionId: `qa-adapter-session-${suffix}`,
  title: 'MemoryCore adapter smoke',
  input: 'adapter smoke input',
  mode: 'analyze',
  status: 'completed',
  stepResults: [],
  policy: { requirePlanApproval: false },
  cancelRequested: false,
  planVersion: 0,
  result: 'adapter smoke result',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const signal = new AbortController().signal;
const client = new TencentMemoryClient({
  endpoint,
  apiKey: process.env.TDAI_MEMORY_API_KEY,
  serviceId: process.env.TDAI_MEMORY_INSTANCE_ID,
});

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const poll = async (fn, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return undefined;
};

let memoryId;
try {
  const health = await client.health(signal);
  assert(health.reachable, `MemoryCore health probe failed: ${health.detail}`);

  const transcript = [
    'USER:',
    'Our production workflow must preserve checkpoints and evidence across worker restarts.',
    '',
    'ASSISTANT:',
    'The workflow will persist checkpoints and verify evidence before completion.',
  ].join('\n');
  const captured = await client.capture(task, transcript, 'Checkpoint and evidence preference recorded.', signal);
  assert(!captured.skipped, `Memory capture was skipped: ${captured.reason ?? 'unknown'}`);
  const duplicate = await client.capture(task, transcript, 'Checkpoint and evidence preference recorded.', signal);
  assert(duplicate.reason === 'already_completed', 'Repeated capture was not deduplicated by the receipt store.');

  const recall = await poll(async () => {
    const value = await client.recall(task, 'orchestrator', 'checkpoints evidence worker restarts', signal);
    return value.itemCount > 0 ? value : undefined;
  }, Number(process.env.MEMORYCORE_QA_WAIT_L1_MS ?? 60_000));
  assert(recall?.itemCount > 0, 'Adapter recall returned no L1/L2/L3 memories before the timeout.');
  memoryId = recall.items[0]?.memoryId;
  assert(memoryId, 'Adapter recall did not return a stable memoryId.');

  const scope = {
    tenantId: task.tenantId,
    userId: task.userId,
    agentId: 'orchestrator',
    sessionId: task.sessionId,
  };
  const updatedText = `Adapter update ${suffix}: preserve the evidence chain.`;
  await client.updateAtomic(scope, memoryId, updatedText, 'adapter smoke', signal);
  const updatedRecall = await poll(async () => {
    const value = await client.recall(task, 'orchestrator', 'preserve evidence chain', signal);
    return value.items.some((item) => item.memoryId === memoryId && item.content.includes(updatedText)) ? value : undefined;
  }, 10_000);
  assert(updatedRecall, 'Adapter L1 update was not visible after the write.');
  await client.deleteAtomic(scope, [memoryId], signal);

  await client.writeCore(scope, `Adapter core ${suffix}: durable context is enabled.`, signal);
  const core = await client.readCore(scope, signal);
  assert(core.content?.includes(`Adapter core ${suffix}`), 'Adapter L3 core read did not return the written content.');

  console.log(JSON.stringify({
    status: 'passed',
    endpoint,
    tenantId: task.tenantId,
    captured: captured.capturedCount,
    recalled: recall.itemCount,
    updated: true,
    core: true,
  }, null, 2));
} finally {
  try {
    if (memoryId) {
      await client.deleteAtomic({ tenantId: task.tenantId, userId: task.userId, agentId: 'orchestrator', sessionId: task.sessionId }, [memoryId], signal);
    }
  } catch { /* best-effort cleanup */ }
  try {
    await client.deleteConversation({ tenantId: task.tenantId, userId: task.userId, agentId: 'orchestrator', sessionId: task.sessionId }, { sessionIds: [task.sessionId] }, signal);
  } catch { /* best-effort cleanup */ }
  await client.close();
}

