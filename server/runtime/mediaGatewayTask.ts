import { randomUUID } from 'node:crypto';
import { durableMediaRoute, type ChatRouteDecision } from './chatRouter.js';
import type { ProviderConfig } from './providerBindings.js';

type GatewayAttachment = { id?: string; kind?: 'file' | 'image' | 'video'; name?: string; mimeType?: string; url?: string; dataUrl?: string; text?: string };
type GatewayMessage = { id?: string; role: 'user' | 'assistant'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>; taskId?: string; attachments?: GatewayAttachment[] };
type MediaChatInput = { sessionId?: string; mode?: 'analyze' | 'build' | 'decide'; messages?: GatewayMessage[]; provider?: ProviderConfig['text']; visionProvider?: ProviderConfig['vision']; imageProvider?: ProviderConfig['image']; videoProvider?: ProviderConfig['video'] };

export const mediaGatewayTaskInput = (request: MediaChatInput, routing: ChatRouteDecision) => {
  const messages = (request.messages ?? []).filter((message) => message && ['user', 'assistant'].includes(message.role)).map((message) => ({
    ...message, id: message.id || randomUUID(),
    content: typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'),
    attachments: [...(message.attachments ?? []), ...(Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url' && part.image_url?.url.startsWith('data:image/')).map((part) => ({ kind: 'image' as const, url: part.image_url!.url })) : [])]
      .slice(0, 6).map((attachment: GatewayAttachment) => ({ id: attachment.id || randomUUID(), kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType, url: attachment.url, dataUrl: attachment.dataUrl, text: attachment.text })),
  }));
  const latest = messages.at(-1);
  if (!latest || latest.role !== 'user' || !latest.content.trim()) throw new Error('A user message is required for media generation.');
  return {
    sessionId: request.sessionId || `chat-${randomUUID()}`, mode: request.mode ?? 'build', input: latest.content,
    routing: durableMediaRoute(routing, latest.content),
    providerConfig: { text: request.provider, vision: request.visionProvider, image: request.imageProvider, video: request.videoProvider },
    contextMessages: messages.map((message) => ({ id: message.id, role: message.role, content: message.content, taskId: message.taskId,
      attachments: message.attachments.map(({ id, kind, name, mimeType }) => ({ id, kind, name, mimeType })) })),
    ...(latest.attachments.length ? { inputSource: { messageId: latest.id, attachments: latest.attachments } } : {}),
  };
};
