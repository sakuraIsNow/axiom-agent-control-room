import type { Logger } from 'pino';
import type { EventHub } from './eventHub.js';
import {
  harnessEventToRuntimeEvent,
  HarnessEventDeduper,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessThread,
  type HarnessTurn,
} from './harness.js';
import type { RuntimeEvent, TaskStore, ToolApproval, ToolRisk, WorkflowTask } from './contracts.js';

export type HarnessBridgeResult = {
  accepted: boolean;
  delegated: boolean;
  capabilities: HarnessCapabilities;
  thread?: HarnessThread;
  turn?: HarnessTurn;
  reason?: string;
};

type DelegatedTask = Pick<WorkflowTask, 'id' | 'runId' | 'tenantId'>;
type ActiveDelegation = {
  task: DelegatedTask;
  thread: HarnessThread;
  controller: AbortController;
  deduper: HarnessEventDeduper;
  output: string;
  afterSequence: number;
  consume: Promise<void>;
};

const terminalTaskStatuses = new Set<WorkflowTask['status']>(['completed', 'failed', 'cancelled']);

const textFromPayload = (payload: Record<string, unknown>) => {
  const value = payload.content ?? payload.delta ?? payload.text ?? payload.message;
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
};

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const approvalRisk = (value: unknown): ToolRisk => value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : 'medium';
const approvalFromPayload = (payload: Record<string, unknown>): ToolApproval | undefined => {
  const toolCall = asRecord(payload.toolCall ?? payload.tool_call);
  const requestId = String(payload.requestId ?? payload.request_id ?? toolCall.toolCallId ?? toolCall.id ?? '');
  if (!requestId) return undefined;
  const name = String(toolCall.name ?? toolCall.toolName ?? payload.name ?? payload.toolName ?? 'external.harness');
  const args = asRecord(toolCall.args ?? toolCall.arguments ?? payload.args);
  return {
    id: requestId,
    signature: `harness:${requestId}`,
    stepId: String(payload.stepId ?? payload.itemId ?? toolCall.itemId ?? 'external-harness'),
    name: name.slice(0, 160),
    args,
    risk: approvalRisk(toolCall.risk ?? payload.risk),
    status: 'pending',
    requestedAt: typeof payload.requestedAt === 'string' ? payload.requestedAt : new Date().toISOString(),
  };
};

/** Explicit boundary between an external Harness and the durable task runtime. */
export class HarnessTaskBridge {
  private readonly active = new Map<string, ActiveDelegation>();
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryRunning = false;

  constructor(
    private readonly store: TaskStore,
    private readonly hub: EventHub,
    private readonly adapter: HarnessAdapter,
    private readonly logger?: Logger,
  ) {}

