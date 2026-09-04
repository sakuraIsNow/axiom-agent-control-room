import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityPackById, capabilityPackManifestDigest } from './capabilityPacks.js';

test('capability pack manifest digest is stable and changes with the manifest', () => {
  const pack = capabilityPackById('development');
  assert.ok(pack);
  const digest = capabilityPackManifestDigest(pack);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(capabilityPackManifestDigest(pack), digest);
  assert.notEqual(capabilityPackManifestDigest({ ...pack, version: '1.0.1' }), digest);
});

