import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { EventHub } from './eventHub.js';
import type { AgentMemory } from './memoryClient.js';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';
import type { AgentStore } from './contracts.js';
import { buildNativeToolAliasMap, classifyTask, WorkflowOrchestrator } from './orchestrator.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { ToolRegistry } from './toolRegistry.js';
import { ModelRoutingPolicy } from './modelRouting.js';

class FakeModel implements ModelClient {
  readonly model = 'fake-production-model';
  reviewCalls = 0;
  researcherCalls = 0;
  requestedModels: string[] = [];

  async complete(request: ModelCompletionRequest) {
    this.requestedModels.push(request.model ?? this.model);
    if (request.system.includes('You are a researcher')) {
      this.researcherCalls += 1;
      if (this.researcherCalls === 1) throw new Error('Temporary sub-agent failure.');
    }
    let content: string;
    if (request.system.includes('live directory snapshot')) {
      assert.match(request.system, /"id":"researcher"/);
      content = '实时目录显示研究员、分析员和工程师等内置角色；当前没有发布的自定义 Agent。';
    } else if (request.system.includes('conversational agent')) {
      content = '你好，我在。';
    } else if (request.system.includes('planner in a production')) {
      content = JSON.stringify({
        summary: 'Parallel evidence and analysis followed by validation.',
        routingReason: 'The first two steps are independent.',
        steps: [
          {
            id: 'evidence',
            title: 'Collect evidence',
            role: 'researcher',
            objective: 'Collect bounded evidence.',
            dependsOn: [],
            acceptanceCriteria: ['Evidence is explicit'],
          },
          {
            id: 'risks',
            title: 'Analyze risks',
            role: 'analyst',
            objective: 'Analyze operational risks.',
            dependsOn: [],
            acceptanceCriteria: ['Risks have mitigations'],
          },
        ],
      });
    } else if (request.system.includes('independent reviewer')) {
      this.reviewCalls += 1;
      content = this.reviewCalls === 1
        ? JSON.stringify({
            approved: true,
            score: 72,
            summary: 'The model claimed approval below the configured score gate.',
            gaps: [],
            requiredCorrections: [],
          })
        : JSON.stringify({
            approved: true,
            score: 94,
            summary: 'The correction closes the quality gap.',
            gaps: [],
            requiredCorrections: [],
          });
    } else if (request.system.includes('synthesizer')) {
      content = 'Validated final artifact.';
    } else {
      content = JSON.stringify({
        output: request.user.includes('Resolve these review findings')
          ? 'Added an executable verification step.'
          : 'Completed scoped sub-agent work.',
        evidence: ['Evidence is bounded to supplied context.'],
        confidence: 0.88,
      });
    }
    await request.onDelta?.({ content });
    return { content, attempts: 1, durationMs: 1 };
  }
}

class MinimalPlanModel extends FakeModel {
  async complete(request: ModelCompletionRequest) {
    if (!request.system.includes('planner in a production')) return super.complete(request);
    const content = JSON.stringify({
      summary: '先构建平台方案。',
      routingReason: '规划器只返回了一个步骤，运行时需要补齐系统设计角色。',
      steps: [{
        id: 'build-only',
        title: '形成平台方案',
        role: 'builder',
        objective: '形成一个可执行的平台方案。',
        dependsOn: [],
        acceptanceCriteria: ['方案可执行'],
      }],
    });
    await request.onDelta?.({ content });
    return { content, attempts: 1, durationMs: 1 };
  }
}

class ConditionalWorkflowModel extends FakeModel {
  async complete(request: ModelCompletionRequest) {
    if (request.system.includes('You are a analyst sub-agent') && request.user.includes('decide approval')) {
      const content = JSON.stringify({ output: 'approved', evidence: ['operator policy'], confidence: 0.9, toolCalls: [] });
      await request.onDelta?.({ content });
      return { content, attempts: 1, durationMs: 1 };
    }
    return super.complete(request);
  }
}

class PlannerPlaceholderModel extends FakeModel {
  async complete(request: ModelCompletionRequest) {
    if (!request.system.includes('planner in a production')) return super.complete(request);
    const content = JSON.stringify({
      summary: 'Run a bounded specialist step.',
      routingReason: 'The planner response includes a placeholder model that must be ignored.',
      steps: [{
        id: 'placeholder-step',
        title: 'Run specialist',
        role: 'researcher',
        objective: 'Return a bounded result.',
        dependsOn: [],
        acceptanceCriteria: ['The result is explicit'],
        model: 'optional-model',
      }],
    });
    await request.onDelta?.({ content });
    return { content, attempts: 1, durationMs: 1 };
  }
}

class UnsupportedStepModel extends FakeModel {
  attemptedModels: string[] = [];

  async complete(request: ModelCompletionRequest) {
    this.attemptedModels.push(request.model ?? this.model);
    if (request.model === 'unsupported-model') {
      const error = new Error('The supported API model names are fake-production-model, but you passed unsupported-model.') as Error & { status?: number };
      error.status = 400;
      throw error;
    }
    return super.complete(request);
  }
}

class ConflictModel implements ModelClient {
  readonly model = 'conflict-model';

  async complete(request: ModelCompletionRequest) {
    let content: string;
    if (request.system.includes('planner in a production')) {
      content = JSON.stringify({
        summary: 'Run two independent specialists and validate their conclusions.',
        routingReason: 'Independent conclusions require competitive validation.',
        steps: [
          { id: 'support', title: 'Assess support', role: 'researcher', objective: 'Assess whether the selected option is supported.', dependsOn: [], acceptanceCriteria: ['Conclusion is explicit'] },
          { id: 'challenge', title: 'Challenge support', role: 'analyst', objective: 'Challenge the selected option and identify failure cases.', dependsOn: [], acceptanceCriteria: ['Counter-conclusion is explicit'] },
        ],
      });
    } else if (request.system.includes('You are a researcher sub-agent')) {
      content = JSON.stringify({ output: '该方案支持 PostgreSQL，成功率约 90%。', evidence: ['support evidence'], confidence: 0.8, toolCalls: [] });
    } else if (request.system.includes('You are a analyst sub-agent')) {
      content = JSON.stringify({ output: '该方案不支持 PostgreSQL，成功率仅约 60%。', evidence: ['challenge evidence'], confidence: 0.75, toolCalls: [] });
    } else if (request.system.includes('independent reviewer')) {
      content = JSON.stringify({ approved: true, score: 92, summary: 'The conflict was surfaced for validation.', gaps: [], requiredCorrections: [] });
    } else if (request.system.includes('synthesizer')) {
      content = 'The final answer preserves the competing conclusions.';
    } else {
      content = JSON.stringify({ output: 'Completed.', evidence: [], confidence: 0.8, toolCalls: [] });
    }
    await request.onDelta?.({ content });
    return { content, attempts: 1, durationMs: 1 };
  }
}

