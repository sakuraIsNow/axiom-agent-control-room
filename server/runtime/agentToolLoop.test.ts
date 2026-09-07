import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseToolLoopRecord, runAgentToolLoop, toolInvocationDigest, toolLoopScope, type AgentToolDecision, type AgentToolLoopRecord } from './agentToolLoop.js';

const decision = (name?: string, args: Record<string, unknown> = {}): AgentToolDecision => ({ output: name ? `Request ${name}` : 'Delivered', toolCalls: name ? [{ name, args }] : [] });

test('tool loop observes a result before selecting the next tool and journals before effects', async () => {
  const history: AgentToolLoopRecord[] = [];
  const calls: string[] = [];
  const result = await runAgentToolLoop({
    scope: 'test', history, signal: new AbortController().signal, assertActive: async () => {},
    decide: async ({ round, observations }) => {
      if (round === 2) assert.equal(observations[0]?.error, 'Read the configuration instead');
      return { decision: round === 1 ? decision('lookup') : round === 2 ? decision('read', { path: 'config.json' }) : decision(), tokens: 10, attempts: 1 };
    },
    execute: async (invocation, invocationId) => {
      assert.equal(history.at(-1)?.phase, 'decision');
      calls.push(`${invocation.name}:${invocationId}`);
      return { error: 'Read the configuration instead' };
    },
    persist: async (record) => { history.push(structuredClone(record)); },
  });
  assert.equal(result.stopReason, undefined);
  assert.equal(result.rounds, 3);
  assert.equal(result.tokens, 30);
  assert.deepEqual(calls, ['lookup:test:1:0', 'read:test:2:0']);
});

test('approval interruption preserves decision and invocation identity across restoration', async () => {
  const history: AgentToolLoopRecord[] = [];
  let modelCalls = 0;
  const ids: string[] = [];
  const options = {
    scope: 'approval', history, signal: new AbortController().signal, assertActive: async () => {},
    decide: async ({ round }: { round: number }) => { modelCalls += 1; return { decision: round === 1 ? decision('write') : decision(), tokens: 2, attempts: 1 }; },
    persist: async (record: AgentToolLoopRecord) => { history.push(structuredClone(record)); },
  };
  await assert.rejects(runAgentToolLoop({ ...options, execute: async (_call, id) => { ids.push(id); throw new Error('approval required'); } }), /approval required/);
  const restored = await runAgentToolLoop({ ...options, history: structuredClone(history), execute: async (_call, id) => { ids.push(id); return { error: 'Rejected by operator' }; } });
  assert.deepEqual(ids, ['approval:1:0', 'approval:1:0']);
  assert.equal(modelCalls, 2);
  assert.equal(restored.observations.length, 1);
  assert.equal(restored.tokens, 4);
});

test('committed observations and final decision replay without models or effects', async () => {
  const history: AgentToolLoopRecord[] = [];
  const initial = {
    scope: 'replay', history, signal: new AbortController().signal, assertActive: async () => {},
    decide: async ({ round }: { round: number }) => ({ decision: round === 1 ? decision('read') : decision(), tokens: 3, attempts: 1 }),
    execute: async () => ({ error: 'no data' }),
    persist: async (record: AgentToolLoopRecord) => { history.push(structuredClone(record)); },
  };
  await runAgentToolLoop(initial);
  const restored = await runAgentToolLoop({ ...initial, history: structuredClone(history), decide: async () => { throw new Error('unexpected model'); }, execute: async () => { throw new Error('unexpected effect'); } });
  assert.equal(restored.decision.output, 'Delivered');
  assert.equal(restored.observations.length, 1);
});

test('no-progress, round, call and token limits stop without extra side effects', async () => {
  for (const mode of ['no-progress', 'round-budget', 'call-budget', 'token-budget'] as const) {
    let calls = 0;
    const result = await runAgentToolLoop({
      scope: mode, history: [], signal: new AbortController().signal, assertActive: async () => {},
      maxRounds: mode === 'round-budget' ? 1 : 8,
      maxCalls: mode === 'call-budget' ? 1 : 24,
      maxTokens: mode === 'token-budget' ? 1 : 100,
      decide: async () => ({ decision: decision('write'), tokens: 1, attempts: 1 }),
      execute: async () => { calls += 1; return { error: 'unchanged' }; },
      persist: async () => {},
    });
    assert.equal(result.stopReason, mode);
    assert.equal(calls, mode === 'token-budget' ? 0 : 1);
  }
});

