import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { ProviderBindingStore } from './providerBindings.js';
import { createBoundTextModel } from './boundProviderModel.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';

test('two tenant users execute real HTTP model requests only through their own immutable provider and token', async () => {
  const previous = process.env.AXIOM_PROVIDER_SECRET;
  process.env.AXIOM_PROVIDER_SECRET = 'two-http-providers-test-encryption';
  const seen: Array<{ provider: string; authorization?: string; model: string; prompt: string }> = [];
  const fake = async (name: string) => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ provider: name, authorization: request.headers.authorization, model: body.model, prompt: body.messages.at(-1).content });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `Result from ${name}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    return { url: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())) };
  };
  const first = await fake('one'); const second = await fake('two');
  const bindings = new ProviderBindingStore(); const tasks = new SqliteTaskStore(':memory:');
  try {
    await bindings.initialize(); await tasks.initialize();
    const owners = [{ tenantId: 'same-tenant', userId: 'alice' }, { tenantId: 'same-tenant', userId: 'bob' }];
    const taskList = [];
    for (let index = 0; index < 2; index += 1) {
      const reference = await bindings.create(owners[index], { text: { apiKey: index === 0 ? 'alice-token' : '', baseUrl: index === 0 ? first.url : second.url, model: `model-${index}`, location: 'local' }, vision: null, image: null, video: null, search: null });
      taskList.push(await tasks.createTask({ ...owners[index], ...reference, sessionId: `session-${index}`, title: 'HTTP provider test', input: `private-user-${index}`, mode: 'analyze' }));
    }
    for (const task of taskList) {
      const restored = (await tasks.getTask(task.id, task.tenantId))!;
      const model = await createBoundTextModel(bindings, restored);
      const result = await model.complete({ system: 'Return this provider label', user: restored.input, signal: AbortSignal.timeout(5_000) });
      assert.equal(result.finishReason, 'stop'); assert.equal(result.usage?.total_tokens, 11);
    }
    assert.deepEqual(seen, [
      { provider: 'one', authorization: 'Bearer alice-token', model: 'model-0', prompt: 'private-user-0' },
      { provider: 'two', authorization: undefined, model: 'model-1', prompt: 'private-user-1' },
    ]);
    await assert.rejects(createBoundTextModel(bindings, { ...taskList[0], userId: 'bob' }), /not owned/);
    assert.equal(seen.length, 2, 'Wrong-owner recovery must fail before making any provider request');
  } finally {
    await bindings.close(); await tasks.close(); await first.close(); await second.close();
    if (previous === undefined) delete process.env.AXIOM_PROVIDER_SECRET; else process.env.AXIOM_PROVIDER_SECRET = previous;
  }
});
