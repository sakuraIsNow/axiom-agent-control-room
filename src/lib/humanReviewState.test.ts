import assert from 'node:assert/strict';
import test from 'node:test';
import { canHumanReviewTask } from './humanReviewState';

const waitingTask = { id: 'task-waiting', status: 'waiting_for_human' as const };
const review = { approved: false, score: 75 };

test('human review actions require the selected waiting task and its review result', () => {
  assert.equal(canHumanReviewTask(waitingTask, review, waitingTask.id), true);
  assert.equal(canHumanReviewTask(waitingTask, null, waitingTask.id), false);
  assert.equal(canHumanReviewTask(waitingTask, review, 'another-task'), false);
  assert.equal(canHumanReviewTask({ id: waitingTask.id, status: 'completed' }, review, waitingTask.id), false);
  assert.equal(canHumanReviewTask(null, review, waitingTask.id), false);
});
