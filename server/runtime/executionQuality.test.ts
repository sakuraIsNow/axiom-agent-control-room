import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentMessage, ReviewResult, RuntimeEvent, StepResult, WorkflowTask } from './contracts.js';
import { formatDependencyContext, reviewMadeProgress } from './executionEfficiency.js';
import { summarizeExecutionQuality } from './executionQuality.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { createTaskApi } from './taskApi.js';
import { EventHub } from './eventHub.js';
import { deliveryContextDigest, deliverySources, parseDeliveryAssessment, parseDeliveryContract } from './deliveryVerification.js';

const epoch = Date.parse('2026-09-07T01:00:00Z');
const step: StepResult = { stepId: 'a', agentId: 'analyst-a', role: 'analyst', status: 'completed',
  output: 'Source-backed decision.', evidence: [], confidence: 0.9, attempts: 1, durationMs: 20 };
const task = { id: 'quality-task', runId: 'run-1', status: 'completed', createdAt: new Date(epoch).toISOString(),
  updatedAt: new Date(epoch + 100).toISOString(), stepResults: [step] } as WorkflowTask;
const event = (sequence: number, type: RuntimeEvent['type'], payload: Record<string, unknown> = {}, ms = sequence * 10): RuntimeEvent => ({
  id: `event-${sequence}`, taskId: task.id, runId: task.runId, sequence, type, payload, version: 1, timestamp: new Date(epoch + ms).toISOString(),
});

const taskWithDeliveryAssessment = (): WorkflowTask => {
  const current = { ...task, tenantId: 'quality-owner', userId: 'reader', sessionId: 'quality-session',
    input: 'Return budget 4700. Preserve retention of 14 days.', result: 'Budget: 4700. Retention: 14 days.', planVersion: 1,
    plan: { summary: 'Deliver the specified budget and retention.', routingReason: 'Authored quality fixture.', version: 1, approvalStatus: 'approved',
      profile: { kind: 'implementation', difficulty: 'hard', route: 'full-workflow', score: 5, reasons: ['fixture'], maxSteps: 1, requiresReview: false },
      steps: [{ id: 'a', title: 'Prepare delivery', role: 'analyst', objective: 'Preserve the supplied values.', dependsOn: [], acceptanceCriteria: ['Budget and retention are present.'] }] },
  } as WorkflowTask;
  const sources = deliverySources(current, []);
  const contract = parseDeliveryContract(JSON.stringify({ requirements: [
    { id: 'budget', text: 'Return budget 4700.', sourceId: 'input', sourceQuote: 'Return budget 4700.' },
    { id: 'retention', text: 'Preserve retention of 14 days.', sourceId: 'input', sourceQuote: 'Preserve retention of 14 days.' },
  ] }), sources);
  const delivery = parseDeliveryAssessment(JSON.stringify({ requirements: [
    { id: 'budget', status: 'satisfied', reason: 'The candidate includes the requested budget.', outputQuote: '4700' },
    { id: 'retention', status: 'satisfied', reason: 'The candidate includes the requested retention.', outputQuote: '14 days' },
  ] }), contract, current.result!);
  return { ...current, review: { approved: true, score: 100, summary: 'Model assessment completed.', gaps: [], requiredCorrections: [],
    delivery: { ...delivery, contextDigest: deliveryContextDigest(current, current.stepResults, [], sources.inputDigest) } } };
};

const reverseObjectKeys = <T,>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => reverseObjectKeys(item)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)])) as T;
  return value;
};

test('current delivery coverage counts model assessments without claiming factual accuracy', () => {
  const current = taskWithDeliveryAssessment();
  const quality = summarizeExecutionQuality(current, []).quality;
  assert.deepEqual(quality.requirementCoverage, { basis: 'model-assessment', satisfied: 2, total: 2, status: 'passed' });
  assert.equal(quality.factualCorrectness, 'not-independently-evaluated');
  const partial = structuredClone(current);
  partial.review!.delivery!.requirements[1]!.status = 'unknown';
  partial.review!.delivery!.status = 'inconclusive';
  assert.deepEqual(summarizeExecutionQuality(partial, []).quality.requirementCoverage,
    { basis: 'model-assessment', satisfied: 1, total: 2, status: 'inconclusive' });
  assert.equal(summarizeExecutionQuality(partial, []).quality.factualCorrectness, 'not-independently-evaluated');
});

