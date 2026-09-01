import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNonConflictingSteps } from './workflowConcurrency.js';

const step = (id: string, role = 'builder', writeScopes?: string[]) => ({
  id,
  title: id,
  role,
  objective: id,
  dependsOn: [],
  acceptanceCriteria: ['done'],
  ...(writeScopes ? { writeScopes } : {}),
});

test('write scope scheduler keeps independent writers parallel and splits overlaps', () => {
  const selected = selectNonConflictingSteps([
    step('a', 'builder', ['src/a']),
    step('b', 'builder', ['src/b']),
    step('c', 'builder', ['src/a/index.ts']),
  ], 3);
  assert.deepEqual(selected.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(selectNonConflictingSteps([
    step('a', 'builder'),
    step('b', 'builder', ['src/b']),
  ], 3).map((item) => item.id), ['a']);
});

test('read-only Agents are not serialized by write scopes', () => {
  const selected = selectNonConflictingSteps([
    step('research-a', 'researcher'),
    step('research-b', 'researcher'),
    step('build', 'builder', ['src']),
  ], 3);
  assert.deepEqual(selected.map((item) => item.id), ['research-a', 'research-b', 'build']);
});
