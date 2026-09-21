import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PostgresTaskStore } from './postgresTaskStore.js';
import type { StepResult } from './contracts.js';
import { deliveryContextDigest, deliverySources, parseDeliveryAssessment, parseDeliveryContract } from './deliveryVerification.js';
import { summarizeExecutionQuality } from './executionQuality.js';

test('PostgreSQL stores and reloads object tool approvals as JSONB', async (t) => {
  const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();
  if (!connectionString) {
    t.skip('AXIOM_TEST_DATABASE_URL is not configured.');
    return;
  }
  const store = new PostgresTaskStore(connectionString);
  const tenantId = `jsonb-regression-${randomUUID()}`;
  await store.initialize();
  let taskId = '';
  try {
    const created = await store.createTask({
      tenantId,
      userId: 'jsonb-regression-user',
      sessionId: randomUUID(),
      title: 'JSONB approval regression',
      input: 'Persist an approval list.',
      mode: 'build',
    });
    taskId = created.id;
    const approval = {
      id: randomUUID(),
      name: 'workspace.write',
      stepId: 'step-jsonb',
      args: { path: 'output.html', content: '<svg><path d="M0 0" /></svg>' },
      signature: randomUUID(),
      risk: 'high' as const,
      status: 'pending' as const,
      requestedAt: new Date().toISOString(),
    };
    const updated = await store.updateTask(taskId, { status: 'waiting_for_human', toolApprovals: [approval] }, created.revision);
    assert.deepEqual(updated.toolApprovals, [approval]);
    assert.deepEqual((await store.getTask(taskId, tenantId))?.toolApprovals, [approval]);
    const approved = { ...approval, status: 'approved' as const, decidedBy: 'jsonb-regression-user', decidedAt: new Date().toISOString() };
    const resumed = await store.updateTask(taskId, { status: 'queued', toolApprovals: [approved] }, updated.revision);
    assert.deepEqual((await store.getTask(taskId, tenantId))?.toolApprovals, [approved]);
    const cleared = await store.updateTask(taskId, { toolApprovals: [] }, resumed.revision);
    assert.deepEqual((await store.getTask(taskId, tenantId))?.toolApprovals, []);
    await store.updateTask(taskId, { toolApprovals: null }, cleared.revision);
    assert.equal((await store.getTask(taskId, tenantId))?.toolApprovals, undefined);
  } finally {
    if (taskId) await store.deleteTask(taskId, tenantId).catch(() => undefined);
    await store.close();
  }
});

test('PostgreSQL JSONB roundtrip preserves arithmetic delivery receipts, events and context identity', async (t) => {
  const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();
  if (!connectionString) {
    t.skip('AXIOM_TEST_DATABASE_URL is not configured.');
    return;
  }
  const store = new PostgresTaskStore(connectionString);
  const tenantId = `jsonb-delivery-regression-${randomUUID()}`;
  let taskId = '';
  try {
    await store.initialize();
    const created = await store.createTask({ tenantId, userId: 'jsonb-delivery-owner', sessionId: randomUUID(), title: 'JSONB delivery receipt regression',
      input: 'Process 600 items at 120 items per hour. Return JSON hours as items divided by rate.', mode: 'build',
      plan: { summary: 'Calculate source-bound duration.', routingReason: 'JSONB integration fixture.', version: 1, approvalStatus: 'approved',
        profile: { kind: 'implementation', difficulty: 'hard', route: 'full-workflow', score: 5, reasons: ['database roundtrip'], maxSteps: 1, requiresReview: false },
        steps: [{ id: 'calculate', title: 'Calculate hours', role: 'analyst', objective: 'Divide item count by hourly rate.', dependsOn: [], acceptanceCriteria: ['JSON hours equals 600 / 120.'], toolNames: [], writeScopes: [] }] } });
    taskId = created.id;
    const results: StepResult[] = [{ stepId: 'calculate', agentId: 'analyst-calculate', role: 'analyst', status: 'completed', output: '600 / 120 = 5.',
      evidence: [], confidence: 0.9, attempts: 1, durationMs: 5,
      handoff: { summary: 'Duration calculated from supplied numbers.', status: 'complete', artifactIds: [], evidenceIds: [], openQuestions: [], completionCriteria: ['Calculation complete.'] } }];
    const prepared = await store.updateTask(taskId, { stepResults: results, result: '{"hours":5}', status: 'reviewing' }, created.revision);
    const sources = deliverySources(prepared, []);
    const contract = parseDeliveryContract(JSON.stringify({ requirements: [{ id: 'hours', text: 'Return numeric hours equal to 600 divided by 120.',
      sourceId: 'input', sourceQuote: prepared.input,
      calculation: { path: ['hours'], expression: { op: 'divide', args: [
        { sourceId: 'input', sourceQuote: '600', value: 600 }, { sourceId: 'input', sourceQuote: '120', value: 120 },
      ] } } }] }), sources);
    const assessed = parseDeliveryAssessment(JSON.stringify({ requirements: [{ id: 'hours', status: 'satisfied', reason: 'The requested numeric field is present.', outputQuote: '5' }] }), contract, prepared.result!);
    const contextDigest = deliveryContextDigest(prepared, results, [], sources.inputDigest);
    const delivery = { ...assessed, contextDigest, runtimeExecution: 'completed' as const, runtimeGaps: [], upstreamReviewApproved: true };
    const completed = await store.updateTask(taskId, { status: 'completed', review: { approved: true, score: 100, summary: 'Bounded calculation checked.', gaps: [], requiredCorrections: [], delivery } }, prepared.revision);
    await store.appendEvent(completed, { type: 'delivery.assessed', payload: { ...delivery } });
    await store.appendEvent(completed, { type: 'task.completed', payload: { partial: false } });

    const reloaded = await store.getTask(taskId, tenantId);
    assert.ok(reloaded);
    const events = await store.getEvents(taskId);
    assert.equal(reloaded.input, prepared.input);
    assert.equal(reloaded.result, prepared.result);
    assert.deepEqual(reloaded.plan?.steps, prepared.plan?.steps);
    assert.deepEqual(reloaded.stepResults, results);
    assert.deepEqual(reloaded.review?.delivery, delivery);
    assert.deepEqual(events.find((event) => event.type === 'delivery.assessed')?.payload, delivery);
    const calculation = reloaded.review?.delivery?.requirements[0]?.calculation;
    assert.deepEqual(calculation, { basis: 'deterministic-arithmetic', path: ['hours'], status: 'satisfied', expected: 5, actual: 5 });
    const restoredSources = deliverySources(reloaded, events);
    assert.equal(restoredSources.inputDigest, sources.inputDigest);
    assert.equal(deliveryContextDigest(reloaded, reloaded.stepResults, events, restoredSources.inputDigest), contextDigest);
    assert.deepEqual(summarizeExecutionQuality(reloaded, events).quality.requirementCoverage,
      { basis: 'model-assessment', satisfied: 1, total: 1, status: 'passed' });
  } finally {
    try { if (taskId) await store.deleteTask(taskId, tenantId); }
    finally { await store.close(); }
  }
});
