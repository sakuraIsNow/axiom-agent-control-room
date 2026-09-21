import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatRouteDecisionSchema, routeChatIntent, summarizeRoutingDiagnostics, type ChatRouteDecision, type ChatRouteInput, type RoutingDiagnostic, type RoutingExecutionOptions, type RoutingModelCall } from './chatRouter.js';
import { OpenAICompatibleModelClient, type ModelClient, type ModelCompletionRequest } from './modelClient.js';
import { JevDecisionRouter } from './jevDecisionRouter.js';

type DecisionAdapter = NonNullable<RoutingExecutionOptions['decisionRouter']>;
type EvaluationInput = Parameters<DecisionAdapter['evaluate']>[0];
type EvaluationResult = Awaited<ReturnType<DecisionAdapter['evaluate']>>;
const input: ChatRouteInput = { message: 'Analyze the supplied plan and identify its tradeoffs.', mode: 'analyze', availableAgents: [
  { id: 'analyst', label: 'Analyst', description: 'Analyze supplied evidence.', capabilities: ['analysis'] },
  { id: 'builder', label: 'Builder', description: 'Produce an implementation plan.', capabilities: ['implementation'] },
  { id: 'direct-responder', label: 'Conversation', description: 'Self-contained dialogue.', capabilities: ['conversation'] },
], availableSkills: [] };
const router = (overrides: Partial<ChatRouteDecision['router']> = {}): ChatRouteDecision['router'] => ({
  intent: 'task', taskKind: 'research', difficulty: 'moderate', requiresExternalFacts: false,
  requiredCapabilities: ['analysis'], candidateAgentIds: ['analyst'], candidateSkillIds: [], confidence: 0.96,
  rationale: 'Use one authorized Analyst for the supplied plan.', ...overrides,
});
const scheduler = (agents = ['analyst']) => ({ route: agents.length > 1 ? 'team' : 'single-agent', activeAgentIds: agents,
  skippedAgentIds: [], appendAgentIds: agents, selectedSkillIds: [], executionWaves: [agents.map((_, index) => `step-${index}`)],
  steps: agents.map((agentId, index) => ({ id: `step-${index}`, title: 'Requested analysis', agentId, objective: 'Analyze the supplied plan.', dependsOn: [], skillIds: [] })),
  requiresReview: false, synthesisAgentId: 'synthesizer', reason: 'Run only the useful authorized Agents.',
});
const directScheduler = () => ({ ...scheduler(), route: 'direct', activeAgentIds: ['direct-responder'], appendAgentIds: ['direct-responder'], executionWaves: [], steps: [] });

class LegacyModel implements ModelClient {
  model = 'configured-platform-model';
  location: 'local' | 'internet' = 'internet';
  requests: ModelCompletionRequest[] = [];
  constructor(private readonly outputs: Array<unknown | ((request: ModelCompletionRequest) => unknown)>, private readonly totalTokens?: number) {}
  async complete(request: ModelCompletionRequest) {
    request.signal.throwIfAborted();
    assert.equal(request.toolChoice, 'none');
    assert.equal(request.tools?.length ?? 0, 0);
    this.requests.push(request);
    const next = this.outputs.shift();
    assert.notEqual(next, undefined, 'unexpected model invocation');
    const value = typeof next === 'function' ? next(request) : next;
    return { content: typeof value === 'string' ? value : JSON.stringify(value), finishReason: 'stop', attempts: 1, durationMs: 1,
      ...(this.totalTokens === undefined ? {} : { usage: { total_tokens: this.totalTokens } }) };
  }
}

const adapter = (decision: ChatRouteDecision['router'] | null, custom?: (request: EvaluationInput, signal: AbortSignal) => Promise<EvaluationResult>) => {
  const calls: EvaluationInput[] = [];
  const value: DecisionAdapter = { async evaluate(request, signal) {
    calls.push(request);
    signal.throwIfAborted();
    if (custom) return custom(request, signal);
    return { decision, model: 'jev-local-decision', totalTokens: 17, promptCharacters: 120, ...(decision ? {} : { reason: 'ambiguous' as const }) };
  } };
  return { value, calls };
};
const hybrid = (value: DecisionAdapter): RoutingExecutionOptions => ({ decisionRouter: value, decisionRouterMode: 'hybrid' });
const stages = (model: LegacyModel) => model.requests.map((request) => request.system.includes('You are the Router Agent') ? 'router' : 'scheduler');