class UnavailableConversationModel implements ModelClient {
  readonly model = 'unavailable-model';

  async complete(request: ModelCompletionRequest): Promise<never> {
    if (request.system.includes('conversational agent')) throw new TypeError('fetch failed');
    throw new Error('Unexpected non-conversational request.');
  }
}

class ToolApprovalModel implements ModelClient {
  readonly model = 'tool-approval-model';
  builderCalls = 0;

  async complete(request: ModelCompletionRequest) {
    let content: string;
    if (request.system.includes('planner in a production')) {
      content = JSON.stringify({
        summary: 'Build one bounded file change and verify it.',
        routingReason: 'The builder owns the approved workspace change.',
        steps: [{
          id: 'write-step',
          title: 'Write release note',
          role: 'builder',
          objective: 'Write a release note into the workspace.',
          dependsOn: [],
          acceptanceCriteria: ['The release note is written'],
        }],
      });
    } else if (request.system.includes('You are a builder sub-agent')) {
      this.builderCalls += 1;
      content = JSON.stringify({
        output: 'Prepare the release note.',
        evidence: [],
        confidence: 0.8,
        toolCalls: [{ name: 'workspace.write', args: { path: 'release.md', content: '# Release\n' } }],
      });
    } else if (request.system.includes('builder finalizing')) {
      content = JSON.stringify({ output: 'Release note was written and verified.', evidence: ['The approved write tool completed.'], confidence: 0.95, toolCalls: [] });
    } else if (request.system.includes('independent reviewer')) {
      content = JSON.stringify({ approved: true, score: 96, summary: 'The approved workspace change is complete.', gaps: [], requiredCorrections: [] });
    } else if (request.system.includes('synthesizer')) {
      content = 'Release note delivered.';
    } else {
      content = JSON.stringify({ output: 'Completed.', evidence: [], confidence: 0.8, toolCalls: [] });
    }
    await request.onDelta?.({ content });
    return { content, attempts: 1, durationMs: 1 };
  }
}

class NativeToolCallModel implements ModelClient {
  readonly model = 'native-tool-call-model';
  nativeToolNames: string[] = [];

  async complete(request: ModelCompletionRequest) {
    if (request.system.includes('planner in a production')) {
      const content = JSON.stringify({
        summary: 'Read one bounded workspace file and validate the result.',
        routingReason: 'The builder requires one read-only tool call.',
        steps: [{
          id: 'native-read',
          title: 'Read the workspace file',
          role: 'builder',
          objective: 'Read README.md and report the bounded result.',
          dependsOn: [],
          acceptanceCriteria: ['The file read is reported'],
        }],
      });
      await request.onDelta?.({ content });
      return { content, attempts: 1, durationMs: 1 };
    }
    if (request.system.includes('You are a builder sub-agent')) {
      this.nativeToolNames = (request.tools ?? []).map((tool) => tool.function.name);
      return {
        content: '',
        toolCalls: [{ id: 'native-read-1', name: 'axiom_workspace_read', args: { path: 'README.md' } }],
        attempts: 1,
        durationMs: 1,
      };
    }
    if (request.system.includes('independent reviewer')) {
      const content = JSON.stringify({ approved: true, score: 96, summary: 'The native tool call was executed and evidenced.', gaps: [], requiredCorrections: [] });
      await request.onDelta?.({ content });
      return { content, attempts: 1, durationMs: 1 };
    }
    const content = 'Native tool result delivered.';
    await request.onDelta?.({ content });
    return { content, attempts: 1, durationMs: 1 };
  }
}

class CustomRoleModel implements ModelClient {
  readonly model = 'custom-role-model';

  async complete(request: ModelCompletionRequest) {
    let content: string;
    if (request.system.includes('planner in a production')) {
      content = JSON.stringify({
        summary: 'Use the tenant custom data specialist, then synthesize the result.',
        routingReason: 'The published custom role matches the data comparison objective.',
        steps: [{
          id: 'data-review',
          title: 'Compare the supplied data',
          role: 'data-specialist',
          objective: 'Compare the supplied data and state bounded findings.',
          dependsOn: [],
          acceptanceCriteria: ['The comparison is explicit'],
        }],
      });
    } else if (request.system.includes('data-specialist sub-agent')) {
      assert.match(request.system, /Allowed step tools: workspace\.read/);
      content = JSON.stringify({
        output: 'The custom data specialist completed the comparison.',
        evidence: ['The published custom role contract was applied.'],
        confidence: 0.91,
        toolCalls: [
          { name: 'workspace.read', args: { path: 'README.md' } },
          { name: 'workspace.write', args: { path: 'blocked.txt', content: 'must not run' } },
        ],
      });
    } else if (request.system.includes('independent reviewer')) {
      content = JSON.stringify({ approved: true, score: 96, summary: 'Custom role output is sufficient.', gaps: [], requiredCorrections: [] });
    } else if (request.system.includes('synthesizer')) {
      content = 'Custom role result synthesized.';
    } else {
      content = JSON.stringify({ output: 'Completed.', evidence: [], confidence: 0.8, toolCalls: [] });
    }
    await request.onDelta?.({ content });
    return { content, attempts: 1, durationMs: 1 };
  }
}

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

const createTask = (store: SqliteTaskStore, title: string) => store.createTask({
  tenantId: 'tenant-a',
  userId: 'user-a',
  sessionId: 'session-a',
  title,
  input: 'Build and verify a production workflow.',
  mode: 'build',
});

