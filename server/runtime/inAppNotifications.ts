import type { ArtifactRecord } from './artifactCatalog.js';
import type {
  InAppNotification,
  TaskEventSummary,
  WorkflowTask,
} from './contracts.js';
import type { ScheduledTrigger } from './scheduler.js';

type NotificationProjectionInput = {
  tasks: WorkflowTask[];
  eventSummaries: Map<string, TaskEventSummary>;
  schedules?: ScheduledTrigger[];
  artifactCleanup?: ArtifactRecord[];
  readIds?: ReadonlySet<string>;
  now?: Date;
  lookbackDays?: number;
};

const urgency = { attention: 0, warning: 1, success: 2, info: 3 } as const;

const validTimestamp = (value: string | undefined, fallback: string) => (
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback
);

const completionEvidence = (summary: TaskEventSummary | undefined) => {
  if (summary?.latest?.type !== 'task.completed') return null;
  const value = summary.latest.payload.evidenceSummary;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const evidence = value as { status?: unknown; gaps?: unknown };
  return {
    status: typeof evidence.status === 'string' ? evidence.status : undefined,
    gaps: Array.isArray(evidence.gaps) ? evidence.gaps.filter((gap): gap is string => typeof gap === 'string') : [],
  };
};

const notification = (
  value: Omit<InAppNotification, 'read'>,
  readIds: ReadonlySet<string>,
): InAppNotification => ({ ...value, read: readIds.has(value.id) });

/**
 * Build a notification feed from authoritative task, schedule and Artifact
 * state. Only read receipts are persisted; resolving the source state removes
 * an action notification automatically.
 */
export const buildInAppNotifications = ({
  tasks,
  eventSummaries,
  schedules = [],
  artifactCleanup = [],
  readIds = new Set<string>(),
  now = new Date(),
  lookbackDays = 14,
}: NotificationProjectionInput): InAppNotification[] => {
  const result: InAppNotification[] = [];
  const fallbackTimestamp = now.toISOString();
  const recentCutoff = now.getTime() - Math.max(1, lookbackDays) * 86_400_000;

  for (const task of tasks) {
    const summary = eventSummaries.get(task.id);
    const target = { view: 'tasks' as const, taskId: task.id, sessionId: task.sessionId };
    const taskTimestamp = validTimestamp(task.updatedAt, fallbackTimestamp);

    if (task.status === 'awaiting_approval') {
      const id = `plan-approval:${task.id}:${task.planVersion ?? task.plan?.version ?? 0}`;
      result.push(notification({
        id,
        kind: 'approval_required',
        severity: 'attention',
        title: '执行计划等待确认',
        message: `“${task.title}”已完成编排，确认后才会开始执行。`,
        createdAt: taskTimestamp,
        target,
        action: { kind: 'open', label: '查看计划', resourceId: task.id },
      }, readIds));
      continue;
    }

    if (task.status === 'waiting_for_human') {
      const pendingApprovals = (task.toolApprovals ?? []).filter((approval) => approval.status === 'pending');
      if (pendingApprovals.length > 0) {
        for (const approval of pendingApprovals) {
          result.push(notification({
            id: `tool-approval:${task.id}:${approval.id}`,
            kind: 'approval_required',
            severity: 'attention',
            title: '工具操作等待确认',
            message: `“${task.title}”需要确认 ${approval.name} 后才能继续。`,
            createdAt: validTimestamp(approval.requestedAt, taskTimestamp),
            target,
            action: { kind: 'open', label: '查看并决定', resourceId: task.id },
          }, readIds));
        }
      } else if (task.review) {
        result.push(notification({
          id: `review-approval:${task.id}:${task.planVersion ?? 0}:${task.review.score}`,
          kind: 'approval_required',
          severity: 'attention',
          title: '交付结果等待审核',
          message: `“${task.title}”的质量评分为 ${task.review.score}/100，需要决定交付或整改。`,
          createdAt: taskTimestamp,
          target,
          action: { kind: 'open', label: '前往审核', resourceId: task.id },
        }, readIds));
      }
      continue;
    }

    if (task.status === 'failed') {
      if (Date.parse(taskTimestamp) < recentCutoff) continue;
      const fromPlugin = summary?.source === 'plugin';
      result.push(notification({
        id: `${fromPlugin ? 'plugin' : 'task'}-failed:${task.id}`,
        kind: fromPlugin ? 'plugin_failed' : 'task_failed',
        severity: 'warning',
        title: fromPlugin ? '插件运行未完成' : '任务执行未完成',
        message: `“${task.title}”保留了执行记录，可以查看原因后重新运行。`,
        createdAt: taskTimestamp,
        target,
        action: { kind: 'retry-task', label: '重新运行', resourceId: task.id },
      }, readIds));
      continue;
    }

    if (task.status !== 'completed' || Date.parse(taskTimestamp) < recentCutoff) continue;
    const evidence = completionEvidence(summary);
    const partial = evidence?.status === 'partial';
    result.push(notification({
      id: `${partial ? 'partial-delivery' : 'task-completed'}:${task.id}`,
      kind: partial ? 'partial_delivery' : 'task_completed',
      severity: partial ? 'warning' : 'success',
      title: partial ? '任务已形成部分交付' : '任务已完成',
      message: partial
        ? `“${task.title}”已有可用结果${evidence.gaps.length > 0 ? `，仍有 ${evidence.gaps.length} 项待补充` : ''}。`
        : `“${task.title}”已完成，可以查看交付结果。`,
      createdAt: taskTimestamp,
      target,
      action: { kind: 'open', label: partial ? '查看部分结果' : '查看结果', resourceId: task.id },
    }, readIds));
  }

  for (const schedule of schedules) {
    if (schedule.lastRunStatus !== 'dead-letter' || !schedule.deadLetteredAt) continue;
    result.push(notification({
      id: `schedule-dead-letter:${schedule.id}:${schedule.deadLetteredAt}`,
      kind: 'schedule_dead_letter',
      severity: 'attention',
      title: '日程已暂停',
      message: `“${schedule.title}”连续失败 ${schedule.failureCount} 次，需要检查后恢复。`,
      createdAt: validTimestamp(schedule.deadLetteredAt, fallbackTimestamp),
      target: { view: 'schedules', scheduleId: schedule.id },
      action: { kind: 'resume-schedule', label: '恢复日程', resourceId: schedule.id },
    }, readIds));
  }

  const failedArtifacts = artifactCleanup.filter((artifact) => artifact.cleanupAttempts > 0 && artifact.status === 'delete_pending');
  if (failedArtifacts.length > 0) {
    const latest = [...failedArtifacts].sort((left, right) => Date.parse(right.lastAttemptAt ?? right.createdAt) - Date.parse(left.lastAttemptAt ?? left.createdAt))[0]!;
    result.push(notification({
      id: `artifact-cleanup:${latest.id}:${latest.cleanupAttempts}`,
      kind: 'artifact_cleanup_failed',
      severity: 'warning',
      title: '文件清理需要重试',
      message: `${failedArtifacts.length} 个 Artifact 尚未清理完成，原任务结果不受影响。`,
      createdAt: validTimestamp(latest.lastAttemptAt, latest.createdAt),
      target: { view: 'operations' },
      action: { kind: 'retry-artifact-cleanup', label: '重新清理' },
    }, readIds));
  }

  return result.sort((left, right) => {
    if (left.read !== right.read) return left.read ? 1 : -1;
    const urgencyDelta = urgency[left.severity] - urgency[right.severity];
    if (urgencyDelta !== 0) return urgencyDelta;
    return Date.parse(right.createdAt) - Date.parse(left.createdAt);
  });
};
