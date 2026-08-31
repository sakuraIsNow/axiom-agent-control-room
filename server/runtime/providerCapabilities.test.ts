import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepSeekCapabilityInfo } from './providerCapabilities.js';

test('reports native DeepSeek capability boundaries', () => {
  const capabilities = deepSeekCapabilityInfo({
    baseUrl: 'https://api.deepseek.com',
    textModel: 'deepseek-chat',
    visionModel: 'deepseek-v4-flash-vision-exp',
    searchEnabled: true,
    searchModel: 'deepseek-v4-flash',
  });
  const byName = new Map(capabilities.map((item) => [item.capability, item]));
  assert.equal(byName.get('web_search')?.endpoint, '/responses');
  assert.equal(byName.get('file_image')?.endpoint, '/files');
  assert.equal(byName.get('function_call')?.native, true);
});

test('does not overclaim native capabilities for a custom provider', () => {
  const capabilities = deepSeekCapabilityInfo({
    baseUrl: 'https://provider.example.com/v1',
    textModel: 'custom-model',
    visionModel: 'custom-vision',
    searchEnabled: true,
    searchModel: 'custom-search',
  });
  assert.deepEqual(capabilities, [{
    capability: 'text',
    native: false,
    model: 'custom-model',
    note: '自定义 Provider 的能力必须通过实际握手或配置声明确认。',
  }]);
});
