import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowTask } from '../types';
import { taskHasPartialDelivery } from './taskDelivery';
import { miniAppTaskOutput, observeMiniAppTask, type MiniAppTaskProgress } from './miniAppExecution';
import { nexusTaskActivity } from './nexusRunPresentation';
import { deliveryEventActivity, taskStageLabel } from './taskPresentation';
import { translateUiText } from './uiLanguage';

const completedTask = (): WorkflowTask => ({
  id: 'delivery-fixture', status: 'completed', result: 'Saved result', stepResults: [],
  review: { approved: true, score: 100, summary: 'Accepted', gaps: [], requiredCorrections: [], delivery: {
    schemaVersion: 1, inputDigest: 'input', contractDigest: 'contract', resultDigest: 'result', status: 'passed',
    basis: 'model-assessment', factualCorrectness: 'not-independently-verified', requirements: [], assessedAt: '2026-09-21T00:00:00Z', correctionAttempts: 0,
    runtimeExecution: 'completed', runtimeGaps: [], upstreamReviewApproved: true,
  } },
} as unknown as WorkflowTask);

test('accepted deliveries retain incomplete results in history and Mini App output', () => {
  const original = completedTask();
  assert.equal(taskHasPartialDelivery(original), false);
  assert.equal(taskHasPartialDelivery({ ...original, review: undefined }), false);
  const patches: Array<Partial<NonNullable<NonNullable<WorkflowTask['review']>['delivery']>>> = [
    { status: 'needs-revision' }, { status: 'inconclusive' }, { runtimeExecution: 'partial' },
    { runtimeExecution: 'unverified' }, { runtimeExecution: undefined }, { runtimeGaps: ['Missing file'] }, { upstreamReviewApproved: false },
  ];
  for (const patch of patches) {
    const task = { ...original, review: { ...original.review!, delivery: { ...original.review!.delivery!, ...patch } } };
    assert.equal(task.review.approved, true);
    assert.equal(taskHasPartialDelivery(task), true);
    assert.match(miniAppTaskOutput(task), /^\[Partial result/);
    assert.equal(nexusTaskActivity(task.status, taskHasPartialDelivery(task)), 'Agent Nexus 已保存部分结果');
  }
});

test('delivery stages have readable bilingual progress without creating Agent Graph nodes', () => {
  for (const stage of ['delivery:requirements', 'delivery:contract-audit', 'delivery:verification', 'delivery:correction']) {
    assert.notEqual(taskStageLabel(stage), stage);
    const activity = deliveryEventActivity({ type: 'delivery.stage.started', payload: { stage } });
    assert.ok(activity?.includes('Agent'));
    assert.notEqual(translateUiText(activity!, 'en'), activity);
    assert.equal(translateUiText(activity!, 'zh-CN'), activity);
    assert.ok(deliveryEventActivity({ type: 'model.completed', payload: { stage } }));
    assert.equal(deliveryEventActivity({ type: 'model.failed', payload: { stage } }), '交付检查未完成');
  }
  assert.equal(deliveryEventActivity({ type: 'model.delta', payload: { stage: 'synthesizer' } }), null);
  assert.equal(deliveryEventActivity({ type: 'delivery.assessed', payload: { status: 'passed', runtimeExecution: 'completed', upstreamReviewApproved: false } }), '交付存在待处理项');
  assert.equal(deliveryEventActivity({ type: 'delivery.assessed', payload: { status: 'passed', runtimeExecution: 'unverified' } }), '交付结果待核对');
});

test('Mini App observes real delivery stage events and never shows complete for accepted partial results', async () => {
  const originalFetch = globalThis.fetch;
  const task = completedTask();
  task.review!.delivery!.status = 'needs-revision';
  let snapshots = 0;
  const stages = ['delivery:requirements', 'delivery:contract-audit', 'delivery:verification', 'delivery:correction'];
  const events = [...stages.map((stage, index) => ({ id: `stage-${index}`, type: 'delivery.stage.started', taskId: task.id, sequence: index + 1, payload: { stage } })),
    { id: 'terminal', type: 'task.completed', taskId: task.id, sequence: stages.length + 1, payload: {} }];
  const progress: MiniAppTaskProgress[] = [];
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('/events?')) return new Response(events.map((event) => `event: runtime\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      snapshots += 1;
      return Response.json({ task: { ...task, status: snapshots === 1 ? 'reviewing' : 'completed' } });
    };
    const result = await observeMiniAppTask(task.id, new AbortController().signal, (item) => progress.push(item));
    assert.match(result, /^\[Partial result/);
    for (const stage of stages) assert.ok(progress.some((item) => item.status === deliveryEventActivity({ type: 'delivery.stage.started', payload: { stage } })));
    assert.equal(progress.at(-1)?.completionStatus, 'partial');
    assert.ok(!progress.some((item) => item.status === 'Agent 已完成'));
    progress.length = 0;
    await observeMiniAppTask(task.id, new AbortController().signal, (item) => progress.push(item));
    assert.ok(!progress.some((item) => item.status === 'Agent 已完成'));
  } finally { globalThis.fetch = originalFetch; }
});
