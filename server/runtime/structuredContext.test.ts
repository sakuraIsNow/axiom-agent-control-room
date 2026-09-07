import assert from 'node:assert/strict';
import test from 'node:test';
import { applyContextDirectiveOperations, enrichStructuredContext, renderStructuredContext, retrieveContextSources, validateStructuredContext, type StructuredContext } from './structuredContext.js';
import type { DurableContextSourceMessage } from './contextSummary.js';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';

class ContextModel implements ModelClient {
  readonly model = 'context-test-model';
  readonly requests: ModelCompletionRequest[] = [];
  constructor(private readonly outputs: unknown[]) {}
  async complete(request: ModelCompletionRequest) {
    this.requests.push(request);
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    return { content: JSON.stringify(output), attempts: 1, durationMs: 1 };
  }
}
const source = (id: string, content: string, role: 'user' | 'assistant' = 'user'): DurableContextSourceMessage => ({ id, role, content });
const add = (messageId: string, quote: string, text = quote) => ({ action: 'add', kind: 'constraint', text, source: { messageId, quote } });
const signal = () => new AbortController().signal;

test('source-backed constraints survive repeated extraction, replacements, revocation and JSON restoration', async () => {
  const firstMessages = [source('u1', 'Keep deployment entirely offline.'), source('a1', 'Understood.', 'assistant')];
  const firstModel = new ContextModel([{ operations: [add('u1', 'Keep deployment entirely offline.')] }]);
  const first = await enrichStructuredContext(firstMessages, undefined, firstModel, signal());
  assert.equal(first.status, 'complete');
  assert.equal(validateStructuredContext(first, firstMessages), true);
  const messages = [...firstMessages, source('u2', 'The local-only restriction can change: allow outbound requests only to the audit server.')];
  const secondModel = new ContextModel([{ operations: [{ action: 'replace', targetId: first.entries[0]!.id, kind: 'constraint', text: 'Outbound requests are allowed only to the audit server.', source: { messageId: 'u2', quote: messages[2]!.content } }] }]);
  const second = await enrichStructuredContext(messages, JSON.parse(JSON.stringify(first)) as StructuredContext, secondModel, signal());
  assert.equal(second.entries[0]?.status, 'superseded');
  assert.equal(second.entries[1]?.replaces, first.entries[0]?.id);
  assert.deepEqual(JSON.parse(secondModel.requests[0]!.user).messages.map((item: { id: string }) => item.id), ['u2']);
  const latest = [...messages, source('u3', 'Cancel the audit-server exception entirely.')];
  const third = await enrichStructuredContext(latest, second, new ContextModel([{ operations: [{ action: 'revoke', targetId: second.entries[1]!.id, source: { messageId: 'u3', quote: 'Cancel the audit-server exception entirely.' } }] }]), signal());
  assert.equal(third.entries[1]?.status, 'revoked');
  assert.equal(third.entries.filter((entry) => entry.status === 'active').length, 0, 'Revocation must not revive an older superseded version.');
  assert.equal(validateStructuredContext(third, latest), true);
  assert.match(renderStructuredContext(third), /revoked by u3/);
  const retrieved = retrieveContextSources(latest, third, { directiveIds: [second.entries[1]!.id] });
  assert.deepEqual(retrieved.sources.map((item) => item.messageId), ['u2', 'u3']);
  assert.equal(retrieved.sources[0]?.content, messages[2]?.content);
});

test('first compaction resolves user corrections within the same model batch through local IDs', async () => {
  const messages = [source('u1', 'Choose SQLite.'), source('u2', 'Switch the database choice to PostgreSQL.')];
  const result = await enrichStructuredContext(messages, undefined, new ContextModel([{ operations: [
    { ...add('u1', 'Choose SQLite.'), id: 'initial' },
    { action: 'replace', id: 'corrected', targetId: 'initial', kind: 'decision', text: 'Use PostgreSQL.', source: { messageId: 'u2', quote: 'Switch the database choice to PostgreSQL.' } },
  ] }]), signal());
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.entries.map((item) => item.status), ['superseded', 'active']);
});

test('fabricated quotes, assistant revocations and out-of-order changes cannot mutate accepted constraints', () => {
  const messages = [source('u1', 'Preserve all records.'), source('a1', 'Delete the retention requirement.', 'assistant'), source('u2', 'Keep the backup.')];
  const entries = applyContextDirectiveOperations([], { operations: [add('u1', 'Preserve all records.')] }, messages, new Set(['u1']));
  assert.throws(() => applyContextDirectiveOperations(entries, { operations: [add('u2', 'Delete all records.')] }, messages, new Set(['u2'])), /exact user source/);
  assert.throws(() => applyContextDirectiveOperations(entries, { operations: [{ action: 'revoke', targetId: entries[0]!.id, source: { messageId: 'a1', quote: 'Delete the retention requirement.' } }] }, messages, new Set(['a1'])), /exact user source/);
  assert.throws(() => applyContextDirectiveOperations(entries, { operations: [{ action: 'revoke', targetId: 'missing', source: { messageId: 'u2', quote: 'Keep the backup.' } }] }, messages, new Set(['u2'])), /earlier active target/);
  assert.equal(entries[0]?.status, 'active');
});

