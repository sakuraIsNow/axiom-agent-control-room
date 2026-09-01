import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session, WorkflowTask } from '../types';
import { findTaskAssistantIndex } from './taskHistorySelection';

const task = (id: string, input: string): WorkflowTask => ({
  id,
  runId: `run-${id}`,
  sessionId: 'session-1',
  title: input,
  input,
  mode: 'analyze',
  status: 'completed',
  stepResults: [],
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:01:00.000Z',
});

const session: Session = {
  id: 'session-1',
  title: 'history',
  updatedAt: Date.now(),
  messages: [
    { id: 'u1', role: 'user', content: 'same request', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: 'old answer', createdAt: 2, taskId: 'old-task' },
    { id: 'u2', role: 'user', content: 'same request', createdAt: 3 },
    { id: 'a2', role: 'assistant', content: 'new answer', createdAt: 4, taskId: 'new-task' },
  ],
};

test('task history selects the newest explicit assistant turn', () => {
  assert.equal(findTaskAssistantIndex(session, task('old-task', 'same request')), 1);
  assert.equal(findTaskAssistantIndex(session, task('new-task', 'same request')), 3);
});

test('task history matches the newest user turn without crossing into a later turn', () => {
  const copy: Session = {
    ...session,
    messages: session.messages.map((message) => message.taskId ? { ...message, taskId: undefined } : message),
  };
  assert.equal(findTaskAssistantIndex(copy, task('missing-task', 'same request')), 3);
});
