import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';
import { enforceChatRouteSafety, fallbackChatRoute, routeChatIntent, RoutingUnavailableError, summarizeRoutingDiagnostics, workflowPlanFromChatRoute, type RoutingDiagnostic, type RoutingModelCall } from './chatRouter.js';
import { explicitlyDisablesRetrieval } from '../shared/chatRoutingFallback.js';

class RouteModel implements ModelClient {
  readonly model = 'route-model';
  readonly requests: ModelCompletionRequest[] = [];
  private readonly outputs: string[];
  constructor(content: string | string[]) {
    this.outputs = Array.isArray(content) ? [...content] : [content];
  }
  async complete(_request: ModelCompletionRequest) {
    this.requests.push(_request);
    return { content: this.outputs.shift() ?? '{}', attempts: 1, durationMs: 1 };
  }
}

const routerOutput = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  intent: 'task',
  taskKind: 'implementation',
  difficulty: 'hard',
  requiresExternalFacts: false,
  requiredCapabilities: ['architecture', 'implementation'],
  candidateAgentIds: ['researcher', 'analyst', 'builder'],
  candidateSkillIds: ['architecture-design', 'implementation'],
  confidence: 0.91,
  rationale: '本轮需要先分析架构，再形成可执行实现。',
  ...overrides,
});

const schedulerOutput = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  route: 'full-workflow',
  activeAgentIds: ['researcher', 'analyst', 'builder'],
  skippedAgentIds: [],
  appendAgentIds: ['researcher', 'analyst', 'builder'],
  selectedSkillIds: ['architecture-design', 'implementation'],
  executionWaves: [['research', 'analysis'], ['delivery']],
  steps: [
    { id: 'research', title: '约束梳理', agentId: 'researcher', objective: '梳理边界和依赖。', dependsOn: [], skillIds: ['architecture-design'] },
    { id: 'analysis', title: '架构分析', agentId: 'analyst', objective: '形成架构与取舍。', dependsOn: [], skillIds: ['architecture-design'] },
    { id: 'delivery', title: '实现计划', agentId: 'builder', objective: '形成实现与测试计划。', dependsOn: ['research', 'analysis'], skillIds: ['implementation'] },
  ],
  requiresReview: false,
  synthesisAgentId: 'synthesizer',
  reason: '三个 Agent 分两波执行，避免无关角色参与。',
  ...overrides,
});

test('routing diagnostics measure Router and Scheduler separately without exposing prompts', async () => {
  const measurements: Array<Record<string, unknown>> = [];
  const decision = await routeChatIntent({ message: 'Design a platform', mode: 'build', onModelCall: (measurement) => measurements.push({ ...measurement }) },
    new RouteModel([routerOutput(), schedulerOutput()]), new AbortController().signal);
  assert.equal(decision.source, 'router-agent');
  assert.deepEqual(measurements.map((item) => item.stage), ['router', 'scheduler']);
  assert.ok(measurements.every((item) => item.status === 'completed' && item.totalTokens === null && Number(item.promptCharacters) > 0));
  assert.ok(measurements.every((item) => !('user' in item) && !('system' in item)));
  const failed: Array<Record<string, unknown>> = [];
  const degraded = await routeChatIntent({ message: 'Compare official sources and verify the recommendation.', mode: 'decide', onModelCall: (measurement) => failed.push({ ...measurement }) },
    { model: 'unavailable', async complete() { throw new Error('Injected disconnect'); } }, new AbortController().signal);
  assert.equal(degraded.source, 'deterministic-fallback');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.status, 'failed');
  assert.equal(failed[0]!.totalTokens, null);
});

test('diagnostic observers cannot turn a healthy model route into fallback', async () => {
  let observed = 0;
  const decision = await routeChatIntent({ message: 'Design a platform', mode: 'build', onModelCall: () => {
    observed += 1;
    throw new Error('Injected diagnostic observer failure');
  } }, new RouteModel([routerOutput(), schedulerOutput()]), new AbortController().signal);
  assert.equal(decision.source, 'router-agent');
  assert.equal(observed, 2);
});

test('Router Agent and Scheduler Agent produce the durable graph that executes this turn', async () => {
  const decision = await routeChatIntent(
    {
      message: '设计并实现一个生产级平台，给出架构、接口和测试方案',
      mode: 'build',
      currentGraph: {
        nodes: [{ id: 'old-search', agentId: 'search-agent', role: 'search-agent', title: '联网搜索 Agent', dependsOn: [], status: 'completed' }],
        edges: [],
      },
    },
    new RouteModel([routerOutput(), schedulerOutput({ skippedAgentIds: ['search-agent'] })]),
    new AbortController().signal,
  );
  assert.equal(decision.source, 'router-agent');
  assert.equal(decision.execution, 'workflow');
  assert.deepEqual(decision.scheduler.executionWaves, [['research', 'analysis'], ['delivery']]);
  assert.ok(decision.scheduler.skippedAgentIds.includes('search-agent'));
  const plan = workflowPlanFromChatRoute(decision);
  assert.deepEqual(plan?.steps.map((step) => step.role), ['researcher', 'analyst', 'builder']);
  assert.deepEqual(plan?.graph?.nodes.filter((node) => !['orchestrator', 'synthesizer'].includes(node.role)).map((node) => node.role), ['researcher', 'analyst', 'builder']);
  assert.equal(plan?.routingDecision?.confidence, 0.91);
  assert.equal(plan?.schedulingDecision?.reason, decision.scheduler.reason);
});

test('a follow-up turn may skip the old graph and use one direct Agent', async () => {
  const decision = await routeChatIntent(
    {
      message: '把刚才结论压缩成一句话',
      mode: 'analyze',
      currentGraph: {
        nodes: [
          { id: 'research', agentId: 'researcher-research', role: 'researcher', title: '研究员', dependsOn: [], status: 'completed' },
          { id: 'analysis', agentId: 'analyst-analysis', role: 'analyst', title: '分析员', dependsOn: [], status: 'completed' },
        ],
        edges: [],
      },
    },
    new RouteModel([
      routerOutput({ taskKind: 'question', difficulty: 'easy', requiredCapabilities: ['answer'], candidateAgentIds: ['direct-responder'], candidateSkillIds: [], confidence: 0.95, rationale: '只需压缩已有上下文。' }),
      schedulerOutput({ route: 'direct', activeAgentIds: ['direct-responder'], skippedAgentIds: ['researcher', 'analyst'], appendAgentIds: ['direct-responder'], selectedSkillIds: [], executionWaves: [], steps: [], requiresReview: false, reason: '本轮不需要重跑旧 Agent。' }),
    ]),
    new AbortController().signal,
  );
  assert.equal(decision.source, 'router-agent');
  assert.equal(decision.workflowRoute, 'direct');
  assert.deepEqual(decision.scheduler.activeAgentIds, ['direct-responder']);
  assert.ok(decision.scheduler.skippedAgentIds.includes('researcher'));
});

