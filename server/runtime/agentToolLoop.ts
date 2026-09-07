import { createHash } from 'node:crypto';
import type { ToolExecution } from './toolRegistry.js';

export type AgentToolInvocation = { name: string; args: Record<string, unknown> };
export type AgentToolDecision = { output: string; toolCalls: AgentToolInvocation[] };
export type AgentToolObservation = {
  round: number;
  index: number;
  invocationId: string;
  invocation: AgentToolInvocation;
  execution?: ToolExecution;
  error?: string;
};
export type AgentToolLoopStop = 'no-progress' | 'round-budget' | 'call-budget' | 'token-budget';
export type AgentToolLoopRecord<T extends AgentToolDecision = AgentToolDecision> = {
  version: 1;
  scope: string;
  round: number;
} & (
  | { phase: 'decision'; decision: T; tokens: number; measuredTokens?: number; attempts: number }
  | { phase: 'observation'; observation: AgentToolObservation }
  | { phase: 'completed' }
  | { phase: 'stopped'; reason: AgentToolLoopStop }
);

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

export const toolInvocationDigest = (invocation: AgentToolInvocation) => createHash('sha256').update(stableJson(invocation)).digest('hex');

export const toolLoopScope = (runId: string, step: unknown, rerunSequence = 0) => createHash('sha256')
  .update(stableJson({ runId, step, rerunSequence })).digest('hex');

export const parseToolLoopRecord = <T extends AgentToolDecision>(
  value: Record<string, unknown>,
  scope: string,
  parseDecision: (value: unknown) => T,
): AgentToolLoopRecord<T> | null => {
  if (value.scope !== scope) return null;
  if (value.version !== 1 || !Number.isInteger(value.round) || Number(value.round) < 1 || Number(value.round) > 64) {
    throw new Error('Invalid persisted Agent tool loop record.');
  }
  const base = { version: 1 as const, scope, round: Number(value.round) };
  if (value.phase === 'decision') {
    if (!Number.isFinite(value.tokens) || Number(value.tokens) < 0 || !Number.isInteger(value.attempts) || Number(value.attempts) < 1) throw new Error('Invalid persisted Agent decision usage.');
    if (value.measuredTokens !== undefined && (!Number.isFinite(value.measuredTokens) || Number(value.measuredTokens) < 0)) throw new Error('Invalid persisted measured usage.');
    return { ...base, phase: 'decision', decision: parseDecision(value.decision), tokens: Number(value.tokens), ...(value.measuredTokens !== undefined ? { measuredTokens: Number(value.measuredTokens) } : {}), attempts: Number(value.attempts) };
  }
  if (value.phase === 'completed') return { ...base, phase: 'completed' };
  if (value.phase === 'stopped' && ['no-progress', 'round-budget', 'call-budget', 'token-budget'].includes(String(value.reason))) {
    return { ...base, phase: 'stopped', reason: value.reason as AgentToolLoopStop };
  }
  if (value.phase === 'observation') {
    const observation = value.observation as AgentToolObservation | undefined;
    if (!observation || observation.round !== base.round || !Number.isInteger(observation.index) || observation.index < 0
      || typeof observation.invocationId !== 'string' || !observation.invocation || typeof observation.invocation.name !== 'string'
      || !observation.invocation.args || typeof observation.invocation.args !== 'object'
      || (!observation.execution && typeof observation.error !== 'string')) throw new Error('Invalid persisted Agent tool observation.');
    if (observation.execution && (!observation.execution.call || typeof observation.execution.auditId !== 'string'
      || !Number.isInteger(observation.execution.exitCode) || typeof observation.execution.output !== 'string')) throw new Error('Invalid persisted Agent tool receipt.');
    return { ...base, phase: 'observation', observation };
  }
  throw new Error('Unknown persisted Agent tool loop phase.');
};

const boundedPositive = (value: number | undefined, fallback: number, ceiling: number) => Number.isFinite(value)
  ? Math.min(ceiling, Math.max(1, Math.floor(value!))) : fallback;

