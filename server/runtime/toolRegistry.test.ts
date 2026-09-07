import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { FileArtifactStore } from './artifactStore.js';
import { allowedHttpHost, ToolApprovalRequiredError, ToolExecutionPendingError, ToolExecutionUnknownError, ToolRegistry, type RegisteredTool } from './toolRegistry.js';
import { SqliteToolExecutionStore, type ToolExecutionStore } from './toolExecutionStore.js';
import type { AgentStore, WorkflowTask } from './contracts.js';

const task = (id = 'tool-task'): WorkflowTask => ({
  id,
  runId: `${id}-run`,
  revision: 0,
  tenantId: 'tenant-a',
  userId: 'operator-a',
  sessionId: 'session-a',
  title: 'Tool test',
  input: 'tool test',
  mode: 'build',
  status: 'running',
  stepResults: [],
  cancelRequested: false,
  policy: { requirePlanApproval: false },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

test('tool catalog exposes risk, schema, timeout, and approval metadata', () => {
  const registry = new ToolRegistry({ execute: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, auditId: 'fake' }) } as never);
  const catalog = registry.catalog();
  assert.ok(catalog.length >= 9);
  assert.equal(catalog.find((tool) => tool.name === 'workspace.patch')?.risk, 'high');
  assert.equal(catalog.find((tool) => tool.name === 'workspace.patch')?.approvalRequired, true);
  assert.ok(catalog.find((tool) => tool.name === 'workspace.git-diff')?.parameters.properties);
  assert.equal(catalog.find((tool) => tool.name === 'workspace.search')?.executionBoundary, 'sandbox');
  assert.equal(catalog.find((tool) => tool.name === 'workspace.write')?.executionBoundary, 'host-bounded');
  assert.equal(catalog.find((tool) => tool.name === 'database.query')?.executionBoundary, 'host-bounded');
});

test('semantic external-tool routing applies Top-K, health, authorization, and Agent permissions', () => {
  const registry = new ToolRegistry({ execute: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, auditId: 'fake' }) } as never);
  const addExternal = (name: string, overrides: Partial<NonNullable<RegisteredTool['routing']>> = {}) => registry.upsert({
    name,
    description: '查询城市天气',
    risk: 'low',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    schema: z.object({}).strict(),
    timeoutMs: 5_000,
    routing: {
      sourceId: `source-${name}`,
      tenantId: 'tenant-a',
      categories: ['research'],
      capabilityTags: ['天气', 'weather'],
      healthStatus: 'healthy',
      authorizationStatus: 'not-required',
      allowedAgentIds: ['builder'],
      sourceRisk: 'low',
      successRate: 0.9,
      latencyMs: 100,
      ...overrides,
    },
    handler: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, auditId: 'external' }),
  });
  for (let index = 0; index < 10; index += 1) addExternal(`external_weather_${index}`);
  addExternal('external_unhealthy', { healthStatus: 'unhealthy' });
  addExternal('external_pending_auth', { authorizationStatus: 'pending' });
  addExternal('external_wrong_agent', { allowedAgentIds: ['analyst'] });
  addExternal('external_other_tenant', { tenantId: 'tenant-b' });

  const selected = registry.catalogForTask({ tenantId: 'tenant-a', query: '查询上海天气并形成简报', agentIds: ['builder'], externalLimit: 6 });
  const externalNames = selected.filter((tool) => tool.routing).map((tool) => tool.name);
  assert.equal(externalNames.length, 6);
  assert.ok(externalNames.every((name) => /^external_weather_/u.test(name)));
  assert.equal(selected.some((tool) => tool.name === 'external_unhealthy'), false);
  assert.equal(selected.some((tool) => tool.name === 'external_pending_auth'), false);
  assert.equal(selected.some((tool) => tool.name === 'external_wrong_agent'), false);
  assert.equal(selected.some((tool) => tool.name === 'external_other_tenant'), false);

  const unrelated = registry.catalogForTask({ tenantId: 'tenant-a', query: '修改本地文件中的标题', agentIds: ['builder'], externalLimit: 6 });
  assert.equal(unrelated.some((tool) => tool.routing), false);
  const forbiddenExplicit = registry.catalogForTask({ tenantId: 'tenant-a', query: '查询天气', agentIds: ['builder'], explicitNames: ['external_wrong_agent'] });
  assert.equal(forbiddenExplicit.some((tool) => tool.name === 'external_wrong_agent'), false);
});

