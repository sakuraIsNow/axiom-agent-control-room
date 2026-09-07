import test from 'node:test';
import assert from 'node:assert/strict';
import { translateRunEventLabel } from './runEventPresentation';

test('runtime labels translate task.created and model.failed while preserving source names', () => {
  const cases = [
    ['任务已持久化', 'Task saved durably'],
    ['研究员的阶段调用未完成', "研究员's stage call did not complete"],
    ['任务管理开始执行', '任务管理 started execution'],
    ['任务已持久化的阶段调用未完成', "任务已持久化's stage call did not complete"],
    ['任务管理 执行失败', '任务管理 failed execution'],
    ['研究员连接提前结束，正在重新连接（第 2 次）', "研究员's connection ended early; reconnecting (attempt 2)"],
    ['已分配研究员：任务管理', 'Assigned 研究员: 任务管理'],
    ['报告生成 Agent 已交付 任务管理.docx', 'Report Agent delivered 任务管理.docx'],
    ['报告生成 Agent 已交付 已完成', 'Report Agent delivered 已完成'],
    ['工具 已完成 已获批准，继续执行', 'Tool 已完成 approved; continuing execution'],
    ['任务分类：研究任务 · 中等 · 小组协作', 'Task classification: Research task · Moderate · Agent team'],
  ];
  for (const [label, expected] of cases) {
    assert.equal(translateRunEventLabel({ label, labelSource: 'system' }, 'en'), expected);
    assert.equal(translateRunEventLabel({ label, labelSource: 'system' }, 'zh-CN'), label);
  }
});

test('unclassified and gateway labels remain verbatim even when they match system copy', () => {
  for (const label of ['任务管理', '任务已持久化', '研究员的阶段调用未完成', '任务管理开始执行']) {
    assert.equal(translateRunEventLabel({ label }, 'en'), label);
    assert.equal(translateRunEventLabel({ label, labelSource: 'verbatim' }, 'en'), label);
  }
});

test('unknown future system labels do not lose content', () => {
  const label = 'Future runtime label: 原始诊断 42';
  assert.equal(translateRunEventLabel({ label, labelSource: 'system' }, 'en'), label);
});
