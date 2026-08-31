/**
 * Real MemoryCore integration smoke.
 *
 * The test is intentionally opt-in: without TDAI_MEMORY_ENDPOINT there is no
 * external service to verify, so the script exits successfully with a clear
 * skip message. When configured it exercises the public v3 data plane through
 * HTTP and fails on an unhealthy or partially working Gateway.
 */

const endpoint = (process.env.TDAI_MEMORY_ENDPOINT ?? '').trim().replace(/\/$/, '');
if (!endpoint) {
  console.log('SKIP: TDAI_MEMORY_ENDPOINT is not configured; MemoryCore integration is not enabled.');
  process.exit(0);
}

const apiKey = (process.env.TDAI_MEMORY_API_KEY ?? '').trim();
const serviceId = (process.env.TDAI_MEMORY_INSTANCE_ID ?? 'axiom-control-room').trim();
const waitL1Ms = Math.max(0, Number(process.env.MEMORYCORE_QA_WAIT_L1_MS ?? 45_000));
const waitL2Ms = Math.max(0, Number(process.env.MEMORYCORE_QA_WAIT_L2_MS ?? 15_000));
const startedAt = Date.now();
const suffix = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
const scope = {
  team_id: `qa-memory-${suffix}`,
  agent_id: 'orchestrator',
  user_id: 'qa-user',
  session_id: `qa-session-${suffix}`,
};

const headers = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'x-tdai-service-id': serviceId,
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
};

const request = async (path, body, options = {}) => {
  const response = await fetch(`${endpoint}${path}`, {
    method: options.method ?? 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(Number(options.timeoutMs ?? 20_000)),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || (!options.allowRaw && payload?.code !== 0)) {
    const message = payload?.message ?? `HTTP ${response.status}`;
    throw new Error(`${options.label ?? path} failed: ${message}`);
  }
  return options.allowRaw ? payload : payload.data;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const poll = async (fn, timeoutMs, intervalMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
};

let createdMessageIds = [];
let l1Id;
let scenarioPath;

try {
  const health = await request('/health', undefined, { method: 'GET', label: 'MemoryCore health', allowRaw: true });
  assert(health?.status === 'ok', 'MemoryCore health did not report status=ok.');

  const messages = Array.from({ length: 5 }, (_, index) => [
    { role: 'user', content: `Durable workflow preference ${index + 1}: preserve checkpoints, evidence, and recovery state across worker restarts.` },
    { role: 'assistant', content: `Recorded durable preference ${index + 1} for the production workflow.` },
  ]).flat();
  const added = await request('/v3/conversation/add', { ...scope, messages }, { label: 'L0 conversation add' });
  createdMessageIds = added?.accepted_ids ?? [];
  assert(createdMessageIds.length === messages.length, `Expected ${messages.length} L0 records, got ${createdMessageIds.length}.`);

  const conversation = await request('/v3/conversation/query', { ...scope, limit: 100 }, { label: 'L0 conversation query' });
  assert(conversation?.total === messages.length, `Expected exactly ${messages.length} L0 records, got ${conversation?.total}.`);

  const isolated = await request('/v3/conversation/query', {
    ...scope,
    user_id: 'different-user',
    limit: 100,
  }, { label: 'L0 tenant isolation query' });
  assert(isolated?.total === 0, 'L0 query crossed the user isolation boundary.');

  const atomic = await poll(async () => {
    const result = await request('/v3/atomic/query', { ...scope, limit: 100 }, { label: 'L1 atomic query' });
    return result?.items?.[0] ? result : null;
  }, waitL1Ms);
  assert(atomic?.items?.length > 0, 'No L1 memory was extracted before the integration timeout. Check MemoryCore LLM configuration.');
  l1Id = atomic.items[0].id;

  const updatedContent = `Updated production memory ${suffix}: checkpoints must survive worker restarts.`;
  await request('/v3/atomic/update', { ...scope, id: l1Id, content: updatedContent, background: 'qa integration' }, { label: 'L1 atomic update' });
  const updated = await request('/v3/atomic/query', { ...scope, limit: 100 }, { label: 'L1 updated query' });
  assert(updated.items.some((item) => item.id === l1Id && item.content === updatedContent), 'L1 update was not visible after the write.');

  const coreContent = `Axiom MemoryCore integration ${suffix}: durable user preference.`;
  await request('/v3/core/write', { ...scope, content: coreContent }, { label: 'L3 core write' });
  const core = await request('/v3/core/read', scope, { label: 'L3 core read' });
  assert(core?.content === coreContent, 'L3 core read did not return the just-written content.');

  const scenarioList = await poll(async () => {
    const result = await request('/v3/scenario/ls', scope, { label: 'L2 scenario list' });
    return result?.entries?.find((entry) => entry.path?.endsWith('.md')) ? result : null;
  }, waitL2Ms);
  if (scenarioList?.entries?.length) {
    const entry = scenarioList.entries.find((candidate) => candidate.path?.endsWith('.md'));
    scenarioPath = entry.path;
    const scenario = await request('/v3/scenario/read', { ...scope, path: scenarioPath }, { label: 'L2 scenario read' });
    assert(typeof scenario?.content === 'string', 'L2 scenario read returned no content.');
    await request('/v3/scenario/write', {
      ...scope,
      path: scenarioPath,
      content: `${scenario.content}\n\nQA integration update ${suffix}`,
      summary: 'Axiom integration smoke',
    }, { label: 'L2 scenario update' });
  } else {
    console.log('WARN: no L2 scenario was available in the configured wait window; L2 generation is asynchronous.');
  }

  console.log(JSON.stringify({
    status: 'passed',
    endpoint,
    serviceId,
    tenantId: scope.team_id,
    l0Messages: createdMessageIds.length,
    l1MemoryId: l1Id,
    l2Scenario: scenarioPath ?? null,
    l3Verified: true,
    elapsedMs: Date.now() - startedAt,
  }, null, 2));
} finally {
  // Cleanup is best-effort. Keep the test failure visible while avoiding stale
  // L0/L1/L2 data in a shared local MemoryCore instance.
  try {
    if (l1Id) await request('/v3/atomic/delete', { ...scope, ids: [l1Id] }, { label: 'L1 cleanup' });
  } catch (error) {
    console.warn(`WARN: L1 cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (scenarioPath) await request('/v3/scenario/rm', { ...scope, path: scenarioPath }, { label: 'L2 cleanup' });
  } catch (error) {
    console.warn(`WARN: L2 cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (createdMessageIds.length) await request('/v3/conversation/delete', { ...scope, message_ids: createdMessageIds }, { label: 'L0 cleanup' });
  } catch (error) {
    console.warn(`WARN: L0 cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