test('a conversational Router decision discards redundant Scheduler steps without using regex fallback', async () => {
  const decision = await routeChatIntent(
    { message: '你好，介绍一下你自己', mode: 'analyze' },
    new RouteModel([
      routerOutput({
        intent: 'conversation', taskKind: 'conversation', difficulty: 'trivial', requiredCapabilities: ['conversation'],
        candidateAgentIds: ['direct-responder'], candidateSkillIds: [], confidence: 0.97, rationale: '普通寒暄。',
      }),
      schedulerOutput({
        route: 'single-agent', activeAgentIds: ['direct-responder'], appendAgentIds: ['direct-responder'], selectedSkillIds: [],
        executionWaves: [['reply']], steps: [{ id: 'reply', title: '直接回答', agentId: 'direct-responder', objective: '完成寒暄。', dependsOn: [], skillIds: [] }],
        requiresReview: false, reason: '直接回答即可。',
      }),
    ]),
    new AbortController().signal,
  );
  assert.equal(decision.source, 'router-agent');
  assert.equal(decision.intent, 'conversation');
  assert.equal(decision.workflowRoute, 'direct');
  assert.deepEqual(decision.scheduler.activeAgentIds, ['direct-responder']);
  assert.deepEqual(decision.scheduler.steps, []);
});

test('server route safety prevents a stale conversation decision from bypassing explicit capabilities', () => {
  const input = { message: '帮我生成一张未来城市海报', mode: 'build' as const };
  const stale = fallbackChatRoute({ message: '你好', mode: 'analyze' });
  const guarded = enforceChatRouteSafety(stale, input);
  assert.equal(guarded.intent, 'image-generation');
  assert.equal(guarded.agentRole, 'drawing-agent');
  assert.equal(guarded.execution, 'gateway');
});

test('server route safety keeps a model-selected retrieval workflow intact', () => {
  const input = { message: '搜索最新的 Agent 框架并比较架构、成本和落地风险', mode: 'analyze' as const };
  const fallback = fallbackChatRoute(input);
  const taskDecision = {
    ...fallbackChatRoute({ message: '设计一个平台', mode: 'analyze' }),
    source: 'router-agent' as const,
    intent: 'task' as const,
    execution: 'workflow' as const,
    agentRole: 'orchestrator',
    workflowRoute: 'team' as const,
  };
  const guarded = enforceChatRouteSafety(taskDecision, input);
  assert.equal(fallback.intent, 'task');
  assert.equal(fallback.requiresSearch, true);
  assert.ok(fallback.scheduler.steps.find((step) => step.agentId === 'analyst')?.dependsOn.includes('research'));
  assert.equal(guarded.intent, 'task');
  assert.equal(guarded.execution, 'workflow');
  assert.deepEqual(guarded.scheduler.steps, taskDecision.scheduler.steps);
});

test('server route safety normalizes task execution to match its workflow route', () => {
  const base = fallbackChatRoute({ message: '设计一个需要分析和实现的服务', mode: 'build' });
  const stale = {
    ...base,
    intent: 'task' as const,
    execution: 'gateway' as const,
    agentRole: 'analyst',
    workflowRoute: 'team' as const,
    scheduler: { ...base.scheduler, route: 'single-agent' as const },
  };
  const guarded = enforceChatRouteSafety(stale, { message: '设计一个需要分析和实现的服务', mode: 'build' });
  assert.equal(guarded.execution, 'workflow');
  assert.equal(guarded.workflowRoute, 'team');
  assert.equal(guarded.agentRole, 'orchestrator');
  assert.equal(guarded.scheduler.route, 'team');
});

test('server route safety normalizes direct task routes to the gateway', () => {
  const base = fallbackChatRoute({ message: '回答一个简单问题', mode: 'analyze' });
  const stale = {
    ...base,
    intent: 'task' as const,
    execution: 'workflow' as const,
    agentRole: 'orchestrator',
    workflowRoute: 'direct' as const,
    scheduler: { ...base.scheduler, route: 'team' as const },
  };
  const guarded = enforceChatRouteSafety(stale, { message: '回答一个简单问题', mode: 'analyze' });
  assert.equal(guarded.execution, 'gateway');
  assert.equal(guarded.workflowRoute, 'direct');
  assert.equal(guarded.agentRole, 'direct-responder');
  assert.deepEqual(guarded.scheduler.steps, []);
});

test('composite task routes retain the external-facts requirement', () => {
  const base = fallbackChatRoute({ message: '设计平台并搜索最新开源方案', mode: 'build' });
  const routed = {
    ...base,
    intent: 'task' as const,
    execution: 'workflow' as const,
    workflowRoute: 'team' as const,
    agentRole: 'orchestrator',
    requiresSearch: false,
    router: {
      ...base.router,
      intent: 'task' as const,
      requiresExternalFacts: true,
      candidateAgentIds: ['researcher', 'analyst', 'search-agent'],
    },
  };
  const guarded = enforceChatRouteSafety(routed, { message: '设计平台并搜索最新开源方案', mode: 'build' });
  assert.equal(guarded.requiresSearch, true);
});

test('Router accepts null for an omitted optional report export field', async () => {
  const decision = await routeChatIntent(
    { message: '你好，介绍一下你自己', mode: 'analyze' },
    new RouteModel([
      routerOutput({
        intent: 'conversation',
        taskKind: 'conversation',
        difficulty: 'trivial',
        requiredCapabilities: ['conversation'],
        candidateAgentIds: ['direct-responder'],
        candidateSkillIds: [],
        confidence: 0.95,
        reportExport: null,
      }),
      schedulerOutput({
        route: 'direct',
        activeAgentIds: ['direct-responder'],
        skippedAgentIds: [],
        appendAgentIds: ['direct-responder'],
        selectedSkillIds: [],
        executionWaves: [],
        steps: [],
        requiresReview: false,
      }),
    ]),
    new AbortController().signal,
  );
  assert.equal(decision.source, 'router-agent');
  assert.equal(decision.intent, 'conversation');
  assert.equal(decision.reportExport, undefined);
});

test('Router task fields correct a contradictory conversation intent before scheduling', async () => {
  const decision = await routeChatIntent(
    { message: '比较 PostgreSQL 与 SQLite 的多 worker 部署风险', mode: 'decide' },
    new RouteModel([
      routerOutput({
        intent: 'conversation', taskKind: 'decision', difficulty: 'moderate', requiredCapabilities: ['analysis'],
        candidateAgentIds: ['direct-responder', 'analyst'], candidateSkillIds: ['architecture-design'], confidence: 0.9, rationale: '需要完成部署取舍。',
      }),
      schedulerOutput({
        route: 'single-agent', activeAgentIds: ['analyst'], appendAgentIds: ['analyst'], selectedSkillIds: ['architecture-design'],
        executionWaves: [['analysis']], steps: [{ id: 'analysis', title: '部署取舍', agentId: 'analyst', objective: '比较并给出风险结论。', dependsOn: [], skillIds: ['architecture-design'] }],
        requiresReview: false, reason: '分析 Agent 足够完成本轮。',
      }),
    ]),
    new AbortController().signal,
  );
  assert.equal(decision.source, 'router-agent');
  assert.equal(decision.intent, 'task');
  assert.equal(decision.workflowRoute, 'single-agent');
  assert.deepEqual(decision.router.candidateAgentIds, ['analyst']);
  assert.deepEqual(decision.scheduler.activeAgentIds, ['analyst']);
});

