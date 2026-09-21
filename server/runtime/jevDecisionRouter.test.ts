import assert from 'node:assert/strict';
import test from 'node:test';
import { JevDecisionError, JevDecisionRouter } from './jevDecisionRouter.js';
import type { ChatRouteInput } from './chatRouter.js';

const input = (change: Partial<ChatRouteInput> = {}): ChatRouteInput => ({ message: '你好，今天心情不错', mode: 'analyze',
  availableAgents: [
    { id: 'direct-responder', label: 'Conversation', description: 'Social dialogue', capabilities: ['conversation'] },
    { id: 'analyst', label: 'Analysis', description: 'Analyze and compare', capabilities: ['analysis', 'decision'] },
    { id: 'builder', label: 'Builder', description: 'Implement', capabilities: ['implementation'] },
    { id: 'search-agent', label: 'Search', description: 'Find current facts', capabilities: ['web-search'] },
  ], availableSkills: [{ id: 'implementation', label: 'Implement', description: 'Code implementation' }], ...change });
type RequestBody = { model: string; state: { latestUserTurn: string; authorizedAgents: Array<{ id: string }>; authorizedSkills: Array<{ id: string }> };
  questions: Record<string, { type: 'choice' | 'noul'; instructions: string; criteria: Record<string, string> }> };
type FixtureOptions = { intent?: string; kind?: string; difficulty?: string; agents?: string[]; skills?: string[]; external?: boolean };
const reply = (body: RequestBody, options: FixtureOptions = {}) => {
  const choices: Record<string, string> = { intent: options.intent ?? 'conversation', taskKind: options.kind ?? 'conversation', difficulty: options.difficulty ?? 'trivial' };
  const answers: Record<string, Record<string, unknown>> = {};
  for (const [id, question] of Object.entries(body.questions)) {
    if (question.type === 'choice') answers[id] = { type: 'choice', choice: choices[id], confidence: 0.99,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === choices[id] ? 0.99 : 0.01 / (Object.keys(question.criteria).length - 1)])) };
    else {
      const yes = id === 'requiresExternalFacts' ? options.external === true : id.startsWith('agent')
        ? (options.agents ?? ['direct-responder']).includes(body.state.authorizedAgents[Number(id.slice(5))]!.id)
        : (options.skills ?? []).includes(body.state.authorizedSkills[Number(id.slice(5))]!.id);
      answers[id] = { type: 'noul', noul: yes ? 0.99 : 0.01 };
    }
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 20 } };
};
const fixture = (options: FixtureOptions = {}, transform?: (value: ReturnType<typeof reply>, body: RequestBody) => unknown) => {
  const requests: Array<{ url: string; options: RequestInit; body: RequestBody }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    requests.push({ url: String(url), options: init!, body });
    const value = reply(body, options);
    return new Response(JSON.stringify(transform ? transform(value, body) : value), { status: 200 });
  };
  return { requests, router: new JevDecisionRouter({ apiKey: 'fixture-private-key', fetchImpl }) };
};
const evaluate = (router: JevDecisionRouter, value = input()) => router.evaluate(value, new AbortController().signal);
const rejectsCode = async (promise: Promise<unknown>, code: string, sent = true) => assert.rejects(promise,
  (error: unknown) => error instanceof JevDecisionError && error.code === code && error.requestSent === sent
    && !error.message.includes('fixture-private-key') && !error.message.includes('upstream-private'));

