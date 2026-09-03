import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import pino from 'pino';
import { createBusinessCapabilityApi } from './businessCapabilities.js';
import { SqliteBusinessCapabilityStore } from './businessCapabilityStore.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { SqliteArtifactCatalog } from './artifactCatalog.js';
import { EventHub } from './eventHub.js';
import { WorkflowOrchestrator } from './orchestrator.js';
import { TencentMemoryClient, type AgentMemory } from './memoryClient.js';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';
import { ToolRegistry } from './toolRegistry.js';
import { signPrincipal } from './principal.js';

const principalSecret = 'business-capability-test-secret-32-bytes';
let previousPrincipalSecret: string | undefined;

before(() => {
  previousPrincipalSecret = process.env.AXIOM_PRINCIPAL_SECRET;
  process.env.AXIOM_PRINCIPAL_SECRET = principalSecret;
});

after(() => {
  if (previousPrincipalSecret === undefined) delete process.env.AXIOM_PRINCIPAL_SECRET;
  else process.env.AXIOM_PRINCIPAL_SECRET = previousPrincipalSecret;
});

const headers = (tenantId: string, userId: string, role: 'owner' | 'admin' | 'member' | 'viewer' = 'member') => {
  const signed = signPrincipal({ tenantId, userId, role }, principalSecret);
  const separator = signed.indexOf('.');
  return {
    'content-type': 'application/json',
    'x-axiom-principal': signed.slice(0, separator),
    'x-axiom-principal-signature': signed.slice(separator + 1),
  };
};

const json = async <T>(response: Response) => await response.json() as T;

const createHarness = async (options: Parameters<typeof createBusinessCapabilityApi>[0] extends infer T
  ? Partial<Omit<T & object, 'records' | 'tasks' | 'coordinator'>> : never = {}) => {
  const records = new SqliteBusinessCapabilityStore(':memory:');
  const tasks = new SqliteTaskStore(':memory:');
  await records.initialize();
  await tasks.initialize();
  let nudges = 0;
  const api = createBusinessCapabilityApi({
    records,
    tasks,
    coordinator: { nudge() { nudges += 1; }, abort() {}, pauseStep() { return false; } } as never,
    ...options,
  });
  const request = (path: string, init?: RequestInit) => api.request(new Request(`http://business.test${path}`, init));
  return { records, tasks, api, request, nudges: () => nudges };
};

