import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real HTTP route -> real provider client -> loopback SSE provider. The source
// server runs from a disposable cwd and a minimal environment, so dotenv never
// sees the user's credentials and no real conversations/tasks are touched.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(await realpath(tmpdir()), 'axiom-routing-http-'));
const databasePath = join(scratch, 'runtime.sqlite');
const apiKey = 'routing-http-fixture-key';
const calls = new Map();
const requests = [];
const results = [];
let child;
let childFailure;
let childLog = '';
let cleaning;
const router = () => ({ intent: 'task', taskKind: 'decision', difficulty: 'easy', requiresExternalFacts: false,
  requiredCapabilities: ['analysis', 'tradeoffs'], candidateAgentIds: ['analyst'], candidateSkillIds: ['architecture-design'], confidence: 0.95, rationale: 'One analysis responsibility suffices for this turn.' });
const scheduler = () => ({ route: 'single-agent', activeAgentIds: ['analyst'], skippedAgentIds: [], appendAgentIds: ['analyst'], selectedSkillIds: ['architecture-design'], executionWaves: [['analyze']],
  steps: [{ id: 'analyze', title: 'Compare options', agentId: 'analyst', objective: 'Compare the supplied deployment options without external retrieval.', dependsOn: [], skillIds: ['architecture-design'] }], requiresReview: false, synthesisAgentId: 'synthesizer', reason: 'Keep the execution minimal.' });
const conversationalRouter = () => ({ intent: 'conversation', taskKind: 'conversation', difficulty: 'trivial', requiresExternalFacts: false,
  requiredCapabilities: ['conversation'], candidateAgentIds: ['direct-responder'], candidateSkillIds: [], confidence: 0.98, rationale: 'Only self-contained social dialogue.' });
const conversationalScheduler = () => ({ route: 'direct', activeAgentIds: ['direct-responder'], skippedAgentIds: [], appendAgentIds: ['direct-responder'], selectedSkillIds: [], executionWaves: [], steps: [],
  requiresReview: false, synthesisAgentId: 'synthesizer', reason: 'Only self-contained social dialogue.' });

const provider = createServer(async (request, response) => {
  try {
    let source = ''; for await (const chunk of request) source += chunk;
    const body = JSON.parse(source);
    const name = body.model;
    const count = (calls.get(name) ?? 0) + 1; calls.set(name, count);
    const system = body.messages.find((item) => item.role === 'system')?.content ?? '';
    const payload = JSON.parse(body.messages.find((item) => item.role === 'user')?.content ?? '{}');
    const stage = system.startsWith('You are the Router Agent') ? 'router' : 'scheduler';
    requests.push({ name, stage, repaired: Boolean(payload.correction), contract: payload.selectionContract, tools: body.tools });
    if (name === 'provider-unavailable') {
      response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Injected unavailable"}}'); return;
    }
    let output = stage === 'router' ? router() : scheduler();
    if (name.startsWith('conversation-')) output = stage === 'router' ? conversationalRouter() : conversationalScheduler();
    if (name === 'conversation-low-confidence' && stage === 'router') output.confidence = 0.7;
    if (name === 'conversation-repair' && stage === 'router' && !payload.correction) output = {};
    let finishReason = 'stop';
    let toolCalls;
    if (stage === 'scheduler' && (name === 'skill-repair' && !payload.correction || name === 'persistent-invalid' || name === 'shared-budget')) output.selectedSkillIds = ['tradeoffs', 'risk-analysis'];
    if (stage === 'router' && name === 'shared-budget' && !payload.correction) output = {};
    if (stage === 'router' && name === 'unavailable-capability') output.candidateAgentIds = ['invented-agent'];
    if (stage === 'scheduler' && !payload.correction && name === 'truncated-repair') finishReason = 'length';
    if (stage === 'scheduler' && !payload.correction && name === 'tool-repair') {
      toolCalls = [{ index: 0, id: 'must-not-execute', type: 'function', function: { name: 'shell.exec', arguments: '{"command":"MUST_NOT_EXECUTE"}' } }];
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output), ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ finish_reason: finishReason, delta: {} }], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Invalid fixture request"}}');
  }
});

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const stopChild = async () => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  if (process.platform === 'win32') {
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await once(killer, 'close');
  } else child.kill('SIGTERM');
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Isolated routing server did not stop.')); }, 8_000); })]); }
  finally { clearTimeout(timer); }
};
const cleanup = () => cleaning ??= (async () => {
  await stopChild();
  provider.closeAllConnections();
  if (provider.listening) await new Promise((done) => provider.close(done));
  const actual = await realpath(scratch); const leaf = relative(await realpath(tmpdir()), actual);
  assert.ok(leaf.startsWith('axiom-routing-http-') && !leaf.includes('..') && !leaf.includes('/') && !leaf.includes('\\') && !isAbsolute(leaf), 'Unsafe temporary cleanup path.');
  await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
})();
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });

