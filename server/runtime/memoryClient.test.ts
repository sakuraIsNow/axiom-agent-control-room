import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkflowTask } from './contracts.js';
import { TencentMemoryClient } from './memoryClient.js';
import { SqliteMemoryCaptureReceiptStore } from './memoryCaptureStore.js';

const task = (patch: Partial<WorkflowTask> = {}): WorkflowTask => ({
  id: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  revision: 0,
  tenantId: 'tenant-a',
  userId: 'user-a',
  sessionId: 'session-a',
  title: 'memory test',
  input: 'remember this',
  mode: 'analyze',
  status: 'completed',
  stepResults: [],
  policy: { requirePlanApproval: false },
  cancelRequested: false,
  planVersion: 0,
  result: 'done',
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-29T08:00:01.000Z',
  ...patch,
});

const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ code: status === 200 ? 0 : status, message: status === 200 ? 'ok' : 'failed', data }), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('memory capture is idempotent, stores only the latest user turn, and redacts secrets', async () => {
  const receiptStore = new SqliteMemoryCaptureReceiptStore(':memory:');
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return envelope({ accepted_ids: ['m1', 'm2'], total_count: 12 });
  };
  const client = new TencentMemoryClient({ endpoint: 'http://memory.test', receiptStore, fetcher });
  await client.initialize();
  try {
    const transcript = 'USER:\n旧问题\n\nASSISTANT:\n旧回答\n\nUSER:\n新问题，key=sk-1234567890abcdef';
    const [first, second] = await Promise.all([
      client.capture(task(), transcript, '新回答', new AbortController().signal),
      client.capture(task(), transcript, '新回答', new AbortController().signal),
    ]);
    assert.equal(bodies.length, 1);
    assert.equal([first, second].filter((result) => !result.skipped).length, 1);
    assert.equal([first, second].filter((result) => result.reason === 'in_progress').length, 1);
    const messages = bodies[0]?.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0]?.content, '新问题，key=[redacted-key]');
    assert.equal(messages[1]?.content, '新回答');
    assert.doesNotMatch(JSON.stringify(bodies), /sk-1234567890abcdef/);

    const duplicate = await client.capture(task(), transcript, '新回答', new AbortController().signal);
    assert.equal(duplicate.reason, 'already_completed');
    assert.equal(bodies.length, 1);
  } finally {
    await client.close();
  }
});

test('memory capture marks failures as retryable and succeeds on the next attempt', async () => {
  const receiptStore = new SqliteMemoryCaptureReceiptStore(':memory:');
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return calls === 1 ? envelope({}, 503) : envelope({ accepted_ids: ['m1', 'm2'], total_count: 2 });
  };
  const client = new TencentMemoryClient({ endpoint: 'http://memory.test', receiptStore, fetcher });
  await client.initialize();
  try {
    await assert.rejects(() => client.capture(task(), '问题', '回答', new AbortController().signal));
    const result = await client.capture(task(), '问题', '回答', new AbortController().signal);
    assert.equal(result.skipped, false);
    assert.equal(calls, 2);
    const stats = await client.captureStats('tenant-a', 'user-a');
    assert.equal(stats.attempts, 2);
    assert.equal(stats.completed, 1);
    assert.equal(stats.failed, 0);
  } finally {
    await client.close();
  }
});