test('decision routing is opt-in and default legacy classification remains unchanged', async () => {
  const model = new LegacyModel([router(), scheduler()]);
  const decision = await routeChatIntent(input, model, new AbortController().signal);
  assert.deepEqual(stages(model), ['router', 'scheduler']);
  assert.equal(decision.routerModel, model.model);
  assert.equal(decision.source, 'router-agent');
  assert.equal(decision.decisionRouting, undefined);
  assert.ok(chatRouteDecisionSchema.safeParse(decision).success);
});

test('hybrid accepts a validated Jev decision while retaining the configured LLM Scheduler', async () => {
  const jev = adapter(router());
  const model = new LegacyModel([scheduler()]);
  const result = await routeChatIntent(input, model, new AbortController().signal, hybrid(jev.value));
  assert.equal(jev.calls.length, 1);
  assert.deepEqual(stages(model), ['scheduler']);
  assert.equal(result.routerModel, 'jev-local-decision');
  assert.equal(result.source, 'router-agent');
  assert.deepEqual(result.router.candidateAgentIds, ['analyst']);
  assert.deepEqual(result.scheduler.activeAgentIds, ['analyst']);
  assert.deepEqual(result.decisionRouting, { mode: 'hybrid', provider: 'jev', model: 'jev-local-decision', outcome: 'selected' });
  assert.ok(chatRouteDecisionSchema.safeParse(result).success);
  const prompt = JSON.parse(model.requests[0]!.user);
  assert.deepEqual(prompt.selectionContract.selectableAgentIds, ['analyst']);
  assert.deepEqual(prompt.selectionContract.selectableSkillIds, []);
});

test('Jev confidence cannot trigger the existing Router-only simple-chat fast path', async () => {
  const events: RoutingDiagnostic[] = [];
  const jev = adapter(router({ intent: 'conversation', taskKind: 'conversation', difficulty: 'trivial', requiredCapabilities: ['conversation'], candidateAgentIds: ['direct-responder'], confidence: 1 }));
  const model = new LegacyModel([directScheduler()]);
  const result = await routeChatIntent({ ...input, message: 'Hello!', onDiagnostic: (event) => events.push(event) }, model, new AbortController().signal, hybrid(jev.value));
  assert.equal(result.intent, 'conversation');
  assert.deepEqual(stages(model), ['scheduler']);
  assert.equal(events.some((event) => event.event === 'stage-skipped'), false);
  assert.equal(result.decisionRouting?.outcome, 'selected');
});

test('shadow observes Jev without narrowing the original Agent or Skill directory', async () => {
  const jev = adapter(router({ candidateAgentIds: ['analyst'] }));
  const model = new LegacyModel([
    (request: ModelCompletionRequest) => {
      const prompt = JSON.parse(request.user);
      assert.deepEqual(prompt.selectionContract.selectableAgentIds, ['analyst', 'builder', 'direct-responder']);
      assert.deepEqual(prompt.selectionContract.selectableSkillIds, ['approved-skill']);
      return router({ candidateAgentIds: ['builder'], requiredCapabilities: ['implementation'] });
    }, scheduler(['builder']),
  ]);
  const result = await routeChatIntent({ ...input, availableSkills: [{ id: 'approved-skill', label: 'Allowed', description: 'An existing allowed Skill.' }] }, model,
    new AbortController().signal, { decisionRouter: jev.value, decisionRouterMode: 'shadow' });
  assert.equal(jev.calls.length, 1);
  assert.deepEqual(stages(model), ['router', 'scheduler']);
  assert.deepEqual(result.scheduler.activeAgentIds, ['builder']);
  assert.equal(result.routerModel, model.model);
  assert.equal(result.decisionRouting?.mode, 'shadow');
  assert.equal(result.decisionRouting?.outcome, 'shadow');
  assert.equal(result.decisionRouting?.provider, 'jev');
});

