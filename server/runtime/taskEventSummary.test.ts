import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeTaskEvents } from './taskEventSummary.js';

test('task event summary keeps schedule ownership and real routing selections', () => {
  const summaries = summarizeTaskEvents([{
    taskId: 'task-1',
    sequence: 1,
    type: 'task.created',
    timestamp: '2026-09-02T00:00:00.000Z',
    payload: {
      source: 'schedule',
      triggerId: 'schedule-1',
      manual: true,
      activeAgentIds: ['search-agent', 'analyst'],
      selectedSkillIds: ['web-search'],
    },
  }]);
  assert.deepEqual(summaries.get('task-1'), {
    source: 'schedule',
    triggerId: 'schedule-1',
    manual: true,
    activeAgentIds: ['search-agent', 'analyst'],
    selectedSkillIds: ['web-search'],
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    retries: 0,
    toolCalls: 0,
    latest: {
      type: 'task.created',
      timestamp: '2026-09-02T00:00:00.000Z',
      payload: {
        source: 'schedule', triggerId: 'schedule-1', manual: true,
        activeAgentIds: ['search-agent', 'analyst'], selectedSkillIds: ['web-search'],
      },
    },
  });
});