const test = async (name, run) => {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); }
};
try {
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const environmentNames = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LANG']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => environmentNames.has(key.toUpperCase())));
  child = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href, join(root, 'server/index.ts'), '--api-only'], {
    cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...env, NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: '0', LOG_LEVEL: 'info',
      AXIOM_SQLITE_PATH: databasePath, AXIOM_OBJECT_STORAGE_PATH: join(scratch, 'artifacts'), AXIOM_AGENT_WORKSPACE_ROOT: join(scratch, 'workspace'),
      DATABASE_URL: '', AXIOM_PROVIDER_SECRET: 'isolated-routing-provider-secret-0123456789', AXIOM_API_KEY: apiKey,
      AXIOM_PRINCIPAL_SECRET: '', AXIOM_TOOL_EXECUTOR: 'disabled', AXIOM_SERVE_FRONTEND: 'false',
      DEEPSEEK_API_KEY: 'fixture-model-key', DEEPSEEK_API_BASE: providerUrl, DEEPSEEK_MODEL: 'fixture-default', DEEPSEEK_NATIVE_SEARCH: 'false', DEEPSEEK_FILES_API: 'false',
      TDAI_MEMORY_ENDPOINT: '', DEEPSEEK_HARNESS_URL: '', DMX_CONFIG_PATH: '', DMX_API_KEY: '', VIDEO_API_KEY: '', VIDEO_API_BASE: '',
    },
  });
  child.on('error', (error) => { childFailure = error; });
  const collect = (chunk) => { childLog = `${childLog}${chunk}`.slice(-12_000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  let port;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (childFailure) throw childFailure;
    if (child.exitCode !== null) throw new Error(`Isolated server failed to start: ${childLog}`);
    port = childLog.match(/"port":(\d+).*Axiom Agent Gateway listening/)?.[1];
    if (port) break; await delay(100);
  }
  assert.ok(port, 'Isolated server startup timed out.');
  const baseUrl = `http://127.0.0.1:${port}`;
  const request = async (name, message = 'Compare PostgreSQL and SQLite deployment tradeoffs.', authorized = true, extra = {}) => {
    const response = await fetch(`${baseUrl}/api/chat/route`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ message, mode: 'decide', ...extra, provider: { apiUrl: providerUrl, apiKey: 'fixture-model-key', model: name, location: 'local' } }), signal: AbortSignal.timeout(15_000) });
    return { response, body: await response.json() };
  };
  await test('healthy-plan-has-first-pass-diagnostics', async () => {
    const { response, body } = await request('healthy'); assert.equal(response.status, 200);
    assert.equal(body.decision.source, 'router-agent'); assert.equal(body.diagnostics.summary.firstPassValid, true);
    assert.equal(body.diagnostics.summary.modelCalls, 2); assert.equal(body.diagnostics.summary.totalTokens, 84); assert.equal(body.diagnostics.summary.repairTokens, 0);
    assert.equal(body.diagnostics.summary.schedulingPath, 'router-scheduler'); assert.equal(body.diagnostics.summary.schedulerSkippedReason, null);
  });
  await test('trivial-chat-skips-only-the-scheduler-with-real-http-token-accounting', async () => {
    const { response, body } = await request('conversation-fast', 'Hello!', true, { mode: 'analyze' }); assert.equal(response.status, 200);
    assert.equal(body.decision.source, 'router-agent'); assert.equal(body.decision.execution, 'gateway'); assert.equal(body.decision.agentRole, 'direct-responder');
    assert.equal(body.diagnostics.summary.firstPassValid, true); assert.equal(body.diagnostics.summary.modelCalls, 1); assert.equal(body.diagnostics.summary.totalTokens, 42);
    assert.equal(body.diagnostics.summary.schedulingPath, 'router-direct'); assert.equal(body.diagnostics.summary.schedulerSkippedReason, 'validated-trivial-conversation');
    assert.equal(calls.get('conversation-fast'), 1); assert.deepEqual(body.diagnostics.calls.map((call) => call.stage), ['router']);
    assert.equal(body.diagnostics.events.some((event) => event.stage === 'scheduler' && event.event === 'validation-passed'), false);
  });
  await test('follow-up-chat-keeps-scheduler-and-does-not-reactivate-old-agents', async () => {
    const { response, body } = await request('conversation-followup', 'Thank you!', true, { mode: 'analyze',
      conversationContext: [{ role: 'user', content: 'Compare database tradeoffs.' }, { role: 'assistant', content: 'The comparison is complete.' }],
      currentGraph: { nodes: [{ id: 'analysis', role: 'analyst', title: 'Analyst', status: 'completed', dependsOn: [] }], edges: [] } });
    assert.equal(response.status, 200); assert.equal(body.diagnostics.summary.modelCalls, 2); assert.equal(body.diagnostics.summary.schedulingPath, 'router-scheduler');
    assert.deepEqual(body.decision.scheduler.activeAgentIds, ['direct-responder']); assert.deepEqual(body.decision.scheduler.skippedAgentIds, ['analyst']);
  });
  for (const [name, expectedCalls] of [['conversation-low-confidence', 2], ['conversation-repair', 3]]) await test(`${name}-cannot-bypass-scheduler`, async () => {
    const { response, body } = await request(name, 'Hello!', true, { mode: 'analyze' }); assert.equal(response.status, 200);
    assert.equal(body.decision.source, 'router-agent'); assert.equal(body.diagnostics.summary.modelCalls, expectedCalls);
    assert.equal(body.diagnostics.summary.schedulingPath, 'router-scheduler'); assert.equal(body.diagnostics.summary.schedulerSkippedReason, null);
    assert.equal(calls.get(name), expectedCalls);
  });
  for (const [name, code] of [['skill-repair', 'unavailable-id'], ['truncated-repair', 'truncated-output'], ['tool-repair', 'unexpected-tool-call']]) {
    await test(`${name}-through-real-sse-provider`, async () => {
      const { response, body } = await request(name); assert.equal(response.status, 200); assert.equal(body.decision.source, 'router-agent');
      const summary = body.diagnostics.summary; assert.equal(summary.firstPassValid, false); assert.equal(summary.repaired, true); assert.equal(summary.fallback, false);
      assert.equal(summary.modelCalls, 3); assert.equal(summary.totalTokens, 126); assert.equal(summary.repairTokens, 42); assert.equal(summary.repairModelCalls, 1);
      assert.ok(body.diagnostics.events.some((event) => event.event === 'validation-rejected' && event.code === code));
      assert.ok(body.diagnostics.calls.every((call) => call.status === 'completed'));
      const selected = requests.filter((item) => item.name === name && item.stage === 'scheduler');
      assert.equal(selected.length, 2); assert.deepEqual(selected[0].contract, selected[1].contract);
      assert.deepEqual(body.decision.skillIds, ['architecture-design']);
    });
  }
  await test('persistent-invalid-output-falls-back-after-one-repair', async () => {
    const { response, body } = await request('persistent-invalid'); assert.equal(response.status, 200);
    assert.equal(body.decision.source, 'deterministic-fallback'); assert.equal(body.diagnostics.summary.repairModelCalls, 1); assert.equal(body.diagnostics.summary.modelCalls, 3);
    assert.equal(body.diagnostics.summary.fallbackCode, 'unavailable-id');
  });
  await test('router-repair-exhausts-scheduler-repair-budget', async () => {
    const { response, body } = await request('shared-budget'); assert.equal(response.status, 200);
    assert.equal(body.decision.source, 'deterministic-fallback'); assert.equal(body.diagnostics.summary.repairModelCalls, 1); assert.equal(body.diagnostics.summary.modelCalls, 3);
    assert.equal(body.diagnostics.summary.validationFailures, 2);
  });
  await test('provider-failure-is-not-a-semantic-repair', async () => {
    const { response, body } = await request('provider-unavailable'); assert.equal(response.status, 200);
    assert.equal(body.decision.source, 'deterministic-fallback'); assert.equal(body.diagnostics.summary.modelCalls, 1); assert.equal(body.diagnostics.summary.repairModelCalls, 0);
    assert.equal(body.diagnostics.summary.fallbackCode, 'provider-error'); assert.equal(body.diagnostics.summary.totalTokens, null);
  });
  await test('unavailable-required-agent-is-not-resurrected-by-fallback', async () => {
    const { response, body } = await request('unavailable-capability', 'Generate a video of a sunrise.');
    assert.equal(response.status, 503); assert.equal(body.code, 'ROUTING_CAPABILITY_UNAVAILABLE'); assert.equal(body.decision, undefined);
    assert.ok(body.diagnostics.events.some((event) => event.event === 'unavailable'));
  });
  await test('unauthenticated-route-does-not-call-provider', async () => {
    const { response } = await request('unauthenticated', 'Hello', false); assert.equal(response.status, 401); assert.equal(calls.has('unauthenticated'), false);
  });
  await test('all-calls-bounded-and-no-tools-offered', async () => {
    assert.ok([...calls.values()].every((count) => count <= 3)); assert.ok(requests.every((item) => item.tools === undefined));
  });
  await stopChild();
  await test('routing-and-injected-tool-call-create-no-execution-or-history', async () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try { for (const table of ['tasks', 'task_events', 'sessions', 'tool_execution_ledger', 'provider_bindings', 'axiom_business_records']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `Unexpected writes in ${table}`); }
    finally { db.close(); }
  });
} catch (error) {
  results.push({ name: 'isolated-http-smoke', passed: false, error: error instanceof Error ? error.message : String(error) });
} finally { await cleanup(); }

const report = { generatedAt: new Date().toISOString(), scope: 'Real isolated source HTTP server and loopback SSE provider; no paid models, tools or user histories.', passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, total: results.length, providerCalls: Object.fromEntries(calls), results };
await writeFile(join(root, 'qa/routing-repair-http-smoke-results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
