import assert from 'node:assert/strict';
import test from 'node:test';
import { userFacingError } from './errorPresentation';

test('user-facing errors hide raw English details while retaining an HTTP status', () => {
  assert.equal(userFacingError(new Error('Origin is not allowed.'), '请求失败。'), '请求失败。');
  assert.equal(userFacingError(new Error('Gateway returned HTTP 502.'), '请求失败。'), '请求失败。（HTTP 502）');
});

test('user-facing errors preserve an existing Chinese explanation', () => {
  assert.equal(userFacingError(new Error('任务不存在。'), '请求失败。'), '任务不存在。');
});
