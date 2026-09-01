import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeSourceFromPayload } from './runtimeContext.js';

test('normalizes every supported runtime entrypoint to a stable source', () => {
  const cases: Array<[unknown, string]> = [
    ['external-harness', 'harness'],
    ['external-harness-recovery', 'harness'],
    ['external-harness-resume', 'harness'],
    ['agent-workflow', 'agent-nexus'],
    ['agent-nexus', 'agent-nexus'],
    ['plugin', 'plugin'],
    ['schedule', 'schedule'],
    ['webhook', 'webhook'],
    ['conversation', 'conversation'],
    ['builtin', 'builtin'],
    ['unknown-entrypoint', 'api'],
    [undefined, 'api'],
  ];
  for (const [input, expected] of cases) assert.equal(runtimeSourceFromPayload(input), expected);
});