test('capability-pack state filters tenant external tools before model injection', () => {
  const registry = new ToolRegistry({ execute: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, auditId: 'fake' }) } as never);
  registry.upsert({
    name: 'external_office_calendar', description: '读取飞书日历', risk: 'medium',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, schema: z.object({}).strict(), timeoutMs: 5_000,
    routing: { sourceId: 'office-source', tenantId: 'tenant-a', categories: ['office'], capabilityTags: ['飞书', '日历'], healthStatus: 'healthy', authorizationStatus: 'ready', allowedAgentIds: [], sourceRisk: 'medium' },
    handler: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, auditId: 'external' }),
  });
  registry.setTenantCapabilityPacks('tenant-a', ['development', 'research', 'data']);
  assert.equal(registry.catalogForTask({ tenantId: 'tenant-a', query: '读取飞书日历', agentIds: ['researcher'] }).some((tool) => tool.name === 'external_office_calendar'), false);
  registry.setTenantCapabilityPacks('tenant-a', ['development', 'research', 'office', 'data']);
  assert.equal(registry.catalogForTask({ tenantId: 'tenant-a', query: '读取飞书日历', agentIds: ['researcher'] }).some((tool) => tool.name === 'external_office_calendar'), true);
});

test('agent.propose creates a private draft through the AgentStore boundary', async () => {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  const created: Array<Record<string, unknown>> = [];
  const agentStore = {
    createAgent: async (input: Record<string, unknown>) => {
      created.push(input);
      return {
        id: 'agent-draft-1',
        roleId: input.roleId,
        status: 'draft',
      };
    },
  } as unknown as AgentStore;
  const registry = new ToolRegistry(undefined, null, agentStore);
  const catalog = registry.catalog();
  const proposalTool = catalog.find((tool) => tool.name === 'agent.propose');
  assert.equal(proposalTool?.risk, 'low');
  assert.equal(proposalTool?.executionBoundary, 'host-bounded');
  assert.equal(proposalTool?.approvalRequired, false);

  try {
    const execution = await registry.execute(task('agent-proposal'), 'proposal-step', {
      name: 'agent.propose',
      args: {
        roleId: 'data-specialist',
        name: 'Data Specialist',
        description: 'Compares structured data.',
        systemPromptTemplate: 'Use structured data reasoning.',
        whenToUseHint: 'Use for data comparison questions.',
        toolAllowlist: ['workspace.read'],
      },
    });
    assert.equal(execution.exitCode, 0);
    assert.deepEqual(JSON.parse(execution.output), { id: 'agent-draft-1', roleId: 'data-specialist', status: 'draft' });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.tenantId, 'tenant-a');
    assert.equal(created[0]?.createdBy, 'operator-a');
    assert.equal(created[0]?.status, undefined, 'the Tool Registry does not publish proposals');
    assert.deepEqual((created[0]?.definition as { toolAllowlist?: string[] }).toolAllowlist, ['workspace.read']);
  } finally {
    if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
    else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
  }
});

test('HTTP allowlist rejects cloud metadata and private IPv6 addresses', () => {
  const previous = process.env.AXIOM_HTTP_ALLOWLIST;
  process.env.AXIOM_HTTP_ALLOWLIST = '169.254.169.254,metadata.google.internal,fd00::1,example.com';
  try {
    assert.equal(allowedHttpHost('169.254.169.254'), false);
    assert.equal(allowedHttpHost('metadata.google.internal'), false);
    assert.equal(allowedHttpHost('fd00::1'), false);
    assert.equal(allowedHttpHost('::1'), false);
    assert.equal(allowedHttpHost('example.com'), true);
  } finally {
    if (previous === undefined) delete process.env.AXIOM_HTTP_ALLOWLIST;
    else process.env.AXIOM_HTTP_ALLOWLIST = previous;
  }
});