test('Scheduler steps drive active Agents, review state, and a proportionate two-Agent route', async () => {
  const decision = await routeChatIntent(
    { message: '修复空指针问题并给出测试', mode: 'build' },
    new RouteModel([
      routerOutput({
        difficulty: 'hard', requiredCapabilities: ['implementation', 'quality-review'], candidateAgentIds: ['builder', 'reviewer'],
        candidateSkillIds: ['implementation', 'quality-review'], confidence: 0.92, rationale: '实现后需要验证。',
      }),
      schedulerOutput({
        route: 'full-workflow', activeAgentIds: ['reviewer', 'builder'], appendAgentIds: ['reviewer'],
        selectedSkillIds: ['quality-review', 'implementation'], executionWaves: [['wrong']], requiresReview: false,
        synthesisAgentId: 'summary-agent',
        steps: [
          { id: 'fix', title: '完成修复', agentId: 'builder', objective: '修复问题并编写测试。', dependsOn: [], skillIds: ['implementation'] },
          { id: 'review', title: '验证修复', agentId: 'reviewer', objective: '运行测试并检查回归。', dependsOn: ['fix'], skillIds: ['quality-review'] },
        ],
        reason: '实现和验证按依赖执行。',
      }),
    ]),
    new AbortController().signal,
  );
  assert.equal(decision.source, 'router-agent');
  assert.equal(decision.workflowRoute, 'team');
  assert.deepEqual(decision.scheduler.activeAgentIds, ['builder', 'reviewer']);
  assert.deepEqual(decision.scheduler.executionWaves, [['fix'], ['review']]);
  assert.equal(decision.scheduler.requiresReview, true);
});

test('unknown Agent ids or low confidence fail closed to deterministic fallback', async () => {
  const invalid = await routeChatIntent(
    { message: '设计一个服务', mode: 'build' },
    new RouteModel([routerOutput({ candidateAgentIds: ['invented-agent'] }), schedulerOutput()]),
    new AbortController().signal,
  );
  assert.equal(invalid.source, 'deterministic-fallback');
  assert.equal(invalid.router.candidateAgentIds.includes('invented-agent'), false);

  const uncertain = await routeChatIntent(
    { message: '分析这个需求', mode: 'analyze' },
    new RouteModel([routerOutput({ confidence: 0.2 }), schedulerOutput()]),
    new AbortController().signal,
  );
  assert.equal(uncertain.source, 'deterministic-fallback');
});

test('a valid Router and Scheduler decision is not bounded by the regex triage score', async () => {
  const message = '设计一个平台，包含前端、后端和数据流';
  assert.notEqual(fallbackChatRoute({ message, mode: 'analyze' }).workflowRoute, 'single-agent');
  const decision = await routeChatIntent(
    { message, mode: 'analyze' },
    new RouteModel([
      routerOutput({ taskKind: 'question', difficulty: 'moderate', requiredCapabilities: ['architecture'], candidateAgentIds: ['analyst'], candidateSkillIds: ['architecture-design'], confidence: 0.88, rationale: '当前只要求方案分析，不要求真实构建。' }),
      schedulerOutput({ route: 'single-agent', activeAgentIds: ['analyst'], skippedAgentIds: [], appendAgentIds: ['analyst'], selectedSkillIds: ['architecture-design'], executionWaves: [['analysis']], steps: [{ id: 'analysis', title: '平台方案分析', agentId: 'analyst', objective: '给出前后端边界和数据流。', dependsOn: [], skillIds: ['architecture-design'] }], requiresReview: false, reason: '一个架构分析 Agent 足够完成本轮。' }),
    ]),
    new AbortController().signal,
  );
  assert.equal(decision.source, 'router-agent');
  assert.equal(decision.workflowRoute, 'single-agent');
  assert.deepEqual(decision.scheduler.activeAgentIds, ['analyst']);
});

test('semantic routing assigns search, registry, and task intents to real execution paths', async () => {
  const search = await routeChatIntent(
    { message: '今天北京天气怎么样', mode: 'analyze' },
    new RouteModel('{"intent":"web-search","workflowRoute":"direct","reason":"需要实时天气"}'),
    new AbortController().signal,
  );
  assert.equal(search.agentRole, 'search-agent');
  assert.equal(search.requiresSearch, true);
  assert.equal(search.execution, 'gateway');

  const registry = await routeChatIntent(
    { message: '现在有哪些 Agent', mode: 'analyze' },
    new RouteModel('{"intent":"agent-registry","workflowRoute":"direct","reason":"需要查询运行时注册表"}'),
    new AbortController().signal,
  );
  assert.equal(registry.agentRole, 'registry-agent');

  const comparison = await routeChatIntent(
    { message: '比较 PostgreSQL 与 SQLite 在多 worker 部署中的风险和取舍', mode: 'decide' },
    new RouteModel('{"intent":"task","workflowRoute":"team","reason":"需要并行比较多个部署权衡"}'),
    new AbortController().signal,
  );
  assert.equal(comparison.execution, 'workflow');
  assert.equal(comparison.workflowRoute, 'team');
});

test('attachment routing remains deterministic when the semantic model is unavailable', async () => {
  const image = fallbackChatRoute({ message: '分析附件', mode: 'analyze', attachments: [{ name: 'screen.png', mimeType: 'image/png' }] });
  assert.equal(image.intent, 'image-analysis');
  assert.equal(image.agentRole, 'vision-agent');

  const document = fallbackChatRoute({ message: '总结报告', mode: 'analyze', attachments: [{ name: 'report.pdf', mimeType: 'application/pdf' }] });
  assert.equal(document.intent, 'document-analysis');
  assert.equal(document.agentRole, 'document-agent');
});

test('explicit video requests stay on the video Agent even when semantic routing disagrees', async () => {
  const decision = await routeChatIntent(
    { message: '制作一段三十秒的产品介绍视频', mode: 'build' },
    new RouteModel('{"intent":"image-generation","workflowRoute":"direct","reason":"误判为图片"}'),
    new AbortController().signal,
  );
  assert.equal(decision.intent, 'video-generation');
  assert.equal(decision.agentRole, 'video-agent');
  assert.equal(decision.execution, 'gateway');
});

test('fallback routing assigns every specialist intent before ordinary task classification', () => {
  const cases = [
    ['你在吗', 'conversation', 'direct-responder'],
    ['搜索最近的水文论文和 DOI', 'academic-search', 'academic-search-agent'],
    ['查看 GitHub 上 mirros-lab/harnesseval-w 的最新代码', 'github-research', 'github-research-agent'],
    ['生成一张未来城市图片', 'image-generation', 'drawing-agent'],
    ['制作一段产品介绍视频', 'video-generation', 'video-agent'],
    ['查询今天上海天气', 'web-search', 'search-agent'],
    ['现在有哪些可用智能体', 'agent-registry', 'registry-agent'],
  ] as const;
  for (const [message, intent, role] of cases) {
    const decision = fallbackChatRoute({ message, mode: 'analyze' });
    assert.equal(decision.intent, intent, message);
    assert.equal(decision.agentRole, role, message);
  }
});

