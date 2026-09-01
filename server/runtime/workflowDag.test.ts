import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWorkflowDag, workflowDagIssueText } from './workflowDag.js';

test('workflow DAG computes deterministic parallel waves', () => {
  const result = analyzeWorkflowDag([
    { id: 'build', dependsOn: ['research', 'analysis'] },
    { id: 'research', dependsOn: [] },
    { id: 'analysis', dependsOn: [] },
    { id: 'review', dependsOn: ['build'] },
  ]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.waves, [['analysis', 'research'], ['build'], ['review']]);
});

test('workflow DAG rejects invalid dependency graphs', () => {
  const result = analyzeWorkflowDag([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'a', dependsOn: [] },
    { id: 'c', dependsOn: ['missing'] },
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'duplicate-step'));
  assert.ok(result.issues.some((issue) => issue.code === 'unknown-dependency'));
  assert.ok(result.issues.some((issue) => issue.code === 'cycle'));
  assert.match(workflowDagIssueText({ code: 'cycle' }), /循环依赖/);
});
