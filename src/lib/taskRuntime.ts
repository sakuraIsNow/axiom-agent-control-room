import type { AgentMode, ChatRouteDecision, InAppNotificationFeed, InAppNotificationKind, OperationsAlertsSnapshot, OperationsSnapshot, OutboundNotificationCatalog, OutboundNotificationChannel, OutboundNotificationDelivery, TaskStats, TaskStatsDaily, WorkflowCheckpointBranch, WorkflowCheckpointDiff, WorkflowCheckpointSummary, WorkflowEvent, WorkflowTask, WorkflowTaskSummary } from '../types';
import type { ChatMessage, ExecutionPolicy, ProviderServiceSettings, ProviderSettings } from '../types';
import { consumeSseBlocks } from './sse';

export type TaskProviderConfig = Partial<Record<keyof ProviderSettings,
  Pick<ProviderServiceSettings, 'location'> & Partial<Pick<ProviderServiceSettings, 'credentialId' | 'apiKey' | 'apiUrl' | 'model'>>>>;

export function taskProviderConfig(settings: ProviderSettings): TaskProviderConfig {
  return Object.fromEntries(Object.entries(settings).flatMap(([kind, provider]) => provider.useCustom ? [[kind, {
    location: provider.location,
    ...(provider.credentialId ? { credentialId: provider.credentialId } : {}),
    ...(provider.apiKey.trim() ? { apiKey: provider.apiKey.trim() } : {}),
    ...(provider.apiUrl.trim() ? { apiUrl: provider.apiUrl.trim() } : {}),
    ...(provider.model.trim() ? { model: provider.model.trim() } : {}),
  }]] : []));
}

export async function createWorkflowTask(input: {
  sessionId: string;
  title: string;
  prompt: string;
  mode: AgentMode;
  templateId?: string;
  modelCredentialId?: string;
  providerConfig?: TaskProviderConfig;
  pluginId?: string;
  /** Stable per-turn key so a browser/network retry cannot create a duplicate task. */
  idempotencyKey?: string;
  signal: AbortSignal;
  policy?: Partial<ExecutionPolicy>;
  routing?: ChatRouteDecision;
  contextMessages?: ChatMessage[];
  inputSource?: { messageId: string; attachments: NonNullable<ChatMessage['attachments']> };
}) {
  const response = await fetch('/api/tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(input.idempotencyKey?.trim() ? { 'Idempotency-Key': input.idempotencyKey.trim().slice(0, 160) } : {}),
    },
    body: JSON.stringify({
      sessionId: input.sessionId,
      title: input.title,
      input: input.prompt,
      mode: input.mode,
      templateId: input.templateId,
      modelCredentialId: input.modelCredentialId,
      providerConfig: input.providerConfig,
      pluginId: input.pluginId,
      policy: input.policy,
      routing: input.routing,
      contextMessages: input.contextMessages?.map((message) => ({
        id: message.id, role: message.role, content: message.content, taskId: message.taskId,
        attachments: message.attachments?.map((attachment) => ({ id: attachment.id, kind: attachment.kind ?? 'image', ...('name' in attachment ? { name: attachment.name } : {}), ...('mimeType' in attachment ? { mimeType: attachment.mimeType } : {}), ...('size' in attachment ? { size: attachment.size } : {}) })),
      })),
      inputSource: input.inputSource ? { messageId: input.inputSource.messageId, attachments: input.inputSource.attachments.map((attachment) => ({
        id: attachment.id, kind: attachment.kind ?? 'image',
        ...('name' in attachment ? { name: attachment.name } : {}),
        ...('mimeType' in attachment ? { mimeType: attachment.mimeType } : {}),
        ...('url' in attachment ? { url: attachment.url } : {}),
        ...('dataUrl' in attachment ? { dataUrl: attachment.dataUrl } : {}),
        ...('text' in attachment ? { text: attachment.text } : {}),
      })) } : undefined,
    }),
    signal: input.signal,
  });
  const body = await response.json().catch(() => null) as { task?: WorkflowTask; error?: string } | null;
  if (!response.ok || !body?.task) throw new Error(body?.error ?? `Task API returned ${response.status}.`);
  return body.task;
}

export async function listWorkflowTasks(limit = 30, signal?: AbortSignal) {
  const response = await fetch(`/api/tasks?limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`, { signal });
  const body = await response.json().catch(() => null) as { tasks?: WorkflowTaskSummary[]; error?: string } | null;
  if (!response.ok || !Array.isArray(body?.tasks)) throw new Error(body?.error ?? `Task list returned ${response.status}.`);
  return body.tasks;
}

