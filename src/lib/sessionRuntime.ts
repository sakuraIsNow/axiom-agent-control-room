import type { AgentGraph, ChatMessage, FileAttachment, ImageAttachment, PersistedContextSummary, Session, VideoAttachment } from '../types';

type PersistedSessionMessage = Omit<ChatMessage, 'attachments'> & {
  attachments?: Array<{
    id: string;
    kind?: 'file' | 'video' | 'image';
    url?: string;
    alt?: string;
    name?: string;
    mimeType?: string;
    size?: number;
    text?: string;
    poster?: string;
  }>;
};

export type PersistedSessionPayload = {
  id: string;
  title: string;
  messages: PersistedSessionMessage[];
  updatedAt: number;
  activeTaskId?: string;
  activeAssistantId?: string;
  agentGraph?: AgentGraph;
  contextSummary?: PersistedContextSummary;
};

export type RemoteSession = PersistedSessionPayload & {
  tenantId: string;
  userId: string;
};

const imageAttachment = (attachment: ImageAttachment) => ({
  id: attachment.id,
  kind: 'image' as const,
  url: attachment.url,
  alt: attachment.alt,
});

const fileAttachment = (attachment: FileAttachment) => ({
  id: attachment.id,
  kind: attachment.kind,
  name: attachment.name,
  mimeType: attachment.mimeType,
  size: attachment.size,
  // The original bytes are intentionally kept local. Extracted text and
  // metadata are enough to restore a conversation without re-uploading a file.
  text: attachment.text,
});

const videoAttachment = (attachment: VideoAttachment) => ({
  id: attachment.id,
  kind: attachment.kind,
  url: attachment.url,
  alt: attachment.alt,
  mimeType: attachment.mimeType,
  poster: attachment.poster,
});

export const toPersistedSession = (session: Session): PersistedSessionPayload => ({
  id: session.id,
  title: session.title,
  messages: session.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    pending: message.pending,
    taskId: message.taskId,
    route: message.route,
    agentRole: message.agentRole,
    attachments: message.attachments?.map((attachment) => attachment.kind === 'video'
      ? videoAttachment(attachment)
      : attachment.kind === 'file'
        ? fileAttachment(attachment)
        : imageAttachment(attachment)),
  })),
  updatedAt: session.updatedAt,
  activeTaskId: session.activeTaskId,
  activeAssistantId: session.activeAssistantId,
  agentGraph: session.agentGraph,
});

const readJson = async <T>(response: Response, fallback: string) => {
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `${fallback} (${response.status})`);
  return body as T;
};

export async function listConversationSessions(limit = 50, signal?: AbortSignal) {
  const bounded = Math.min(100, Math.max(1, Math.floor(limit)));
  const response = await fetch(`/api/sessions?limit=${bounded}`, { signal });
  const body = await readJson<{ sessions?: RemoteSession[]; deletedSessionIds?: string[] }>(response, '会话历史读取失败');
  return {
    sessions: Array.isArray(body.sessions) ? body.sessions : [],
    deletedSessionIds: Array.isArray(body.deletedSessionIds) ? body.deletedSessionIds : [],
  };
}

export async function upsertConversationSession(session: Session, signal?: AbortSignal) {
  const payload = toPersistedSession(session);
  const response = await fetch(`/api/sessions/${encodeURIComponent(payload.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  return (await readJson<{ session: RemoteSession }>(response, '会话历史保存失败')).session;
}

export async function deleteConversationSession(sessionId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `会话删除失败 (${response.status})`);
  }
}