test('memory capture compensation survives a process restart and reclaims an expired lease', async () => {
  const path = resolve(process.cwd(), '.data', `memory-recovery-${randomUUID()}.sqlite`);
  let calls = 0;
  const failing: typeof fetch = async () => {
    calls += 1;
    return envelope({}, 503);
  };
  const firstStore = new SqliteMemoryCaptureReceiptStore(path);
  const first = new TencentMemoryClient({ endpoint: 'http://memory.test', receiptStore: firstStore, fetcher: failing });
  await first.initialize();
  try {
    await assert.rejects(() => first.capture(task(), '跨重启问题', '跨重启回答', new AbortController().signal));
    const pending = await firstStore.listRetryable(10, new Date(Date.now() + 2_000));
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.requestInput, '跨重启问题');
  } finally {
    await first.close();
  }

  // The durable retry policy starts with a one-second backoff. A restarted
  // worker must honor that lease rather than hot-looping the upstream service.
  await new Promise((resolve) => setTimeout(resolve, 1_050));

  const succeeding: typeof fetch = async () => {
    calls += 1;
    return envelope({ accepted_ids: ['recovered'], total_count: 1 });
  };
  const second = new TencentMemoryClient({ endpoint: 'http://memory.test', receiptStore: new SqliteMemoryCaptureReceiptStore(path), fetcher: succeeding });
  try {
    await second.initialize();
    const result = await second.runCaptureCompensation(10);
    assert.equal(result.attempted, 1);
    assert.equal(result.completed, 1);
    assert.equal((await second.captureStats('tenant-a', 'user-a')).completed, 1);
    assert.equal(calls, 2);
  } finally {
    await second.close();
    rmSync(path, { force: true });
  }
});

test('memory compensation terminally acknowledges a failed capture superseded by a newer cursor', async () => {
  const receiptStore = new SqliteMemoryCaptureReceiptStore(':memory:');
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return calls === 1
      ? envelope({}, 503)
      : envelope({ accepted_ids: ['newer-user', 'newer-assistant'], total_count: 2 });
  };
  const client = new TencentMemoryClient({ endpoint: 'http://memory.test', receiptStore, fetcher });
  await client.initialize();
  try {
    const older = task({ id: '11111111-1111-4111-8111-111111111112', updatedAt: '2026-08-29T08:00:01.000Z' });
    await assert.rejects(() => client.capture(older, 'older input', 'older output', new AbortController().signal));
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const newer = task({ id: '11111111-1111-4111-8111-111111111113', updatedAt: '2026-08-29T08:00:02.000Z' });
    const captured = await client.capture(newer, 'newer input', 'newer output', new AbortController().signal);
    assert.equal(captured.skipped, false);

    const compensation = await client.runCaptureCompensation(10);
    assert.equal(compensation.attempted, 1);
    assert.equal(compensation.completed, 1);
    assert.equal(calls, 2, 'an obsolete receipt should not call MemoryCore again');
    const stats = await client.captureStats('tenant-a', 'user-a');
    assert.equal(stats.failed, 0);
    assert.equal(stats.completed, 2);
  } finally {
    await client.close();
  }
});

test('memory recall filters expired and low-confidence records while preserving layer provenance', async () => {
  const previousThreshold = process.env.AXIOM_MEMORY_MIN_CONFIDENCE;
  process.env.AXIOM_MEMORY_MIN_CONFIDENCE = '0.4';
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v3/atomic/search') return envelope({ items: [
      { id: 'high', content: '可信项目偏好', score: 0.91, created_at: '2026-08-20T00:00:00.000Z' },
      { id: 'low', content: '低置信度噪声', score: 0.12 },
      { id: 'expired', content: '已经过期的计划', score: 0.99, expires_at: '2025-01-01T00:00:00.000Z' },
    ] });
    if (path === '/v3/core/read') return envelope({ content: '用户偏好结构化结论', updated_at: '2026-08-28T00:00:00.000Z' });
    if (path === '/v3/scenario/ls') return envelope({ entries: [
      { path: '项目/上线.md', summary: '上线前必须完成回归', confidence: 0.8 },
      { path: '项目/旧版.md', summary: '旧方案', expires_at: '2024-01-01T00:00:00.000Z' },
    ] });
    return envelope({});
  };
  const client = new TencentMemoryClient({ endpoint: 'http://memory.test', receiptStore: new SqliteMemoryCaptureReceiptStore(':memory:'), fetcher });
  try {
    const recall = await client.recall(task(), 'planner', '上线计划', new AbortController().signal);
    assert.equal(recall.available, true);
    assert.equal(recall.itemCount, 3);
    assert.deepEqual(recall.quality.byLayer, { L1: 1, L2: 1, L3: 1 });
    assert.equal(recall.quality.expiredFiltered, 2);
    assert.equal(recall.quality.lowConfidenceFiltered, 1);
    assert.match(recall.context, /可信项目偏好/);
    assert.match(recall.context, /上线前必须完成回归/);
    assert.match(recall.context, /用户偏好结构化结论/);
    assert.doesNotMatch(recall.context, /低置信度噪声|已经过期的计划|旧方案/);
    assert.ok(recall.items.every((item) => item.source.startsWith('memorycore:') && item.confidence >= 0.4));
  } finally {
    process.env.AXIOM_MEMORY_MIN_CONFIDENCE = previousThreshold;
    await client.close();
  }
});

