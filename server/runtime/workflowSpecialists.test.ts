import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pino from 'pino';
import { compileAgentWorkflow } from './workflowCompiler.js';
import { executeWorkflowSpecialist, isWorkflowSpecialist, workflowSpecialistCatalog } from './workflowSpecialists.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { WorkflowOrchestrator } from './orchestrator.js';
import { EventHub } from './eventHub.js';
import type { AgentMemory } from './memoryClient.js';
import type { ModelClient } from './modelClient.js';
import { SqliteBusinessCapabilityStore } from './businessCapabilityStore.js';
import type { ArtifactStore } from './artifactStore.js';
import { nexusArtifactSetDigest, type NexusArtifactSnapshot } from './nexusArtifacts.js';
import { SqliteToolExecutionStore } from './toolExecutionStore.js';
import { ToolRegistry } from './toolRegistry.js';
import { summarizeExecutionQuality } from './executionQuality.js';

const envKeys = ['DMX_API_KEY', 'DMX_BASE_URL', 'DMX_MODEL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_API_BASE', 'DEEPSEEK_NATIVE_SEARCH_MODEL', 'DEEPSEEK_NATIVE_SEARCH', 'DEEPSEEK_VISION_API_KEY', 'DEEPSEEK_VISION_API_BASE', 'DEEPSEEK_VISION_MODEL', 'VIDEO_API_BASE', 'VIDEO_API_KEY', 'VIDEO_MODEL'] as const;

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
  assert.equal(isWorkflowSpecialist('vision-agent'), true);
  assert.equal(isWorkflowSpecialist('document-agent'), true);
  assert.equal(workflowSpecialistCatalog().some((agent) => agent.id === ('vision-agent' as never)), false);
});

