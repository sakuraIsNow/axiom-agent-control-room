import type { AgentMode, ChatRouteDecision, OperationsSnapshot, TaskStats, TaskStatsDaily, WorkflowEvent, WorkflowTask, WorkflowTaskSummary } from '../types';
import type { ExecutionPolicy } from '../types';
import { consumeSseBlocks } from './sse';

export async function createWorkflowTask(input: {
  sessionId: string;
  title: string;
  prompt: string;
  mode: AgentMode;
  templateId?: string;
  modelCredentialId?: string;
  /** Stable per-turn key so a browser/network retry cannot create a duplicate task. */
  idempotencyKey?: string;
  signal: AbortSignal;
  policy?: Partial<ExecutionPolicy>;
  routing?: ChatRouteDecision;
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
      policy: input.policy,
      routing: input.routing,
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
        terminal = event.type === 'task.completed'
          || event.type === 'task.failed'
          || event.type === 'task.cancelled'
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
        terminal = event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.cancelled'
          || event.type === 'plan.approval_requested' || event.type === 'plan.rejected'
          || event.type === 'review.approval_requested' || event.type === 'review.rejected'
          || event.type === 'tool.approval_requested' || event.type === 'tool.rejected';
      });
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
