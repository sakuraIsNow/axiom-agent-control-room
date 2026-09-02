import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowTask, WorkflowTaskStatus } from '../types';
import { isTaskExecuting, taskHistoryState } from './taskHistoryState';

const task = (status: WorkflowTaskStatus): WorkflowTask => ({
  id: 'task-1',
  runId: 'run-1',
  revision: 0,
  sessionId: 'session-1',
  title: 'History state',
  input: 'test',
  mode: 'analyze',
  status,
  stepResults: [],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:01:00.000Z',
});

test('only executable task states restore a pending assistant response', () => {
  for (const status of ['queued', 'planning', 'running', 'reviewing'] as const) {
    assert.equal(isTaskExecuting(status), true);
    assert.equal(taskHistoryState(task(status)).pending, true);
  }
  for (const status of ['awaiting_approval', 'waiting_for_human', 'paused', 'completed', 'failed', 'cancelled'] as const) {
    assert.equal(isTaskExecuting(status), false);
    assert.equal(taskHistoryState(task(status)).pending, false);
    assert.equal(taskHistoryState(task(status)).activity, '');
  }
});

test('failed tasks keep a durable partial result visible in conversation history', () => {
  const failed = task('failed');
  failed.result = '已生成的前半部分';
  failed.error = '最终交付内容未完整生成：模型输出达到上限，续写未能完成，请重试。';
  const state = taskHistoryState(failed);
  assert.equal(state.pending, false);
  assert.match(state.content, /已生成的前半部分/);
  assert.match(state.content, /未完整结束/);
  assert.match(state.content, /输出达到上限/);
});

test('a review gate is presented as waiting for confirmation instead of execution', () => {
  const waiting = task('waiting_for_human');
  waiting.review = { approved: false, score: 75, summary: '证据不足', gaps: [], requiredCorrections: [] };
  const state = taskHistoryState(waiting);
  assert.equal(state.pending, false);
  assert.match(state.content, /审查 Agent 已完成质量检查（75\/100），当前结果需要你确认/);
  assert.doesNotMatch(state.content, /恢复执行|生成中/);
});