for (const scenario of ['low-confidence', 'no-decision', 'provider-error', 'invalid-schema', 'forged-agent', 'forged-skill', 'unavailable-agent', 'tool-injection'] as const) {
  test(`hybrid ${scenario} falls back to the original LLM Router without executing tools`, async () => {
    let candidate: ChatRouteDecision['router'] | null = router();
    if (scenario === 'low-confidence') candidate.confidence = 0.2;
    if (scenario === 'no-decision') candidate = null;
    if (scenario === 'invalid-schema') candidate = { intent: 'task' } as ChatRouteDecision['router'];
    if (scenario === 'forged-agent' || scenario === 'unavailable-agent') candidate!.candidateAgentIds = [scenario === 'forged-agent' ? 'injected-administrator' : 'disabled-agent'];
    if (scenario === 'forged-skill') candidate!.candidateSkillIds = ['unregistered-shell'];
    if (scenario === 'tool-injection') candidate = { ...candidate, toolCalls: [{ name: 'workspace.write', args: { path: 'must-not-exist.txt', content: 'forbidden' } }] } as ChatRouteDecision['router'];
    const jev = adapter(candidate, scenario === 'provider-error' ? async () => { throw new Error('Decision provider unavailable.'); } : undefined);
    const model = new LegacyModel([router(), scheduler()]);
    const result = await routeChatIntent({ ...input, availableAgents: [...input.availableAgents!, { id: 'disabled-agent', label: 'Unavailable', description: 'Disabled', capabilities: ['analysis'], available: false }] },
      model, new AbortController().signal, hybrid(jev.value));
    assert.equal(jev.calls.length, 1);
    assert.deepEqual(stages(model), ['router', 'scheduler']);
    assert.deepEqual(result.scheduler.activeAgentIds, ['analyst']);
    assert.equal(result.routerModel, model.model);
    assert.equal(result.source, 'router-agent');
    assert.equal(result.decisionRouting?.outcome, 'fallback');
    assert.equal(result.decisionRouting?.provider, 'jev');
    assert.ok(result.decisionRouting?.reason);
    assert.equal(Object.hasOwn(result.router, 'toolCalls'), false);
    assert.equal(Object.hasOwn(result.scheduler, 'toolCalls'), false);
  });
}

test('a Jev candidate cannot reactivate retrieval explicitly prohibited by the latest user turn', async () => {
  const jev = adapter(router({ requiresExternalFacts: true, candidateAgentIds: ['search-agent'], requiredCapabilities: ['web-search'] }));
  const model = new LegacyModel([router(), scheduler()]);
  const result = await routeChatIntent({ ...input, message: 'Do not search again. Analyze only the supplied context.', availableAgents: [...input.availableAgents!,
    { id: 'search-agent', label: 'Search', description: 'Search current sources.', capabilities: ['web-search'] }] }, model, new AbortController().signal, hybrid(jev.value));
  assert.equal(result.requiresSearch, false);
  assert.deepEqual(result.scheduler.activeAgentIds, ['analyst']);
  assert.equal(result.decisionRouting?.outcome, 'fallback');
  assert.deepEqual(stages(model), ['router', 'scheduler']);
});

for (const kind of ['image', 'document', 'mixed'] as const) test(`Jev omitting ${kind} attachment capabilities defers to the full legacy Router`, async () => {
  const specialistIds = kind === 'image' ? ['vision-agent'] : kind === 'document' ? ['document-agent'] : ['vision-agent', 'document-agent'];
  const jev = adapter(router());
  const attachments = kind === 'image' ? [{ name: 'image.png', mimeType: 'image/png', kind: 'image' }]
    : kind === 'document' ? [{ name: 'report.pdf', mimeType: 'application/pdf', kind: 'document' }]
      : [{ name: 'image.png', mimeType: 'image/png', kind: 'image' }, { name: 'report.pdf', mimeType: 'application/pdf', kind: 'document' }];
  const model = new LegacyModel([router({ candidateAgentIds: [...specialistIds, 'analyst'], requiredCapabilities: ['analysis', ...specialistIds.map((id) => id === 'vision-agent' ? 'image-analysis' : 'document-analysis')] }), scheduler([...specialistIds, 'analyst'])]);
  const result = await routeChatIntent({ ...input, message: 'Analyze the attached material and explain the conclusion.', attachments,
    availableAgents: [...input.availableAgents!, ...specialistIds.map((id) => ({ id, label: id, description: 'Analyze the authorized attachment.', capabilities: [id === 'vision-agent' ? 'image-analysis' : 'document-analysis'] }))] },
  model, new AbortController().signal, hybrid(jev.value));
  assert.equal(result.decisionRouting?.outcome, 'fallback');
  assert.deepEqual(stages(model), ['router', 'scheduler']);
  for (const id of specialistIds) assert.ok(result.scheduler.steps.some((step) => step.agentId === id));
  const analysis = result.scheduler.steps.find((step) => step.agentId === 'analyst');
  for (const id of specialistIds) assert.equal(analysis?.dependsOn.includes(result.scheduler.steps.find((step) => step.agentId === id)!.id), true, `Analysis must depend on ${id}.`);
});

