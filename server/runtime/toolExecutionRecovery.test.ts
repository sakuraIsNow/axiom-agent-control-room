import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { registerPersistedExternalTools } from './businessCapabilities.js';
import { SqliteBusinessCapabilityStore } from './businessCapabilityStore.js';
import { SqliteToolExecutionStore } from './toolExecutionStore.js';
import { ToolApprovalRequiredError, ToolExecutionUnknownError, ToolRegistry } from './toolRegistry.js';
import type { WorkflowTask } from './contracts.js';

const currentTask = (): WorkflowTask => ({ id: 'task', runId: 'run', revision: 1, tenantId: 'tenant', userId: 'owner', sessionId: 'session',
  title: 'Recovery test', input: 'Test an external tool', mode: 'build', status: 'running', stepResults: [], cancelRequested: false,
  policy: { requirePlanApproval: false }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

const harness = async (risk: 'low' | 'high', readOnly = false) => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string };
    if (message.method === 'tools/call') calls += 1;
    response.setHeader('content-type', 'application/json');
    if (calls === 1) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { message: 'Transport failed after accepting the request.' } }));
    } else response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'destination verified' }] } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const records = new SqliteBusinessCapabilityStore(':memory:');
  const ledger = new SqliteToolExecutionStore(':memory:');
  await records.initialize();
  await ledger.initialize();
  const source = await records.create({ tenantId: 'tenant', userId: 'owner', ownerId: 'owner', kind: 'tool-source', status: 'enabled', data: {
    protocol: 'mcp', name: 'Local Fake MCP', location: 'local', endpoint: `http://127.0.0.1:${address.port}`, healthStatus: 'healthy', authorizationStatus: 'not-required',
    specification: { tools: [{ name: 'test_operation', risk, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}) }] },
    operations: [{ operationId: 'test_operation', method: 'mcp', path: 'test_operation', risk, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  } });
  const registry = new ToolRegistry(undefined, null, null, null, ledger);
  await registerPersistedExternalTools(records, registry);
  const tool = registry.catalog().find((item) => item.routing?.sourceId === source.id);
  assert.ok(tool);
  return { records, ledger, registry, sourceId: source.id, invocation: { name: tool.name, args: {} }, calls: () => calls,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await records.close(); await ledger.close(); } };
};

