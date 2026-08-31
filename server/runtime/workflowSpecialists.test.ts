import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { compileAgentWorkflow } from './workflowCompiler.js';
import { executeWorkflowSpecialist, workflowSpecialistCatalog } from './workflowSpecialists.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { WorkflowOrchestrator } from './orchestrator.js';
import { EventHub } from './eventHub.js';
import type { AgentMemory } from './memoryClient.js';
import type { ModelClient } from './modelClient.js';

const envKeys = ['DMX_API_KEY', 'DMX_BASE_URL', 'DMX_MODEL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_API_BASE', 'DEEPSEEK_NATIVE_SEARCH_MODEL', 'DEEPSEEK_NATIVE_SEARCH', 'VIDEO_API_BASE', 'VIDEO_API_KEY', 'VIDEO_MODEL'] as const;

const withEnvironment = async (values: Partial<Record<(typeof envKeys)[number], string>>, action: () => Promise<void>) => {
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of envKeys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    await action();
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
};

test('workflow specialist catalog reports configured capability instead of overclaiming', async () => {
  await withEnvironment({}, async () => {
    const catalog = workflowSpecialistCatalog();
    assert.equal(catalog.find((agent) => agent.id === 'drawing-agent')?.available, false);
    assert.equal(catalog.find((agent) => agent.id === 'search-agent')?.available, false);
    assert.equal(catalog.find((agent) => agent.id === 'video-agent')?.available, false);
  });
  await withEnvironment({ DMX_API_KEY: 'image-key', DEEPSEEK_API_KEY: 'search-key', VIDEO_API_BASE: 'http://127.0.0.1:9000', VIDEO_MODEL: 'local-video' }, async () => {
    const catalog = workflowSpecialistCatalog();
    assert.equal(catalog.find((agent) => agent.id === 'drawing-agent')?.available, true);
    assert.equal(catalog.find((agent) => agent.id === 'search-agent')?.available, true);
    assert.equal(catalog.find((agent) => agent.id === 'video-agent')?.available, true);
  });
});

test('drawing specialist returns a renderable Markdown image from the configured provider', async () => {
  const originalFetch = globalThis.fetch;
  await withEnvironment({ DMX_API_KEY: 'image-key', DMX_BASE_URL: 'https://image.example/v1', DMX_MODEL: 'image-model' }, async () => {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://image.example/v1/images/generations');
      assert.match(String(init?.headers && JSON.stringify(init.headers)), /image-key/);
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/generated.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const result = await executeWorkflowSpecialist('drawing-agent', '雨夜未来城市', new AbortController().signal);
      assert.equal(result.model, 'image-model');
      assert.match(result.output, /!\[工作流生成图片 1\]\(https:\/\/cdn\.example\/generated\.png\)/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('search specialist forces native web_search and preserves source URLs', async () => {
  const originalFetch = globalThis.fetch;
  await withEnvironment({ DEEPSEEK_API_KEY: 'search-key', DEEPSEEK_API_BASE: 'https://api.deepseek.com', DEEPSEEK_NATIVE_SEARCH_MODEL: 'deepseek-v4-flash' }, async () => {
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { tools?: Array<{ type: string }>; tool_choice?: { type: string }; model?: string; stream?: boolean };
      assert.deepEqual(request.tools, [{ type: 'web_search' }]);
      assert.deepEqual(request.tool_choice, { type: 'web_search' });
      assert.equal(request.model, 'deepseek-v4-flash');
      assert.equal(request.stream, true);
      return new Response(JSON.stringify({ output_text: '检索结果：https://example.com/source' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const result = await executeWorkflowSpecialist('search-agent', '查询最新资料', new AbortController().signal);
      assert.match(result.output, /https:\/\/example\.com\/source/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('workflow compilation rejects an unavailable service Agent before execution', async () => {
  await withEnvironment({}, async () => {
    const compiled = compileAgentWorkflow({
      schemaVersion: 1,
      nodes: [
        { id: 'input', type: 'input', name: '输入', position: { x: 0, y: 0 } },
        { id: 'draw', type: 'agent', name: '绘图', position: { x: 200, y: 0 }, agentRef: { source: 'builtin', id: 'drawing-agent' } },
        { id: 'output', type: 'output', name: '输出', position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'input', target: 'draw', kind: 'flow' },
        { id: 'e2', source: 'draw', target: 'output', kind: 'flow' },
      ],
      scopedAgents: [],
    }, [], []);
    assert.ok(compiled.issues.some((issue) => issue.code === 'specialist-unavailable'));
    assert.equal(compiled.plan.steps.length, 0);
  });
});

test('orchestrator executes a snapshotted drawing Agent as a real workflow step', async () => {
  const originalFetch = globalThis.fetch;
  await withEnvironment({ DMX_API_KEY: 'image-key', DMX_BASE_URL: 'https://image.example/v1', DMX_MODEL: 'image-model' }, async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/workflow.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    const memory: AgentMemory = {
      async recall() {
        return {
          context: '', itemCount: 0, available: false, items: [],
          quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } },
        };
      },
      async capture(task) {
        return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' };
      },
    };
    let synthesisInput = '';
    const model: ModelClient = {
      model: 'text-model',
      async complete(request) {
        synthesisInput = request.user;
        await request.onDelta?.({ content: '最终绘图结果' });
        return { content: '最终绘图结果', attempts: 1, durationMs: 1 };
      },
    };
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', title: '绘图工作流', input: '生成一张未来城市图片', mode: 'build',
        plan: {
          summary: '绘图', routingReason: '手动工作流', approvalStatus: 'approved',
          profile: { kind: 'creative', difficulty: 'moderate', route: 'full-workflow', score: 60, reasons: ['manual'], maxSteps: 1, requiresReview: false },
          steps: [{
            id: 'draw', title: '绘图 Agent', role: 'drawing-agent', objective: '生成图片', dependsOn: [], acceptanceCriteria: ['返回图片'],
            failureStrategy: 'retry', maxDurationMs: 600_000,
            agentContract: { source: 'builtin', agentId: 'drawing-agent', displayName: '绘图 Agent', toolAllowlist: [] },
          }],
        },
      });
      const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' })).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed', result.error);
      assert.match(result.stepResults[0]?.output ?? '', /https:\/\/cdn\.example\/workflow\.png/);
      assert.match(synthesisInput, /https:\/\/cdn\.example\/workflow\.png/);
      const events = await store.getEvents(task.id);
      assert.ok(events.some((event) => event.type === 'agent.completed' && event.payload.serviceAgent === 'drawing-agent'));
      assert.ok(events.some((event) => event.type === 'model.completed' && event.payload.serviceAgent === 'drawing-agent'));
    } finally {
      await store.close();
      globalThis.fetch = originalFetch;
    }
  });
});