export async function getTaskStats(signal?: AbortSignal): Promise<TaskStats> {
  const response = await fetch('/api/tasks/stats', { signal });
  const body = await response.json().catch(() => null) as (TaskStats & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? `Task stats returned ${response.status}.`);
  return body;
}

export async function getTaskStatsDaily(days = 7, signal?: AbortSignal): Promise<TaskStatsDaily[]> {
  const response = await fetch(`/api/tasks/stats/daily?days=${Math.min(31, Math.max(1, Math.floor(days)))}`, { signal });
  const body = await response.json().catch(() => null) as { days?: TaskStatsDaily[]; error?: string } | null;
  if (!response.ok || !Array.isArray(body?.days)) throw new Error(body?.error ?? `Daily task stats returned ${response.status}.`);
  return body.days;
}

export async function getOperationsSnapshot(hours = 24, signal?: AbortSignal): Promise<OperationsSnapshot> {
  const safeHours = Math.min(168, Math.max(1, Math.floor(hours)));
  const response = await fetch(`/api/runtime/operations?hours=${safeHours}`, { signal });
  const body = await response.json().catch(() => null) as (OperationsSnapshot & { error?: string }) | null;
  if (!response.ok || !body?.generatedAt || !body.queue || !body.workers || !body.sla) {
    throw new Error(body?.error ?? `Operations snapshot returned ${response.status}.`);
  }
  return body;
}

export async function getOperationsAlerts(hours = 24, signal?: AbortSignal): Promise<OperationsAlertsSnapshot> {
  const safeHours = Math.min(168, Math.max(1, Math.floor(hours)));
  const response = await fetch(`/api/runtime/alerts?hours=${safeHours}`, { signal });
  const body = await response.json().catch(() => null) as (OperationsAlertsSnapshot & { error?: string }) | null;
  if (!response.ok || !body?.generatedAt || !body.summary || !Array.isArray(body.alerts)) {
    throw new Error(body?.error ?? `Runtime alerts returned ${response.status}.`);
  }
  return body;
}

export async function getInAppNotifications(limit = 40, signal?: AbortSignal): Promise<InAppNotificationFeed> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const response = await fetch(`/api/notifications?limit=${safeLimit}`, { signal });
  const body = await response.json().catch(() => null) as (InAppNotificationFeed & { error?: string }) | null;
  if (!response.ok || !body?.generatedAt || !Array.isArray(body.notifications) || typeof body.unreadCount !== 'number') {
    throw new Error(body?.error ?? `通知列表读取失败 (${response.status})。`);
  }
  return body;
}

export async function markInAppNotificationsRead(input: { ids?: string[]; all?: boolean }) {
  const response = await fetch('/api/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: input.ids ?? [], all: input.all ?? false }),
  });
  const body = await response.json().catch(() => null) as { marked?: number; unreadCount?: number; error?: string } | null;
  if (!response.ok || typeof body?.marked !== 'number' || typeof body.unreadCount !== 'number') {
    throw new Error(body?.error ?? `通知状态更新失败 (${response.status})。`);
  }
  return { marked: body.marked, unreadCount: body.unreadCount };
}

export async function getOutboundNotificationCatalog(signal?: AbortSignal): Promise<OutboundNotificationCatalog> {
  const response = await fetch('/api/notification-channels', { signal });
  const body = await response.json().catch(() => null) as (Partial<OutboundNotificationCatalog> & { error?: string }) | null;
  if (!response.ok || !Array.isArray(body?.channels) || !Array.isArray(body.deliveries) || !Array.isArray(body.supportedEventKinds)) {
    throw new Error(body?.error ?? `通知渠道读取失败 (${response.status})。`);
  }
  return body as OutboundNotificationCatalog;
}

export type OutboundNotificationChannelDraft = {
  name: string;
  endpoint?: string;
  signingSecret?: string;
  location: 'internet' | 'local';
  eventKinds: InAppNotificationKind[];
  enabled: boolean;
};

export async function createOutboundNotificationChannel(input: OutboundNotificationChannelDraft & { endpoint: string; signingSecret: string }): Promise<OutboundNotificationChannel> {
  const response = await fetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { channel?: OutboundNotificationChannel; error?: string } | null;
  if (!response.ok || !body?.channel) throw new Error(body?.error ?? `通知渠道创建失败 (${response.status})。`);
  return body.channel;
}

