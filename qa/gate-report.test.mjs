import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { classifyGateAttempts, gateExitCode, summarizeGateResults } from './gate-report.mjs';

const attempt = (status, number = 1) => ({ attempt: number, name: 'fixture', script: 'fixture', status, code: status === 'passed' ? 0 : 1, durationMs: 10 });

test('a clean first attempt is the only unconditional pass', () => {
  const result = classifyGateAttempts([attempt('passed')]);
  assert.equal(result.status, 'passed');
  assert.equal(result.firstPassPassed, true);
  assert.equal(result.retried, false);
  const summary = summarizeGateResults([result]);
  assert.equal(summary.firstPassRate, 1);
  assert.equal(gateExitCode(summary), 0);
});

test('failure followed by success remains unstable and preserves both attempts', () => {
  const attempts = [attempt('failed'), attempt('passed', 2)];
  const result = classifyGateAttempts(attempts);
  assert.equal(result.status, 'unstable');
  assert.equal(result.firstPassPassed, false);
  assert.equal(result.retried, true);
  assert.equal(result.flaky, true);
  assert.equal(result.durationMs, 20);
  assert.deepEqual(result.attempts, attempts);
  const summary = summarizeGateResults([result, classifyGateAttempts([attempt('passed')]), { status: 'skipped' }]);
  assert.equal(summary.status, 'unstable');
  assert.equal(summary.passed, 1);
  assert.equal(summary.unstable, 1);
  assert.equal(summary.firstPassPassed, 1);
  assert.equal(summary.firstPassRate, 0.5);
  assert.equal(summary.flaky, 1);
  assert.equal(summary.retried, 1);
  assert.equal(gateExitCode(summary), 1);
});

test('persistent failure wins over unstable and skipped stages', () => {
  const summary = summarizeGateResults([
    classifyGateAttempts([attempt('failed'), attempt('failed', 2)]),
    classifyGateAttempts([attempt('failed'), attempt('passed', 2)]),
    { status: 'skipped' },
  ]);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.failed, 1);
  assert.equal(summary.retried, 2);
  assert.equal(gateExitCode(summary), 1);
});

test('empty or fully skipped gates cannot claim completion', () => {
  assert.throws(() => classifyGateAttempts([]));
  assert.equal(gateExitCode(summarizeGateResults([])), 1);
  assert.equal(summarizeGateResults([{ status: 'skipped' }]).firstPassRate, null);
});

test('an injected flaky result fails the actual process exit contract', () => {
  const moduleUrl = new URL('./gate-report.mjs', import.meta.url).href;
  const code = `import {classifyGateAttempts,summarizeGateResults,gateExitCode} from ${JSON.stringify(moduleUrl)};process.exitCode=gateExitCode(summarizeGateResults([classifyGateAttempts([{status:'failed',durationMs:1},{status:'passed',durationMs:1}])]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
});
