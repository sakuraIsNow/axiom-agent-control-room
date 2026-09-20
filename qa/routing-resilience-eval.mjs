import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chatRouteDecisionSchema, enforceChatRouteSafety, fallbackChatRoute, routeChatIntent, summarizeRoutingDiagnostics, workflowPlanFromChatRoute } from '../server/runtime/chatRouter.ts';
import { fallbackChatRoute as browserFallback } from '../src/lib/chatRoutingFallback.ts';
import { routeChatMessage } from '../src/lib/chatRouting.ts';

const originalFailure = '请基于最新官方资料，比较 PostgreSQL 与 SQLite 在多 worker 部署中的并发、迁移和故障恢复风险，给出选型方案并验证结论';
const previousGraph = { nodes: ['orchestrator', 'github-research-agent', 'vision-agent', 'builder', 'reviewer', 'synthesizer'].map((role) => ({ id: role, role, title: role, status: 'completed', dependsOn: [] })), edges: [] };
const image = { id: 'image', kind: 'image', url: 'data:image/png;base64,fixture', alt: 'design.png' };
const document = { id: 'document', kind: 'file', name: 'requirements.pdf', mimeType: 'application/pdf', size: 32, text: 'Fixture design requirements.' };
const cases = [
  { id: 'original-postgresql-sqlite', message: originalFailure, mode: 'decide', roles: ['search-agent', 'analyst', 'reviewer'], dependencies: [['search-agent', 'analyst'], ['analyst', 'reviewer']], search: true, skills: ['web-research', 'evidence-research', 'quality-review'] },
  { id: 'english-composite', message: 'Use the latest official sources to compare PostgreSQL and SQLite concurrency and migration risks, recommend a deployment option and verify the conclusions.', mode: 'decide', roles: ['search-agent', 'analyst', 'reviewer'], dependencies: [['search-agent', 'analyst'], ['analyst', 'reviewer']], search: true },
  { id: 'search-implementation', message: 'Search the latest API documentation, then implement the requested integration and verify it.', mode: 'build', roles: ['search-agent', 'builder', 'reviewer'], dependencies: [['search-agent', 'builder'], ['builder', 'reviewer']], search: true },
  { id: 'academic-comparison', message: '查找最近的水文学论文，比较方法并验证结论。', mode: 'decide', roles: ['academic-search-agent', 'analyst', 'reviewer'], dependencies: [['academic-search-agent', 'analyst'], ['analyst', 'reviewer']], search: true },
  { id: 'github-comparison', message: '检索 GitHub 开源项目，比较架构并给出选型方案。', mode: 'decide', roles: ['github-research-agent', 'analyst'], dependencies: [['github-research-agent', 'analyst']], search: true },
  { id: 'simple-weather', message: '查询今天上海天气', mode: 'analyze', intent: 'web-search', roles: ['search-agent'], search: true, direct: true },
  { id: 'simple-search', message: '搜索 PostgreSQL 最新官方文档', mode: 'analyze', intent: 'web-search', roles: ['search-agent'], search: true, direct: true },
  { id: 'simple-academic', message: '搜索最近的水文论文和 DOI', mode: 'analyze', intent: 'academic-search', roles: ['academic-search-agent'], search: true, direct: true },
  { id: 'simple-greeting', message: '你好', mode: 'build', intent: 'conversation', roles: ['direct-responder'], search: false, direct: true, noSkills: true },
  { id: 'capability-question', message: '你有联网搜索的能力吗', mode: 'analyze', intent: 'agent-registry', roles: ['registry-agent'], search: false, direct: true, noSkills: true },
  { id: 'turn-search-to-greeting', message: '谢谢', mode: 'analyze', intent: 'conversation', roles: ['direct-responder'], search: false, direct: true, noSkills: true, currentGraph: previousGraph },
  { id: 'turn-search-to-summary', message: '用一句话总结刚才的结论', mode: 'analyze', roles: ['direct-responder'], search: false, direct: true, noSkills: true, currentGraph: previousGraph },
  { id: 'turn-prohibit-repeat-search', message: '不要重新搜索，仅把上一轮结论整理成三个要点，不要新增事实。', mode: 'analyze', roles: ['direct-responder'], search: false, direct: true, noSkills: true, currentGraph: previousGraph },
  { id: 'turn-stop-search', message: '本轮不再检索，只根据已有结论给出选型方案。', mode: 'decide', roles: ['researcher', 'analyst'], dependencies: [['researcher', 'analyst']], search: false, currentGraph: previousGraph },
  { id: 'turn-new-search', message: '查询今天北京天气', mode: 'analyze', intent: 'web-search', roles: ['search-agent'], search: true, direct: true, currentGraph: previousGraph },
  { id: 'mixed-attachments', message: 'Analyze these inputs.', mode: 'analyze', roles: ['vision-agent', 'document-agent'], search: false, attachments: [image, document], parallelInputs: true },
  { id: 'attachment-research-implementation', message: 'Compare the attached design and document with the latest official sources, implement the changes and verify the result.', mode: 'build', roles: ['vision-agent', 'document-agent', 'search-agent', 'analyst', 'builder', 'reviewer'], dependencies: [['vision-agent', 'analyst'], ['document-agent', 'analyst'], ['search-agent', 'analyst'], ['analyst', 'builder'], ['builder', 'reviewer']], search: true, attachments: [image, document] },
  { id: 'simple-attachment', message: '总结附件', mode: 'analyze', intent: 'document-analysis', roles: ['document-agent'], search: false, direct: true, attachments: [document] },
  { id: 'attachment-search-media', message: '根据附件和最新官方资料，生成产品海报图片并验证内容。', mode: 'build', roles: ['document-agent', 'search-agent', 'drawing-agent', 'reviewer'], dependencies: [['document-agent', 'drawing-agent'], ['search-agent', 'drawing-agent'], ['drawing-agent', 'reviewer']], search: true, attachments: [document] },
  { id: 'healthy-minimal-plan', message: '设计一个平台，包含前端、后端和数据流', mode: 'analyze', roles: ['researcher', 'analyst'], healthyRoles: ['analyst'], dependencies: [['researcher', 'analyst']], search: false },
];