test('project collaboration persists members, tasks, mentions, review decisions, and complete export', async () => {
  const harness = await createHarness();
  const ownerHeaders = headers('tenant-project', 'owner', 'owner');
  const reviewerHeaders = headers('tenant-project', 'reviewer');
  try {
    const createdResponse = await harness.request('/projects', {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ name: '发布项目', goal: '形成可验收交付', acceptanceCriteria: ['证据可追溯'], strategy: '先验证再交付' }),
    });
    assert.equal(createdResponse.status, 201);
    let project = (await json<{ project: { id: string; revision: number } }>(createdResponse)).project;

    const memberResponse = await harness.request(`/projects/${project.id}/members`, {
      method: 'PUT', headers: ownerHeaders,
      body: JSON.stringify({ userId: 'reviewer', role: 'reviewer', revision: project.revision }),
    });
    assert.equal(memberResponse.status, 200);
    project = (await json<{ project: { id: string; revision: number } }>(memberResponse)).project;

    const taskResponse = await harness.request(`/projects/${project.id}/tasks`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ title: '验证任务', input: '检查交付完整性', mode: 'analyze' }),
    });
    assert.equal(taskResponse.status, 201);
    const taskBody = await json<{ task: { id: string; input: string }; project: { revision: number } }>(taskResponse);
    project = { ...project, revision: taskBody.project.revision };
    assert.match(taskBody.task.input, new RegExp(`\\[项目ID:${project.id}\\]`));
    assert.match(taskBody.task.input, /证据可追溯/);
    assert.equal(harness.nudges(), 1);

    const commentResponse = await harness.request(`/projects/${project.id}/comments`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ body: '@reviewer 请审核本轮交付', targetType: 'task', targetId: taskBody.task.id }),
    });
    assert.equal(commentResponse.status, 201);
    const notificationResponse = await harness.request('/project-notifications', { headers: reviewerHeaders });
    const mentionNotifications = await json<{ notifications: Array<{ id: string; status: string; data: { type: string } }> }>(notificationResponse);
    assert.equal(mentionNotifications.notifications[0]?.data.type, 'mention');

    const invalidAssignment = await harness.request(`/projects/${project.id}/reviewers`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ reviewerId: 'reviewer', targetType: 'task', targetId: '00000000-0000-4000-8000-000000000000', note: '无效目标' }),
    });
    assert.equal(invalidAssignment.status, 404);

    const assignmentResponse = await harness.request(`/projects/${project.id}/reviewers`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ reviewerId: 'reviewer', targetType: 'task', targetId: taskBody.task.id, note: '检查证据边界' }),
    });
    assert.equal(assignmentResponse.status, 201);
    const assignment = (await json<{ assignment: { id: string; revision: number } }>(assignmentResponse)).assignment;

    const decisionResponse = await harness.request(`/projects/${project.id}/reviewers/${assignment.id}/decision`, {
      method: 'POST', headers: reviewerHeaders,
      body: JSON.stringify({ revision: assignment.revision, decision: 'approved', note: '证据和验收条件一致。' }),
    });
    assert.equal(decisionResponse.status, 200);
    assert.equal((await json<{ assignment: { status: string } }>(decisionResponse)).assignment.status, 'approved');

    const exportResponse = await harness.request(`/projects/${project.id}/export`, { headers: ownerHeaders });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('content-disposition') ?? '', /attachment/);
    const exported = await json<{ schemaVersion: number; tasks: unknown[]; comments: unknown[]; reviewAssignments: Array<{ status: string }>; resourceManifest: { task: string[] } }>(exportResponse);
    assert.equal(exported.schemaVersion, 2);
    assert.equal(exported.tasks.length, 1);
    assert.equal(exported.comments.length, 1);
    assert.equal(exported.reviewAssignments[0]?.status, 'approved');
    assert.deepEqual(exported.resourceManifest.task, [taskBody.task.id]);
  } finally {
    await harness.records.close();
    await harness.tasks.close();
  }
});