test('cancellation after model decision prevents tool execution and malformed journals fail closed', async () => {
  const controller = new AbortController();
  await assert.rejects(runAgentToolLoop({
    scope: 'cancel', history: [], signal: controller.signal, assertActive: async () => {},
    decide: async () => { controller.abort(); return { decision: decision('write'), tokens: 0, attempts: 1 }; },
    execute: async () => { throw new Error('must not execute'); }, persist: async () => {},
  }), /abort/i);
  assert.throws(() => parseToolLoopRecord({ scope: 'cancel', version: 1, round: -1, phase: 'decision' }, 'cancel', () => decision()), /Invalid persisted/);
  assert.equal(toolInvocationDigest({ name: 'read', args: { a: 1, b: 2 } }), toolInvocationDigest({ name: 'read', args: { b: 2, a: 1 } }));
  assert.notEqual(toolLoopScope('run', { id: 'step' }, 0), toolLoopScope('run', { id: 'step' }, 10));
});

test('restored bounded loops retain the last tool observations and never fabricate measured usage', async () => {
  const history: AgentToolLoopRecord[] = [];
  const options = {
    scope: 'bound-replay', history, maxRounds: 1, signal: new AbortController().signal, assertActive: async () => {},
    decide: async () => ({ decision: decision('read'), tokens: 20, attempts: 1 }),
    execute: async () => ({ error: 'A real tool observation' }),
    persist: async (record: AgentToolLoopRecord) => { history.push(structuredClone(record)); },
  };
  const first = await runAgentToolLoop(options);
  const restored = await runAgentToolLoop({ ...options, history: structuredClone(history), execute: async () => { throw new Error('Unexpected effect'); } });
  assert.equal(first.measuredTokens, undefined);
  assert.equal(restored.measuredTokens, undefined);
  assert.equal(restored.stopReason, 'round-budget');
  assert.deepEqual(restored.observations, first.observations);
  const measured = await runAgentToolLoop({ ...options, history: [], decide: async () => ({ decision: decision(), tokens: 20, measuredTokens: 15, attempts: 1 }) });
  assert.equal(measured.measuredTokens, 15);
});

test('read-modify-read observes fresh state and unchanged read polling stops after two attempts', async () => {
  let state = 'original';
  const seen: string[] = [];
  const result = await runAgentToolLoop({
    scope: 'verify', history: [], signal: new AbortController().signal, assertActive: async () => {}, isReadOnly: (call) => call.name === 'read',
    decide: async ({ round, observations }) => {
      if (round === 4) assert.equal(observations.at(-1)?.execution?.output, 'updated');
      return { decision: round === 1 || round === 3 ? decision('read') : round === 2 ? decision('write') : decision(), tokens: 1, attempts: 1 };
    },
    execute: async (invocation, id) => {
      if (invocation.name === 'write') state = 'updated';
      seen.push(`${invocation.name}:${state}`);
      return { execution: { call: { id, ...invocation }, output: state, stderr: '', exitCode: 0, durationMs: 1, auditId: id, signature: id, risk: 'low' } };
    }, persist: async () => {},
  });
  assert.equal(result.stopReason, undefined);
  assert.deepEqual(seen, ['read:original', 'write:updated', 'read:updated']);
  let reads = 0;
  const unchanged = await runAgentToolLoop({
    scope: 'poll', history: [], signal: new AbortController().signal, assertActive: async () => {}, isReadOnly: () => true,
    decide: async () => ({ decision: decision('read'), tokens: 1, attempts: 1 }),
    execute: async () => { reads += 1; return { error: 'No changes' }; }, persist: async () => {},
  });
  assert.equal(unchanged.stopReason, 'no-progress');
  assert.equal(reads, 2);
});
