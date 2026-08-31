import type { OperationsAgentSummary, OperationsModelSummary, OperationsSnapshot, OperationsToolSummary } from './contracts.js';

export type OperationsTaskRow = {
  id: string;
  status: string;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | number | Date | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
};

export type OperationsEventRow = {
  taskId: string;
  type: string;
  agentId?: string | null;
  timestamp: string | number | Date;
  payload: Record<string, unknown>;
};

const numberValue = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

const timestamp = (value: string | number | Date | null | undefined) => {
  const parsed = value instanceof Date ? value.getTime() : new Date(value ?? 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const iso = (value: string | number | Date) => new Date(timestamp(value)).toISOString();

const percentage = (numerator: number, denominator: number) => denominator > 0
  ? Number((numerator / denominator * 100).toFixed(1))
  : null;

const percentile = (values: number[], ratio: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index]!);
};

const modelHealth = (calls: number, failures: number): OperationsModelSummary['health'] => {
  if (calls + failures === 0) return 'unknown';
  const rate = (calls / (calls + failures)) * 100;
  return rate >= 90 && failures === 0 ? 'healthy' : 'degraded';
};

export const buildOperationsSnapshot = (
  tasks: OperationsTaskRow[],
  events: OperationsEventRow[],
  options: { now?: number; windowHours?: number } = {},
): OperationsSnapshot => {
  const now = options.now ?? Date.now();
  const windowHours = Math.min(168, Math.max(1, Math.floor(options.windowHours ?? 24)));
  const windowStart = now - windowHours * 60 * 60 * 1_000;
  const inWindow = (value: string | number | Date) => timestamp(value) >= windowStart;

  const queueStatuses = ['queued', 'planning', 'running', 'reviewing', 'awaiting_approval', 'waiting_for_human', 'paused'] as const;
  const queue = {
    queued: 0,
    planning: 0,
    running: 0,
    reviewing: 0,
    awaitingApproval: 0,
    waitingForHuman: 0,
    paused: 0,
    totalActive: 0,
    oldestQueuedAt: undefined as string | undefined,
    oldestWaitMs: 0,
  };
  const leaseMap = new Map<string, { taskCount: number; leaseExpiresAt?: string }>();
  const activeLeaseWorkers = new Set<string>();
  let staleLeases = 0;
  const durations: number[] = [];
  let terminalTasks = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;

  for (const task of tasks) {
    const status = task.status;
    if (status === 'queued') queue.queued += 1;
    if (status === 'planning') queue.planning += 1;
    if (status === 'running') queue.running += 1;
    if (status === 'reviewing') queue.reviewing += 1;
    if (status === 'awaiting_approval') queue.awaitingApproval += 1;
    if (status === 'waiting_for_human') queue.waitingForHuman += 1;
    if (status === 'paused') queue.paused += 1;
    if ((queueStatuses as readonly string[]).includes(status)) queue.totalActive += 1;

    if (task.leaseOwner) {
      const expiry = timestamp(task.leaseExpiresAt);
      if (expiry > 0 && expiry <= now) staleLeases += 1;
      if (expiry > now) activeLeaseWorkers.add(task.leaseOwner);
      const current = leaseMap.get(task.leaseOwner) ?? { taskCount: 0 };
      current.taskCount += 1;
      if (expiry > 0) current.leaseExpiresAt = new Date(expiry).toISOString();
      leaseMap.set(task.leaseOwner, current);
    }

    // Queue pressure describes the current queue, even when a task has been
    // waiting longer than the selected event/terminal-task reporting window.
    if (status === 'queued') {
      const created = timestamp(task.createdAt);
      if (!queue.oldestQueuedAt || created < timestamp(queue.oldestQueuedAt)) queue.oldestQueuedAt = new Date(created).toISOString();
      queue.oldestWaitMs = Math.max(queue.oldestWaitMs, now - created);
    }

    if (!inWindow(task.updatedAt)) continue;
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      terminalTasks += 1;
      if (status === 'completed') completed += 1;
      if (status === 'failed') failed += 1;
      if (status === 'cancelled') cancelled += 1;
      const duration = Math.max(0, timestamp(task.updatedAt) - timestamp(task.createdAt));
      durations.push(duration);
    }
  }

  const modelMap = new Map<string, { calls: number; successes: number; failures: number; latencies: number[]; tokens: number; cost: number; lastUsedAt?: string }>();
  const toolMap = new Map<string, { calls: number; successes: number; failures: number; lastFailureAt?: string }>();
  const agentMap = new Map<string, { role?: string; started: number; completed: number; failed: number }>();
  let reviewerStarted = 0;
  let reviewerCompleted = 0;
  let reviewerApproved = 0;
  let reviewerRejected = 0;
  let humanTakeover = 0;

  for (const event of events) {
    if (!inWindow(event.timestamp)) continue;
    const payload = event.payload ?? {};
    if (event.type === 'model.completed') {
      const model = String(payload.model ?? '未标记模型').trim() || '未标记模型';
      const current = modelMap.get(model) ?? { calls: 0, successes: 0, failures: 0, latencies: [], tokens: 0, cost: 0 };
      current.calls += 1;
      current.successes += 1;
      current.latencies.push(numberValue(payload.durationMs));
      current.tokens += numberValue(payload.totalTokens);
      current.cost += numberValue(payload.estimatedCostUsd);
      current.lastUsedAt = iso(event.timestamp);
      modelMap.set(model, current);
    }
    if (event.type === 'agent.failed' || event.type === 'turn.failed') {
      const model = String(payload.model ?? '').trim();
      if (model) {
        const current = modelMap.get(model) ?? { calls: 0, successes: 0, failures: 0, latencies: [], tokens: 0, cost: 0 };
        current.failures += 1;
        current.lastUsedAt = iso(event.timestamp);
        modelMap.set(model, current);
      }
    }

    const toolName = String(payload.name ?? '').trim();
    if (toolName && ['tool.started', 'tool.completed', 'tool.failed'].includes(event.type)) {
      const current = toolMap.get(toolName) ?? { calls: 0, successes: 0, failures: 0 };
      if (event.type === 'tool.started') current.calls += 1;
      if (event.type === 'tool.completed') { current.successes += 1; current.calls = Math.max(current.calls, current.successes + current.failures); }
      if (event.type === 'tool.failed') { current.failures += 1; current.calls = Math.max(current.calls, current.successes + current.failures); current.lastFailureAt = iso(event.timestamp); }
      toolMap.set(toolName, current);
    }

    if (['agent.started', 'agent.completed', 'agent.failed'].includes(event.type)) {
      const agentId = String(event.agentId ?? payload.agentId ?? payload.role ?? '未标记 Agent').trim() || '未标记 Agent';
      const current = agentMap.get(agentId) ?? { started: 0, completed: 0, failed: 0 };
      if (typeof payload.role === 'string') current.role = payload.role;
      if (event.type === 'agent.started') current.started += 1;
      if (event.type === 'agent.completed') current.completed += 1;
      if (event.type === 'agent.failed') current.failed += 1;
      agentMap.set(agentId, current);
    }
    if (event.type === 'review.started') reviewerStarted += 1;
    if (event.type === 'review.completed') {
      reviewerCompleted += 1;
      if (payload.approved === true) reviewerApproved += 1;
      if (payload.approved === false) reviewerRejected += 1;
    }
    if (event.type === 'review.approval_requested') humanTakeover += 1;
  }

  const models = [...modelMap.entries()].map(([model, value]): OperationsModelSummary => ({
    model,
    calls: value.calls,
    successes: value.successes,
    failures: value.failures,
    successRate: percentage(value.successes, value.successes + value.failures),
    averageLatencyMs: value.latencies.length ? Math.round(value.latencies.reduce((sum, item) => sum + item, 0) / value.latencies.length) : 0,
    totalTokens: Math.round(value.tokens),
    estimatedCostUsd: Number(value.cost.toFixed(6)),
    ...(value.lastUsedAt ? { lastUsedAt: value.lastUsedAt } : {}),
    health: modelHealth(value.successes, value.failures),
  })).sort((left, right) => (right.lastUsedAt ?? '').localeCompare(left.lastUsedAt ?? ''));
  const tools = [...toolMap.entries()].map(([name, value]): OperationsToolSummary => ({
    name,
    calls: value.calls,
    successes: value.successes,
    failures: value.failures,
    failureRate: Number((value.failures / Math.max(1, value.successes + value.failures) * 100).toFixed(1)),
    ...(value.lastFailureAt ? { lastFailureAt: value.lastFailureAt } : {}),
  })).sort((left, right) => right.failures - left.failures || right.calls - left.calls);
  const agents = [...agentMap.entries()].map(([agentId, value]): OperationsAgentSummary => ({
    agentId,
    ...(value.role ? { role: value.role } : {}),
    started: value.started,
    completed: value.completed,
    failed: value.failed,
    successRate: percentage(value.completed, value.completed + value.failed),
  })).sort((left, right) => (right.started + right.completed) - (left.started + left.completed));

  return {
    generatedAt: new Date(now).toISOString(),
    windowHours,
    workers: {
      active: activeLeaseWorkers.size,
      leases: [...leaseMap.entries()].map(([workerId, value]) => ({ workerId, taskCount: value.taskCount, ...(value.leaseExpiresAt ? { leaseExpiresAt: value.leaseExpiresAt } : {}) })),
      staleLeases,
    },
    queue: { ...queue },
    models,
    tools,
    agents,
    reviewer: {
      started: reviewerStarted,
      completed: reviewerCompleted,
      approved: reviewerApproved,
      rejected: reviewerRejected,
      humanTakeover,
      approvalRate: percentage(reviewerApproved, reviewerCompleted),
    },
    sla: {
      terminalTasks,
      completed,
      failed,
      cancelled,
      successRate: percentage(completed, terminalTasks),
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
    },
  };
};