for (const mutation of ['input', 'notes', 'work', 'result', 'plan', 'rerun'] as const) test(`delivery coverage becomes unknown after ${mutation} changes the assessed scope`, () => {
  const current = taskWithDeliveryAssessment();
  const history: RuntimeEvent[] = [];
  if (mutation === 'input') current.input = `${current.input} Include the source disclosure.`;
  if (mutation === 'notes') history.push(event(1, 'human.note', { author: current.userId, message: 'Include the source disclosure.' }));
  if (mutation === 'work') current.stepResults = current.stepResults.map((result) => ({ ...result, output: `${result.output} Evidence was updated.` }));
  if (mutation === 'result') current.result = 'This is a different draft.';
  if (mutation === 'plan') current.plan!.steps[0]!.objective = 'A changed objective.';
  if (mutation === 'rerun') history.push(event(1, 'node.rerun_requested', { stepId: 'a' }));
  assert.equal(summarizeExecutionQuality(current, history).quality.requirementCoverage, null);
});

test('JSONB-like key reordering preserves coverage of unchanged input, work and delivery', () => {
  const current = taskWithDeliveryAssessment();
  const reordered = reverseObjectKeys(current);
  assert.deepEqual(reordered, current);
  assert.notEqual(JSON.stringify(reordered.plan?.steps), JSON.stringify(current.plan?.steps));
  assert.notEqual(JSON.stringify(reordered.stepResults), JSON.stringify(current.stepResults));
  assert.deepEqual(summarizeExecutionQuality(reordered, []).quality.requirementCoverage,
    { basis: 'model-assessment', satisfied: 2, total: 2, status: 'passed' });
});

test('delivery extraction, assessment and text revision have separate truthful phase usage', () => {
  const current = taskWithDeliveryAssessment();
  const report = summarizeExecutionQuality(current, [
    event(1, 'model.completed', { stage: 'delivery:requirements', totalTokens: 11, durationMs: 10 }),
    event(2, 'model.completed', { stage: 'delivery:contract-audit', totalTokens: 13, durationMs: 15 }),
    event(3, 'model.completed', { stage: 'synthesizer', totalTokens: 17, durationMs: 20 }),
    event(4, 'model.completed', { stage: 'delivery:verification', totalTokens: 19, durationMs: 30 }),
    event(5, 'delivery.correction.started', { attempt: 1 }),
    event(6, 'model.completed', { stage: 'delivery:correction', totalTokens: 23, durationMs: 40 }),
    event(7, 'model.completed', { stage: 'delivery:verification', totalTokens: 29, durationMs: 50 }),
    event(8, 'task.completed'),
  ]);
  assert.equal(report.usage.calls, 6);
  assert.equal(report.usage.totalTokens, 112);
  assert.equal(report.phases.planning?.calls, 2);
  assert.equal(report.phases.planning?.totalTokens, 24);
  assert.equal(report.phases.review?.calls, 2);
  assert.equal(report.phases.review?.totalTokens, 48);
  assert.equal(report.phases.review?.durationMs, 80);
  assert.equal(report.phases.correction?.calls, 1);
  assert.equal(report.phases.correction?.totalTokens, 23);
  assert.equal(report.phases.delivery?.calls, 1);
  assert.equal(report.phases.delivery?.totalTokens, 17);
  assert.equal(report.quality.correctionRounds, 1);
  assert.equal(report.quality.firstAttemptExecutionSuccess, false);
  assert.equal(report.quality.humanTakeover, false);
});