test('Jev misclassifying an explicit export cannot claim a server-corrected route as its own selection', async () => {
  const jev = adapter(router());
  const model = new LegacyModel([
    router({ intent: 'report-export', taskKind: 'operations', requiredCapabilities: ['report-export'], candidateAgentIds: ['report-agent'], reportExport: { scope: 'last-answer', format: 'md' } }),
    { ...directScheduler(), activeAgentIds: ['report-agent'], appendAgentIds: ['report-agent'] },
  ]);
  const result = await routeChatIntent({ ...input, message: '请将上面的回答导出为 Markdown 文件下载。', availableAgents: [...input.availableAgents!,
    { id: 'report-agent', label: 'Report', description: 'Export a user-requested report.', capabilities: ['report-export'] }] }, model, new AbortController().signal, hybrid(jev.value));
  assert.equal(result.decisionRouting?.outcome, 'fallback');
  assert.equal(result.intent, 'report-export');
  assert.equal(result.reportExport?.format, 'md');
  assert.deepEqual(stages(model), ['router', 'scheduler']);
});

test('a normalization-changing Jev conversation is not selected as a valid first-pass task route', async () => {
  const jev = adapter(router({ intent: 'conversation', taskKind: 'research', candidateAgentIds: ['analyst'] }));
  const model = new LegacyModel([router(), scheduler()]);
  const result = await routeChatIntent(input, model, new AbortController().signal, hybrid(jev.value));
  assert.equal(result.decisionRouting?.outcome, 'fallback');
  assert.equal(result.intent, 'task');
  assert.deepEqual(stages(model), ['router', 'scheduler']);
});

test('Scheduler repair stays inside Jev-authorized candidates and never grants injected tool permissions', async () => {
  const jev = adapter(router());
  const invalid = scheduler(['builder']);
  const model = new LegacyModel([invalid, (request: ModelCompletionRequest) => {
    const payload = JSON.parse(request.user);
    assert.deepEqual(payload.selectionContract.selectableAgentIds, ['analyst']);
    assert.deepEqual(payload.selectionContract.selectableSkillIds, []);
    assert.ok(payload.correction);
    return scheduler();
  }]);
  const result = await routeChatIntent(input, model, new AbortController().signal, hybrid(jev.value));
  assert.equal(jev.calls.length, 1);
  assert.deepEqual(stages(model), ['scheduler', 'scheduler']);
  assert.deepEqual(result.scheduler.activeAgentIds, ['analyst']);
  assert.equal(result.decisionRouting?.outcome, 'selected');
});

test('a shadow provider error does not prevent the unchanged legacy route from completing', async () => {
  const jev = adapter(null, async () => { throw new Error('Shadow transport disconnected.'); });
  const model = new LegacyModel([router(), scheduler()]);
  const result = await routeChatIntent(input, model, new AbortController().signal, { decisionRouter: jev.value, decisionRouterMode: 'shadow' });
  assert.deepEqual(stages(model), ['router', 'scheduler']);
  assert.deepEqual(result.scheduler.activeAgentIds, ['analyst']);
  assert.equal(result.routerModel, model.model);
  assert.equal(result.decisionRouting?.mode, 'shadow');
});