test('project roles are enforced and archived projects become consistently read-only', async () => {
  const harness = await createHarness();
  const tenantId = 'tenant-project-roles';
  const ownerHeaders = headers(tenantId, 'owner', 'owner');
  const editorHeaders = headers(tenantId, 'editor');
  const reviewerHeaders = headers(tenantId, 'reviewer');
  const viewerHeaders = headers(tenantId, 'viewer');
  try {
    const created = await harness.request('/projects', {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ name: '权限项目', goal: '验证角色和归档边界', acceptanceCriteria: [], strategy: '' }),
    });
    let project = (await json<{ project: { id: string; revision: number } }>(created)).project;
    for (const [userId, role] of [['editor', 'editor'], ['reviewer', 'reviewer'], ['viewer', 'viewer']] as const) {
      const response = await harness.request(`/projects/${project.id}/members`, {
        method: 'PUT', headers: ownerHeaders,
        body: JSON.stringify({ userId, role, revision: project.revision }),
      });
      assert.equal(response.status, 200);
      project = (await json<{ project: { id: string; revision: number } }>(response)).project;
    }

    assert.equal((await harness.request(`/projects/${project.id}`, { headers: viewerHeaders })).status, 200);
    assert.equal((await harness.request(`/projects/${project.id}/comments`, {
      method: 'POST', headers: viewerHeaders, body: JSON.stringify({ body: '只读用户不应写入', targetType: 'project' }),
    })).status, 403);
    assert.equal((await harness.request(`/projects/${project.id}/members`, {
      method: 'PUT', headers: editorHeaders, body: JSON.stringify({ userId: 'other', role: 'viewer', revision: project.revision }),
    })).status, 403);
    assert.equal((await harness.request(`/projects/${project.id}/comments`, {
      method: 'POST', headers: reviewerHeaders, body: JSON.stringify({ body: '审核意见', targetType: 'project' }),
    })).status, 201);

    const taskResponse = await harness.request(`/projects/${project.id}/tasks`, {
      method: 'POST', headers: editorHeaders,
      body: JSON.stringify({ title: '编辑者任务', input: '验证可编辑权限', mode: 'analyze' }),
    });
    assert.equal(taskResponse.status, 201);
    const taskBody = await json<{ task: { id: string }; project: { id: string; revision: number } }>(taskResponse);
    project = taskBody.project;
    assert.equal((await harness.request(`/projects/${project.id}/tasks`, {
      method: 'POST', headers: reviewerHeaders,
      body: JSON.stringify({ title: '越权任务', input: '不应创建', mode: 'analyze' }),
    })).status, 404);

    const decisionResponse = await harness.request(`/projects/${project.id}/decisions`, {
      method: 'POST', headers: editorHeaders,
      body: JSON.stringify({ title: '采用方案', decision: '使用受控发布', rationale: '降低风险' }),
    });
    assert.equal(decisionResponse.status, 201);
    let decision = (await json<{ decision: { id: string; revision: number; status: string } }>(decisionResponse)).decision;
    const acceptedResponse = await harness.request(`/projects/${project.id}/decisions/${decision.id}`, {
      method: 'PATCH', headers: editorHeaders,
      body: JSON.stringify({ revision: decision.revision, status: 'accepted' }),
    });
    assert.equal(acceptedResponse.status, 200);
    decision = (await json<{ decision: { id: string; revision: number; status: string } }>(acceptedResponse)).decision;
    assert.equal(decision.status, 'accepted');

    const assignmentResponse = await harness.request(`/projects/${project.id}/reviewers`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ reviewerId: 'reviewer', targetType: 'task', targetId: taskBody.task.id, note: '归档前分配' }),
    });
    assert.equal(assignmentResponse.status, 201);
    const assignment = (await json<{ assignment: { id: string; revision: number } }>(assignmentResponse)).assignment;

    const archiveResponse = await harness.request(`/projects/${project.id}/archive`, {
      method: 'POST', headers: ownerHeaders, body: JSON.stringify({ revision: project.revision }),
    });
    assert.equal(archiveResponse.status, 200);
    project = (await json<{ project: { id: string; revision: number } }>(archiveResponse)).project;

    const archivedWrites: Array<[string, string, HeadersInit, unknown]> = [
      [`/projects/${project.id}`, 'PATCH', editorHeaders, { revision: project.revision, goal: '不应修改' }],
      [`/projects/${project.id}/members`, 'PUT', ownerHeaders, { userId: 'new-user', role: 'viewer', revision: project.revision }],
      [`/projects/${project.id}/resources`, 'POST', ownerHeaders, { resourceType: 'task', resourceId: taskBody.task.id, revision: project.revision }],
      [`/projects/${project.id}/tasks`, 'POST', editorHeaders, { title: '归档任务', input: '不应创建', mode: 'analyze' }],
      [`/projects/${project.id}/comments`, 'POST', reviewerHeaders, { body: '归档后评论', targetType: 'project' }],
      [`/projects/${project.id}/decisions`, 'POST', editorHeaders, { title: '归档决策', decision: '不应创建', rationale: '' }],
      [`/projects/${project.id}/decisions/${decision.id}`, 'PATCH', editorHeaders, { revision: decision.revision, status: 'superseded' }],
      [`/projects/${project.id}/reviewers`, 'POST', ownerHeaders, { reviewerId: 'reviewer', targetType: 'task', targetId: taskBody.task.id, note: '' }],
      [`/projects/${project.id}/reviewers/${assignment.id}/decision`, 'POST', reviewerHeaders, { revision: assignment.revision, decision: 'approved', note: '不应提交' }],
    ];
    for (const [path, method, requestHeaders, body] of archivedWrites) {
      const response = await harness.request(path, { method, headers: requestHeaders, body: JSON.stringify(body) });
      assert.equal(response.status, 409, `${method} ${path} should reject archived project writes`);
      assert.match((await json<{ error: string }>(response)).error, /已归档/);
    }
    assert.equal((await harness.request(`/projects/${project.id}/export`, { headers: viewerHeaders })).status, 200);
  } finally {
    await harness.records.close();
    await harness.tasks.close();
  }
});

