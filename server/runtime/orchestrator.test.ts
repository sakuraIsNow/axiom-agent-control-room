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
import { FileArtifactStore } from './artifactStore.js';
import { deliveryModelFixture } from './testing/deliveryModelFixture.js';

class FakeModel implements ModelClient {
  readonly model = 'fake-production-model';
  reviewCalls = 0;
  researcherCalls = 0;
  requestedModels: string[] = [];

  async complete(request: ModelCompletionRequest) {
    this.requestedModels.push(request.model ?? this.model);
    const delivery = deliveryModelFixture(request);
    if (delivery) return delivery;
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

class SynthesisContinuationModel extends FakeModel {
  synthesisCalls = 0;

  async complete(request: ModelCompletionRequest) {
    if (!request.system.includes('synthesizer')) return super.complete(request);
    this.synthesisCalls += 1;
    const content = this.synthesisCalls === 1
      ? '第一段交付内容在这里，已经完成了前置验证和范围确认，但最后一句尚未结束'
      : '第一段交付内容在这里，已经完成了前置验证和范围确认，但最后一句尚未结束，续写已经接上并完整结束。';
    await request.onDelta?.({ content });
    return {
      content,
      finishReason: this.synthesisCalls === 1 ? 'length' : 'stop',
      attempts: 1,
      durationMs: 1,
    };
  }
}

class AlwaysTruncatedSynthesisModel extends FakeModel {
  synthesisCalls = 0;

  async complete(request: ModelCompletionRequest) {
    if (!request.system.includes('synthesizer')) return super.complete(request);
    this.synthesisCalls += 1;
    const content = this.synthesisCalls === 1 ? '已生成但被截断的部分' : '仍然没有结束';
    await request.onDelta?.({ content });
    return { content, finishReason: 'length', attempts: 1, durationMs: 1 };
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

class GuidanceCaptureModel extends FakeModel {
  readonly guidanceRequests: ModelCompletionRequest[] = [];

  async complete(request: ModelCompletionRequest) {
    if (request.user.includes('先校验迁移兼容性，再继续实现。')) this.guidanceRequests.push(request);
    return super.complete(request);
  }
}

class LargeResultReferenceModel extends FakeModel {
  readonly largeOutput = `${'完整上游证据。'.repeat(2_200)}尾部校验标记`;
  downstreamRequest?: ModelCompletionRequest;
  synthesisRequest?: ModelCompletionRequest;

  async complete(request: ModelCompletionRequest) {
    if (request.system.includes('You are a analyst sub-agent')) {
      const content = JSON.stringify({ output: this.largeOutput, evidence: ['完整证据已生成'], confidence: 0.9, toolCalls: [], handoff: '上游已完成详细分析，完整正文请按 result_ref 读取。' });
      await request.onDelta?.({ content });
      return { content, attempts: 1, durationMs: 1, usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } };
    }
    if (request.system.includes('You are a builder sub-agent')) {
      this.downstreamRequest = request;
      const content = JSON.stringify({ output: '已根据上游摘要形成实施方案。', evidence: ['引用上游结果'], confidence: 0.88, toolCalls: [] });
      await request.onDelta?.({ content });
      return { content, attempts: 1, durationMs: 1 };
    }
    if (request.system.includes('synthesizer')) {
      this.synthesisRequest = request;
      const content = '长结果引用工作流已完成。';
      await request.onDelta?.({ content });
      return { content, attempts: 1, durationMs: 1 };
    }
    return super.complete(request);
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
    const delivery = deliveryModelFixture(request);
    if (delivery) return delivery;
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

class WriteScopeModel extends FakeModel {
  async complete(request: ModelCompletionRequest) {
    if (request.system.includes('planner in a production')) {
      const content = JSON.stringify({
        summary: '并行读取与分批写入。',
        routingReason: '两个写入 Agent 触碰同一目录，必须分到不同执行波次。',
        steps: [
          { id: 'read', title: '读取部署资料', role: 'researcher', objective: '读取资料。', dependsOn: [], acceptanceCriteria: ['资料已读取'] },
          { id: 'write-a', title: '更新配置 A', role: 'builder', objective: '更新 A。', dependsOn: [], writeScopes: ['deploy/config'], acceptanceCriteria: ['A 已更新'] },
          { id: 'write-b', title: '更新配置 B', role: 'builder', objective: '更新 B。', dependsOn: [], writeScopes: ['deploy/config/prod'], acceptanceCriteria: ['B 已更新'] },
        ],
      });
      await request.onDelta?.({ content });
      return { content, attempts: 1, durationMs: 1 };
    }
    return super.complete(request);
  }
}

class UnavailableConversationModel implements ModelClient {
  readonly model = 'unavailable-model';

  async complete(request: ModelCompletionRequest): Promise<never> {
    if (request.system.includes('conversational agent')) throw new TypeError('fetch failed');
    throw new Error('Unexpected non-conversational request.');
  }
}

class PausableParallelModel implements ModelClient {
  readonly model = 'pausable-parallel-model';
  readonly targetStarted: Promise<void>;
  readonly siblingStarted: Promise<void>;
  targetCalls = 0;
  siblingCalls = 0;
  private resolveTargetStarted!: () => void;
  private resolveSiblingStarted!: () => void;
  private resolveSibling!: () => void;
  private readonly siblingRelease: Promise<void>;

  constructor(private readonly blockFirstTarget: boolean) {
    this.targetStarted = new Promise((resolve) => { this.resolveTargetStarted = resolve; });
    this.siblingStarted = new Promise((resolve) => { this.resolveSiblingStarted = resolve; });
    this.siblingRelease = new Promise((resolve) => { this.resolveSibling = resolve; });
  }

  releaseSibling() {
    this.resolveSibling();
  }

  private async waitForAbort(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  async complete(request: ModelCompletionRequest) {
    const delivery = deliveryModelFixture(request);
    if (delivery) return delivery;
    let content: string;
    if (request.system.includes('You are a researcher sub-agent')) {
      this.targetCalls += 1;
      this.resolveTargetStarted();
      if (this.blockFirstTarget && this.targetCalls === 1) await this.waitForAbort(request.signal);
      content = JSON.stringify({ output: '目标 Agent 已从检查点完成。', evidence: [], confidence: 0.9, toolCalls: [] });
    } else if (request.system.includes('You are a analyst sub-agent')) {
      this.siblingCalls += 1;
      this.resolveSiblingStarted();
      await this.siblingRelease;
      content = JSON.stringify({ output: '并行兄弟 Agent 已完成。', evidence: [], confidence: 0.9, toolCalls: [] });
    } else if (request.system.includes('synthesizer')) {
      content = '并行任务已完成。';
    } else {
      content = JSON.stringify({ output: '完成。', evidence: [], confidence: 0.9, toolCalls: [] });
    }
    await request.onDelta?.({ content });
    return { content, attempts: 1, durationMs: 1 };
  }
}

class DependencyTransferModel implements ModelClient {
  readonly model = 'dependency-transfer-model';
  readonly downstreamInputs = new Map<string, string>();

  async complete(request: ModelCompletionRequest) {
    const delivery = deliveryModelFixture(request);
    if (delivery) return delivery;
    let content: string;
    if (request.system.includes('You are a researcher sub-agent')) {
      content = JSON.stringify({
        output: JSON.stringify({ summary: '完整摘要', details: '完整细节', hidden: '不应进入字段模式' }),
        evidence: [], confidence: 0.9, toolCalls: [],
        handoff: { summary: '结构化交接摘要', status: 'complete', artifactIds: ['artifact-source-1'], evidenceIds: [], openQuestions: [], completionCriteria: ['上游完成'] },
      });
    } else if (request.system.includes('synthesizer')) {
      content = '传递模式验证完成。';
    } else {
      const marker = ['summary-consumer', 'full-consumer', 'fields-consumer', 'reference-consumer'].find((value) => request.user.includes(value)) ?? 'unknown';
      this.downstreamInputs.set(marker, request.user);
      content = JSON.stringify({ output: `${marker} 完成`, evidence: [], confidence: 0.9, toolCalls: [] });
    }
    await request.onDelta?.({ content });
    return { content, attempts: 1, durationMs: 1 };
  }
}

class ToolApprovalModel implements ModelClient {
  readonly model = 'tool-approval-model';
  builderCalls = 0;

  async complete(request: ModelCompletionRequest) {
    const delivery = deliveryModelFixture(request);
    if (delivery) return delivery;
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
    const delivery = deliveryModelFixture(request);
    if (delivery) return delivery;
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
    const delivery = deliveryModelFixture(request);
    if (delivery) return delivery;
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

class BoundedReplannerModel implements ModelClient {
  readonly model = 'bounded-replanner-model';
  originalCalls = 0;

  async complete(request: ModelCompletionRequest) {
    const delivery = deliveryModelFixture(request);
    if (delivery) return delivery;
    let content: string;
    if (request.system.includes('You are a researcher sub-agent') && !request.user.includes('诊断步骤')) {
      this.originalCalls += 1;
      throw new Error('upstream source stayed unavailable');
    }
    if (request.system.includes('synthesizer')) content = '恢复后的完整交付。';
    else content = JSON.stringify({
      output: request.user.includes('诊断步骤') ? '已使用受限替代路径恢复上游结果。' : '下游已消费恢复交接。',
      evidence: [{ claim: '恢复结果由当前执行产生。', kind: 'model-inference', source: 'bounded-replanner-model', verification: 'unverified', confidence: .8 }],
      confidence: .8,
      toolCalls: [],
      handoff: { summary: '恢复完成，可供下游继续。', status: 'complete', artifactIds: [], evidenceIds: [], openQuestions: [], completionCriteria: ['恢复结果可消费'] },
    });
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

  test('pauses only the selected parallel Agent, checkpoints its completed sibling, and resumes after restart', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-agent-pause', userId: 'user-agent-pause', sessionId: 'session-agent-pause',
        title: 'parallel Agent pause', input: '并行执行两个 Agent，并只暂停目标 Agent。', mode: 'build',
        plan: {
          summary: '并行执行两个独立 Agent。', routingReason: '验证 Agent 级暂停的隔离性。',
          profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 3, reasons: ['parallel control'], maxSteps: 2, requiresReview: false },
          steps: [
            { id: 'target', title: '目标 Agent', role: 'researcher', objective: '等待暂停并在恢复后完成。', dependsOn: [], acceptanceCriteria: ['恢复后完成'], failureStrategy: 'retry' },
            { id: 'sibling', title: '兄弟 Agent', role: 'analyst', objective: '在目标暂停期间正常完成。', dependsOn: [], acceptanceCriteria: ['不被误中断'], failureStrategy: 'retry' },
          ],
          version: 1, approvalStatus: 'approved',
        },
      });
      const firstModel = new PausableParallelModel(true);
      const firstOrchestrator = new WorkflowOrchestrator(store, new EventHub(), firstModel, memory, pino({ level: 'silent' }));
      const firstRun = firstOrchestrator.run(task, new AbortController().signal);
      await Promise.all([firstModel.targetStarted, firstModel.siblingStarted]);
      const pauseEvent = await store.appendEvent(task, {
        type: 'node.pause_requested', agentId: 'operator-target',
        payload: { stepId: 'target', requestedBy: task.userId, reason: '并行暂停回归测试' },
      });
      assert.ok(pauseEvent.sequence > 0);
      assert.equal(firstOrchestrator.pauseStep(task.id, 'target'), true);
      firstModel.releaseSibling();

      const paused = await firstRun;
      assert.equal(paused.status, 'paused');
      assert.deepEqual(paused.stepResults.map((result) => result.stepId), ['sibling']);
      assert.equal(firstModel.targetCalls, 1);
      assert.equal(firstModel.siblingCalls, 1);
      const pausedEvents = await store.getEvents(task.id);
      assert.ok(pausedEvents.some((event) => event.type === 'agent.interrupted'
        && event.payload.stepId === 'target'
        && Array.isArray(event.payload.preservedSiblingResults)
        && event.payload.preservedSiblingResults.includes('sibling')));
      assert.ok(pausedEvents.some((event) => event.type === 'checkpoint.saved'
        && event.payload.completedSteps === 1
        && typeof event.payload.snapshot === 'object'
        && event.payload.snapshot !== null
        && Array.isArray((event.payload.snapshot as { stepResults?: unknown[] }).stepResults)
        && (event.payload.snapshot as { stepResults: Array<{ stepId?: string }> }).stepResults.some((result) => result.stepId === 'sibling')));

      const queued = await store.updateTask(task.id, { status: 'queued', error: null });
      await store.appendEvent(queued, {
        type: 'node.resume_requested', agentId: 'operator-target',
        payload: { stepId: 'target', requestedBy: task.userId, checkpointSteps: queued.stepResults.length },
      });
      const resumedTask = (await store.getTask(task.id))!;
      const resumedModel = new PausableParallelModel(false);
      resumedModel.releaseSibling();
      const completed = await new WorkflowOrchestrator(store, new EventHub(), resumedModel, memory, pino({ level: 'silent' }))
        .run(resumedTask, new AbortController().signal);
      assert.equal(completed.status, 'completed', completed.error);
      assert.equal(resumedModel.targetCalls, 1);
      assert.equal(resumedModel.siblingCalls, 0, 'the durable sibling checkpoint must not execute again');
      assert.deepEqual(new Set(completed.stepResults.map((result) => result.stepId)), new Set(['target', 'sibling']));
    } finally {
      await store.close();
    }
  });

  test('handles a rapid pause and resume without losing or duplicating a parallel sibling result', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-agent-race', userId: 'user-agent-race', sessionId: 'session-agent-race',
        title: 'parallel Agent pause resume race', input: '验证暂停后立即恢复不会丢失并行结果。', mode: 'build',
        plan: {
          summary: '并行执行两个独立 Agent。', routingReason: '验证控制事件竞态。',
          profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 3, reasons: ['control race'], maxSteps: 2, requiresReview: false },
          steps: [
            { id: 'target', title: '目标 Agent', role: 'researcher', objective: '被快速暂停和恢复。', dependsOn: [], acceptanceCriteria: ['最终完成'], failureStrategy: 'retry' },
            { id: 'sibling', title: '兄弟 Agent', role: 'analyst', objective: '只执行一次。', dependsOn: [], acceptanceCriteria: ['不重复执行'], failureStrategy: 'retry' },
          ],
          version: 1, approvalStatus: 'approved',
        },
      });
      const model = new PausableParallelModel(true);
      const orchestrator = new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }));
      const running = orchestrator.run(task, new AbortController().signal);
      await Promise.all([model.targetStarted, model.siblingStarted]);
      await store.appendEvent(task, { type: 'node.pause_requested', agentId: 'operator-target', payload: { stepId: 'target', requestedBy: task.userId } });
      assert.equal(orchestrator.pauseStep(task.id, 'target'), true);
      await store.appendEvent(task, { type: 'node.resume_requested', agentId: 'operator-target', payload: { stepId: 'target', requestedBy: task.userId } });
      model.releaseSibling();

      const completed = await running;
      assert.equal(completed.status, 'completed', completed.error);
      assert.equal(model.targetCalls, 2, 'the interrupted target should restart once');
      assert.equal(model.siblingCalls, 1, 'the settled sibling should remain checkpointed');
      assert.equal(completed.stepResults.filter((result) => result.stepId === 'sibling').length, 1);
      assert.equal((await store.getEvents(task.id)).filter((event) => event.type === 'task.paused').length, 0);
    } finally {
      await store.close();
    }
  });

  test('delivers summary, full, selected fields, and Artifact references according to each Nexus edge contract', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const contract = (mode: 'summary' | 'full' | 'fields' | 'reference', fields?: string[]) => ({
        source: 'builtin' as const, agentId: 'analyst', displayName: '下游 Agent', toolAllowlist: [],
        dependencyTransfers: { source: { mode, ...(fields ? { fields } : {}) } },
      });
      const task = await store.createTask({
        tenantId: 'tenant-transfer', userId: 'user-transfer', sessionId: 'session-transfer',
        title: 'Nexus transfer modes', input: '验证 Agent Nexus 连线传递内容。', mode: 'analyze',
        plan: {
          summary: '验证四种传递模式。', routingReason: '每个下游 Agent 使用独立传递契约。',
          profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 3, reasons: ['transfer contract'], maxSteps: 5, requiresReview: false },
          steps: [
            { id: 'source', title: '上游', role: 'researcher', objective: 'produce-source', dependsOn: [], acceptanceCriteria: ['上游完成'], failureStrategy: 'retry' },
            { id: 'summary', title: '摘要消费者', role: 'analyst', objective: 'summary-consumer', dependsOn: ['source'], acceptanceCriteria: ['收到摘要'], failureStrategy: 'retry', agentContract: contract('summary') },
            { id: 'full', title: '全文消费者', role: 'builder', objective: 'full-consumer', dependsOn: ['source'], acceptanceCriteria: ['收到全文'], failureStrategy: 'retry', agentContract: contract('full') },
            { id: 'fields', title: '字段消费者', role: 'reviewer', objective: 'fields-consumer', dependsOn: ['source'], acceptanceCriteria: ['只收到字段'], failureStrategy: 'retry', agentContract: contract('fields', ['details']) },
            { id: 'reference', title: '引用消费者', role: 'auditor', objective: 'reference-consumer', dependsOn: ['source'], acceptanceCriteria: ['收到引用'], failureStrategy: 'retry', agentContract: contract('reference') },
          ],
          version: 1, approvalStatus: 'approved',
        },
      });
      const model = new DependencyTransferModel();
      const completed = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }))
        .run(task, new AbortController().signal);
      assert.equal(completed.status, 'completed', completed.error);
      assert.match(model.downstreamInputs.get('summary-consumer') ?? '', /按连线传递的内容：结构化交接摘要/);
      assert.doesNotMatch(model.downstreamInputs.get('summary-consumer') ?? '', /完整细节/);
      assert.match(model.downstreamInputs.get('full-consumer') ?? '', /完整细节/);
      assert.match(model.downstreamInputs.get('fields-consumer') ?? '', /按连线传递的内容：\{"details":"完整细节"\}/);
      assert.doesNotMatch(model.downstreamInputs.get('fields-consumer') ?? '', /不应进入字段模式/);
      assert.match(model.downstreamInputs.get('reference-consumer') ?? '', /上游结果仅通过引用传递：artifact-source-1/);
      const messages = (await store.getEvents(task.id)).filter((event) => event.type === 'agent.message');
      assert.equal(messages.length, 4);
      assert.ok(messages.some((event) => String(event.payload.content).includes('完整细节')));
      assert.ok(messages.some((event) => String(event.payload.content).includes('artifact-source-1')));
    } finally {
      await store.close();
    }
  });

  test('inserts one bounded recovery Agent, preserves failures, and rewires pending descendants', async () => {
    const previous = process.env.AXIOM_MAX_AUTO_REPLANS;
    process.env.AXIOM_MAX_AUTO_REPLANS = '1';
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-replan', userId: 'user-replan', sessionId: 'session-replan',
        title: 'bounded recovery', input: 'Recover a failed dependency without expanding permissions.', mode: 'build',
        plan: {
          summary: 'Run and recover a dependency.', routingReason: 'Recovery behavior test.',
          profile: { kind: 'implementation', difficulty: 'hard', route: 'full-workflow', score: 5, reasons: ['dependency recovery'], maxSteps: 3, requiresReview: false },
          steps: [
            { id: 'source', title: '读取上游', role: 'researcher', objective: 'original-step must fail', dependsOn: [], acceptanceCriteria: ['上游可用'], skillIds: [], failureStrategy: 'retry' },
            { id: 'delivery', title: '形成交付', role: 'builder', objective: 'consume recovered upstream', dependsOn: ['source'], acceptanceCriteria: ['交付完成'], skillIds: [], failureStrategy: 'retry' },
          ],
          version: 1, approvalStatus: 'approved',
        },
      });
      const model = new BoundedReplannerModel();
      const completed = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' })).run(task, new AbortController().signal);
      const recovery = completed.plan?.steps.find((step) => step.recoveryForStepId === 'source');
      const failed = completed.stepResults.find((result) => result.stepId === 'source' && result.status === 'failed');
      const delivery = completed.plan?.steps.find((step) => step.id === 'delivery');
      const events = await store.getEvents(task.id);
      assert.equal(completed.status, 'completed');
      assert.ok(recovery);
      assert.deepEqual(recovery?.toolNames, []);
      assert.deepEqual(recovery?.writeScopes, []);
      assert.equal(failed?.recoveredByStepId, recovery?.id);
      assert.deepEqual(delivery?.dependsOn, [recovery?.id]);
      assert.equal(completed.planVersion, 2);
      assert.equal(completed.error, undefined);
      assert.equal(model.originalCalls, 2);
      const replans = events.filter((event) => event.type === 'plan.replanned' && event.payload.trigger === 'automatic-failure');
      assert.equal(replans.length, 1);
      assert.equal(replans[0]?.payload.riskIncreased, false);
      assert.equal(events.find((event) => event.type === 'task.completed')?.payload.partial, false);
    } finally {
      await store.close();
      if (previous === undefined) delete process.env.AXIOM_MAX_AUTO_REPLANS;
      else process.env.AXIOM_MAX_AUTO_REPLANS = previous;
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

  test('applies each live guidance event once at the next safe execution point', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-guidance',
        userId: 'user-guidance',
        sessionId: 'session-guidance',
        title: 'guidance-once',
        input: '完成数据库迁移方案和上线检查。',
        mode: 'build',
        plan: {
          summary: '顺序完成分析与交付。',
          routingReason: '第二步依赖第一步。',
          profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 3, reasons: ['test'], maxSteps: 2, requiresReview: false },
          steps: [
            { id: 'analyze', title: '分析迁移', role: 'analyst', objective: '分析迁移风险。', dependsOn: [], acceptanceCriteria: ['风险明确'], skillIds: ['architecture-design'] },
            { id: 'deliver', title: '形成方案', role: 'builder', objective: '形成上线方案。', dependsOn: ['analyze'], acceptanceCriteria: ['步骤可执行'], skillIds: ['implementation'] },
          ],
          approvalStatus: 'approved',
          version: 1,
        },
      });
      const accepted = await store.appendEvent(task, {
        type: 'human.guidance_accepted',
        payload: {
          guidanceId: 'guidance-once-1',
          message: '先校验迁移兼容性，再继续实现。',
          behavior: 'continue',
          author: 'user-guidance',
          delivery: 'builtin-next-safe-point',
        },
      });
      const model = new GuidanceCaptureModel();
      const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }))
        .run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.equal(model.guidanceRequests.length, 1, 'guidance must not leak into later steps or synthesis');
      assert.match(model.guidanceRequests[0]!.user, /Human operator notes:[\s\S]*先校验迁移兼容性/);
      const applied = (await store.getEvents(task.id)).filter((event) => event.type === 'human.guidance_applied');
      assert.equal(applied.length, 1);
      assert.equal(applied[0]?.payload.guidanceId, 'guidance-once-1');
      assert.equal(applied[0]?.payload.acceptedSequence, accepted.sequence);
      assert.equal(Array.isArray(applied[0]?.payload.targetAgentIds), true);
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

  test('continues a synthesized answer after the provider reports finish_reason=length', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await createTask(store, 'synthesis continuation');
      const model = new SynthesisContinuationModel();
      const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }))
        .run(task, new AbortController().signal);
      assert.equal(result.status, 'completed', result.error);
      assert.equal(model.synthesisCalls, 2);
      assert.equal(result.result, '第一段交付内容在这里，已经完成了前置验证和范围确认，但最后一句尚未结束，续写已经接上并完整结束。');
      const events = await store.getEvents(task.id);
      const synthesisEvents = events.filter((event) => event.type === 'model.completed' && String(event.payload.stage).startsWith('synthesizer'));
      assert.equal(synthesisEvents[0]?.payload.finishReason, 'length');
      assert.equal(synthesisEvents[1]?.payload.finishReason, 'stop');
      const continuationDelta = events.find((event) => event.type === 'model.delta' && event.payload.stage === 'synthesizer:continuation:1');
      assert.equal(continuationDelta?.payload.content, '，续写已经接上并完整结束。');
      assert.equal(events.at(-1)?.type, 'task.completed');
    } finally {
      await store.close();
    }
  });

  test('keeps partial synthesis visible and fails transparently when continuations are exhausted', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await createTask(store, 'synthesis exhaustion');
      const model = new AlwaysTruncatedSynthesisModel();
      const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }))
        .run(task, new AbortController().signal);
      assert.equal(result.status, 'failed');
      assert.match(result.error ?? '', /输出达到上限/);
      assert.ok(result.result?.includes('已生成但被截断的部分'));
      const events = await store.getEvents(task.id);
      const failed = events.at(-1);
      assert.equal(failed?.type, 'task.failed');
      assert.equal(failed?.payload.partial, true);
      assert.equal(typeof failed?.payload.result, 'string');
      assert.equal(events.some((event) => event.type === 'task.completed'), false);
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
      assert.equal(modelEvents.find((event) => event.payload.stage === 'agent:research:round:1:attempt:2')?.payload.model, 'fast-model');
      assert.equal(modelEvents.find((event) => event.payload.stage === 'agent:analysis:round:1:attempt:1')?.payload.model, 'deep-model');
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

  test('persists write-scope scheduling decisions and monotonic graph revisions', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session-a',
        title: 'write scope scheduling',
        input: '比较两个部署方案。',
        mode: 'analyze',
      });
      const orchestrator = new WorkflowOrchestrator(store, new EventHub(), new WriteScopeModel(), memory, pino({ level: 'silent' }));
      const result = await orchestrator.run(task, new AbortController().signal);
      assert.equal(result.status, 'completed', result.error);
      const events = await store.getEvents(task.id);
      const queueUpdate = events.find((event) => event.type === 'queue.updated');
      assert.deepEqual(queueUpdate?.payload.selectedSteps, ['read', 'write-a']);
      assert.deepEqual(queueUpdate?.payload.deferredSteps, ['write-b']);
      const graphs = events.filter((event) => event.type === 'graph.updated')
        .map((event) => (event.payload.graph as { revision?: number; nodes?: Array<{ id: string; writeScopes?: string[]; executionWave?: number }> }));
      const revisions = graphs.map((graph) => graph.revision ?? 0);
      assert.ok(revisions.length >= 2);
      assert.ok(revisions.every((revision, index) => index === 0 || revision >= revisions[index - 1]!));
      assert.ok(new Set(revisions).size >= 2, 'a checkpoint or final delivery must advance the graph revision');
      const writeNode = graphs.at(-1)?.nodes?.find((node) => node.id === 'write-a');
      assert.deepEqual(writeNode?.writeScopes, ['deploy/config']);
      assert.equal(typeof writeNode?.executionWave, 'number');
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

  for (const requiresReview of [false, true]) test(`delivers a standalone HTML animation without human approval and preserves its file (quality review: ${requiresReview})`, async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    const workspace = await mkdtemp(join(tmpdir(), 'axiom-generated-animation-'));
    const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
    process.env.AXIOM_TOOL_EXECUTOR = 'docker';
    const content = '<!doctype html><html><body><svg viewBox="0 0 20 20"><circle r="4"><animate attributeName="cx" values="0;20;0" dur="2s" repeatCount="indefinite"/></circle></svg></body></html>';
    let builderCalls = 0;
    const model = new FakeModel();
    const fallback = model.complete.bind(model);
    model.complete = async (request) => {
      if (request.system.includes('independent reviewer')) {
        assert.ok(request.user.includes(content), 'The reviewer must inspect actual saved source, not only a generated link');
        return { content: JSON.stringify({ approved: true, score: 92, summary: '已检查动画源码，浏览器运行效果未验证。', gaps: [], requiredCorrections: [] }), attempts: 1, durationMs: 1 };
      }
      if (!request.system.includes('You are a builder')) return fallback(request);
      builderCalls += 1;
      assert.ok(request.tools?.some((tool) => tool.function.name === 'axiom_artifact_create'));
      if (builderCalls > 1) assert.match(request.user, /downloadUrl/);
      return { content: JSON.stringify({ output: '动画已生成。', confidence: 0.9, evidence: [],
        toolCalls: builderCalls === 1 ? [{ name: 'artifact.create', args: { filename: 'animation.html', content } }] : [] }), attempts: 1, durationMs: 1 };
    };
    try {
      const task = await store.createTask({ tenantId: 'tenant-animation', userId: 'user-a', sessionId: 'session-animation',
        title: 'Generate a standalone animation', input: '创建一个 HTML，内容是 SVG 绘制的 2D 动画。', mode: 'build',
        plan: { summary: '直接创建动画成果', routingReason: '单个工程师即可完成', approvalStatus: 'approved',
          profile: { kind: 'implementation', difficulty: 'easy', route: 'single-agent', score: 1, reasons: ['standalone deliverable'], maxSteps: 1, requiresReview },
          schedulingDecision: { route: 'single-agent', activeAgentIds: ['builder'], skippedAgentIds: [], appendAgentIds: ['builder'], selectedSkillIds: [], executionWaves: [['draw']],
            steps: [{ id: 'draw', title: '绘制动画', agentId: 'builder', objective: '生成 HTML 动画成果', dependsOn: [], skillIds: [] }], requiresReview, synthesisAgentId: 'synthesizer', reason: 'Standalone generation' },
          steps: [{ id: 'draw', title: '绘制动画', role: 'builder', objective: '生成 HTML 动画成果', dependsOn: [], acceptanceCriteria: ['可预览、下载'] }] } });
      const artifacts = new FileArtifactStore(workspace);
      const tools = new ToolRegistry({ execute: async () => { throw new Error('Standalone output must not execute shell commands'); } } as never, artifacts);
      const completed = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }), tools, undefined, undefined, undefined, artifacts)
        .run(task, new AbortController().signal);
      assert.equal(completed.status, 'completed', completed.error);
      assert.equal(builderCalls, 2, 'One creation followed by a real tool observation');
      const artifact = completed.stepResults.flatMap((step) => step.artifacts ?? []).find((item) => item.mimeType === 'text/html');
      assert.ok(artifact);
      assert.equal(await artifacts.get(artifact.id, task.tenantId), content);
      const url = `/api/tasks/${task.id}/artifacts/files/${encodeURIComponent(artifact.id)}`;
      assert.ok(completed.result?.includes(url), completed.result);
      assert.equal(completed.toolApprovals?.length ?? 0, 0);
      const events = await store.getEvents(task.id);
      assert.equal(events.some((event) => event.type === 'tool.approval_requested'), false);
      assert.equal(events.some((event) => event.type === 'review.started'), requiresReview);
      assert.ok(events.some((event) => event.type === 'artifact.created' && event.payload.id === artifact.id));
      assert.ok(events.some((event) => event.type === 'model.delta' && String(event.payload.content).includes(url)));
    } finally {
      if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
      else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
      await store.close();
      await rm(workspace, { recursive: true, force: true });
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
      assert.equal(model.builderCalls, 1, 'Approval resume reuses the persisted Agent decision.');
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

  test('service interruption checkpoints completed work without making its active successor a failed terminal step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axiom-interrupted-checkpoint-'));
    const filename = join(root, 'tasks.sqlite');
    let store = new SqliteTaskStore(filename);
    await store.initialize();
    const controller = new AbortController();
    let successorStarted!: () => void;
    const started = new Promise<void>((resolve) => { successorStarted = resolve; });
    const firstModel: ModelClient = {
      model: 'interrupted-checkpoint-fixture',
      async complete(request) {
        if (request.system.includes('You are a analyst sub-agent')) return { content: JSON.stringify({ output: 'Budget: 4700.', evidence: [], confidence: 0.9, toolCalls: [] }), attempts: 1, durationMs: 1 };
        successorStarted();
        await new Promise<never>((_resolve, reject) => {
          if (request.signal.aborted) reject(request.signal.reason);
          else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        });
        throw new Error('Interrupted output must never be returned.');
      },
    };
    try {
      const original = await store.createTask({ tenantId: 'tenant-a', userId: 'user-a', sessionId: 'interrupted-session', title: 'restart active successor', input: 'Analyze and deliver budget.', mode: 'build',
        plan: { summary: 'Analyze before delivery.', routingReason: 'Sequential checkpoint test.', approvalStatus: 'approved',
          profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 3, reasons: ['test'], maxSteps: 2, requiresReview: false },
          steps: [
            { id: 'analyze', title: 'Analyze', role: 'analyst', objective: 'Read budget.', dependsOn: [], acceptanceCriteria: ['Budget preserved.'] },
            { id: 'deliver', title: 'Deliver', role: 'builder', objective: 'Deliver budget.', dependsOn: ['analyze'], acceptanceCriteria: ['Budget delivered.'], failureStrategy: 'retry' },
          ] } });
      const run = new WorkflowOrchestrator(store, new EventHub(), firstModel, memory, pino({ level: 'silent' })).run(original, controller.signal);
      await Promise.race([started, run.then(() => { throw new Error('Task ended before active-step interruption.'); })]);
      controller.abort(new DOMException('Runtime shutting down', 'AbortError'));
      const interrupted = await run;
      assert.notEqual(interrupted.status, 'cancelled');
      assert.deepEqual(interrupted.stepResults.map((item) => item.stepId), ['analyze']);
      assert.equal(interrupted.stepResults[0]?.status, 'completed');
      const before = await store.getEvents(original.id);
      assert.equal(before.filter((event) => event.type === 'agent.failed').length, 0);
      assert.ok(before.some((event) => event.type === 'agent.interrupted' && event.payload.stepId === 'deliver'));

      await store.close();
      store = new SqliteTaskStore(filename);
      await store.initialize();
      const restored = await store.getTask(original.id);
      let deliveryCalls = 0;
      const recoveredModel: ModelClient = { model: 'recovered-checkpoint-fixture', async complete(request) {
        assert.ok(!request.system.includes('You are a analyst sub-agent'), 'completed predecessor must not execute again');
        assert.match(request.user, /4700/);
        const synthesis = request.system.includes('You are the synthesizer');
        if (!synthesis) deliveryCalls += 1;
        return { content: synthesis ? 'Delivered budget 4700.' : JSON.stringify({ output: 'Report budget: 4700.', evidence: [], confidence: 0.9, toolCalls: [] }), attempts: 1, durationMs: 1 };
      } };
      const completed = await new WorkflowOrchestrator(store, new EventHub(), recoveredModel, memory, pino({ level: 'silent' })).run(restored!, AbortSignal.timeout(5_000));
      assert.equal(completed.status, 'completed', completed.error);
      assert.equal(completed.result, 'Delivered budget 4700.');
      assert.equal(deliveryCalls, 1);
      assert.deepEqual(completed.stepResults.map((item) => item.stepId), ['analyze', 'deliver']);
      assert.ok(completed.stepResults.every((item) => item.status === 'completed'));
    } finally {
      controller.abort(new DOMException('Test cleanup', 'AbortError'));
      await store.close();
      await rm(root, { recursive: true, force: true });
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

  test('stores large step results by reference and dereferences them only for bounded review consumers', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    const objects = new Map<string, string>();
    const artifactStore = {
      kind: 'filesystem' as const,
      put: async (id: string, content: string) => { objects.set(id, content); return { key: id, bytes: Buffer.byteLength(content, 'utf8') }; },
      get: async (id: string) => objects.get(id) ?? null,
      delete: async (id: string) => { objects.delete(id); },
      health: async () => ({ configured: true, reachable: true, detail: 'ok' }),
    };
    try {
      const profile = { kind: 'implementation' as const, difficulty: 'moderate' as const, route: 'team' as const, score: 4, reasons: ['long result'], maxSteps: 2, requiresReview: false };
      const task = await store.createTask({
        tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', title: 'long result reference',
        input: '生成详细分析，并据此形成实施方案。', mode: 'build',
        plan: {
          summary: '详细分析后形成实施方案。', routingReason: '第二步依赖第一步。', profile,
          steps: [
            { id: 'analysis', title: '详细分析', role: 'analyst', objective: '输出详细分析。', dependsOn: [], acceptanceCriteria: ['分析完整'] },
            { id: 'delivery', title: '形成方案', role: 'builder', objective: '基于分析形成方案。', dependsOn: ['analysis'], acceptanceCriteria: ['方案可执行'] },
          ],
          version: 1, approvalStatus: 'approved',
        },
      });
      const model = new LargeResultReferenceModel();
      const result = await new WorkflowOrchestrator(
        store, new EventHub(), model, memory, pino({ level: 'silent' }),
        undefined, undefined, undefined, undefined, artifactStore,
      ).run(task, new AbortController().signal);
      const analysis = result.stepResults.find((step) => step.stepId === 'analysis');
      assert.equal(result.status, 'completed');
      assert.ok(analysis?.resultRef?.id.startsWith(`step-result:${task.id}:analysis:`));
      assert.equal(analysis?.outputTruncated, true);
      assert.equal(analysis?.outputChars, model.largeOutput.length);
      assert.equal(objects.get(analysis!.resultRef!.id), model.largeOutput);
      assert.match(model.downstreamRequest?.user ?? '', /result_ref: step-result:/);
      assert.doesNotMatch(model.downstreamRequest?.user ?? '', /完整上游证据。完整上游证据。完整上游证据。/);
      assert.ok(model.synthesisRequest?.artifactRefs?.includes(analysis!.resultRef!.id));
      assert.match(model.synthesisRequest?.user ?? '', /完整上游证据。完整上游证据。完整上游证据。/);
      const events = await store.getEvents(task.id);
      assert.ok(events.some((event) => event.type === 'artifact.created' && event.payload.id === analysis?.resultRef?.id));
      assert.ok(events.some((event) => event.type === 'model.completed'
        && event.payload.promptCacheHitTokens === 60
        && event.payload.promptCacheMissTokens === 40
        && typeof event.payload.cacheKey === 'string'));
      assert.ok(events.some((event) => event.type === 'model.completed'
        && event.payload.stage === 'synthesizer'
        && Array.isArray(event.payload.artifactRefs)
        && event.payload.artifactRefs.includes(analysis?.resultRef?.id)));
    } finally {
      await store.close();
    }
  });

  test('keeps the full large step result in the task database when Artifact storage is unavailable', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    const artifactStore = {
      kind: 'filesystem' as const,
      put: async () => { throw new Error('object store unavailable'); },
      get: async () => null,
      delete: async () => undefined,
      health: async () => ({ configured: true, reachable: false, detail: 'offline' }),
    };
    try {
      const profile = { kind: 'implementation' as const, difficulty: 'moderate' as const, route: 'team' as const, score: 4, reasons: ['long result'], maxSteps: 2, requiresReview: false };
      const task = await store.createTask({
        tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', title: 'long result fallback',
        input: '生成详细分析，并据此形成实施方案。', mode: 'build',
        plan: {
          summary: '详细分析后形成实施方案。', routingReason: '第二步依赖第一步。', profile,
          steps: [
            { id: 'analysis', title: '详细分析', role: 'analyst', objective: '输出详细分析。', dependsOn: [], acceptanceCriteria: ['分析完整'] },
            { id: 'delivery', title: '形成方案', role: 'builder', objective: '基于分析形成方案。', dependsOn: ['analysis'], acceptanceCriteria: ['方案可执行'] },
          ],
          version: 1, approvalStatus: 'approved',
        },
      });
      const model = new LargeResultReferenceModel();
      const result = await new WorkflowOrchestrator(
        store, new EventHub(), model, memory, pino({ level: 'silent' }),
        undefined, undefined, undefined, undefined, artifactStore,
      ).run(task, new AbortController().signal);
      const analysis = result.stepResults.find((step) => step.stepId === 'analysis');
      const persisted = await store.getTask(task.id, task.tenantId);
      assert.equal(result.status, 'completed');
      assert.equal(analysis?.resultRef, undefined);
      assert.equal(analysis?.outputTruncated, undefined);
      assert.equal(analysis?.output, model.largeOutput);
      assert.equal(persisted?.stepResults.find((step) => step.stepId === 'analysis')?.output, model.largeOutput);
      assert.doesNotMatch(model.downstreamRequest?.user ?? '', /result_ref: step-result:/);
      assert.equal((await store.getEvents(task.id)).some((event) => event.type === 'artifact.created' && event.payload.kind === 'step-output'), false);
    } finally {
      await store.close();
    }
  });

  test('answers agent catalog questions from the runtime registry', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const model = new FakeModel();
      const complete = model.complete.bind(model);
      const systems: string[] = [];
      model.complete = async (request) => { systems.push(request.system); return complete(request); };
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
        model,
        memory,
        pino({ level: 'silent' }),
      ).run(task, new AbortController().signal);
      assert.equal(result.status, 'completed');
      assert.ok(systems.some((system) => system.includes('500 Chinese characters or 180 English words')
        && system.includes('explicitly asks for a full technical inventory') && system.includes('Compute any counts from the snapshot')));
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
