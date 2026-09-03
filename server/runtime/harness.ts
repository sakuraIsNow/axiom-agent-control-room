import { randomUUID } from 'node:crypto';
import type { RuntimeEvent, RuntimeEventType } from './contracts.js';

export type HarnessKind = 'builtin' | 'deepseek' | 'codex';
export type HarnessProtocol = 'builtin/v1' | 'deepseek-harness/v1' | 'codex-app-server/v2';

export type HarnessCapabilities = {
  kind: HarnessKind;
  protocol: HarnessProtocol;
  version: string;
  configured: boolean;
  compatible: boolean;
  active: boolean;
  capabilities: string[];
  reason: string;
};

export type HarnessThreadInput = {
  taskId: string;
  sessionId: string;
  workspaceRoot?: string;
  model?: string;
  presetId?: string;
};

export type HarnessThread = {
  threadId: string;
  taskId: string;
  sessionId: string;
  kind: HarnessKind;
  externallyOwned: boolean;
};

export type HarnessTurnInput = {
  taskId: string;
  threadId: string;
  runId: string;
  input: string;
  model?: string;
};

export type HarnessTurn = {
  turnId: string;
  threadId: string;
  taskId: string;
  runId: string;
};

export type HarnessCommandResult = {
  accepted: boolean;
  delegated: boolean;
  command: 'resume' | 'interrupt' | 'approve' | 'steer';
  reason?: string;
};

/**
 * A provider-neutral event vocabulary shared by DeepSeek ACP-style sessions,
 * Codex app-server items, and the built-in task runtime. External sequence
 * numbers are retained in the mapped RuntimeEvent payload; TaskStore remains
 * the authority for tenant-scoped ordering.
 */
export type HarnessEventKind =
  | 'thread.started'
  | 'thread.resumed'
  | 'thread.forked'
  | 'thread.closed'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.interrupted'
  | 'turn.failed'
  | 'item.started'
  | 'item.completed'
  | 'message.delta'
  | 'reasoning.delta'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'agent.spawned'
  | 'agent.message'
  | 'agent.interrupted'
  | 'agent.completed'
  | 'queue.updated'
  | 'approval.requested'
  | 'approval.resolved'
  | 'artifact.created'
  | 'checkpoint.saved';

export type HarnessEvent = {
  id: string;
  sequence: number;
  kind: HarnessEventKind;
  timestamp?: string;
  threadId: string;
  taskId?: string;
  runId?: string;
  turnId?: string;
  itemId?: string;
  agentId?: string;
  parentThreadId?: string;
  payload: Record<string, unknown>;
};

export type HarnessEventContext = {
  taskId: string;
  runId: string;
  fallbackAgentId?: string;
};

export interface HarnessAdapter {
  readonly kind: HarnessKind;
  readonly protocol: HarnessProtocol;
  handshake(signal?: AbortSignal): Promise<HarnessCapabilities>;
  startThread(input: HarnessThreadInput, signal?: AbortSignal): Promise<HarnessThread>;
  startTurn(input: HarnessTurnInput, signal?: AbortSignal): Promise<HarnessTurn>;
  /**
   * Resume from the last persisted external sequence. Adapters use this to
   * seed their in-process cursor before a restarted sidecar emits events.
   */
  resume(threadId: string, signal?: AbortSignal, afterSequence?: number): Promise<HarnessCommandResult>;
  interrupt(threadId: string, turnId?: string): Promise<HarnessCommandResult>;
  approve(requestId: string, decision: 'approved' | 'rejected', note?: string): Promise<HarnessCommandResult>;
  steer(threadId: string, note: string): Promise<HarnessCommandResult>;
  subscribe(threadId: string, afterSequence?: number, signal?: AbortSignal): AsyncIterable<HarnessEvent>;
}

export class HarnessOperationUnavailableError extends Error {
  constructor(readonly operation: string, readonly harness: HarnessKind, message: string) {
    super(message);
    this.name = 'HarnessOperationUnavailableError';
  }
}

const BUILTIN_CAPABILITIES = [
  'durable-loop',
  'checkpoint-resume',
  'dependency-graph',
  'subagent-delegation',
  'human-steering',
  'review-gate',
  'runtime-event-replay',
];

const unavailable = (harness: HarnessKind, command: HarnessCommandResult['command']): HarnessCommandResult => ({
  accepted: false,
  delegated: false,
  command,
  reason: `${harness} adapter is not connected to an external control plane.`,
});

/**
 * The built-in orchestrator owns execution today. This adapter gives it the
 * same identity surface as an external Harness without claiming that a
 * sidecar was contacted or that a command was executed remotely.
 */
