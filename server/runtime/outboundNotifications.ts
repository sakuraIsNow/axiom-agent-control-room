import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import type { InAppNotification, InAppNotificationKind } from './contracts.js';

export type NotificationEndpointLocation = 'internet' | 'local';
export type OutboundDeliveryStatus = 'pending' | 'delivering' | 'retrying' | 'delivered' | 'dead_letter';
const maxDeliveryAttempts = 5;
const deliveryLeaseMs = (value: number) => Number.isFinite(value) ? Math.min(120_000, Math.max(1_000, value)) : 30_000;

export const outboundNotificationKinds: InAppNotificationKind[] = [
  'approval_required',
  'task_completed',
  'partial_delivery',
  'task_failed',
  'plugin_failed',
  'schedule_dead_letter',
  'artifact_cleanup_failed',
];

export type OutboundNotificationChannel = {
  id: string;
  name: string;
  type: 'webhook';
  location: NotificationEndpointLocation;
  endpointDisplay: string;
  eventKinds: InAppNotificationKind[];
  enabled: boolean;
  hasSigningSecret: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OutboundNotificationChannelInput = {
  tenantId: string;
  userId: string;
  name: string;
  endpoint: string;
  signingSecret: string;
  location: NotificationEndpointLocation;
  eventKinds: InAppNotificationKind[];
  enabled: boolean;
};

type ResolvedOutboundNotificationChannel = OutboundNotificationChannel & {
  tenantId: string;
  userId: string;
  endpoint: string;
  signingSecret: string;
};

export type OutboundNotificationDelivery = {
  id: string;
  channelId: string;
  channelName: string;
  endpointDisplay: string;
  notificationId: string;
  eventKind: InAppNotificationKind | 'test';
  status: OutboundDeliveryStatus;
  attemptCount: number;
  totalAttempts: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  responseStatus?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

type StoredDelivery = OutboundNotificationDelivery & {
  tenantId: string;
  userId: string;
  payload: InAppNotification;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
};

type ChannelRow = {
  id: unknown; tenant_id: unknown; user_id: unknown; name: unknown; location: unknown;
  endpoint_display: unknown; encrypted_config: unknown; event_kinds_json: unknown; enabled: unknown;
  created_at: unknown; updated_at: unknown;
};

type DeliveryRow = {
  id: unknown; tenant_id: unknown; user_id: unknown; channel_id: unknown; channel_name: unknown;
  endpoint_display: unknown; notification_id: unknown; event_kind: unknown; payload_json: unknown; status: unknown;
  attempt_count: unknown; total_attempts: unknown; next_attempt_at: unknown; last_attempt_at: unknown;
  delivered_at: unknown; response_status: unknown; last_error: unknown; lease_owner: unknown;
  lease_expires_at: unknown; lease_token?: unknown; created_at: unknown; updated_at: unknown;
};

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const json = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const bool = (value: unknown) => value === true || value === 1 || value === '1';
const boundedError = (value: unknown) => String(value instanceof Error ? value.message : value ?? '投递失败').replace(/https?:\/\/\S+/giu, '[已隐藏地址]').slice(0, 1_000);

const secretKey = (explicit?: string) => {
  const secret = explicit?.trim() || process.env.AXIOM_NOTIFICATION_SECRET?.trim() || process.env.AXIOM_PROVIDER_SECRET?.trim();
  if (!secret) throw new Error('保存通知渠道前需要配置 AXIOM_NOTIFICATION_SECRET。');
  return createHash('sha256').update(secret, 'utf8').digest();
};

const encryptConfig = (config: { endpoint: string; signingSecret: string }, aad: string, secret?: string) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(secret), nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return [nonce, encrypted, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
};

const decryptConfig = (value: string, aad: string, secret?: string) => {
  const [nonce, encrypted, tag] = value.split('.');
  if (!nonce || !encrypted || !tag) throw new Error('通知渠道密文无效。');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(secret), Buffer.from(nonce, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8')) as { endpoint: string; signingSecret: string };
};

const privateAddress = (address: string) => {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const version = isIP(normalized);
  if (version === 4) {
    const [first = 0, second = 0] = normalized.split('.').map(Number);
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127);
  }
  if (version === 6) {
    return normalized === '::' || normalized === '::1'
      || /^(?:fc|fd|fe[89ab])/iu.test(normalized)
      || /^::ffff:(?:0:)?(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/iu.test(normalized);
  }
  return false;
};

export const normalizeWebhookEndpoint = (raw: string, location: NotificationEndpointLocation) => {
  if (raw.length > 2_048) throw new Error('Webhook URL 过长。');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Webhook URL 无效。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Webhook 只支持 HTTP 或 HTTPS。');
  if (url.username || url.password || url.hash) throw new Error('Webhook URL 不能包含账号、密码或片段。');
  if (location === 'internet' && url.protocol !== 'https:') throw new Error('公网 Webhook 必须使用 HTTPS。');
  if (location === 'internet' && (privateAddress(url.hostname) || ['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase()))) {
    throw new Error('公网 Webhook 不能指向本机或私有网络。');
  }
  return url.toString();
};

const endpointDisplay = (endpoint: string) => {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : '/…'}`;
};

const channelFromRow = (row: ChannelRow): OutboundNotificationChannel & { tenantId: string; userId: string; encryptedConfig: string } => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  userId: String(row.user_id),
  name: String(row.name),
  type: 'webhook',
  location: row.location === 'local' ? 'local' : 'internet',
  endpointDisplay: String(row.endpoint_display),
  eventKinds: json<InAppNotificationKind[]>(row.event_kinds_json, []).filter((kind) => outboundNotificationKinds.includes(kind)),
  enabled: bool(row.enabled),
  hasSigningSecret: true,
  encryptedConfig: String(row.encrypted_config),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const deliveryFromRow = (row: DeliveryRow): StoredDelivery => ({
  id: String(row.id), tenantId: String(row.tenant_id), userId: String(row.user_id),
  channelId: String(row.channel_id), channelName: String(row.channel_name), endpointDisplay: String(row.endpoint_display),
  notificationId: String(row.notification_id), eventKind: String(row.event_kind) as StoredDelivery['eventKind'],
  payload: json<InAppNotification>(row.payload_json, {} as InAppNotification), status: String(row.status) as OutboundDeliveryStatus,
  attemptCount: Number(row.attempt_count ?? 0), totalAttempts: Number(row.total_attempts ?? 0), nextAttemptAt: iso(row.next_attempt_at),
  ...(row.last_attempt_at ? { lastAttemptAt: iso(row.last_attempt_at) } : {}),
  ...(row.delivered_at ? { deliveredAt: iso(row.delivered_at) } : {}),
  ...(row.response_status !== null && row.response_status !== undefined ? { responseStatus: Number(row.response_status) } : {}),
  ...(row.last_error ? { lastError: String(row.last_error) } : {}),
  ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
  ...(row.lease_token ? { leaseToken: String(row.lease_token) } : {}),
  ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});

const publicDelivery = ({ tenantId: _tenantId, userId: _userId, payload: _payload, leaseOwner: _leaseOwner, leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt, ...delivery }: StoredDelivery): OutboundNotificationDelivery => delivery;
const publicChannel = ({ tenantId: _tenantId, userId: _userId, encryptedConfig: _encryptedConfig, ...channel }: ReturnType<typeof channelFromRow>): OutboundNotificationChannel => channel;

export interface OutboundNotificationStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listOwners(): Promise<Array<{ tenantId: string; userId: string }>>;
  listChannels(tenantId: string, userId: string): Promise<OutboundNotificationChannel[]>;
  getChannel(id: string, tenantId: string, userId: string): Promise<ResolvedOutboundNotificationChannel | null>;
  saveChannel(input: OutboundNotificationChannelInput, id?: string): Promise<OutboundNotificationChannel>;
  deleteChannel(id: string, tenantId: string, userId: string): Promise<boolean>;
  enqueue(tenantId: string, userId: string, notification: InAppNotification, channelId?: string): Promise<string[]>;
  listDeliveries(tenantId: string, userId: string, limit?: number): Promise<OutboundNotificationDelivery[]>;
  getDelivery(id: string, tenantId: string, userId: string): Promise<OutboundNotificationDelivery | null>;
  claimNext(workerId: string, leaseMs: number, id?: string): Promise<StoredDelivery | null>;
  markDelivered(id: string, workerId: string, leaseToken: string, responseStatus: number): Promise<void>;
  markFailed(id: string, workerId: string, leaseToken: string, error: string, responseStatus?: number, terminal?: boolean): Promise<void>;
  retry(id: string, tenantId: string, userId: string): Promise<boolean>;
  pruneDeliveries(before: string, limit?: number): Promise<number>;
}

export class SqliteOutboundNotificationStore implements OutboundNotificationStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly encryptionSecret?: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  async initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS outbound_notification_channels (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
        location TEXT NOT NULL, endpoint_display TEXT NOT NULL, encrypted_config TEXT NOT NULL,
        event_kinds_json TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_channels_owner ON outbound_notification_channels(tenant_id, user_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS outbound_notification_deliveries (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL, endpoint_display TEXT NOT NULL, notification_id TEXT NOT NULL,
        event_kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
        total_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_attempt_at TEXT,
        delivered_at TEXT, response_status INTEGER, last_error TEXT, lease_owner TEXT, lease_expires_at TEXT, lease_token TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(channel_id, notification_id)
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_due ON outbound_notification_deliveries(status, next_attempt_at, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_owner ON outbound_notification_deliveries(tenant_id, user_id, created_at DESC);
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const channelColumns = this.db.prepare('PRAGMA table_info(outbound_notification_channels)').all() as Array<{ name: string }>;
      if (!channelColumns.some((column) => column.name === 'deleted_at')) this.db.exec('ALTER TABLE outbound_notification_channels ADD COLUMN deleted_at TEXT');
      const deliveryColumns = this.db.prepare('PRAGMA table_info(outbound_notification_deliveries)').all() as Array<{ name: string }>;
      if (!deliveryColumns.some((column) => column.name === 'lease_token')) {
        this.db.exec(`ALTER TABLE outbound_notification_deliveries ADD COLUMN lease_token TEXT;
          UPDATE outbound_notification_deliveries SET attempt_count=attempt_count+1,total_attempts=total_attempts+1 WHERE status='delivering';`);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  async close() { this.db.close(); }

  async listOwners() {
    return (this.db.prepare('SELECT DISTINCT tenant_id, user_id FROM outbound_notification_channels WHERE enabled = 1 AND deleted_at IS NULL').all() as Array<{ tenant_id: string; user_id: string }>)
      .map((row) => ({ tenantId: row.tenant_id, userId: row.user_id }));
  }

  async listChannels(tenantId: string, userId: string) {
    return (this.db.prepare('SELECT * FROM outbound_notification_channels WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC').all(tenantId, userId) as unknown as ChannelRow[])
      .map(channelFromRow).map(publicChannel);
  }

  async getChannel(id: string, tenantId: string, userId: string) {
    const row = this.db.prepare('SELECT * FROM outbound_notification_channels WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL').get(id, tenantId, userId) as unknown as ChannelRow | undefined;
    if (!row) return null;
    const stored = channelFromRow(row);
    const config = decryptConfig(stored.encryptedConfig, `${tenantId}:${id}`, this.encryptionSecret);
    return { ...publicChannel(stored), tenantId, userId, ...config };
  }

  async saveChannel(input: OutboundNotificationChannelInput, id = randomUUID()) {
    const now = new Date().toISOString();
    const endpoint = normalizeWebhookEndpoint(input.endpoint, input.location);
    const kinds = [...new Set(input.eventKinds)].filter((kind) => outboundNotificationKinds.includes(kind));
    if (!kinds.length) throw new Error('至少选择一种通知事件。');
    if (input.signingSecret.trim().length < 16) throw new Error('Webhook 签名密钥至少需要 16 个字符。');
    const encrypted = encryptConfig({ endpoint, signingSecret: input.signingSecret.trim() }, `${input.tenantId}:${id}`, this.encryptionSecret);
    this.db.prepare(`
      INSERT INTO outbound_notification_channels(id, tenant_id, user_id, name, location, endpoint_display, encrypted_config, event_kinds_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, location = excluded.location, endpoint_display = excluded.endpoint_display,
        encrypted_config = excluded.encrypted_config, event_kinds_json = excluded.event_kinds_json, enabled = excluded.enabled, updated_at = excluded.updated_at, deleted_at = NULL
      WHERE outbound_notification_channels.tenant_id = excluded.tenant_id AND outbound_notification_channels.user_id = excluded.user_id
    `).run(id, input.tenantId, input.userId, input.name, input.location, endpointDisplay(endpoint), encrypted, JSON.stringify(kinds), input.enabled ? 1 : 0, now, now);
    const saved = await this.getChannel(id, input.tenantId, input.userId);
    if (!saved) throw new Error('通知渠道保存失败。');
    const { endpoint: _endpoint, signingSecret: _signingSecret, tenantId: _tenantId, userId: _userId, ...result } = saved;
    return result;
  }

  async deleteChannel(id: string, tenantId: string, userId: string) {
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE outbound_notification_channels SET enabled = 0, deleted_at = ?, updated_at = ?,
      encrypted_config = '', endpoint_display = '已删除', event_kinds_json = '[]', name = '已删除渠道'
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`).run(now, now, id, tenantId, userId).changes > 0;
  }

  async enqueue(tenantId: string, userId: string, notification: InAppNotification, channelId?: string) {
    const rows = this.db.prepare(`SELECT * FROM outbound_notification_channels WHERE tenant_id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL ${channelId ? 'AND id = ?' : ''}`)
      .all(...(channelId ? [tenantId, userId, channelId] : [tenantId, userId])) as unknown as ChannelRow[];
    const now = new Date().toISOString();
    const ids: string[] = [];
    const insert = this.db.prepare(`INSERT OR IGNORE INTO outbound_notification_deliveries(
      id, tenant_id, user_id, channel_id, channel_name, endpoint_display, notification_id, event_kind, payload_json,
      status, attempt_count, total_attempts, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?)`);
    for (const row of rows) {
      const channel = channelFromRow(row);
      const eventKind: InAppNotificationKind | 'test' = notification.id.startsWith('test:') ? 'test' : notification.kind;
      if (eventKind !== 'test' && !channel.eventKinds.includes(notification.kind)) continue;
      const id = randomUUID();
      const result = insert.run(id, tenantId, userId, channel.id, channel.name, channel.endpointDisplay, notification.id, eventKind, JSON.stringify(notification), now, now, now);
      if (result.changes > 0) ids.push(id);
    }
    return ids;
  }

  async listDeliveries(tenantId: string, userId: string, limit = 60) {
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    return (this.db.prepare('SELECT * FROM outbound_notification_deliveries WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, userId, safeLimit) as unknown as DeliveryRow[])
      .map(deliveryFromRow).map(publicDelivery);
  }

  async getDelivery(id: string, tenantId: string, userId: string) {
    const row = this.db.prepare('SELECT * FROM outbound_notification_deliveries WHERE id = ? AND tenant_id = ? AND user_id = ?').get(id, tenantId, userId) as unknown as DeliveryRow | undefined;
    return row ? publicDelivery(deliveryFromRow(row)) : null;
  }

  async claimNext(workerId: string, leaseMs: number, id?: string) {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + deliveryLeaseMs(leaseMs)).toISOString();
    const leaseToken = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Count attempts when claimed so repeated crashes cannot retry forever.
      this.db.prepare(`UPDATE outbound_notification_deliveries SET status = 'dead_letter',
        last_error = 'Delivery retry limit reached after an interrupted attempt.', lease_owner = NULL, lease_token = NULL,
        lease_expires_at = NULL, updated_at = ? WHERE status IN ('pending', 'retrying', 'delivering')
        AND attempt_count >= ? AND next_attempt_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ${id ? 'AND id = ?' : ''}`).run(...(id ? [nowIso, maxDeliveryAttempts, nowIso, nowIso, id] : [nowIso, maxDeliveryAttempts, nowIso, nowIso]));
      const row = this.db.prepare(`SELECT * FROM outbound_notification_deliveries
        WHERE status IN ('pending', 'retrying', 'delivering') AND next_attempt_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ${id ? 'AND id = ?' : ''} ORDER BY next_attempt_at ASC LIMIT 1`).get(...(id ? [nowIso, nowIso, id] : [nowIso, nowIso])) as unknown as DeliveryRow | undefined;
      if (!row) { this.db.exec('COMMIT'); return null; }
      this.db.prepare(`UPDATE outbound_notification_deliveries SET status = 'delivering', lease_owner = ?, lease_token = ?,
        lease_expires_at = ?, last_attempt_at = ?, updated_at = ?, attempt_count = attempt_count + 1, total_attempts = total_attempts + 1 WHERE id = ?`)
        .run(workerId, leaseToken, leaseExpiresAt, nowIso, nowIso, String(row.id));
      this.db.exec('COMMIT');
      return deliveryFromRow({ ...row, status: 'delivering', lease_owner: workerId, lease_token: leaseToken, lease_expires_at: leaseExpiresAt,
        last_attempt_at: nowIso, updated_at: nowIso, attempt_count: Number(row.attempt_count) + 1, total_attempts: Number(row.total_attempts) + 1 });
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async markDelivered(id: string, workerId: string, leaseToken: string, responseStatus: number) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE outbound_notification_deliveries SET status = 'delivered',
      response_status = ?, delivered_at = ?, last_error = NULL, lease_owner = NULL, lease_token = NULL,
      lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ? AND lease_token = ?
      AND status = 'delivering' AND lease_expires_at > ?`).run(responseStatus, now, now, id, workerId, leaseToken, now);
  }

  async markFailed(id: string, workerId: string, leaseToken: string, error: string, responseStatus?: number, terminal = false) {
    const now = new Date();
    const row = this.db.prepare(`SELECT attempt_count FROM outbound_notification_deliveries WHERE id = ? AND lease_owner = ?
      AND lease_token = ? AND status = 'delivering' AND lease_expires_at > ?`).get(id, workerId, leaseToken, now.toISOString()) as { attempt_count?: number } | undefined;
    if (!row) return;
    const attempts = Number(row.attempt_count ?? 0);
    const dead = terminal || attempts >= maxDeliveryAttempts;
    const delayMs = Math.min(60 * 60_000, 5_000 * (2 ** Math.max(0, attempts - 1)));
    this.db.prepare(`UPDATE outbound_notification_deliveries SET status = ?,
      next_attempt_at = ?, response_status = ?, last_error = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_token = ? AND status = 'delivering' AND lease_expires_at > ?`)
      .run(dead ? 'dead_letter' : 'retrying', new Date(now.getTime() + delayMs).toISOString(), responseStatus ?? null, boundedError(error), now.toISOString(), id, workerId, leaseToken, now.toISOString());
  }

  async retry(id: string, tenantId: string, userId: string) {
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE outbound_notification_deliveries SET status = 'pending', attempt_count = 0, next_attempt_at = ?,
      last_error = NULL, response_status = NULL, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'dead_letter'`).run(now, now, id, tenantId, userId).changes > 0;
  }

  async pruneDeliveries(before: string, limit = 1_000) {
    const result = this.db.prepare(`DELETE FROM outbound_notification_deliveries WHERE id IN (
      SELECT id FROM outbound_notification_deliveries WHERE status IN ('delivered', 'dead_letter') AND updated_at < ? ORDER BY updated_at ASC LIMIT ?
    )`).run(before, Math.min(10_000, Math.max(1, Math.floor(limit))));
    return Number(result.changes);
  }
}

export class PostgresOutboundNotificationStore implements OutboundNotificationStore {
  private readonly pool: Pool;
  constructor(connectionString: string, private readonly encryptionSecret?: string) {
    this.pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
  }
  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('axiom:outbound-notifications:schema'))");
      await client.query(`
      CREATE TABLE IF NOT EXISTS outbound_notification_channels (
        id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
        location TEXT NOT NULL, endpoint_display TEXT NOT NULL, encrypted_config TEXT NOT NULL,
        event_kinds_json JSONB NOT NULL, enabled BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_channels_owner ON outbound_notification_channels(tenant_id, user_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS outbound_notification_deliveries (
        id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id UUID NOT NULL,
        channel_name TEXT NOT NULL, endpoint_display TEXT NOT NULL, notification_id TEXT NOT NULL, event_kind TEXT NOT NULL,
        payload_json JSONB NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, total_attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL, last_attempt_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, response_status INTEGER,
        last_error TEXT, lease_owner TEXT, lease_expires_at TIMESTAMPTZ, lease_token TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(channel_id, notification_id)
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_due ON outbound_notification_deliveries(status, next_attempt_at, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_owner ON outbound_notification_deliveries(tenant_id, user_id, created_at DESC);
      ALTER TABLE outbound_notification_channels ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
          AND table_name='outbound_notification_deliveries' AND column_name='lease_token') THEN
          ALTER TABLE outbound_notification_deliveries ADD COLUMN lease_token TEXT;
          UPDATE outbound_notification_deliveries SET attempt_count=attempt_count+1,total_attempts=total_attempts+1 WHERE status='delivering';
        END IF;
      END $$;
      `);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async close() { await this.pool.end(); }
  async listOwners() {
    const result = await this.pool.query('SELECT DISTINCT tenant_id, user_id FROM outbound_notification_channels WHERE enabled = TRUE AND deleted_at IS NULL');
    return result.rows.map((row) => ({ tenantId: String(row.tenant_id), userId: String(row.user_id) }));
  }
  async listChannels(tenantId: string, userId: string) {
    const result = await this.pool.query('SELECT * FROM outbound_notification_channels WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL ORDER BY updated_at DESC', [tenantId, userId]);
    return result.rows.map((row) => publicChannel(channelFromRow(row as ChannelRow)));
  }
  async getChannel(id: string, tenantId: string, userId: string) {
    const result = await this.pool.query('SELECT * FROM outbound_notification_channels WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND deleted_at IS NULL', [id, tenantId, userId]);
    if (!result.rows[0]) return null;
    const stored = channelFromRow(result.rows[0] as ChannelRow);
    return { ...publicChannel(stored), tenantId, userId, ...decryptConfig(stored.encryptedConfig, `${tenantId}:${id}`, this.encryptionSecret) };
  }
  async saveChannel(input: OutboundNotificationChannelInput, id = randomUUID()) {
    const now = new Date().toISOString();
    const endpoint = normalizeWebhookEndpoint(input.endpoint, input.location);
    const kinds = [...new Set(input.eventKinds)].filter((kind) => outboundNotificationKinds.includes(kind));
    if (!kinds.length) throw new Error('至少选择一种通知事件。');
    if (input.signingSecret.trim().length < 16) throw new Error('Webhook 签名密钥至少需要 16 个字符。');
    const encrypted = encryptConfig({ endpoint, signingSecret: input.signingSecret.trim() }, `${input.tenantId}:${id}`, this.encryptionSecret);
    const result = await this.pool.query(`INSERT INTO outbound_notification_channels(
      id, tenant_id, user_id, name, location, endpoint_display, encrypted_config, event_kinds_json, enabled, created_at, updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
    ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, location=EXCLUDED.location, endpoint_display=EXCLUDED.endpoint_display,
      encrypted_config=EXCLUDED.encrypted_config, event_kinds_json=EXCLUDED.event_kinds_json, enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at, deleted_at=NULL
    WHERE outbound_notification_channels.tenant_id=EXCLUDED.tenant_id AND outbound_notification_channels.user_id=EXCLUDED.user_id RETURNING *`,
    [id, input.tenantId, input.userId, input.name, input.location, endpointDisplay(endpoint), encrypted, JSON.stringify(kinds), input.enabled, now]);
    if (!result.rows[0]) throw new Error('通知渠道保存失败。');
    return publicChannel(channelFromRow(result.rows[0] as ChannelRow));
  }
  async deleteChannel(id: string, tenantId: string, userId: string) {
    const result = await this.pool.query(`UPDATE outbound_notification_channels SET enabled=FALSE,deleted_at=NOW(),updated_at=NOW(),
      encrypted_config='',endpoint_display='已删除',event_kinds_json='[]'::jsonb,name='已删除渠道'
      WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND deleted_at IS NULL`, [id, tenantId, userId]);
    return (result.rowCount ?? 0) > 0;
  }
  async enqueue(tenantId: string, userId: string, notification: InAppNotification, channelId?: string) {
    const channels = await this.pool.query(`SELECT * FROM outbound_notification_channels WHERE tenant_id=$1 AND user_id=$2 AND enabled=TRUE AND deleted_at IS NULL ${channelId ? 'AND id=$3' : ''}`, channelId ? [tenantId, userId, channelId] : [tenantId, userId]);
    const now = new Date().toISOString();
    const ids: string[] = [];
    for (const raw of channels.rows) {
      const channel = channelFromRow(raw as ChannelRow);
      const eventKind: InAppNotificationKind | 'test' = notification.id.startsWith('test:') ? 'test' : notification.kind;
      if (eventKind !== 'test' && !channel.eventKinds.includes(notification.kind)) continue;
      const id = randomUUID();
      const result = await this.pool.query(`INSERT INTO outbound_notification_deliveries(
        id,tenant_id,user_id,channel_id,channel_name,endpoint_display,notification_id,event_kind,payload_json,status,next_attempt_at,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$10,$10) ON CONFLICT(channel_id,notification_id) DO NOTHING`,
      [id, tenantId, userId, channel.id, channel.name, channel.endpointDisplay, notification.id, eventKind, JSON.stringify(notification), now]);
      if ((result.rowCount ?? 0) > 0) ids.push(id);
    }
    return ids;
  }
  async listDeliveries(tenantId: string, userId: string, limit = 60) {
    const result = await this.pool.query('SELECT * FROM outbound_notification_deliveries WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3', [tenantId, userId, Math.min(200, Math.max(1, Math.floor(limit)))]);
    return result.rows.map((row) => publicDelivery(deliveryFromRow(row as DeliveryRow)));
  }
  async getDelivery(id: string, tenantId: string, userId: string) {
    const result = await this.pool.query('SELECT * FROM outbound_notification_deliveries WHERE id=$1 AND tenant_id=$2 AND user_id=$3', [id, tenantId, userId]);
    return result.rows[0] ? publicDelivery(deliveryFromRow(result.rows[0] as DeliveryRow)) : null;
  }
  async claimNext(workerId: string, leaseMs: number, id?: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE outbound_notification_deliveries SET status='dead_letter',
        last_error='Delivery retry limit reached after an interrupted attempt.',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
        WHERE status IN ('pending','retrying','delivering') AND attempt_count >= $1
        AND next_attempt_at <= NOW() AND (lease_expires_at IS NULL OR lease_expires_at <= NOW()) ${id ? 'AND id=$2' : ''}`,
      id ? [maxDeliveryAttempts, id] : [maxDeliveryAttempts]);
      const result = await client.query(`SELECT * FROM outbound_notification_deliveries WHERE status IN ('pending','retrying','delivering')
        AND next_attempt_at <= NOW() AND (lease_expires_at IS NULL OR lease_expires_at <= NOW()) ${id ? 'AND id=$1' : ''}
        ORDER BY next_attempt_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, id ? [id] : []);
      if (!result.rows[0]) { await client.query('COMMIT'); return null; }
      const updated = await client.query(`UPDATE outbound_notification_deliveries SET status='delivering', lease_owner=$1, lease_token=$4,
        lease_expires_at=NOW()+($2::double precision * INTERVAL '1 millisecond'), last_attempt_at=NOW(), updated_at=NOW(),
        attempt_count=attempt_count+1,total_attempts=total_attempts+1 WHERE id=$3 RETURNING *`,
      [workerId, deliveryLeaseMs(leaseMs), result.rows[0].id, randomUUID()]);
      await client.query('COMMIT');
      return deliveryFromRow(updated.rows[0] as DeliveryRow);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async markDelivered(id: string, workerId: string, leaseToken: string, responseStatus: number) {
    await this.pool.query(`UPDATE outbound_notification_deliveries SET status='delivered',
      response_status=$1,delivered_at=NOW(),last_error=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
      WHERE id=$2 AND lease_owner=$3 AND lease_token=$4 AND status='delivering' AND lease_expires_at > clock_timestamp()`, [responseStatus, id, workerId, leaseToken]);
  }
  async markFailed(id: string, workerId: string, leaseToken: string, error: string, responseStatus?: number, terminal = false) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT attempt_count FROM outbound_notification_deliveries WHERE id=$1 AND lease_owner=$2
        AND lease_token=$3 AND status='delivering' AND lease_expires_at > clock_timestamp() FOR UPDATE`, [id, workerId, leaseToken]);
      if (!result.rows[0]) { await client.query('COMMIT'); return; }
      const attempts = Number(result.rows[0].attempt_count ?? 0);
      const dead = terminal || attempts >= maxDeliveryAttempts;
      const delayMs = Math.min(60 * 60_000, 5_000 * (2 ** Math.max(0, attempts - 1)));
      await client.query(`UPDATE outbound_notification_deliveries SET status=$1,
        next_attempt_at=NOW()+($2::double precision * INTERVAL '1 millisecond'),response_status=$3,last_error=$4,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$5 AND lease_owner=$6
        AND lease_token=$7 AND status='delivering' AND lease_expires_at > clock_timestamp()`,
      [dead ? 'dead_letter' : 'retrying', delayMs, responseStatus ?? null, boundedError(error), id, workerId, leaseToken]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async retry(id: string, tenantId: string, userId: string) {
    const result = await this.pool.query(`UPDATE outbound_notification_deliveries SET status='pending',attempt_count=0,next_attempt_at=NOW(),
      last_error=NULL,response_status=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
      WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND status='dead_letter'`, [id, tenantId, userId]);
    return (result.rowCount ?? 0) > 0;
  }
  async pruneDeliveries(before: string, limit = 1_000) {
    const result = await this.pool.query(`DELETE FROM outbound_notification_deliveries WHERE id IN (
      SELECT id FROM outbound_notification_deliveries WHERE status IN ('delivered','dead_letter') AND updated_at < $1 ORDER BY updated_at ASC LIMIT $2
    )`, [before, Math.min(10_000, Math.max(1, Math.floor(limit)))]);
    return result.rowCount ?? 0;
  }
}

const resolvedHostAddressesArePublic = async (url: URL) => {
  const results = await lookup(url.hostname, { all: true, verbatim: true });
  if (!results.length || results.some((entry) => privateAddress(entry.address))) throw new Error('公网 Webhook 解析到了私有或不可用地址。');
};

const testNotification = (): InAppNotification => ({
  id: `test:${randomUUID()}`,
  kind: 'task_completed',
  severity: 'info',
  title: 'Axiom 通知测试',
  message: '如果你收到这条消息，Webhook 渠道已经可以正常接收 Axiom 通知。',
  createdAt: new Date().toISOString(),
  read: false,
  target: { view: 'tasks' },
  action: { kind: 'open', label: '打开 Axiom' },
});

export class OutboundNotificationManager {
  private readonly workerId = `notification-${randomUUID()}`;
  private deliveryTimer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private delivering = false;
  private reconciling = false;
  private stopping = false;
  private source?: (tenantId: string, userId: string) => Promise<InAppNotification[]>;

  constructor(
    readonly store: OutboundNotificationStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly log: { warn(value: unknown, message?: string): void } = console,
  ) {}

  setSource(source: (tenantId: string, userId: string) => Promise<InAppNotification[]>) { this.source = source; }

  start() {
    this.stopping = false;
    if (!this.deliveryTimer) {
      this.deliveryTimer = setInterval(() => {
        void this.flush().catch((error) => this.log.warn({ error: boundedError(error) }, 'outbound notification delivery loop failed'));
      }, 1_000);
      this.deliveryTimer.unref();
    }
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => void this.reconcileAll(), 15_000);
      this.reconcileTimer.unref();
    }
    void this.reconcileAll();
  }

  async stop() {
    this.stopping = true;
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.deliveryTimer = undefined;
    this.reconcileTimer = undefined;
    const deadline = Date.now() + 30_000;
    while ((this.delivering || this.reconciling) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async reconcileScope(tenantId: string, userId: string, notifications?: InAppNotification[]) {
    const feed = notifications ?? await this.source?.(tenantId, userId) ?? [];
    let enqueued = 0;
    for (const notification of feed) enqueued += (await this.store.enqueue(tenantId, userId, notification)).length;
    return enqueued;
  }

  async reconcileAll() {
    if (this.stopping || this.reconciling || !this.source) return;
    this.reconciling = true;
    try {
      for (const owner of await this.store.listOwners()) await this.reconcileScope(owner.tenantId, owner.userId);
      const configuredRetention = Number(process.env.AXIOM_NOTIFICATION_RETENTION_DAYS ?? 90);
      const retentionDays = Number.isFinite(configuredRetention) ? Math.min(365, Math.max(1, Math.floor(configuredRetention))) : 90;
      await this.store.pruneDeliveries(new Date(Date.now() - retentionDays * 86_400_000).toISOString());
    } catch (error) {
      this.log.warn({ error: boundedError(error) }, 'outbound notification reconciliation failed');
    } finally { this.reconciling = false; }
  }

  async enqueueTest(channelId: string, tenantId: string, userId: string) {
    const ids = await this.store.enqueue(tenantId, userId, testNotification(), channelId);
    const id = ids[0];
    if (!id) throw new Error('通知渠道未启用或不存在。');
    await this.flush(20, id);
    return this.store.getDelivery(id, tenantId, userId);
  }

  async flush(limit = 20, specificId?: string) {
    if (this.stopping) return 0;
    if (this.delivering) {
      if (!specificId) return 0;
      const deadline = Date.now() + 30_000;
      while (this.delivering && !this.stopping && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (this.delivering || this.stopping) return 0;
    }
    this.delivering = true;
    let processed = 0;
    try {
      while (processed < limit) {
        const delivery = await this.store.claimNext(this.workerId, 30_000, specificId);
        if (!delivery) break;
        await this.deliver(delivery);
        processed += 1;
        if (specificId) break;
      }
    } finally { this.delivering = false; }
    return processed;
  }

  private async deliver(delivery: StoredDelivery) {
    let channel: ResolvedOutboundNotificationChannel | null;
    try {
      channel = await this.store.getChannel(delivery.channelId, delivery.tenantId, delivery.userId);
    } catch (error) {
      await this.store.markFailed(delivery.id, this.workerId, delivery.leaseToken!, `通知渠道无法解密：${boundedError(error)}`);
      return;
    }
    if (!channel || !channel.enabled) {
      await this.store.markFailed(delivery.id, this.workerId, delivery.leaseToken!, '通知渠道不存在或已停用。', undefined, true);
      return;
    }
    try {
      const endpoint = new URL(normalizeWebhookEndpoint(channel.endpoint, channel.location));
      if (channel.location === 'internet') await resolvedHostAddressesArePublic(endpoint);
      const remainingLeaseMs = Date.parse(delivery.leaseExpiresAt ?? '') - Date.now();
      if (!Number.isFinite(remainingLeaseMs) || remainingLeaseMs <= 0) return;
      const timestamp = new Date().toISOString();
      const body = JSON.stringify({
        version: 1,
        deliveryId: delivery.id,
        event: delivery.eventKind,
        notification: delivery.payload,
      });
      const signature = createHmac('sha256', channel.signingSecret).update(`${timestamp}.${body}`).digest('hex');
      const response = await this.fetcher(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(10_000, remainingLeaseMs)),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Axiom-Notification/1.0',
          'x-axiom-delivery-id': delivery.id,
          'idempotency-key': delivery.id,
          'x-axiom-event': delivery.eventKind,
          'x-axiom-timestamp': timestamp,
          'x-axiom-signature': `v1=${signature}`,
        },
        body,
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) {
        await this.store.markDelivered(delivery.id, this.workerId, delivery.leaseToken!, response.status);
        return;
      }
      const terminal = response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status);
      await this.store.markFailed(delivery.id, this.workerId, delivery.leaseToken!, `Webhook 返回 HTTP ${response.status}。`, response.status, terminal);
    } catch (error) {
      await this.store.markFailed(delivery.id, this.workerId, delivery.leaseToken!, boundedError(error));
    }
  }
}

export const createOutboundNotificationStore = (): OutboundNotificationStore => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return new PostgresOutboundNotificationStore(databaseUrl);
  return new SqliteOutboundNotificationStore(process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'));
};