test('Agent Registry fallback does not inherit live-search metadata from its reason', () => {
  const decision = fallbackChatRoute({ message: '你有哪些子智能体', mode: 'analyze' });
  assert.equal(decision.intent, 'agent-registry');
  assert.equal(decision.agentRole, 'registry-agent');
  assert.equal(decision.requiresSearch, false);
  assert.deepEqual(decision.skillIds, []);
  assert.equal(decision.router.requiresExternalFacts, false);
});

test('Report Agent routes explicit exports while ordinary report writing remains a task', async () => {
  const lastAnswer = await routeChatIntent(
    { message: '把以上回答导出为 Word 报告并下载', mode: 'analyze' },
    new RouteModel([
      routerOutput({
        intent: 'report-export', taskKind: 'operations', difficulty: 'easy', requiresExternalFacts: false,
        requiredCapabilities: ['report-export'], candidateAgentIds: ['report-agent'], candidateSkillIds: ['report-export'],
        confidence: 0.98, rationale: '用户明确要求把现有回答导出为 Word 文件。',
        reportExport: { scope: 'last-answer', format: 'docx' },
      }),
      schedulerOutput({
        route: 'direct', activeAgentIds: ['report-agent'], skippedAgentIds: [], appendAgentIds: ['report-agent'],
        selectedSkillIds: ['report-export'], executionWaves: [], steps: [], requiresReview: false,
        reason: '报告生成 Agent 直接处理文件导出。',
      }),
    ]),
    new AbortController().signal,
  );
  assert.equal(lastAnswer.intent, 'report-export');
  assert.equal(lastAnswer.agentRole, 'report-agent');
  assert.deepEqual(lastAnswer.reportExport, { scope: 'last-answer', format: 'docx' });

  const conversation = fallbackChatRoute({ message: '把整个对话导出 PDF', mode: 'analyze' });
  assert.equal(conversation.intent, 'report-export');
  assert.deepEqual(conversation.reportExport, { scope: 'conversation', format: 'pdf' });

  const writeOnly = fallbackChatRoute({ message: '帮我写一份详细的水库研究报告', mode: 'analyze' });
  assert.equal(writeOnly.intent, 'task');
  assert.equal(writeOnly.reportExport, undefined);
});

test('explicit export intent survives a semantic Router Agent misclassification', async () => {
  const decision = await routeChatIntent(
    { message: '把以上回答导出为 PDF', mode: 'analyze' },
    new RouteModel([
      routerOutput({
        intent: 'task', taskKind: 'question', difficulty: 'easy', requiredCapabilities: ['direct-responder'],
        candidateAgentIds: ['direct-responder'], candidateSkillIds: [], confidence: 0.98,
        rationale: '模型误将导出请求当成普通问答。',
      }),
      schedulerOutput({
        route: 'direct', activeAgentIds: ['direct-responder'], appendAgentIds: ['direct-responder'],
        selectedSkillIds: [], steps: [], executionWaves: [], reason: '误判为直接回答。',
      }),
    ]),
    new AbortController().signal,
  );
  assert.equal(decision.intent, 'report-export');
  assert.equal(decision.agentRole, 'report-agent');
  assert.deepEqual(decision.reportExport, { scope: 'last-answer', format: 'pdf' });
  assert.ok(decision.reason.includes('导出'));
});

test('routes system design without an explicit Agent name and selects only relevant skills', async () => {
  const fallback = fallbackChatRoute({ message: '设计一个平台，包含前端、后端和数据流', mode: 'analyze' });
  assert.equal(fallback.intent, 'task');
  assert.ok(['team', 'full-workflow'].includes(fallback.workflowRoute));
  assert.equal(fallback.agentRole, 'orchestrator');
  assert.ok(fallback.skillIds.includes('architecture-design'));
  assert.equal(fallback.skillIds.includes('web-research'), false);

  const semantic = await routeChatIntent(
    { message: '设计一个平台，包含前端、后端和数据流', mode: 'analyze' },
    new RouteModel('{"intent":"task","workflowRoute":"direct","reason":"模型低估了系统范围"}'),
    new AbortController().signal,
  );
  assert.equal(semantic.workflowRoute, fallback.workflowRoute);
  assert.ok(semantic.skillIds.includes('architecture-design'));
});

test('maps specialist intents to their skill bundles without adding unrelated capabilities', () => {
  const search = fallbackChatRoute({ message: '查询今天上海天气', mode: 'analyze' });
  assert.ok(search.skillIds.includes('web-research'));
  assert.ok(search.skillIds.includes('evidence-research'));
  assert.equal(search.skillIds.includes('visual-generation'), false);

  const drawing = fallbackChatRoute({ message: '生成一张未来城市插画', mode: 'analyze' });
  assert.ok(drawing.skillIds.includes('visual-generation'));
  assert.equal(drawing.skillIds.includes('web-research'), false);
});

test('explicit multi-agent sequences always enter the full workflow', () => {
  const message = '请为一个面向普通用户的多智能体平台设计生产级架构：先由搜索 Agent 检索最新开源方案，再由架构 Agent 设计服务拆分与数据流，由数据库 Agent 比较 PostgreSQL 和 SQLite，由实现 Agent 制定 API、SSE 流式输出、MemoryCore 持久化与 Harness 断点恢复方案，若发现安全或性能风险则进入修复 Loop，最后由 Reviewer 审核并由 Synthesizer 输出可执行的落地计划。';
  const decision = fallbackChatRoute({ message, mode: 'build' });
  assert.equal(decision.intent, 'task');
  assert.equal(decision.execution, 'workflow');
  assert.equal(decision.workflowRoute, 'full-workflow');
  assert.equal(decision.agentRole, 'orchestrator');
  assert.equal(decision.requiresSearch, true);
});

test('semantic specialist misclassification cannot downgrade an explicit workflow', async () => {
  const message = '先由搜索 Agent 检索开源方案，再由架构 Agent 设计服务拆分，最后由 Reviewer 审核交付。';
  const decision = await routeChatIntent(
    { message, mode: 'build' },
    new RouteModel('{"intent":"github-research","workflowRoute":"direct","reason":"模型误判为仓库查询"}'),
    new AbortController().signal,
  );
  assert.equal(decision.intent, 'task');
  assert.equal(decision.execution, 'workflow');
  assert.equal(decision.workflowRoute, 'full-workflow');
  assert.equal(decision.agentRole, 'orchestrator');
});

test('capability questions remain registry requests without substring false positives', () => {
  for (const message of ['你有联网搜索的能力吗', '你能进行联网搜索吗', '你支持图片识别吗']) {
    const capability = fallbackChatRoute({ message, mode: 'analyze' });
    assert.equal(capability.intent, 'agent-registry', message);
    assert.equal(capability.agentRole, 'registry-agent', message);
    assert.equal(capability.execution, 'gateway', message);
    assert.equal(capability.requiresSearch, false, message);
    assert.deepEqual(capability.skillIds, [], message);
    assert.equal(capability.router.requiresExternalFacts, false, message);
  }

  const ordinary = fallbackChatRoute({ message: '智能体如何协作完成一个系统设计？', mode: 'analyze' });
  assert.notEqual(ordinary.intent, 'agent-registry');
});

test('mentioning multi-agent alone does not force a full workflow', () => {
  const decision = fallbackChatRoute({ message: '什么是多智能体系统？', mode: 'analyze' });
  assert.notEqual(decision.workflowRoute, 'full-workflow');
});

