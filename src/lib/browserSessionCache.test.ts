import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCacheWriter, safelyStorePreference } from './browserSessionCache';
import type { Session } from '../types';

const session = (content: string): Session[] => [{ id: 's', title: 'history', updatedAt: 1, messages: [{ id: 'm', role: 'assistant', content, createdAt: 1 }] }];

test('one streaming burst persists its latest snapshot instead of every delta', async () => {
  const writes: Session[][] = [];
  const writer = createSessionCacheWriter(async (snapshot) => { writes.push(snapshot); }, 10);
  for (let index = 0; index < 100; index += 1) writer.schedule(session(String(index)));
  await writer.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.[0]?.messages[0]?.content, '99');
  writer.dispose();
});

test('quota failures are contained and newer snapshots can retry', async () => {
  let fail = true;
  const writes: string[] = [];
  const writer = createSessionCacheWriter(async (snapshot) => {
    if (fail) throw new Error('QuotaExceededError');
    writes.push(snapshot[0]!.messages[0]!.content);
  }, 10);
  writer.schedule(session('first'));
  assert.equal(await writer.flush(), false);
  fail = false;
  writer.schedule(session('latest'));
  assert.equal(await writer.flush(), true);
  assert.deepEqual(writes, ['latest']);
  writer.dispose();
});

test('an older in-flight snapshot cannot overwrite the latest persisted state', async () => {
  const writes: string[] = [];
  let release: (() => void) | undefined;
  const writer = createSessionCacheWriter(async (snapshot) => {
    if (snapshot[0]!.messages[0]!.content === 'first') await new Promise<void>((resolve) => { release = resolve; });
    writes.push(snapshot[0]!.messages[0]!.content);
  }, 1000);
  writer.schedule(session('first'));
  const first = writer.flush();
  writer.schedule(session('latest'));
  const second = writer.flush();
  release!();
  await Promise.all([first, second]);
  assert.deepEqual(writes, ['first', 'latest']);
  writer.dispose();
});

test('blocked preference storage does not escape into React effects', () => {
  assert.equal(safelyStorePreference({ setItem: () => { throw new Error('SecurityError'); } }, 'key', 'value'), false);
});

test('updates arriving during a slow cache write wait for the next throttle interval', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const writes: string[] = [];
  let release: (() => void) | undefined;
  const writer = createSessionCacheWriter(async (snapshot) => {
    const content = snapshot[0]!.messages[0]!.content;
    writes.push(content);
    if (content === 'first') await new Promise<void>((resolve) => { release = resolve; });
  }, 1000);
  writer.schedule(session('first'));
  context.mock.timers.tick(1000);
  for (let index = 0; index < 100; index += 1) writer.schedule(session(String(index)));
  release!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ['first']);
  context.mock.timers.tick(999);
  assert.deepEqual(writes, ['first']);
  context.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ['first', '99']);
  writer.dispose();
});