test('official typed protocol preserves Chinese input and reports measured usage without calling a chat endpoint', async () => {
  const f = fixture(); const value = input(); const result = await evaluate(f.router, value);
  assert.equal(result.decision?.intent, 'conversation');
  assert.deepEqual(result.decision?.candidateAgentIds, ['direct-responder']);
  assert.deepEqual(result.decision?.candidateSkillIds, []);
  assert.deepEqual(result.decision?.requiredCapabilities, ['conversation']);
  assert.equal(result.totalTokens, 120);
  assert.equal(result.requestSent, true);
  assert.equal(result.model, 'jev-1.13.0');
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.equal((request.options.headers as Record<string, string>).Authorization, 'Bearer fixture-private-key');
  assert.equal(request.body.state.latestUserTurn, value.message);
  assert.equal(result.promptCharacters, String(request.options.body).length);
  assert.ok(request.body.questions.agent0!.instructions.includes('direct-responder'));
  assert.ok(request.body.questions.agent0!.instructions.includes('state.authorizedAgents[0]'));
  assert.ok(!JSON.stringify(request.body).includes('fixture-private-key'));
});

test('multiple relevant Agents and Skills may be selected independently', async () => {
  const f = fixture({ intent: 'task', kind: 'implementation', difficulty: 'moderate', agents: ['analyst', 'builder'], skills: ['implementation', 'review'] });
  const result = await evaluate(f.router, input({ message: '分析一下需求，然后做一个本地待办小工具',
    availableSkills: [...input().availableSkills!, { id: 'review', label: 'Review', description: 'Review implementation' }] }));
  assert.deepEqual(result.decision?.candidateAgentIds, ['analyst', 'builder']);
  assert.deepEqual(result.decision?.candidateSkillIds, ['implementation', 'review']);
});

test('simple external lookup uses only the authorized search Agent', async () => {
  const f = fixture({ intent: 'web-search', kind: 'question', difficulty: 'easy', agents: ['search-agent'], external: true });
  const result = await evaluate(f.router, input({ message: '帮我查一下今天北京天气' }));
  assert.equal(result.decision?.requiresExternalFacts, true);
  assert.deepEqual(result.decision?.candidateAgentIds, ['search-agent']);
});

test('zero selected Agents abstains rather than inventing a default Agent', async () => {
  const f = fixture({ agents: [] });
  const result = await evaluate(f.router);
  assert.equal(result.decision, null); assert.equal(result.reason, 'unsupported');
  assert.equal(result.requestSent, true);
  assert.equal(result.totalTokens, 120);
});

test('empty input or invalid directories abstain before transport and report no request', async () => {
  const baseline = input();
  const cases: Partial<ChatRouteInput>[] = [
    { message: '   ' },
    { availableAgents: [] },
    { availableAgents: undefined },
    { availableAgents: [{ ...baseline.availableAgents![0]!, id: '' }] },
    { availableAgents: [baseline.availableAgents![0]!, baseline.availableAgents![0]!] },
    { availableSkills: [{ id: ' ', label: 'Invalid', description: 'Invalid directory entry.' }] },
    { availableSkills: [baseline.availableSkills![0]!, baseline.availableSkills![0]!] },
  ];
  const f = fixture();
  for (const overrides of cases) {
    const result = await evaluate(f.router, input(overrides));
    assert.equal(result.decision, null);
    assert.equal(result.reason, 'unsupported');
    assert.equal(result.requestSent, false);
    assert.equal(result.promptCharacters, 0);
    assert.equal(result.totalTokens, null);
  }
  assert.equal(f.requests.length, 0);
});

test('unavailable Agents and missing explicit directories are never selected', async () => {
  const f = fixture();
  const result = await evaluate(f.router, input({ availableAgents: input().availableAgents!.map((agent) => ({ ...agent, available: agent.id !== 'direct-responder' })) }));
  assert.equal(result.decision, null);
  assert.ok(f.requests[0]!.body.state.authorizedAgents.every((agent) => agent.id !== 'direct-responder'));
  assert.equal((await evaluate(f.router, input({ availableAgents: undefined }))).reason, 'unsupported');
  assert.equal((await evaluate(f.router, input({ availableAgents: [input().availableAgents![0]!, input().availableAgents![0]!] }))).reason, 'unsupported');
  assert.equal(f.requests.length, 1);
  const g = fixture({ intent: 'task', kind: 'implementation', difficulty: 'easy', agents: ['builder'], skills: ['hidden'] });
  const hidden = { id: 'hidden', label: 'Hidden', description: 'Not available', available: false };
  assert.deepEqual((await evaluate(g.router, input({ availableSkills: [hidden] }))).decision?.candidateSkillIds, []);
  assert.deepEqual(g.requests[0]!.body.state.authorizedSkills, []);
});