test('open-source project lookup remains a GitHub specialist request', () => {
  const decision = fallbackChatRoute({ message: '有哪些值得参考的开源游戏 GitHub 项目？', mode: 'analyze' });
  assert.equal(decision.intent, 'github-research');
  assert.equal(decision.agentRole, 'github-research-agent');
});

test('mixed attachments preserve the semantic multi-agent plan through server validation', async () => {
  const input = { message: 'Compare the diagram and design document, then implement the agreed changes.', mode: 'build' as const, attachments: [{ name: 'diagram.png' }, { name: 'design.pdf', mimeType: 'application/pdf' }] };
  const steps = [
    { id: 'diagram', title: 'Inspect diagram', agentId: 'vision-agent', objective: 'Read the supplied architecture image.', dependsOn: [], skillIds: [] },
    { id: 'document', title: 'Read design', agentId: 'document-agent', objective: 'Read the design document.', dependsOn: [], skillIds: [] },
    { id: 'build', title: 'Implement changes', agentId: 'builder', objective: 'Implement the agreed changes with tests.', dependsOn: ['diagram', 'document'], skillIds: ['implementation'] },
  ];
  const decision = await routeChatIntent(input, new RouteModel([
    routerOutput({ candidateAgentIds: ['vision-agent', 'document-agent', 'builder'], candidateSkillIds: ['implementation'] }),
    schedulerOutput({ activeAgentIds: ['vision-agent', 'document-agent', 'builder'], appendAgentIds: [], selectedSkillIds: ['implementation'], steps }),
  ]), new AbortController().signal);
  assert.equal(decision.source, 'router-agent');
  assert.equal(decision.intent, 'task');
  assert.deepEqual(decision.scheduler.steps, steps);
  assert.ok(decision.router.requiredCapabilities.includes('image-analysis'));
  assert.ok(decision.router.requiredCapabilities.includes('document-analysis'));
  const guarded = enforceChatRouteSafety(decision, input);
  assert.deepEqual(guarded.scheduler.steps, steps);
  assert.equal(guarded.execution, 'workflow');
  assert.deepEqual(workflowPlanFromChatRoute(guarded)?.steps.slice(0, 2).map((step) => step.agentContract?.agentId), ['vision-agent', 'document-agent']);
});

test('missing attachment stages supplement the chosen task instead of discarding its work', async () => {
  const input = { message: 'Implement this design.', mode: 'build' as const, attachments: [{ kind: 'image', name: 'sketch' }, { kind: 'file', name: 'requirements.txt' }] };
  const decision = await routeChatIntent(input, new RouteModel([
    routerOutput({ candidateAgentIds: ['builder'], candidateSkillIds: ['implementation'] }),
    schedulerOutput({ route: 'single-agent', activeAgentIds: ['builder'], appendAgentIds: [], selectedSkillIds: ['implementation'], steps: [{ id: 'implement', title: 'Implement', agentId: 'builder', objective: 'Keep the model-selected implementation objective.', dependsOn: [], skillIds: ['implementation'] }] }),
  ]), new AbortController().signal);
  assert.equal(decision.source, 'router-agent');
  assert.deepEqual(decision.scheduler.activeAgentIds, ['vision-agent', 'document-agent', 'builder']);
  assert.equal(decision.scheduler.steps.at(-1)?.id, 'implement');
  assert.equal(decision.scheduler.steps.at(-1)?.objective, 'Keep the model-selected implementation objective.');
  assert.deepEqual(decision.scheduler.executionWaves, [['attachment-image-analysis', 'attachment-document-analysis'], ['implement']]);
});

test('mixed fallback needs only attachment capabilities and old graph roles do not become new requirements', async () => {
  const mixed = fallbackChatRoute({ message: 'Analyze these inputs.', mode: 'analyze', attachments: [{ name: 'photo.jpg' }, { name: 'report.pdf' }] });
  assert.equal(mixed.intent, 'task');
  assert.equal(mixed.workflowRoute, 'team');
  assert.deepEqual(mixed.scheduler.activeAgentIds, ['vision-agent', 'document-agent']);
  assert.equal(mixed.requiresSearch, false);
  const followup = await routeChatIntent({ message: 'Summarize the result in one sentence.', mode: 'analyze', currentGraph: workflowPlanFromChatRoute(mixed)?.graph }, new RouteModel([
    routerOutput({ taskKind: 'question', difficulty: 'easy', candidateAgentIds: ['direct-responder'], candidateSkillIds: [] }),
    schedulerOutput({ route: 'direct', activeAgentIds: ['direct-responder'], appendAgentIds: ['direct-responder'], selectedSkillIds: [], steps: [] }),
  ]), new AbortController().signal);
  assert.equal(followup.source, 'router-agent');
  assert.equal(followup.workflowRoute, 'direct');
  assert.deepEqual(followup.scheduler.activeAgentIds, ['direct-responder']);
});

test('router timeout preserves evidence, comparison delivery, and verification for the original failure', async () => {
  const message = '请基于最新官方资料，比较 PostgreSQL 与 SQLite 在多 worker 部署中的并发、迁移和故障恢复风险，给出选型方案并验证结论';
  let fallbacks = 0;
  const decision = await routeChatIntent({ message, mode: 'decide', onFallback: () => { fallbacks += 1; } }, {
    model: 'injected-timeout',
    complete: async () => { throw new DOMException('Injected Router timeout', 'TimeoutError'); },
  }, new AbortController().signal);
  assert.equal(fallbacks, 1);
  assert.equal(decision.intent, 'task');
  assert.equal(decision.execution, 'workflow');
  assert.equal(decision.source, 'deterministic-fallback');
  assert.equal(decision.requiresSearch, true);
  assert.deepEqual(decision.scheduler.activeAgentIds, ['search-agent', 'analyst', 'reviewer']);
  assert.deepEqual(decision.scheduler.executionWaves, [['research'], ['analysis'], ['quality-review']]);
  assert.ok(decision.scheduler.steps.every((step) => step.objective.includes(message)));
  assert.ok(decision.skillIds.includes('web-research'));
  assert.ok(decision.skillIds.includes('evidence-research'));
  const plan = workflowPlanFromChatRoute(decision)!;
  assert.equal(plan.routingSource, 'deterministic-fallback');
  assert.equal(plan.steps[0]?.agentContract?.agentId, 'search-agent');
  assert.deepEqual(plan.steps[1]?.dependsOn, ['research']);
  assert.deepEqual(plan.steps[2]?.dependsOn, ['research', 'analysis']);
});

test('old browser fallback decisions are re-evaluated with the current shared contract', () => {
  const stale = { ...fallbackChatRoute({ message: '今天的天气', mode: 'analyze' }), routingVersion: 'router-scheduler/local-fallback-v1' };
  const input = { message: '查询最新官方资料，比较数据库选型并验证结论', mode: 'decide' as const };
  assert.deepEqual(enforceChatRouteSafety(stale, input), fallbackChatRoute(input));
});

