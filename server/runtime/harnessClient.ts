import {
  HarnessOperationUnavailableError,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessCommandResult,
  type HarnessEvent,
  type HarnessThread,
  type HarnessThreadInput,
  type HarnessTurn,
  type HarnessTurnInput,
} from './harness.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export type HarnessHandshake = {
  kind: 'builtin' | 'deepseek' | 'codex';
  protocol: 'builtin/v1' | 'deepseek-harness/v1' | 'codex-app-server/v2';
  version: string;
  configured: boolean;
  compatible: boolean;
  active: boolean;
  reason: string;
  capabilities: string[];
};

type HarnessPayload = {
  protocol?: string;
  version?: string;
  capabilities?: unknown;
};

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup?: () => void;
};

type StdioTransportOptions = {
  command: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  onMessage: (message: RpcMessage) => void;
  onClose: (error?: Error) => void;
};

/**
 * Minimal ACP JSON-RPC stdio transport. ACP deliberately uses newline framed
 * JSON, so keeping this boundary small makes protocol failures observable and
 * prevents a sidecar from gaining access to the main process internals.
 */
class AcpStdioTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number | string, PendingRpc>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: StdioTransportOptions) {
    const [executable, ...args] = options.command;
    if (!executable) throw new Error('DEEPSEEK_HARNESS_COMMAND is empty.');
    this.process = spawn(executable, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => this.receive(line));
    this.process.stderr.on('data', () => {
      // Sidecar stderr is intentionally not surfaced as protocol content.
    });
    this.process.once('error', (error) => this.close(error));
    this.process.once('exit', (code, signal) => {
      this.close(new Error(`Harness sidecar exited (${code ?? 'signal ' + signal}).`));
    });
  }

  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Harness sidecar transport is closed.'));
    const id = this.nextId++;
    const timeoutMs = Math.max(500, this.options.timeoutMs ?? 30_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`Harness RPC ${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      timer.unref();
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.pending.set(id, { resolve, reject, timer, cleanup });
      const abort = () => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Harness RPC cancelled.'));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        abort();
        if (this.pending.has(id)) reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    if (this.closed) throw new Error('Harness sidecar transport is closed.');
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  respond(id: number | string, result: unknown) {
    if (this.closed) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(error ?? new Error('Harness sidecar transport closed.'));
      this.pending.delete(id);
    }
    this.options.onClose(error);
    if (!this.process.killed) this.process.kill();
  }

  private receive(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(trimmed) as RpcMessage;
    } catch {
      this.close(new Error('Harness sidecar emitted invalid JSON.'));
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanup?.();
      if (message.error) pending.reject(new Error(message.error.message || `Harness RPC ${message.id} failed.`));
      else pending.resolve(message.result);
      return;
    }
    this.options.onMessage(message);
  }
}

type EventQueue = {
  events: HarnessEvent[];
  waiters: Array<(result: IteratorResult<HarnessEvent>) => void>;
  closed: boolean;
};

type StdioAdapterOptions = {
  command: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  active?: boolean;
};

type CodexStdioOptions = StdioAdapterOptions;

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' ? value as Record<string, unknown> : {}
);

const jsonRpcCapabilityNames = (result: Record<string, unknown>) => {
  const capabilities = asRecord(result.agentCapabilities);
  const names = ['acp-jsonrpc-stdio', 'session-new', 'session-prompt', 'session-cancel', 'session-update'];
  if (asRecord(capabilities.promptCapabilities).image === true) names.push('image-prompt');
  const advertised = [capabilities.capabilities, result.capabilities]
    .find((value): value is unknown[] => Array.isArray(value)) ?? [];
  for (const value of advertised) {
    if (typeof value === 'string' && value.length <= 80 && !names.includes(value)) names.push(value);
  }
  return names;
};

/** ACP adapter used only after an explicit capability handshake and opt-in. */
class DeepSeekAcpStdioAdapter implements HarnessAdapter {
  readonly kind = 'deepseek' as const;
  readonly protocol = 'deepseek-harness/v1' as const;
  private transport?: AcpStdioTransport;
  private initialized?: Promise<Record<string, unknown>>;
  private readonly queues = new Map<string, EventQueue>();
  private readonly turns = new Map<string, { threadId: string; taskId: string; runId: string }>();
  private readonly pendingApprovals = new Map<string, { rpcId: number | string; threadId: string }>();
  private readonly sequence = new Map<string, number>();

  constructor(private readonly options: StdioAdapterOptions) {}

  async handshake(signal?: AbortSignal): Promise<HarnessCapabilities> {
    try {
      const result = await this.initialize(signal);
      const protocolVersion = String(result.protocolVersion ?? '');
      const agentInfo = asRecord(result.agentInfo);
      const knownAgent = agentInfo.name === undefined || agentInfo.name === 'deepseek-harness-acp';
      const compatible = knownAgent && (protocolVersion === '1' || protocolVersion === '1.0');
      const active = compatible && this.options.active === true;
      return {
        kind: this.kind,
        protocol: this.protocol,
        version: protocolVersion || 'unknown',
        configured: true,
        compatible,
        active,
        capabilities: jsonRpcCapabilityNames(result),
        reason: !compatible
          ? 'ACP sidecar protocol version is not supported.'
          : active
            ? 'ACP stdio sidecar handshake passed and execution is explicitly enabled.'
            : 'ACP stdio sidecar handshake passed; set DEEPSEEK_HARNESS_ACTIVE=true to enable execution.',
      };
    } catch (error) {
      return {
        kind: this.kind,
        protocol: this.protocol,
        version: 'unknown',
        configured: true,
        compatible: false,
        active: false,
        capabilities: [],
        reason: error instanceof Error ? error.message : 'ACP sidecar handshake failed.',
      };
    }
  }

  async startThread(input: HarnessThreadInput, signal?: AbortSignal): Promise<HarnessThread> {
    await this.requireActive(signal);
    const result = asRecord(await this.request('session/new', {
      cwd: input.workspaceRoot || process.cwd(),
      additionalDirectories: [],
      mcpServers: [],
    }, signal));
    const threadId = typeof result.sessionId === 'string' ? result.sessionId : '';
    if (!threadId) throw new Error('ACP session/new returned no sessionId.');
    this.queues.set(threadId, { events: [], waiters: [], closed: false });
    this.sequence.set(threadId, 0);
    return { threadId, taskId: input.taskId, sessionId: input.sessionId, kind: this.kind, externallyOwned: true };
  }

  async startTurn(input: HarnessTurnInput, signal?: AbortSignal): Promise<HarnessTurn> {
    await this.requireActive(signal);
    const turnId = input.runId || randomUUID();
    this.turns.set(turnId, { threadId: input.threadId, taskId: input.taskId, runId: input.runId });
    this.publish(input.threadId, 'turn.started', { turnId, taskId: input.taskId, runId: input.runId });
    void this.request('session/prompt', {
      sessionId: input.threadId,
      prompt: [{ type: 'text', text: input.input }],
    }, signal).then((value) => {
      const result = asRecord(value);
      this.publish(input.threadId, 'turn.completed', {
        turnId,
        stopReason: typeof result.stopReason === 'string' ? result.stopReason : 'end_turn',
      });
    }).catch((error) => {
      this.publish(input.threadId, 'turn.failed', { turnId, error: error instanceof Error ? error.message : String(error) });
    });
    return { turnId, threadId: input.threadId, taskId: input.taskId, runId: input.runId };
  }

  async resume(threadId: string, signal?: AbortSignal, afterSequence = 0): Promise<HarnessCommandResult> {
    if (!(await this.hasCapability('session-resume', signal))) return this.unavailable('resume');
    // A worker restart can resume a persisted thread before startThread has
    // recreated its in-memory event queue. Recreate the bounded queue at the
    // transport boundary so replayed updates are not dropped. A previous
    // sidecar disconnect closes an existing queue; reopen it before accepting
    // replayed updates from the new transport process.
    const queue = this.queues.get(threadId);
    if (queue) queue.closed = false;
    else this.queues.set(threadId, { events: [], waiters: [], closed: false });
    // A new adapter instance starts with no local sequence state after a
    // worker restart. Seed it from the durable bridge cursor before replay so
    // freshly received events are strictly newer than persisted events.
    this.sequence.set(threadId, Math.max(this.sequence.get(threadId) ?? 0, Math.max(0, Math.floor(afterSequence))));
    await this.request('session/resume', { sessionId: threadId }, signal);
    this.publish(threadId, 'thread.resumed', {});
    return { accepted: true, delegated: true, command: 'resume' };
  }

  async interrupt(threadId: string, turnId?: string): Promise<HarnessCommandResult> {
    if (!this.transport) return this.unavailable('interrupt');
    try {
      this.transport.notify('session/cancel', { sessionId: threadId });
      this.publish(threadId, 'turn.interrupted', { ...(turnId ? { turnId } : {}) });
      return { accepted: true, delegated: true, command: 'interrupt' };
    } catch (error) {
      return { accepted: false, delegated: true, command: 'interrupt', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async approve(requestId: string, decision: 'approved' | 'rejected', note?: string): Promise<HarnessCommandResult> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || !this.transport) return this.unavailable('approve');
    this.pendingApprovals.delete(requestId);
    this.transport.respond(pending.rpcId, {
      outcome: decision === 'approved'
        ? { outcome: 'selected', optionId: 'allow-once' }
        : { outcome: 'selected', optionId: 'reject-once' },
      ...(note ? { note: note.slice(0, 2_000) } : {}),
    });
    this.publish(pending.threadId, 'approval.resolved', { requestId, decision, ...(note ? { note } : {}) });
    return { accepted: true, delegated: true, command: 'approve' };
  }

  async steer(threadId: string, note: string): Promise<HarnessCommandResult> {
    if (!(await this.hasCapability('session-steer'))) return this.unavailable('steer');
    try {
      await this.request('session/steer', { sessionId: threadId, note: note.slice(0, 8_000) });
      return { accepted: true, delegated: true, command: 'steer' };
    } catch (error) {
      return { accepted: false, delegated: true, command: 'steer', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async *subscribe(threadId: string, afterSequence = 0, signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    const queue = this.queues.get(threadId);
    if (!queue) return;
    while (true) {
      const next = queue.events.findIndex((event) => event.sequence > afterSequence);
      if (next >= 0) {
        const event = queue.events.splice(next, 1)[0]!;
        afterSequence = event.sequence;
        yield event;
        continue;
      }
      if (queue.closed) return;
      const result = await new Promise<IteratorResult<HarnessEvent>>((resolve, reject) => {
        const abort = () => {
          const index = queue.waiters.indexOf(resolve);
          if (index >= 0) queue.waiters.splice(index, 1);
          reject(signal?.reason instanceof Error ? signal.reason : new Error('Harness subscription cancelled.'));
        };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        queue.waiters.push(resolve);
      });
      if (result.done || !result.value) return;
      afterSequence = result.value.sequence;
      yield result.value;
    }
  }

  close() {
    for (const queue of this.queues.values()) {
      queue.closed = true;
      for (const waiter of queue.waiters.splice(0)) waiter({ done: true, value: undefined });
    }
    this.transport?.close();
  }

  private async initialize(signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.initialized) return this.initialized;
    this.transport = new AcpStdioTransport({
      ...this.options,
      onMessage: (message) => this.onMessage(message),
      onClose: () => {
        this.initialized = undefined;
        for (const queue of this.queues.values()) {
          queue.closed = true;
          for (const waiter of queue.waiters.splice(0)) waiter({ done: true, value: undefined });
        }
      },
    });
    this.initialized = this.transport.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'axiom-agent-control-room', version: '0.1.0' },
    }, signal).then((value) => asRecord(value));
    try { return await this.initialized; } catch (error) { this.transport.close(error instanceof Error ? error : new Error(String(error))); throw error; }
  }

  private async requireActive(signal?: AbortSignal) {
    const capabilities = await this.handshake(signal);
    if (!capabilities.compatible || !capabilities.active) {
      throw new HarnessOperationUnavailableError('transport', this.kind, capabilities.reason);
    }
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    if (!this.transport) throw new Error('ACP sidecar transport is not initialized.');
    return this.transport.request(method, params, signal);
  }

  private async hasCapability(name: string, signal?: AbortSignal) {
    const result = await this.initialize(signal);
    return jsonRpcCapabilityNames(result).includes(name);
  }

  private unavailable(operation: HarnessCommandResult['command']): HarnessCommandResult {
    return { accepted: false, delegated: false, command: operation, reason: 'ACP sidecar does not advertise this operation.' };
  }

  private publish(threadId: string, kind: HarnessEvent['kind'], payload: Record<string, unknown>) {
    const queue = this.queues.get(threadId);
    if (!queue) return;
    const sequence = (this.sequence.get(threadId) ?? 0) + 1;
    this.sequence.set(threadId, sequence);
    const event: HarnessEvent = { id: randomUUID(), sequence, kind, threadId, payload };
    const waiter = queue.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else {
      queue.events.push(event);
      if (queue.events.length > 2_048) queue.events.splice(0, queue.events.length - 2_048);
    }
  }

  private onMessage(message: RpcMessage) {
    if (message.method === 'session/update') {
      const params = asRecord(message.params);
      const threadId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const update = asRecord(params.update);
      const kind = update.sessionUpdate;
      if (threadId && kind === 'agent_message_chunk') {
        this.publish(threadId, 'message.delta', { content: update.content });
      }
      return;
    }
    if (message.method === 'session/request_permission' && message.id !== undefined) {
      const params = asRecord(message.params);
      const threadId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const toolCall = asRecord(params.toolCall);
      const requestId = String(toolCall.toolCallId ?? message.id);
      this.pendingApprovals.set(requestId, { rpcId: message.id, threadId });
      this.publish(threadId, 'approval.requested', { requestId, toolCall });
    }
  }
}

/**
 * Codex app-server v2 transport. The protocol is also newline-framed JSON-RPC,
 * but uses the resource-oriented thread/start and turn/start methods instead
 * of ACP's session namespace. Unknown notifications are retained as generic
 * item events so protocol additions remain observable without unsafe guesses.
 */
export class CodexAppServerAdapter implements HarnessAdapter {
  readonly kind = 'codex' as const;
  readonly protocol = 'codex-app-server/v2' as const;
  private transport?: AcpStdioTransport;
  private initialized?: Promise<Record<string, unknown>>;
  private readonly queues = new Map<string, EventQueue>();
  private readonly sequence = new Map<string, number>();
  private readonly pendingApprovals = new Map<string, { rpcId: number | string; threadId: string }>();

  constructor(private readonly options: CodexStdioOptions) {}

  async handshake(signal?: AbortSignal): Promise<HarnessCapabilities> {
    try {
      const result = await this.initialize(signal);
      const compatible = Boolean(result && typeof result === 'object');
      return {
        kind: this.kind,
        protocol: this.protocol,
        version: typeof result.protocolVersion === 'string' ? result.protocolVersion : '2',
        configured: true,
        compatible,
        active: compatible && this.options.active === true,
        capabilities: ['jsonrpc-stdio', 'thread-start', 'thread-resume', 'turn-start', 'turn-interrupt', 'turn-steer', 'item-events', 'approval-requests', 'event-replay'],
        reason: !compatible
          ? 'Codex app-server initialize returned an invalid response.'
          : this.options.active === true
            ? 'Codex app-server v2 handshake passed and execution is enabled.'
            : 'Codex app-server handshake passed; set CODEX_APP_SERVER_ACTIVE=true to enable execution.',
      };
    } catch (error) {
      return { kind: this.kind, protocol: this.protocol, version: 'unknown', configured: true, compatible: false, active: false, capabilities: [], reason: error instanceof Error ? error.message : 'Codex app-server handshake failed.' };
    }
  }

  async startThread(input: HarnessThreadInput, signal?: AbortSignal): Promise<HarnessThread> {
    await this.requireActive(signal);
    const result = asRecord(await this.request('thread/start', {
      ...(input.model ? { model: input.model } : {}),
      cwd: input.workspaceRoot || process.cwd(),
      ...(input.presetId ? { profile: input.presetId } : {}),
    }, signal));
    const thread = asRecord(result.thread);
    const threadId = String(thread.id ?? result.threadId ?? '');
    if (!threadId) throw new Error('Codex thread/start returned no thread id.');
    this.queues.set(threadId, { events: [], waiters: [], closed: false });
    this.sequence.set(threadId, 0);
    return { threadId, taskId: input.taskId, sessionId: input.sessionId, kind: this.kind, externallyOwned: true };
  }

  async startTurn(input: HarnessTurnInput, signal?: AbortSignal): Promise<HarnessTurn> {
    await this.requireActive(signal);
    // Publish the local lifecycle marker before writing the RPC. A Codex
    // sidecar is allowed to flush item notifications in the same stdout
    // frame as the turn/start response; publishing after await would make
    // subscribers observe message.delta before turn.started nondeterministically.
    this.publish(input.threadId, 'turn.started', { turnId: input.runId, taskId: input.taskId, runId: input.runId, source: 'client' });
    const result = asRecord(await this.request('turn/start', {
      threadId: input.threadId,
      input: [{ type: 'text', text: input.input }],
      ...(input.model ? { model: input.model } : {}),
    }, signal));
    const turn = asRecord(result.turn);
    const turnId = String(turn.id ?? result.turnId ?? (input.runId || randomUUID()));
    return { turnId, threadId: input.threadId, taskId: input.taskId, runId: input.runId };
  }

  async resume(threadId: string, signal?: AbortSignal, afterSequence = 0): Promise<HarnessCommandResult> {
    await this.requireActive(signal);
    const queue = this.queues.get(threadId);
    if (queue) queue.closed = false;
    else this.queues.set(threadId, { events: [], waiters: [], closed: false });
    this.sequence.set(threadId, Math.max(this.sequence.get(threadId) ?? 0, Math.max(0, Math.floor(afterSequence))));
    await this.request('thread/resume', { threadId }, signal);
    this.publish(threadId, 'thread.resumed', {});
    return { accepted: true, delegated: true, command: 'resume' };
  }

  async interrupt(threadId: string, turnId?: string): Promise<HarnessCommandResult> {
    try {
      await this.request('turn/interrupt', { threadId, ...(turnId ? { turnId } : {}) });
      this.publish(threadId, 'turn.interrupted', { ...(turnId ? { turnId } : {}) });
      return { accepted: true, delegated: true, command: 'interrupt' };
    } catch (error) {
      return { accepted: false, delegated: true, command: 'interrupt', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async approve(requestId: string, decision: 'approved' | 'rejected', note?: string): Promise<HarnessCommandResult> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || !this.transport) return { accepted: false, delegated: true, command: 'approve', reason: 'Codex approval request is no longer pending.' };
    this.pendingApprovals.delete(requestId);
    this.transport.respond(pending.rpcId, { decision: decision === 'approved' ? 'accept' : 'decline', ...(note ? { note: note.slice(0, 2_000) } : {}) });
    this.publish(pending.threadId, 'approval.resolved', { requestId, decision, ...(note ? { note } : {}) });
    return { accepted: true, delegated: true, command: 'approve' };
  }

  async steer(threadId: string, note: string): Promise<HarnessCommandResult> {
    try {
      await this.request('turn/steer', { threadId, input: [{ type: 'text', text: note.slice(0, 8_000) }] });
      return { accepted: true, delegated: true, command: 'steer' };
    } catch (error) {
      return { accepted: false, delegated: true, command: 'steer', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async *subscribe(threadId: string, afterSequence = 0, signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    const queue = this.queues.get(threadId);
    if (!queue) return;
    while (true) {
      const next = queue.events.findIndex((event) => event.sequence > afterSequence);
      if (next >= 0) { const event = queue.events.splice(next, 1)[0]!; afterSequence = event.sequence; yield event; continue; }
      if (queue.closed) return;
      const result = await new Promise<IteratorResult<HarnessEvent>>((resolve, reject) => {
        const abort = () => { const index = queue.waiters.indexOf(resolve); if (index >= 0) queue.waiters.splice(index, 1); reject(signal?.reason instanceof Error ? signal.reason : new Error('Codex subscription cancelled.')); };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        queue.waiters.push(resolve);
      });
      if (result.done || !result.value) return;
      afterSequence = result.value.sequence;
      yield result.value;
    }
  }

  close() {
    for (const queue of this.queues.values()) { queue.closed = true; for (const waiter of queue.waiters.splice(0)) waiter({ done: true, value: undefined }); }
    this.transport?.close();
  }

  private async initialize(signal?: AbortSignal) {
    if (this.initialized) return this.initialized;
    this.transport = new AcpStdioTransport({ ...this.options, onMessage: (message) => this.onMessage(message), onClose: () => {
      this.initialized = undefined;
      for (const queue of this.queues.values()) { queue.closed = true; for (const waiter of queue.waiters.splice(0)) waiter({ done: true, value: undefined }); }
    } });
    this.initialized = this.transport.request('initialize', {
      clientInfo: { name: 'axiom-agent-control-room', title: 'Axiom Agent Control Room', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, signal).then((value) => asRecord(value));
    return this.initialized;
  }

  private async requireActive(signal?: AbortSignal) {
    const capabilities = await this.handshake(signal);
    if (!capabilities.compatible || !capabilities.active) throw new HarnessOperationUnavailableError('transport', this.kind, capabilities.reason);
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    if (!this.transport) throw new Error('Codex app-server transport is not initialized.');
    return this.transport.request(method, params, signal);
  }

  private publish(threadId: string, kind: HarnessEvent['kind'], payload: Record<string, unknown>) {
    const queue = this.queues.get(threadId); if (!queue) return;
    const sequence = (this.sequence.get(threadId) ?? 0) + 1; this.sequence.set(threadId, sequence);
    const event: HarnessEvent = { id: randomUUID(), sequence, kind, threadId, payload };
    const waiter = queue.waiters.shift(); if (waiter) waiter({ done: false, value: event }); else { queue.events.push(event); if (queue.events.length > 2_048) queue.events.splice(0, queue.events.length - 2_048); }
  }

  private onMessage(message: RpcMessage) {
    const params = asRecord(message.params);
    const threadId = String(params.threadId ?? params.thread_id ?? '');
    if (!threadId) return;
    const method = message.method ?? '';
    if (method === 'turn/started') this.publish(threadId, 'turn.started', { ...params });
    else if (method === 'turn/completed') this.publish(threadId, 'turn.completed', { ...params });
    else if (method === 'turn/interrupted') this.publish(threadId, 'turn.interrupted', { ...params });
    else if (method === 'error') this.publish(threadId, 'turn.failed', { ...params });
    else if (method === 'item/agentMessage/delta') this.publish(threadId, 'message.delta', { content: params.delta ?? params.text ?? '' });
    else if (method === 'item/started') this.publish(threadId, 'item.started', { item: params.item, turnId: params.turnId });
    else if (method === 'item/completed') this.publish(threadId, 'item.completed', { item: params.item, turnId: params.turnId });
    else if (method.includes('/requestApproval') && message.id !== undefined) {
      const requestId = String(params.itemId ?? params.requestId ?? message.id);
      this.pendingApprovals.set(requestId, { rpcId: message.id, threadId });
      this.publish(threadId, 'approval.requested', { requestId, ...params });
    }
  }
}

/**
 * Optional sidecar boundary. The built-in orchestrator remains authoritative
 * unless a sidecar proves the expected capability contract.
 */
export class DeepSeekHarnessClient {
  private readonly endpoint = process.env.DEEPSEEK_HARNESS_URL?.trim().replace(/\/$/, '') ?? '';
  private readonly apiKey = process.env.DEEPSEEK_HARNESS_API_KEY?.trim() ?? '';

  async handshake(signal?: AbortSignal): Promise<HarnessHandshake> {
    const command = parseCommandEnv();
    if (command.length > 0) {
      let adapter: DeepSeekAcpStdioAdapter | undefined;
      try {
        adapter = new DeepSeekAcpStdioAdapter({
          command,
          cwd: process.env.DEEPSEEK_HARNESS_CWD?.trim() || undefined,
          timeoutMs: Number(process.env.DEEPSEEK_HARNESS_TIMEOUT_MS ?? 30_000),
          active: process.env.DEEPSEEK_HARNESS_ACTIVE === 'true',
        });
        const capabilities = await adapter.handshake(signal);
        return {
          kind: 'deepseek',
          protocol: 'deepseek-harness/v1',
          version: capabilities.version,
          configured: capabilities.configured,
          compatible: capabilities.compatible,
          active: capabilities.active,
          reason: capabilities.reason,
          capabilities: capabilities.capabilities,
        };
      } catch (error) {
        return {
          kind: 'deepseek',
          protocol: 'deepseek-harness/v1',
          version: 'unknown',
          configured: true,
          compatible: false,
          active: false,
          reason: error instanceof Error ? error.message : 'ACP sidecar handshake failed.',
          capabilities: [],
        };
      } finally {
        adapter?.close();
      }
    }
    if (!this.endpoint) {
      return {
        kind: 'builtin',
        protocol: 'builtin/v1',
        version: '1',
        configured: false,
        compatible: true,
        active: true,
        reason: 'Built-in Harness contract is active; an external sidecar is optional.',
        capabilities: [
          'durable-loop',
          'checkpoint-resume',
          'dependency-graph',
          'subagent-delegation',
          'human-steering',
          'review-gate',
          'thread-turn-item-events',
          'runtime-event-replay',
          'approval-context',
        ],
      };
    }

    try {
      const response = await fetch(`${this.endpoint}/capabilities`, {
        headers: {
          Accept: 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(2_500)]),
      });
      const payload = await response.json().catch(() => null) as HarnessPayload | null;
      const capabilities = Array.isArray(payload?.capabilities)
        ? payload.capabilities.filter((value): value is string => typeof value === 'string').slice(0, 32)
        : [];
      const compatible = response.ok && payload?.protocol === 'deepseek-harness/v1';
      return {
        kind: 'deepseek',
        protocol: 'deepseek-harness/v1',
        version: typeof payload?.version === 'string' ? payload.version : 'unknown',
        configured: true,
        compatible,
        active: compatible && process.env.DEEPSEEK_HARNESS_ACTIVE === 'true',
        reason: compatible ? '能力握手已通过。' : 'Sidecar 未声明支持 deepseek-harness/v1。',
        capabilities,
      };
    } catch (error) {
      return {
        kind: 'deepseek',
        protocol: 'deepseek-harness/v1',
        version: 'unknown',
        configured: true,
        compatible: false,
        active: false,
        reason: '能力握手失败。',
        capabilities: [],
      };
    }
  }
}

/**
 * Read-only DeepSeek sidecar adapter until an ACP/HTTP transport is explicitly
 * configured. Capability discovery never implies that task execution moved to
 * the sidecar; callers must opt into a real transport implementation.
 */
export class DeepSeekHarnessAdapter implements HarnessAdapter {
  readonly kind = 'deepseek' as const;
  readonly protocol = 'deepseek-harness/v1' as const;
  private readonly client = new DeepSeekHarnessClient();
  private readonly stdio?: DeepSeekAcpStdioAdapter;

  constructor(options: { command?: readonly string[]; cwd?: string; timeoutMs?: number; active?: boolean } = {}) {
    const command = options.command ?? parseCommandEnv();
    if (command.length > 0) {
      this.stdio = new DeepSeekAcpStdioAdapter({
        command,
        cwd: options.cwd ?? (process.env.DEEPSEEK_HARNESS_CWD?.trim() || undefined),
        timeoutMs: options.timeoutMs ?? Number(process.env.DEEPSEEK_HARNESS_TIMEOUT_MS ?? 30_000),
        active: options.active ?? process.env.DEEPSEEK_HARNESS_ACTIVE === 'true',
      });
    }
  }

  async handshake(signal?: AbortSignal): Promise<HarnessCapabilities> {
    if (this.stdio) return this.stdio.handshake(signal);
    const result = await this.client.handshake(signal);
    return {
      kind: this.kind,
      protocol: this.protocol,
      version: 'unknown',
      configured: result.configured,
      compatible: result.configured && result.compatible,
      active: result.configured && result.active,
      capabilities: result.capabilities,
      reason: result.configured
        ? result.reason
        : 'DeepSeek Harness sidecar is not configured; Builtin Harness remains authoritative.',
    };
  }

  private unavailable(operation: string): HarnessOperationUnavailableError {
    return new HarnessOperationUnavailableError(
      operation,
      this.kind,
      'DeepSeek capability discovery is available, but ACP/HTTP turn transport is not configured.',
    );
  }

  async startThread(_input: HarnessThreadInput, _signal?: AbortSignal): Promise<HarnessThread> {
    if (this.stdio) return this.stdio.startThread(_input, _signal);
    throw this.unavailable('startThread');
  }

  async startTurn(_input: HarnessTurnInput, _signal?: AbortSignal): Promise<HarnessTurn> {
    if (this.stdio) return this.stdio.startTurn(_input, _signal);
    throw this.unavailable('startTurn');
  }

  async resume(_threadId: string, _signal?: AbortSignal, _afterSequence?: number): Promise<HarnessCommandResult> {
    if (this.stdio) return this.stdio.resume(_threadId, _signal, _afterSequence);
    throw this.unavailable('resume');
  }

  async interrupt(_threadId: string, _turnId?: string): Promise<HarnessCommandResult> {
    if (this.stdio) return this.stdio.interrupt(_threadId, _turnId);
    throw this.unavailable('interrupt');
  }

  async approve(_requestId: string, _decision: 'approved' | 'rejected', _note?: string): Promise<HarnessCommandResult> {
    if (this.stdio) return this.stdio.approve(_requestId, _decision, _note);
    throw this.unavailable('approve');
  }

  async steer(_threadId: string, _note: string): Promise<HarnessCommandResult> {
    if (this.stdio) return this.stdio.steer(_threadId, _note);
    throw this.unavailable('steer');
  }

  async *subscribe(_threadId: string, _afterSequence = 0, _signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    if (this.stdio) {
      yield* this.stdio.subscribe(_threadId, _afterSequence, _signal);
      return;
    }
    throw new HarnessOperationUnavailableError(
      'subscribe',
      this.kind,
      'DeepSeek capability discovery is available, but ACP/HTTP event transport is not configured.',
    );
  }

  close() {
    this.stdio?.close();
  }
}

/** Explicit Codex app-server v2 adapter. It is selected only when a Codex
 * command is configured, so the built-in runtime remains the default. */
export class CodexHarnessAdapter implements HarnessAdapter {
  readonly kind = 'codex' as const;
  readonly protocol = 'codex-app-server/v2' as const;
  private readonly stdio?: CodexAppServerAdapter;

  constructor(options: { command?: readonly string[]; cwd?: string; timeoutMs?: number; active?: boolean } = {}) {
    const command = options.command ?? parseNamedCommandEnv('CODEX_APP_SERVER_COMMAND');
    if (command.length > 0) {
      this.stdio = new CodexAppServerAdapter({
        command,
        cwd: options.cwd ?? (process.env.CODEX_APP_SERVER_CWD?.trim() || undefined),
        timeoutMs: options.timeoutMs ?? Number(process.env.CODEX_APP_SERVER_TIMEOUT_MS ?? 30_000),
        active: options.active ?? process.env.CODEX_APP_SERVER_ACTIVE === 'true',
      });
    }
  }

  async handshake(signal?: AbortSignal): Promise<HarnessCapabilities> {
    if (this.stdio) return this.stdio.handshake(signal);
    return { kind: this.kind, protocol: this.protocol, version: 'unknown', configured: false, compatible: false, active: false, capabilities: [], reason: 'Codex app-server command is not configured.' };
  }
  async startThread(input: HarnessThreadInput, signal?: AbortSignal) { return this.require().startThread(input, signal); }
  async startTurn(input: HarnessTurnInput, signal?: AbortSignal) { return this.require().startTurn(input, signal); }
  async resume(threadId: string, signal?: AbortSignal, afterSequence?: number) { return this.require().resume(threadId, signal, afterSequence); }
  async interrupt(threadId: string, turnId?: string) { return this.require().interrupt(threadId, turnId); }
  async approve(requestId: string, decision: 'approved' | 'rejected', note?: string) { return this.require().approve(requestId, decision, note); }
  async steer(threadId: string, note: string) { return this.require().steer(threadId, note); }
  async *subscribe(threadId: string, afterSequence = 0, signal?: AbortSignal) {
    yield* this.require().subscribe(threadId, afterSequence, signal);
  }
  close() { this.stdio?.close(); }
  private require() {
    if (!this.stdio) throw new HarnessOperationUnavailableError('transport', this.kind, 'Codex app-server command is not configured.');
    return this.stdio;
  }
}

/** Parse an explicit JSON command first; the plain form is intentionally tiny
 * and does not invoke a shell, preventing environment-controlled command
 * injection through metacharacters. */
function parseNamedCommandEnv(name: string): readonly string[] {
  const json = process.env[`${name}_JSON`]?.trim();
  if (json) {
    try {
      const value = JSON.parse(json) as unknown;
      if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())) return value.map((item) => item.trim());
    } catch {
      return [];
    }
  }
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => token.replace(/^("|')|("|')$/g, '')).filter(Boolean);
}

function parseCommandEnv(): readonly string[] {
  return parseNamedCommandEnv('DEEPSEEK_HARNESS_COMMAND');
}