test('vision specialist sends real image bytes as a multimodal model part', async () => {
  const originalFetch = globalThis.fetch;
  let userContent: unknown;
  await withEnvironment({ DEEPSEEK_VISION_API_KEY: 'vision-key', DEEPSEEK_VISION_API_BASE: 'https://vision.example/v1', DEEPSEEK_VISION_MODEL: 'vision-model' }, async () => {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> };
      userContent = body.messages[1]?.content;
      return new Response(JSON.stringify({ choices: [{ message: { content: '图中包含绿色圆形。' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const result = await executeWorkflowSpecialist('vision-agent', '分析图片', new AbortController().signal, [{
        artifactRecordId: 'record-image', artifactId: 'image', name: '参考图.png', mimeType: 'image/png', bytes: bytes.byteLength,
        digest: 'a'.repeat(64), storageEncoding: 'binary', content: bytes,
      }]);
      assert.equal(result.model, 'vision-model');
      assert.match(result.output, /绿色圆形/u);
      assert.ok(Array.isArray(userContent));
      assert.ok((userContent as Array<{ type?: string; image_url?: { url?: string } }>).some((part) => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,')));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('document specialist extracts text bytes and never injects base64 into the text model', async () => {
  let user = '';
  const model: ModelClient = {
    model: 'document-model',
    async complete(request) {
      user = request.user;
      return { content: '文档结论已提取。', attempts: 1, durationMs: 1 };
    },
  };
  const content = Buffer.from('# 采购报告\n预算为 120 万元。', 'utf8');
  const result = await executeWorkflowSpecialist('document-agent', '提取预算', new AbortController().signal, [{
    artifactRecordId: 'record-document', artifactId: 'document', name: '报告.md', mimeType: 'text/markdown', bytes: content.byteLength,
    digest: 'b'.repeat(64), storageEncoding: 'binary', content,
  }], model);
  assert.equal(result.model, 'document-model');
  assert.match(user, /预算为 120 万元/u);
  assert.doesNotMatch(user, /base64/u);
});

test('drawing specialist returns a renderable Markdown image from the configured provider', async () => {
  const originalFetch = globalThis.fetch;
  await withEnvironment({ DMX_API_KEY: 'image-key', DMX_BASE_URL: 'https://image.example/v1', DMX_MODEL: 'image-model' }, async () => {
    const store = new SqliteTaskStore(':memory:');
    const ledger = new SqliteToolExecutionStore(':memory:');
    await store.initialize();
    await ledger.initialize();
    const task = await store.createTask({ tenantId: 'media', userId: 'owner', sessionId: 'media-session', title: 'Image', input: 'Draw', mode: 'build' });
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://image.example/v1/images/generations');
      assert.match(String(init?.headers && JSON.stringify(init.headers)), /image-key/);
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/generated.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const result = await executeWorkflowSpecialist('drawing-agent', '雨夜未来城市', new AbortController().signal, [], undefined,
        { execution: { store: ledger, task, stepId: 'draw', invocationId: 'generation-1' } });
      assert.equal(result.model, 'image-model');
      assert.match(result.output, /!\[工作流生成图片 1\]\(https:\/\/cdn\.example\/generated\.png\)/);
    } finally {
      globalThis.fetch = originalFetch;
      await store.close();
      await ledger.close();
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

test('search specialist distinguishes a completed zero-result search from a transport failure', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ output_text: '', status: 'completed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await withEnvironment({ DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_NATIVE_SEARCH: 'true' }, async () => {
      const result = await executeWorkflowSpecialist('academic-search-agent', '检索一个非常冷门的主题', new AbortController().signal);
      assert.match(result.output, /正常结束，但没有找到可核验/);
      assert.equal(result.confidence, 0.2);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('workflow compilation retains implemented service Agents independently of global provider keys', async () => {
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
    assert.equal(compiled.issues.length, 0);
    assert.equal(compiled.plan.steps.length, 1);
    assert.equal(compiled.plan.steps[0]?.maxDurationMs, 600_000);
  });
});

test('orchestrator executes a snapshotted drawing Agent as a real workflow step', async () => {
  const originalFetch = globalThis.fetch;
  await withEnvironment({ DMX_API_KEY: 'image-key', DMX_BASE_URL: 'https://image.example/v1', DMX_MODEL: 'image-model' }, async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/workflow.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const store = new SqliteTaskStore(':memory:');
    const ledger = new SqliteToolExecutionStore(':memory:');
    await store.initialize();
    await ledger.initialize();
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
      const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }), new ToolRegistry(undefined, undefined, undefined, undefined, ledger)).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed', result.error);
      assert.match(result.stepResults[0]?.output ?? '', /https:\/\/cdn\.example\/workflow\.png/);
      assert.match(synthesisInput, /https:\/\/cdn\.example\/workflow\.png/);
      const events = await store.getEvents(task.id);
      assert.ok(events.some((event) => event.type === 'agent.completed' && event.payload.serviceAgent === 'drawing-agent'));
      assert.ok(events.some((event) => event.type === 'model.completed' && event.payload.serviceAgent === 'drawing-agent'));
    } finally {
      await store.close();
      await ledger.close();
      globalThis.fetch = originalFetch;
    }
  });
});

test('orchestrator loads only digest-verified Nexus attachments for a document Agent', async () => {
  const store = new SqliteTaskStore(':memory:');
  const business = new SqliteBusinessCapabilityStore(':memory:');
  await store.initialize();
  await business.initialize();
  const memory: AgentMemory = {
    async recall() { return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }; },
    async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
  };
  let documentInput = '';
  let modelCalls = 0;
  const model: ModelClient = {
    model: 'document-model',
    async complete(request) {
      modelCalls += 1;
      if (request.system.includes('文档分析 Agent')) {
        documentInput = request.user;
        return { content: '附件预算为 120 万元。', attempts: 1, durationMs: 1 };
      }
      const content = request.system.includes('synthesizer') ? '文档工作流完成。' : JSON.stringify({ approved: true, score: 95, summary: '通过', gaps: [], requiredCorrections: [] });
      await request.onDelta?.({ content });
      return { content, attempts: 1, durationMs: 1 };
    },
  };
  const binaries = new Map<string, Uint8Array>();
  const artifactStore: ArtifactStore = {
    kind: 'filesystem',
    async put(id, content, tenantId) { return { key: `${tenantId}:${id}.md`, bytes: Buffer.byteLength(content) }; },
    async get() { return null; },
    async putBinary(id, content, tenantId) { binaries.set(`${tenantId}:${id}`, Uint8Array.from(content)); return { key: `${id}.bin`, bytes: content.byteLength }; },
    async getBinary(id, tenantId) { return binaries.get(`${tenantId}:${id}`) ?? null; },
    async delete() {},
    async health() { return { configured: true, reachable: true, detail: 'test' }; },
  };
  const tenantId = 'tenant-document';
  const workflowId = randomUUID();
  const bytes = Buffer.from('# 财务报告\n预算为 120 万元。', 'utf8');
  const artifactId = `nexus:${workflowId}:report`;
  binaries.set(`${tenantId}:${artifactId}`, bytes);
  const artifactRecord = await business.create({
    tenantId, userId: 'owner', ownerId: 'owner', kind: 'nexus-artifact', status: 'active',
    data: { workflowId, workflowVersion: 1, artifactId, name: '财务报告.md', mimeType: 'text/markdown', bytes: bytes.byteLength, digest: createHash('sha256').update(bytes).digest('hex'), storageKey: `${artifactId}.bin`, storageEncoding: 'binary' },
  });
  const snapshot: NexusArtifactSnapshot = {
    artifactRecordId: artifactRecord.id, artifactId, name: '财务报告.md', mimeType: 'text/markdown', bytes: bytes.byteLength,
    digest: createHash('sha256').update(bytes).digest('hex'), storageKey: `${artifactId}.bin`, storageEncoding: 'binary',
  };
  try {
    const task = await store.createTask({
      tenantId, userId: 'owner', sessionId: `agent-nexus-test-${workflowId}`, templateId: workflowId,
      title: '文档分析', input: '提取预算', mode: 'analyze',
      plan: {
        summary: '分析附件', routingReason: '手动 Nexus', version: 1, approvalStatus: 'approved',
        profile: { kind: 'research', difficulty: 'moderate', route: 'full-workflow', score: 50, reasons: ['manual'], maxSteps: 1, requiresReview: false },
        steps: [{ id: 'document', title: '文档分析 Agent', role: 'document-agent', objective: '读取报告', dependsOn: [], acceptanceCriteria: ['提取预算'], failureStrategy: 'retry', agentContract: { source: 'builtin', agentId: 'document-agent', displayName: '文档分析 Agent', toolAllowlist: [] } }],
      },
    });
    await business.create({ tenantId, userId: 'owner', ownerId: 'owner', kind: 'nexus-test-run', status: 'running', data: { workflowId, workflowVersion: 1, taskId: task.id, artifacts: [snapshot], artifactSetDigest: nexusArtifactSetDigest([snapshot]) } });
    const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }), undefined, undefined, undefined, undefined, artifactStore, null, business)
      .run(task, new AbortController().signal);
    assert.equal(result.status, 'completed', result.error);
    assert.match(documentInput, /预算为 120 万元/u);
    assert.doesNotMatch(documentInput, /base64/u);

    const callsBeforeTamperedInput = modelCalls;
    binaries.set(`${tenantId}:${artifactId}`, Buffer.from('内容已被篡改', 'utf8'));
    const tamperedTask = await store.createTask({
      tenantId, userId: 'owner', sessionId: `agent-nexus-test-${workflowId}-tampered`, templateId: workflowId,
      title: '文档分析篡改检查', input: '提取预算', mode: 'analyze', plan: task.plan,
    });
    await business.create({ tenantId, userId: 'owner', ownerId: 'owner', kind: 'nexus-test-run', status: 'running', data: { workflowId, workflowVersion: 1, taskId: tamperedTask.id, artifacts: [snapshot], artifactSetDigest: nexusArtifactSetDigest([snapshot]) } });
    const tampered = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }), undefined, undefined, undefined, undefined, artifactStore, null, business)
      .run(tamperedTask, new AbortController().signal);
    assert.equal(tampered.status, 'failed');
    assert.match(tampered.error ?? '', /内容摘要校验失败/u);
    assert.equal(modelCalls, callsBeforeTamperedInput);
    const tamperedEvents = await store.getEvents(tampered.id);
    assert.equal(tamperedEvents.some((event) => event.type === 'model.failed' || event.type === 'model.completed'), false);
    assert.ok(tamperedEvents.some((event) => event.type === 'agent.failed' && event.payload.serviceAgent === 'document-agent'
      && event.payload.callKind === 'specialist-service' && event.payload.usageStatus === 'not-observed'));
    assert.equal(summarizeExecutionQuality(tampered, tamperedEvents).usage.calls, 0);
  } finally {
    await business.close();
    await store.close();
  }
});