describe('WorkflowOrchestrator', () => {
  test('builds protocol-safe native tool aliases without changing registry names', () => {
    const aliases = buildNativeToolAliasMap([
      'workspace.read',
      'workspace.search',
      'workspace.git-diff',
      'workspace.read',
    ]);
    assert.equal(aliases.actualToAlias.get('workspace.read'), 'axiom_workspace_read');
    assert.equal(aliases.aliasToActual.get('axiom_workspace_read'), 'workspace.read');
    assert.equal(aliases.actualToAlias.get('workspace.git-diff'), 'axiom_workspace_git-diff');
    for (const alias of aliases.actualToAlias.values()) {
      assert.match(alias, /^[a-zA-Z0-9_-]+$/);
      assert.ok(alias.length <= 64);
    }
  });

  test('executes the durable Router and Scheduler Agent plan without regex reclassification', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-router',
        userId: 'user-router',
        sessionId: 'session-router',
        title: 'scheduler-owned execution',
        input: 'A deliberately short input that regex triage would normally keep direct.',
        mode: 'build',
        plan: {
          summary: '调度 Agent 选择分析与实现。',
          routingReason: '本轮需要两个互补角色。',
          profile: { kind: 'implementation', difficulty: 'hard', route: 'team', score: 4, reasons: ['Router Agent decision'], maxSteps: 2, requiresReview: false },
          steps: [
            { id: 'architecture', title: '架构分析', role: 'analyst', objective: '形成架构边界。', dependsOn: [], acceptanceCriteria: ['边界明确'], skillIds: ['architecture-design'] },
            { id: 'implementation', title: '实现计划', role: 'builder', objective: '形成实现与测试步骤。', dependsOn: ['architecture'], acceptanceCriteria: ['步骤可执行'], skillIds: ['implementation'] },
          ],
          routingDecision: {
            intent: 'task', taskKind: 'implementation', difficulty: 'hard', requiresExternalFacts: false,
            requiredCapabilities: ['architecture', 'implementation'], candidateAgentIds: ['analyst', 'builder'], candidateSkillIds: ['architecture-design', 'implementation'], confidence: 0.94, rationale: '需要分析与实现。',
          },
          schedulingDecision: {
            route: 'team', activeAgentIds: ['analyst', 'builder'], skippedAgentIds: ['researcher'], appendAgentIds: ['analyst', 'builder'], selectedSkillIds: ['architecture-design', 'implementation'],
            executionWaves: [['architecture'], ['implementation']],
            steps: [
              { id: 'architecture', title: '架构分析', agentId: 'analyst', objective: '形成架构边界。', dependsOn: [], skillIds: ['architecture-design'] },
              { id: 'implementation', title: '实现计划', agentId: 'builder', objective: '形成实现与测试步骤。', dependsOn: ['architecture'], skillIds: ['implementation'] },
            ],
            requiresReview: false, synthesisAgentId: 'synthesizer', reason: '按依赖分两波执行。',
          },
          routingVersion: 'router-scheduler/v1',
          routerModel: 'route-model',
          routerConfidence: 0.94,
          version: 1,
          approvalStatus: 'approved',
        },
      });
      const orchestrator = new WorkflowOrchestrator(store, new EventHub(), new FakeModel(), memory, pino({ level: 'silent' }));
      const result = await orchestrator.run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.stepResults.filter((step) => !step.skipped).map((step) => step.role), ['analyst', 'builder']);
      const events = await store.getEvents(task.id);
      assert.ok(events.some((event) => event.type === 'routing.decided' && event.payload.confidence === 0.94));
      assert.ok(events.some((event) => event.type === 'scheduling.decided' && Array.isArray(event.payload.activeAgentIds)));
      assert.ok(events.some((event) => event.type === 'agent.skipped' && event.agentId === 'researcher'));
      assert.ok(events.some((event) => event.type === 'graph.extended'));
      assert.ok(events.some((event) => event.type === 'task.planning' && event.agentId === 'scheduler-agent'));
      assert.equal(events.some((event) => event.type === 'task.planning' && event.agentId === 'planner'), false);
    } finally {
      await store.close();
    }
  });

  test('maps a native DeepSeek tool alias back through the real Tool Registry', async () => {
    const store = new SqliteTaskStore(':memory:');
    const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
    process.env.AXIOM_TOOL_EXECUTOR = 'docker';
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'native tool alias workflow',
        input: 'Implement a complex production workflow with dependencies, recovery, acceptance, and multi-agent collaboration.',
        mode: 'build',
      });
      const model = new NativeToolCallModel();
      const tools = new ToolRegistry({
        execute: async () => ({ stdout: 'bounded README contents', stderr: '', exitCode: 0, durationMs: 1, auditId: 'native-tool' }),
      } as never);
      const orchestrator = new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }), tools);
      const result = await orchestrator.run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.ok(model.nativeToolNames.length > 0);
      assert.ok(model.nativeToolNames.every((name) => /^[a-zA-Z0-9_-]+$/.test(name)));
      const events = await store.getEvents(task.id);
      assert.ok(events.some((event) => event.type === 'tool.completed' && event.payload.name === 'workspace.read'));
      assert.ok(events.some((event) => event.type === 'memory.capture.started'));
      assert.ok(events.some((event) => event.type === 'memory.capture.skipped' && event.payload.reason === 'disabled'));
      assert.ok(result.stepResults.some((step) => step.toolCalls?.some((call) => call.name === 'workspace.read')));
    } finally {
      if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
      else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
      await store.close();
    }
  });

  test('triages Chinese requests by scope instead of forcing every task into direct mode', () => {
    const direct = classifyTask('有哪些子智能体', 'analyze');
    assert.equal(direct.route, 'direct');

    const system = classifyTask('分析数据库、队列、失败恢复、成本和验收标准', 'analyze');
    assert.notEqual(system.route, 'direct');
    assert.ok(['team', 'full-workflow'].includes(system.route));

    const workflow = classifyTask('实现复杂多 Agent 工作流，并明确依赖关系与可恢复 loop', 'build');
    assert.equal(workflow.route, 'full-workflow');
    assert.equal(workflow.requiresReview, true);

    const decision = classifyTask('Compare PostgreSQL and SQLite, then analyze risks and trade-offs for multi-worker deployment.', 'decide');
    assert.equal(decision.kind, 'decision');
    assert.equal(decision.route, 'team');
    assert.equal(decision.difficulty, 'moderate');

    const analyzedDecision = classifyTask('Compare PostgreSQL and SQLite for multi-worker deployment, including risks, cost, and recovery trade-offs.', 'analyze');
    assert.equal(analyzedDecision.kind, 'decision');
    assert.equal(analyzedDecision.route, 'team');
  });

  test('evaluates visual condition branches and persists skipped checkpoints', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({ tenantId: 'tenant-a', userId: 'user-a', sessionId: 'conditional-session', title: 'conditional workflow', input: 'run branch', mode: 'analyze' });
      const planned = await store.updateTask(task.id, {
        plan: {
          summary: 'conditional', routingReason: 'test', approvalStatus: 'approved',
          profile: { kind: 'operations', difficulty: 'moderate', route: 'team', score: 50, reasons: ['condition'], maxSteps: 3, requiresReview: false },
          steps: [
            { id: 'source', title: '审批判断', role: 'analyst', objective: 'decide approval', dependsOn: [], acceptanceCriteria: ['给出结果'] },
            { id: 'yes', title: '通过分支', role: 'builder', objective: '执行通过分支', dependsOn: ['source'], conditions: [{ sourceStepId: 'source', expression: 'contains("approved")', branch: 'true' }], acceptanceCriteria: ['完成'] },
            { id: 'no', title: '拒绝分支', role: 'builder', objective: '执行拒绝分支', dependsOn: ['source'], conditions: [{ sourceStepId: 'source', expression: 'contains("approved")', branch: 'false' }], acceptanceCriteria: ['完成'] },
          ],
        },
      });
      const result = await new WorkflowOrchestrator(store, new EventHub(), new ConditionalWorkflowModel(), memory, pino({ level: 'silent' })).run(planned, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.equal(result.stepResults.find((step) => step.stepId === 'yes')?.skipped, undefined);
      assert.equal(result.stepResults.find((step) => step.stepId === 'no')?.skipped, true);
      const events = await store.getEvents(task.id);
      assert.ok(events.some((event) => event.type === 'branch.selected' && event.payload.stepId === 'yes'));
      assert.ok(events.some((event) => event.type === 'branch.skipped' && event.payload.stepId === 'no'));
    } finally {
      await store.close();
    }
  });

  test('routes skills from the latest user turn without leaking earlier search context', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'latest-turn skill routing',
        input: 'USER:\n查询今天北京天气\n\nASSISTANT:\n天气信息已整理。\n\nUSER:\n设计一个平台，包含前端、后端和数据流',
        mode: 'analyze',
      });
      const result = await new WorkflowOrchestrator(
        store,
        new EventHub(),
        new FakeModel(),
        memory,
        pino({ level: 'silent' }),
      ).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      const spawned = (await store.getEvents(task.id))
        .filter((event) => event.type === 'agent.spawned' && event.agentId !== 'orchestrator');
      assert.ok(spawned.length >= 3, 'system design is covered by multiple Agents');
      for (const event of spawned) {
        const skillIds = Array.isArray(event.payload.skillIds) ? event.payload.skillIds : [];
        assert.equal(skillIds.includes('web-research'), false, `historical search skill leaked into ${event.agentId}`);
      }
    } finally {
      await store.close();
    }
  });

  test('adds architecture coverage when a system-design planner returns one Agent', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'system design coverage',
        input: '设计一个平台',
        mode: 'analyze',
      });
      const result = await new WorkflowOrchestrator(
        store,
        new EventHub(),
        new MinimalPlanModel(),
        memory,
        pino({ level: 'silent' }),
      ).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      const roles = new Set(result.plan?.steps.map((step) => step.role));
      assert.deepEqual([...roles].sort(), ['analyst', 'builder', 'researcher']);
    } finally {
      await store.close();
    }
  });

  test('runs parallel specialists, correction, review, and synthesis to completion', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await createTask(store, 'validated workflow');
      const model = new FakeModel();
      const orchestrator = new WorkflowOrchestrator(
        store,
        new EventHub(),
        model,
        memory,
        pino({ level: 'silent' }),
      );

      const result = await orchestrator.run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.equal(result.result, 'Validated final artifact.');
      assert.equal(result.review?.approved, true);
      assert.ok(result.stepResults.length >= 3);
      assert.equal(model.reviewCalls, 2);

      const events = await store.getEvents(task.id);
      assert.deepEqual(
        events.map((event) => event.sequence),
        events.map((_, index) => index + 1),
      );
      assert.ok(events.some((event) => event.type === 'checkpoint.saved'));
      assert.ok(events.some((event) => event.type === 'agent.retrying'));
      assert.ok(events.some((event) => event.type === 'graph.updated'));
      assert.ok(events.some((event) => event.type === 'model.delta'));
      assert.ok(events.some((event) => event.type === 'agent.message'));
      assert.ok(result.stepResults.some((step) => (step.messages?.length ?? 0) > 0));
      const lifecycleStarted = events.find((event) => event.type === 'agent.started');
      const lifecycleCompleted = events.find((event) => event.type === 'agent.completed');
      for (const lifecycle of [lifecycleStarted, lifecycleCompleted]) {
        assert.equal(typeof lifecycle?.payload.role, 'string');
        assert.equal(typeof lifecycle?.payload.title, 'string');
        assert.equal(typeof lifecycle?.payload.objective, 'string');
        assert.equal(Array.isArray(lifecycle?.payload.dependsOn), true);
      }
      const graphEvent = events.find((event) => event.type === 'graph.updated');
      const graph = graphEvent?.payload.graph as { nodes?: Array<{ id: string }>; edges?: Array<{ kind: string }> } | undefined;
      assert.ok((graph?.nodes?.length ?? 0) >= 4, 'full workflow graph includes planner, steps, reviewer, and synthesizer');
      assert.ok(graph?.edges?.some((edge) => edge.kind === 'dependency' || edge.kind === 'delegation'));
      assert.ok(graph?.edges?.some((edge) => edge.kind === 'delegation'));
      assert.ok(graph?.edges?.some((edge) => edge.kind === 'review'));
      assert.ok(events.some((event) => event.type === 'loop.started'));
      assert.ok(events.some((event) => event.type === 'loop.iteration'));
      assert.ok(events.some((event) => event.type === 'loop.completed'));
      assert.equal(events.at(-1)?.type, 'task.completed');
      assert.ok(events.filter((event) => event.type === 'review.completed').length === 2);
    } finally {
      await store.close();
    }
  });

  test('honors per-step model selection while keeping task defaults as fallback', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'step model routing',
        input: 'Build and verify a production workflow.',
        mode: 'build',
        plan: {
          summary: 'Run two specialists with explicit model assignments.',
          routingReason: 'Research and analysis have different latency/quality needs.',
          profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 2, reasons: ['test'], maxSteps: 4, requiresReview: false },
          steps: [
            { id: 'research', title: 'Research', role: 'researcher', objective: 'Collect bounded evidence.', dependsOn: [], acceptanceCriteria: ['Evidence is explicit'], model: 'fast-model', failureStrategy: 'retry' },
            { id: 'analysis', title: 'Analysis', role: 'analyst', objective: 'Analyze the evidence.', dependsOn: [], acceptanceCriteria: ['Risks are explicit'], model: 'deep-model', failureStrategy: 'retry' },
          ],
        },
      });
      const model = new FakeModel();
      const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' })).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed', `${result.error} / models=${model.requestedModels.join(',')} / steps=${JSON.stringify(result.stepResults)}`);
      assert.ok(model.requestedModels.includes('fast-model'));
      assert.ok(model.requestedModels.includes('deep-model'));
      const modelEvents = (await store.getEvents(task.id)).filter((event) => event.type === 'model.completed');
      assert.equal(modelEvents.find((event) => event.payload.stage === 'agent:research:attempt:2')?.payload.model, 'fast-model');
      assert.equal(modelEvents.find((event) => event.payload.stage === 'agent:analysis:attempt:1')?.payload.model, 'deep-model');
    } finally {
      await store.close();
    }
  });

  test('drops planner placeholder models before execution', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await createTask(store, 'planner placeholder model');
      const model = new PlannerPlaceholderModel();
      const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' })).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed', result.error);
      assert.equal(result.plan?.steps[0]?.model, undefined);
      assert.equal(model.requestedModels.includes('optional-model'), false);
    } finally {
      await store.close();
    }
  });

  test('assigns planner steps only from the controlled model policy catalog', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await createTask(store, 'controlled model policy');
      const policy = new ModelRoutingPolicy();
      const result = await new WorkflowOrchestrator(store, new EventHub(), new FakeModel(), memory, pino({ level: 'silent' }), undefined, undefined, undefined, policy)
        .run(task, new AbortController().signal);
      assert.equal(result.status, 'completed', result.error);
      assert.ok(result.plan?.steps.every((step) => step.model === 'fake-production-model'));
    } finally {
      await store.close();
    }
  });

  test('falls back to the task model when a persisted step model is rejected upstream', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'unsupported step model',
        input: 'Build and verify a production workflow.',
        mode: 'build',
        model: 'fake-production-model',
        plan: {
          summary: 'Run one specialist.',
          routingReason: 'Regression test.',
          profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 2, reasons: ['test'], maxSteps: 4, requiresReview: false },
          steps: [{ id: 'fallback', title: 'Fallback step', role: 'researcher', objective: 'Return a result.', dependsOn: [], acceptanceCriteria: ['Result is explicit'], model: 'unsupported-model', failureStrategy: 'retry' }],
          approvalStatus: 'approved',
        },
      });
      const model = new UnsupportedStepModel();
      const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' })).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed', result.error);
      assert.equal(model.attemptedModels.includes('unsupported-model'), true);
      assert.equal(model.attemptedModels.includes('fake-production-model'), true);
      const events = await store.getEvents(task.id);
      assert.ok(events.some((event) => event.type === 'agent.retrying' && event.payload.reason === 'unsupported-model'));
    } finally {
      await store.close();
    }
  });

  test('surfaces explicit conflicts between parallel specialists for validation', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await createTask(store, 'conflicting specialist conclusions');
      const orchestrator = new WorkflowOrchestrator(store, new EventHub(), new ConflictModel(), memory, pino({ level: 'silent' }));
      const result = await orchestrator.run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      const events = await store.getEvents(task.id);
      const conflict = events.find((event) => event.type === 'agent.conflict');
      assert.ok(conflict, 'parallel disagreement should be persisted as an event');
      assert.deepEqual(conflict?.payload.stepIds, ['support', 'challenge']);
      assert.equal(conflict?.payload.resolution, 'reviewer-validation-required');
    } finally {
      await store.close();
    }
  });

  test('constrains parallel step token budgets when the task budget is tight', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'tight budget workflow',
        input: 'Build and verify a production workflow.',
        mode: 'build',
        policy: { maxTokens: 10_000 },
      });
      const orchestrator = new WorkflowOrchestrator(store, new EventHub(), new FakeModel(), memory, pino({ level: 'silent' }));
      const result = await orchestrator.run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      const events = await store.getEvents(task.id);
      const constrained = events.find((event) => event.type === 'budget.constrained');
      assert.ok(constrained, 'the runtime should report budget-aware scheduling');
      const constrainedSteps = constrained?.payload.steps as Array<{ maxTokens?: number }> | undefined;
      assert.ok((constrainedSteps?.length ?? 0) > 0);
      assert.ok(constrainedSteps!.every((step) => Number(step.maxTokens) < 6_144));
    } finally {
      await store.close();
    }
  });

  test('stops after planning when approval is required and resumes only after approval', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'approval workflow',
        input: 'Build and verify a production workflow with dependencies and acceptance criteria.',
        mode: 'build',
        policy: { requirePlanApproval: true },
      });
      const model = new FakeModel();
      const orchestrator = new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }));

      const waiting = await orchestrator.run(task, new AbortController().signal);
      assert.equal(waiting.status, 'awaiting_approval');
      assert.equal(waiting.plan?.approvalStatus, 'pending');
      assert.equal(waiting.stepResults.length, 0);
      assert.ok((await store.getEvents(task.id)).some((event) => event.type === 'plan.approval_requested'));

      const approvedPlan = { ...waiting.plan!, approvalStatus: 'approved' as const, approvedBy: 'user-a', approvedAt: new Date().toISOString() };
      const approved = await store.updateTask(task.id, { status: 'queued', plan: approvedPlan });
      const result = await orchestrator.run(approved, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.ok(result.stepResults.length > 0);
    } finally {
      await store.close();
    }
  });

  test('pauses a high-risk workspace tool and resumes only after durable approval', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    const workspace = await mkdtemp(join(tmpdir(), 'axiom-orchestrator-tools-'));
    const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
    const previousRoot = process.env.AXIOM_AGENT_WORKSPACE_ROOT;
    process.env.AXIOM_TOOL_EXECUTOR = 'docker';
    process.env.AXIOM_AGENT_WORKSPACE_ROOT = workspace;
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'tool approval workflow',
        input: 'Implement a complex production workflow with dependencies, recovery, acceptance, and multi-agent collaboration.',
        mode: 'build',
      });
      const tools = new ToolRegistry({ execute: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, auditId: 'fake' }) } as never);
      const model = new ToolApprovalModel();
      const orchestrator = new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }), tools);
      const waiting = await orchestrator.run(task, new AbortController().signal);
      assert.equal(waiting.status, 'waiting_for_human');
      assert.equal(waiting.toolApprovals?.[0]?.status, 'pending');
      assert.ok((await store.getEvents(task.id)).some((event) => event.type === 'tool.approval_requested'));

      const approvedTool = { ...waiting.toolApprovals![0]!, status: 'approved' as const, decidedBy: 'user-a', decidedAt: new Date().toISOString() };
      const resumed = await store.updateTask(task.id, { status: 'queued', toolApprovals: [approvedTool] });
      const completed = await orchestrator.run(resumed, new AbortController().signal);
      assert.equal(completed.status, 'completed', `${completed.error ?? 'workflow did not complete'} :: ${JSON.stringify(completed.stepResults)}`);
      assert.equal(await readFile(join(workspace, 'release.md'), 'utf8'), '# Release\n');
      assert.ok((await store.getEvents(task.id)).some((event) => event.type === 'tool.completed'));
      assert.equal(model.builderCalls, 2);
    } finally {
      if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
      else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
      if (previousRoot === undefined) delete process.env.AXIOM_AGENT_WORKSPACE_ROOT;
      else process.env.AXIOM_AGENT_WORKSPACE_ROOT = previousRoot;
      await rm(workspace, { recursive: true, force: true });
      await store.close();
    }
  });

  test('leaves infrastructure interruptions recoverable instead of cancelling the task', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await createTask(store, 'recoverable interruption');
      const orchestrator = new WorkflowOrchestrator(
        store,
        new EventHub(),
        new FakeModel(),
        memory,
        pino({ level: 'silent' }),
      );
      const controller = new AbortController();
      controller.abort(new DOMException('Runtime shutting down', 'AbortError'));

      const result = await orchestrator.run(task, controller.signal);
      assert.equal(result.status, 'queued');
      assert.equal(result.cancelRequested, false);
      assert.equal((await store.getEvents(task.id)).length, 0);
    } finally {
      await store.close();
    }
  });

  test('does not advance a paused task and can resume from its persisted state', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await createTask(store, 'paused workflow');
      const paused = await store.updateTask(task.id, { status: 'paused' });
      const orchestrator = new WorkflowOrchestrator(
        store,
        new EventHub(),
        new FakeModel(),
        memory,
        pino({ level: 'silent' }),
      );
      const pausedResult = await orchestrator.run(paused, new AbortController().signal);
      assert.equal(pausedResult.status, 'paused');
      assert.equal((await store.getEvents(task.id)).length, 0);

      const resumed = await store.updateTask(task.id, { status: 'queued' });
      const result = await orchestrator.run(resumed, new AbortController().signal);
      assert.equal(result.status, 'completed');
    } finally {
      await store.close();
    }
  });

  test('routes social turns around the evidence quality gate', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'hello',
        input: 'USER:\nhello',
        mode: 'analyze',
      });
      const orchestrator = new WorkflowOrchestrator(
        store,
        new EventHub(),
        new FakeModel(),
        memory,
        pino({ level: 'silent' }),
      );
      const result = await orchestrator.run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.equal(result.result, '你好，我在。');
      assert.equal(result.review, undefined);
      const events = await store.getEvents(task.id);
      assert.equal(events.at(-1)?.type, 'task.completed');
      assert.equal(events.some((event) => event.type === 'agent.spawned' && event.agentId?.startsWith('direct-responder-')), true);
      assert.equal(events.some((event) => event.type === 'agent.started'), true);
      assert.equal(events.some((event) => event.type === 'agent.completed'), true);
      const started = events.find((event) => event.type === 'agent.started');
      const completed = events.find((event) => event.type === 'agent.completed');
      assert.equal(started?.payload.role, 'direct-responder');
      assert.equal(started?.payload.objective, 'hello');
      assert.deepEqual(started?.payload.dependsOn, []);
      assert.equal(completed?.payload.title, '直连响应器');
      assert.equal(result.stepResults.length, 1);
      assert.equal(result.stepResults[0]?.role, 'direct-responder');
      assert.equal(events.some((event) => event.type === 'task.planning' || event.type === 'task.planned'), false);
      assert.equal(events.some((event) => event.type === 'review.completed' || event.type === 'artifact.created'), false);
    } finally {
      await store.close();
    }
  });

  test('fails transparently instead of returning a fixed answer when the model is unavailable', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'capabilities',
        input: 'USER:\n你能做什么',
        mode: 'analyze',
      });
      const orchestrator = new WorkflowOrchestrator(
        store,
        new EventHub(),
        new UnavailableConversationModel(),
        memory,
        pino({ level: 'silent' }),
      );
      const result = await orchestrator.run(task, new AbortController().signal);
      assert.equal(result.status, 'failed');
      assert.equal(result.result, undefined);
      const events = await store.getEvents(task.id);
      assert.ok(events.some((event) => event.type === 'task.failed'));
      assert.equal(events.some((event) => event.type === 'task.completed'), false);
    } finally {
      await store.close();
    }
  });

  test('preserves completed sibling work and synthesizes a partial result after one Agent exhausts retries', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-partial',
        userId: 'user-partial',
        sessionId: 'session-partial',
        title: 'partial workflow recovery',
        input: 'Compare two deployment options.',
        mode: 'build',
      });
      const plan = {
        summary: 'Run independent evidence steps.',
        routingReason: 'Independent work can be combined even when one provider call fails.',
        profile: { kind: 'implementation' as const, difficulty: 'moderate' as const, route: 'team' as const, score: 2, reasons: ['test'], maxSteps: 3, requiresReview: false },
        steps: [
          { id: 'evidence', title: '收集证据', role: 'researcher' as const, objective: '收集部署证据。', dependsOn: [], acceptanceCriteria: ['给出证据'], failureStrategy: 'retry' as const },
          { id: 'risk', title: '分析风险', role: 'analyst' as const, objective: '分析部署风险。', dependsOn: [], acceptanceCriteria: ['给出风险'], failureStrategy: 'retry' as const },
        ],
        approvalStatus: 'approved' as const,
        version: 1,
      };
      const planned = await store.updateTask(task.id, { plan });
      const model: ModelClient = {
        model: 'partial-test-model',
        async complete(request) {
          if (request.system.includes('You are a analyst')) throw new Error('upstream timeout while analyzing');
          const content = request.system.includes('synthesizer')
            ? '已根据成功完成的证据生成部分交付，并标注了未完成的风险分析。'
            : JSON.stringify({ output: '已收集部署证据。', evidence: ['真实测试证据'], confidence: 0.8, toolCalls: [] });
          await request.onDelta?.({ content });
          return { content, attempts: 1, durationMs: 1 };
        },
      };
      const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' })).run(planned, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.match(result.error ?? '', /部分 Agent 未完成/);
      assert.ok(result.stepResults.some((step) => step.stepId === 'evidence' && step.status === 'completed'));
      assert.ok(result.stepResults.some((step) => step.stepId === 'risk' && step.status === 'failed'));
      assert.match(result.result ?? '', /部分交付/);
      const completed = (await store.getEvents(task.id)).find((event) => event.type === 'task.completed');
      assert.equal(completed?.payload.partial, true);
    } finally {
      await store.close();
    }
  });

  test('routes a short factual question to a direct response', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'short question',
        input: 'USER:\n什么是向量数据库',
        mode: 'analyze',
      });
      const result = await new WorkflowOrchestrator(
        store,
        new EventHub(),
        new FakeModel(),
        memory,
        pino({ level: 'silent' }),
      ).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.equal(result.plan?.profile?.route, 'direct');
      assert.equal(result.plan?.graph, undefined);
      const events = await store.getEvents(task.id);
      assert.equal(events.some((event) => event.type === 'agent.spawned' && event.payload.role === 'direct-responder'), true);
      assert.equal(result.stepResults.length, 1);
      assert.equal(events.some((event) => event.type === 'task.planning' || event.type === 'task.planned'), false);
      assert.equal(events.some((event) => event.type === 'review.completed' || event.type === 'artifact.created'), false);
    } finally {
      await store.close();
    }
  });

  test('persists a direct response Artifact before the task is exposed as completed', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    const writes: Array<{ id: string; content: string }> = [];
    const artifactStore = {
      kind: 'filesystem' as const,
      put: async (id: string, content: string) => { writes.push({ id, content }); return { key: id, bytes: content.length }; },
      get: async () => null,
      delete: async () => undefined,
      health: async () => ({ configured: true, reachable: true, detail: 'ok' }),
    };
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a',
        title: 'artifact persistence', input: 'USER:\n请简短说明什么是缓存', mode: 'analyze',
      });
      const result = await new WorkflowOrchestrator(
        store, new EventHub(), new FakeModel(), memory, pino({ level: 'silent' }),
        undefined, undefined, undefined, undefined, artifactStore,
      ).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.id, `result:${task.id}`);
      assert.ok(writes[0]?.content.length);
    } finally {
      await store.close();
    }
  });

  test('answers agent catalog questions from the runtime registry', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'agent catalog',
        input: 'USER:\n有哪些子智能体',
        mode: 'analyze',
      });
      const result = await new WorkflowOrchestrator(
        store,
        new EventHub(),
        new FakeModel(),
        memory,
        pino({ level: 'silent' }),
      ).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.match(result.result ?? '', /研究员/);
      assert.match(result.result ?? '', /分析员/);
      assert.match(result.result ?? '', /工程师/);
      assert.match(result.result ?? '', /规划器/);
      assert.match(result.result ?? '', /审查员/);
      assert.match(result.result ?? '', /汇总员/);
      assert.match(result.result ?? '', /实时目录/);
      const events = await store.getEvents(task.id);
      assert.equal(events.some((event) => event.type === 'agent.spawned' && event.payload.role === 'direct-responder'), true);
      assert.equal(events.some((event) => event.type === 'task.planning' || event.type === 'review.completed'), false);
      assert.equal(events.some((event) => event.type === 'model.delta' && String(event.payload.content ?? '').includes('实时目录补充')), true);
    } finally {
      await store.close();
    }
  });

  test('routes a focused implementation request to one agent', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'focused implementation',
        input: 'USER:\n帮我写一个 JavaScript 防抖函数',
        mode: 'build',
      });
      const result = await new WorkflowOrchestrator(
        store,
        new EventHub(),
        new FakeModel(),
        memory,
        pino({ level: 'silent' }),
      ).run(task, new AbortController().signal);
      const events = await store.getEvents(task.id);
      assert.equal(result.status, 'completed');
      assert.equal(result.plan?.profile?.route, 'single-agent');
      assert.equal(events.filter((event) => event.type === 'agent.spawned').length, 1);
      const started = events.find((event) => event.type === 'agent.started');
      const completed = events.find((event) => event.type === 'agent.completed');
      assert.equal(started?.payload.stepId, 'single-agent');
      assert.equal(typeof started?.payload.role, 'string');
      assert.equal(started?.payload.title, '专注执行 Agent');
      assert.equal(started?.payload.objective, '帮我写一个 JavaScript 防抖函数');
      assert.deepEqual(completed?.payload.dependsOn, []);
      assert.equal(events.some((event) => event.type === 'checkpoint.saved'), false);
    } finally {
      await store.close();
    }
  });

  test('uses a small team for a moderate comparison without the full quality gate', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'moderate comparison',
        input: `USER:\nEvaluate and compare two vendor plans with requirements and tradeoffs. ${'Provide concrete context for the decision. '.repeat(5)}`,
        mode: 'decide',
      });
      const result = await new WorkflowOrchestrator(
        store,
        new EventHub(),
        new FakeModel(),
        memory,
        pino({ level: 'silent' }),
      ).run(task, new AbortController().signal);
      const events = await store.getEvents(task.id);
      assert.equal(result.status, 'completed');
      assert.equal(result.plan?.profile?.route, 'team');
      assert.equal(result.review?.score, 100);
      assert.equal(events.some((event) => event.type === 'review.started'), false);
      assert.equal(events.filter((event) => event.type === 'agent.spawned').length, 2);
    } finally {
      await store.close();
    }
  });

  test('pauses for human review and resumes after an explicit approval', async () => {
    const previousRounds = process.env.AGENT_REVIEW_CORRECTION_ROUNDS;
    const previousApproval = process.env.AGENT_REQUIRE_REVIEW_APPROVAL;
    process.env.AGENT_REVIEW_CORRECTION_ROUNDS = '0';
    process.env.AGENT_REQUIRE_REVIEW_APPROVAL = 'true';
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await createTask(store, 'human review takeover');
      const model = new FakeModel();
      const orchestrator = new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }));
      const waiting = await orchestrator.run(task, new AbortController().signal);
      assert.equal(waiting.status, 'waiting_for_human');
      assert.equal(waiting.review?.approved, false);
      assert.ok((await store.getEvents(task.id)).some((event) => event.type === 'review.approval_requested'));

      const approvedReview = { ...waiting.review!, approved: true, summary: 'Approved by operator for delivery.' };
      const approved = await store.updateTask(task.id, { status: 'queued', review: approvedReview });
      const resumed = await orchestrator.run(approved, new AbortController().signal);
      assert.equal(resumed.status, 'completed');
      assert.equal(resumed.result, 'Validated final artifact.');
      assert.equal(model.reviewCalls, 1);
    } finally {
      await store.close();
      if (previousRounds === undefined) delete process.env.AGENT_REVIEW_CORRECTION_ROUNDS;
      else process.env.AGENT_REVIEW_CORRECTION_ROUNDS = previousRounds;
      if (previousApproval === undefined) delete process.env.AGENT_REQUIRE_REVIEW_APPROVAL;
      else process.env.AGENT_REQUIRE_REVIEW_APPROVAL = previousApproval;
    }
  });

  test('loads a published custom role into planning and enforces its tool allowlist', async () => {
    const store = new SqliteTaskStore(':memory:');
    const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
    process.env.AXIOM_TOOL_EXECUTOR = 'docker';
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'custom data workflow',
        input: 'Implement a complex data comparison workflow with dependencies, recovery, acceptance, and multi-agent collaboration.',
        mode: 'build',
      });
      const customAgentStore = {
        listAgents: async () => [{
          id: 'custom-1',
          tenantId: 'tenant-a',
          roleId: 'data-specialist',
          name: 'Data Specialist',
          description: 'Compares structured data.',
          kind: 'worker' as const,
          status: 'published' as const,
          visibility: 'team' as const,
          version: 1,
          createdBy: 'user-a',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          definition: {
            systemPromptTemplate: 'Use structured data reasoning.',
            whenToUseHint: 'Use for data comparison and migration questions.',
            toolAllowlist: ['workspace.read'],
            memoryRecall: false,
          },
          history: [],
        }],
      } as unknown as AgentStore;
      const executorCalls: string[][] = [];
      const tools = new ToolRegistry({
        execute: async (request: { command: string; args?: string[] }) => {
          executorCalls.push([request.command, ...(request.args ?? [])]);
          return { stdout: 'bounded read', stderr: '', exitCode: 0, durationMs: 1, auditId: 'custom-tool' };
        },
      } as never);
      const orchestrator = new WorkflowOrchestrator(
        store,
        new EventHub(),
        new CustomRoleModel(),
        memory,
        pino({ level: 'silent' }),
        tools,
        customAgentStore,
      );
      const result = await orchestrator.run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.equal(result.plan?.steps.some((step) => step.role === 'data-specialist'), true);
      assert.ok(result.stepResults.some((step) => step.role === 'data-specialist'));
      assert.equal(executorCalls.length, 1, 'only the allowlisted tool should execute');
      const events = await store.getEvents(task.id);
      assert.ok(events.some((event) => event.type === 'agent.spawned' && event.payload.role === 'data-specialist'));
      assert.ok(events.some((event) => event.type === 'tool.failed' && event.payload.name === 'workspace.write'));
    } finally {
      if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
      else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
      await store.close();
    }
  });

  test('falls back to the built-in plan when the custom Agent directory is unavailable', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'directory outage workflow',
        input: 'Implement a complex workflow with dependencies, recovery, acceptance, and multi-agent collaboration.',
        mode: 'build',
      });
      const unavailableAgentStore = {
        listAgents: async () => { throw new Error('agent directory unavailable'); },
      } as unknown as AgentStore;
      const orchestrator = new WorkflowOrchestrator(
        store,
        new EventHub(),
        new CustomRoleModel(),
        memory,
        pino({ level: 'silent' }),
        undefined,
        unavailableAgentStore,
      );
      const result = await orchestrator.run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.ok(result.plan?.steps.length);
      assert.equal(result.plan?.steps.some((step) => step.role === 'data-specialist'), false);
      assert.ok(result.plan?.steps.every((step) => ['researcher', 'analyst', 'builder'].includes(step.role)));
    } finally {
      await store.close();
    }
  });
});