test('one human review resolves both ledgers and survives failure between phases without redispatch', async () => {
  const previous = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  const fixture = await harness('high');
  try {
    const original = currentTask();
    const approval = await fixture.registry.execute(original, 'step', fixture.invocation, { invocationId: 'logical-one' }).catch((error: unknown) => error);
    assert.ok(approval instanceof ToolApprovalRequiredError);
    const task = { ...original, toolApprovals: [{ ...approval.approval, status: 'approved' as const }] };
    const failed = await fixture.registry.execute(task, 'step', fixture.invocation, { invocationId: 'logical-one' }).catch((error: unknown) => error);
    assert.ok(failed instanceof ToolExecutionUnknownError);
    assert.equal(fixture.calls(), 1);
    const initialRecords = await fixture.records.list('tenant', 'task-action');
    assert.equal(initialRecords.length, 1);
    assert.equal(initialRecords[0]?.status, 'outcome_unknown');
    const resolution = { tenantId: 'tenant', id: failed.record.id, expectedRevision: failed.record.revision,
      operatorId: 'reviewer', decision: 'confirmed-not-executed' as const, note: 'The destination audit confirms this request was not executed.' };
    const resolveLedger = fixture.ledger.resolveUnknown.bind(fixture.ledger);
    let interrupt = true;
    fixture.ledger.resolveUnknown = async (input) => { if (interrupt) { interrupt = false; throw new Error('Second phase temporarily unavailable'); } return resolveLedger(input); };
    await assert.rejects(fixture.registry.resolveExecutionUnknown(resolution), /acknowledgement could not be confirmed/);
    assert.equal((await fixture.ledger.get('tenant', failed.record.id))?.status, 'outcome_unknown');
    assert.equal((await fixture.records.get(initialRecords[0]!.id, 'tenant'))?.status, 'verified_not_executed');
    await assert.rejects(fixture.registry.execute(task, 'step', fixture.invocation, { invocationId: 'logical-one' }), ToolExecutionUnknownError);
    assert.equal(fixture.calls(), 1, 'a partially completed review cannot authorize redispatch');
    await assert.rejects(fixture.registry.resolveExecutionUnknown({ ...resolution, decision: 'confirmed-completed' }), /different decision/);
    const resolved = await fixture.registry.resolveExecutionUnknown(resolution);
    assert.equal(resolved?.status, 'retryable');
    const reviewed = (await fixture.records.get(initialRecords[0]!.id, 'tenant'))!;
    assert.equal((reviewed.data.outcomeResolutions as unknown[]).length, 1, 'retrying a partial review does not duplicate its audit');
    const executed = await fixture.registry.execute(task, 'step', fixture.invocation, { invocationId: 'logical-one' });
    assert.equal(executed.exitCode, 0);
    assert.equal(fixture.calls(), 2);
    const completed = await fixture.records.list('tenant', 'task-action');
    assert.equal(completed.length, 2, 'the uncertain attempt is retained, not deleted');
    assert.deepEqual(completed.map((record) => record.status).sort(), ['completed', 'verified_not_executed']);
    assert.ok(completed.every((record) => record.data.approvalId === approval.approval.id), 'the approved logical invocation is retained');
    const replay = await fixture.registry.execute(task, 'step', fixture.invocation, { invocationId: 'logical-one' });
    assert.equal(replay.replayed, true);
    assert.equal(fixture.calls(), 2);
  } finally { await fixture.close(); if (previous === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previous; }
});

test('MCP low risk alone never permits automatic retry; explicit readonly metadata does', async () => {
  const previous = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  try {
    const unannotated = await harness('low');
    try {
      const failure = await unannotated.registry.execute(currentTask(), 'step', unannotated.invocation, { invocationId: 'one' }).catch((error: unknown) => error);
      assert.ok(failure instanceof ToolExecutionUnknownError);
      assert.equal(unannotated.calls(), 1);
      await unannotated.registry.resolveExecutionUnknown({ tenantId: 'tenant', id: failure.record.id, expectedRevision: failure.record.revision,
        operatorId: 'reviewer', decision: 'confirmed-not-executed', note: 'The local service confirms no write was applied.' });
      assert.equal((await unannotated.registry.execute(currentTask(), 'step', unannotated.invocation, { invocationId: 'one' })).exitCode, 0);
      assert.equal(unannotated.calls(), 2, 'unapproved low-risk tools are correlated by durable execution ID');
    } finally { await unannotated.close(); }
    const readOnly = await harness('low', true);
    try {
      const result = await readOnly.registry.execute(currentTask(), 'step', readOnly.invocation, { invocationId: 'one' });
      assert.equal(result.exitCode, 0);
      assert.equal(readOnly.calls(), 2);
      assert.equal((await readOnly.ledger.listForTask('tenant', 'task'))[0]?.sideEffect, 'read-only');
    } finally { await readOnly.close(); }
  } finally { if (previous === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previous; }
});

test('a tool definition changed between registry claim and dispatch cannot reuse its old readonly classification', async () => {
  const previous = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  const fixture = await harness('low', true);
  try {
    const claim = fixture.ledger.claim.bind(fixture.ledger);
    fixture.ledger.claim = async (input) => {
      const result = await claim(input);
      const source = (await fixture.records.get(fixture.sourceId, 'tenant'))!;
      await fixture.records.update(source.id, 'tenant', { data: { ...source.data, pinnedDigest: 'changed-definition',
        specification: { tools: [{ name: 'test_operation', risk: 'low' }] } } }, source.revision);
      return result;
    };
    const result = await fixture.registry.execute(currentTask(), 'step', fixture.invocation, { invocationId: 'one' });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /definition changed/);
    assert.equal(fixture.calls(), 0);
  } finally { await fixture.close(); if (previous === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previous; }
});
