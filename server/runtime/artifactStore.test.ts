import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { FileArtifactStore, S3ArtifactStore, s3ArtifactConfigFromEnv } from './artifactStore.js';

test('FileArtifactStore persists, reads, deletes, and probes the configured directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axiom-artifact-store-'));
  try {
    const store = new FileArtifactStore(root);
    const written = await store.put('tool:task/step', 'hello artifact');
    assert.equal(written.bytes, 14);
    assert.equal(await store.get('tool:task/step'), 'hello artifact');
    const health = await store.health();
    assert.equal(health.reachable, true);
    assert.match(health.detail, /本地 Artifact/);
    const first = await store.put('a:b', 'first artifact');
    const second = await store.put('a_b', 'second artifact');
    assert.notEqual(first.key, second.key);
    assert.equal(await store.get('a:b'), 'first artifact');
    assert.equal(await store.get('a_b'), 'second artifact');
    await store.delete('tool:task/step');
    assert.equal(await store.get('tool:task/step'), null);
    await assert.rejects(readFile(written.key, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FileArtifactStore supports cross-worker reads and deletes on a shared directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axiom-artifact-workers-'));
  try {
    const workerA = new FileArtifactStore(root);
    const workerB = new FileArtifactStore(root);
    const tenantA = await workerA.put('result:cross-worker', 'shared result', 'tenant-a');
    assert.equal(await workerB.get('result:cross-worker', 'tenant-a'), 'shared result');
    const tenantB = await workerB.put('result:cross-worker', 'other tenant result', 'tenant-b');
    assert.notEqual(tenantA.key, tenantB.key);
    assert.equal(await workerA.get('result:cross-worker', 'tenant-a'), 'shared result');
    assert.equal(await workerA.get('result:cross-worker', 'tenant-b'), 'other tenant result');
    await workerB.delete('result:cross-worker', 'tenant-a');
    assert.equal(await workerA.get('result:cross-worker', 'tenant-a'), null);
    assert.equal(await workerA.get('result:cross-worker', 'tenant-b'), 'other tenant result');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tenant-scoped filesystem deletion preserves an unscoped migration artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axiom-artifact-legacy-delete-'));
  try {
    const workerA = new FileArtifactStore(root);
    const workerB = new FileArtifactStore(root);
    await workerA.put('result:legacy', 'legacy result');
    await workerB.delete('result:legacy', 'tenant-a');
    assert.equal(await workerA.get('result:legacy', 'tenant-b'), 'legacy result');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('S3ArtifactStore uses a tenant-safe encoded key and S3-compatible commands', async () => {
  const commands: unknown[] = [];
  let stored = 'remote artifact';
  const client = {
    send: async (command: unknown) => {
      commands.push(command);
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToString: async () => stored } };
      }
      return {};
    },
  };
  const store = new S3ArtifactStore({ bucket: 'axiom-test', prefix: 'axiom-artifacts', serverSideEncryption: 'AES256' }, client);
  const put = await store.put('result:task/with spaces', 'remote artifact', 'tenant-a');
  assert.equal(put.key, 's3://axiom-test/axiom-artifacts/tenant-a/result%3Atask%2Fwith%20spaces.md');
  assert.equal(await store.get('result:task/with spaces', 'tenant-a'), stored);
  await store.delete('result:task/with spaces', 'tenant-a');
  const health = await store.health();
  assert.equal(health.reachable, true);
  assert.match(health.detail, /S3 兼容 Artifact/);
  assert.equal(commands.filter((command) => command instanceof PutObjectCommand).length, 1);
  assert.equal(commands.filter((command) => command instanceof GetObjectCommand).length, 1);
  assert.equal(commands.filter((command) => command instanceof DeleteObjectCommand).length, 1);
  assert.equal(commands.filter((command) => command instanceof HeadBucketCommand).length, 1);
  const putCommand = commands.find((command): command is PutObjectCommand => command instanceof PutObjectCommand);
  assert.equal(putCommand?.input.Bucket, 'axiom-test');
  assert.equal(putCommand?.input.ContentType, 'text/markdown; charset=utf-8');
  assert.equal(putCommand?.input.ServerSideEncryption, 'AES256');
});

test('tenant-scoped deletion does not remove an unscoped migration artifact', async () => {
  const deletedKeys: string[] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof DeleteObjectCommand) deletedKeys.push(String(command.input.Key));
      return {};
    },
  };
  const store = new S3ArtifactStore({ bucket: 'axiom-test', prefix: 'axiom-artifacts' }, client);
  await store.delete('result:legacy', 'tenant-a');
  assert.deepEqual(deletedKeys, ['axiom-artifacts/tenant-a/result%3Alegacy.md']);
});

