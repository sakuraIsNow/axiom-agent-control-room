import test from 'node:test';
import assert from 'node:assert/strict';
import type { UserPlugin } from './contracts.js';
import { createPluginRelease, inspectPluginCompatibility } from './pluginCompatibility.js';

const plugin = (definition: UserPlugin['definition'], kind: UserPlugin['kind'] = 'prompt'): UserPlugin => ({
  id: 'plugin-1',
  tenantId: 'tenant-a',
  name: '生产检查插件',
  description: '验证发布前检查',
  kind,
  status: 'draft',
  visibility: 'private',
  version: 2,
  definition,
  history: [],
  createdBy: 'owner-a',
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
});

test('plugin compatibility declares permissions and rejects unavailable tools', () => {
  const candidate = plugin({ mode: 'analyze', promptPrefix: '分析输入。', toolNames: ['workspace.read', 'missing.tool'] });
  const report = inspectPluginCompatibility(candidate, [{ name: 'workspace.read', risk: 'low' }]);
  assert.equal(report.compatible, false);
  assert.match(report.errors.join('\n'), /missing\.tool/);
  assert.deepEqual(report.permissions.map((permission) => permission.id), ['tool:missing.tool', 'tool:workspace.read']);
});

test('mini-app compatibility rejects direct network access but keeps Agent bridge gaps visible as warnings', () => {
  const directNetwork = plugin({
    mode: 'build',
    htmlContent: '<!doctype html><html><body><script>fetch("https://example.com")</script></body></html>',
    toolNames: [],
  }, 'mini-app');
  assert.match(inspectPluginCompatibility(directNetwork, []).errors.join('\n'), /不能直接联网/);

  const bridged = plugin({
    mode: 'build',
    htmlContent: '<!doctype html><html><body>等待接入</body></html>',
    toolNames: [],
    agentEnabled: true,
    agentInstructions: '只查询公开天气。',
  }, 'mini-app');
  const report = inspectPluginCompatibility(bridged, []);
  assert.equal(report.compatible, true);
  assert.deepEqual(report.permissions.map((permission) => permission.id), ['platform-agent']);
  assert.match(report.warnings.join('\n'), /尚未调用 Agent 桥/);
});

test('signed plugin releases verify integrity and fail closed after content tampering', () => {
  const signingKey = 'test-only-plugin-signing-key-at-least-32-characters';
  const candidate = plugin({ mode: 'decide', promptPrefix: '给出结论。', toolNames: [] });
  const draftReport = inspectPluginCompatibility(candidate, [], { signingKey, signatureRequired: true });
  assert.equal(draftReport.compatible, true);
  const publishableReport = inspectPluginCompatibility(candidate, [], { signingKey });
  const release = createPluginRelease(candidate, publishableReport, 'owner-a', signingKey);
  const published = { ...candidate, status: 'published' as const, release };
  const verified = inspectPluginCompatibility(published, [], { signingKey, signatureRequired: true });
  assert.equal(verified.compatible, true);
  assert.equal(verified.releaseState, 'signed');

  const tampered = { ...published, description: '内容已被修改' };
  const invalid = inspectPluginCompatibility(tampered, [], { signingKey, signatureRequired: true });
  assert.equal(invalid.compatible, false);
  assert.equal(invalid.releaseState, 'invalid');
  assert.match(invalid.errors.join('\n'), /发布证明/);
});

test('signed releases fail closed without their verification key and weak keys cannot publish', () => {
  const signingKey = 'test-only-plugin-signing-key-at-least-32-characters';
  const candidate = plugin({ mode: 'decide', promptPrefix: '给出结论。', toolNames: [] });
  const report = inspectPluginCompatibility(candidate, [], { signingKey });
  const published = {
    ...candidate,
    status: 'published' as const,
    release: createPluginRelease(candidate, report, 'owner-a', signingKey),
  };

  const missingKey = inspectPluginCompatibility(published, []);
  assert.equal(missingKey.compatible, false);
  assert.equal(missingKey.releaseState, 'invalid');
  assert.match(missingKey.errors.join('\n'), /缺少验签密钥/);

  const weakKey = inspectPluginCompatibility(candidate, [], { signingKey: 'too-short' });
  assert.equal(weakKey.compatible, false);
  assert.match(weakKey.errors.join('\n'), /至少需要 32 个字符/);
  assert.throws(() => createPluginRelease(candidate, { ...report, compatible: true }, 'owner-a', 'too-short'), /at least 32 characters/);
});

test('release signatures cover provenance and invalidate stale permission risk', () => {
  const signingKey = 'test-only-plugin-signing-key-at-least-32-characters';
  const candidate = plugin({ mode: 'analyze', promptPrefix: '读取后分析。', toolNames: ['workspace.read'] });
  const lowRiskCatalog = [{ name: 'workspace.read', risk: 'low' as const }];
  const report = inspectPluginCompatibility(candidate, lowRiskCatalog, { signingKey });
  const release = createPluginRelease(candidate, report, 'owner-a', signingKey);
  const published = { ...candidate, status: 'published' as const, release };

  const changedActor = inspectPluginCompatibility({
    ...published,
    release: { ...release, signedBy: 'other-user' },
  }, lowRiskCatalog, { signingKey });
  assert.equal(changedActor.releaseState, 'invalid');
  assert.match(changedActor.errors.join('\n'), /签名校验失败/);

  const elevatedRisk = inspectPluginCompatibility(published, [{ name: 'workspace.read', risk: 'high' }], { signingKey });
  assert.equal(elevatedRisk.releaseState, 'invalid');
  assert.match(elevatedRisk.errors.join('\n'), /权限或风险等级已变化/);
});