test('fallback only selects current-turn capabilities after search is explicitly stopped', () => {
  const previous = fallbackChatRoute({ message: '搜索 GitHub 最新项目，比较方案并验证结论', mode: 'decide' });
  const current = fallbackChatRoute({ message: '本轮不再检索，只根据已有结论给出选型方案。', mode: 'decide', currentGraph: workflowPlanFromChatRoute(previous)?.graph });
  assert.equal(current.requiresSearch, false);
  assert.equal(current.skillIds.includes('web-research'), false);
  assert.equal(current.skillIds.includes('github-inspection'), false);
  assert.equal(current.scheduler.activeAgentIds.includes('github-research-agent'), false);
  assert.equal(current.scheduler.activeAgentIds.includes('reviewer'), false);
});

test('capability tags mistaken for Skills get one scoped Scheduler correction with measured overhead', async () => {
  const events: RoutingDiagnostic[] = [];
  const calls: RoutingModelCall[] = [];
  const wrong = JSON.parse(schedulerOutput());
  wrong.selectedSkillIds = ['tradeoffs', 'risk-analysis'];
  wrong.steps[1].skillIds = ['tradeoffs'];
  const model = new RouteModel([routerOutput(), JSON.stringify(wrong), schedulerOutput()]);
  const decision = await routeChatIntent({ message: 'Compare the design tradeoffs.', mode: 'decide', onDiagnostic: (event) => events.push(event), onModelCall: (call) => calls.push(call) }, model, new AbortController().signal);
  assert.equal(decision.source, 'router-agent');
  assert.equal(model.requests.length, 3);
  assert.deepEqual(calls.map(({ stage, purpose }) => [stage, purpose]), [['router', 'initial'], ['scheduler', 'initial'], ['scheduler', 'repair']]);
  assert.equal(calls.every((call) => call.status === 'completed'), true, 'HTTP success is separate from semantic validity');
  assert.deepEqual(events.map((event) => [event.event, event.code]), [['validation-passed', undefined], ['validation-rejected', 'unavailable-id'], ['repair-started', 'unavailable-id'], ['validation-passed', undefined]]);
  const initial = JSON.parse(model.requests[1]!.user);
  const repair = JSON.parse(model.requests[2]!.user);
  assert.deepEqual(repair.selectionContract, initial.selectionContract);
  assert.equal(repair.correction.code, 'unavailable-id');
  assert.ok(repair.correction.validationFeedback.includes('tradeoffs'));
  assert.ok(initial.candidateAgents.every((agent: Record<string, unknown>) => 'capabilityDescriptions' in agent && !('capabilities' in agent)));
  const summary = summarizeRoutingDiagnostics(calls, events);
  assert.equal(summary.firstPassValid, false);
  assert.equal(summary.repaired, true);
  assert.equal(summary.fallback, false);
  assert.equal(summary.validationFailures, 1);
  assert.equal(summary.repairModelCalls, 1);
  assert.equal(summary.repairTokens, null, 'unreported tokens must not appear as zero');
  assert.ok(summary.repairDurationMs >= 0);
  assert.equal(JSON.stringify(events).includes('Compare'), false, 'diagnostics never retain the user prompt');
});

test('Router correction consumes the single shared budget and Scheduler cannot start another repair', async () => {
  const events: RoutingDiagnostic[] = [];
  const model = new RouteModel(['{"broken":', routerOutput(), schedulerOutput({ selectedSkillIds: ['risk-analysis'] }), schedulerOutput()]);
  const decision = await routeChatIntent({ message: 'Design a service.', mode: 'build', onDiagnostic: (event) => events.push(event) }, model, new AbortController().signal);
  assert.equal(decision.source, 'deterministic-fallback');
  assert.equal(model.requests.length, 3);
  assert.equal(events.filter((event) => event.event === 'repair-started').length, 1);
  assert.deepEqual(events.filter((event) => event.event === 'validation-rejected').map((event) => event.code), ['invalid-json', 'unavailable-id']);
  assert.equal(events.at(-1)?.code, 'unavailable-id');
});

test('one Router schema repair can recover without turning a greeting into a workflow', async () => {
  const model = new RouteModel(['{}', routerOutput({ intent: 'conversation', taskKind: 'conversation', difficulty: 'trivial', candidateAgentIds: ['direct-responder'], candidateSkillIds: [] }), schedulerOutput({ route: 'direct', activeAgentIds: ['direct-responder'], appendAgentIds: [], selectedSkillIds: [], steps: [], executionWaves: [] })]);
  const decision = await routeChatIntent({ message: 'Hello!', mode: 'analyze' }, model, new AbortController().signal);
  assert.equal(decision.source, 'router-agent');
  assert.equal(decision.execution, 'gateway');
  assert.deepEqual(decision.scheduler.activeAgentIds, ['direct-responder']);
  assert.deepEqual(decision.scheduler.steps, []);
  assert.equal(JSON.parse(model.requests[1]!.user).correction.code, 'invalid-schema');
});

test('cycles and out-of-candidate Agent or Skill choices are repairable but never executable', async () => {
  const healthy = JSON.parse(schedulerOutput());
  const cycle = structuredClone(healthy);
  cycle.steps[0].dependsOn = ['delivery'];
  const outsideStep = structuredClone(healthy);
  outsideStep.steps[2].agentId = 'reviewer';
  const outsideSkill = structuredClone(healthy);
  outsideSkill.steps[0].skillIds = ['quality-review'];
  const outsideAppend = { ...healthy, appendAgentIds: ['reviewer'] };
  for (const [invalid, code] of [[cycle, 'invalid-dependencies'], [outsideStep, 'outside-candidates'], [outsideSkill, 'outside-candidates'], [outsideAppend, 'outside-candidates']] as const) {
    const model = new RouteModel([routerOutput(), JSON.stringify(invalid), schedulerOutput()]);
    const decision = await routeChatIntent({ message: 'Design and implement the service.', mode: 'build' }, model, new AbortController().signal);
    assert.equal(decision.source, 'router-agent');
    assert.equal(JSON.parse(model.requests[2]!.user).correction.code, code);
    assert.deepEqual(decision.scheduler.activeAgentIds, ['researcher', 'analyst', 'builder']);
    assert.deepEqual(decision.scheduler.executionWaves, [['research', 'analysis'], ['delivery']]);
  }
});

test('failed correction safely falls back and provider failures never start a semantic repair', async () => {
  for (const stage of ['initial', 'repair'] as const) {
    const events: RoutingDiagnostic[] = [];
    let calls = 0;
    const decision = await routeChatIntent({ message: 'Design a service.', mode: 'build', onDiagnostic: (event) => events.push(event) }, {
      model: 'injected', async complete() {
        calls += 1;
        if (stage === 'repair' && calls === 1) return { content: '{}', durationMs: 1, attempts: 1 };
        throw new Error('Provider disconnected');
      },
    }, new AbortController().signal);
    assert.equal(decision.source, 'deterministic-fallback');
    assert.equal(calls, stage === 'repair' ? 2 : 1);
    assert.equal(events.at(-1)?.code, 'provider-error');
    assert.equal(events.filter((event) => event.event === 'repair-started').length, stage === 'repair' ? 1 : 0);
  }
  const events: RoutingDiagnostic[] = [];
  const invalid = schedulerOutput({ selectedSkillIds: ['risk-analysis'] });
  const model = new RouteModel([routerOutput(), invalid, invalid, schedulerOutput()]);
  const decision = await routeChatIntent({ message: 'Design a service.', mode: 'build', onDiagnostic: (event) => events.push(event) }, model, new AbortController().signal);
  assert.equal(decision.source, 'deterministic-fallback');
  assert.equal(model.requests.length, 3);
  assert.equal(events.filter((event) => event.event === 'repair-started').length, 1);
});