for (const mode of ['hybrid', 'shadow'] as const) test(`${mode} cancellation during decision evaluation aborts instead of falling back`, async () => {
  const controller = new AbortController();
  let fallbacks = 0;
  const jev = adapter(router(), async (_request, signal) => {
    controller.abort(new DOMException('User cancelled decision routing.', 'AbortError'));
    signal.throwIfAborted();
    throw new Error('Unreachable');
  });
  const model = new LegacyModel([]);
  await assert.rejects(routeChatIntent({ ...input, onFallback: () => { fallbacks += 1; } }, model, controller.signal,
    { decisionRouter: jev.value, decisionRouterMode: mode }), { name: 'AbortError' });
  assert.equal(jev.calls.length, 1);
  assert.equal(model.requests.length, 0);
  assert.equal(fallbacks, 0);
});

test('a pre-cancelled request invokes neither decision provider nor platform model', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Already cancelled.', 'AbortError'));
  const jev = adapter(router());
  const model = new LegacyModel([]);
  await assert.rejects(routeChatIntent(input, model, controller.signal, hybrid(jev.value)), { name: 'AbortError' });
  assert.equal(jev.calls.length, 0);
  assert.equal(model.requests.length, 0);
});

test('a provider returning a decision after cancellation cannot start the Scheduler', async () => {
  const controller = new AbortController();
  const jev = adapter(router(), async () => {
    controller.abort(new DOMException('Cancelled before decision delivery.', 'AbortError'));
    return { decision: router(), model: 'jev-local-decision', totalTokens: 17, promptCharacters: 120 };
  });
  const model = new LegacyModel([]);
  await assert.rejects(routeChatIntent(input, model, controller.signal, hybrid(jev.value)), { name: 'AbortError' });
  assert.equal(jev.calls.length, 1);
  assert.equal(model.requests.length, 0);
});

test('provider failures expose bounded routing reasons instead of raw transport secrets', async () => {
  const marker = 'test-secret-must-never-appear-in-route';
  const jev = adapter(null, async () => { throw new Error(`Remote failed with Authorization: Bearer ${marker}`); });
  const model = new LegacyModel([router(), scheduler()]);
  const result = await routeChatIntent(input, model, new AbortController().signal, hybrid(jev.value));
  assert.equal(result.decisionRouting?.outcome, 'fallback');
  assert.ok(result.decisionRouting?.reason);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
  assert.equal(model.requests.some((request) => request.user.includes(marker) || request.system.includes(marker)), false);
});

test('exhausted Jev Scheduler validation returns to the original LLM Router once without executing tools', async () => {
  const jev = adapter(router());
  const model = new LegacyModel([scheduler(['builder']), scheduler(['builder']),
    router({ candidateAgentIds: ['builder'], requiredCapabilities: ['implementation'] }), scheduler(['builder'])]);
  const result = await routeChatIntent(input, model, new AbortController().signal, hybrid(jev.value));
  assert.equal(jev.calls.length, 1);
  assert.deepEqual(stages(model), ['scheduler', 'scheduler', 'router', 'scheduler']);
  assert.equal(result.routerModel, model.model);
  assert.deepEqual(result.scheduler.activeAgentIds, ['builder']);
  assert.equal(result.decisionRouting?.outcome, 'fallback');
  assert.equal(result.decisionRouting?.reason, 'scheduler-rejected');
});

test('Jev and Scheduler usage are both measured and preserve their selected routing source', async () => {
  const calls: RoutingModelCall[] = [];
  const events: RoutingDiagnostic[] = [];
  const jev = adapter(router());
  const model = new LegacyModel([scheduler()], 29);
  await routeChatIntent({ ...input, onModelCall: (call) => calls.push(call), onDiagnostic: (event) => events.push(event) },
    model, new AbortController().signal, hybrid(jev.value));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => [call.stage, call.totalTokens]), [['router', 17], ['scheduler', 29]]);
  assert.equal(calls[0]?.provider, 'jev');
  assert.equal(calls[0]?.model, 'jev-local-decision');
  const summary = summarizeRoutingDiagnostics(calls, events);
  assert.equal(summary.totalTokens, 46);
  assert.equal(summary.firstPassValid, true);
});