const inputFor = (item) => ({ message: item.message, mode: item.mode, attachments: (item.attachments ?? []).map((attachment) => attachment.kind === 'image' ? { name: attachment.alt, kind: 'image', mimeType: 'image/*' } : { name: attachment.name, kind: 'file', mimeType: attachment.mimeType }), currentGraph: item.currentGraph,
  conversationContext: item.currentGraph ? [{ role: 'user', content: '搜索 GitHub，分析附件、实现并验证。' }, { role: 'assistant', content: 'Previous-turn work is complete.' }] : [] });

// These independent model fixtures specify intended responsibilities; they never call the fallback.
const modelOutput = (item) => {
  const roles = item.healthyRoles ?? item.roles;
  const skillsFor = (role) => ['search-agent', 'academic-search-agent', 'github-research-agent'].includes(role) ? ['web-research', 'evidence-research'] : role === 'builder' ? ['implementation'] : role === 'reviewer' ? ['quality-review'] : [];
  const steps = item.direct ? [] : roles.map((role, index) => ({ id: `model-${index + 1}`, agentId: role, title: `Complete ${role} responsibility`, objective: `Complete this responsibility for: ${item.message}`, dependsOn: item.healthyRoles ? [] : (item.dependencies ?? []).filter(([, target]) => target === role).map(([source]) => `model-${roles.indexOf(source) + 1}`), skillIds: skillsFor(role) }));
  const skills = [...new Set((item.direct ? roles.flatMap(skillsFor) : steps.flatMap((step) => step.skillIds)))];
  return [{ intent: item.intent ?? 'task', taskKind: item.intent === 'conversation' ? 'conversation' : item.mode === 'decide' ? 'decision' : 'question', difficulty: roles.length >= 4 ? 'hard' : roles.length > 1 ? 'moderate' : 'easy', requiresExternalFacts: item.search, requiredCapabilities: roles, candidateAgentIds: roles, candidateSkillIds: skills, confidence: 0.98, rationale: 'The current turn requires only these responsibilities.' },
    { route: item.direct ? 'direct' : roles.length >= 4 ? 'full-workflow' : roles.length > 1 ? 'team' : 'single-agent', activeAgentIds: roles, skippedAgentIds: [], appendAgentIds: roles, selectedSkillIds: skills, steps, executionWaves: [], requiresReview: roles.includes('reviewer'), synthesisAgentId: 'synthesizer', reason: 'Use the current-turn dependencies to deliver the request.' }];
};

