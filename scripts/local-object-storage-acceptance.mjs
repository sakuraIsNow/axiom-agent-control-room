import { spawn } from 'node:child_process';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const node = process.execPath;
const port = (process.env.AXIOM_MINIO_PORT ?? '9000').trim();
const endpoint = `http://127.0.0.1:${port}`;
const bucket = (process.env.AXIOM_MINIO_QA_BUCKET ?? 'axiom-qa').trim();
const accessKeyId = (process.env.AXIOM_MINIO_ROOT_USER ?? 'axiom-minio').trim();
const secretAccessKey = (process.env.AXIOM_MINIO_ROOT_PASSWORD ?? 'change-me-minio').trim();

const run = (command, args, options = {}) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    windowsHide: true,
  });
  child.once('error', rejectRun);
  child.once('close', (code, signal) => {
    if (code === 0) resolveRun();
    else rejectRun(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal ?? 'unknown'}.`));
  });
});

await run(docker, ['compose', '-f', 'docker-compose.local.yml', '--profile', 'artifacts', 'up', '-d', 'minio']);

const client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

const deadline = Date.now() + 60_000;
let lastError;
while (Date.now() < deadline) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    lastError = undefined;
    break;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    const name = error?.name;
    if (status === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        lastError = undefined;
        break;
      } catch (createError) {
        const createStatus = createError?.$metadata?.httpStatusCode;
        if (createStatus !== 409 && createError?.name !== 'BucketAlreadyOwnedByYou') lastError = createError;
        else {
          lastError = undefined;
          break;
        }
      }
    } else {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
}

if (lastError) {
  throw new Error(`MinIO did not become ready at ${endpoint}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const qaEnv = {
  ...process.env,
  AXIOM_OBJECT_STORAGE_ENDPOINT: endpoint,
  AXIOM_OBJECT_STORAGE_BUCKET: bucket,
  AXIOM_OBJECT_STORAGE_REGION: 'us-east-1',
  AXIOM_OBJECT_STORAGE_PREFIX: 'axiom-qa-artifacts',
  AXIOM_OBJECT_STORAGE_ACCESS_KEY: accessKeyId,
  AXIOM_OBJECT_STORAGE_SECRET_KEY: secretAccessKey,
  AXIOM_OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
};

if (!process.argv.includes('--prepare-only')) {
  await run(node, ['--import', 'tsx', 'qa/object-storage-integration.mjs'], { env: qaEnv });
}
console.log(JSON.stringify({ ok: true, service: 'minio', endpoint, bucket, preparedOnly: process.argv.includes('--prepare-only') }));