test('hard or complex work and report export defer to the semantic model', async () => {
  for (const difficulty of ['hard', 'complex']) {
    const f = fixture({ intent: 'task', kind: 'implementation', difficulty, agents: ['analyst', 'builder'] });
    const result = await evaluate(f.router, input({ message: '设计并实现大型平台' }));
    assert.equal(result.decision, null); assert.equal(result.reason, 'complex-task');
  }
  const result = await evaluate(fixture({ intent: 'report-export', kind: 'operations', difficulty: 'easy' }).router);
  assert.equal(result.decision, null); assert.equal(result.reason, 'unsupported');
});

test('uncertain Choice or Noul results never become confident decisions', async () => {
  for (const modify of [
    (value: ReturnType<typeof reply>) => { value.answers.intent!.confidence = 0.84; },
    (value: ReturnType<typeof reply>) => { value.answers.agent1!.noul = 0.5; },
    (value: ReturnType<typeof reply>) => { value.answers.requiresExternalFacts!.noul = 0.2; },
    (value: ReturnType<typeof reply>) => { value.answers.skill0!.noul = 0.16; },
  ]) {
    const f = fixture({}, (value) => { modify(value); return value; });
    const result = await evaluate(f.router);
    assert.equal(result.decision, null); assert.equal(result.reason, 'low-confidence');
  }
});

test('Noul boundary values are accepted, with honest minimum confidence', async () => {
  const f = fixture({}, (value) => { value.answers.agent0!.noul = 0.85; value.answers.agent1!.noul = 0.15; return value; });
  const result = await evaluate(f.router);
  assert.equal(result.decision?.confidence, 0.85);
});

test('cross-question contradictions and latest no-search instruction abstain', async () => {
  for (const options of [
    { intent: 'conversation', kind: 'implementation', agents: ['builder'] },
    { intent: 'conversation', agents: ['direct-responder', 'analyst'] },
    { intent: 'task', kind: 'conversation', difficulty: 'easy', agents: ['analyst'] },
    { intent: 'web-search', kind: 'question', difficulty: 'easy', agents: ['search-agent'], external: false },
    { intent: 'task', kind: 'research', difficulty: 'moderate', agents: ['analyst'], external: true },
  ]) assert.equal((await evaluate(fixture(options).router)).decision, null);
  const f = fixture({ intent: 'web-search', kind: 'question', difficulty: 'easy', agents: ['search-agent'], external: true });
  assert.equal((await evaluate(f.router, input({ message: '本轮不要再联网搜索，只总结已有内容' }))).decision, null);
});

test('image and document attachments cannot silently lose their required analysis capability', async () => {
  const f = fixture({ intent: 'task', kind: 'decision', difficulty: 'moderate', agents: ['analyst'] });
  const result = await evaluate(f.router, input({ message: '对比这些材料', attachments: [{ kind: 'image', mimeType: 'image/png' }, { kind: 'file', mimeType: 'application/pdf' }] }));
  assert.equal(result.decision, null); assert.equal(result.reason, 'ambiguous');
  const drawing = { id: 'drawing-agent', label: 'Drawing', description: 'Generate image', capabilities: ['image-generation'] };
  const g = fixture({ intent: 'image-generation', kind: 'creative', difficulty: 'easy', agents: ['drawing-agent'] });
  assert.equal((await evaluate(g.router, input({ availableAgents: [drawing],
    attachments: [{ kind: 'file', mimeType: 'application/pdf' }] }))).reason, 'ambiguous');
});