const validate = (decision, item, normal) => {
  chatRouteDecisionSchema.parse(decision);
  const roles = normal ? item.healthyRoles ?? item.roles : item.roles;
  assert.equal(decision.intent, item.intent ?? 'task');
  assert.equal(decision.requiresSearch, item.search);
  assert.equal(decision.router.requiresExternalFacts, item.search);
  assert.deepEqual([...decision.scheduler.activeAgentIds].sort(), [...roles].sort());
  assert.equal(decision.execution, item.direct ? 'gateway' : 'workflow');
  assert.equal(decision.workflowRoute, decision.scheduler.route);
  const steps = decision.scheduler.steps;
  const completed = new Set();
  const flattenedWaves = [];
  for (const wave of decision.scheduler.executionWaves) {
    for (const id of wave) {
      const step = steps.find((value) => value.id === id);
      assert.ok(step, `unknown scheduled step ${id}`);
      assert.ok(step.dependsOn.every((dependency) => completed.has(dependency)), `premature execution of ${id}`);
    }
    wave.forEach((id) => { assert.equal(completed.has(id), false); completed.add(id); flattenedWaves.push(id); });
  }
  assert.deepEqual([...flattenedWaves].sort(), steps.map((step) => step.id).sort());
  if (item.direct) assert.deepEqual(steps, []);
  else {
    assert.deepEqual([...new Set(steps.map((step) => step.agentId))].sort(), [...roles].sort());
    assert.deepEqual([...new Set(steps.flatMap((step) => step.skillIds))].sort(), [...decision.skillIds].sort());
    const hasAncestor = (target, source, seen = new Set()) => target.dependsOn.some((id) => {
      if (id === source.id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const previous = steps.find((step) => step.id === id);
      return previous && hasAncestor(previous, source, seen);
    });
    for (const [source, target] of normal && item.healthyRoles ? [] : item.dependencies ?? []) {
      assert.ok(hasAncestor(steps.find((step) => step.agentId === target), steps.find((step) => step.agentId === source)), `${source} must precede ${target}`);
    }
    const plan = workflowPlanFromChatRoute(decision);
    assert.ok(plan);
    assert.equal(plan.routingSource, decision.source);
    assert.deepEqual(plan.steps.map(({ id, role, dependsOn }) => ({ id, role, dependsOn })), steps.map(({ id, agentId, dependsOn }) => ({ id, role: agentId, dependsOn })));
    for (const step of steps) for (const dependency of step.dependsOn) assert.ok(plan.graph.edges.some((edge) => edge.from === dependency && edge.to === step.id));
    if (!normal) assert.ok(steps.every((step) => step.objective.includes(item.message)), 'each step must retain the requested deliverable');
  }
  assert.equal(decision.scheduler.requiresReview, roles.includes('reviewer'));
  if (item.noSkills) assert.deepEqual(decision.skillIds, []);
  if (!item.search) assert.equal(decision.skillIds.includes('web-research') || decision.skillIds.includes('github-inspection'), false);
  if (!normal) for (const skill of item.skills ?? []) assert.ok(decision.skillIds.includes(skill));
  for (const node of item.currentGraph?.nodes ?? []) {
    if (!['orchestrator', 'synthesizer'].includes(node.role) && !roles.includes(node.role)) assert.ok(decision.scheduler.skippedAgentIds.includes(node.role));
  }
};

const modes = ['normal', 'router-timeout', 'router-unavailable', 'router-bad-response', 'scheduler-timeout', 'scheduler-unavailable', 'scheduler-bad-response',
  'router-repair-success', 'scheduler-capability-repair-success', 'scheduler-candidate-repair-success', 'scheduler-dependency-repair-success'];
const results = [];
for (const item of cases) for (const fault of modes) {
  const started = performance.now();
  const outputs = modelOutput(item);
  let modelCalls = 0;
  let fallbackNotifications = 0;
  const diagnostics = [];
  const measurements = [];
  const input = inputFor(item);
  let decision;
  try {
    decision = await routeChatIntent({ ...input, onFallback: () => { fallbackNotifications += 1; }, onDiagnostic: (event) => diagnostics.push(event), onModelCall: (call) => measurements.push(call) }, {
      model: 'deterministic-routing-fixture',
      complete: async (request) => {
        modelCalls += 1;
        const stage = request.system.startsWith('You are the Router Agent') ? 'router' : 'scheduler';
        const payload = JSON.parse(request.user);
        assert.equal(payload.latestUserTurn, item.message);
        assert.ok(Array.isArray(payload.selectionContract.selectableAgentIds));
        assert.ok(Array.isArray(payload.selectionContract.selectableSkillIds));
        if (fault === `${stage}-timeout`) throw new DOMException('Injected route timeout', 'TimeoutError');
        if (fault === `${stage}-unavailable`) throw Object.assign(new Error('Injected provider unavailable'), { status: 503 });
        const output = structuredClone(outputs[stage === 'router' ? 0 : 1]);
        if (!payload.correction && fault === 'router-repair-success' && stage === 'router') return { content: '{"broken":', attempts: 1, durationMs: 1 };
        if (!payload.correction && stage === 'scheduler') {
          if (fault === 'scheduler-capability-repair-success') output.selectedSkillIds = ['tradeoffs', 'risk-analysis'];
          if (fault === 'scheduler-candidate-repair-success') output.appendAgentIds = ['video-agent'];
          if (fault === 'scheduler-dependency-repair-success') {
            if (!output.steps.length) output.steps.push({ id: 'bad-step', title: 'Untrusted step', agentId: output.activeAgentIds[0], objective: 'Fixture dependency', dependsOn: [], skillIds: [] });
            output.steps[0].dependsOn = [output.steps[0].id];
          }
        }
        return { content: fault === `${stage}-bad-response` ? '{"broken":' : JSON.stringify(output), attempts: 1, durationMs: 1, usage: { total_tokens: 100 } };
      },
    }, new AbortController().signal);
    const recovered = fault.endsWith('-repair-success');
    const normal = fault === 'normal' || recovered;
    assert.equal(decision.source, normal ? 'router-agent' : 'deterministic-fallback');
    assert.equal(fallbackNotifications, normal ? 0 : 1);
    assert.equal(measurements.filter((call) => call.purpose === 'repair').length, recovered || fault.endsWith('-bad-response') ? 1 : 0);
    assert.equal(modelCalls <= 3, true, 'the whole route has at most one correction, not one per stage');
    if (recovered) assert.equal(diagnostics.filter((event) => event.event === 'validation-rejected').length, 1);
    validate(decision, item, normal);
    if (!normal) {
      assert.deepEqual(decision, fallbackChatRoute(input));
      assert.deepEqual(decision, browserFallback({ message: item.message, mode: item.mode, attachments: item.attachments, currentGraph: item.currentGraph }));
    }
    validate(enforceChatRouteSafety(decision, input), item, normal);
    results.push({ id: item.id, fault, firstAttemptPassed: true, source: decision.source, fallbackTriggered: fallbackNotifications > 0, modelCalls, routing: summarizeRoutingDiagnostics(measurements, diagnostics), intent: decision.intent, activeAgentIds: decision.scheduler.activeAgentIds, steps: decision.scheduler.steps.map(({ id, agentId, dependsOn, skillIds }) => ({ id, agentId, dependsOn, skillIds })), durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    results.push({ id: item.id, fault, firstAttemptPassed: false, source: decision?.source ?? null, fallbackTriggered: fallbackNotifications > 0, modelCalls, error: error instanceof Error ? error.message : String(error) });
  }
}

const originalFetch = globalThis.fetch;
const provider = { useCustom: false, location: 'internet', apiUrl: '', apiKey: '', model: 'fixture' };
for (const fault of ['http-unavailable', 'http-timeout', 'http-bad-json', 'http-bad-decision']) {
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (fault === 'http-unavailable') return new Response('{"error":"Injected unavailable"}', { status: 503 });
      if (fault === 'http-timeout') throw new DOMException('Injected network timeout', 'TimeoutError');
      if (fault === 'http-bad-json') return new Response('{"broken":', { status: 200 });
      return new Response('{"decision":{"intent":"web-search"}}', { status: 200 });
    };
    const item = cases[0];
    const decision = await routeChatMessage(item.message, item.mode, [], provider, new AbortController().signal);
    assert.equal(decision.source, 'deterministic-fallback');
    validate(decision, item, false);
    results.push({ id: 'browser-original-failure', fault, firstAttemptPassed: true, source: decision.source, fallbackTriggered: true, httpCalls: calls });
  } catch (error) {
    results.push({ id: 'browser-original-failure', fault, firstAttemptPassed: false, httpCalls: calls, error: error instanceof Error ? error.message : String(error) });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const passed = results.filter((result) => result.firstAttemptPassed).length;
const healthy = results.filter((result) => result.fault === 'normal');
const injected = results.filter((result) => result.fault !== 'normal');
const report = { generatedAt: new Date().toISOString(), scope: 'deterministic Router/Scheduler and browser failure injection; no paid model or task execution', passed, failed: results.length - passed, skipped: 0, total: results.length,
  firstAttemptPassRate: passed / results.length,
  healthy: { total: healthy.length, passed: healthy.filter((result) => result.firstAttemptPassed).length, fallbackCount: healthy.filter((result) => result.fallbackTriggered).length, fallbackRate: healthy.filter((result) => result.fallbackTriggered).length / healthy.length },
  injected: { total: injected.length, passed: injected.filter((result) => result.firstAttemptPassed).length, fallbackCount: injected.filter((result) => result.fallbackTriggered).length },
  correction: { total: results.filter((result) => result.routing?.repaired).length, recovered: results.filter((result) => result.routing?.repaired && result.source === 'router-agent').length, maxModelCalls: Math.max(...results.map((result) => result.modelCalls ?? 0)) },
  boundaries: ['Faults are deterministic exceptions and responses; this does not measure real provider latency or availability.', 'Assertions cover executable plans, capabilities, Skill selection and dependencies; citations and final task completion need execution-quality evaluation.'], results };
await writeFile(fileURLToPath(new URL('./routing-resilience-eval-results.json', import.meta.url)), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, results: results.filter((result) => !result.firstAttemptPassed) }, null, 2));
if (report.failed) process.exitCode = 1;