test('managed memories report honest local degradation and persist MemoryCore sync outcomes', async () => {
  const localHarness = await createHarness();
  const ownerHeaders = headers('tenant-memory', 'memory-owner', 'owner');
  try {
    const localResponse = await localHarness.request('/memories', {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ content: '用户偏好结构化结论。', source: '人工录入', layer: 'L0', confidence: 0.9, scope: 'user', enabled: true }),
    });
    assert.equal(localResponse.status, 201);
    const localMemory = (await json<{ memory: { id: string; revision: number; data: { syncState: string; syncMessage: string } } }>(localResponse)).memory;
    assert.equal(localMemory.data.syncState, 'local-policy');
    assert.match(localMemory.data.syncMessage, /未配置/);
    const disabled = await localHarness.request(`/memories/${localMemory.id}`, {
      method: 'PATCH', headers: ownerHeaders,
      body: JSON.stringify({ revision: localMemory.revision, enabled: false }),
    });
    assert.equal((await json<{ memory: { status: string } }>(disabled)).memory.status, 'disabled');
  } finally {
    await localHarness.records.close();
    await localHarness.tasks.close();
  }

  const requestedPaths: string[] = [];
  const memory = new TencentMemoryClient({
    endpoint: 'https://memory.test',
    fetcher: (async (input) => {
      const path = new URL(String(input)).pathname;
      requestedPaths.push(path);
      const data = path.endsWith('/conversation/add')
        ? { accepted_ids: ['message-1'], accepted_versions: ['v1'], total_count: 1 }
        : path.endsWith('/scenario/write') ? { path: 'axiom/manual/test.md', version: 'v2', updated_at: new Date().toISOString() }
          : path.endsWith('/scenario/rm') ? {}
            : { version: 'v3', updated_at: new Date().toISOString() };
      return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const remoteHarness = await createHarness({ memory });
  try {
    const l1Response = await remoteHarness.request('/memories', {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ content: '记住已确认的项目约束。', source: '项目复盘', layer: 'L1', confidence: 0.85, scope: 'user', enabled: true }),
    });
    assert.equal(l1Response.status, 201);
    const l1 = (await json<{ memory: { id: string; data: { syncState: string; remoteIds: string[] } } }>(l1Response)).memory;
    assert.equal(l1.data.syncState, 'pending-extraction');
    assert.deepEqual(l1.data.remoteIds, ['message-1']);
    assert.ok(requestedPaths.includes('/v3/conversation/add'));

    const l3Response = await remoteHarness.request('/memories', {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ content: '核心协作原则。', source: '负责人', layer: 'L3', confidence: 1, scope: 'user', enabled: true }),
    });
    const l3 = (await json<{ memory: { id: string; data: { syncState: string } } }>(l3Response)).memory;
    assert.equal(l3.data.syncState, 'synced');
    const l3Delete = await remoteHarness.request(`/memories/${l3.id}`, { method: 'DELETE', headers: ownerHeaders });
    assert.equal(l3Delete.status, 409);
    assert.match((await json<{ error: string }>(l3Delete)).error, /没有独立删除协议/);
  } finally {
    await remoteHarness.records.close();
    await remoteHarness.tasks.close();
  }
});

const listen = async (server: Server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务没有获得端口。');
  return `http://127.0.0.1:${address.port}`;
};

