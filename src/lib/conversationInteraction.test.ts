import assert from 'node:assert/strict';
import test from 'node:test';
import { isConversationSubmitKey, isNearConversationBottom } from './conversationInteraction';

test('IME confirmation never submits a conversation or Nexus instruction', () => {
  assert.equal(isConversationSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(isConversationSubmitKey({ key: 'Enter', shiftKey: false, keyCode: 229 }), false);
  assert.equal(isConversationSubmitKey({ key: 'Enter', shiftKey: true }), false);
  assert.equal(isConversationSubmitKey({ key: 'Enter', shiftKey: false }), true);
});

test('streaming follows the bottom only while the reader remains near it', () => {
  assert.equal(isNearConversationBottom({ scrollHeight: 1200, clientHeight: 400, scrollTop: 799 }), true);
  assert.equal(isNearConversationBottom({ scrollHeight: 1200, clientHeight: 400, scrollTop: 180 }), false);
  assert.equal(isNearConversationBottom({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 }), true);
});
