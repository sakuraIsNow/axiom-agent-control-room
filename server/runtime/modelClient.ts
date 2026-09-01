import { consumeSseBlocks } from './sse.js';

export type ModelCompletionRequest = {
  model?: string;
  maxTokens?: number;
  system: string;
  user: string;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  tools?: ModelToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  signal: AbortSignal;
  onDelta?: (delta: { content?: string; reasoning?: string }) => void | Promise<void>;
  onRetry?: (nextAttempt: number) => void | Promise<void>;
};

export type ModelToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ModelToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

export type ModelCompletion = {
  content: string;
  reasoning?: string;
  usage?: Record<string, number>;
  toolCalls?: ModelToolCall[];
  attempts: number;
  durationMs: number;
};

export type ModelHealth = {
  configured: boolean;
  reachable: boolean;
  detail: string;
};

export interface ModelClient {
  readonly model: string;
  complete(request: ModelCompletionRequest): Promise<ModelCompletion>;
}

const redactSecrets = (message: string) => message.replace(/sk-[A-Za-z0-9_-]{10,}/g, '[redacted-key]');

const endpoint = (baseUrl: string) => {
  const normalized = baseUrl.replace(/\/$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
};

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

export class OpenAICompatibleModelClient implements ModelClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly timeoutExplicit: boolean;
  private readonly reasoningTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly apiKeyOptional: boolean;
  private readonly onUsage?: (usage?: Record<string, number>) => void;

  constructor(options?: {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    timeoutMs?: number;
    maxAttempts?: number;
    apiKeyOptional?: boolean;
    onUsage?: (usage?: Record<string, number>) => void;
  }) {
    this.apiKey = options?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.apiBase = options?.apiBase ?? process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com';
    this.model = options?.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
    this.timeoutExplicit = options?.timeoutMs !== undefined;
    this.timeoutMs = Math.max(5_000, options?.timeoutMs ?? Number(process.env.AGENT_MODEL_TIMEOUT_MS ?? 120_000));
    // Reasoning-heavy models (for example DeepSeek V4 Pro) can spend more than
    // two minutes in the model stream before returning a final answer. Keep the
    // short timeout for routing/health probes, while allowing the normal runtime
    // client a bounded longer window. An explicit per-client timeout always wins.
    const configuredReasoningTimeout = Number(process.env.AGENT_REASONING_MODEL_TIMEOUT_MS ?? 300_000);
    this.reasoningTimeoutMs = Math.max(
      this.timeoutMs,
      Number.isFinite(configuredReasoningTimeout) ? configuredReasoningTimeout : 300_000,
    );
    this.maxAttempts = Math.min(6, Math.max(1, options?.maxAttempts ?? Number(process.env.AGENT_MODEL_MAX_ATTEMPTS ?? 3)));
    this.apiKeyOptional = options?.apiKeyOptional ?? false;
    this.onUsage = options?.onUsage;
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletion> {
    if (!this.apiKey && !this.apiKeyOptional) throw new Error('Agent runtime model API key is not configured.');
    const startedAt = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (request.signal.aborted) throw request.signal.reason ?? new DOMException('Aborted', 'AbortError');
      try {
        const requestedModel = request.model ?? this.model;
        const isReasoningModel = /(?:reasoner|reasoning|deepseek-v4-pro|deepseek-r1|\br1\b)/i.test(requestedModel);
        const requestTimeoutMs = isReasoningModel && !this.timeoutExplicit ? this.reasoningTimeoutMs : this.timeoutMs;
        const requestSignal = AbortSignal.any([request.signal, AbortSignal.timeout(requestTimeoutMs)]);
        const response = await fetch(endpoint(this.apiBase), {
          method: 'POST',
          headers: {
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: requestedModel,
            messages: [
              { role: 'system', content: request.system.slice(0, 30_000) },
              { role: 'user', content: request.user.slice(0, 80_000) },
            ],
            stream: true,
            ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
            stream_options: { include_usage: true },
            temperature: request.temperature ?? 0.2,
            ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
            ...(request.tools?.length ? { tools: request.tools, tool_choice: request.toolChoice ?? 'auto' } : {}),
          }),
          signal: requestSignal,
        });

        const contentType = response.headers.get('content-type') ?? '';
        let content = '';
        let reasoning = '';
        let usage: Record<string, number> | undefined;
        const streamedToolCalls = new Map<number, { id?: string; name: string; arguments: string }>();
        if (contentType.includes('text/event-stream') && response.body) {
          const reader = response.body.getReader();
          // Undici can resolve fetch() once headers arrive and leave a body
          // reader pending even after the request signal times out. Race every
          // read with the same signal so a stalled provider becomes retryable.
          const readChunk = async () => {
            if (requestSignal.aborted) throw requestSignal.reason ?? new DOMException('Aborted', 'AbortError');
            return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
              const onAbort = () => {
                cleanup();
                void reader.cancel().catch(() => undefined);
                reject(requestSignal.reason ?? new DOMException('Aborted', 'AbortError'));
              };
              const cleanup = () => requestSignal.removeEventListener('abort', onAbort);
              requestSignal.addEventListener('abort', onAbort, { once: true });
              reader.read().then((result) => {
                cleanup();
                resolve(result);
              }, (error) => {
                cleanup();
                reject(error);
              });
            });
          };
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await readChunk();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks: string[] = [];
            buffer = consumeSseBlocks(buffer, (block) => { blocks.push(block); });
            for (const block of blocks) {
              const rawData = block.split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('');
              if (!rawData || rawData === '[DONE]') continue;
              const payload = JSON.parse(rawData) as {
                choices?: Array<{ delta?: {
                  content?: string;
                  reasoning_content?: string;
                  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
                }; message?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
                usage?: Record<string, number>;
                error?: { message?: string };
              };
              if (payload.error) {
                const error = new Error(payload.error.message ?? 'Model stream failed.') as Error & { status?: number };
                error.status = response.status;
                throw error;
              }
              const delta = payload.choices?.[0]?.delta;
              if (delta?.content) {
                content += delta.content;
                await request.onDelta?.({ content: delta.content });
              }
              if (delta?.reasoning_content) {
                reasoning += delta.reasoning_content;
                await request.onDelta?.({ reasoning: delta.reasoning_content });
              }
              for (const item of delta?.tool_calls ?? []) {
                const index = Number.isInteger(item.index) ? Number(item.index) : streamedToolCalls.size;
                const previous = streamedToolCalls.get(index) ?? { id: undefined, name: '', arguments: '' };
                streamedToolCalls.set(index, {
                  id: item.id ?? previous.id,
                  name: item.function?.name ?? previous.name,
                  arguments: `${previous.arguments}${item.function?.arguments ?? ''}`,
                });
              }
              if (payload.usage) usage = payload.usage;
            }
          }
          buffer += decoder.decode();
          if (buffer.trim()) {
            const blocks: string[] = [];
            consumeSseBlocks(`${buffer}\n\n`, (block) => { blocks.push(block); });
            for (const block of blocks) {
              const rawData = block.split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('');
              if (!rawData || rawData === '[DONE]') continue;
              const payload = JSON.parse(rawData) as {
                choices?: Array<{ delta?: {
                  content?: string;
                  reasoning_content?: string;
                  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
                } }>;
                usage?: Record<string, number>;
              };
              if ((payload as { error?: { message?: string } }).error) {
                throw new Error((payload as { error?: { message?: string } }).error?.message ?? 'Model stream failed.');
              }
              const delta = payload.choices?.[0]?.delta;
              if (delta?.content) { content += delta.content; await request.onDelta?.({ content: delta.content }); }
              if (delta?.reasoning_content) { reasoning += delta.reasoning_content; await request.onDelta?.({ reasoning: delta.reasoning_content }); }
              for (const item of delta?.tool_calls ?? []) {
                const index = Number.isInteger(item.index) ? Number(item.index) : streamedToolCalls.size;
                const previous = streamedToolCalls.get(index) ?? { id: undefined, name: '', arguments: '' };
                streamedToolCalls.set(index, { id: item.id ?? previous.id, name: item.function?.name ?? previous.name, arguments: `${previous.arguments}${item.function?.arguments ?? ''}` });
              }
              if (payload.usage) usage = payload.usage;
            }
          }
        } else {
          const payload = await response.json().catch(() => null) as {
            choices?: Array<{ message?: {
              content?: string;
              reasoning_content?: string;
              tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
            } }>;
            usage?: Record<string, number>;
            error?: { message?: string };
          } | null;
          if (payload?.choices?.[0]?.message?.content) {
            content = payload.choices[0].message.content;
            reasoning = payload.choices[0].message.reasoning_content ?? '';
            await request.onDelta?.({ content, reasoning: reasoning || undefined });
          }
          usage = payload?.usage;
          for (const item of payload?.choices?.[0]?.message?.tool_calls ?? []) {
            streamedToolCalls.set(streamedToolCalls.size, {
              id: item.id,
              name: item.function?.name ?? '',
              arguments: item.function?.arguments ?? '',
            });
          }
          if (payload?.error) {
            const error = new Error(payload.error.message ?? `Model request failed with ${response.status}.`) as Error & { status?: number };
            error.status = response.status;
            throw error;
          }
        }

        if (!response.ok) {
          const error = new Error(`Model request failed with ${response.status}.`) as Error & { status?: number };
          error.status = response.status;
          throw error;
        }
        const toolCalls = [...streamedToolCalls.values()]
          .filter((item) => item.name)
          .map((item) => {
            let args: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(item.arguments || '{}');
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
            } catch {
              // The orchestrator will reject malformed arguments through the tool schema.
            }
            return { id: item.id, name: item.name, args } satisfies ModelToolCall;
          });
        const trimmedContent = content.trim();
        if (!trimmedContent && toolCalls.length === 0) throw new Error('Model returned an empty response.');
        this.onUsage?.(usage);
        return {
          content: trimmedContent,
          reasoning: reasoning || undefined,
          usage,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        };
      } catch (caught) {
        if (request.signal.aborted) throw request.signal.reason ?? caught;
        lastError = caught instanceof Error ? caught : new Error('Unknown model request failure.');
        const status = (lastError as Error & { status?: number }).status;
        const retryable = lastError.name === 'TimeoutError'
          || (status === undefined && lastError.name !== 'AbortError')
          || status === 408
          || status === 409
          || status === 429
          || (status !== undefined && status >= 500);
        if (!retryable || attempt >= this.maxAttempts) break;
        await request.onRetry?.(attempt + 1);
        await delay(Math.min(4_000, 350 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 180)), request.signal);
      }
    }

    throw lastError ?? new Error('Model request failed.');
  }

  async health(signal?: AbortSignal): Promise<ModelHealth> {
    if (!this.apiKey) return { configured: false, reachable: false, detail: '尚未配置文本模型 API 密钥。' };
    const base = this.apiBase.replace(/\/$/, '').replace(/\/chat\/completions$/i, '');
    try {
      const response = await fetch(`${base}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(2_500)]),
      });
      return response.ok
        ? { configured: true, reachable: true, detail: '文本模型服务健康检查通过。' }
        : { configured: true, reachable: false, detail: `文本模型服务返回 HTTP ${response.status}。` };
    } catch {
      return { configured: true, reachable: false, detail: '文本模型服务健康检查失败。' };
    }
  }
}
