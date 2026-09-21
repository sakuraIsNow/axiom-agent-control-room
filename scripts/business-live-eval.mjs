import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Document, Packer, Paragraph } from 'docx';
import pino from 'pino';
import { evaluateJsonDelivery, inspectSvgDelivery, liveDeliveryCases, unwrapDelivery } from '../qa/lib/live-delivery-cases.mjs';
import { liveDeliveryEnvironment, liveProviderOrigin } from '../qa/lib/live-delivery-isolation.mjs';
import { evaluateFinalDeliveryOutcome, finalDeliveryCases } from '../qa/lib/final-delivery-cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const finalDeliveryMode = process.argv.length === 4 && process.argv[3] === '--final-delivery';
const cases = finalDeliveryMode ? finalDeliveryCases : liveDeliveryCases;
const reportName = finalDeliveryMode ? 'final-delivery-live-eval' : 'business-live-eval';
const outputTokenLimit = finalDeliveryMode ? 4096 : 1800;
if ((process.argv.length !== 3 && !finalDeliveryMode) || process.argv[2] !== '--live') {
  console.error('Usage: node --import tsx scripts/business-live-eval.mjs --live [--final-delivery]');
  console.error('Uses the configured text model on four synthetic deliveries in an isolated workspace. Maximum 40 provider requests; no automatic suite retry. No real history or external tools.');
  process.exitCode = 2;
} else {
  const { config } = await import('dotenv');
  const providerEnv = { ...process.env };
  config({ path: resolve(root, '.env.local'), quiet: true, processEnv: providerEnv });
  config({ path: resolve(root, '.env'), quiet: true, processEnv: providerEnv });
  const apiBase = providerEnv.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com';
  const providerOrigin = liveProviderOrigin(apiBase);
  const model = providerEnv.DEEPSEEK_MODEL ?? 'deepseek-chat';
  const apiKey = providerEnv.DEEPSEEK_API_KEY?.trim() ?? '';
  const safeEnvironment = liveDeliveryEnvironment();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, safeEnvironment);
  for (const key of Object.keys(providerEnv)) delete providerEnv[key];
  const { OpenAICompatibleModelClient } = await import('../server/runtime/modelClient.ts');
  const { routeChatIntent, workflowPlanFromChatRoute, summarizeRoutingDiagnostics } = await import('../server/runtime/chatRouter.ts');
  const { WorkflowOrchestrator } = await import('../server/runtime/orchestrator.ts');
  const { SqliteTaskStore } = await import('../server/runtime/sqliteTaskStore.ts');
  const { createTaskApi } = await import('../server/runtime/taskApi.ts');
  const { EventHub } = await import('../server/runtime/eventHub.ts');
  const { attachmentDataUrl, extractAttachmentText } = await import('../server/runtime/attachmentContent.ts');
  const { summarizeExecutionQuality } = await import('../server/runtime/executionQuality.ts');
  const { defaultProviderLocation } = await import('../server/runtime/providerLocation.ts');
  const { FileArtifactStore } = await import('../server/runtime/artifactStore.ts');
  const { persistTaskInputAttachments } = await import('../server/runtime/taskInputAttachments.ts');
  const local = defaultProviderLocation(apiBase) === 'local';
  const directory = await mkdtemp(join(tmpdir(), 'axiom-business-live-'));
  const previousDirectory = process.cwd();
  const generatedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Live delivery suite deadline exceeded.')), 480_000);
  const abort = () => controller.abort(new Error('Live delivery suite interrupted.'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const originalFetch = globalThis.fetch;
  let browser;
  let providerRequests = 0;
  let modelCalls = 0;
  const observations = [];
  const calls = [];
  const scrub = (value) => String(value).replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[redacted-key]')
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]').slice(0, 24_000);
  const memory = {
    async recall() { return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }; },
    async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
  };
  try {
    process.chdir(directory);
    if (!apiKey && !local) throw new Error('Default text provider is not configured.');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    const provider = new OpenAICompatibleModelClient({ apiBase, apiKey, model, apiKeyOptional: local, maxAttempts: 1, timeoutMs: 35_000 });
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== providerOrigin || providerRequests >= 40) throw new Error('Live suite network/request boundary rejected.');
      providerRequests += 1;
      return originalFetch(input, { ...init, redirect: 'error' });
    };
    let caseModelCalls = 0;
    const client = { model: provider.model, async complete(request) {
      controller.signal.throwIfAborted();
      if (caseModelCalls >= 10 || modelCalls >= 40) throw new Error('Live suite model budget exceeded.');
      caseModelCalls += 1; modelCalls += 1;
      const started = performance.now();
      const record = { status: 'failed', tokens: null, durationMs: null };
      calls.push(record);
      try {
        const result = await provider.complete({ ...request, model: provider.model, tools: undefined, toolChoice: 'none', maxAttempts: 1, maxTokens: Math.min(request.maxTokens ?? outputTokenLimit, outputTokenLimit), signal: AbortSignal.any([controller.signal, request.signal]) });
        record.status = 'completed'; record.tokens = result.usage?.total_tokens ?? null;
        if (result.toolCalls?.length) throw new Error('No tools authorized in the live delivery suite.');
        return result;
      } finally { record.durationMs = Math.round(performance.now() - started); }
    } };
    for (const fixture of cases) {
      if (controller.signal.aborted) break;
      caseModelCalls = 0;
      const callStart = calls.length;
      const requestStart = providerRequests;
      const started = performance.now();
      const databasePath = join(directory, `${fixture.id}.sqlite`);
      let store = new SqliteTaskStore(databasePath);
      await store.initialize();
      let task;
      let route;
      let phase = 'attachment';
      const routingCalls = [], routingEvents = [];
      const observation = { id: fixture.id, scope: fixture.scope, passed: false, firstAttemptDeliverySuccess: false, output: '', assertions: {} };
      try {
        let extracted = '';
        const owner = { tenantId: 'live-delivery-isolated', userId: 'live-delivery-isolated', sessionId: fixture.id };
        const artifactStore = new FileArtifactStore(join(directory, fixture.id, 'artifacts'));
        let attachments = [];
        let inputAttachments = [];
        if (fixture.document) {
          const bytes = await Packer.toBuffer(new Document({ sections: [{ children: fixture.documentLines.map((line) => new Paragraph(line)) }] }));
          const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const attachment = { id: 'budget', name: 'budget.docx', kind: 'file', mimeType, dataUrl: attachmentDataUrl(bytes, mimeType) };
          extracted = await extractAttachmentText(attachment);
          assert.ok(fixture.documentLines.every((line) => extracted.includes(line)), 'DOCX content must survive extraction.');
          inputAttachments = await persistTaskInputAttachments({ messageId: 'budget-turn', attachments: [attachment] }, owner, artifactStore);
          attachments = [{ kind: 'file', name: 'budget.docx', mimeType }];
        }
        phase = 'routing';
        if (!fixture.deliveryGate) {
          route = await routeChatIntent({ message: `${fixture.message}${extracted ? `\nSupplied extracted document:\n${extracted}` : ''}`, mode: fixture.mode, attachments,
          conversationContext: fixture.history ?? [], currentGraph: null,
          availableAgents: [{ id: 'direct-responder', label: 'Direct', description: 'Answer only using supplied text.', capabilities: ['conversation'], available: true }, { id: 'analyst', label: 'Analyst', description: 'Analyze supplied records and constraints.', capabilities: ['analysis'], available: true }, { id: 'builder', label: 'Builder', description: 'Produce requested text or SVG source, with no tools.', capabilities: ['implementation'], available: true }, { id: 'document-agent', label: 'Document', description: 'Extract and analyze supplied Word, PDF and text attachments.', capabilities: ['document-analysis'], available: true }],
          onModelCall: (call) => routingCalls.push(call), onDiagnostic: (event) => routingEvents.push(event),
        }, client, AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]));
        assert.equal(route.source, 'router-agent', 'A fallback is not a successful live model-routing observation.');
          assert.equal(route.requiresSearch, false, 'All required evidence is supplied.');
        }
        const input = [fixture.history?.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join('\n\n'), `USER: ${fixture.message}`, extracted && `\nDocument budget.docx:\n${extracted}`].filter(Boolean).join('\n\n');
        // The production document specialist is exercised inside a durable task,
        // not the conversation gateway. This is recorded as a harness adaptation.
        const executionRoute = route?.intent === 'document-analysis' && route.execution !== 'workflow' ? { ...route, execution: 'workflow', workflowRoute: 'single-agent', scheduler: { ...route.scheduler, route: 'single-agent', steps: [{ id: 'document-analysis', agentId: 'document-agent', title: 'Document analysis', objective: fixture.message, dependsOn: [], skillIds: [] }], executionWaves: [['document-analysis']] } } : route;
        observation.documentGatewayAdapted = executionRoute !== route;
        const plan = fixture.plan ? structuredClone(fixture.plan) : workflowPlanFromChatRoute(executionRoute) ?? { summary: 'Model-authorized direct response.', steps: [], approvalStatus: 'approved', profile: { kind: route.router.taskKind, difficulty: route.router.difficulty, route: 'direct', score: 0, reasons: [route.reason], maxSteps: 0, requiresReview: false } };
        observation.fixedPlan = Boolean(fixture.plan);
        plan.inputAttachments = inputAttachments;
        phase = 'execution';
        task = await store.createTask({ ...owner, title: fixture.id, input, mode: fixture.mode, model: client.model, plan });
        const orchestrator = new WorkflowOrchestrator(store, new EventHub(), client, memory, pino({ level: 'silent' }), undefined, undefined, undefined, undefined, artifactStore);
        task = await orchestrator.run(task, AbortSignal.any([controller.signal, AbortSignal.timeout(finalDeliveryMode ? 180_000 : 100_000)]));
        const events = await store.getEvents(task.id);
        observation.output = scrub(task.result ?? '');
        observation.quality = summarizeExecutionQuality(task, events);
        observation.status = task.status;
        if (fixture.deliveryGate) observation.delivery = task.review?.delivery ?? null;
        phase = 'oracle';
        const oracle = fixture.deliveryGate ? evaluateFinalDeliveryOutcome(fixture, task.result ?? '', {
          taskStatus: task.status, delivery: task.review?.delivery,
          toolCalls: events.filter((event) => event.type === 'tool.completed').length,
          humanApprovals: events.filter((event) => event.type === 'review.approved').length,
          taskCompletedEvents: events.filter((event) => event.type === 'task.completed').length,
        }) : fixture.svg ? { passed: await page.evaluate(inspectSvgDelivery, unwrapDelivery(task.result ?? '', 'svg')), reason: 'Structural SVG parser and independent geometry/color/label requirements.' } : evaluateJsonDelivery(fixture, task.result ?? '');
        observation.oracle = oracle;
        observation.assertions = {
          expectedStatus: task.status === (fixture.expectedStatus ?? 'completed'), requirements: oracle.passed,
          streaming: events.some((event) => event.type === 'model.delta' && typeof event.payload.content === 'string' && event.payload.content.length > 0),
          terminalCount: events.filter((event) => ['task.completed', 'task.failed', 'task.cancelled'].includes(event.type)).length === (fixture.expectedStatus === 'waiting_for_human' ? 0 : 1),
          orderedEvents: events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence),
          noToolExecution: !events.some((event) => event.type === 'tool.completed'),
        };
        if (fixture.deliveryGate) {
          const expected = [].concat(fixture.expectedAssessmentStatus);
          observation.assertions.finalAssessment = expected.includes(task.review?.delivery?.status);
          observation.assertions.assessmentBoundToOutput = task.review?.delivery?.resultDigest === createHash('sha256').update(task.result ?? '').digest('hex');
          observation.assertions.noFactualGuarantee = task.review?.delivery?.factualCorrectness === 'not-independently-verified';
          observation.assertions.boundedCorrection = (task.review?.delivery?.correctionAttempts ?? Infinity) <= 1;
          observation.assertions.noHumanAutoApproval = !events.some((event) => event.type === 'review.approved');
        }
        const taskId = task.id;
        const output = task.result;
        phase = 'persistence';
        await store.close(); store = new SqliteTaskStore(databasePath); await store.initialize();
        const restored = await store.getTask(taskId, task.tenantId);
        const restoredEvents = await store.getEvents(taskId);
        assert.equal(process.env.DATABASE_URL, undefined, 'Task API must not create a real scheduler.');
        assert.ok(process.cwd().startsWith(directory), 'Default dependency paths must remain in the temporary workspace.');
        const api = createTaskApi({ store, hub: new EventHub(), coordinator: { nudge() {}, abort() {} }, artifactStore, memory });
        const response = await api.request(`/tasks/${taskId}/artifacts/result`, { headers: { 'x-axiom-tenant-id': task.tenantId, 'x-axiom-user-id': task.userId } });
        const artifact = await response.json();
        observation.assertions.reopenedHistory = restored?.result === output && restored?.status === task.status && restoredEvents.length === events.length;
        observation.assertions.deliveredArtifact = response.ok && artifact.artifact?.content === output;
        observation.passed = Object.values(observation.assertions).every(Boolean);
        observation.firstAttemptDeliverySuccess = observation.passed && observation.quality.quality.firstAttemptExecutionSuccess === true;
      } catch (error) { observation.error = { phase, type: scrub(error?.name ?? 'Error'), code: typeof error?.code === 'string' ? scrub(error.code) : null, message: 'Routing, execution, persistence or independent delivery validation failed. No suite retry was performed.' }; }
      finally { await store.close(); }
      observation.routing = { route: route?.workflowRoute ?? null, source: route?.source ?? null, diagnostics: summarizeRoutingDiagnostics(routingCalls, routingEvents), events: routingEvents.map(({ stage, event, code }) => ({ stage, event, code })) };
      observation.modelCalls = caseModelCalls; observation.providerRequests = providerRequests - requestStart;
      observation.durationMs = Math.round(performance.now() - started);
      const measured = calls.slice(callStart);
      observation.tokens = measured.length && measured.every((item) => item.tokens !== null && item.status === 'completed') ? measured.reduce((sum, item) => sum + item.tokens, 0) : null;
      observations.push(observation);
      console.log(`${fixture.id}: ${observation.passed ? 'passed' : 'failed'} (${observation.modelCalls} model calls)`);
    }
  } catch { observations.push({ id: 'suite-environment', passed: false, error: 'The isolated live suite could not initialize or complete. Check model and Chromium availability.' }); }
  finally {
    clearTimeout(timer); controller.abort(); globalThis.fetch = originalFetch;
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    await browser?.close();
    process.chdir(previousDirectory);
    const actual = await realpath(directory), temp = await realpath(tmpdir());
    const child = relative(temp, actual);
    if (!child.startsWith('axiom-business-live-') || child.includes('..') || child.includes('/') || child.includes('\\')) throw new Error('Cleanup containment check failed.');
    await rm(actual, { recursive: true, force: true });
  }
  const report = { suite: finalDeliveryMode ? 'final-delivery-live-v1' : 'business-live-delivery-v1', generatedAt, completedAt: new Date().toISOString(), model: scrub(model),
    oracleDigest: createHash('sha256').update(await readFile(resolve(root, finalDeliveryMode ? 'qa/lib/final-delivery-cases.mjs' : 'qa/lib/live-delivery-cases.mjs'))).digest('hex'),
    fixtureDigest: createHash('sha256').update(JSON.stringify(cases.map(({ schema: _schema, verify: _verify, ...item }) => item))).digest('hex'),
    methodology: finalDeliveryMode
      ? 'Real text model, fixed two-Agent complex plans and final verification in WorkflowOrchestrator. Independent exact JSON oracle and fail-closed unknown-evidence case, SQLite reopen and Artifact API. One observation per case; no suite retry or automatic human approval. Not a Router benchmark; intermediate review is excluded to isolate final verification.'
      : 'Real model Router/Scheduler and WorkflowOrchestrator, actual DOCX extraction, SQLite persistence reopen, final Artifact API and exact independent oracles. Four synthetic requests, one observation each; no retries of the suite and no model self-score.',
    limitations: finalDeliveryMode
      ? ['Fixed complex plans isolate final verification, not routing or intermediate Reviewer quality.', 'Two synthetic supplied-data observations, not an arbitrary-task accuracy or population benchmark.', 'No real external facts, tool effects, production certification or user history.', 'A semantic receipt is not an independent proof of factual correctness.']
      : ['Restricted read-only Agent directory; not the full production tool catalog.', 'Document gateway selection is adapted into a single durable step executing the actual document specialist, not an HTTP gateway test.', 'Supplied evidence, not live search or arbitrary factual truth.', 'SVG source is structurally parsed, not an image-generation service or screenshot test.', 'No real plugin/Nexus/external-write execution in this live subset.', 'Four observations are not a population benchmark or capacity test.'],
    limits: { totalModelCalls: 40, callsPerCase: 10, outputTokensPerCall: outputTokenLimit, totalDeadlineMs: 480_000 }, modelCalls, providerRequests,
    summary: { total: cases.length, observed: observations.filter((row) => row.id !== 'suite-environment').length, passed: observations.filter((row) => row.passed).length, failed: observations.filter((row) => !row.passed).length, firstAttemptDeliverySuccess: observations.filter((row) => row.firstAttemptDeliverySuccess).length }, observations };
  const passed = report.summary.observed === report.summary.total && report.summary.failed === 0;
  await mkdir(resolve(root, 'qa'), { recursive: true });
  const content = `${JSON.stringify({ ...report, passed }, null, 2)}\n`;
  await writeFile(resolve(root, `qa/${reportName}-${generatedAt.replace(/[:.]/g, '-')}-results.json`), content);
  await writeFile(resolve(root, `qa/${reportName}-results.json`), content);
  console.log(JSON.stringify({ success: passed, ...report.summary, modelCalls, providerRequests }, null, 2));
  if (!passed) process.exitCode = 1;
}
