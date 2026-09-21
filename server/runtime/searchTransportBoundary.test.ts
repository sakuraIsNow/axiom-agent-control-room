import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowTask } from './contracts.js';
import { executeWorkflowSpecialist } from './workflowSpecialists.js';

const task: WorkflowTask = { id: 'search-transport-fixture', runId: 'run', revision: 1, tenantId: 'fixture', userId: 'fixture', sessionId: 'fixture',
  title: 'Search transport boundary', input: 'Find the requested material.', mode: 'analyze', status: 'running', stepResults: [],
  cancelRequested: false, policy: { requirePlanApproval: false }, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' };
const provider = { apiKey: 'fixture-search-key-not-a-secret', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' };

for (const agent of ['search-agent', 'academic-search-agent', 'github-research-agent'] as const) {
  test(`${agent} sends only a native Responses request with search tools and preserves source names`, async () => {
    const originalFetch = globalThis.fetch;
    const previousEnabled = process.env.DEEPSEEK_NATIVE_SEARCH;
    process.env.DEEPSEEK_NATIVE_SEARCH = 'true';
    const destinations: string[] = [];
    const answer = 'Retrieved source: https://open-meteo.com/; the page mentions Bing and DuckDuckGo.';
    globalThis.fetch = async (input, init) => {
      const destination = String(input);
      destinations.push(destination);
      assert.equal(destination, 'https://api.deepseek.com/responses');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${provider.apiKey}`);
      const body = JSON.parse(String(init?.body)) as { model: string; tools: unknown[]; tool_choice: unknown; stream: boolean };
      assert.equal(body.model, provider.model);
      assert.deepEqual(body.tools, [{ type: 'web_search' }]);
      assert.deepEqual(body.tool_choice, { type: 'web_search' });
      assert.equal(body.stream, true);
      return new Response(`event: response.web_search_call.completed\ndata: {}\n\nevent: response.output_text.delta\ndata: ${JSON.stringify({ delta: answer })}\n\nevent: response.completed\ndata: {"response":{"usage":{"total_tokens":12}}}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const result = await executeWorkflowSpecialist(agent, task.input, new AbortController().signal, [], undefined, {
        task, providerResolver: async (_owner, kind) => { assert.equal(kind, 'search'); return provider; },
      });
      assert.equal(result.output, answer);
      assert.equal(result.completionStatus, 'complete');
      assert.deepEqual(destinations, ['https://api.deepseek.com/responses']);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousEnabled === undefined) delete process.env.DEEPSEEK_NATIVE_SEARCH; else process.env.DEEPSEEK_NATIVE_SEARCH = previousEnabled;
    }
  });
}

for (const status of [401, 503]) test(`native search HTTP ${status} cannot trigger an alternate-provider fallback`, async () => {
  const originalFetch = globalThis.fetch;
  const previousEnabled = process.env.DEEPSEEK_NATIVE_SEARCH;
  process.env.DEEPSEEK_NATIVE_SEARCH = 'true';
  const destinations: string[] = [];
  globalThis.fetch = async (input) => {
    destinations.push(String(input));
    assert.equal(String(input), 'https://api.deepseek.com/responses');
    return new Response('{"error":{"message":"Injected fixture failure"}}', { status, headers: { 'content-type': 'application/json' } });
  };
  try {
    await assert.rejects(executeWorkflowSpecialist('search-agent', task.input, new AbortController().signal, [], undefined,
      { task, providerResolver: async () => provider }), new RegExp(String(status)));
    assert.deepEqual(destinations, ['https://api.deepseek.com/responses']);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEnabled === undefined) delete process.env.DEEPSEEK_NATIVE_SEARCH; else process.env.DEEPSEEK_NATIVE_SEARCH = previousEnabled;
  }
});
