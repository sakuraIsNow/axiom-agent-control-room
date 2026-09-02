import type { AgentMode, ChatAttachment, ChatMessage, ChatRouteDecision, ImageProviderSettings, TextProviderSettings, Usage, VideoProviderSettings } from '../types';
import { consumeSseBlocks } from './sse';

type StreamHandlers = {
  onStatus: (phase: string, message: string) => void;
  onToken: (token: string) => void;
  onReset?: () => void;
  onReasoning: (token: string) => void;
  onAttachment?: (attachment: ChatAttachment) => void;
  onComplete: (data: { durationMs: number; usage?: Usage; route?: string; agentRole?: string; model?: string }) => void;
  onError: (message: string) => void;
};

export async function streamAgentResponse(
  messages: ChatMessage[],
  mode: AgentMode,
  sessionId: string,
  signal: AbortSignal,
  handlers: StreamHandlers,
  provider?: TextProviderSettings,
  visionProvider?: TextProviderSettings,
  imageProvider?: ImageProviderSettings,
  videoProvider?: VideoProviderSettings,
  routing?: ChatRouteDecision,
) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: messages.map(({ id, role, content, taskId, attachments }) => ({ id, role, content, taskId, attachments })),
      mode,
      sessionId,
      provider: provider?.useCustom
        ? {
            ...(provider.credentialId ? { credentialId: provider.credentialId } : { apiUrl: provider.apiUrl.trim(), apiKey: provider.apiKey }),
            model: provider.model.trim(),
            location: provider.location,
          }
        : undefined,
      visionProvider: visionProvider?.useCustom
        ? {
            ...(visionProvider.credentialId ? { credentialId: visionProvider.credentialId } : { apiUrl: visionProvider.apiUrl.trim(), apiKey: visionProvider.apiKey }),
            model: visionProvider.model.trim(),
            location: visionProvider.location,
          }
        : undefined,
      imageProvider: imageProvider?.useCustom
        ? {
            ...(imageProvider.credentialId ? { credentialId: imageProvider.credentialId } : { apiUrl: imageProvider.apiUrl.trim(), apiKey: imageProvider.apiKey }),
            model: imageProvider.model.trim(),
            location: imageProvider.location,
          }
        : undefined,
      videoProvider: videoProvider?.useCustom
        ? {
            ...(videoProvider.credentialId ? { credentialId: videoProvider.credentialId } : { apiUrl: videoProvider.apiUrl.trim(), apiKey: videoProvider.apiKey }),
            model: videoProvider.model.trim(),
            location: videoProvider.location,
          }
        : undefined,
      routing,
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Agent 网关返回 HTTP ${response.status}。`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  let reportedError: string | null = null;

  const dispatch = (block: string) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const rawData = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');

    if (!event || !rawData) return;

    const data = JSON.parse(rawData) as Record<string, unknown>;
    if (event === 'status') handlers.onStatus(String(data.phase), String(data.message));
    if (event === 'token') handlers.onToken(String(data.content));
    if (event === 'reset') handlers.onReset?.();
    if (event === 'reasoning') handlers.onReasoning(String(data.content));
    if (event === 'attachment' && data.attachment && typeof data.attachment === 'object') handlers.onAttachment?.(data.attachment as ChatAttachment);
    if (event === 'complete') {
      completed = true;
      handlers.onComplete({
        durationMs: Number(data.durationMs ?? 0),
        usage: data.usage as Usage | undefined,
        route: typeof data.route === 'string' ? data.route : undefined,
        agentRole: typeof data.agentRole === 'string' ? data.agentRole : undefined,
        model: typeof data.model === 'string' ? data.model : undefined,
      });
    }
    if (event === 'error') {
      reportedError = String(data.message ?? 'Agent 网关返回执行失败。');
      handlers.onError(reportedError);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = consumeSseBlocks(buffer, dispatch);
  }

  buffer += decoder.decode();
  if (buffer.trim()) dispatch(buffer);
  if (reportedError) throw new Error(reportedError);
  if (!completed && !signal.aborted) throw new Error('Agent 响应流在完成前中断。');
}
