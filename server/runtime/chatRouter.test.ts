import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';
import { enforceChatRouteSafety, fallbackChatRoute, routeChatIntent, workflowPlanFromChatRoute } from './chatRouter.js';

class RouteModel implements ModelClient {
  readonly model = 'route-model';
  private readonly outputs: string[];
  constructor(content: string | string[]) {
    this.outputs = Array.isArray(content) ? [...content] : [content];
  }
  async complete(_request: ModelCompletionRequest) {
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
    intent: 'task' as const,
    execution: 'workflow' as const,
    agentRole: 'orchestrator',
    workflowRoute: 'team' as const,
  };
  const guarded = enforceChatRouteSafety(taskDecision, input);
  assert.equal(fallback.intent, 'web-search');
  assert.equal(guarded.intent, 'task');
  assert.equal(guarded.execution, 'workflow');
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
