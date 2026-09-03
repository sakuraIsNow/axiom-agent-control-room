import { createHash } from 'node:crypto';
import type { BusinessRecord } from './businessCapabilityStore.js';

export type NexusArtifactStorageEncoding = 'binary' | 'text' | 'legacy-data-url';

export type NexusArtifactSnapshot = {
  artifactRecordId: string;
  artifactId: string;
  name: string;
  mimeType: string;
  bytes: number;
  digest: string;
  storageKey?: string;
  storageEncoding: NexusArtifactStorageEncoding;
};

export const parseNexusArtifactSnapshot = (value: unknown): NexusArtifactSnapshot | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const storageEncoding = item.storageEncoding;
  if (typeof item.artifactRecordId !== 'string' || typeof item.artifactId !== 'string'
    || typeof item.name !== 'string' || typeof item.mimeType !== 'string'
    || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0
    || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(item.digest)
    || !['binary', 'text', 'legacy-data-url'].includes(String(storageEncoding))) return null;
  return {
    artifactRecordId: item.artifactRecordId,
    artifactId: item.artifactId,
    name: item.name,
    mimeType: item.mimeType,
    bytes: Number(item.bytes),
    digest: item.digest,
    storageEncoding: storageEncoding as NexusArtifactStorageEncoding,
    ...(typeof item.storageKey === 'string' ? { storageKey: item.storageKey } : {}),
  };
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
};

export const stableDigest = (value: unknown) => createHash('sha256')
  .update(JSON.stringify(canonicalize(value)))
  .digest('hex');

export const nexusArtifactSnapshot = (record: BusinessRecord): NexusArtifactSnapshot | null => {
  if (record.kind !== 'nexus-artifact' || record.status !== 'active') return null;
  const artifactId = typeof record.data.artifactId === 'string' ? record.data.artifactId : '';
  const name = typeof record.data.name === 'string' ? record.data.name : artifactId;
  const mimeType = typeof record.data.mimeType === 'string' ? record.data.mimeType : 'application/octet-stream';
  const bytes = Number(record.data.bytes);
  const digest = typeof record.data.digest === 'string' ? record.data.digest : '';
  const rawEncoding = record.data.storageEncoding;
  const storageEncoding: NexusArtifactStorageEncoding = rawEncoding === 'binary'
    ? 'binary'
    : rawEncoding === 'legacy-data-url' ? 'legacy-data-url' : 'text';
  if (!artifactId || !name || !Number.isSafeInteger(bytes) || bytes < 0 || !/^[a-f0-9]{64}$/u.test(digest)) return null;
  return {
    artifactRecordId: record.id,
    artifactId,
    name,
    mimeType,
    bytes,
    digest,
    storageEncoding,
    ...(typeof record.data.storageKey === 'string' ? { storageKey: record.data.storageKey } : {}),
  };
};

export const snapshotNexusArtifacts = (records: BusinessRecord[], workflowId: string) => records
  .filter((record) => record.data.workflowId === workflowId)
  .map(nexusArtifactSnapshot)
  .filter((artifact): artifact is NexusArtifactSnapshot => Boolean(artifact))
  .sort((left, right) => left.artifactRecordId.localeCompare(right.artifactRecordId));

export const nexusArtifactSetDigest = (artifacts: NexusArtifactSnapshot[]) => stableDigest(
  artifacts.map(({ artifactRecordId, artifactId, name, mimeType, bytes, digest, storageEncoding }) => ({
    artifactRecordId, artifactId, name, mimeType, bytes, digest, storageEncoding,
  })),
);

export const nexusReleaseDigest = (definition: unknown, artifacts: NexusArtifactSnapshot[]) => stableDigest({
  definition,
  artifacts: artifacts.map(({ artifactRecordId, artifactId, name, mimeType, bytes, digest, storageEncoding }) => ({
    artifactRecordId, artifactId, name, mimeType, bytes, digest, storageEncoding,
  })),
});