test('OpenAPI and MCP tools validate, pin, authorize, approve, audit, and preserve Artifact lineage', async () => {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const external = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    calls.push({ method: request.method ?? '', url: request.url ?? '', body });
    if (request.url === '/mcp') {
      const rpc = JSON.parse(body) as { id?: string; method?: string };
      response.setHeader('content-type', 'application/json');
      response.setHeader('mcp-session-id', 'mcp-session-test');
      if (rpc.method === 'notifications/initialized') { response.statusCode = 202; response.end(); return; }
      const result = rpc.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } }
        : rpc.method === 'tools/list'
          ? { tools: [{ name: 'lookup.weather', description: '查询天气', inputSchema: { type: 'object', properties: { city: { type: 'string', maxLength: 40 } }, required: ['city'], additionalProperties: false } }] }
          : { content: [{ type: 'text', text: '上海 25°C' }] };
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, method: request.method, path: request.url, body: body ? JSON.parse(body) : null }));
  });
  const endpoint = await listen(external);
  const catalog = new SqliteArtifactCatalog(':memory:');
  await catalog.initialize();
  const artifactContent = new Map<string, string>();
  const artifactStore = {
    kind: 'filesystem' as const,
    async put(id: string, content: string, tenantId?: string) { artifactContent.set(`${tenantId}:${id}`, content); return { key: id, bytes: Buffer.byteLength(content) }; },
    async get(id: string, tenantId?: string) { return artifactContent.get(`${tenantId}:${id}`) ?? null; },
    async delete(id: string, tenantId?: string) { artifactContent.delete(`${tenantId}:${id}`); },
    async health() { return { configured: true, reachable: true, detail: 'test' }; },
  };
  const tools = new ToolRegistry(undefined, artifactStore, null, catalog);
  const harness = await createHarness({ tools, artifacts: artifactStore, artifactCatalog: catalog });
  const ownerHeaders = headers('tenant-tools', 'tool-owner', 'owner');
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  try {
    const openApiResponse = await harness.request('/tool-sources', {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({
        name: '本地订单服务', protocol: 'openapi', location: 'local', version: '1.0.0', enabled: true, allowedAgentIds: ['builder'],
        specification: {
          openapi: '3.1.0', servers: [{ url: endpoint }], paths: {
            '/items/{id}': { get: { operationId: 'read.item', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', maxLength: 20 } }] } },
            '/items': { post: { operationId: 'create.item', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', maxLength: 30 } }, required: ['name'], additionalProperties: false } } } } } },
          },
        },
      }),
    });
    assert.equal(openApiResponse.status, 201);
    const source = (await json<{ source: { id: string; data: { registeredToolNames: string[]; operationRisks: Record<string, string>; healthStatus: string; categories: string[]; capabilityTags: string[]; riskLevel: string; authorizationStatus: string } } }>(openApiResponse)).source;
    assert.equal(source.data.registeredToolNames.length, 2);
    assert.equal(source.data.operationRisks['create.item'], 'high');
    assert.equal(source.data.healthStatus, 'healthy');
    assert.equal(source.data.authorizationStatus, 'not-required');
    assert.equal(source.data.riskLevel, 'high');
    assert.ok(source.data.categories.includes('custom'));
    assert.ok(source.data.registeredToolNames.every((name) => tools.catalog().some((tool) => tool.name === name)));

    const badArgs = await harness.request(`/tool-sources/${source.id}/call`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ operationId: 'read.item', agentId: 'builder', args: {} }),
    });
    assert.equal(badArgs.status, 502);
    assert.match((await json<{ error: string }>(badArgs)).error, /id不能为空/);

    const foreignTask = await harness.tasks.createTask({ tenantId: 'tenant-other', userId: 'other', sessionId: 'other', title: '其他任务', input: 'x', mode: 'analyze' });
    const foreignLineage = await harness.request(`/tool-sources/${source.id}/call`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ operationId: 'read.item', agentId: 'builder', taskId: foreignTask.id, args: { id: '1' } }),
    });
    assert.equal(foreignLineage.status, 404);

    const approvalRequested = await harness.request(`/tool-sources/${source.id}/call`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ operationId: 'create.item', agentId: 'builder', args: { body: { name: 'Axiom' } } }),
    });
    assert.equal(approvalRequested.status, 202);
    const approval = (await json<{ approval: { id: string; revision: number } }>(approvalRequested)).approval;
    const approvalList = await harness.request(`/tool-sources/${source.id}/approvals`, { headers: ownerHeaders });
    assert.equal((await json<{ approvals: unknown[] }>(approvalList)).approvals.length, 1);
    const approved = await harness.request(`/tool-sources/${source.id}/approvals/${approval.id}`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ approved: true, revision: approval.revision, note: '允许创建测试记录' }),
    });
    assert.equal(approved.status, 200);
    const callResponse = await harness.request(`/tool-sources/${source.id}/call`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ operationId: 'create.item', agentId: 'builder', approvalId: approval.id, args: { body: { name: 'Axiom' } } }),
    });
    assert.equal(callResponse.status, 200);
    const callResult = await json<{ artifactId: string; receiptId: string }>(callResponse);
    assert.ok(await catalog.get('tenant-tools', callResult.artifactId));
    assert.ok(calls.some((call) => call.method === 'POST' && call.url === '/items'));

    const runtimeToolName = source.data.registeredToolNames.find((name) => name.endsWith('read_item'))!;
    assert.ok(runtimeToolName);
    const runtimeMemory: AgentMemory = {
      async recall() {
        return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } };
      },
      async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
    };
    const runtimeModel: ModelClient = {
      model: 'dynamic-tool-integration-model',
      async complete(request: ModelCompletionRequest) {
        let content = '';
        if (request.system.includes('builder finalizing')) {
          content = JSON.stringify({
            output: '已通过动态 OpenAPI 工具读取目标记录。',
            evidence: [{ claim: '目标记录由工具返回。', kind: 'tool-result', source: 'tool audit', verification: 'verified', confidence: .95 }],
            confidence: .95,
            toolCalls: [],
          });
        } else if (request.system.includes('You are a builder sub-agent')) {
          const functionName = request.tools?.find((tool) => tool.function.name.includes('read_item'))?.function.name;
          assert.ok(functionName, 'dynamic tool must be exposed to the model as a native function');
          return { content: '', toolCalls: [{ id: 'dynamic-read-1', name: functionName, args: { id: 'runtime' } }], attempts: 1, durationMs: 1 };
        } else if (request.system.includes('independent reviewer')) {
          content = JSON.stringify({ approved: true, score: 96, summary: '动态工具结果已进入证据链。', gaps: [], requiredCorrections: [] });
        } else if (request.system.includes('synthesizer')) {
          content = '动态 OpenAPI 工具主执行链已完成。';
        } else {
          content = JSON.stringify({ output: '完成。', evidence: [], confidence: .9, toolCalls: [] });
        }
        await request.onDelta?.({ content });
        return { content, attempts: 1, durationMs: 1 };
      },
    };
    const runtimeTask = await harness.tasks.createTask({
      tenantId: 'tenant-tools', userId: 'tool-owner', sessionId: 'dynamic-tools', title: '动态工具主链', input: '读取目标记录并形成可验证结论。', mode: 'analyze',
      plan: {
        summary: '调用租户导入的 OpenAPI 工具。', routingReason: '任务需要外部记录。',
        profile: { kind: 'research', difficulty: 'moderate', route: 'team', score: 2, reasons: ['external tool'], maxSteps: 1, requiresReview: false },
        steps: [{ id: 'dynamic-read', title: '读取外部记录', role: 'builder', objective: '读取 runtime 记录。', dependsOn: [], acceptanceCriteria: ['工具结果可审计'], toolNames: [runtimeToolName], failureStrategy: 'retry' }],
        version: 1, approvalStatus: 'approved',
      },
    });
    const runtimeResult = await new WorkflowOrchestrator(harness.tasks, new EventHub(), runtimeModel, runtimeMemory, pino({ level: 'silent' }), tools)
      .run(runtimeTask, new AbortController().signal);
    assert.equal(runtimeResult.status, 'completed', runtimeResult.error);
    assert.ok(calls.some((call) => call.method === 'GET' && call.url === '/items/runtime'));
    assert.ok(runtimeResult.stepResults.some((step) => step.toolCalls?.some((call) => call.name === runtimeToolName)));
    const runtimeEvents = await harness.tasks.getEvents(runtimeTask.id);
    assert.ok(runtimeEvents.some((event) => event.type === 'tool.completed' && event.payload.name === runtimeToolName));
    assert.ok(runtimeEvents.some((event) => event.type === 'artifact.created' && (event.payload.lineage as { toolCallId?: string } | undefined)?.toolCallId));

    const mcpResponse = await harness.request('/tool-sources', {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ name: '本地 MCP', protocol: 'mcp', location: 'local', version: '2025-03-26', enabled: true, allowedAgentIds: [], specification: { endpoint: `${endpoint}/mcp` } }),
    });
    assert.equal(mcpResponse.status, 201);
    const mcpSource = (await json<{ source: { id: string; data: { registeredToolNames: string[] } } }>(mcpResponse)).source;
    assert.equal(mcpSource.data.registeredToolNames.length, 1);
    const mcpCall = await harness.request(`/tool-sources/${mcpSource.id}/call`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ operationId: 'lookup.weather', agentId: 'searcher', args: { city: '上海' } }),
    });
    assert.equal(mcpCall.status, 200);
    assert.ok(calls.filter((call) => call.url === '/mcp').length >= 4);
    const sourceList = await harness.request('/tool-sources', { headers: ownerHeaders });
    const listedSources = (await json<{ sources: Array<{ id: string; data: { usageCount: number; successRate: number } }> }>(sourceList)).sources;
    const usedSource = listedSources.find((item) => item.id === source.id);
    assert.ok((usedSource?.data.usageCount ?? 0) >= 2);
    assert.ok((usedSource?.data.successRate ?? 0) > 0.5 && (usedSource?.data.successRate ?? 1) < 1);

    const pendingAuthResponse = await harness.request('/tool-sources', {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({
        name: '待授权天气 MCP', protocol: 'mcp', location: 'local', version: '2025-03-26', enabled: true,
        authType: 'api-key', description: '查询天气', categories: ['research'], capabilityTags: ['天气'], visibility: 'private', riskLevel: 'low', allowedAgentIds: [],
        specification: { endpoint: `${endpoint}/mcp`, tools: [{ name: 'lookup.weather', description: '查询天气', inputSchema: { type: 'object' } }] },
      }),
    });
    assert.equal(pendingAuthResponse.status, 201);
    const pendingAuth = await json<{ source: { status: string; data: { authorizationStatus: string; registeredToolNames: string[] } } }>(pendingAuthResponse);
    assert.equal(pendingAuth.source.status, 'disabled');
    assert.equal(pendingAuth.source.data.authorizationStatus, 'pending');
    assert.equal(pendingAuth.source.data.registeredToolNames.length, 1);
  } finally {
    if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
    else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
    external.close();
    await once(external, 'close');
    await catalog.close();
    await harness.records.close();
    await harness.tasks.close();
  }
});