test('low confidence does not trigger a repair that merely inflates model confidence', async () => {
  const model = new RouteModel([routerOutput({ confidence: 0.2 }), routerOutput(), schedulerOutput()]);
  const decision = await routeChatIntent({ message: 'Design a service.', mode: 'build' }, model, new AbortController().signal);
  assert.equal(decision.source, 'deterministic-fallback');
  assert.equal(model.requests.length, 1);
});

test('cancelled routing never falls back or retries before, during, or between model stages', async () => {
  for (const cancelAt of [0, 1, 2, 3]) {
    const controller = new AbortController();
    let calls = 0;
    let fallbacks = 0;
    const events: RoutingDiagnostic[] = [];
    if (cancelAt === 0) controller.abort();
    await assert.rejects(routeChatIntent({ message: 'Design a service.', mode: 'build', onFallback: () => { fallbacks += 1; }, onDiagnostic: (event) => events.push(event) }, {
      model: 'cancel-fixture', async complete() {
        calls += 1;
        if (calls === cancelAt) controller.abort();
        return { content: calls === 1 ? routerOutput() : '{}', attempts: 1, durationMs: 1 };
      },
    }, controller.signal), { name: 'AbortError' });
    assert.equal(calls, cancelAt);
    assert.equal(fallbacks, 0);
    assert.equal(events.at(-1)?.event, 'cancelled');
  }
});

test('fallback honors empty/restricted directories and never resurrects unavailable Agents or Skills', async () => {
  const availableAgents = [{ id: 'analyst', label: 'Analysis', description: 'Analysis only', capabilities: ['analysis'] }];
  const model = new RouteModel('{}');
  await assert.rejects(routeChatIntent({ message: 'Hello', mode: 'analyze', availableAgents: [], availableSkills: [] }, model, new AbortController().signal), RoutingUnavailableError);
  assert.equal(model.requests.length, 0);
  await assert.rejects(routeChatIntent({ message: 'Search current weather.', mode: 'analyze', availableAgents }, new RouteModel('{}'), new AbortController().signal), RoutingUnavailableError);
  const limited = await routeChatIntent({ message: 'Design a service.', mode: 'build', availableSkills: [] }, new RouteModel('{}'), new AbortController().signal);
  assert.equal(limited.source, 'deterministic-fallback');
  assert.deepEqual(limited.skillIds, []);
  assert.deepEqual(limited.router.candidateSkillIds, []);
  assert.ok(limited.scheduler.steps.every((step) => step.skillIds.length === 0));
});

test('multi-turn scheduling derives new and skipped roles from actual work, never arbitrary model history labels', async () => {
  const prior = workflowPlanFromChatRoute(await routeChatIntent({ message: 'Design the service.', mode: 'build' }, new RouteModel([routerOutput(), schedulerOutput()]), new AbortController().signal))!.graph;
  const followup = await routeChatIntent({ message: 'Now only review the existing implementation.', mode: 'analyze', currentGraph: prior }, new RouteModel([
    routerOutput({ candidateAgentIds: ['reviewer'], candidateSkillIds: ['quality-review'] }),
    schedulerOutput({ route: 'single-agent', activeAgentIds: ['reviewer'], appendAgentIds: [], skippedAgentIds: ['reviewer', 'invented-history-agent'], selectedSkillIds: ['quality-review'], steps: [{ id: 'review', agentId: 'reviewer', title: 'Review', objective: 'Review existing work only.', dependsOn: [], skillIds: ['quality-review'] }] }),
  ]), new AbortController().signal);
  assert.equal(followup.source, 'router-agent');
  assert.deepEqual(followup.scheduler.activeAgentIds, ['reviewer']);
  assert.deepEqual(followup.scheduler.appendAgentIds, ['reviewer']);
  assert.deepEqual(followup.scheduler.skippedAgentIds, ['researcher', 'analyst', 'builder']);
});

test('diagnostics summarize known repair tokens without storing prompts and observers remain non-authoritative', async () => {
  const calls: RoutingModelCall[] = [];
  const events: RoutingDiagnostic[] = [];
  let completion = 0;
  const outputs = [routerOutput(), '{}', schedulerOutput()];
  const decision = await routeChatIntent({ message: 'Design a service.', mode: 'build', onModelCall: (call) => calls.push(call), onDiagnostic: (event) => { events.push(event); throw new Error('Observer failure'); } }, {
    model: 'usage-fixture', async complete() { return { content: outputs[completion++]!, attempts: 1, durationMs: 1, usage: { total_tokens: 100 } }; },
  }, new AbortController().signal);
  assert.equal(decision.source, 'router-agent');
  assert.equal(summarizeRoutingDiagnostics(calls, events).totalTokens, 300);
  assert.equal(summarizeRoutingDiagnostics(calls, events).repairTokens, 100);
});

test('valid-looking JSON with truncated/tool/oversized responses is rejected before semantic acceptance', async () => {
  for (const [mode, code] of [['length', 'truncated-output'], ['tool', 'unexpected-tool-call'], ['oversized', 'oversized-output']] as const) {
    const events: RoutingDiagnostic[] = [];
    const requests: ModelCompletionRequest[] = [];
    const decision = await routeChatIntent({ message: 'Design a service.', mode: 'build', onDiagnostic: (event) => events.push(event) }, {
      model: 'invalid-completion-fixture', async complete(request) {
        requests.push(request);
        assert.equal(request.toolChoice, 'none');
        assert.equal(request.tools, undefined);
        const first = requests.length === 1;
        return { content: first ? (mode === 'oversized' ? ' '.repeat(16_001) + routerOutput() : routerOutput()) : requests.length === 2 ? routerOutput() : schedulerOutput(), attempts: 1, durationMs: 1,
          ...(first && mode === 'length' ? { finishReason: 'length' } : {}),
          ...(first && mode === 'tool' ? { toolCalls: [{ name: 'shell.exec', args: { command: 'must-not-run' } }] } : {}) };
      },
    }, new AbortController().signal);
    assert.equal(decision.source, 'router-agent');
    assert.equal(requests.length, 3);
    assert.equal(events.find((event) => event.event === 'validation-rejected')?.code, code);
    assert.equal(events.filter((event) => event.event === 'repair-started').length, 1);
    assert.ok(JSON.parse(requests[1]!.user).correction.invalidOutput.length <= 6_000);
  }
});

