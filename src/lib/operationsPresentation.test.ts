import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsAlertDetail } from './operationsPresentation';

test('Readiness alert combinations translate each platform service label', () => {
  const cases = [
    ['API 身份认证；租户身份签名；视频模型服务', 'API authentication; Tenant identity signing; Video model service'],
    ['租户身份签名；视频模型服务；长期记忆', 'Tenant identity signing; Video model service; Long-term memory'],
    ['任务模型配置保护；文本模型服务', 'Task model configuration protection; Text model service'],
    ['API 身份认证', 'API authentication'],
  ];
  for (const id of ['readiness-blocked', 'readiness-degraded']) {
    for (const [detail, expected] of cases) {
      const alert = { id, source: 'readiness' as const, detail };
      assert.equal(operationsAlertDetail(alert, 'en'), expected);
      assert.equal(operationsAlertDetail(alert, 'zh-CN'), detail);
    }
  }
});

test('Readiness label formatting does not parse or translate other alert source text', () => {
  const detail = 'API 身份认证；用户原文：任务管理';
  assert.equal(operationsAlertDetail({ id: 'readiness-degraded', source: 'tool', detail }, 'en'), detail);
  assert.equal(operationsAlertDetail({ id: 'custom-readiness-note', source: 'readiness', detail }, 'en'), detail);
  assert.equal(operationsAlertDetail({ id: 'readiness-degraded', source: 'readiness', detail: '用户原文：任务管理' }, 'en'), '用户原文：任务管理');
});