test('specialist setup and transport failures remain observable without guessed model calls', async (t) => {
  const cases = [
    { name: 'missing image provider', agentId: 'drawing-agent', environment: {}, requests: 0, error: /绘图模型尚未配置/u },
    { name: 'missing document input', agentId: 'document-agent', environment: {}, requests: 0, error: /没有收到可解析/u },
    { name: 'search service rejects the request', agentId: 'search-agent', environment: { DEEPSEEK_API_KEY: 'fixture-search-key', DEEPSEEK_API_BASE: 'https://search.invalid' }, requests: 1, error: /搜索 Agent 请求失败 \(503\)/u },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    await withEnvironment(scenario.environment, async () => {
      const store = new SqliteTaskStore(':memory:');
      await store.initialize();
      const originalFetch = globalThis.fetch;
      let serviceRequests = 0;
      let modelCalls = 0;
      globalThis.fetch = async (input) => {
        serviceRequests += 1;
        assert.equal(String(input), 'https://search.invalid/responses');
        return new Response(JSON.stringify({ error: 'Fixture service unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      };
      const model: ModelClient = { model: 'unused-text-model', async complete() { modelCalls += 1; throw new Error('Unexpected text-model invocation'); } };
      const memory: AgentMemory = {
        async recall() { return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }; },
        async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
      };
      try {
        const task = await store.createTask({
          tenantId: 'specialist-failure', userId: 'owner', sessionId: randomUUID(), title: scenario.name, input: 'Inspect the requested material', mode: 'analyze',
          plan: { summary: 'One specialist step', routingReason: 'manual', approvalStatus: 'approved',
            profile: { kind: 'research', difficulty: 'moderate', route: 'full-workflow', score: 50, reasons: ['manual'], maxSteps: 1, requiresReview: false },
            steps: [{ id: 'specialist', title: scenario.name, role: scenario.agentId, objective: 'Inspect the material', dependsOn: [], acceptanceCriteria: ['Return findings'],
              agentContract: { source: 'builtin', agentId: scenario.agentId, displayName: scenario.name, toolAllowlist: [] } }],
          },
        });
        const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' })).run(task, new AbortController().signal);
        assert.equal(result.status, 'failed', result.error);
        assert.match(result.error ?? '', scenario.error);
        assert.equal(serviceRequests, scenario.requests);
        assert.equal(modelCalls, 0);
        const events = await store.getEvents(task.id);
        assert.equal(events.filter((event) => event.type === 'model.failed' || event.type === 'model.completed').length, 0);
        const failures = events.filter((event) => event.type === 'agent.failed');
        assert.equal(failures.length, 1);
        assert.equal(failures[0]?.payload.serviceAgent, scenario.agentId);
        assert.equal(failures[0]?.payload.callKind, 'specialist-service');
        assert.equal(failures[0]?.payload.usageStatus, 'not-observed');
        assert.equal('spanId' in failures[0]!.payload, false);
        const quality = summarizeExecutionQuality(result, events);
        assert.equal(quality.usage.calls, 0);
        assert.equal(quality.usage.totalTokens, null);
        assert.equal(quality.usage.usageStatus, 'not-observed');
      } finally {
        globalThis.fetch = originalFetch;
        await store.close();
      }
    });
  });
});
