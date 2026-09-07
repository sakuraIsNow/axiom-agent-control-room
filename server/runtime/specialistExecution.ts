import { createHash, randomUUID } from 'node:crypto';
import type { WorkflowTask } from './contracts.js';
import type { ToolExecutionRecord, ToolExecutionStore } from './toolExecutionStore.js';
import { ToolExecutionPendingError, ToolExecutionUnknownError, type ToolExecution } from './toolRegistry.js';

export type SpecialistExecutionContext = {
  store: ToolExecutionStore;
  task: WorkflowTask;
  stepId: string;
  invocationId: string;
};

export type SpecialistProviderReceipt = {
  status: number;
  payload: Record<string, unknown>;
};

const workerId = `specialist:${process.pid}:${randomUUID()}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const generationResponseText = async (response: Response) => {
  const maxBytes = 64_000_000;
  if (Number(response.headers.get('content-length')) > maxBytes || !response.body) throw new Error('Generation receipt exceeds the supported size or has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Generation receipt exceeds the supported size.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
};

/** Only generation POSTs use this entry point; it shares the normal recovery ledger. */
export const executeSpecialistGeneration = async (input: {
  context: SpecialistExecutionContext;
  toolName: 'service.image.generate' | 'service.video.generate';
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  image?: { content: Uint8Array; mimeType: string; name: string };
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{ receipt: ToolExecution; response?: SpecialistProviderReceipt; record: ToolExecutionRecord }> => {
  const { context, signal } = input;
  signal.throwIfAborted();
  const safeArgs = { requestDigest: digest(input.body), providerDigest: digest([input.url, input.apiKey]), model: String(input.body.model ?? ''),
    ...(input.image ? { imageDigest: createHash('sha256').update(input.image.content).digest('hex'), imageMimeType: input.image.mimeType } : {}) };
  const signature = digest({ version: 1, ...safeArgs, toolName: input.toolName });
  const leaseMs = Math.min(300_000, Math.max(1_000, Number(process.env.AXIOM_TOOL_EXECUTION_LEASE_MS) || 30_000));
  const claim = await context.store.claim({
    tenantId: context.task.tenantId, taskId: context.task.id, runId: context.task.runId,
    stepId: context.stepId, invocationId: context.invocationId, signature, toolName: input.toolName,
    sideEffect: 'write', callId: randomUUID(), auditId: randomUUID(), workerId, leaseMs,
  });
  const replay = (record: ToolExecutionRecord) => {
    if (record.receiptSource === 'tool' && record.receipt) {
      const receipt = { ...record.receipt, replayed: true };
      const response = JSON.parse(receipt.output) as SpecialistProviderReceipt;
      return { receipt, response, record };
    }
    const confirmation = record.resolutions.at(-1);
    if (!confirmation) throw new ToolExecutionUnknownError(record);
    const receipt: ToolExecution = {
      call: { id: record.callId, name: input.toolName, args: safeArgs }, output: confirmation.note,
      stderr: '', exitCode: 0, durationMs: 0, auditId: record.auditId, risk: 'medium', signature,
      replayed: true, receiptSource: 'human-confirmed', humanConfirmation: confirmation,
    };
    return { receipt, record };
  };
  if (claim.kind === 'replay') return replay(claim.record);
  if (claim.kind === 'pending') throw new ToolExecutionPendingError(claim.record);
  if (claim.kind === 'outcome_unknown') throw new ToolExecutionUnknownError(claim.record);
  if (claim.kind !== 'claimed') throw new ToolExecutionPendingError(claim.record);
  const owner = { tenantId: context.task.tenantId, id: claim.record.id, leaseToken: claim.leaseToken };
  if (signal.aborted) {
    await context.store.releaseUnstarted(owner);
    signal.throwIfAborted();
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(input.timeoutMs)]);
  let heartbeat: Promise<void> | undefined;
  let leaseLost = false;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = context.store.renew(owner, leaseMs).then((renewed) => {
      if (!renewed) { leaseLost = true; controller.abort(); }
    }).catch(() => { leaseLost = true; controller.abort(); }).finally(() => { heartbeat = undefined; });
  }, Math.max(100, Math.floor(leaseMs / 3)));
  timer.unref();
  const startedAt = Date.now();
  const unknown = async () => {
    const reason = 'The generation service may have accepted the request, but its durable result is unconfirmed. Verify the provider outcome before retrying.';
    await context.store.markUnknown(owner, reason).catch(() => false);
    const record = await context.store.get(context.task.tenantId, claim.record.id).catch(() => null);
    return new ToolExecutionUnknownError(record ?? { ...claim.record, status: 'outcome_unknown', unknownReason: reason });
  };
  try {
    let body: string | FormData = JSON.stringify(input.body);
    if (input.image) {
      const form = new FormData();
      for (const [key, value] of Object.entries(input.body)) form.append(key, String(value));
      form.append('image', new Blob([Uint8Array.from(input.image.content)], { type: input.image.mimeType }), input.image.name);
      body = form;
    }
    // No automatic HTTP retry: a lost response can still mean the provider accepted it.
    const response = await fetch(input.url, {
      method: 'POST', headers: { ...(!input.image ? { 'Content-Type': 'application/json' } : {}), ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}) },
      body, signal: requestSignal, redirect: 'error',
    });
    if (response.status >= 500 || response.status === 408) throw new Error('Generation acceptance could not be confirmed.');
    const text = await generationResponseText(response);
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Generation receipt must be an object.');
    requestSignal.throwIfAborted();
    const providerReceipt: SpecialistProviderReceipt = { status: response.status, payload: payload as Record<string, unknown> };
    const receipt: ToolExecution = {
      call: { id: claim.record.callId, name: input.toolName, args: safeArgs }, output: JSON.stringify(providerReceipt),
      stderr: response.ok ? '' : `Generation service rejected the request (${response.status}).`,
      exitCode: response.ok ? 0 : 1, durationMs: Date.now() - startedAt,
      auditId: claim.record.auditId, risk: 'medium', signature, receiptSource: 'tool',
    };
    let saved = false;
    try { saved = !leaseLost && await context.store.complete(owner, receipt); }
    catch { /* Verify the commit before treating a lost acknowledgement as unknown. */ }
    const record = await context.store.get(context.task.tenantId, claim.record.id).catch(() => null);
    if (record?.status === 'completed' && record.receiptSource === 'tool' && record.receipt) {
      if (!saved) return replay(record);
      return { receipt: record.receipt, response: providerReceipt, record };
    }
    if (!saved || !record) throw await unknown();
    return { receipt, response: providerReceipt, record };
  } catch (error) {
    if (error instanceof ToolExecutionUnknownError) throw error;
    throw await unknown();
  } finally {
    clearInterval(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
    await heartbeat;
  }
};

export const specialistUsage = (usage: unknown): Record<string, number> | undefined => {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const fields = Object.entries(usage).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return fields.length ? Object.fromEntries(fields) as Record<string, number> : undefined;
};

export const measuredSpecialistTokens = (usage: Record<string, number> | undefined): number | undefined => {
  if (!usage) return undefined;
  if (Number.isFinite(usage.total_tokens)) return usage.total_tokens;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  return input !== undefined && output !== undefined ? input + output : undefined;
};
