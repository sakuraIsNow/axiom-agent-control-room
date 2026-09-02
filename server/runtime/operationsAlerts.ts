import type { OperationsAlert, OperationsAlertsSnapshot, OperationsSnapshot } from './contracts.js';
import type { RuntimeReadiness } from './readiness.js';

const numberEnv = (name: string, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};

const add = (alerts: OperationsAlert[], alert: OperationsAlert) => alerts.push(alert);

export const buildOperationsAlerts = (
  snapshot: OperationsSnapshot,
  readiness?: Pick<RuntimeReadiness, 'state' | 'blockers' | 'warnings'>,
  now = Date.now(),
): OperationsAlertsSnapshot => {
  const alerts: OperationsAlert[] = [];
  const queueWarning = numberEnv('AXIOM_ALERT_QUEUED_TASKS', 10, 1, 10_000);
  const queueCritical = numberEnv('AXIOM_ALERT_QUEUED_TASKS_CRITICAL', Math.max(queueWarning * 5, 50), queueWarning, 100_000);
  const waitWarning = numberEnv('AXIOM_ALERT_OLDEST_QUEUE_WAIT_MS', 300_000, 1_000, 86_400_000);
  const waitCritical = numberEnv('AXIOM_ALERT_OLDEST_QUEUE_WAIT_CRITICAL_MS', Math.max(waitWarning * 3, 900_000), waitWarning, 172_800_000);
  const toolFailureRate = numberEnv('AXIOM_ALERT_TOOL_FAILURE_RATE', 25, 1, 100);

  if (snapshot.queue.queued >= queueCritical) {
    add(alerts, {
      id: 'queue-backlog-critical', severity: 'critical', source: 'queue', metric: 'queue.queued',
      value: snapshot.queue.queued, threshold: queueCritical, title: '队列积压严重',
      detail: `排队任务达到 ${snapshot.queue.queued} 个，已超过严重阈值 ${queueCritical} 个。应立即扩容 Worker 或检查模型服务。`,
    });
  } else if (snapshot.queue.queued >= queueWarning) {
    add(alerts, {
      id: 'queue-backlog-warning', severity: 'warning', source: 'queue', metric: 'queue.queued',
      value: snapshot.queue.queued, threshold: queueWarning, title: '队列开始积压',
      detail: `排队任务达到 ${snapshot.queue.queued} 个，已超过提醒阈值 ${queueWarning} 个。`,
    });
  }

  if (snapshot.queue.oldestWaitMs >= waitCritical) {
    add(alerts, {
      id: 'queue-wait-critical', severity: 'critical', source: 'queue', metric: 'queue.oldestWaitMs',
      value: snapshot.queue.oldestWaitMs, threshold: waitCritical, title: '任务等待过久',
      detail: `最早排队任务已等待 ${Math.round(snapshot.queue.oldestWaitMs / 60_000)} 分钟，可能存在 Worker 或 Provider 阻塞。`,
    });
  } else if (snapshot.queue.oldestWaitMs >= waitWarning) {
    add(alerts, {
      id: 'queue-wait-warning', severity: 'warning', source: 'queue', metric: 'queue.oldestWaitMs',
      value: snapshot.queue.oldestWaitMs, threshold: waitWarning, title: '任务等待偏久',
      detail: `最早排队任务已等待 ${Math.round(snapshot.queue.oldestWaitMs / 60_000)} 分钟。`,
    });
  }

  if (snapshot.workers.staleLeases > 0) {
    add(alerts, {
      id: 'worker-stale-lease', severity: 'critical', source: 'worker', metric: 'workers.staleLeases',
      value: snapshot.workers.staleLeases, title: '发现过期 Worker 租约',
      detail: `${snapshot.workers.staleLeases} 个租约已过期，任务会在租约恢复窗口后重新认领。请检查 Worker 进程和数据库连接。`,
    });
  }

  const degradedModels = snapshot.models.filter((model) => model.health === 'degraded');
  for (const model of degradedModels.slice(0, 5)) {
    add(alerts, {
      id: `model-degraded:${model.model}`, severity: 'warning', source: 'model', metric: `${model.model}.successRate`,
      value: model.successRate ?? 0, threshold: 90, title: `模型 ${model.model} 需要关注`,
      detail: `最近窗口成功率 ${model.successRate ?? 0}%，失败 ${model.failures} 次，平均延迟 ${model.averageLatencyMs} ms。`,
    });
  }

  for (const tool of snapshot.tools.filter((candidate) => candidate.failures > 0 && candidate.failureRate >= toolFailureRate).slice(0, 5)) {
    add(alerts, {
      id: `tool-failure:${tool.name}`, severity: 'warning', source: 'tool', metric: `${tool.name}.failureRate`,
      value: tool.failureRate, threshold: toolFailureRate, title: `工具 ${tool.name} 失败率偏高`,
      detail: `最近窗口失败率 ${tool.failureRate}%，失败 ${tool.failures} 次。请检查工具权限、沙箱或外部依赖。`,
    });
  }

  if (snapshot.queue.waitingForHuman > 0 || snapshot.queue.awaitingApproval > 0) {
    const waiting = snapshot.queue.waitingForHuman + snapshot.queue.awaitingApproval;
    add(alerts, {
      id: 'review-backlog', severity: 'info', source: 'review', metric: 'review.pending', value: waiting,
      title: '有任务等待人工确认', detail: `当前有 ${waiting} 个任务需要人工查看或批准，确认后才能继续执行。`,
    });
  }

  if ((snapshot.artifacts?.cleanupFailures ?? 0) > 0 || (snapshot.artifacts?.deletePending ?? 0) > 0) {
    const failed = snapshot.artifacts?.cleanupFailures ?? 0;
    const pending = snapshot.artifacts?.deletePending ?? 0;
    add(alerts, {
      id: 'artifact-cleanup', severity: failed > 0 ? 'warning' : 'info', source: 'artifact', metric: 'artifacts.deletePending',
      value: pending, title: 'Artifact 清理队列有待处理项',
      detail: `${pending} 个 Artifact 等待清理${failed > 0 ? `，其中 ${failed} 个此前清理失败` : ''}。可在运行观测中重试。`,
    });
  }

  if (readiness?.state === 'blocked') {
    add(alerts, {
      id: 'readiness-blocked', severity: 'critical', source: 'readiness', metric: 'readiness.state', value: readiness.state,
      title: '服务未达到运行条件', detail: readiness.blockers.slice(0, 3).join('；') || 'Readiness 存在阻塞项。',
    });
  } else if (readiness?.state === 'degraded') {
    add(alerts, {
      id: 'readiness-degraded', severity: 'warning', source: 'readiness', metric: 'readiness.state', value: readiness.state,
      title: '服务处于受限模式', detail: readiness.warnings.slice(0, 3).join('；') || '部分生产依赖尚未配置或不可用。',
    });
  }

  const priority: Record<OperationsAlert['severity'], number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((left, right) => priority[left.severity] - priority[right.severity] || left.id.localeCompare(right.id));
  return {
    generatedAt: new Date(now).toISOString(),
    windowHours: snapshot.windowHours,
    ...(readiness ? { readinessState: readiness.state } : {}),
    summary: {
      critical: alerts.filter((alert) => alert.severity === 'critical').length,
      warning: alerts.filter((alert) => alert.severity === 'warning').length,
      info: alerts.filter((alert) => alert.severity === 'info').length,
    },
    alerts,
  };
};
