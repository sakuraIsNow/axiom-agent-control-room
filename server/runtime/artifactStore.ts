import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type ArtifactStoreHealth = {
  configured: boolean;
  reachable: boolean;
  detail: string;
};

export interface ArtifactStore {
  readonly kind: 'filesystem' | 's3';
  put(id: string, content: string, tenantId?: string): Promise<{ key: string; bytes: number }>;
  get(id: string, tenantId?: string): Promise<string | null>;
  delete(id: string, tenantId?: string): Promise<void>;
  health(signal?: AbortSignal): Promise<ArtifactStoreHealth>;
}

const validateArtifactId = (id: string) => {
  const value = id.trim();
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Artifact id must contain 1-512 printable characters.');
  }
  return value;
};

const normalizedTenant = (tenantId?: string) => {
  if (!tenantId) return '';
  const value = tenantId.trim();
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Artifact tenant id must contain 1-256 printable characters.');
  }
  return encodeURIComponent(value);
};

export class FileArtifactStore implements ArtifactStore {
  readonly kind = 'filesystem' as const;
  private readonly root: string;

  constructor(root = resolve(process.cwd(), '.data', 'artifacts')) {
    this.root = resolve(root);
  }

  private key(id: string, tenantId?: string) {
    const value = validateArtifactId(id);
    // A sanitized filename alone is ambiguous (`a:b` and `a_b` collide).
    // Keep a short readable prefix, then append a digest of the original id.
    const readable = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'artifact';
    const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
    const tenant = normalizedTenant(tenantId);
    return join(this.root, ...(tenant ? [tenant] : []), `${readable}--${digest}.md`);
  }

  private legacyKey(id: string) {
    const safe = validateArtifactId(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.root, `${safe}.md`);
  }

  async put(id: string, content: string, tenantId?: string) {
    const key = this.key(id, tenantId);
    await mkdir(dirname(key), { recursive: true });
    // Write to a unique sibling and rename so a process interruption cannot
    // expose a partially written Markdown artifact to another worker.
    const temporary = `${key}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, key);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return { key, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async get(id: string, tenantId?: string) {
    try {
      return await readFile(this.key(id, tenantId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Read objects written before tenant-scoped keys were introduced.
      if (tenantId) {
        try { return await readFile(this.key(id), 'utf8'); } catch (scopedError) {
          if ((scopedError as NodeJS.ErrnoException).code !== 'ENOENT') throw scopedError;
        }
      }
      // Read artifacts written by pre-hardening builds while they age out.
      try {
        return await readFile(this.legacyKey(id), 'utf8');
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw legacyError;
      }
    }
  }

  async delete(id: string, tenantId?: string) {
    // Never remove an unscoped migration object from a tenant-scoped request:
    // another tenant may still be reading that legacy object during migration.
    // An unscoped delete is reserved for explicit maintenance/cleanup calls.
    const keys = tenantId
      ? [this.key(id, tenantId)]
      : [this.key(id), this.legacyKey(id)];
    await Promise.all(keys.map((key) => rm(key, { force: true })));
  }

  async health(): Promise<ArtifactStoreHealth> {
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.R_OK | constants.W_OK);
      return { configured: true, reachable: true, detail: '本地 Artifact 目录可读写。' };
    } catch (error) {
      return {
        configured: true,
        reachable: false,
        detail: `本地 Artifact 目录不可用：${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  }
}

export type S3ArtifactStoreConfig = {
  bucket: string;
  endpoint?: string;
  region?: string;
  prefix?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  serverSideEncryption?: 'AES256' | 'aws:kms';
};

type S3Sender = Pick<S3Client, 'send'>;

const storageTimeoutSignal = (signal?: AbortSignal) => {
  const configured = Number(process.env.AXIOM_OBJECT_STORAGE_TIMEOUT_MS ?? 12_000);
  const timeoutMs = Number.isFinite(configured) ? Math.min(60_000, Math.max(1_000, configured)) : 12_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

const normalizedPrefix = (value = 'axiom-artifacts') => value
  .trim()
  .replace(/^\/+|\/+$/g, '')
  .split('/')
  .filter(Boolean)
  .map((segment) => encodeURIComponent(segment))
  .join('/');

export class S3ArtifactStore implements ArtifactStore {
  readonly kind = 's3' as const;
  private readonly client: S3Sender;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly serverSideEncryption?: 'AES256' | 'aws:kms';

  constructor(config: S3ArtifactStoreConfig, client?: S3Sender) {
    this.bucket = config.bucket.trim();
    if (!this.bucket) throw new Error('AXIOM_OBJECT_STORAGE_BUCKET is required for S3-compatible storage.');
    this.prefix = normalizedPrefix(config.prefix);
    this.serverSideEncryption = config.serverSideEncryption;
    if (client) {
      this.client = client;
      return;
    }
    const clientConfig: S3ClientConfig = {
      region: config.region?.trim() || 'us-east-1',
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
              ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
            },
          }
        : {}),
    };
    this.client = new S3Client(clientConfig);
  }

  private key(id: string, tenantId?: string) {
    const encodedId = encodeURIComponent(validateArtifactId(id));
    const tenant = normalizedTenant(tenantId);
    return [this.prefix, ...(tenant ? [tenant] : []), `${encodedId}.md`].filter(Boolean).join('/');
  }

  async put(id: string, content: string, tenantId?: string) {
    const key = this.key(id, tenantId);
    const bytes = Buffer.byteLength(content, 'utf8');
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: Buffer.from(content, 'utf8'),
      ContentLength: bytes,
      ContentType: 'text/markdown; charset=utf-8',
      ...(this.serverSideEncryption ? { ServerSideEncryption: this.serverSideEncryption } : {}),
      Metadata: { 'axiom-artifact-id': encodeURIComponent(id).slice(0, 1_024) },
    }), { abortSignal: storageTimeoutSignal() });
    return { key: `s3://${this.bucket}/${key}`, bytes };
  }

  async get(id: string, tenantId?: string) {
    const keys = tenantId ? [this.key(id, tenantId), this.key(id)] : [this.key(id)];
    for (const key of keys) {
      try {
        const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: storageTimeoutSignal() });
        if (!response.Body) return null;
        return await response.Body.transformToString('utf-8');
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        const name = (error as { name?: string }).name;
        if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') continue;
        throw error;
      }
    }
    return null;
  }

  async delete(id: string, tenantId?: string) {
    // Keep tenant-scoped deletion strictly tenant-scoped. In particular, do
    // not delete the unscoped legacy key as a side effect of a user request.
    const keys = tenantId ? [this.key(id, tenantId)] : [this.key(id)];
    await Promise.all(keys.map((key) => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: storageTimeoutSignal() })));
  }

  async health(signal?: AbortSignal): Promise<ArtifactStoreHealth> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: storageTimeoutSignal(signal) });
      return { configured: true, reachable: true, detail: `S3 兼容 Artifact 存储桶 ${this.bucket} 可访问。` };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      return {
        configured: true,
        reachable: false,
        detail: `S3 兼容 Artifact 存储桶 ${this.bucket} 不可用${status ? `（HTTP ${status}）` : ''}。`,
      };
    }
  }
}

