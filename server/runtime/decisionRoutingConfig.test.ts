import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDecisionRoutingConfig } from './decisionRouting.js';

const key = 'apikey_test_only_not_a_real_secret';
test('legacy remains the default and does not read an unrelated credential file', () => {
  const config = createDecisionRoutingConfig({ TYPESAFE_API_KEY_FILE: '/does-not-exist' });
  assert.deepEqual(config.options, {});
  assert.equal(config.status.mode, 'legacy');
  assert.equal(config.status.reason, 'disabled');
});
test('both explicit modes are server-only opt-ins and reveal no credential or path', () => {
  for (const mode of ['jev-shadow', 'jev-hybrid']) {
    const config = createDecisionRoutingConfig({ AXIOM_DECISION_ROUTER: mode, TYPESAFE_API_KEY: key });
    assert.equal(config.status.ready, true);
    assert.equal(config.status.model, 'jev-1.13.0');
    assert.equal(config.options.decisionRouterMode, mode === 'jev-shadow' ? 'shadow' : 'hybrid');
    assert.equal(JSON.stringify(config.status).includes(key), false);
  }
});
test('invalid mode, limits, model, key and endpoint fail back to legacy without throwing', () => {
  for (const overrides of [
    { AXIOM_DECISION_ROUTER: 'typo' }, { AXIOM_JEV_TIMEOUT_MS: 'NaN' }, { AXIOM_JEV_TIMEOUT_MS: '10001' },
    { AXIOM_JEV_MIN_CONFIDENCE: '0.1' }, { AXIOM_JEV_MIN_CONFIDENCE: 'NaN' },
    { TYPESAFE_API_BASE: 'http://api.typesafe.ai' }, { TYPESAFE_API_BASE: 'https://user:password@api.typesafe.ai' },
    { TYPESAFE_API_BASE: 'https://api.typesafe.ai?key=secret' }, { TYPESAFE_MODEL: 'model\nsecret' },
    { TYPESAFE_API_KEY: 'invalid key' },
  ]) {
    const config = createDecisionRoutingConfig({ AXIOM_DECISION_ROUTER: 'jev-hybrid', TYPESAFE_API_KEY: key, ...overrides });
    assert.deepEqual(config.options, {});
    assert.equal(config.status.reason, 'invalid-config');
  }
});
test('explicit key files support raw or labelled content and environment keys take priority', () => {
  const directory = mkdtempSync(join(tmpdir(), 'axiom-jev-config-'));
  const keyPath = join(directory, 'key.txt');
  try {
    for (const content of [key, `key: ${key}`, `\uFEFFkey\uFF1A${key}`, `key='${key}'`]) {
      writeFileSync(keyPath, content);
      const config = createDecisionRoutingConfig({ AXIOM_DECISION_ROUTER: 'jev-shadow', TYPESAFE_API_KEY_FILE: keyPath });
      assert.equal(config.status.ready, true);
      assert.equal(JSON.stringify(config.status).includes(keyPath), false);
    }
    assert.equal(createDecisionRoutingConfig({ AXIOM_DECISION_ROUTER: 'jev-hybrid', TYPESAFE_API_KEY: key,
      TYPESAFE_API_KEY_FILE: '/does-not-exist' }).status.ready, true);
    writeFileSync(keyPath, 'a'.repeat(4_097));
    assert.equal(createDecisionRoutingConfig({ AXIOM_DECISION_ROUTER: 'jev-hybrid', TYPESAFE_API_KEY_FILE: keyPath }).status.reason, 'invalid-config');
  } finally { rmSync(directory, { recursive: true }); }
});
test('missing credentials disable only the optional decision service', () => {
  assert.equal(createDecisionRoutingConfig({ AXIOM_DECISION_ROUTER: 'jev-hybrid' }).status.reason, 'missing-key');
  assert.equal(createDecisionRoutingConfig({ AXIOM_DECISION_ROUTER: 'jev-hybrid', TYPESAFE_API_KEY_FILE: '/does-not-exist' }).status.reason, 'unreadable-key-file');
});
