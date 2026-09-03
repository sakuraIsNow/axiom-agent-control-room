import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

export type IntegrationCredentialInput = {
  tenantId: string;
  userId: string;
  provider: string;
  name: string;
  authType: 'api-key' | 'oauth2' | 'service-account';
  secrets: Record<string, string>;
  metadata?: Record<string, unknown>;
};

export type IntegrationCredentialPublic = Omit<IntegrationCredentialInput, 'tenantId' | 'userId' | 'secrets'> & {
  id: string;
  ownerId: string;
  secretFields: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

export type IntegrationCredentialResolved = IntegrationCredentialPublic & { secrets: Record<string, string> };

type CredentialRow = IntegrationCredentialPublic & { tenantId: string; encryptedSecrets: string };

const encryptionKey = () => {
  const secret = process.env.AXIOM_INTEGRATION_SECRET?.trim() || process.env.AXIOM_PROVIDER_SECRET?.trim();
  if (!secret) throw new Error('AXIOM_INTEGRATION_SECRET or AXIOM_PROVIDER_SECRET is required for integration credentials.');
  if (secret.length < 32) throw new Error('Integration credential encryption secret must contain at least 32 characters.');
  return createHash('sha256').update(secret, 'utf8').digest();
};

const encrypt = (value: Record<string, string>, aad: string) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [nonce, encrypted, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
};

const decrypt = (value: string, aad: string) => {
  const [nonce, encrypted, tag] = value.split('.');
  if (!nonce || !encrypted || !tag) throw new Error('Stored integration credential is malformed.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(nonce, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Stored integration credential payload is invalid.');
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
};

const publicRecord = (row: CredentialRow): IntegrationCredentialPublic => {
  const { tenantId: _tenantId, encryptedSecrets: _encryptedSecrets, ...visible } = row;
  return visible;
};

const fromSqlite = (row: Record<string, unknown>): CredentialRow => ({
  id: String(row.id), tenantId: String(row.tenant_id), ownerId: String(row.owner_id), provider: String(row.provider),
  name: String(row.name), authType: String(row.auth_type) as IntegrationCredentialInput['authType'],
  metadata: JSON.parse(String(row.metadata_json ?? '{}')) as Record<string, unknown>,
  secretFields: JSON.parse(String(row.secret_fields_json ?? '[]')) as string[], encryptedSecrets: String(row.encrypted_secrets),
  createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}),
});

const fromPostgres = (row: Record<string, unknown>): CredentialRow => ({
  id: String(row.id), tenantId: String(row.tenant_id), ownerId: String(row.owner_id), provider: String(row.provider),
  name: String(row.name), authType: String(row.auth_type) as IntegrationCredentialInput['authType'],
  metadata: (row.metadata_json ?? {}) as Record<string, unknown>, secretFields: (row.secret_fields_json ?? []) as string[],
  encryptedSecrets: String(row.encrypted_secrets), createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(), ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}),
});

export interface IntegrationCredentialStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  list(tenantId: string, ownerId?: string): Promise<IntegrationCredentialPublic[]>;
  upsert(input: IntegrationCredentialInput, id?: string): Promise<IntegrationCredentialPublic>;
  get(id: string, tenantId: string): Promise<IntegrationCredentialResolved | null>;
  touch(id: string, tenantId: string): Promise<void>;
  delete(id: string, tenantId: string): Promise<boolean>;
}