const enabled = (value: string | undefined) => value?.trim().toLowerCase() === 'true';

export const s3ArtifactConfigFromEnv = (): S3ArtifactStoreConfig | null => {
  const rawEndpoint = process.env.AXIOM_OBJECT_STORAGE_ENDPOINT?.trim();
  if (!rawEndpoint) return null;
  let endpoint: string | undefined;
  let bucket = process.env.AXIOM_OBJECT_STORAGE_BUCKET?.trim() ?? '';
  let endpointPrefix = '';

  if (rawEndpoint.startsWith('s3://')) {
    const parsed = new URL(rawEndpoint);
    bucket ||= parsed.hostname;
    endpointPrefix = parsed.pathname.replace(/^\/+|\/+$/g, '');
  } else if (/^https?:\/\//i.test(rawEndpoint)) {
    const parsed = new URL(rawEndpoint);
    if (!bucket && parsed.pathname !== '/') {
      const [pathBucket, ...pathPrefix] = parsed.pathname.split('/').filter(Boolean);
      bucket = pathBucket ?? '';
      endpointPrefix = pathPrefix.join('/');
      parsed.pathname = '/';
    }
    endpoint = parsed.toString().replace(/\/$/, '');
  } else {
    throw new Error('AXIOM_OBJECT_STORAGE_ENDPOINT must use s3://, http://, or https://.');
  }

  if (!bucket) throw new Error('AXIOM_OBJECT_STORAGE_BUCKET is required when the endpoint does not include a bucket.');
  const configuredPrefix = process.env.AXIOM_OBJECT_STORAGE_PREFIX?.trim();
  const serverSideEncryption = process.env.AXIOM_OBJECT_STORAGE_SSE?.trim();
  if (serverSideEncryption && serverSideEncryption !== 'AES256' && serverSideEncryption !== 'aws:kms') {
    throw new Error('AXIOM_OBJECT_STORAGE_SSE must be AES256 or aws:kms.');
  }
  return {
    bucket,
    endpoint,
    region: process.env.AXIOM_OBJECT_STORAGE_REGION?.trim() || 'us-east-1',
    prefix: configuredPrefix || endpointPrefix || 'axiom-artifacts',
    forcePathStyle: process.env.AXIOM_OBJECT_STORAGE_FORCE_PATH_STYLE === undefined
      ? Boolean(endpoint)
      : enabled(process.env.AXIOM_OBJECT_STORAGE_FORCE_PATH_STYLE),
    accessKeyId: process.env.AXIOM_OBJECT_STORAGE_ACCESS_KEY?.trim() || process.env.AWS_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.AXIOM_OBJECT_STORAGE_SECRET_KEY?.trim() || process.env.AWS_SECRET_ACCESS_KEY?.trim(),
    sessionToken: process.env.AXIOM_OBJECT_STORAGE_SESSION_TOKEN?.trim() || process.env.AWS_SESSION_TOKEN?.trim(),
    ...(serverSideEncryption ? { serverSideEncryption: serverSideEncryption as 'AES256' | 'aws:kms' } : {}),
  };
};

export const createArtifactStore = (): ArtifactStore | null => {
  const s3Config = s3ArtifactConfigFromEnv();
  if (s3Config) return new S3ArtifactStore(s3Config);
  const root = process.env.AXIOM_OBJECT_STORAGE_PATH?.trim();
  return root ? new FileArtifactStore(root) : null;
};
