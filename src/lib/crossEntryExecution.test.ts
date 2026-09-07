import test from 'node:test';
import assert from 'node:assert/strict';
import { taskProviderConfig } from './taskRuntime';
import { miniAppNeedsTask, miniAppTaskOutput } from './miniAppExecution';
import type { ChatRouteDecision, ProviderSettings, WorkflowTask } from '../types';

test('task provider payload preserves all explicit services without copying inactive defaults', () => {
  const defaults = { useCustom: false, location: 'internet' as const, apiKey: '', apiUrl: '', model: '' };
  const settings: ProviderSettings = {
    text: { ...defaults, useCustom: true, location: 'local', apiUrl: 'http://127.0.0.1:11434/v1', model: 'local-text' },
    vision: { ...defaults, useCustom: true, credentialId: 'saved-vision', model: 'vision-model' },
    image: { ...defaults, useCustom: true, apiKey: 'fake-key', apiUrl: 'https://image.example/v1', model: 'image-model' },
    video: { ...defaults, apiKey: 'inactive-fake-key' },
  };
  const payload = taskProviderConfig(settings);
  assert.equal(payload.text?.location, 'local');
  assert.equal(payload.text?.apiKey, undefined);
  assert.equal(payload.vision?.credentialId, 'saved-vision');
  assert.equal(payload.image?.apiKey, 'fake-key');
  assert.equal(payload.video, undefined);
  assert.equal(settings.video.apiKey, 'inactive-fake-key');
});

test('Mini App follows workflow and durable generation routes without forcing simple chat', () => {
  const route = (execution: string, intent: string) => ({ execution, intent }) as ChatRouteDecision;
  assert.equal(miniAppNeedsTask(route('gateway', 'conversation')), false);
  assert.equal(miniAppNeedsTask(route('workflow', 'task')), true);
  assert.equal(miniAppNeedsTask(route('gateway', 'image-generation')), true);
  assert.equal(miniAppNeedsTask(route('gateway', 'video-generation')), true);
});

test('Mini App never converts a pause, failed task, or empty delivery into success', () => {
  const task = (status: string, result = 'partial draft') => ({ status, result }) as WorkflowTask;
  for (const status of ['paused', 'awaiting_approval', 'waiting_for_human', 'failed', 'cancelled', 'running']) {
    assert.throws(() => miniAppTaskOutput(task(status)));
  }
  assert.throws(() => miniAppTaskOutput(task('completed', '   ')));
  assert.equal(miniAppTaskOutput(task('completed', 'real result')), 'real result');
  assert.match(miniAppTaskOutput({ ...task('completed'), stepResults: [{ status: 'completed', handoff: { status: 'partial' } }] } as WorkflowTask), /^\[Partial result/);
});
