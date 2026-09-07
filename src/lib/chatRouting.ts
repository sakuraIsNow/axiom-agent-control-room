import type { AgentGraph, AgentMode, ChatMessage, ChatRouteDecision, FileAttachment, ImageAttachment, TextProviderSettings } from '../types';
import { fallbackChatRoute } from './chatRoutingFallback';
import { chatRouteDecisionSchema } from '../../server/shared/chatRoutingSchema';

const routeTimeoutMs = 12_000;
const routeMaxAttempts = 2;
const retryableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = globalThis.setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    globalThis.clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

const isAbort = (error: unknown, signal: AbortSignal) => signal.aborted
  || (error instanceof DOMException && error.name === 'AbortError')
  || (error instanceof Error && /aborted|abort|cancelled|canceled/i.test(error.message));

export async function routeChatMessage(
  message: string,
  mode: AgentMode,
  attachments: Array<ImageAttachment | FileAttachment>,
  provider: TextProviderSettings,
  signal: AbortSignal,
  context?: { messages: ChatMessage[]; graph: AgentGraph | null },
) {
  const payload = {
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
  };

  for (let attempt = 1; attempt <= routeMaxAttempts; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const timeoutController = new AbortController();
    const abortFromCaller = () => timeoutController.abort(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = globalThis.setTimeout(() => timeoutController.abort(new DOMException('Routing timeout', 'TimeoutError')), routeTimeoutMs);
    signal.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const responsePromise = fetch('/api/chat/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: timeoutController.signal,
      });
      const response = await Promise.race([
        responsePromise,
        new Promise<Response>((_, reject) => timeoutController.signal.addEventListener('abort', () => reject(timeoutController.signal.reason), { once: true })),
      ]);
      const body = await response.json().catch(() => null) as { decision?: ChatRouteDecision; error?: string } | null;
      if (!response.ok || !body?.decision) {
        throw Object.assign(new Error(body?.error ?? `Semantic routing returned HTTP ${response.status}.`), { retryable: retryableStatus(response.status) });
      }
      const decision = chatRouteDecisionSchema.safeParse(body.decision);
      if (!decision.success) throw Object.assign(new Error('Routing returned an invalid decision.'), { retryable: false });
      return decision.data as ChatRouteDecision;
    } catch (error) {
      if (isAbort(error, signal)) {
        if (signal.aborted) throw signal.reason ?? error;
        if (attempt === routeMaxAttempts) break;
      } else {
        // Network failures and timeouts are transient by default. HTTP
        // responses mark non-retryable client errors explicitly above.
        const retryable = (error as { retryable?: boolean }).retryable ?? true;
        if (attempt === routeMaxAttempts || !retryable) break;
      }
      if (attempt < routeMaxAttempts) await wait(150 * attempt, signal);
    } finally {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', abortFromCaller);
    }
  }

  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  return fallbackChatRoute({ message, mode, attachments, currentGraph: context?.graph ?? null });
}
