import assert from 'node:assert/strict';
import test from 'node:test';
import { improvementEvaluationText } from './improvementPresentation';

test('only known evaluation metadata is translated; model and user content stays intact', () => {
  assert.equal(improvementEvaluationText('Evidence-based report', 'zh-CN'), '有据可查的报告');
  assert.equal(improvementEvaluationText('Evidence-based report', 'en'), 'Evidence-based report');
  assert.equal(improvementEvaluationText('My original model output', 'zh-CN'), 'My original model output');
});
