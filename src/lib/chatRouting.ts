import type { AgentGraph, AgentMode, ChatMessage, ChatRouteDecision, FileAttachment, ImageAttachment, TextProviderSettings } from '../types';

export async function routeChatMessage(
  message: string,
  mode: AgentMode,
  attachments: Array<ImageAttachment | FileAttachment>,
  provider: TextProviderSettings,
  signal: AbortSignal,
  context?: { messages: ChatMessage[]; graph: AgentGraph | null },
) {
  const response = await fetch('/api/chat/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      mode,
      attachments: attachments.map((attachment) => 'url' in attachment
        ? { name: attachment.alt, mimeType: 'image/*', kind: 'image' }
        : { name: attachment.name, mimeType: attachment.mimeType, kind: 'file' }),
      conversationContext: (context?.messages ?? []).slice(-12).map((item) => ({ role: item.role, content: item.content.slice(0, 2_000) })),
      currentGraph: context?.graph ?? null,
      provider: provider.useCustom
        ? { ...(provider.credentialId ? { credentialId: provider.credentialId } : { apiUrl: provider.apiUrl.trim(), apiKey: provider.apiKey }), model: provider.model.trim(), location: provider.location }
        : undefined,
    }),
    signal,
  });
  const body = await response.json().catch(() => null) as { decision?: ChatRouteDecision; error?: string } | null;
  if (!response.ok || !body?.decision) throw new Error(body?.error ?? `语义路由服务返回 HTTP ${response.status}。`);
  return body.decision;
}