test('starting a final delivery correction invalidates first-attempt success even without a retry or failed call', () => {
  const current = taskWithDeliveryAssessment();
  const calls = [event(1, 'model.completed', { stage: 'delivery:verification', totalTokens: 19 })];
  assert.equal(summarizeExecutionQuality(current, calls).quality.firstAttemptExecutionSuccess, true);
  const report = summarizeExecutionQuality(current, [...calls, event(2, 'delivery.correction.started', { attempt: 1 })]);
  assert.equal(report.usage.failures, 0);
  assert.equal(report.usage.retries, 0);
  assert.equal(report.quality.correctionRounds, 1);
  assert.equal(report.quality.firstAttemptExecutionSuccess, false);
});

test('execution quality deduplicates replay and keeps call duration separate from wall time', () => {
  const first = event(2, 'model.completed', { stage: 'agent:a:round:1', spanId: 'a', totalTokens: 30, durationMs: 90, promptCharacters: 200, attempts: 2 });
  const second = event(3, 'model.completed', { stage: 'agent:b:round:1', spanId: 'b', totalTokens: 50, durationMs: 80, promptCharacters: 300 });
  const report = summarizeExecutionQuality(task, [second, first, first, event(4, 'task.completed')]);
  assert.equal(report.usage.calls, 2);
  assert.equal(report.usage.totalTokens, null);
  assert.equal(report.usage.measuredTokens, 80);
  assert.equal(report.usage.unknownUsageAttempts, 1);
  assert.equal(report.usage.usageStatus, 'partial');
  assert.equal(report.usage.promptCharacters, 500);
  assert.equal(report.usage.retries, 1);
  assert.equal(report.timing.elapsedMs, 40);
  assert.equal(report.timing.modelCallDurationMs, 170);
  assert.equal(report.quality.firstAttemptExecutionSuccess, false);
});

test('execution quality does not report missing or failed-call usage as zero', () => {
  const report = summarizeExecutionQuality(task, [
    event(1, 'model.completed', { stage: 'planner', totalTokens: 10, durationMs: 20 }),
    event(2, 'model.failed', { stage: 'agent:a', usageStatus: 'unknown', durationMs: 45, attempts: 2 }),
    event(3, 'model.completed', { stage: 'synthesizer', usageStatus: 'unknown' }),
  ]);
  assert.equal(report.usage.totalTokens, null);
  assert.equal(report.usage.measuredTokens, 10);
  assert.equal(report.usage.usageStatus, 'partial');
  assert.equal(report.usage.unknownUsageCalls, 2);
  assert.equal(report.usage.failures, 1);
  assert.equal(report.phases.planning?.totalTokens, 10);
  assert.equal(report.phases.delivery?.totalTokens, null);
  const empty = summarizeExecutionQuality(task, []);
  assert.equal(empty.usage.totalTokens, null);
  assert.equal(empty.quality.firstAttemptExecutionSuccess, null);
  assert.equal(empty.routing.degraded, null);
});

test('specialist service failures are observable without inventing model calls or usage', () => {
  const report = summarizeExecutionQuality(task, [
    event(1, 'agent.failed', { serviceAgent: 'search-agent', callKind: 'specialist-service', usageStatus: 'not-observed' }),
    event(2, 'model.completed', { stage: 'synthesizer', totalTokens: 10 }),
  ]);
  assert.equal(report.quality.specialistServiceFailures, 1);
  assert.equal(report.quality.firstAttemptExecutionSuccess, false);
  assert.equal(report.usage.calls, 1);
  assert.equal(report.usage.failures, 0);
  assert.equal(report.usage.measuredTokens, 10);
});

test('execution quality measures useful answer separately from reasoning and reset events', () => {
  const report = summarizeExecutionQuality(task, [
    event(1, 'model.delta', { stage: 'planner', reasoning: 'Internal thought.' }),
    event(2, 'model.delta', { stage: 'synthesizer', content: 'discarded', reset: true }),
    event(3, 'model.delta', { stage: 'synthesizer', reasoning: 'Thinking.' }),
    event(4, 'model.delta', { stage: 'synthesizer', content: 'Deliverable.' }),
    event(5, 'task.completed'),
  ]);
  assert.equal(report.timing.firstActivityMs, 10);
  assert.equal(report.timing.firstAnswerMs, 40);
});