export async function updateOutboundNotificationChannel(channelId: string, input: Partial<OutboundNotificationChannelDraft>): Promise<OutboundNotificationChannel> {
  const response = await fetch(`/api/notification-channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { channel?: OutboundNotificationChannel; error?: string } | null;
  if (!response.ok || !body?.channel) throw new Error(body?.error ?? `通知渠道更新失败 (${response.status})。`);
  return body.channel;
}

export async function deleteOutboundNotificationChannel(channelId: string) {
  const response = await fetch(`/api/notification-channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `通知渠道删除失败 (${response.status})。`);
  }
}

export async function testOutboundNotificationChannel(channelId: string): Promise<OutboundNotificationDelivery> {
  const response = await fetch(`/api/notification-channels/${encodeURIComponent(channelId)}/test`, { method: 'POST' });
  const body = await response.json().catch(() => null) as { delivery?: OutboundNotificationDelivery; error?: string } | null;
  if (!response.ok || !body?.delivery) throw new Error(body?.error ?? `测试通知发送失败 (${response.status})。`);
  return body.delivery;
}

export async function retryOutboundNotificationDelivery(deliveryId: string): Promise<OutboundNotificationDelivery> {
  const response = await fetch(`/api/notification-deliveries/${encodeURIComponent(deliveryId)}/retry`, { method: 'POST' });
  const body = await response.json().catch(() => null) as { delivery?: OutboundNotificationDelivery; error?: string } | null;
  if (!response.ok || !body?.delivery) throw new Error(body?.error ?? `通知重投失败 (${response.status})。`);
  return body.delivery;
}

export async function cleanupArtifacts(limit = 50, signal?: AbortSignal) {
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const response = await fetch(`/api/runtime/artifacts/cleanup?limit=${safeLimit}`, { method: 'POST', signal });
  const body = await response.json().catch(() => null) as { scanned?: number; deleted?: number; failed?: number; stats?: OperationsSnapshot['artifacts']; error?: string } | null;
  if (!response.ok || !body) throw new Error(body?.error ?? `Artifact 清理返回 ${response.status}。`);
  return body;
}

export async function getCurrentPrincipal(signal?: AbortSignal): Promise<{ tenantId: string; userId: string; role: string }> {
  const response = await fetch('/api/whoami', { signal });
  const body = await response.json().catch(() => null) as { tenantId?: string; userId?: string; role?: string; error?: string } | null;
  if (!response.ok || !body?.userId || !body.tenantId) throw new Error(body?.error ?? `Principal lookup returned ${response.status}.`);
  return { tenantId: body.tenantId, userId: body.userId, role: body.role ?? 'member' };
}

export async function getWorkflowTask(taskId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { signal });
  const body = await response.json().catch(() => null) as { task?: WorkflowTask; error?: string } | null;
  if (!response.ok || !body?.task) throw new Error(body?.error ?? `Task lookup returned ${response.status}.`);
  return body.task;
}

export async function listWorkflowCheckpoints(taskId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/checkpoints`, { signal });
  const body = await response.json().catch(() => null) as {
    taskId?: string;
    currentRevision?: number;
    checkpoints?: WorkflowCheckpointSummary[];
    branches?: WorkflowCheckpointBranch[];
    error?: string;
  } | null;
  if (!response.ok || !Array.isArray(body?.checkpoints) || !Array.isArray(body.branches) || typeof body.currentRevision !== 'number') {
    throw new Error(body?.error ?? `Checkpoint list returned ${response.status}.`);
  }
  return {
    taskId: body.taskId ?? taskId,
    currentRevision: body.currentRevision,
    checkpoints: body.checkpoints,
    branches: body.branches,
  };
}

export async function compareWorkflowCheckpoint(taskId: string, checkpointId: string, targetTaskId?: string, signal?: AbortSignal) {
  const query = targetTaskId ? `?targetTaskId=${encodeURIComponent(targetTaskId)}` : '';
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/checkpoints/${encodeURIComponent(checkpointId)}/diff${query}`, { signal });
  const body = await response.json().catch(() => null) as { diff?: WorkflowCheckpointDiff; error?: string } | null;
  if (!response.ok || !body?.diff) throw new Error(body?.error ?? `Checkpoint comparison returned ${response.status}.`);
  return body.diff;
}

