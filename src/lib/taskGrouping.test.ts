import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowTaskSummary } from '../types';
import { groupTaskRuns, isAgentWorkflowTask } from './taskGrouping';

const makeTask = (overrides: Partial<WorkflowTaskSummary> = {}): WorkflowTaskSummary => ({
  id: 'task-1',
  runId: 'run-1',
  sessionId: 'session-1',
  userId: 'user-1',
  templateId: null,
  title: '示例任务',
  input: 'input',
  mode: 'analyze',
  model: null,
  status: 'completed',
  profile: null,
  cancelRequested: false,
  createdAt: '2026-08-28T08:00:00.000Z',
  updatedAt: '2026-08-28T08:01:00.000Z',
  currentStage: 'completed',
  durationMs: 1000,
  tokens: { prompt: 0, completion: 0, total: 0 },
  estimatedCostUsd: 0,
  modelCalls: 0,
  queueWaitMs: 0,
  attempts: 1,
  toolCalls: 0,
  completedSteps: 0,
  totalSteps: 0,
  ...overrides,
});

test('groups Agent Nexus runs by template, not execution session', () => {
  const tasks = [
    makeTask({ id: 'nexus-1', runId: 'run-1', sessionId: 'agent-nexus-workflow-1', templateId: 'workflow-1', source: 'agent-workflow' }),
    makeTask({ id: 'nexus-2', runId: 'run-2', sessionId: 'workflow-session-old', templateId: 'workflow-1', source: 'agent-workflow', updatedAt: '2026-08-28T08:02:00.000Z' }),
    makeTask({ id: 'nexus-3', runId: 'run-3', sessionId: 'workflow-session-another', templateId: 'workflow-1', source: 'agent-workflow', updatedAt: '2026-08-28T08:03:00.000Z' }),
    makeTask({ id: 'nexus-other', runId: 'run-4', sessionId: 'agent-nexus-workflow-2', templateId: 'workflow-2', source: 'agent-workflow' }),
  ];

  const groups = groupTaskRuns(tasks);
  assert.equal(groups.length, 2);
  const nexus = groups.find((group) => group.task.templateId === 'workflow-1');
  assert.ok(nexus);
  assert.equal(nexus.count, 3);
  assert.equal(nexus.sessionCount, 3);
  assert.deepEqual(nexus.taskIds, ['nexus-1', 'nexus-2', 'nexus-3']);
  assert.equal(nexus.task.id, 'nexus-3', 'newest run is the actionable representative');
});

test('keeps ordinary tasks with identical titles in separate sessions', () => {
  const groups = groupTaskRuns([
    makeTask({ id: 'ordinary-1', sessionId: 'chat-1', title: '同名任务' }),
    makeTask({ id: 'ordinary-2', sessionId: 'chat-2', title: '同名任务', updatedAt: '2026-08-28T08:02:00.000Z' }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.sessionCount, 1);
  assert.equal(groups[1]?.sessionCount, 1);
});

test('recognizes legacy Nexus runs without an explicit source', () => {
  assert.equal(isAgentWorkflowTask(makeTask({ templateId: 'workflow-legacy', sessionId: 'agent-nexus-workflow-legacy' })), true);
  assert.equal(isAgentWorkflowTask(makeTask({ templateId: 'workflow-legacy', source: 'conversation', sessionId: 'chat-legacy' })), false);
  assert.equal(isAgentWorkflowTask(makeTask({ templateId: 'workflow-legacy', source: 'conversation', sessionId: 'agent-nexus-workflow-legacy' })), false);
});

test('counts unique sessions when a Nexus session has multiple runs', () => {
  const groups = groupTaskRuns([
    makeTask({ id: 'run-a', templateId: 'workflow-3', source: 'agent-workflow', sessionId: 'agent-nexus-workflow-3' }),
    makeTask({ id: 'run-b', templateId: 'workflow-3', source: 'agent-workflow', sessionId: 'agent-nexus-workflow-3' }),
    makeTask({ id: 'run-c', templateId: 'workflow-3', source: 'agent-workflow', sessionId: 'workflow-session-3' }),
  ]);
  assert.equal(groups[0]?.count, 3);
  assert.equal(groups[0]?.sessionCount, 2);
});
