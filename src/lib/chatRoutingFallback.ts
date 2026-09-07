import type { AgentGraph, AgentMode, ChatRouteDecision, FileAttachment, ImageAttachment } from '../types';
import { fallbackChatRoute as sharedFallbackChatRoute } from '../../server/shared/chatRoutingFallback';

export const fallbackChatRoute = (input: { message: string; mode: AgentMode; attachments?: Array<ImageAttachment | FileAttachment>; currentGraph?: AgentGraph | null }): ChatRouteDecision => sharedFallbackChatRoute({
  ...input,
  attachments: (input.attachments ?? []).map((attachment) => 'url' in attachment
    ? { name: attachment.alt, mimeType: 'image/*', kind: 'image' }
    : { name: attachment.name, mimeType: attachment.mimeType, kind: 'file' }),
});