test('external routing sends only attachment and directory metadata without mutating the legacy request', async () => {
  const image = { name: 'synthetic-chart.png', mimeType: 'image/png', kind: 'image',
    url: 'data:image/png;base64,PRIVATE_IMAGE_SENTINEL', text: 'PRIVATE_IMAGE_TEXT', content: 'PRIVATE_IMAGE_CONTENT', file: { bytes: 'PRIVATE_IMAGE_FILE' } };
  const document = { name: 'synthetic-report.pdf', mimeType: 'application/pdf', kind: 'file',
    url: 'data:application/pdf;base64,PRIVATE_PDF_SENTINEL', text: 'PRIVATE_PDF_TEXT', content: { extracted: 'PRIVATE_PDF_CONTENT' }, file: 'PRIVATE_PDF_FILE' };
  const agents = [
    { id: 'vision-agent', label: 'Vision', description: 'Analyze images', capabilities: ['image-analysis'], privateData: 'PRIVATE_AGENT_SENTINEL' },
    { id: 'document-agent', label: 'Document', description: 'Analyze documents', capabilities: ['document-analysis'] },
  ];
  const skill = { id: 'comparison', label: 'Compare', description: 'Compare supplied sources', secret: 'PRIVATE_SKILL_SENTINEL', content: { source: 'PRIVATE_SKILL_CONTENT' } };
  const graph = { nodes: [{ id: 'previous', role: 'analyst', title: 'Prior analysis', dependsOn: [], status: 'completed' as const, output: 'PRIVATE_NODE_CONTENT' }],
    edges: [{ from: 'previous', to: 'next', kind: 'dependency' as const, content: 'PRIVATE_EDGE_CONTENT', attachment: image }], privateData: 'PRIVATE_GRAPH_SENTINEL' };
  const value = input({ message: '对照图片和报告的数据，仅使用附件', attachments: [image, document], availableAgents: agents, availableSkills: [skill], currentGraph: graph });
  const before = structuredClone(value);
  const f = fixture({ intent: 'task', kind: 'decision', difficulty: 'moderate', agents: ['vision-agent', 'document-agent'], skills: ['comparison'] });
  const result = await evaluate(f.router, value);
  assert.deepEqual(result.decision?.candidateAgentIds, ['vision-agent', 'document-agent']);
  const state = f.requests[0]!.body.state as unknown as Record<string, unknown>;
  assert.deepEqual(state.attachments, [
    { name: image.name, mimeType: image.mimeType, kind: image.kind },
    { name: document.name, mimeType: document.mimeType, kind: document.kind },
  ]);
  assert.deepEqual(state.currentSessionGraph, { nodes: [{ id: 'previous', role: 'analyst', title: 'Prior analysis', status: 'completed' }], edges: [{ from: 'previous', to: 'next', kind: 'dependency' }] });
  assert.deepEqual(state.authorizedSkills, [{ id: skill.id, label: skill.label, description: skill.description }]);
  assert.ok(!JSON.stringify(f.requests[0]!.body).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(f.requests[0]!.body).includes('data:image/'));
  assert.deepEqual(value, before);
});

test('invalid or oversized metadata abstains before external transport rather than serializing nested content', async () => {
  const f = fixture();
  const invalid = [
    { attachments: [{ name: { content: 'private' }, mimeType: 'image/png' }] },
    { attachments: [{ name: 'x'.repeat(513) }] },
    { attachments: [{ mimeType: 'x'.repeat(161) }] },
    { attachments: [{ kind: 'x'.repeat(33) }] },
    { attachments: [null] },
    { currentGraph: { nodes: [], edges: [{ from: { content: 'private' }, to: 'next', kind: 'dependency' }] } },
    { availableSkills: [{ id: 'private', label: 'Private', description: { content: 'private' } }] },
    { availableAgents: [{ ...input().availableAgents![0]!, capabilities: [{ content: 'private' }] }] },
  ];
  for (const change of invalid) {
    const value = input(change as unknown as Partial<ChatRouteInput>);
    const before = structuredClone(value);
    const result = await evaluate(f.router, value);
    assert.equal(result.decision, null);
    assert.equal(result.reason, 'unsupported');
    assert.equal(result.requestSent, false);
    assert.deepEqual(value, before);
  }
  assert.equal(f.requests.length, 0);
});