test('pre-request Jev rejection does not fabricate a provider invocation or first-pass success', async () => {
  const calls: RoutingModelCall[] = [];
  const events: RoutingDiagnostic[] = [];
  const jev = adapter(null, async () => { throw Object.assign(new Error('Local routing budget exceeded.'), { requestSent: false, code: 'budget-exceeded' }); });
  const model = new LegacyModel([router(), scheduler()], 29);
  const result = await routeChatIntent({ ...input, onModelCall: (call) => calls.push(call), onDiagnostic: (event) => events.push(event) },
    model, new AbortController().signal, hybrid(jev.value));
  assert.equal(jev.calls.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.provider === 'jev'), false);
  assert.equal(result.decisionRouting?.reason, 'budget-exceeded');
  const summary = summarizeRoutingDiagnostics(calls, events);
  assert.equal(summary.totalTokens, 58);
  assert.equal(summary.firstPassValid, false);
});

for (const mode of ['hybrid', 'shadow'] as const) {
  for (const condition of ['empty-input', 'invalid-directory'] as const) test(`${mode} ${condition} abstention records no Jev provider call`, async () => {
    let fetchCalls = 0;
    const jev = new JevDecisionRouter({ apiKey: 'fake-evaluation-only-key', fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('Preflight abstention must not send a request.');
    } });
    const calls: RoutingModelCall[] = [];
    const events: RoutingDiagnostic[] = [];
    const model = new LegacyModel([router(), scheduler()], 29);
    const result = await routeChatIntent({ ...input,
      ...(condition === 'empty-input' ? { message: ' ' } : { availableSkills: [{ id: '', label: 'Invalid', description: 'Unusable directory.' }] }),
      onModelCall: (call) => calls.push(call), onDiagnostic: (event) => events.push(event),
    }, model, new AbortController().signal, { decisionRouter: jev, decisionRouterMode: mode });
    assert.equal(fetchCalls, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls.some((call) => call.provider === 'jev'), false);
    assert.deepEqual(stages(model), ['router', 'scheduler']);
    assert.equal(result.decisionRouting?.reason, 'unsupported');
    assert.equal(result.decisionRouting?.outcome, mode === 'hybrid' ? 'fallback' : 'shadow');
    const summary = summarizeRoutingDiagnostics(calls, events);
    assert.equal(summary.totalTokens, 58);
    assert.equal(summary.firstPassValid, mode === 'shadow');
  });
}

for (const mode of ['hybrid', 'shadow'] as const) test(`local model content never reaches a configured external ${mode} decision provider`, async () => {
  const jev = adapter(router());
  const model = new LegacyModel([router(), scheduler()]);
  model.location = 'local';
  const result = await routeChatIntent(input, model, new AbortController().signal, { decisionRouter: jev.value, decisionRouterMode: mode });
  assert.equal(jev.calls.length, 0);
  assert.deepEqual(stages(model), ['router', 'scheduler']);
  assert.equal(result.decisionRouting, undefined);
  assert.equal(result.routerModel, model.model);
});

for (const apiBase of ['http://127.0.0.1:11434/v1', 'http://192.168.10.12:8000/v1']) test(`key-protected private endpoint ${apiBase} is still local for decision privacy`, async () => {
  const legacy = new LegacyModel([router(), scheduler()]);
  const model = new OpenAICompatibleModelClient({ apiBase, apiKey: 'fake-private-model-key', apiKeyOptional: false, model: 'private-text-model' });
  model.complete = legacy.complete.bind(legacy);
  const jev = adapter(router());
  assert.equal(model.location, 'local');
  const result = await routeChatIntent(input, model, new AbortController().signal, hybrid(jev.value));
  assert.equal(jev.calls.length, 0);
  assert.deepEqual(stages(legacy), ['router', 'scheduler']);
  assert.equal(result.decisionRouting, undefined);
});

test('an explicitly local private domain cannot be overridden by a configured Jev adapter', async () => {
  const legacy = new LegacyModel([router(), scheduler()]);
  const model = new OpenAICompatibleModelClient({ apiBase: 'https://private-model.example.test/v1', apiKey: 'fake-private-model-key', apiKeyOptional: false, location: 'local' });
  model.complete = legacy.complete.bind(legacy);
  const jev = adapter(router());
  assert.equal(model.location, 'local');
  await routeChatIntent(input, model, new AbortController().signal, hybrid(jev.value));
  assert.equal(jev.calls.length, 0);
  assert.deepEqual(stages(legacy), ['router', 'scheduler']);
});
