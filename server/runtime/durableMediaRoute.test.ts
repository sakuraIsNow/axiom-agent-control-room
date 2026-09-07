import test from 'node:test';
import assert from 'node:assert/strict';
import { durableMediaRoute, enforceChatRouteSafety, fallbackChatRoute, workflowPlanFromChatRoute } from './chatRouter.js';

test('image and video requests enter a single durable specialist even with stale gateway routes', () => {
  for (const [message, role, duration] of [['帮我生成一张城市图片', 'drawing-agent', 600_000], ['帮我生成一个城市视频', 'video-agent', 900_000]] as const) {
    const original = fallbackChatRoute({ message, mode: 'build' });
    const route = durableMediaRoute(original, message);
    assert.equal(route.execution, 'workflow');
    assert.equal(route.workflowRoute, 'single-agent');
    assert.deepEqual(route.scheduler.activeAgentIds, [role]);
    const plan = workflowPlanFromChatRoute(original)!;
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].role, role);
    assert.equal(plan.steps[0].agentContract?.agentId, role);
    assert.equal(plan.steps[0].maxDurationMs, duration);
  }
});

test('durable media normalization does not change simple conversation routing', () => {
  const route = fallbackChatRoute({ message: '你好', mode: 'analyze' });
  assert.equal(durableMediaRoute(route), route);
  assert.equal(workflowPlanFromChatRoute(route), undefined);
});

test('an image attached for editing does not replace the selected drawing Agent with vision analysis', () => {
  const input = { message: '编辑这张图片，保留人物修改背景', mode: 'build' as const, attachments: [{ kind: 'image', mimeType: 'image/png' }] };
  const fallback = fallbackChatRoute(input);
  assert.equal(fallback.intent, 'image-generation');
  const route = enforceChatRouteSafety(fallback, input);
  assert.equal(route.intent, 'image-generation');
  assert.equal(route.execution, 'workflow');
  assert.deepEqual(route.scheduler.activeAgentIds, ['drawing-agent']);
});
