import { resolve } from 'node:path';
import type { TaskStore } from './contracts.js';
import { PostgresTaskStore } from './postgresTaskStore.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';

export const createTaskStore = (): TaskStore => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return new PostgresTaskStore(databaseUrl);

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SQLITE_PRODUCTION !== 'true') {
    throw new Error('DATABASE_URL is required in production. Set ALLOW_SQLITE_PRODUCTION=true only for single-node deployments.');
  }

  const sqlitePath = process.env.AXIOM_SQLITE_PATH?.trim()
    || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite');
  return new SqliteTaskStore(sqlitePath);
};
