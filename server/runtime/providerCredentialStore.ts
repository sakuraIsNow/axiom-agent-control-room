import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import type { ProviderLocation } from './providerLocation.js';

export type ProviderCredentialKind = 'text' | 'vision' | 'image' | 'video';

export type ProviderCredentialInput = {
  tenantId: string;
  userId: string;
  kind: ProviderCredentialKind;
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  location: ProviderLocation;
};

export type ProviderCredentialPublic = Omit<ProviderCredentialInput, 'apiKey' | 'tenantId' | 'userId'> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  hasApiKey: boolean;
};

export type ProviderCredentialResolved = ProviderCredentialPublic & { apiKey: string };

type CredentialRow = Omit<ProviderCredentialInput, 'apiKey'> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  hasApiKey: boolean;
  encryptedApiKey: string;
};

const keyFromSecret = () => {
  const secret = process.env.AXIOM_PROVIDER_SECRET?.trim();
  if (!secret) throw new Error('AXIOM_PROVIDER_SECRET is required for encrypted provider credentials.');
  return createHash('sha256').update(secret, 'utf8').digest();
};

const encrypt = (value: string, aad: string) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(), nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [nonce, encrypted, tag].map((part) => part.toString('base64url')).join('.');
};

const decrypt = (value: string, aad: string) => {
  const [nonceEncoded, encryptedEncoded, tagEncoded] = value.split('.');
  if (!nonceEncoded || !encryptedEncoded || !tagEncoded) throw new Error('Stored provider credential is malformed.');
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(), Buffer.from(nonceEncoded, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
};

const toPublic = (row: CredentialRow): ProviderCredentialPublic => {
  const { encryptedApiKey: _encryptedApiKey, tenantId: _tenantId, userId: _userId, ...publicRecord } = row;
  return publicRecord;
};

const rowFromPostgres = (row: Record<string, unknown>): CredentialRow => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  userId: String(row.user_id),
  kind: row.kind as ProviderCredentialKind,
  name: String(row.name),
  apiUrl: String(row.api_url),
  model: String(row.model),
  location: row.location as ProviderLocation,
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
  ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}),
  hasApiKey: Boolean(row.encrypted_api_key),
  encryptedApiKey: String(row.encrypted_api_key ?? ''),
});

const sqliteDate = (value: unknown) => new Date(String(value)).toISOString();

const rowFromSqlite = (row: Record<string, unknown>): CredentialRow => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  userId: String(row.user_id),
  kind: row.kind as ProviderCredentialKind,
  name: String(row.name),
  apiUrl: String(row.api_url),
  model: String(row.model),
  location: row.location as ProviderLocation,
  createdAt: sqliteDate(row.created_at),
  updatedAt: sqliteDate(row.updated_at),
  ...(row.last_used_at ? { lastUsedAt: sqliteDate(row.last_used_at) } : {}),
  hasApiKey: Boolean(row.encrypted_api_key),
  encryptedApiKey: String(row.encrypted_api_key ?? ''),
});

export interface ProviderCredentialStore {
  initialize(): Promise<void>;
  close?(): Promise<void>;
  list(tenantId: string, userId: string, kind?: ProviderCredentialKind): Promise<ProviderCredentialPublic[]>;
  upsert(input: ProviderCredentialInput, id?: string): Promise<ProviderCredentialPublic>;
  get(id: string, tenantId: string, userId: string): Promise<ProviderCredentialResolved | null>;
  touch(id: string, tenantId: string, userId: string): Promise<void>;
  delete(id: string, tenantId: string, userId: string): Promise<boolean>;
}

