import assert from 'node:assert/strict';
import test from 'node:test';
import { localizeRuntimeText, taskDifficultyLabel, taskKindLabel, taskReasonLabel, taskRouteLabel, taskStageLabel } from './taskPresentation';

test('task presentation hides internal English enum values without changing their protocol values', () => {
  assert.equal(taskKindLabel('implementation'), '实现任务');
  assert.equal(taskDifficultyLabel('complex'), '复杂');
  assert.equal(taskRouteLabel('full-workflow'), '完整工作流');
  assert.equal(taskReasonLabel('multiple constraints'), '包含多项约束');
  assert.equal(taskStageLabel('completed'), '已完成');
});

test('known persisted reviewer output is presented in Chinese', () => {
  assert.equal(
    localizeRuntimeText('Evidence tree lacks concrete artifacts for steps 1-5 (e.g., actual plan, research report, analysis report, draft deliverable, review report)'),
    '步骤 1 至 5 的证据树缺少具体产物，例如实际计划、研究报告、分析报告、交付草稿和审查报告。',
  );
  assert.equal(localizeRuntimeText('Conversation route does not require evidence-tree review.'), '对话路由不需要执行证据树审查。');
});

test('legacy focused route labels and summaries are presented in Chinese', () => {
  assert.equal(taskStageLabel('Focused task agent'), '专注执行 Agent');
  assert.equal(
    localizeRuntimeText('Triage selected a focused single-agent route; evidence-tree review was not required.'),
    '任务分类选择了单智能体路由，无需执行证据树审查。',
  );
  assert.equal(localizeRuntimeText('The triage profile selected one focused agent.'), '任务分类选择了单智能体专注执行。');
});