test('more than 12 relevant Agents, Skills or capability labels are not silently truncated', async () => {
  const many = Array.from({ length: 13 }, (_, index) => ({ id: `custom-${index}`, label: 'Custom', description: 'Custom', capabilities: ['analysis'] }));
  const f = fixture({ intent: 'task', kind: 'decision', difficulty: 'moderate', agents: many.map((item) => item.id) });
  assert.equal((await evaluate(f.router, input({ availableAgents: many }))).reason, 'unsupported');
  const g = fixture({ intent: 'task', kind: 'decision', difficulty: 'easy', agents: ['analyst'], skills: many.map((item) => item.id) });
  assert.equal((await evaluate(g.router, input({ availableSkills: many }))).reason, 'unsupported');
  const h = fixture({ intent: 'task', kind: 'decision', difficulty: 'easy', agents: ['analyst'] });
  assert.equal((await evaluate(h.router, input({ availableAgents: [{ ...input().availableAgents![1]!, capabilities: many.map((item) => item.id) }] }))).reason, 'unsupported');
});

test('answer map, type, option set, selected maximum, range and probability sum are strictly validated', async () => {
  const mutations: Array<(value: ReturnType<typeof reply>) => void> = [
    (value) => { delete value.answers.agent0; },
    (value) => { value.answers.fakeAgent = { type: 'noul', noul: 1 }; },
    (value) => { value.answers.agent0 = { type: 'choice', choice: 'yes', probabilities: { yes: 1 }, confidence: 1 }; },
    (value) => { value.answers.intent!.choice = 'unregistered'; },
    (value) => { (value.answers.intent!.probabilities as Record<string, number>).unregistered = 0; },
    (value) => { delete (value.answers.intent!.probabilities as Record<string, number>).task; },
    (value) => { value.answers.intent!.probabilities = { conversation: 0.1, task: 0.9 }; },
    (value) => {
      const probabilities = value.answers.intent!.probabilities as Record<string, number>;
      for (const key of Object.keys(probabilities)) probabilities[key] = key === 'conversation' ? 0.1 : key === 'task' ? 0.9 : 0;
    },
    (value) => { (value.answers.intent!.probabilities as Record<string, number>).conversation = 0.5; },
    (value) => { value.answers.intent!.confidence = 2; },
    (value) => { value.model = 'upstream-private token content'; },
    (value) => { value.answers.agent0!.noul = -0.1; },
    (value) => { value.answers.agent0!.extra = 'private'; },
    (value) => { value.usage.input_tokens = -1; },
    (value) => { value.usage.output_tokens = 1.2; },
    (value) => { value.usage.input_tokens = Number.MAX_SAFE_INTEGER; value.usage.output_tokens = 1; },
  ];
  for (const mutate of mutations) {
    const f = fixture({}, (value) => { mutate(value); return value; });
    await rejectsCode(evaluate(f.router), 'invalid-response');
    assert.equal(f.requests.length, 1);
  }
});

test('top-level extra keys and invalid JSON do not escape as raw upstream errors', async () => {
  await rejectsCode(evaluate(fixture({}, (value) => ({ ...value, secret: 'upstream-private' })).router), 'invalid-response');
  const router = new JevDecisionRouter({ apiKey: 'fixture-private-key', fetchImpl: async () => new Response('upstream-private {') });
  await rejectsCode(evaluate(router), 'invalid-response');
});

for (const status of [401, 429, 500, 302]) test(`HTTP ${status} has no retries and leaks no provider body`, async () => {
  let calls = 0;
  const router = new JevDecisionRouter({ apiKey: 'fixture-private-key', fetchImpl: async () => {
    calls++; return new Response('upstream-private fixture-private-key', { status, headers: { Location: 'https://other.example' } });
  } });
  await rejectsCode(evaluate(router), 'provider-error');
  assert.equal(calls, 1);
});