class SqliteIntegrationCredentialStore implements IntegrationCredentialStore {
  private readonly db: DatabaseSync;
  constructor(path: string) { if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path); }
  async initialize() { this.db.exec(`
    CREATE TABLE IF NOT EXISTS integration_credentials (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL,
      auth_type TEXT NOT NULL, metadata_json TEXT NOT NULL, secret_fields_json TEXT NOT NULL, encrypted_secrets TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_integration_credentials_scope ON integration_credentials(tenant_id, owner_id, provider, updated_at DESC);
  `); }
  async close() { this.db.close(); }
  async list(tenantId: string, ownerId?: string) {
    const rows = this.db.prepare(`SELECT * FROM integration_credentials WHERE tenant_id = ?${ownerId ? ' AND owner_id = ?' : ''} ORDER BY updated_at DESC`)
      .all(...(ownerId ? [tenantId, ownerId] : [tenantId])) as Array<Record<string, unknown>>;
    return rows.map(fromSqlite).map(publicRecord);
  }
  async upsert(input: IntegrationCredentialInput, id: string = randomUUID()) {
    const existing = this.db.prepare('SELECT tenant_id, created_at FROM integration_credentials WHERE id = ?').get(id) as { tenant_id?: string; created_at?: string } | undefined;
    if (existing && existing.tenant_id !== input.tenantId) throw new Error('Credential id already belongs to another tenant.');
    const now = new Date().toISOString();
    const secretFields = Object.keys(input.secrets).sort();
    const encryptedSecrets = encrypt(input.secrets, `${input.tenantId}:${id}:${input.provider}`);
    this.db.prepare(`INSERT INTO integration_credentials (id, tenant_id, owner_id, provider, name, auth_type, metadata_json, secret_fields_json, encrypted_secrets, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, provider=excluded.provider, name=excluded.name, auth_type=excluded.auth_type,
        metadata_json=excluded.metadata_json, secret_fields_json=excluded.secret_fields_json, encrypted_secrets=excluded.encrypted_secrets, updated_at=excluded.updated_at
      WHERE integration_credentials.tenant_id = excluded.tenant_id`)
      .run(id, input.tenantId, input.userId, input.provider, input.name, input.authType, JSON.stringify(input.metadata ?? {}), JSON.stringify(secretFields), encryptedSecrets, existing?.created_at ?? now, now);
    const stored = this.db.prepare('SELECT * FROM integration_credentials WHERE id = ? AND tenant_id = ?').get(id, input.tenantId) as Record<string, unknown> | undefined;
    if (!stored) throw new Error('Credential update was rejected by tenant isolation.');
    return publicRecord(fromSqlite(stored));
  }
  async get(id: string, tenantId: string) {
    const row = this.db.prepare('SELECT * FROM integration_credentials WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const parsed = fromSqlite(row);
    return { ...publicRecord(parsed), secrets: decrypt(parsed.encryptedSecrets, `${tenantId}:${id}:${parsed.provider}`) };
  }
  async touch(id: string, tenantId: string) { this.db.prepare('UPDATE integration_credentials SET last_used_at = ? WHERE id = ? AND tenant_id = ?').run(new Date().toISOString(), id, tenantId); }
  async delete(id: string, tenantId: string) { return this.db.prepare('DELETE FROM integration_credentials WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes > 0; }
}

export class PostgresIntegrationCredentialStore implements IntegrationCredentialStore {
  private readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) }); }
  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('axiom_integration_credentials_schema_v1'))");
      await client.query(`CREATE TABLE IF NOT EXISTS integration_credentials (
        id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL,
        auth_type TEXT NOT NULL, metadata_json JSONB NOT NULL, secret_fields_json JSONB NOT NULL, encrypted_secrets TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, last_used_at TIMESTAMPTZ
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS idx_integration_credentials_scope ON integration_credentials(tenant_id, owner_id, provider, updated_at DESC)');
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('axiom_integration_credentials_schema_v1'))").catch(() => undefined);
      client.release();
    }
  }
  async close() { await this.pool.end(); }
  async list(tenantId: string, ownerId?: string) {
    const result = await this.pool.query(`SELECT * FROM integration_credentials WHERE tenant_id = $1${ownerId ? ' AND owner_id = $2' : ''} ORDER BY updated_at DESC`, ownerId ? [tenantId, ownerId] : [tenantId]);
    return result.rows.map((row) => publicRecord(fromPostgres(row as Record<string, unknown>)));
  }
  async upsert(input: IntegrationCredentialInput, id: string = randomUUID()) {
    const now = new Date().toISOString();
    const fields = Object.keys(input.secrets).sort();
    const encryptedSecrets = encrypt(input.secrets, `${input.tenantId}:${id}:${input.provider}`);
    const result = await this.pool.query(`INSERT INTO integration_credentials
      (id, tenant_id, owner_id, provider, name, auth_type, metadata_json, secret_fields_json, encrypted_secrets, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$10)
      ON CONFLICT (id) DO UPDATE SET owner_id=EXCLUDED.owner_id, provider=EXCLUDED.provider, name=EXCLUDED.name, auth_type=EXCLUDED.auth_type,
        metadata_json=EXCLUDED.metadata_json, secret_fields_json=EXCLUDED.secret_fields_json, encrypted_secrets=EXCLUDED.encrypted_secrets, updated_at=EXCLUDED.updated_at
      WHERE integration_credentials.tenant_id = EXCLUDED.tenant_id
      RETURNING *`, [id, input.tenantId, input.userId, input.provider, input.name, input.authType, JSON.stringify(input.metadata ?? {}), JSON.stringify(fields), encryptedSecrets, now]);
    if (!result.rows[0]) throw new Error('Credential update was rejected by tenant isolation.');
    return publicRecord(fromPostgres(result.rows[0] as Record<string, unknown>));
  }
  async get(id: string, tenantId: string) {
    const result = await this.pool.query('SELECT * FROM integration_credentials WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (!result.rows[0]) return null;
    const parsed = fromPostgres(result.rows[0] as Record<string, unknown>);
    return { ...publicRecord(parsed), secrets: decrypt(parsed.encryptedSecrets, `${tenantId}:${id}:${parsed.provider}`) };
  }
  async touch(id: string, tenantId: string) { await this.pool.query('UPDATE integration_credentials SET last_used_at = NOW() WHERE id = $1 AND tenant_id = $2', [id, tenantId]); }
  async delete(id: string, tenantId: string) { const result = await this.pool.query('DELETE FROM integration_credentials WHERE id = $1 AND tenant_id = $2', [id, tenantId]); return (result.rowCount ?? 0) > 0; }
}

export const createIntegrationCredentialStore = (): IntegrationCredentialStore => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return new PostgresIntegrationCredentialStore(databaseUrl);
  return new SqliteIntegrationCredentialStore(process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'));
};

export const createMemoryIntegrationCredentialStore = () => new SqliteIntegrationCredentialStore(':memory:');