test('host-bounded adapters still require the Docker execution gate', async () => {
  const previous = process.env.AXIOM_TOOL_EXECUTOR;
  delete process.env.AXIOM_TOOL_EXECUTOR;
  try {
    const registry = new ToolRegistry({ execute: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, auditId: 'fake' }) } as never);
    await assert.rejects(
      registry.execute(task('disabled-tools'), 'step-1', { name: 'document.read', args: { path: 'README.md' } }),
      /Docker sandbox is enabled/i,
    );
  } finally {
    if (previous === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
    else process.env.AXIOM_TOOL_EXECUTOR = previous;
  }
});

test('write tools pause for approval and preserve artifact lineage after approval', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'axiom-tool-workspace-'));
  const artifacts = await mkdtemp(join(tmpdir(), 'axiom-tool-artifacts-'));
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  const previousRoot = process.env.AXIOM_AGENT_WORKSPACE_ROOT;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  process.env.AXIOM_AGENT_WORKSPACE_ROOT = workspace;
  try {
    const registry = new ToolRegistry({ execute: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, auditId: 'fake' }) } as never, new FileArtifactStore(artifacts));
    const original = task();
    await assert.rejects(
      registry.execute(original, 'step-1', { name: 'workspace.write', args: { path: 'notes/result.txt', content: 'approved content' } }),
      (error: unknown) => error instanceof ToolApprovalRequiredError && error.approval.risk === 'high',
    );
    const approvalError = await registry.execute(original, 'step-1', { name: 'workspace.write', args: { path: 'notes/result.txt', content: 'approved content' } }).catch((error: unknown) => error);
    assert.ok(approvalError instanceof ToolApprovalRequiredError);
    const approved = { ...original, toolApprovals: [{ ...approvalError.approval, status: 'approved' as const, decidedBy: 'operator-a', decidedAt: new Date().toISOString() }] };
    const execution = await registry.execute(approved, 'step-1', { name: 'workspace.write', args: { path: 'notes/result.txt', content: 'approved content' } });
    assert.equal(execution.exitCode, 0);
    assert.equal(await readFile(join(workspace, 'notes', 'result.txt'), 'utf8'), 'approved content');
    assert.equal(execution.artifact?.sourceToolCallId, execution.call.id);
    assert.deepEqual(execution.artifact?.lineage, { taskId: original.id, stepId: 'step-1', toolCallId: execution.call.id });
    assert.equal(registry.audits(original.id).at(-1)?.status, 'completed');
  } finally {
    if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
    else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
    if (previousRoot === undefined) delete process.env.AXIOM_AGENT_WORKSPACE_ROOT;
    else process.env.AXIOM_AGENT_WORKSPACE_ROOT = previousRoot;
    await rm(workspace, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test('artifact storage failure does not turn an already executed tool into a retryable failure', async () => {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  try {
    let executions = 0;
    const registry = new ToolRegistry({
      execute: async () => {
        executions += 1;
        return { stdout: 'side effect completed', stderr: '', exitCode: 0, durationMs: 1, auditId: 'audit-1' };
      },
    } as never, {
      kind: 'filesystem' as const,
      put: async () => { throw new Error('object store unavailable'); },
      get: async () => null,
      delete: async () => undefined,
      health: async () => ({ configured: true, reachable: false, detail: 'offline' }),
    });
    const execution = await registry.execute(task('artifact-outage'), 'step-1', { name: 'workspace.git-status', args: {} });
    assert.equal(execution.exitCode, 0);
    assert.equal(executions, 1);
    assert.match(execution.artifactError ?? '', /object store unavailable/);
    assert.equal(registry.audits('artifact-outage').at(-1)?.status, 'completed');
  } finally {
    if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
    else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
  }
});

test('tool quota and npm script allowlist reject unsafe or excessive calls', async () => {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  const previousQuota = process.env.AXIOM_TOOL_MAX_CALLS_PER_TASK;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  process.env.AXIOM_TOOL_MAX_CALLS_PER_TASK = '1';
  try {
    const calls: string[][] = [];
    const registry = new ToolRegistry({
      execute: async (request: { command: string; args?: string[] }) => {
        calls.push([request.command, ...(request.args ?? [])]);
        return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, auditId: 'fake' };
      },
    } as never);
    const current = task('quota-task');
    await registry.execute(current, 'step-1', { name: 'workspace.git-status', args: {} });
    await assert.rejects(registry.execute(current, 'step-1', { name: 'workspace.git-status', args: {} }), /quota exceeded/i);
    await assert.rejects(registry.execute({ ...current, id: 'script-task' }, 'step-1', { name: 'workspace.test', args: { script: 'test && whoami' } }), /not allowlisted/i);
    assert.equal(calls.length, 1);
  } finally {
    if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
    else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
    if (previousQuota === undefined) delete process.env.AXIOM_TOOL_MAX_CALLS_PER_TASK;
    else process.env.AXIOM_TOOL_MAX_CALLS_PER_TASK = previousQuota;
  }
});

test('read-only document and table adapters normalize workspace data', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'axiom-read-adapters-'));
  const previousRoot = process.env.AXIOM_AGENT_WORKSPACE_ROOT;
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_AGENT_WORKSPACE_ROOT = workspace;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(workspace, 'data'), { recursive: true });
    await writeFile(join(workspace, 'data', 'notes.md'), '# Notes\n\nready', 'utf8');
    await writeFile(join(workspace, 'data', 'items.csv'), 'name,score\nalpha,2\nbeta,3\n', 'utf8');
    const registry = new ToolRegistry({ execute: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, auditId: 'fake' }) } as never);
    const current = task('read-adapters');
    const document = await registry.execute(current, 'step-1', { name: 'document.read', args: { path: 'data/notes.md' } });
    assert.match(document.output, /ready/);
    const table = await registry.execute(current, 'step-1', { name: 'table.read', args: { path: 'data/items.csv', count: 1 } });
    assert.match(table.output, /alpha/);
    assert.doesNotMatch(table.output, /beta/);
    const blockedQuery = await registry.execute(current, 'step-1', { name: 'database.query', args: { query: 'DELETE FROM users' } });
    assert.equal(blockedQuery.exitCode, 1);
    assert.match(blockedQuery.stderr, /read-only|SELECT\/WITH/i);
  } finally {
    if (previousRoot === undefined) delete process.env.AXIOM_AGENT_WORKSPACE_ROOT;
    else process.env.AXIOM_AGENT_WORKSPACE_ROOT = previousRoot;
    if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
    else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('durable invocation replay survives a new registry and precedes artifact persistence', async () => {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  const ledger = new SqliteToolExecutionStore(':memory:');
  let executions = 0;
  const current = task('durable-replay');
  const executor = { execute: async () => { executions += 1; return { stdout: 'original observation', stderr: '', exitCode: 0, durationMs: 1, auditId: 'audit-one' }; } } as never;
  try {
    await ledger.initialize();
    const registry = new ToolRegistry(executor, {
      kind: 'filesystem', put: async () => {
        const records = await ledger.listForTask(current.tenantId, current.id);
        assert.equal(records[0]?.status, 'completed', 'receipt is committed before artifact storage starts');
        throw new Error('offline artifacts');
      }, get: async () => null, delete: async () => undefined, health: async () => ({ configured: true, reachable: false, detail: 'offline' }),
    }, null, null, ledger);
    const first = await registry.execute(current, 'step', { name: 'workspace.git-status', args: {} }, { invocationId: 'round-1-tool-1' });
    assert.equal(first.artifactError, 'offline artifacts');
    const restarted = new ToolRegistry(executor, null, null, null, ledger);
    const replayed = await restarted.execute(current, 'step', { name: 'workspace.git-status', args: {} }, { invocationId: 'round-1-tool-1' });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.receiptSource, 'tool');
    assert.equal(replayed.call.id, first.call.id);
    assert.equal(replayed.output, first.output);
    assert.equal(replayed.artifactError, 'offline artifacts');
    assert.equal(executions, 1);
    await restarted.execute(current, 'step', { name: 'workspace.git-status', args: {} }, { invocationId: 'round-2-tool-1' });
    assert.equal(executions, 2, 'a new logical invocation intentionally executes the same arguments');
  } finally { await ledger.close(); if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor; }
});

