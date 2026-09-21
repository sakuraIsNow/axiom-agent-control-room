import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSearchDiagnostic, searchExchangeDiagnostic } from './lib/search-smoke-diagnostics.mjs';

test('source names are recorded as answer-content diagnostics, not alternative provider execution', () => {
  const exchange = { text: 'Retrieved page: https://open-meteo.com/. A page also mentions Bing and DuckDuckGo.', statuses: ['Search Agent is checking sources.'],
    complete: { route: 'deepseek-native-search', agentRole: 'search-agent', model: 'deepseek-v4-flash', searchCalls: 1 } };
  const report = searchExchangeDiagnostic('weather', 200, exchange);
  assert.deepEqual(report.mentionedSourceNames, ['Open-Meteo', 'Bing', 'DuckDuckGo']);
  assert.equal(report.completion.route, 'deepseek-native-search');
  assert.equal(Object.hasOwn(report, 'passed'), false);
  assert.match(report.evidenceBasis, /upstream destinations are not instrumented/);
});

test('search failure diagnostics are bounded, redact credentials and omit unapproved completion fields', () => {
  const key = 'sk-fixture-only-private-value';
  const report = searchExchangeDiagnostic('weather', 500, {
    text: `${key} Bearer arbitrary-private-token "apiKey":"other-private-token" ${'x'.repeat(20_000)}`,
    statuses: Array.from({ length: 50 }, () => `Bearer status-private-token ${'y'.repeat(500)}`),
    complete: { route: 'deepseek-native-search-failed', fallbackDisabled: true, apiKey: key, authorization: 'Bearer hidden', payload: { unsafe: key } },
  });
  assert.ok(report.answerExcerpt.length <= 3_000);
  assert.equal(report.statuses.length, 12);
  assert.ok(report.statuses.every((value) => value.length <= 300));
  assert.equal(report.completion.fallbackDisabled, true);
  for (const value of [key, 'arbitrary-private-token', 'other-private-token', 'status-private-token']) assert.equal(JSON.stringify(report).includes(value), false);
  assert.deepEqual(Object.keys(report.completion), ['route', 'fallbackDisabled']);
  assert.equal(redactSearchDiagnostic('Bearer abc', 100), 'Bearer [redacted]');
});