class PostgresProviderCredentialStore implements ProviderCredentialStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    });
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS provider_credentials (
        id UUID PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        api_url TEXT NOT NULL,
        model TEXT NOT NULL,
        location TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_provider_credentials_owner
        ON provider_credentials(tenant_id, user_id, kind, updated_at DESC);
    `);
  }

  async close() {
    await this.pool.end();
  }

  async list(tenantId: string, userId: string, kind?: ProviderCredentialKind) {
    const result = await this.pool.query(
      `SELECT * FROM provider_credentials
       WHERE tenant_id = $1 AND user_id = $2 ${kind ? 'AND kind = $3' : ''}
       ORDER BY updated_at DESC`,
      kind ? [tenantId, userId, kind] : [tenantId, userId],
    );
    return result.rows.map((row) => toPublic(rowFromPostgres(row as Record<string, unknown>)));
  }

  async upsert(input: ProviderCredentialInput, id = randomUUID()) {
    const now = new Date().toISOString();
    const encryptedApiKey = encrypt(input.apiKey, `${input.tenantId}:${id}`);
    const result = await this.pool.query(`
      INSERT INTO provider_credentials (
        id, tenant_id, user_id, kind, name, api_url, model, location,
        encrypted_api_key, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        api_url = EXCLUDED.api_url,
        model = EXCLUDED.model,
        location = EXCLUDED.location,
        encrypted_api_key = EXCLUDED.encrypted_api_key,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `, [id, input.tenantId, input.userId, input.kind, input.name, input.apiUrl, input.model, input.location, encryptedApiKey, now]);
    return toPublic(rowFromPostgres(result.rows[0] as Record<string, unknown>));
  }

  async get(id: string, tenantId: string, userId: string) {
    const result = await this.pool.query(
      'SELECT * FROM provider_credentials WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
      [id, tenantId, userId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const record = rowFromPostgres(row);
    return { ...toPublic(record), apiKey: decrypt(record.encryptedApiKey, `${tenantId}:${id}`) };
  }

  async touch(id: string, tenantId: string, userId: string) {
    await this.pool.query(
      'UPDATE provider_credentials SET last_used_at = NOW() WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
      [id, tenantId, userId],
    );
  }

  async delete(id: string, tenantId: string, userId: string) {
    const result = await this.pool.query(
      'DELETE FROM provider_credentials WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
      [id, tenantId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

class SqliteProviderCredentialStore implements ProviderCredentialStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  async initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_credentials (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        api_url TEXT NOT NULL,
        model TEXT NOT NULL,
        location TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_provider_credentials_owner
        ON provider_credentials(tenant_id, user_id, kind, updated_at DESC);
    `);
  }

  async close() {
    this.db.close();
  }

  async list(tenantId: string, userId: string, kind?: ProviderCredentialKind) {
    const query = kind
      ? 'SELECT * FROM provider_credentials WHERE tenant_id = ? AND user_id = ? AND kind = ? ORDER BY updated_at DESC'
      : 'SELECT * FROM provider_credentials WHERE tenant_id = ? AND user_id = ? ORDER BY updated_at DESC';
    const rows = this.db.prepare(query).all(...(kind ? [tenantId, userId, kind] : [tenantId, userId])) as Array<Record<string, unknown>>;
    return rows.map((row) => toPublic(rowFromSqlite(row)));
  }

  async upsert(input: ProviderCredentialInput, id = randomUUID()) {
    const now = new Date().toISOString();
    const encryptedApiKey = encrypt(input.apiKey, `${input.tenantId}:${id}`);
    this.db.prepare(`
      INSERT INTO provider_credentials (
        id, tenant_id, user_id, kind, name, api_url, model, location,
        encrypted_api_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        api_url = excluded.api_url,
        model = excluded.model,
        location = excluded.location,
        encrypted_api_key = excluded.encrypted_api_key,
        updated_at = excluded.updated_at
    `).run(id, input.tenantId, input.userId, input.kind, input.name, input.apiUrl, input.model, input.location, encryptedApiKey, now, now);
    const row = this.db.prepare('SELECT * FROM provider_credentials WHERE id = ?').get(id) as Record<string, unknown>;
    return toPublic(rowFromSqlite(row));
  }

  async get(id: string, tenantId: string, userId: string) {
    const row = this.db.prepare('SELECT * FROM provider_credentials WHERE id = ? AND tenant_id = ? AND user_id = ?').get(id, tenantId, userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const record = rowFromSqlite(row);
    return { ...toPublic(record), apiKey: decrypt(record.encryptedApiKey, `${tenantId}:${id}`) };
  }

  async touch(id: string, tenantId: string, userId: string) {
    this.db.prepare('UPDATE provider_credentials SET last_used_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ?').run(new Date().toISOString(), id, tenantId, userId);
  }

  async delete(id: string, tenantId: string, userId: string) {
    const result = this.db.prepare('DELETE FROM provider_credentials WHERE id = ? AND tenant_id = ? AND user_id = ?').run(id, tenantId, userId);
    return result.changes > 0;
  }
}

export const createProviderCredentialStore = (): ProviderCredentialStore => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return new PostgresProviderCredentialStore(databaseUrl);
  return new SqliteProviderCredentialStore(process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'));
};
