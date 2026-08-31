import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowTask } from '../types';
import { restoreTaskGraph } from './taskGraphRestoration';

const taskWithStatus = (status: WorkflowTask['status']): WorkflowTask => ({
  id: 'task-1',
  runId: 'run-1',
  sessionId: 'session-1',
  title: 'Graph restore test',
  input: 'test',
  mode: 'analyze',
  status,
  plan: {
    summary: 'test',
    routingReason: 'test',
    graph: {
      nodes: [
        { id: 'orchestrator', role: 'orchestrator', title: 'Orchestrator', dependsOn: [], status: 'running' },
        { id: 'step-1', stepId: 'step-1', agentId: 'researcher-step-1', role: 'researcher', title: 'Research', dependsOn: ['orchestrator'], status: 'queued' },
        { id: 'step-2', stepId: 'step-2', agentId: 'reviewer-step-2', role: 'reviewer', title: 'Review', dependsOn: ['step-1'], status: 'failed' },
      ],
      edges: [
        { from: 'orchestrator', to: 'step-1', kind: 'delegation' },
        { from: 'step-1', to: 'step-2', kind: 'review' },
      ],
    },
  },
  stepResults: [{
    stepId: 'step-1',
    agentId: 'researcher-step-1',
    role: 'researcher',
    status: 'completed',
    output: 'done',
    evidence: [],
    confidence: 0.9,
    attempts: 2,
    durationMs: 1500,
    tokens: 120,
    toolCalls: [],
  }],
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:01:00.000Z',
});

test('completed tasks cannot restore planning-time running or queued graph nodes', () => {
  const task = taskWithStatus('completed');
  const restored = restoreTaskGraph(task);

  assert.deepEqual(restored?.nodes.map((node) => node.status), ['completed', 'completed', 'failed']);
  assert.equal(restored?.nodes[1]?.tokens, 120);
  assert.equal(restored?.nodes[1]?.durationMs, 1500);
  assert.equal(restored?.nodes[1]?.attempts, 2);
  assert.equal(task.plan?.graph?.nodes[0]?.status, 'running');
});

test('active tasks preserve planning-time graph states when no result exists', () => {
  const restored = restoreTaskGraph(taskWithStatus('running'));
  assert.deepEqual(restored?.nodes.map((node) => node.status), ['running', 'completed', 'failed']);
});

test('failed and cancelled tasks do not restore a node as actively running', () => {
  for (const status of ['failed', 'cancelled'] as const) {
    const restored = restoreTaskGraph(taskWithStatus(status));
    assert.equal(restored?.nodes[0]?.status, 'failed');
    assert.equal(restored?.nodes[2]?.status, 'failed');
  }
});

test('approval and paused tasks do not restore a node as actively running', () => {
  for (const status of ['awaiting_approval', 'waiting_for_human', 'paused'] as const) {
    const restored = restoreTaskGraph(taskWithStatus(status));
    assert.equal(restored?.nodes.some((node) => node.status === 'running'), false);
    assert.equal(restored?.nodes[0]?.status, 'queued');
  }
});

test('tasks without a persisted graph restore as null', () => {
  const task = taskWithStatus('completed');
  task.plan = undefined;
  assert.equal(restoreTaskGraph(task), null);
});

test('tasks with a malformed persisted graph fail closed', () => {
  const task = taskWithStatus('completed');
  task.plan!.graph!.edges.push({ from: 'missing', to: 'step-1', kind: 'dependency' });
  assert.equal(restoreTaskGraph(task), null);
});