test('memory recall fails closed for malformed expiry metadata', async () => {
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v3/atomic/search') return envelope({ items: [{ id: 'malformed', content: 'unknown lifetime', score: 0.99, expires_at: 'not-a-date' }] });
    if (path === '/v3/core/read') return envelope({});
    if (path === '/v3/scenario/ls') return envelope({ entries: [] });
    return envelope({});
  };
  const client = new TencentMemoryClient({ endpoint: 'http://memory.test', receiptStore: new SqliteMemoryCaptureReceiptStore(':memory:'), fetcher });
  try {
    const recall = await client.recall(task(), 'planner', 'query', new AbortController().signal);
    assert.equal(recall.itemCount, 0);
    assert.equal(recall.quality.expiredFiltered, 1);
  } finally {
    await client.close();
  }
});

test('partial MemoryCore recall failures degrade without failing the task context', async () => {
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v3/core/read') return envelope({}, 503);
    if (path === '/v3/atomic/search') return envelope({ items: [{ id: 'a', content: '可用记忆', score: 0.8 }] });
    return envelope({ entries: [] });
  };
  const client = new TencentMemoryClient({ endpoint: 'http://memory.test', receiptStore: new SqliteMemoryCaptureReceiptStore(':memory:'), fetcher });
  try {
    const recall = await client.recall(task(), 'planner', 'query', new AbortController().signal);
    assert.equal(recall.available, true);
    assert.equal(recall.itemCount, 1);
    assert.match(recall.context, /可用记忆/);
  } finally {
    await client.close();
  }
});

test('memory recall falls back to scoped atomic query when search is unavailable or empty', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === '/v3/atomic/search') return envelope({ items: [] });
    if (path === '/v3/atomic/query') return envelope({ items: [
      {
        record_id: 'query-fallback-memory',
        content: '跨重启保留检查点和证据链',
        created_at: '2026-08-29T08:00:00.000Z',
      },
    ] });
    if (path === '/v3/core/read') return envelope({}, 503);
    if (path === '/v3/scenario/ls') return envelope({ entries: [] });
    return envelope({});
  };
  const client = new TencentMemoryClient({
    endpoint: 'http://memory.test',
    receiptStore: new SqliteMemoryCaptureReceiptStore(':memory:'),
    fetcher,
  });
  try {
    const recall = await client.recall(task(), 'orchestrator', '检查点证据链', new AbortController().signal);
    assert.equal(recall.available, true);
    assert.equal(recall.itemCount, 1);
    assert.equal(recall.items[0]?.memoryId, 'query-fallback-memory');
    assert.equal(recall.items[0]?.source, 'memorycore:/v3/atomic/query (fallback)');
    assert.equal(recall.items[0]?.confidence, 0.5);
    assert.deepEqual(calls.slice(0, 2), ['/v3/atomic/search', '/v3/core/read']);
    assert.ok(calls.includes('/v3/atomic/query'));
  } finally {
    await client.close();
  }
});

test('memory recall remains a non-blocking empty result when search and query both fail', async () => {
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v3/atomic/search' || path === '/v3/atomic/query') return envelope({}, 503);
    if (path === '/v3/core/read') return envelope({}, 503);
    if (path === '/v3/scenario/ls') return envelope({}, 503);
    return envelope({});
  };
  const client = new TencentMemoryClient({
    endpoint: 'http://memory.test',
    receiptStore: new SqliteMemoryCaptureReceiptStore(':memory:'),
    fetcher,
  });
  try {
    const recall = await client.recall(task(), 'orchestrator', 'query', new AbortController().signal);
    assert.equal(recall.available, false);
    assert.equal(recall.itemCount, 0);
    assert.equal(recall.context, '');
  } finally {
    await client.close();
  }
});