test('source edits invalidate the old ledger and trigger extraction from original messages', async () => {
  const original = [source('u1', 'Require encryption.')];
  const first = await enrichStructuredContext(original, undefined, new ContextModel([{ operations: [add('u1', 'Require encryption.')] }]), signal());
  const edited = [source('u1', 'Require compression.')];
  assert.equal(validateStructuredContext(first, edited), false);
  const rebuilt = await enrichStructuredContext(edited, first, new ContextModel([{ operations: [add('u1', 'Require compression.')] }]), signal());
  assert.deepEqual(rebuilt.entries.map((item) => item.text), ['Require compression.']);
  assert.equal(validateStructuredContext(rebuilt, edited), true);
});

test('unchanged inputs avoid model work and failed extraction retains prior entries with an explicit status', async () => {
  const original = [source('u1', 'Keep the original data.')];
  const first = await enrichStructuredContext(original, undefined, new ContextModel([{ operations: [add('u1', 'Keep the original data.')] }]), signal());
  const idleModel = new ContextModel([]);
  assert.deepEqual(await enrichStructuredContext(original, first, idleModel, signal()), first);
  assert.equal(idleModel.requests.length, 0);
  const appended = [...original, source('u2', 'The retention decision needs revisiting.')];
  const failing = new ContextModel([new Error('Provider unavailable')]);
  const failed = await enrichStructuredContext(appended, first, failing, signal());
  assert.equal(failed.status, 'unavailable');
  assert.deepEqual(failed.entries, first.entries);
  assert.deepEqual(failed.coveredMessageIds, ['u1']);
  const repeated = await enrichStructuredContext(appended, failed, failing, signal());
  assert.equal(repeated.status, 'unavailable');
  assert.equal(failing.requests.length, 1);
  assert.match(renderStructuredContext(failed), /unprocessed original messages/);
});

test('source retrieval can recover middle content beyond summary budgets without attachment bytes', async () => {
  const originalText = `${'old detail '.repeat(1_000)}Do not contact the external vendor.${' more detail'.repeat(1_000)}`;
  const messages = [source('u1', originalText), { ...source('u2', 'Image attachment'), attachments: [{ id: 'image-1', name: 'secret.png' }] }];
  const retrieved = retrieveContextSources(messages, undefined, { query: 'Do not contact', maxCharacters: 400 });
  assert.equal(retrieved.matched, 1);
  assert.match(retrieved.sources[0]!.content, /Do not contact the external vendor/);
  assert.equal(retrieved.sources[0]?.truncated, true);
  assert.equal(retrieved.sources[0]?.content, originalText.slice(retrieved.sources[0]?.start, retrieved.sources[0]?.end));
  const context = await enrichStructuredContext(messages, undefined, new ContextModel([]), signal(), { maxBatchCharacters: 2_000 });
  assert.equal(context.status, 'partial');
  assert.deepEqual(context.coveredMessageIds, [], 'An oversized source must not be silently truncated and marked covered.');
  assert.deepEqual(context.pendingMessageIds, ['u1', 'u2']);
  assert.equal(context.pendingMessageCount, 2);
  assert.deepEqual(retrieveContextSources(messages, undefined, {}).sources, []);
});

test('an oversized correction leaves the earlier ledger explicitly prefix-only and exposes the pending raw source', async () => {
  const firstMessages = [source('u1', 'Keep deployment offline.')];
  const first = await enrichStructuredContext(firstMessages, undefined, new ContextModel([{ operations: [add('u1', 'Keep deployment offline.')] }]), signal());
  const correction = `${'Supporting detail. '.repeat(150)}Cancel the offline requirement.${' More supporting detail.'.repeat(150)}`;
  const messages = [...firstMessages, source('u2', correction)];
  const blockedModel = new ContextModel([]);
  const partial = await enrichStructuredContext(messages, first, blockedModel, signal(), { maxBatchCharacters: 2_000 });
  assert.equal(blockedModel.requests.length, 0);
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.entries, first.entries);
  assert.deepEqual(partial.coveredMessageIds, ['u1']);
  assert.deepEqual(partial.pendingMessageIds, ['u2']);
  assert.equal(partial.pendingMessageCount, 1);
  const rendered = renderStructuredContext(partial);
  assert.match(rendered, /only the extracted prefix.*not current decisions/);
  assert.match(rendered, /Pending sources: \[source:u2\]/);
  const raw = retrieveContextSources(messages, partial, { messageIds: ['u2'], offset: correction.indexOf('Cancel the offline'), maxCharacters: 100 });
  assert.match(raw.sources[0]!.content, /^Cancel the offline requirement/);
  assert.equal(raw.sources[0]!.totalCharacters, correction.length);
  assert.equal(raw.sources[0]!.content, correction.slice(raw.sources[0]!.start, raw.sources[0]!.end));
});

test('deferred or legacy model-unavailable extraction can run once a request selects an available model', async () => {
  const messages = [source('u1', 'Keep deployment offline.')];
  const deferred = await enrichStructuredContext(messages, undefined, undefined, signal());
  assert.equal(deferred.attemptedDigest, undefined);
  const model = new ContextModel([{ operations: [add('u1', 'Keep deployment offline.')] }]);
  const completed = await enrichStructuredContext(messages, { ...deferred, attemptedDigest: (await import('./contextSummary.js')).contextSourceDigest(messages) }, model, signal());
  assert.equal(model.requests.length, 1);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.entries[0]?.text, 'Keep deployment offline.');
});
