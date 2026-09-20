import assert from 'node:assert/strict';
import test from 'node:test';
import type { StepResult } from './contracts.js';
import { appendGeneratedArtifactLinks } from './generatedArtifactDelivery.js';

test('generated downloads survive synthesis omissions without trusting arbitrary model artifacts', () => {
  const result: Pick<StepResult, 'stepId' | 'toolCalls' | 'artifacts'> = {
    stepId: 'draw', toolCalls: [{ id: 'call-1', name: 'artifact.create' }],
    artifacts: [{ id: 'tool:task-1:draw:call-1:artifact', kind: 'tool-output', name: '动画.html', createdAt: new Date().toISOString() }],
  };
  const delivered = appendGeneratedArtifactLinks('已生成动画。', 'task-1', [result]);
  assert.match(delivered, /\[动画\.html\]\(\/api\/tasks\/task-1\/artifacts\/files\/tool%3Atask-1%3Adraw%3Acall-1%3Aartifact\)/);
  assert.equal(appendGeneratedArtifactLinks(delivered, 'task-1', [result, result]), delivered);
  const rawUrl = '/api/tasks/task-1/artifacts/files/tool%3Atask-1%3Adraw%3Acall-1%3Aartifact';
  assert.ok(appendGeneratedArtifactLinks(`File: ${rawUrl}`, 'task-1', [result]).includes(`[动画.html](${rawUrl})`));
  assert.ok(appendGeneratedArtifactLinks('Ready.  \n', 'task-1', [result]).startsWith('Ready.  \n'), 'The streamed answer prefix stays unchanged when adding a missing file');
  assert.equal(appendGeneratedArtifactLinks('answer', 'other-task', [result]), 'answer');
  assert.equal(appendGeneratedArtifactLinks('answer', 'task-1', [{ ...result, toolCalls: [{ id: 'call-1', name: 'workspace.write' }] }]), 'answer');
  assert.equal(appendGeneratedArtifactLinks('answer', 'task-1', [{ ...result, artifacts: [] }]), 'answer');
});
