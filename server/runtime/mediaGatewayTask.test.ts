import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaGatewayTaskInput } from './mediaGatewayTask.js';
import { fallbackChatRoute } from './chatRouter.js';

test('media gateway preserves exact turn images and full conversation without pre-uploading to vision', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const routing = fallbackChatRoute({ message: 'Generate an image', mode: 'build' });
  const input = mediaGatewayTaskInput({ sessionId: 'chat', mode: 'build', imageProvider: { apiUrl: 'http://127.0.0.1:9999', location: 'local', model: 'image-local' }, messages: [
    { id: 'old', role: 'user', content: 'Keep the logo green' },
    { id: 'answer', role: 'assistant', content: 'Understood' },
    { id: 'edit', role: 'user', content: [{ type: 'text', text: 'Add a title to this image' }, { type: 'image_url', image_url: { url: image } }] },
  ] }, routing);
  assert.equal(input.routing.execution, 'workflow'); assert.equal(input.routing.scheduler.steps[0].agentId, 'drawing-agent');
  assert.equal(input.inputSource?.messageId, 'edit'); assert.equal(input.inputSource?.attachments[0].url, image);
  assert.equal(input.contextMessages.length, 3); assert.equal(input.contextMessages[0].content, 'Keep the logo green');
  assert.equal(input.providerConfig.image?.model, 'image-local');
  assert.equal(JSON.stringify(input.contextMessages).includes('base64'), false);
});
