import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeSseBlocks } from './sse';

test('consumes LF and CRLF SSE blocks while preserving incomplete data', () => {
  const blocks: string[] = [];
  let remainder = consumeSseBlocks('event: one\r\ndata: {"ok":1}\r\n\r\nevent: two\ndata: {"ok":2}\n\npartial', (block) => blocks.push(block));
  assert.deepEqual(blocks, ['event: one\r\ndata: {"ok":1}', 'event: two\ndata: {"ok":2}']);
  assert.equal(remainder, 'partial');
  remainder = consumeSseBlocks(`${remainder}\n\ndata: {"ok":3}`, (block) => blocks.push(block));
  assert.deepEqual(blocks.at(-1), 'partial');
  assert.equal(remainder, 'data: {"ok":3}');
});