test('concurrent duplicate invocations have one owner and one pending observer', async () => {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  const ledger = new SqliteToolExecutionStore(':memory:');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  let running: Promise<unknown> | undefined;
  try {
    await ledger.initialize();
    const registry = new ToolRegistry({ execute: async () => { calls += 1; entered(); await gate; return { stdout: 'done', stderr: '', exitCode: 0, durationMs: 1, auditId: 'audit' }; } } as never, null, null, null, ledger);
    const invocation = { name: 'workspace.git-status', args: {} };
    running = registry.execute(task('concurrent'), 'step', invocation, { invocationId: 'one' });
    await started;
    await assert.rejects(registry.execute(task('concurrent'), 'step', invocation, { invocationId: 'one' }), (error: unknown) => error instanceof ToolExecutionPendingError && error.record.status === 'executing');
    release();
    await running;
    assert.equal(calls, 1);
  } finally { release(); await running; await ledger.close(); if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor; }
});

test('approval is bound to the logical invocation and cannot approve a later intentional repeat', async () => {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  const ledger = new SqliteToolExecutionStore(':memory:');
  let calls = 0;
  try {
    await ledger.initialize();
    const registry = new ToolRegistry(undefined, null, null, null, ledger);
    registry.upsert({ name: 'write.test', description: 'test', risk: 'high', parameters: { type: 'object', properties: {}, additionalProperties: false }, schema: z.object({}).strict(), timeoutMs: 1000,
      handler: async (_args, context) => { calls += 1; return { stdout: 'written', stderr: '', exitCode: 0, durationMs: 1, auditId: context.auditId }; } });
    const current = task('approval-identity');
    const invocation = { name: 'write.test', args: {} };
    const requested = await registry.execute(current, 'step', invocation, { invocationId: 'one' }).catch((error: unknown) => error);
    assert.ok(requested instanceof ToolApprovalRequiredError);
    const approved = { ...current, toolApprovals: [{ ...requested.approval, status: 'approved' as const }] };
    await registry.execute(approved, 'step', invocation, { invocationId: 'one' });
    const replayed = await registry.execute(approved, 'step', invocation, { invocationId: 'one' });
    assert.equal(replayed.replayed, true);
    await assert.rejects(registry.execute(approved, 'step', invocation, { invocationId: 'two' }), (error: unknown) => error instanceof ToolApprovalRequiredError && error.approval.signature !== requested.approval.signature);
    assert.equal(calls, 1);
  } finally { await ledger.close(); if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor; }
});