test('post-delivery actions are durable and idempotent while feedback informs model selection', async () => {
  let scheduleCalls = 0;
  let notificationCalls = 0;
  const harness = await createHarness({
    createSchedule: async (input) => { scheduleCalls += 1; return { id: `schedule-${scheduleCalls}`, runAt: input.runAt }; },
    sendNotification: async () => { notificationCalls += 1; return { deliveryIds: [`delivery-${notificationCalls}`] }; },
  });
  const ownerHeaders = headers('tenant-actions', 'task-owner', 'owner');
  try {
    const task = await harness.tasks.createTask({ tenantId: 'tenant-actions', userId: 'task-owner', sessionId: 'session-actions', title: '完成的任务', input: '形成报告', mode: 'analyze', model: 'quality-model' });
    await harness.tasks.updateTask(task.id, { status: 'completed', result: '可交付结果' });
    const payload = { action: 'create-schedule', idempotencyKey: 'schedule-idempotency-0001', schedule: { runAt: new Date(Date.now() + 86_400_000).toISOString() } };
    const first = await harness.request(`/tasks/${task.id}/actions`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(payload) });
    const second = await harness.request(`/tasks/${task.id}/actions`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(payload) });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal((await json<{ idempotent: boolean }>(second)).idempotent, true);
    assert.equal(scheduleCalls, 1);

    const notify = await harness.request(`/tasks/${task.id}/actions`, {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ action: 'send-notification', idempotencyKey: 'notify-idempotency-0001', instruction: '任务已完成。' }),
    });
    assert.equal(notify.status, 201);
    assert.equal(notificationCalls, 1);

    const feedback = await harness.request('/feedback', {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ taskId: task.id, score: 2, issueTypes: ['routing', 'evidence'], note: '路由不准确', evidenceCorrections: [{ evidenceId: 'e-1', correction: '来源时间不匹配' }], revisedAnswer: '修订后的答案' }),
    });
    assert.equal(feedback.status, 201);
    const metrics = await harness.request('/feedback/metrics', { headers: ownerHeaders });
    const metricBody = await json<{ count: number; averageScore: number; issueCounts: Record<string, number>; byModel: Record<string, { averageScore: number }> }>(metrics);
    assert.equal(metricBody.count, 1);
    assert.equal(metricBody.averageScore, 2);
    assert.equal(metricBody.issueCounts.routing, 1);
    assert.equal(metricBody.byModel['quality-model']?.averageScore, 2);

    const estimate = await harness.request('/estimate', {
      method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ input: '比较 PostgreSQL 与 SQLite 并形成迁移建议', mode: 'analyze' }),
    });
    const estimateBody = await json<{ confidence: string; durationMs: { low: number; likely: number; high: number }; basis: string }>(estimate);
    assert.equal(estimateBody.confidence, 'low');
    assert.ok(estimateBody.durationMs.low <= estimateBody.durationMs.likely && estimateBody.durationMs.likely <= estimateBody.durationMs.high);
    assert.match(estimateBody.basis, /真实样本|同租户/);
  } finally {
    await harness.records.close();
    await harness.tasks.close();
  }
});