test('execution quality does not freeze at an earlier completion after local rerun', () => {
  const report = summarizeExecutionQuality({ ...task, status: 'running' }, [event(1, 'task.completed'), event(2, 'node.rerun_requested')], epoch + 500);
  assert.equal(report.timing.elapsedMs, 500);
  assert.equal(report.quality.humanTakeover, true);
});

test('execution quality counts manual node completion as human intervention', () => {
  const report = summarizeExecutionQuality(task, [event(1, 'model.completed', { stage: 'agent:a', totalTokens: 10 }), event(2, 'node.completed_manually')]);
  assert.equal(report.quality.humanTakeover, true);
  assert.equal(report.quality.manualActionCount, 1);
  assert.equal(report.quality.firstAttemptExecutionSuccess, false);
});

test('execution quality counts separate correction cycles even when round numbering restarts', () => {
  const report = summarizeExecutionQuality(task, [event(1, 'loop.iteration', { phase: 'review-correction', round: 1 }),
    event(2, 'plan.replanned'), event(3, 'loop.iteration', { phase: 'review-correction', round: 1 })]);
  assert.equal(report.quality.correctionRounds, 2);
});

test('creating a merged branch does not revoke acceptance of its unchanged source task', () => {
  const accepted = { ...task, review: { approved: true, score: 90, summary: 'Accepted', gaps: [], requiredCorrections: [] } };
  const history = [event(1, 'review.approved'), event(2, 'task.completed')];
  const source = summarizeExecutionQuality(accepted, [...history, event(3, 'checkpoint.merge_created', { mergedTaskId: 'new-merged-task', sourceTaskId: task.id })]);
  assert.equal(source.quality.acceptance, 'accepted');
  const changed = summarizeExecutionQuality(accepted, [...history, event(3, 'checkpoint.merge_created', { mergedTaskId: task.id })]);
  assert.equal(changed.quality.acceptance, 'not-recorded');
});

test('new Harness work invalidates prior acceptance but same-turn resume does not', () => {
  const accepted = { ...task, review: { approved: true, score: 90, summary: 'Accepted', gaps: [], requiredCorrections: [] } };
  const prior = [event(1, 'review.approved')];
  assert.equal(summarizeExecutionQuality(accepted, [...prior, event(2, 'harness.connected', { source: 'external-harness' })]).quality.acceptance, 'not-recorded');
  assert.equal(summarizeExecutionQuality(accepted, [...prior, event(2, 'harness.connected', { source: 'external-harness-resume' })]).quality.acceptance, 'accepted');
  assert.equal(summarizeExecutionQuality(accepted, [...prior, event(2, 'thread.resumed', { source: 'external-harness-recovery' })]).quality.acceptance, 'accepted');
});

test('a previous human approval does not approve a rerun or a new model-reviewed result', () => {
  const approved = { approved: true, score: 90, summary: 'Accepted', gaps: [], requiredCorrections: [] };
  const history = [event(1, 'review.approved'), event(2, 'task.completed'), event(3, 'node.rerun_requested')];
  assert.equal(summarizeExecutionQuality({ ...task, status: 'running' }, history).quality.acceptance, 'not-recorded');
  assert.equal(summarizeExecutionQuality({ ...task, review: approved }, history).quality.acceptance, 'not-recorded');
  assert.equal(summarizeExecutionQuality({ ...task, review: approved }, [...history, event(4, 'review.approved')]).quality.acceptance, 'accepted');
});

test('execution quality keeps approval, actual completion, and factual verification separate', () => {
  const report = summarizeExecutionQuality({ ...task, review: { approved: true, score: 99, summary: 'Approved', gaps: [], requiredCorrections: [] } }, [
    event(1, 'routing.decided', { source: 'deterministic-fallback' }),
    event(2, 'review.approval_requested'), event(3, 'review.approved'),
    event(4, 'loop.iteration', { phase: 'review-correction', round: 1 }),
    event(5, 'loop.iteration', { phase: 'review-stopped', reason: 'no-progress', round: 1 }),
    event(6, 'model.completed', { stage: 'synthesizer', totalTokens: 10 }),
  ]);
  assert.equal(report.quality.acceptance, 'accepted');
  assert.equal(report.quality.execution, 'completed');
  assert.equal(report.quality.factualCorrectness, 'not-independently-evaluated');
  assert.equal(report.quality.requirementCoverage, null);
  assert.equal(report.quality.humanTakeover, true);
  assert.equal(report.quality.firstAttemptExecutionSuccess, false);
  assert.equal(report.quality.correctionRounds, 1);
  assert.equal(report.quality.reviewNoProgressStops, 1);
  assert.equal(report.routing.degraded, true);
});