test('a low-risk write with an unknown result is blocked and human confirmation is not a tool receipt', async () => {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  const ledger = new SqliteToolExecutionStore(':memory:');
  let calls = 0;
  try {
    await ledger.initialize();
    const registry = new ToolRegistry(undefined, null, { createAgent: async () => { calls += 1; throw new Error('Lost connection after draft creation'); } } as unknown as AgentStore, null, ledger);
    const current = task('unknown-write');
    const invocation = { name: 'agent.propose', args: { roleId: 'writer', name: 'Writer', systemPromptTemplate: 'Write', whenToUseHint: 'Writing' } };
    const failed = await registry.execute(current, 'step', invocation, { invocationId: 'one' }).catch((error: unknown) => error);
    assert.ok(failed instanceof ToolExecutionUnknownError);
    assert.equal(failed.record.sideEffect, 'write');
    await assert.rejects(registry.execute(current, 'step', invocation, { invocationId: 'one' }), ToolExecutionUnknownError);
    assert.equal(calls, 1);
    await ledger.resolveUnknown({ tenantId: current.tenantId, id: failed.record.id, expectedRevision: failed.record.revision,
      operatorId: 'reviewer', decision: 'confirmed-completed', note: 'Draft exists; verified its destination record.' });
    const confirmed = await registry.execute(current, 'step', invocation, { invocationId: 'one' });
    assert.equal(confirmed.receiptSource, 'human-confirmed');
    assert.equal(confirmed.humanConfirmation?.operatorId, 'reviewer');
    assert.match(confirmed.output, /Human-confirmed/);
    assert.equal(calls, 1);
    assert.equal((await ledger.get(current.tenantId, failed.record.id))?.receipt, undefined);
  } finally { await ledger.close(); if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor; }
});

