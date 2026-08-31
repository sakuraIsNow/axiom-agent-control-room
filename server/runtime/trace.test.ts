import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTraceContext } from './trace.js';

test('continues a valid W3C trace and rotates the server span', () => {
  const context = resolveTraceContext(new Headers({ traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-00' }));
  assert.equal(context.traceId, '0123456789abcdef0123456789abcdef');
  assert.match(context.spanId, /^[\da-f]{16}$/);
  assert.equal(context.traceparent, `00-${context.traceId}-${context.spanId}-00`);
});

test('starts a safe sampled trace when the incoming header is malformed', () => {
  const context = resolveTraceContext(new Headers({ traceparent: 'not-a-trace' }));
  assert.match(context.traceId, /^[\da-f]{32}$/);
  assert.match(context.spanId, /^[\da-f]{16}$/);
  assert.equal(context.traceparent, `00-${context.traceId}-${context.spanId}-01`);
});