test('missing steps for a non-direct candidate gets actionable correction without expanding candidates', async () => {
  const message = '不要重新搜索，仅把上一轮结论整理成三个要点，不要新增事实。';
  const currentGraph = workflowPlanFromChatRoute(fallbackChatRoute({ message: '搜索最新官方资料，比较数据库方案并验证结论', mode: 'decide' }))!.graph;
  const selectedRouter = routerOutput({ taskKind: 'question', difficulty: 'easy', candidateAgentIds: ['analyst'], candidateSkillIds: [], requiredCapabilities: ['analysis'], requiresExternalFacts: false });
  const missingSteps = schedulerOutput({ route: 'direct', activeAgentIds: ['analyst'], appendAgentIds: [], selectedSkillIds: [], steps: [], executionWaves: [] });
  const corrected = schedulerOutput({ route: 'single-agent', activeAgentIds: ['analyst'], appendAgentIds: [], selectedSkillIds: [], steps: [{ id: 'summarize', title: '整理已有结论', agentId: 'analyst', objective: message, dependsOn: [], skillIds: [] }] });
  for (const repairedOutput of [corrected, missingSteps]) {
    const model = new RouteModel([selectedRouter, missingSteps, repairedOutput]);
    const decision = await routeChatIntent({ message, mode: 'analyze', currentGraph }, model, new AbortController().signal);
    assert.equal(model.requests.length, 3);
    const request = JSON.parse(model.requests[2]!.user);
    assert.equal(request.correction.code, 'outside-candidates');
    assert.match(request.correction.validationFeedback, /Assign a concrete executable step/);
    assert.deepEqual(request.selectionContract.selectableAgentIds, ['analyst']);
    assert.equal(decision.source, repairedOutput === corrected ? 'router-agent' : 'deterministic-fallback');
    assert.equal(decision.requiresSearch, false);
    assert.equal(decision.router.requiresExternalFacts, false);
    assert.equal(decision.scheduler.activeAgentIds.includes('search-agent'), false);
    assert.ok(decision.scheduler.skippedAgentIds.includes('search-agent'));
    assert.equal(decision.skillIds.includes('web-research'), false);
    assert.equal(decision.skillIds.includes('github-inspection'), false);
  }
});

test('shared fallback preserves explicit no-retrieval wording without disabling affirmative requests', () => {
  const currentGraph = workflowPlanFromChatRoute(fallbackChatRoute({ message: '搜索 GitHub 最新框架并比较架构', mode: 'decide' }))!.graph;
  const negative = [
    '不要重新搜索，仅把上一轮结论整理成三个要点，不要新增事实。',
    '无需再次检索，先整理已提供的资料。',
    '不用继续联网，分析已有文档中的差异。',
    '停止额外搜索，比较现有证据。',
    'Do not search again; summarize the previous findings in three bullets.',
    "Don't re-search. Compare only the available evidence.",
    'No further web search; summarize the existing facts.',
    'Without browsing, analyze the existing notes.',
    'Avoid additional retrieval; use the prior answer.',
    '不要重新搜索，只解释“搜索最新资料”这句话。',
    'Do not browse again; explain "Search the web" using the prior context.',
  ];
  for (const message of negative) {
    const decision = fallbackChatRoute({ message, mode: 'analyze', currentGraph });
    assert.equal(decision.requiresSearch, false, message);
    assert.equal(decision.router.requiresExternalFacts, false, message);
    assert.ok(decision.scheduler.activeAgentIds.every((id) => !['search-agent', 'academic-search-agent', 'github-research-agent'].includes(id)), message);
    assert.ok(decision.skillIds.every((id) => !['web-research', 'github-inspection'].includes(id)), message);
    assert.ok(decision.scheduler.skippedAgentIds.includes('github-research-agent'), message);
  }
  for (const message of ['请重新搜索最新官方资料。', '不要只搜索，还要分析最新方案。', '不要使用旧报告，请搜索最新官方资料。', 'Search again using official sources.', "Don't use the old notes; search for current evidence.",
    '请搜索关于“不要重新搜索”这句话的相关资料。', '请搜索关于\'不要重新搜索\'这句话的相关资料。',
    'Search for official documentation about "do not search again".', "Search for articles titled 'No further web search'."]) {
    assert.equal(fallbackChatRoute({ message, mode: 'analyze' }).requiresSearch, true, message);
  }
});

test('latest-turn retrieval prohibition constrains model plans and stale server decisions', async () => {
  const message = '不要重新搜索，仅把上一轮结论整理成三个要点，不要新增事实。';
  const stale = fallbackChatRoute({ message: '搜索今天的官方资讯', mode: 'analyze' });
  assert.equal(stale.requiresSearch, true);
  assert.equal(enforceChatRouteSafety({ ...stale, source: 'router-agent' }, { message, mode: 'analyze' }).requiresSearch, false);
  const model = new RouteModel([routerOutput({ intent: 'web-search', taskKind: 'question', requiresExternalFacts: true, candidateAgentIds: ['search-agent'], candidateSkillIds: ['web-research'] }),
    routerOutput({ taskKind: 'question', difficulty: 'easy', requiresExternalFacts: false, candidateAgentIds: ['direct-responder'], candidateSkillIds: [] }),
    schedulerOutput({ route: 'direct', activeAgentIds: ['direct-responder'], appendAgentIds: [], selectedSkillIds: [], steps: [], executionWaves: [] })]);
  const decision = await routeChatIntent({ message, mode: 'analyze' }, model, new AbortController().signal);
  assert.equal(decision.source, 'router-agent');
  assert.equal(JSON.parse(model.requests[1]!.user).correction.code, 'forbidden-retrieval');
  assert.equal(decision.requiresSearch, false);
  assert.deepEqual(decision.scheduler.activeAgentIds, ['direct-responder']);
});

test('object-scoped prohibitions and affirmative countermand clauses remain semantic Router decisions', async () => {
  const messages = [
    '不用搜索天气，只查询今天的美元人民币汇率。',
    '不要搜索“天气”，只查询今天的美元人民币汇率。',
    '不用搜索，但是请查询今天的美元人民币汇率。',
    "Don't search for weather; only look up today's USD/CNY exchange rate.",
    'Do not search for "weather"; instead search official exchange rates.',
    'No further web search; but look up the latest exchange rate.',
  ];
  for (const message of messages) {
    assert.equal(explicitlyDisablesRetrieval(message), false, message);
    const model = new RouteModel([
      routerOutput({ intent: 'web-search', taskKind: 'question', difficulty: 'easy', requiresExternalFacts: true, candidateAgentIds: ['search-agent'], candidateSkillIds: ['web-research'] }),
      schedulerOutput({ route: 'direct', activeAgentIds: ['search-agent'], appendAgentIds: ['search-agent'], selectedSkillIds: ['web-research'], steps: [], executionWaves: [] }),
    ]);
    const decision = await routeChatIntent({ message, mode: 'analyze' }, model, new AbortController().signal);
    assert.equal(decision.source, 'router-agent', message);
    assert.equal(model.requests.length, 2, 'No regex veto or semantic correction for object-scoped negation.');
    assert.equal(decision.requiresSearch, true, message);
    assert.equal(enforceChatRouteSafety(decision, { message, mode: 'analyze' }).requiresSearch, true, message);
    assert.equal(fallbackChatRoute({ message, mode: 'analyze' }).requiresSearch, true, message);
  }
  for (const message of ['不要搜索天气。', '不要搜索“天气”。', "Don't search for weather.", 'Do not search for "weather".']) {
    assert.equal(explicitlyDisablesRetrieval(message), false, 'A local object prohibition is not global permission revocation.');
  }
});
