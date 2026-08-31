import assert from 'node:assert/strict';
import test from 'node:test';
import { listWorkflowAgentSources } from './workflowRuntime.js';

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