test('lease heartbeat loss interrupts dispatch and leaves unknown writes fenced', async () => {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  const previousLease = process.env.AXIOM_TOOL_EXECUTION_LEASE_MS;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  process.env.AXIOM_TOOL_EXECUTION_LEASE_MS = '1000';
  const ledger = new SqliteToolExecutionStore(':memory:');
  let signal: AbortSignal | undefined;
  try {
    await ledger.initialize();
    ledger.renew = async () => false;
    const registry = new ToolRegistry(undefined, null, null, null, ledger);
    registry.upsert({ name: 'slow.write', description: 'test', risk: 'low', parameters: { type: 'object', properties: {}, additionalProperties: false }, schema: z.object({}).strict(), timeoutMs: 10_000,
      handler: async (_args, context) => { signal = context.signal; return new Promise(() => undefined); } });
    await assert.rejects(registry.execute(task('lease-loss'), 'step', { name: 'slow.write' }, { invocationId: 'one' }), ToolExecutionUnknownError);
    assert.equal(signal?.aborted, true);
    assert.equal((await ledger.listForTask('tenant-a', 'lease-loss'))[0]?.status, 'outcome_unknown');
  } finally {
    await ledger.close();
    if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
    if (previousLease === undefined) delete process.env.AXIOM_TOOL_EXECUTION_LEASE_MS; else process.env.AXIOM_TOOL_EXECUTION_LEASE_MS = previousLease;
  }
});

test('ledger claim outages fail before dispatch and lost receipt persistence blocks unsafe retry', async () => {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  const ledger = new SqliteToolExecutionStore(':memory:');
  let calls = 0;
  try {
    await ledger.initialize();
    const unavailable = { claim: async () => { throw new Error('ledger offline'); } } as unknown as ToolExecutionStore;
    const blocked = new ToolRegistry({ execute: async () => { calls += 1; throw new Error('must not dispatch'); } } as never, null, null, null, unavailable);
    await assert.rejects(blocked.execute(task(), 'step', { name: 'workspace.read', args: { path: 'README.md' } }, { invocationId: 'one' }), /ledger offline/);
    assert.equal(calls, 0);
    ledger.complete = async () => { throw new Error('receipt persistence unavailable'); };
    const registry = new ToolRegistry(undefined, null, { createAgent: async () => { calls += 1; return { id: 'draft', roleId: 'writer', status: 'draft' }; } } as unknown as AgentStore, null, ledger);
    const invocation = { name: 'agent.propose', args: { roleId: 'writer', name: 'Writer', systemPromptTemplate: 'Write', whenToUseHint: 'Writing' } };
    await assert.rejects(registry.execute(task(), 'step', invocation, { invocationId: 'one' }), ToolExecutionUnknownError);
    await assert.rejects(registry.execute(task(), 'step', invocation, { invocationId: 'one' }), ToolExecutionUnknownError);
    assert.equal(calls, 1);
  } finally { await ledger.close(); if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor; }
});