export class BuiltinHarnessAdapter implements HarnessAdapter {
  readonly kind = 'builtin' as const;
  readonly protocol = 'builtin/v1' as const;

  async handshake(): Promise<HarnessCapabilities> {
    return {
      kind: this.kind,
      protocol: this.protocol,
      version: '1',
      configured: false,
      compatible: true,
      active: true,
      capabilities: [...BUILTIN_CAPABILITIES],
      reason: 'Built-in WorkflowOrchestrator is authoritative.',
    };
  }

  async startThread(input: HarnessThreadInput): Promise<HarnessThread> {
    return {
      threadId: `builtin-thread:${input.taskId}`,
      taskId: input.taskId,
      sessionId: input.sessionId,
      kind: this.kind,
      externallyOwned: false,
    };
  }

  async startTurn(input: HarnessTurnInput): Promise<HarnessTurn> {
    return {
      turnId: input.runId || randomUUID(),
      threadId: input.threadId,
      taskId: input.taskId,
      runId: input.runId,
    };
  }

  async resume(_threadId: string): Promise<HarnessCommandResult> {
    return unavailable(this.kind, 'resume');
  }

  async interrupt(_threadId: string, _turnId?: string): Promise<HarnessCommandResult> {
    return unavailable(this.kind, 'interrupt');
  }

  async approve(_requestId: string, _decision: 'approved' | 'rejected', _note?: string): Promise<HarnessCommandResult> {
    return unavailable(this.kind, 'approve');
  }

  async steer(_threadId: string, _note: string): Promise<HarnessCommandResult> {
    return unavailable(this.kind, 'steer');
  }

  async *subscribe(_threadId: string, _afterSequence = 0, _signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    // Built-in events are already persisted and published by TaskStore/EventHub.
  }
}

const runtimeTypeForKind: Partial<Record<HarnessEventKind, RuntimeEventType>> = {
  'thread.started': 'thread.started',
  'thread.resumed': 'thread.resumed',
  'thread.forked': 'thread.forked',
  'thread.closed': 'thread.closed',
  'turn.started': 'turn.started',
  'turn.completed': 'turn.completed',
  'turn.interrupted': 'turn.interrupted',
  'turn.failed': 'turn.failed',
  'item.started': 'item.started',
  'item.completed': 'item.completed',
  'message.delta': 'model.delta',
  'reasoning.delta': 'model.delta',
  'tool.started': 'tool.started',
  'tool.completed': 'tool.completed',
  'tool.failed': 'tool.failed',
  'agent.spawned': 'agent.spawned',
  'agent.message': 'agent.message',
  'agent.interrupted': 'agent.interrupted',
  'agent.completed': 'agent.completed',
  'queue.updated': 'queue.updated',
  'approval.requested': 'approval.requested',
  'approval.resolved': 'approval.resolved',
  'artifact.created': 'artifact.created',
  'checkpoint.saved': 'checkpoint.saved',
};

const eventMetadata = (event: HarnessEvent) => ({
  kind: event.kind,
  eventId: event.id,
  externalSequence: event.sequence,
  threadId: event.threadId,
  ...(event.turnId ? { turnId: event.turnId } : {}),
  ...(event.itemId ? { itemId: event.itemId } : {}),
  ...(event.parentThreadId ? { parentThreadId: event.parentThreadId } : {}),
});

/** Convert external Harness lifecycle facts into the durable RuntimeEvent vocabulary. */
export const harnessEventToRuntimeEvent = (
  event: HarnessEvent,
  context: HarnessEventContext,
): Omit<RuntimeEvent, 'id' | 'sequence'> | null => {
  const type = runtimeTypeForKind[event.kind];
  if (!type) return null;
  const taskId = event.taskId || context.taskId;
  const runId = event.runId || context.runId;
  const payload = {
    ...event.payload,
    harness: eventMetadata(event),
    ...(event.kind === 'reasoning.delta' ? { channel: 'reasoning' } : {}),
  };
  return {
    type,
    version: 1,
    taskId,
    runId,
    ...(event.agentId || context.fallbackAgentId ? { agentId: event.agentId || context.fallbackAgentId } : {}),
    timestamp: event.timestamp || new Date().toISOString(),
    payload,
  };
};

/**
 * Prevents duplicate external notifications during reconnect/replay. The
 * bounded FIFO keeps a long-running worker from retaining every event forever.
 */
export class HarnessEventDeduper {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries = 4096) {}

  accept(event: Pick<HarnessEvent, 'id' | 'sequence' | 'threadId'>): boolean {
    const key = `${event.threadId}:${event.id}:${event.sequence}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.order.push(key);
    while (this.order.length > this.maxEntries) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }
}
