import { createHash } from 'node:crypto';
import { z } from 'zod';
import { attachmentDataUrl, decodeAttachmentDataUrl } from './attachmentContent.js';
import type { ArtifactStore } from './artifactStore.js';
import type { NexusArtifactSnapshot } from './nexusArtifacts.js';

export const taskInputSourceSchema = z.object({
  messageId: z.string().min(1).max(200),
  attachments: z.array(z.object({
    id: z.string().min(1).max(200),
    kind: z.enum(['image', 'file', 'video']).optional(),
    name: z.string().max(300).optional(),
    mimeType: z.string().max(150).optional(),
    url: z.string().max(14 * 1024 * 1024).optional(),
    dataUrl: z.string().max(14 * 1024 * 1024).optional(),
    text: z.string().max(120_000).optional(),
  }).strict()).max(6),
}).strict();
export type TaskInputSource = z.infer<typeof taskInputSourceSchema>;
export type TaskInputAttachmentSnapshot = NexusArtifactSnapshot & {
  sourceAttachmentId: string;
  sourceMessageId: string;
  sourceSessionId: string;
  ownerUserId: string;
};
type AttachmentOwner = { tenantId: string; userId: string; sessionId: string };
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const artifactId = (tenantId: string, snapshot: Pick<TaskInputAttachmentSnapshot, 'ownerUserId' | 'sourceSessionId' | 'sourceMessageId' | 'sourceAttachmentId' | 'digest'>) =>
  `conversation-input:${digest(JSON.stringify([tenantId, snapshot.ownerUserId, snapshot.sourceSessionId, snapshot.sourceMessageId, snapshot.sourceAttachmentId, snapshot.digest]))}`;
const allowedMime = /^(?:text\/|image\/|application\/(?:pdf|json|xml|vnd\.openxmlformats-officedocument\.|msword))/iu;

/** Persist this exact user turn before the task enters the runnable queue. */
export const persistTaskInputAttachments = async (
  source: TaskInputSource | undefined,
  owner: AttachmentOwner,
  store: ArtifactStore | null | undefined,
): Promise<TaskInputAttachmentSnapshot[]> => {
  if (!source?.attachments.length) return [];
  const parsed = taskInputSourceSchema.parse(source);
  if (!store) throw new Error('Conversation attachment storage is unavailable.');
  if (new Set(parsed.attachments.map((attachment) => attachment.id)).size !== parsed.attachments.length) throw new Error('Conversation attachment IDs must be unique.');
  const decoded = parsed.attachments.map((attachment) => {
    const encoded = attachment.dataUrl ?? attachment.url;
    const original = decodeAttachmentDataUrl(encoded);
    if (encoded && !original) throw new Error(`Attachment ${attachment.name ?? attachment.id} has no valid inline bytes.`);
    const extracted = !original && attachment.text?.trim() ? Buffer.from(attachment.text, 'utf8') : undefined;
    const content = original?.bytes ?? extracted;
    const mimeType = original?.mimeType ?? (extracted ? 'text/plain' : attachment.mimeType ?? 'application/octet-stream');
    if (!content?.byteLength || content.byteLength > 10 * 1024 * 1024 || !allowedMime.test(mimeType)) {
      throw new Error(`Attachment ${attachment.name ?? attachment.id} has unsupported, empty, or oversized content.`);
    }
    if (attachment.kind === 'image' && !mimeType.startsWith('image/')) throw new Error('Image attachment bytes must declare an image MIME type.');
    const name = extracted ? `${attachment.name ?? attachment.id}.extracted.txt` : attachment.name ?? `${attachment.id}.${mimeType.startsWith('image/') ? mimeType.slice(6).replace('jpeg', 'jpg') : 'bin'}`;
    return { attachment, content, mimeType, name };
  });
  if (decoded.reduce((total, item) => total + item.content.byteLength, 0) > 20 * 1024 * 1024) throw new Error('Conversation attachments exceed the 20 MB task budget.');
  const snapshots: TaskInputAttachmentSnapshot[] = [];
  for (const item of decoded) {
    const ownership = { sourceAttachmentId: item.attachment.id, sourceMessageId: parsed.messageId, sourceSessionId: owner.sessionId, ownerUserId: owner.userId, digest: digest(item.content) };
    const id = artifactId(owner.tenantId, ownership);
    const storageEncoding = store.putBinary && store.getBinary ? 'binary' as const : 'legacy-data-url' as const;
    const stored = storageEncoding === 'binary'
      ? await store.putBinary!(id, item.content, owner.tenantId, item.mimeType)
      : await store.put(id, attachmentDataUrl(item.content, item.mimeType), owner.tenantId);
    snapshots.push({ ...ownership, artifactRecordId: id, artifactId: id, name: item.name, mimeType: item.mimeType, bytes: item.content.byteLength, storageEncoding, storageKey: stored.key });
  }
  return snapshots;
};

export const loadTaskInputAttachments = async (
  snapshots: TaskInputAttachmentSnapshot[] | undefined,
  owner: Pick<AttachmentOwner, 'tenantId' | 'userId'>,
  store: ArtifactStore | null | undefined,
): Promise<Array<TaskInputAttachmentSnapshot & { content: Uint8Array }>> => {
  if (!snapshots?.length) return [];
  if (!store || snapshots.length > 6 || snapshots.reduce((total, item) => total + item.bytes, 0) > 20 * 1024 * 1024) throw new Error('Conversation attachment storage or budget is invalid.');
  return Promise.all(snapshots.map(async (snapshot) => {
    if (snapshot.ownerUserId !== owner.userId || snapshot.artifactId !== artifactId(owner.tenantId, snapshot)
      || snapshot.artifactRecordId !== snapshot.artifactId || !Number.isSafeInteger(snapshot.bytes)
      || snapshot.bytes <= 0 || snapshot.bytes > 10 * 1024 * 1024 || !allowedMime.test(snapshot.mimeType)) {
      throw new Error('Conversation attachment does not belong to the task owner or has invalid metadata.');
    }
    const content = snapshot.storageEncoding === 'binary'
      ? await store.getBinary?.(snapshot.artifactId, owner.tenantId)
      : decodeAttachmentDataUrl(await store.get(snapshot.artifactId, owner.tenantId) ?? undefined)?.bytes;
    if (!content || content.byteLength !== snapshot.bytes || digest(content) !== snapshot.digest) throw new Error(`Attachment ${snapshot.name} failed its content digest check.`);
    return { ...snapshot, content };
  }));
};