test('execution quality excludes foreign events and distinguishes incomplete execution', () => {
  const planned = { ...task, plan: { summary: 'Complete both', routingReason: 'test', steps: [
    { id: 'a', title: 'A', role: 'analyst', objective: 'A', dependsOn: [], acceptanceCriteria: ['A'] },
    { id: 'b', title: 'B', role: 'builder', objective: 'B', dependsOn: ['a'], acceptanceCriteria: ['B'] },
  ] } } as WorkflowTask;
  const report = summarizeExecutionQuality(planned, [{ ...event(1, 'model.completed', { totalTokens: 999 }), taskId: 'another-owner' },
    event(2, 'model.completed', { stage: 'agent:a', totalTokens: 10 })]);
  assert.equal(report.usage.totalTokens, 10);
  assert.equal(report.quality.execution, 'partial');
  assert.equal(report.quality.firstAttemptExecutionSuccess, false);
});

test('dependency context sends identical handoff text once and preserves source metadata', () => {
  const content = 'Long original findings. '.repeat(250);
  const message = { content, handoff: { summary: content, status: 'partial', openQuestions: ['Missing verification'],
    evidenceIds: ['source-a'], artifactIds: ['artifact-a'], completionCriteria: [] } } as unknown as AgentMessage;
  const formatted = formatDependencyContext(step, message, 4_000);
  assert.equal(formatted.split(content).length - 1, 1);
  assert.ok(formatted.length < content.length * 1.1, 'same information should not double the prompt');
  assert.match(formatted, /Missing verification/);
  assert.match(formatted, /source-a/);
  assert.match(formatted, /artifact-a/);
  const different = formatDependencyContext(step, { ...message, content: 'Selected fields only.' }, 4_000);
  assert.ok(different.includes(content));
  assert.ok(different.includes('Selected fields only.'));
});

test('review progress stops repeated rejected issues without discarding changed findings', () => {
  const review: ReviewResult = { approved: false, score: 45, summary: 'Missing proof', gaps: ['verify source', 'test restore'], requiredCorrections: [] };
  assert.equal(reviewMadeProgress(review, { ...review, summary: 'Different wording', gaps: [' test restore ', 'verify source'] }), false);
  assert.equal(reviewMadeProgress(review, { ...review, score: 55 }), true);
  assert.equal(reviewMadeProgress(review, { ...review, gaps: ['verify source'] }), true);
  assert.equal(reviewMadeProgress(review, { ...review, gaps: ['new contradiction'] }), true);
  assert.equal(reviewMadeProgress(review, { ...review, approved: true }), true);
});

test('task details rebuild execution quality from durable records and retain tenant isolation', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  try {
    const created = await store.createTask({ tenantId: 'tenant-quality', userId: 'reader', sessionId: 'quality-session', title: 'Quality', input: 'Check quality', mode: 'analyze' });
    await store.appendEvent(created, { type: 'model.completed', payload: { stage: 'planner', totalTokens: 45, durationMs: 50, usageStatus: 'measured' } });
    const api = createTaskApi({ store, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
    const response = await api.request(`/tasks/${created.id}`, { headers: { 'x-axiom-tenant-id': created.tenantId, 'x-axiom-user-id': created.userId } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.executionQuality.usage.totalTokens, 45);
    assert.equal(body.executionQuality.phases.planning.durationMs, 50);
    assert.equal((await api.request(`/tasks/${created.id}`, { headers: { 'x-axiom-tenant-id': 'foreign-tenant' } })).status, 404);
  } finally { await store.close(); }
});
