import { randomUUID } from 'node:crypto';
import { S3ArtifactStore, s3ArtifactConfigFromEnv } from '../server/runtime/artifactStore.ts';

const endpoint = (process.env.AXIOM_OBJECT_STORAGE_ENDPOINT ?? '').trim();
if (!endpoint) {
  console.log('SKIP: AXIOM_OBJECT_STORAGE_ENDPOINT is not configured; external Artifact storage is disabled.');
  process.exit(0);
}

const config = s3ArtifactConfigFromEnv();
if (!config) throw new Error('Artifact storage endpoint is set but its S3 configuration is invalid.');

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const workerA = new S3ArtifactStore(config);
const workerB = new S3ArtifactStore(config);
const health = await workerA.health();
assert(health.reachable, health.detail);

const runId = `${Date.now()}-${randomUUID()}`;
const artifactId = `qa-object-${runId}`;
const largeArtifactId = `qa-object-large-${runId}`;
const binaryArtifactId = `qa-object-binary-${runId}`;
const tenantA = `qa-tenant-a-${runId}`;
const tenantB = `qa-tenant-b-${runId}`;
const contentA = `worker-a ${runId}`;
const contentB = `worker-b ${runId}`;
// A payload above the single-request default keeps this check useful for
// providers that transparently stream larger objects, while staying small
// enough for a local MinIO smoke run.
const largeContent = `large ${runId}\n${'x'.repeat(1024 * 1024 + 17)}`;
const binaryContent = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, ...Buffer.from(runId)]);

try {
  const [putA, putB] = await Promise.all([
    workerA.put(artifactId, contentA, tenantA),
    workerB.put(artifactId, contentB, tenantB),
  ]);
  assert(putA.bytes === Buffer.byteLength(contentA, 'utf8'), 'tenant A byte count mismatch.');
  assert(putB.bytes === Buffer.byteLength(contentB, 'utf8'), 'tenant B byte count mismatch.');

  const [readFromB, readFromA] = await Promise.all([
    workerB.get(artifactId, tenantA),
    workerA.get(artifactId, tenantB),
  ]);
  assert(readFromB === contentA, 'cross-worker read for tenant A did not return its object.');
  assert(readFromA === contentB, 'cross-worker read for tenant B did not return its object.');

  await workerA.put(largeArtifactId, largeContent, tenantA);
  const largeRead = await workerB.get(largeArtifactId, tenantA);
  assert(largeRead === largeContent, 'large Artifact round-trip failed.');

  const binaryPut = await workerA.putBinary(binaryArtifactId, binaryContent, tenantA, 'image/png');
  const binaryRead = await workerB.getBinary(binaryArtifactId, tenantA);
  assert(binaryPut.bytes === binaryContent.byteLength, 'binary Artifact byte count mismatch.');
  assert(binaryRead && Buffer.from(binaryRead).equals(Buffer.from(binaryContent)), 'binary Artifact cross-worker round-trip failed.');

  await workerA.delete(artifactId, tenantA);
  const [deletedTenant, retainedTenant] = await Promise.all([
    workerB.get(artifactId, tenantA),
    workerA.get(artifactId, tenantB),
  ]);
  assert(deletedTenant === null, 'tenant-scoped delete left the deleted object readable.');
  assert(retainedTenant === contentB, 'tenant-scoped delete crossed into another tenant.');
  await workerB.delete(artifactId, tenantB);
  await workerA.delete(largeArtifactId, tenantA);
  await workerA.delete(binaryArtifactId, tenantA);

  console.log(JSON.stringify({
    ok: true,
    endpoint,
    bucket: config.bucket,
    crossWorkerRead: true,
    tenantIsolation: true,
    scopedDelete: true,
    largeArtifactBytes: Buffer.byteLength(largeContent, 'utf8'),
    binaryArtifactBytes: binaryContent.byteLength,
  }));
} finally {
  // Cleanup is idempotent and also runs when an assertion fails, so repeated
  // acceptance runs do not leave tenant-scoped fixtures in the bucket.
  await Promise.all([
    workerA.delete(artifactId, tenantA).catch(() => undefined),
    workerA.delete(artifactId, tenantB).catch(() => undefined),
    workerA.delete(largeArtifactId, tenantA).catch(() => undefined),
    workerA.delete(binaryArtifactId, tenantA).catch(() => undefined),
  ]);
}