/** The journal is written before effects; the executor independently fences the invocation. */
export const runAgentToolLoop = async <T extends AgentToolDecision>(options: {
  scope: string;
  history: readonly AgentToolLoopRecord<T>[];
  signal: AbortSignal;
  maxRounds?: number;
  maxCalls?: number;
  maxTokens?: number;
  isReadOnly?: (invocation: AgentToolInvocation) => boolean;
  assertActive: () => Promise<void>;
  decide: (input: { round: number; observations: readonly AgentToolObservation[]; remainingTokens: number }) => Promise<{ decision: T; tokens: number; measuredTokens?: number; attempts: number }>;
  execute: (invocation: AgentToolInvocation, invocationId: string) => Promise<{ execution?: ToolExecution; error?: string }>;
  persist: (record: AgentToolLoopRecord<T>) => Promise<AgentToolLoopRecord<T> | void>;
}) => {
  const maxRounds = boundedPositive(options.maxRounds, 8, 32);
  const maxCalls = boundedPositive(options.maxCalls, 24, 128);
  const maxTokens = boundedPositive(options.maxTokens, 64_000, 512_000);
  const records = options.history.filter((record) => record.scope === options.scope);
  const observations: AgentToolObservation[] = [];
  let tokens = 0;
  let measuredTokens = 0;
  let usageComplete = true;
  let attempts = 0;
  const active = async () => {
    options.signal.throwIfAborted();
    await options.assertActive();
    options.signal.throwIfAborted();
  };
  const save = async (record: AgentToolLoopRecord<T>) => {
    await active();
    const saved = await options.persist(record) ?? record;
    records.push(saved);
    return saved;
  };
  const finish = async (decision: T, round: number, reason?: AgentToolLoopStop) => {
    const existing = records.find((record) => record.round === round && (record.phase === 'stopped' || record.phase === 'completed'));
    if (!existing) await save({ version: 1, scope: options.scope, round, ...(reason ? { phase: 'stopped', reason } : { phase: 'completed' }) });
    return { decision, observations, tokens, measuredTokens: usageComplete ? measuredTokens : undefined, attempts, rounds: round, ...(reason ? { stopReason: reason } : {}) };
  };
  for (let round = 1; round <= maxRounds; round += 1) {
    await active();
    let savedDecision = records.find((record) => record.round === round && record.phase === 'decision');
    if (!savedDecision) {
      const next = await options.decide({ round, observations, remainingTokens: Math.max(0, maxTokens - tokens) });
      savedDecision = await save({ version: 1, scope: options.scope, round, phase: 'decision', ...next });
    }
    if (savedDecision.phase !== 'decision') throw new Error('Agent tool loop journal did not persist its decision.');
    const { decision } = savedDecision;
    tokens += savedDecision.tokens;
    if (savedDecision.measuredTokens === undefined) usageComplete = false;
    else measuredTokens += savedDecision.measuredTokens;
    attempts += savedDecision.attempts;
    const stopped = records.find((record) => record.round === round && record.phase === 'stopped');
    if (stopped?.phase === 'stopped') {
      for (const [index, invocation] of decision.toolCalls.entries()) {
        const prior = records.find((record) => record.phase === 'observation' && record.round === round && record.observation.index === index);
        if (prior?.phase !== 'observation') continue;
        if (prior.observation.invocationId !== `${options.scope}:${round}:${index}` || toolInvocationDigest(prior.observation.invocation) !== toolInvocationDigest(invocation)) throw new Error('Persisted Agent tool observation does not match its decision.');
        observations.push(prior.observation);
      }
      return finish(decision, round, stopped.reason);
    }
    if (decision.toolCalls.length === 0) return finish(decision, round);
    if (tokens >= maxTokens) return finish(decision, round, 'token-budget');
    if (observations.length + decision.toolCalls.length > maxCalls) return finish(decision, round, 'call-budget');
    const isReadOnly = options.isReadOnly ?? (() => false);
    // Re-reading after a write is verification, not a replay of the old read.
    // Only repeated writes are reused; stable reads stop after two unchanged rounds.
    const priorSignatures = new Set(observations.filter((item) => !isReadOnly(item.invocation)).map((item) => toolInvocationDigest(item.invocation)));
    if (decision.toolCalls.every((call) => !isReadOnly(call) && priorSignatures.has(toolInvocationDigest(call)))) return finish(decision, round, 'no-progress');
    if (round > 2 && decision.toolCalls.every(isReadOnly)) {
      const priorRound = observations.filter((item) => item.round === round - 1);
      const earlierRound = observations.filter((item) => item.round === round - 2);
      const matches = (items: AgentToolObservation[]) => items.length === decision.toolCalls.length
        && items.every((item, index) => toolInvocationDigest(item.invocation) === toolInvocationDigest(decision.toolCalls[index]!));
      const resultDigest = (items: AgentToolObservation[]) => stableJson(items.map((item) => item.execution
        ? { output: item.execution.output, stderr: item.execution.stderr, exitCode: item.execution.exitCode }
        : { error: item.error }));
      if (matches(priorRound) && matches(earlierRound) && resultDigest(priorRound) === resultDigest(earlierRound)) return finish(decision, round, 'no-progress');
    }
    for (const [index, invocation] of decision.toolCalls.entries()) {
      const invocationId = `${options.scope}:${round}:${index}`;
      let observation = records.find((record) => record.phase === 'observation' && record.round === round && record.observation.index === index);
      if (observation?.phase === 'observation') {
        if (observation.observation.invocationId !== invocationId || toolInvocationDigest(observation.observation.invocation) !== toolInvocationDigest(invocation)) {
          throw new Error('Persisted Agent tool observation does not match its decision.');
        }
        observations.push(observation.observation);
        continue;
      }
      await active();
      const previous = !isReadOnly(invocation) ? observations.find((item) => toolInvocationDigest(item.invocation) === toolInvocationDigest(invocation)) : undefined;
      const result = previous ? { execution: previous.execution, error: previous.error } : await options.execute(invocation, invocationId);
      observation = await save({ version: 1, scope: options.scope, round, phase: 'observation', observation: { round, index, invocationId, invocation, ...result } });
      if (observation.phase !== 'observation') throw new Error('Agent tool loop journal did not persist its observation.');
      observations.push(observation.observation);
    }
    if (round === maxRounds) return finish(decision, round, 'round-budget');
    if (observations.length >= maxCalls) return finish(decision, round, 'call-budget');
  }
  throw new Error('Agent tool loop ended without a decision.');
};