  /** Rebuild active external delegations from durable task/event state. */
  async recover(limit = 100) {
    if (!this.store.listRecoverableHarnessTasks || this.recoveryRunning) return { inspected: 0, resumed: 0 };
    this.recoveryRunning = true;
    try {
      const capabilities = await this.adapter.handshake();
      if (!capabilities.compatible || !capabilities.active) return { inspected: 0, resumed: 0 };
      const tasks = await this.store.listRecoverableHarnessTasks(limit);
      let resumed = 0;
      for (const task of tasks) {
        if (terminalTaskStatuses.has(task.status) || this.active.has(task.id)) continue;
        const events = await this.store.getEvents(task.id).catch(() => []);
        const approvalState = await this.rebuildApprovals(task, events);
        const connected = [...events].reverse().find((event) => event.type === 'harness.connected' && typeof event.payload.threadId === 'string');
        const threadId = typeof connected?.payload.threadId === 'string' ? connected.payload.threadId : '';
        if (!threadId) continue;
        const lastExternalSequence = events.reduce((max, event) => {
          const harness = event.payload.harness;
          const sequence = harness && typeof harness === 'object' && Number.isFinite(Number((harness as Record<string, unknown>).externalSequence))
            ? Number((harness as Record<string, unknown>).externalSequence)
            : 0;
          return Math.max(max, sequence);
        }, 0);
        const delegation: ActiveDelegation = {
          task: { id: task.id, runId: task.runId, tenantId: task.tenantId },
          thread: { threadId, taskId: task.id, sessionId: task.sessionId, kind: this.adapter.kind, externallyOwned: true },
          controller: new AbortController(),
          deduper: new HarnessEventDeduper(),
          output: events.filter((event) => event.type === 'model.delta').map((event) => textFromPayload(event.payload)).join(''),
          afterSequence: lastExternalSequence,
          consume: Promise.resolve(),
        };
        this.active.set(task.id, delegation);
        delegation.consume = this.consume(delegation);
        if (task.status === 'paused' || task.status === 'running' || (task.status === 'waiting_for_human' && approvalState.hasPending)) {
          const command = await this.adapter.resume(threadId, delegation.controller.signal, lastExternalSequence).catch(() => ({ accepted: false }));
          if (!command.accepted && task.status === 'paused') {
            this.active.delete(task.id);
            delegation.controller.abort();
            continue;
          }
          await this.emit(task, 'thread.resumed', { source: 'external-harness-recovery', threadId, afterSequence: lastExternalSequence });
        }
        resumed += 1;
      }
      return { inspected: tasks.length, resumed };
    } finally {
      this.recoveryRunning = false;
    }
  }

  startRecovery(intervalMs = 20_000) {
    if (this.recoveryTimer) return;
    void this.recover();
    this.recoveryTimer = setInterval(() => void this.recover(), intervalMs);
    this.recoveryTimer.unref();
  }

