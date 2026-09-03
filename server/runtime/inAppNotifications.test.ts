import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskEventSummary, WorkflowTask } from './contracts.js';
import { buildInAppNotifications } from './inAppNotifications.js';

const now = new Date('2026-09-03T08:00:00.000Z');
const task = (id: string, status: WorkflowTask['status'], patch: Partial<WorkflowTask> = {}): WorkflowTask => ({
  id,
  runId: `run-${id}`,
  revision: 1,
  tenantId: 'tenant-a',
  userId: 'user-a',
  sessionId: `session-${id}`,
  title: `任务 ${id}`,
  input: '完成目标',
  mode: 'analyze',
  status,
  stepResults: [],
  cancelRequested: false,
  planVersion: 1,
  policy: { requirePlanApproval: false },
  createdAt: '2026-09-03T07:00:00.000Z',
  updatedAt: '2026-09-03T07:30:00.000Z',
  ...patch,
});

const summary = (patch: Partial<TaskEventSummary> = {}): TaskEventSummary => ({
  modelCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  retries: 0,
  toolCalls: 0,
  ...patch,
});

test('notification projection distinguishes action, completion, partial and plugin failure states', () => {
  const tasks = [
    task('plan', 'awaiting_approval', {
      plan: { summary: 'plan', routingReason: 'test', steps: [], approvalStatus: 'pending' },
    }),
    task('tool', 'waiting_for_human', {
      toolApprovals: [{ id: 'approval-1', signature: 'signature', stepId: 'step-1', name: 'workspace.write', args: {}, risk: 'high', status: 'pending', requestedAt: '2026-09-03T07:40:00.000Z' }],
    }),
    task('review', 'waiting_for_human', {
      review: { approved: false, score: 61, summary: 'needs work', gaps: ['gap'], requiredCorrections: ['fix'] },
    }),
    task('done', 'completed'),
    task('partial', 'completed'),
    task('plugin', 'failed', { error: 'Bearer secret-token-that-must-not-leak' }),
  ];
  const summaries = new Map<string, TaskEventSummary>([
    ['done', summary({ latest: { type: 'task.completed', timestamp: '2026-09-03T07:30:00.000Z', payload: { evidenceSummary: { status: 'verified', gaps: [] } } } })],
    ['partial', summary({ latest: { type: 'task.completed', timestamp: '2026-09-03T07:30:00.000Z', payload: { evidenceSummary: { status: 'partial', gaps: ['one', 'two'] } } } })],
    ['plugin', summary({ source: 'plugin' })],
  ]);

  const notifications = buildInAppNotifications({ tasks, eventSummaries: summaries, now });
  assert.equal(notifications.filter((item) => item.kind === 'approval_required').length, 3);
  assert.equal(notifications.find((item) => item.kind === 'task_completed')?.action.label, '查看结果');
  assert.match(notifications.find((item) => item.kind === 'partial_delivery')?.message ?? '', /2 项待补充/);
  assert.equal(notifications.find((item) => item.kind === 'plugin_failed')?.action.kind, 'retry-task');
  assert.equal(JSON.stringify(notifications).includes('secret-token'), false);
});

test('notification projection includes durable schedule and cleanup failures and applies read receipts', () => {
  const scheduleDeadLetteredAt = '2026-09-03T07:50:00.000Z';
  const first = buildInAppNotifications({
    tasks: [],
    eventSummaries: new Map(),
    now,
    schedules: [{
      id: 'schedule-1', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-1', title: '每日简报', input: '生成简报', mode: 'analyze',
      cadence: { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' }, intervalSeconds: 86_400, enabled: false,
      nextRunAt: '2026-09-04T01:00:00.000Z', createdAt: '2026-09-01T01:00:00.000Z', failureCount: 5,
      lastRunStatus: 'dead-letter', deadLetteredAt: scheduleDeadLetteredAt,
    }],
    artifactCleanup: [{
      id: 'artifact-1', tenantId: 'tenant-a', taskId: 'task-1', source: 'result', bytes: 20,
      createdAt: '2026-09-03T07:00:00.000Z', referenceCount: 0, status: 'delete_pending', cleanupAttempts: 2,
      lastAttemptAt: '2026-09-03T07:55:00.000Z',
    }],
  });
  assert.deepEqual(first.map((item) => item.kind), ['schedule_dead_letter', 'artifact_cleanup_failed']);
  const readId = first[0]!.id;
  const second = buildInAppNotifications({
    tasks: [], eventSummaries: new Map(), now,
    schedules: [{
      id: 'schedule-1', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-1', title: '每日简报', input: '生成简报', mode: 'analyze',
      cadence: { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' }, intervalSeconds: 86_400, enabled: false,
      nextRunAt: '2026-09-04T01:00:00.000Z', createdAt: '2026-09-01T01:00:00.000Z', failureCount: 5,
      lastRunStatus: 'dead-letter', deadLetteredAt: scheduleDeadLetteredAt,
    }],
    readIds: new Set([readId]),
  });
  assert.equal(second[0]?.read, true);
});

test('resolved action notifications disappear instead of keeping stale approval state', () => {
  const waiting = task('approval', 'awaiting_approval');
  assert.equal(buildInAppNotifications({ tasks: [waiting], eventSummaries: new Map(), now }).length, 1);
  const running = { ...waiting, status: 'running' as const };
  assert.equal(buildInAppNotifications({ tasks: [running], eventSummaries: new Map(), now }).length, 0);
});
