import assert from 'node:assert/strict';
import test from 'node:test';
import { listWorkflowAgentSources, waitForNexusTestRuns } from './workflowRuntime.js';

test('workflow Agent sources tolerate a partial API outage', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://axiom.test').pathname;
    if (path === '/api/agents') {
      return new Response(JSON.stringify({ agents: [
        { id: 'planner', role: 'planner', label: '规划器', kind: 'orchestrator', capabilities: [], description: '' },
        { id: 'analyst', role: 'analyst', label: '分析员', kind: 'worker', capabilities: [], description: '' },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/agents/custom') {
      return new Response('temporarily unavailable', { status: 503 });
    }
    return new Response(JSON.stringify({ tools: [{ name: 'workspace.read', description: '读取文件' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const sources = await listWorkflowAgentSources();
    assert.deepEqual(sources.builtin.map((agent) => agent.id), ['analyst']);
    assert.deepEqual(sources.platform, []);
    assert.deepEqual(sources.tools.map((tool) => tool.name), ['workspace.read']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('workflow Agent sources fail closed when every source is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  try {
    assert.deepEqual(await listWorkflowAgentSources(), { builtin: [], platform: [], tools: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Nexus test polling waits for every requested run to reach a real terminal state', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const status = calls === 1 ? 'running' : 'passed';
    return new Response(JSON.stringify({ runs: [
      { id: 'run-a', status, revision: calls, data: { taskId: 'task-a' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'old-run', status: 'failed', revision: 1, data: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const updates: string[][] = [];
  try {
    const runs = await waitForNexusTestRuns('workflow-a', ['run-a'], { pollMs: 0, timeoutMs: 2_000, onUpdate: (items) => updates.push(items.map((item) => item.status)) });
    assert.equal(calls, 2);
    assert.deepEqual(updates, [['running'], ['passed']]);
    assert.deepEqual(runs.map((run) => run.id), ['run-a']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
