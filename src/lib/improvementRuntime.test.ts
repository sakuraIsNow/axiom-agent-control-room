import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createImprovement, getImprovement, ImprovementApiError, listImprovements, listImprovementSources,
  prepareImprovementTrial, updateImprovement,
} from './improvementRuntime';

test('improvement reads use their own endpoints and preserve the abort signal', async (context) => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const controller = new AbortController();
  context.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    const data = url.endsWith('/sources') ? { tasks: [{ id: 'task-1' }] }
      : url === '/api/improvements' ? { proposals: [{ id: 'proposal-1' }] } : { proposal: { id: 'proposal/1' } };
    return Response.json(data);
  });
  assert.deepEqual(await listImprovementSources(controller.signal), [{ id: 'task-1' }]);
  assert.deepEqual(await listImprovements(controller.signal), [{ id: 'proposal-1' }]);
  assert.deepEqual(await getImprovement('proposal/1', controller.signal), { id: 'proposal/1' });
  assert.deepEqual(calls.map((call) => call.url), ['/api/improvements/sources', '/api/improvements', '/api/improvements/proposal%2F1']);
  assert.ok(calls.every((call) => call.options?.signal === controller.signal));
  assert.ok(calls.every((call) => call.options?.method === undefined));
});

test('improvement mutations carry explicit idempotency and optimistic revision, never create a task', async (context) => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  context.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/prepare') ? {
      input: 'Review this unsent instruction.', mode: 'analyze', sourceTaskId: 'task-1', proposalId: 'proposal-1', warnings: [],
    } : { proposal: { id: 'proposal-1', revision: 2, status: 'accepted' } });
  });
  const input = { taskId: 'task-1', note: 'Improve verification.', parentId: 'prior-1', language: 'en' as const, idempotencyKey: 'stable-attempt-1' };
  await createImprovement(input);
  await updateImprovement('proposal-1', 1, 'accepted');
  const draft = await prepareImprovementTrial('proposal-1', 2);
  assert.deepEqual(JSON.parse(calls[0].options?.body as string), input);
  assert.deepEqual(JSON.parse(calls[1].options?.body as string), { revision: 1, status: 'accepted' });
  assert.deepEqual(JSON.parse(calls[2].options?.body as string), { revision: 2 });
  assert.deepEqual(calls.map((call) => call.options?.method), ['POST', 'PATCH', 'POST']);
  assert.ok(calls.every((call) => call.url.startsWith('/api/improvements')));
  assert.ok(calls.every((call) => new Headers(call.options?.headers).get('Content-Type') === 'application/json'));
  assert.equal(draft.input, 'Review this unsent instruction.');
});

test('improvement conflicts remain distinguishable from missing access and invalid responses', async (context) => {
  const responses = [Response.json({ error: 'Revision changed.' }, { status: 409 }), Response.json({ error: 'Not found.' }, { status: 404 }), new Response('<html>Unavailable</html>', { status: 503 })];
  context.mock.method(globalThis, 'fetch', async () => responses.shift()!);
  await assert.rejects(updateImprovement('proposal-1', 1, 'accepted'), (error: unknown) => error instanceof ImprovementApiError && error.status === 409);
  await assert.rejects(getImprovement('proposal-1'), (error: unknown) => error instanceof ImprovementApiError && error.status === 404);
  await assert.rejects(listImprovements(), (error: unknown) => error instanceof ImprovementApiError && error.status === 503 && error.message === 'HTTP 503');
});

test('invalid successful envelopes are reported before they can corrupt UI state', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({}));
  for (const operation of [listImprovementSources, listImprovements, () => getImprovement('p1'), () => prepareImprovementTrial('p1', 1)]) {
    await assert.rejects(operation(), (error: unknown) => error instanceof ImprovementApiError && error.status === 502);
  }
});