  async start(
    task: Pick<WorkflowTask, 'id' | 'runId' | 'tenantId' | 'sessionId' | 'userId' | 'status'>,
    input: string,
    options: { workspaceRoot?: string; model?: string; presetId?: string; afterSequence?: number } = {},
  ): Promise<HarnessBridgeResult> {
    const capabilities = await this.adapter.handshake();
    if (!capabilities.compatible || !capabilities.active) return { accepted: false, delegated: false, capabilities, reason: capabilities.reason };
    if (task.status !== 'paused') return { accepted: false, delegated: false, capabilities, reason: '只有已暂停任务可以委托给外部 Harness，避免与内建 Worker 并发执行。' };
    if (this.active.has(task.id)) return { accepted: false, delegated: true, capabilities, reason: '任务已经存在外部 Harness 委托。' };

    const controller = new AbortController();
    let thread: HarnessThread;
    try {
      thread = await this.adapter.startThread({
        taskId: task.id,
        sessionId: task.sessionId,
        workspaceRoot: options.workspaceRoot,
        model: options.model,
        presetId: options.presetId,
      }, controller.signal);
      if (thread.taskId !== task.id) throw new Error('外部 Harness 返回了不属于当前任务的 thread。');
    } catch (error) {
      controller.abort(error);
      return { accepted: false, delegated: false, capabilities, reason: error instanceof Error ? error.message : String(error) };
    }

    const delegation: ActiveDelegation = {
      task,
      thread,
      controller,
      deduper: new HarnessEventDeduper(),
      output: '',
      afterSequence: Math.max(0, options.afterSequence ?? 0),
      consume: Promise.resolve(),
    };
    this.active.set(task.id, delegation);
    try {
      const running = await this.store.updateTask(task.id, { status: 'running', error: null, cancelRequested: false });
      await this.emit(running, 'harness.connected', { harness: this.adapter.kind, protocol: capabilities.protocol, threadId: thread.threadId, source: 'external-harness' });
      delegation.consume = this.consume(delegation);
      const turn = await this.adapter.startTurn({ taskId: task.id, threadId: thread.threadId, runId: task.runId, input: input.slice(0, 80_000), model: options.model }, controller.signal);
      return { accepted: true, delegated: true, capabilities, thread, turn };
    } catch (error) {
      await this.stop(task.id);
      return { accepted: false, delegated: true, capabilities, thread, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async resume(
    task: Pick<WorkflowTask, 'id' | 'runId' | 'tenantId' | 'sessionId' | 'userId' | 'status'>,
    threadId: string,
    afterSequence = 0,
  ): Promise<HarnessBridgeResult> {
    const capabilities = await this.adapter.handshake();
    if (!capabilities.compatible || !capabilities.active) return { accepted: false, delegated: false, capabilities, reason: capabilities.reason };
    if (task.status !== 'paused') return { accepted: false, delegated: false, capabilities, reason: '只有已暂停任务可以恢复外部 Harness 委托。' };
    if (this.active.has(task.id)) return { accepted: false, delegated: true, capabilities, reason: '任务已经存在外部 Harness 委托。' };
    const priorEvents = await this.store.getEvents(task.id, 0);
    if (!priorEvents.some((event) => event.type === 'harness.connected' && event.payload.threadId === threadId)) {
      return { accepted: false, delegated: false, capabilities, reason: 'threadId 不属于当前任务，无法恢复外部 Harness。' };
    }

    const controller = new AbortController();
    const thread: HarnessThread = { threadId, taskId: task.id, sessionId: task.sessionId, kind: this.adapter.kind, externallyOwned: true };
    const delegation: ActiveDelegation = {
      task,
      thread,
      controller,
      deduper: new HarnessEventDeduper(),
      output: '',
      afterSequence: Math.max(0, afterSequence),
      consume: Promise.resolve(),
    };
    this.active.set(task.id, delegation);
    try {
      const running = await this.store.updateTask(task.id, { status: 'running', error: null, cancelRequested: false });
      await this.emit(running, 'harness.connected', { harness: this.adapter.kind, protocol: capabilities.protocol, threadId, source: 'external-harness-resume' });
      delegation.consume = this.consume(delegation);
      const command = await this.adapter.resume(threadId, controller.signal, afterSequence);
      if (!command.accepted) {
        await this.stop(task.id);
        return { accepted: false, delegated: command.delegated, capabilities, thread, reason: command.reason };
      }
      return { accepted: true, delegated: true, capabilities, thread };
    } catch (error) {
      await this.stop(task.id);
      return { accepted: false, delegated: true, capabilities, thread, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async interrupt(taskId: string) {
    const delegation = this.active.get(taskId);
    if (!delegation) return { accepted: false, delegated: false, reason: '任务没有活动的外部 Harness 委托。' };
    const result = await this.adapter.interrupt(delegation.thread.threadId);
    if (result.accepted) {
      delegation.controller.abort(new DOMException('Harness turn interrupted', 'AbortError'));
      this.active.delete(taskId);
      const task = await this.store.getTask(taskId, delegation.task.tenantId);
      if (task && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
        const paused = await this.store.updateTask(taskId, { status: 'paused', error: '外部 Harness 已中断，任务可从事件游标恢复。' });
        await this.emit(paused, 'task.paused', { source: 'external-harness', threadId: delegation.thread.threadId });
      }
    }
    return result;
  }

  /** Forward an operator decision to an active external Harness. `undefined`
   * means this task is owned by the built-in runtime, so normal tool approval
   * handling should continue without a sidecar call.
   */
  async approve(taskId: string, requestId: string, decision: 'approved' | 'rejected', note?: string) {
    const delegation = this.active.get(taskId);
    if (!delegation) return undefined;
    return this.adapter.approve(requestId, decision, note);
  }

  /**
   * Steer only a task currently owned by this bridge. `undefined` means the
   * built-in runtime owns the task; a rejected result means an external
   * Harness is active but did not accept live steering.
   */
  async steer(taskId: string, note: string) {
    const delegation = this.active.get(taskId);
    if (!delegation) return undefined;
    const capabilities = await this.adapter.handshake();
    if (!capabilities.configured || !capabilities.compatible || !capabilities.active) {
      return {
        accepted: false,
        delegated: true,
        command: 'steer' as const,
        reason: capabilities.reason || '外部 Harness 当前不可用。',
        capabilities,
      };
    }
    const result = await this.adapter.steer(delegation.thread.threadId, note);
    return { ...result, capabilities };
  }

  async stop(taskId: string) {
    const delegation = this.active.get(taskId);
    if (!delegation) return;
    delegation.controller.abort(new DOMException('Harness delegation stopped', 'AbortError'));
    this.active.delete(taskId);
    await Promise.race([delegation.consume, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  }

  async close() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await Promise.all([...this.active.keys()].map((taskId) => this.stop(taskId)));
    const close = this.adapter as HarnessAdapter & { close?: () => void };
    close.close?.();
  }

  private async consume(delegation: ActiveDelegation) {
    try {
      for await (const event of this.adapter.subscribe(delegation.thread.threadId, delegation.afterSequence, delegation.controller.signal)) {
        if (!delegation.deduper.accept(event)) continue;
        if (event.taskId && event.taskId !== delegation.task.id) {
          this.logger?.warn({ taskId: delegation.task.id, eventTaskId: event.taskId, eventId: event.id }, 'ignored cross-task Harness event');
          continue;
        }
        const mapped = harnessEventToRuntimeEvent(event, { taskId: delegation.task.id, runId: delegation.task.runId });
        if (!mapped || mapped.taskId !== delegation.task.id || mapped.runId !== delegation.task.runId) continue;
        const persisted = await this.store.appendEvent(delegation.task, mapped);
        this.hub.publish(persisted);
        delegation.afterSequence = event.sequence;
        if (event.kind === 'message.delta' || event.kind === 'agent.message') delegation.output += textFromPayload(event.payload);
        await this.applyApprovalState(delegation, event);
        await this.applyTerminalState(delegation, event, persisted);
      }
    } catch (error) {
      if (!delegation.controller.signal.aborted) {
        this.logger?.warn({ taskId: delegation.task.id, error }, 'external Harness event stream ended unexpectedly');
        const reason = error instanceof Error ? error.message : String(error);
        await this.emit(delegation.task, 'harness.disconnected', { reason, threadId: delegation.thread.threadId, recoverable: true, afterSequence: delegation.afterSequence });
        const current = await this.store.getTask(delegation.task.id, delegation.task.tenantId);
        if (current && !terminalTaskStatuses.has(current.status)) {
          const paused = await this.store.updateTask(current.id, { status: 'paused', error: '外部 Harness 连接中断，系统将自动从事件游标恢复。' });
          await this.emit(paused, 'task.paused', { source: 'external-harness', threadId: delegation.thread.threadId, recoverable: true });
        }
      }
    } finally {
      if (this.active.get(delegation.task.id) === delegation) this.active.delete(delegation.task.id);
    }
  }

  private async rebuildApprovals(task: WorkflowTask, events: RuntimeEvent[]) {
    let approvals = [...(task.toolApprovals ?? [])];
    let changed = false;
    for (const event of events) {
      const harness = asRecord(event.payload.harness);
      if (event.type === 'approval.requested' && harness.kind) {
        const approval = approvalFromPayload(event.payload);
        if (!approval || approvals.some((item) => item.id === approval.id)) continue;
        approvals.push(approval);
        changed = true;
      }
      if (event.type === 'approval.resolved') {
        const requestId = String(event.payload.requestId ?? '');
        const decision = event.payload.decision === 'rejected' ? 'rejected' : event.payload.decision === 'approved' ? 'approved' : undefined;
        if (!requestId || !decision) continue;
        const index = approvals.findIndex((item) => item.id === requestId);
        if (index >= 0 && approvals[index]!.status === 'pending') {
          approvals[index] = { ...approvals[index]!, status: decision, decidedAt: event.timestamp };
          changed = true;
        }
      }
    }
    if (!changed) return { hasPending: approvals.some((item) => item.status === 'pending') };
    const hasPending = approvals.some((item) => item.status === 'pending');
    await this.store.updateTask(task.id, { toolApprovals: approvals, ...(hasPending ? { status: 'waiting_for_human', error: '外部 Harness 请求了需要人工确认的操作。' } : {}) });
    return { hasPending };
  }

  private async applyApprovalState(delegation: ActiveDelegation, event: HarnessEvent) {
    if (event.kind !== 'approval.requested' && event.kind !== 'approval.resolved') return;
    const task = await this.store.getTask(delegation.task.id, delegation.task.tenantId);
    if (!task || terminalTaskStatuses.has(task.status)) return;
    const approvals = [...(task.toolApprovals ?? [])];
    if (event.kind === 'approval.requested') {
      const approval = approvalFromPayload(event.payload);
      if (!approval || approvals.some((item) => item.id === approval.id)) return;
      approvals.push(approval);
      await this.store.updateTask(task.id, { status: 'waiting_for_human', toolApprovals: approvals, error: '外部 Harness 请求了需要人工确认的操作。' });
      return;
    }
    const requestId = String(event.payload.requestId ?? '');
    const decision = event.payload.decision === 'rejected' ? 'rejected' : event.payload.decision === 'approved' ? 'approved' : undefined;
    if (!requestId || !decision) return;
    const index = approvals.findIndex((item) => item.id === requestId);
    if (index < 0 || approvals[index]!.status !== 'pending') return;
    approvals[index] = {
      ...approvals[index]!,
      status: decision,
      decidedAt: new Date().toISOString(),
      ...(typeof event.payload.note === 'string' ? { note: event.payload.note.slice(0, 2_000) } : {}),
    };
    await this.store.updateTask(task.id, {
      status: decision === 'approved' ? 'running' : 'paused',
      toolApprovals: approvals,
      error: decision === 'approved' ? null : '外部 Harness 操作已被拒绝。',
    });
  }

  private async applyTerminalState(delegation: ActiveDelegation, event: HarnessEvent, persisted: RuntimeEvent) {
    if (event.kind !== 'turn.completed' && event.kind !== 'turn.failed' && event.kind !== 'turn.interrupted') return;
    const task = await this.store.getTask(delegation.task.id, delegation.task.tenantId);
    if (!task || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return;
    if (event.kind === 'turn.completed') {
      const result = delegation.output.trim() || textFromPayload(event.payload).trim();
      const completed = await this.store.updateTask(task.id, { status: 'completed', ...(result ? { result } : {}), error: null, cancelRequested: false });
      await this.emit(completed, 'task.completed', { source: 'external-harness', threadId: delegation.thread.threadId, turnId: event.turnId, ...(result ? { result } : {}), sourceEventId: persisted.id });
    } else if (event.kind === 'turn.interrupted') {
      const paused = await this.store.updateTask(task.id, { status: 'paused', error: '外部 Harness 已中断，任务可从事件游标恢复。' });
      await this.emit(paused, 'task.paused', { source: 'external-harness', threadId: delegation.thread.threadId, turnId: event.turnId, sourceEventId: persisted.id });
    } else {
      const message = textFromPayload(event.payload).trim() || '外部 Harness 执行失败。';
      const failed = await this.store.updateTask(task.id, { status: 'failed', error: message, cancelRequested: false });
      await this.emit(failed, 'task.failed', { source: 'external-harness', threadId: delegation.thread.threadId, turnId: event.turnId, error: message, sourceEventId: persisted.id });
    }
    delegation.controller.abort(new DOMException('Harness turn reached a terminal state', 'AbortError'));
    if (this.active.get(delegation.task.id) === delegation) this.active.delete(delegation.task.id);
  }

  private async emit(task: Pick<WorkflowTask, 'id' | 'runId'>, type: RuntimeEvent['type'], payload: Record<string, unknown>) {
    const event = await this.store.appendEvent(task, { type, payload });
    this.hub.publish(event);
  }
}
