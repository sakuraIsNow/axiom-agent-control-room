import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { z } from 'zod';
import type { ProviderLocation } from './providerLocation.js';

export const providerOverrideSchema = z.object({
  credentialId: z.string().uuid().optional(),
  apiKey: z.string().max(2_000).optional(),
  apiUrl: z.string().url().max(2_000).optional(),
  model: z.string().min(1).max(160).optional(),
  location: z.enum(['internet', 'local']).optional(),
}).strict();
export const providerConfigSchema = z.object({
  text: providerOverrideSchema.optional(), vision: providerOverrideSchema.optional(),
  image: providerOverrideSchema.optional(), video: providerOverrideSchema.optional(),
}).strict();
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type BoundProviderKind = keyof ProviderConfig | 'search';
export type BoundProvider = { apiKey: string; baseUrl: string; model: string; location: ProviderLocation };
export type BoundProviderBundle = Record<BoundProviderKind, BoundProvider | null>;
export type ProviderBindingOwner = { tenantId: string; userId: string; providerBindingId?: string };
export type ProviderBindingReference = { providerBindingId: string; model?: string; capabilities?: Record<'vision' | 'image' | 'video' | 'search', boolean> };
export const providerBindingReference = (providerBindingId: string, bundle: BoundProviderBundle): ProviderBindingReference => ({
  providerBindingId, ...(bundle.text ? { model: bundle.text.model } : {}),
  capabilities: { vision: Boolean(bundle.vision), image: Boolean(bundle.image), video: Boolean(bundle.video), search: Boolean(bundle.search) },
});

const encryptionKey = () => {
  const secret = process.env.AXIOM_PROVIDER_SECRET?.trim();
  if (!secret) throw new Error('AXIOM_PROVIDER_SECRET is required to preserve resumable model configuration.');
  return createHash('sha256').update(secret).digest();
};

// The entire endpoint/model/secret bundle is encrypted. Task records contain
// only its immutable owner-scoped reference, never a mutable credential copy.
export class ProviderBindingStore {
  private readonly pool?: Pool;
  private readonly db?: DatabaseSync;
  constructor(options: { databaseUrl?: string; sqlitePath?: string } = {}) {
    if (options.databaseUrl) this.pool = new Pool({ connectionString: options.databaseUrl, max: 3,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
    else {
      const path = options.sqlitePath ?? ':memory:';
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path);
    }
  }
  async initialize() {
    const sql = `CREATE TABLE IF NOT EXISTS provider_bindings (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      encrypted_bundle TEXT NOT NULL, created_at TEXT NOT NULL
    )`;
    if (this.pool) await this.pool.query(sql); else this.db!.exec(sql);
  }
  async close() { if (this.pool) await this.pool.end(); else this.db!.close(); }
  async create(owner: ProviderBindingOwner, bundle: BoundProviderBundle): Promise<ProviderBindingReference> {
    const id = randomUUID();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
    cipher.setAAD(Buffer.from(`${owner.tenantId}:${owner.userId}:${id}`));
    const payload = Buffer.concat([cipher.update(JSON.stringify(bundle)), cipher.final()]);
    const encrypted = [nonce, payload, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
    const values = [id, owner.tenantId, owner.userId, encrypted, new Date().toISOString()];
    if (this.pool) await this.pool.query('INSERT INTO provider_bindings VALUES ($1,$2,$3,$4,$5)', values);
    else this.db!.prepare('INSERT INTO provider_bindings VALUES (?,?,?,?,?)').run(...values);
    return providerBindingReference(id, bundle);
  }
  async get(owner: ProviderBindingOwner): Promise<BoundProviderBundle> {
    if (!owner.providerBindingId) throw new Error('Task model configuration has no durable binding.');
    const values = [owner.providerBindingId, owner.tenantId, owner.userId];
    const row = this.pool
      ? (await this.pool.query('SELECT encrypted_bundle FROM provider_bindings WHERE id=$1 AND tenant_id=$2 AND user_id=$3', values)).rows[0]
      : this.db!.prepare('SELECT encrypted_bundle FROM provider_bindings WHERE id=? AND tenant_id=? AND user_id=?').get(...values);
    if (!row) throw new Error('Task model configuration is unavailable or not owned by the current user.');
    try {
      const [nonce, payload, tag] = String(row.encrypted_bundle).split('.').map((part) => Buffer.from(part, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce);
      decipher.setAAD(Buffer.from(`${owner.tenantId}:${owner.userId}:${owner.providerBindingId}`));
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8')) as BoundProviderBundle;
    } catch { throw new Error('Stored task model configuration could not be decrypted. Check the original provider secret.'); }
  }
  async resolve(owner: ProviderBindingOwner, kind: BoundProviderKind) { return (await this.get(owner))[kind] ?? null; }
}

export const createProviderBindingStore = () => new ProviderBindingStore({
  databaseUrl: process.env.DATABASE_URL?.trim(),
  sqlitePath: process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'),
});