export async function branchWorkflowCheckpoint(input: {
  taskId: string;
  checkpointId: string;
  expectedRevision: number;
  instruction?: string;
  behavior?: 'continue' | 'replan';
  title?: string;
  operationId?: string;
}) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(input.taskId)}/checkpoints/${encodeURIComponent(input.checkpointId)}/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: input.expectedRevision,
      operationId: input.operationId ?? crypto.randomUUID(),
      instruction: input.instruction ?? '',
      behavior: input.behavior ?? 'continue',
      title: input.title,
    }),
  });
  const body = await response.json().catch(() => null) as { task?: WorkflowTask; error?: string; code?: string; actualRevision?: number } | null;
  if (!response.ok || !body?.task) throw Object.assign(new Error(body?.error ?? `Checkpoint branch returned ${response.status}.`), { code: body?.code, actualRevision: body?.actualRevision });
  return body.task;
}

export async function mergeWorkflowCheckpoint(input: {
  taskId: string;
  checkpointId: string;
  branchTaskId: string;
  expectedRevision: number;
  strategy?: 'manual' | 'prefer-branch' | 'prefer-current';
  title?: string;
  operationId?: string;
}) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(input.taskId)}/checkpoints/${encodeURIComponent(input.checkpointId)}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: input.expectedRevision,
      operationId: input.operationId ?? crypto.randomUUID(),
      branchTaskId: input.branchTaskId,
      strategy: input.strategy ?? 'manual',
      title: input.title,
    }),
  });
  const body = await response.json().catch(() => null) as { task?: WorkflowTask; error?: string; code?: string; actualRevision?: number; conflicts?: string[] } | null;
  if (!response.ok || !body?.task) throw Object.assign(new Error(body?.error ?? `Checkpoint merge returned ${response.status}.`), { code: body?.code, actualRevision: body?.actualRevision, conflicts: body?.conflicts });
  return body.task;
}

export async function deleteWorkflowTask(taskId: string) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Task deletion returned ${response.status}.`);
  }
}

export async function getWorkflowArtifact(taskId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/result`, { signal });
  const body = await response.json().catch(() => null) as { artifact?: { content?: string }; error?: string } | null;
  if (!response.ok || !body?.artifact) throw new Error(body?.error ?? `Artifact lookup returned ${response.status}.`);
  return body.artifact;
}

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    window.clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

export async function streamWorkflowEvents(
  taskId: string,
  signal: AbortSignal,
  onEvent: (event: WorkflowEvent) => void,
  afterSequence = 0,
) {
  let lastSequence = Math.max(0, Math.floor(afterSequence));
  let reconnects = 0;
  let terminal = false;
  let humanBoundary = false;

  while (!terminal && !signal.aborted) {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/events?after=${lastSequence}`, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Task event stream returned ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSseBlocks(buffer, (block) => {
        const eventName = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
        const rawData = block.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (eventName !== 'runtime' || !rawData) return;
        const event = JSON.parse(rawData) as WorkflowEvent;
        if (event.sequence <= lastSequence) return;
        lastSequence = event.sequence;
        onEvent(event);
        humanBoundary = ['plan.approval_requested', 'plan.rejected', 'review.approval_requested', 'review.rejected', 'tool.approval_requested', 'tool.rejected', 'tool.outcome_unknown', 'task.paused'].includes(event.type);
        terminal = event.type === 'task.completed'
          || event.type === 'task.failed'
          || event.type === 'task.cancelled'
          || event.type === 'task.paused'
          || event.type === 'tool.outcome_unknown'
          || event.type === 'plan.approval_requested'
          || event.type === 'plan.rejected'
          || event.type === 'review.approval_requested'
          || event.type === 'review.rejected'
          || event.type === 'tool.approval_requested'
          || event.type === 'tool.rejected';
      });
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      consumeSseBlocks(`${buffer}\n\n`, (block) => {
        const eventName = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
        const rawData = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
        if (eventName !== 'runtime' || !rawData) return;
        const event = JSON.parse(rawData) as WorkflowEvent;
        if (event.sequence <= lastSequence) return;
        lastSequence = event.sequence;
        onEvent(event);
        humanBoundary = ['plan.approval_requested', 'plan.rejected', 'review.approval_requested', 'review.rejected', 'tool.approval_requested', 'tool.rejected', 'tool.outcome_unknown', 'task.paused'].includes(event.type);
        terminal = event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled'
          || event.type === 'task.paused' || event.type === 'tool.outcome_unknown'
          || event.type === 'plan.approval_requested' || event.type === 'plan.rejected'
          || event.type === 'review.approval_requested' || event.type === 'review.rejected'
          || event.type === 'tool.approval_requested' || event.type === 'tool.rejected';
      });
    }

    if (terminal && humanBoundary && !signal.aborted) {
      const current = await getWorkflowTask(taskId, signal);
      terminal = !['queued', 'planning', 'running', 'reviewing'].includes(current.status);
    }
    if (!terminal && !signal.aborted) {
      reconnects += 1;
      if (reconnects > 8) throw new Error('Task event stream could not be reconnected.');
      await delay(Math.min(5_000, 350 * 2 ** (reconnects - 1)), signal);
    }
  }
}

export async function cancelWorkflowTask(taskId: string) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
  if (!response.ok && response.status !== 409) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Task cancellation returned ${response.status}.`);
  }
}

