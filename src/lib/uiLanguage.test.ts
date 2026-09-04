import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_UI_LANGUAGE, normalizeUiLanguage, resolveInitialUiLanguage, translateUiText } from './uiLanguage';

test('English is the default UI language and query selection takes precedence', () => {
  assert.equal(DEFAULT_UI_LANGUAGE, 'en');
  assert.equal(resolveInitialUiLanguage(), 'en');
  assert.equal(resolveInitialUiLanguage({ stored: 'zh-CN' }), 'zh-CN');
  assert.equal(resolveInitialUiLanguage({ query: '?lang=en', stored: 'zh-CN' }), 'en');
  assert.equal(normalizeUiLanguage('zh-Hans'), 'zh-CN');
});

test('UI translations preserve product terms and support dynamic labels', () => {
  assert.equal(translateUiText('任务管理', 'en'), 'Tasks');
  assert.equal(translateUiText('Agent Nexus · 智能体枢纽', 'en'), 'Agent Nexus');
  assert.equal(translateUiText('删除会话 研究记录', 'en'), 'Delete conversation 研究记录');
  assert.equal(translateUiText('同步中…', 'en'), 'Syncing...');
  assert.equal(translateUiText('正在读取运行数据', 'en'), 'Loading runtime data');
  assert.equal(translateUiText('任务管理', 'zh-CN'), '任务管理');
  assert.equal(translateUiText('DeepSeek API', 'en'), 'DeepSeek API');
});