test('redirected responses and network failures are rejected without raw exception text', async () => {
  const response = new Response('{}'); Object.defineProperty(response, 'redirected', { value: true });
  await rejectsCode(evaluate(new JevDecisionRouter({ apiKey: 'fixture-private-key', fetchImpl: async () => response })), 'provider-error');
  await rejectsCode(evaluate(new JevDecisionRouter({ apiKey: 'fixture-private-key', fetchImpl: async () => { throw new Error('upstream-private fixture-private-key'); } })), 'provider-error');
});

test('failed HTTP responses are cancelled without consuming their potentially sensitive body', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 });
  await rejectsCode(evaluate(new JevDecisionRouter({ apiKey: 'fixture-private-key', fetchImpl: async () => response })), 'provider-error');
  assert.equal(cancelled, true);
});

test('deadline bounds both unresponsive fetch and body consumption', async () => {
  let calls = 0;
  const never = new JevDecisionRouter({ apiKey: 'fixture-private-key', timeoutMs: 10, fetchImpl: async () => { calls++; return new Promise(() => undefined); } });
  await rejectsCode(evaluate(never), 'timeout');
  assert.equal(calls, 1);
  let cancelled = false;
  const body = new JevDecisionRouter({ apiKey: 'fixture-private-key', timeoutMs: 10, fetchImpl: async () =>
    new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } })) });
  await rejectsCode(evaluate(body), 'timeout');
  assert.equal(cancelled, true);
});

test('caller abort remains an abort and never retries or falls through to an answer', async () => {
  const controller = new AbortController(); let calls = 0;
  const router = new JevDecisionRouter({ apiKey: 'fixture-private-key', fetchImpl: async () => { calls++; return new Promise(() => undefined); } });
  const pending = router.evaluate(input(), controller.signal);
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(router.evaluate(input(), controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('full latest request is never silently sliced to fit the request budget', async () => {
  const f = fixture();
  await rejectsCode(evaluate(f.router, input({ message: 'x'.repeat(64_001) })), 'budget-exceeded', false);
  await rejectsCode(evaluate(f.router, input({ message: 'x'.repeat(63_990) })), 'budget-exceeded', false);
  assert.equal(f.requests.length, 0);
});

test('response size is bounded while streaming, including declared oversized content', async () => {
  for (const response of [new Response('x'.repeat(128_001)), new Response('{}', { headers: { 'Content-Length': '9999999' } })]) {
    const router = new JevDecisionRouter({ apiKey: 'fixture-private-key', fetchImpl: async () => response });
    await rejectsCode(evaluate(router), 'budget-exceeded');
  }
});

test('trusted endpoint configuration permits only the official path and secure or loopback origins', async () => {
  for (const baseUrl of ['https://api.typesafe.ai', 'https://api.typesafe.ai/v1', 'https://api.typesafe.ai/v1/systemone', 'http://127.0.0.1:9999']) {
    let target = '';
    const router = new JevDecisionRouter({ apiKey: 'fixture-private-key', baseUrl, fetchImpl: async (url, init) => {
      target = String(url); return new Response(JSON.stringify(reply(JSON.parse(String(init!.body)))));
    } });
    await evaluate(router); assert.ok(target.endsWith('/v1/systemone'));
  }
  for (const baseUrl of ['http://public.example', 'https://user:secret@api.typesafe.ai', 'https://api.typesafe.ai?key=secret',
    'https://api.typesafe.ai/other', 'file:///private', 'https://api.typesafe.ai/#token']) {
    assert.throws(() => new JevDecisionRouter({ apiKey: 'fixture-private-key', baseUrl }), (error: unknown) =>
      error instanceof JevDecisionError && error.code === 'provider-error' && error.requestSent === false);
  }
});