export async function pauseWorkflowTask(taskId: string, reason = '操作员已暂停任务。') {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  const body = await response.json().catch(() => null) as { task?: WorkflowTask; error?: string } | null;
  if (!response.ok || !body?.task) throw new Error(body?.error ?? `Task pause returned ${response.status}.`);
  return body.task;
}

export async function resumeWorkflowTask(taskId: string) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/resume`, { method: 'POST' });
  const body = await response.json().catch(() => null) as { task?: WorkflowTask; error?: string } | null;
  if (!response.ok || !body?.task) throw new Error(body?.error ?? `Task resume returned ${response.status}.`);
  return body.task;
}

export async function sendTaskNote(taskId: string, message: string) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const body = await response.json().catch(() => null) as { note?: WorkflowEvent; error?: string } | null;
  if (!response.ok || !body?.note) throw new Error(body?.error ?? `Operator note returned ${response.status}.`);
  return body.note;
}

export type TaskGuidanceReceipt = {
  taskId: string;
  guidanceId: string;
  status: 'accepted' | 'applied';
  delivery: 'builtin-next-safe-point' | 'external-harness';
  accepted: WorkflowEvent;
  applied?: WorkflowEvent;
};

export async function sendTaskGuidance(taskId: string, message: string, behavior: 'continue' | 'replan' = 'continue') {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/guidance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, behavior }),
  });
  const body = await response.json().catch(() => null) as (Partial<TaskGuidanceReceipt> & { error?: string }) | null;
  if (!response.ok || !body?.guidanceId || !body.accepted || !body.status || !body.delivery) {
    throw new Error(body?.error ?? `Task guidance returned ${response.status}.`);
  }
  return body as TaskGuidanceReceipt;
}

export async function retryWorkflowTask(taskId: string) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' });
  const body = await response.json().catch(() => null) as { task?: WorkflowTask; error?: string } | null;
  if (!response.ok || !body?.task) throw new Error(body?.error ?? `Task retry returned ${response.status}.`);
  return body.task;
}

const postTaskControl = async (path: string, body?: Record<string, unknown>) => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => null) as { task?: WorkflowTask; event?: WorkflowEvent; error?: string } | null;
  if (!response.ok || !payload?.task) throw new Error(payload?.error ?? `Task control returned ${response.status}.`);
  return { task: payload.task, event: payload.event };
};

export const approveWorkflowPlan = (taskId: string, note = '') => postTaskControl(
  `/api/tasks/${encodeURIComponent(taskId)}/approve-plan`,
  { note },
);

export const rejectWorkflowPlan = (taskId: string, note = '') => postTaskControl(
  `/api/tasks/${encodeURIComponent(taskId)}/reject-plan`,
  { note },
);

export const approveWorkflowReview = (taskId: string, note = '') => postTaskControl(
  `/api/tasks/${encodeURIComponent(taskId)}/approve-review`,
  { note },
);

export const rejectWorkflowReview = (taskId: string, note = '') => postTaskControl(
  `/api/tasks/${encodeURIComponent(taskId)}/reject-review`,
  { note },
);

export const approveWorkflowTool = (taskId: string, approvalId: string, note = '') => postTaskControl(
  `/api/tasks/${encodeURIComponent(taskId)}/approve-tool`,
  { approvalId, note },
);

export const rejectWorkflowTool = (taskId: string, approvalId: string, note = '') => postTaskControl(
  `/api/tasks/${encodeURIComponent(taskId)}/reject-tool`,
  { approvalId, note },
);

export const replanWorkflowTask = (taskId: string, instruction: string, preserveCompleted = false) => postTaskControl(
  `/api/tasks/${encodeURIComponent(taskId)}/replan`,
  { instruction, preserveCompleted },
);

export const controlWorkflowNode = (
  taskId: string,
  nodeId: string,
  action: 'retry' | 'rerun' | 'skip' | 'complete',
  input: { reason?: string; output?: string; evidence?: string[]; confidence?: number } = {},
) => postTaskControl(
  `/api/tasks/${encodeURIComponent(taskId)}/nodes/${encodeURIComponent(nodeId)}/${action}`,
  input,
);
