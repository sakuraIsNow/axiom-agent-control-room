import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowTask } from '../types';
import { deliveryReviewSummary, getTaskHumanSnapshot, submitTaskHumanAction, TaskActionError, taskNeedsHumanAction } from './taskActionRuntime';
import { isNexusTaskExecuting, isNexusTaskTerminal, nexusTaskActivity } from './nexusRunPresentation';

test('paused tasks retain pending plan, review and each distinct tool approval', () => {
  const task = { status: 'paused', plan: { approvalStatus: 'pending' }, review: { approved: false }, toolApprovals: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }, { id: 'c', status: 'approved' }] } as WorkflowTask;
  const actions = taskNeedsHumanAction(task);
  assert.equal(actions.plan, true); assert.equal(actions.review, true);
  assert.deepEqual(actions.tools.map((item) => item.id), ['a', 'b']);
  assert.equal(taskNeedsHumanAction({ ...task, status: 'completed' }).tools.length, 0);
  assert.equal(taskNeedsHumanAction({ ...task, status: 'cancelled' }).review, false);
  assert.equal(taskNeedsHumanAction({ ...task, plan: { ...task.plan!, approvalStatus: 'rejected' } }).planRejected, true);
});

test('task decisions carry exact revisions, approvals and revision instructions', async () => {
  const original = globalThis.fetch;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ path: String(url), body: JSON.parse(String(options?.body)) });
    return Response.json({ task: { id: 'task/a', revision: 9, status: 'queued' } });
  };
  try {
    await submitTaskHumanAction({ id: 'task/a', revision: 8 }, 'approve-tool', 'Checked the target', 'approval-2');
    assert.equal(requests[0].path, '/api/tasks/task%2Fa/approve-tool');
    assert.deepEqual(requests[0].body, { expectedRevision: 8, note: 'Checked the target', approvalId: 'approval-2' });
    await submitTaskHumanAction({ id: 'task/a', revision: 9 }, 'replan', 'Only update the draft');
    assert.deepEqual(requests[1].body, { expectedRevision: 9, note: 'Only update the draft', instruction: 'Only update the draft', preserveCompleted: true });
    await assert.rejects(submitTaskHumanAction({ id: 'task/a', revision: undefined! }, 'resume', ''), (error: unknown) => error instanceof TaskActionError && error.status === 409);
  } finally { globalThis.fetch = original; }
});

test('permission and conflict failures keep structured status instead of pretending success', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ error: 'No access' }, { status: 403 });
    await assert.rejects(getTaskHumanSnapshot('task'), (error: unknown) => error instanceof TaskActionError && error.status === 403);
    globalThis.fetch = async () => Response.json({ error: 'Changed' }, { status: 409 });
    await assert.rejects(submitTaskHumanAction({ id: 'task', revision: 3 }, 'approve-plan', ''), (error: unknown) => error instanceof TaskActionError && error.status === 409);
    globalThis.fetch = async () => Response.json({ task: { id: 'task', revision: 4 }, actionPermissions: { canManage: false } });
    assert.equal((await getTaskHumanSnapshot('task')).canManage, false);
  } finally { globalThis.fetch = original; }
});

test('Nexus only treats completed, failed and cancelled as terminal; human boundaries stay resumable', () => {
  for (const status of ['paused', 'awaiting_approval', 'waiting_for_human'] as const) {
    assert.equal(isNexusTaskTerminal(status), false); assert.equal(isNexusTaskExecuting(status), false);
    assert.ok(nexusTaskActivity(status));
  }
  assert.equal(isNexusTaskExecuting('running'), true);
  assert.equal(isNexusTaskTerminal('completed'), true);
  assert.equal(nexusTaskActivity('completed', true), 'Agent Nexus 已保存部分结果');
});

test('delivery checks count requirements without treating human acceptance as a passed assessment', async () => {
  const receipt = {
    schemaVersion: 1,
    inputDigest: 'input-digest', contractDigest: 'contract-digest', resultDigest: 'result-digest',
    status: 'needs-revision', basis: 'model-assessment', assessedAt: '2026-09-21T00:00:00Z', correctionAttempts: 1,
    factualCorrectness: 'not-independently-verified',
    requirements: [
      { id: 'r1', text: 'Use the latest budget', status: 'satisfied', reason: 'Matches the revision.', outputQuote: '4500' },
      { id: 'r2', text: 'Provide a source', status: 'unsatisfied', reason: 'No source was supplied.', outputQuote: '' },
      { id: 'r3', text: 'Verify the price', status: 'unknown', reason: 'Live price was not available.', outputQuote: '' },
    ],
  } as const;
  const task = { id: 'accepted', revision: 4, status: 'completed', review: { approved: true, score: 80, summary: 'Accepted by operator', gaps: [], requiredCorrections: [], delivery: { ...receipt, requirements: [...receipt.requirements] } } } as unknown as WorkflowTask;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ task, actionPermissions: { canManage: true } });
    const snapshot = await getTaskHumanSnapshot(task.id);
    const summary = deliveryReviewSummary(snapshot.task);
    assert.equal(summary?.receipt.status, 'needs-revision');
    assert.equal(summary?.receipt.factualCorrectness, 'not-independently-verified');
    assert.equal(summary?.satisfied, 1);
    assert.equal(summary?.total, 3);
    assert.deepEqual(summary?.outstanding.map((requirement) => requirement.id), ['r2', 'r3']);
  } finally { globalThis.fetch = original; }
});

test('older tasks do not invent delivery checks from reviewer approval or score', () => {
  assert.equal(deliveryReviewSummary({}), null);
  assert.equal(deliveryReviewSummary({ review: { approved: true, score: 100, summary: 'Approved', gaps: [], requiredCorrections: [] } }), null);
});

test('delivery summary does not present upstream rejection or incomplete execution as a fully passed result', () => {
  const task = { review: { approved: true, delivery: { schemaVersion: 1, status: 'passed', requirements: [], runtimeExecution: 'completed', runtimeGaps: [], upstreamReviewApproved: true } } } as unknown as WorkflowTask;
  assert.equal(deliveryReviewSummary(task)?.status, 'passed');
  const receipt = task.review!.delivery!;
  for (const override of [{ runtimeExecution: 'partial' }, { runtimeGaps: ['Export unavailable'] }, { upstreamReviewApproved: false }]) {
    const checked = deliveryReviewSummary({ review: { ...task.review!, delivery: { ...receipt, ...override } } } as WorkflowTask);
    assert.equal(checked?.status, 'needs-revision');
  }
  assert.equal(deliveryReviewSummary({ review: { ...task.review!, delivery: { ...receipt, runtimeExecution: undefined } } })?.status, 'inconclusive');
});