test('S3 Artifact reads legacy unscoped objects during tenant-key migration', async () => {
  const requestedKeys: string[] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        requestedKeys.push(String(command.input.Key));
        if (requestedKeys.length === 1) {
          const error = new Error('missing') as Error & { name: string; $metadata: { httpStatusCode: number } };
          error.name = 'NoSuchKey';
          error.$metadata = { httpStatusCode: 404 };
          throw error;
        }
        return { Body: { transformToString: async () => 'legacy artifact' } };
      }
      return {};
    },
  };
  const store = new S3ArtifactStore({ bucket: 'axiom-test', prefix: 'axiom-artifacts' }, client);
  assert.equal(await store.get('result:legacy', 'tenant-a'), 'legacy artifact');
  assert.deepEqual(requestedKeys, [
    'axiom-artifacts/tenant-a/result%3Alegacy.md',
    'axiom-artifacts/result%3Alegacy.md',
  ]);
});

test('S3ArtifactStore treats a missing object as an empty lookup, not a storage outage', async () => {
  const client = {
    send: async () => {
      const error = new Error('missing') as Error & { name: string; $metadata: { httpStatusCode: number } };
      error.name = 'NoSuchKey';
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    },
  };
  const store = new S3ArtifactStore({ bucket: 'axiom-test' }, client);
  assert.equal(await store.get('missing'), null);
  const health = await store.health();
  assert.equal(health.reachable, false);
  assert.match(health.detail, /不可用/);
});

test('S3 endpoint configuration supports s3 URLs and path-style MinIO/COS endpoints', () => {
  const keys = [
    'AXIOM_OBJECT_STORAGE_ENDPOINT',
    'AXIOM_OBJECT_STORAGE_BUCKET',
    'AXIOM_OBJECT_STORAGE_PREFIX',
    'AXIOM_OBJECT_STORAGE_REGION',
    'AXIOM_OBJECT_STORAGE_FORCE_PATH_STYLE',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.AXIOM_OBJECT_STORAGE_ENDPOINT = 's3://axiom-artifacts/runs';
    delete process.env.AXIOM_OBJECT_STORAGE_BUCKET;
    delete process.env.AXIOM_OBJECT_STORAGE_PREFIX;
    const s3 = s3ArtifactConfigFromEnv();
    assert.deepEqual(s3 && { bucket: s3.bucket, prefix: s3.prefix, endpoint: s3.endpoint, forcePathStyle: s3.forcePathStyle }, {
      bucket: 'axiom-artifacts', prefix: 'runs', endpoint: undefined, forcePathStyle: false,
    });

    process.env.AXIOM_OBJECT_STORAGE_ENDPOINT = 'http://minio:9000/axiom-bucket/runs';
    const minio = s3ArtifactConfigFromEnv();
    assert.deepEqual(minio && { bucket: minio.bucket, prefix: minio.prefix, endpoint: minio.endpoint, forcePathStyle: minio.forcePathStyle }, {
      bucket: 'axiom-bucket', prefix: 'runs', endpoint: 'http://minio:9000', forcePathStyle: true,
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
