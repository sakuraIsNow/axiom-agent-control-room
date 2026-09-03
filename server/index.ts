import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import dotenv from 'dotenv';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import { TaskCoordinator } from './runtime/coordinator.js';
import { EventHub } from './runtime/eventHub.js';
import { MemoryCaptureCompensationWorker, TencentMemoryClient } from './runtime/memoryClient.js';
import { OpenAICompatibleModelClient } from './runtime/modelClient.js';
import { WorkflowOrchestrator } from './runtime/orchestrator.js';
import { createTaskApi } from './runtime/taskApi.js';
import { createTaskStore } from './runtime/taskStore.js';
import { RuntimeMetrics } from './runtime/metrics.js';
import { verifyPrincipal } from './runtime/principal.js';
import { createArtifactStore } from './runtime/artifactStore.js';
import { createArtifactCatalog } from './runtime/artifactCatalog.js';
import { attachmentPdfVisualPages, extractAttachmentText } from './runtime/attachmentContent.js';
import { ToolRegistry } from './runtime/toolRegistry.js';
import { createTemplateStore } from './runtime/templateStore.js';
import { createPluginStore } from './runtime/pluginStore.js';
import { createAgentStore } from './runtime/agentStore.js';
import { agentCatalog, appendMissingAgentDirectory, supplementAgentDirectoryResponse } from './runtime/agentCatalog.js';
import { deepSeekCapabilityInfo } from './runtime/providerCapabilities.js';
import { prepareDeepSeekImageFiles } from './runtime/deepseekFiles.js';
import { chatRouteDecisionSchema, enforceChatRouteSafety, fallbackChatRoute, routeChatIntent, type ChatIntent, type ChatRouteDecision } from './runtime/chatRouter.js';
import { isOriginAllowed } from './runtime/originPolicy.js';
import { normalizeProviderBaseUrl } from './runtime/providerLocation.js';
import { buildContextWindow, validatePersistedContextSummary, type DurableContextSourceMessage, type PersistedContextSummary } from './runtime/contextSummary.js';
import { runtimeSkillCatalog, skillInstructions } from './runtime/skillCatalog.js';
import { workflowSpecialistCatalog } from './runtime/workflowSpecialists.js';
import type { AgentGraph } from './runtime/contracts.js';
import { ModelRoutingPolicy, parseModelCostCatalog } from './runtime/modelRouting.js';
import { createProviderCredentialStore, type ProviderCredentialKind } from './runtime/providerCredentialStore.js';
import { consumeSseBlocks } from './runtime/sse.js';
import { resolveTraceContext } from './runtime/trace.js';
import { CodexHarnessAdapter, DeepSeekHarnessAdapter } from './runtime/harnessClient.js';
import { createOutboundNotificationStore, OutboundNotificationManager } from './runtime/outboundNotifications.js';
import { createBusinessCapabilityStore } from './runtime/businessCapabilityStore.js';
import { registerPersistedExternalTools } from './runtime/businessCapabilities.js';
import { createIntegrationCredentialStore } from './runtime/integrationCredentialStore.js';

dotenv.config({ path: resolve(process.cwd(), '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const loadExternalImageConfig = () => {
  const configPath = process.env.DMX_CONFIG_PATH?.trim();
  if (!configPath || !existsSync(configPath)) return;
  const source = readFileSync(configPath, 'utf8');
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(DMX_API_KEY|DMX_BASE_URL|DMX_MODEL)\s*=\s*["']?([^"']*)["']?\s*$/);
    if (match?.[1] && match[2] && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
};

loadExternalImageConfig();

type ClientContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { file_id: string } };

type ClientMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string | ClientContentPart[];
  taskId?: string;
  /** Browser-only metadata used to extract attachments before provider calls. */
  attachments?: ClientAttachment[];
};

type ClientAttachment = {
  id?: string;
  kind?: 'file' | 'image' | 'video';
  name?: string;
  mimeType?: string;
  size?: number;
  dataUrl?: string;
  text?: string;
  url?: string;
  alt?: string;
};

type ProviderOverride = {
  credentialId?: string;
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  location?: 'internet' | 'local';
};

type ChatRequest = {
  messages?: ClientMessage[];
  mode?: 'analyze' | 'build' | 'decide';
  sessionId?: string;
  provider?: ProviderOverride;
  visionProvider?: ProviderOverride;
  imageProvider?: ProviderOverride;
  videoProvider?: ProviderOverride;
  routing?: ChatRouteDecision;
};

type ChatRouteRequest = {
  message?: string;
  mode?: 'analyze' | 'build' | 'decide';
  attachments?: Array<{ name?: string; mimeType?: string; kind?: string }>;
  conversationContext?: Array<{ role?: string; content?: string }>;
  currentGraph?: AgentGraph | null;
  provider?: ProviderOverride;
};

type ImageRequest = {
  prompt?: string;
  mode?: 'generate' | 'edit';
  size?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  n?: number;
  imageData?: string;
  provider?: ProviderOverride;
};

type ResolvedProvider = {
  apiKey: string;
  baseUrl: string;
  model: string;
  location: 'internet' | 'local';
};

const defaultTextProvider = {
  apiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? '',
  baseUrl: process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  visionModel: process.env.DEEPSEEK_VISION_MODEL ?? 'deepseek-v4-flash-vision-exp',
};
const defaultVisionProvider = {
  apiKey: process.env.DEEPSEEK_VISION_API_KEY?.trim() || defaultTextProvider.apiKey,
  baseUrl: process.env.DEEPSEEK_VISION_API_BASE?.trim() || defaultTextProvider.baseUrl,
  model: process.env.DEEPSEEK_VISION_MODEL ?? 'deepseek-v4-flash-vision-exp',
};
const nativeSearchModel = process.env.DEEPSEEK_NATIVE_SEARCH_MODEL?.trim() || 'deepseek-v4-flash';
const nativeSearchEnabled = process.env.DEEPSEEK_NATIVE_SEARCH !== 'false';
const configuredNativeSearchMaxTokens = Number(process.env.DEEPSEEK_NATIVE_SEARCH_MAX_TOKENS ?? 6_144);
const nativeSearchMaxTokens = Number.isFinite(configuredNativeSearchMaxTokens)
  ? Math.max(1_024, Math.min(8_192, configuredNativeSearchMaxTokens))
  : 6_144;

const defaultImageProvider = {
  apiKey: process.env.DMX_API_KEY?.trim() ?? '',
  baseUrl: process.env.DMX_BASE_URL ?? 'https://www.dmxapi.cn',
  model: process.env.DMX_MODEL ?? 'gpt-image-2-03',
};
const defaultVideoProvider = {
  apiKey: process.env.VIDEO_API_KEY?.trim() ?? '',
  baseUrl: process.env.VIDEO_API_BASE?.trim() ?? '',
  model: process.env.VIDEO_MODEL?.trim() ?? '',
};

const port = Number(process.env.API_PORT ?? 8787);
const maxImageRequestBytes = 22 * 1024 * 1024;
const maxChatRequestBytes = 14 * 1024 * 1024;
const app = new Hono();
const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['req.headers.authorization', 'apiKey', '*.apiKey'],
});
const metrics = new RuntimeMetrics();
const taskStore = createTaskStore();
await taskStore.initialize();
const providerCredentialStore = createProviderCredentialStore();
await providerCredentialStore.initialize();
const templateStore = createTemplateStore();
await templateStore.initialize();
const pluginStore = createPluginStore();
await pluginStore.initialize();
const agentStore = createAgentStore();
await agentStore.initialize();
const businessCapabilityStore = createBusinessCapabilityStore();
await businessCapabilityStore.initialize();
const integrationCredentialStore = createIntegrationCredentialStore();
await integrationCredentialStore.initialize();
const outboundNotificationStore = createOutboundNotificationStore();
await outboundNotificationStore.initialize();
const outboundNotifications = new OutboundNotificationManager(outboundNotificationStore, fetch, logger);
outboundNotifications.start();
const eventHub = new EventHub();
eventHub.subscribeAll((event) => {
  metrics.recordEvent(event);
  if (event.type === 'task.completed') metrics.recordTask('completed');
  if (event.type === 'task.failed') metrics.recordTask('failed');
  if (event.type === 'task.cancelled') metrics.recordTask('cancelled');
});
const runtimeModel = new OpenAICompatibleModelClient({ onUsage: (usage) => metrics.recordUsage(usage) });
const configuredModelNames = (process.env.AXIOM_ALLOWED_MODELS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const modelRoutingCandidates = [...new Set([defaultTextProvider.model, ...configuredModelNames])];
const modelRoutingPolicy = new ModelRoutingPolicy(parseModelCostCatalog(process.env.AXIOM_MODEL_COSTS));
if (taskStore.getModelRoutingStats) {
  try {
    modelRoutingPolicy.restore(await taskStore.getModelRoutingStats());
  } catch (error) {
    logger.warn({ error }, 'model-routing history could not be restored; starting with cold statistics');
  }
}
eventHub.subscribeAll((event) => modelRoutingPolicy.recordEvent(event));
try {
  for (const feedback of await businessCapabilityStore.listAll('feedback', 10_000)) {
    const score = Number(feedback.data.score);
    const issueTypes = Array.isArray(feedback.data.issueTypes) ? feedback.data.issueTypes.filter((item): item is string => typeof item === 'string') : [];
    const models = Array.isArray(feedback.data.models) ? feedback.data.models.filter((item): item is string => typeof item === 'string') : typeof feedback.data.model === 'string' ? [feedback.data.model] : [];
    for (const model of models) modelRoutingPolicy.recordFeedback({ model, score, routingIssue: issueTypes.includes('routing'), humanTakeover: issueTypes.includes('routing') });
  }
} catch (error) {
  logger.warn({ error }, 'business feedback could not be restored into model routing');
}
const runtimeMemory = new TencentMemoryClient();
await runtimeMemory.initialize();
const memoryCompensationWorker = new MemoryCaptureCompensationWorker(runtimeMemory);
memoryCompensationWorker.start();
const runtimeArtifactStore = createArtifactStore();
const runtimeArtifactCatalog = createArtifactCatalog();
await runtimeArtifactCatalog.initialize();
try {
  const reconciledArtifacts = await runtimeArtifactCatalog.reconcile();
  if (reconciledArtifacts > 0) logger.info({ count: reconciledArtifacts }, 'reconciled durable Artifact records');
} catch (error) {
  logger.warn({ error }, 'Artifact catalog reconciliation skipped; runtime results remain durable');
}
const runtimeTools = new ToolRegistry(undefined, runtimeArtifactStore, agentStore, runtimeArtifactCatalog);
try {
  const registeredExternalTools = await registerPersistedExternalTools(businessCapabilityStore, runtimeTools, integrationCredentialStore);
  if (registeredExternalTools > 0) logger.info({ count: registeredExternalTools }, 'restored external MCP/OpenAPI tools');
} catch (error) {
  logger.warn({ error }, 'external tools could not be restored; built-in tools remain available');
}
// The sidecar adapter is lazy: without an explicit command and activation it
// never spawns a child process and the built-in runtime remains authoritative.
const hasCodexSidecar = Boolean(process.env.CODEX_APP_SERVER_COMMAND?.trim() || process.env.CODEX_APP_SERVER_COMMAND_JSON?.trim());
const hasDeepSeekSidecar = Boolean(process.env.DEEPSEEK_HARNESS_COMMAND?.trim() || process.env.DEEPSEEK_HARNESS_COMMAND_JSON?.trim());
// Keep the built-in runtime as the only executor until an explicit stdio
// sidecar command is configured. Capability discovery over HTTP is read-only
// and must not create a delegation bridge that can compete with the Worker.
const harnessAdapter = hasCodexSidecar
  ? new CodexHarnessAdapter()
  : hasDeepSeekSidecar
    ? new DeepSeekHarnessAdapter()
    : undefined;
const resolveTaskModel = async (task: { modelCredentialId?: string; tenantId: string; userId: string }) => {
  if (!task.modelCredentialId) return runtimeModel;
  const credential = await providerCredentialStore.get(task.modelCredentialId, task.tenantId, task.userId);
  if (!credential || credential.kind !== 'text') throw new Error('Task text model credential is unavailable or not owned by the current user.');
  const baseUrl = normalizeProviderBaseUrl(credential.apiUrl, defaultTextProvider.baseUrl, credential.location);
  return new OpenAICompatibleModelClient({
    apiKey: credential.apiKey,
    apiBase: baseUrl,
    model: credential.model,
    apiKeyOptional: credential.location === 'local',
    onUsage: (usage) => metrics.recordUsage(usage),
  });
};
const orchestrator = new WorkflowOrchestrator(taskStore, eventHub, runtimeModel, runtimeMemory, logger, runtimeTools, agentStore, resolveTaskModel, modelRoutingPolicy, runtimeArtifactStore, runtimeArtifactCatalog, businessCapabilityStore);
const coordinator = new TaskCoordinator(taskStore, orchestrator, logger);
coordinator.start();

const apiKeyGuard = process.env.AXIOM_API_KEY?.trim();
if (process.env.NODE_ENV === 'production' && !apiKeyGuard && process.env.AXIOM_TRUST_PROXY_AUTH !== 'true') {
  throw new Error('AXIOM_API_KEY or AXIOM_TRUST_PROXY_AUTH=true is required in production.');
}

const allowedOrigins = new Set(
  (process.env.AXIOM_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  const originAllowed = isOriginAllowed(origin, allowedOrigins);
  if (!originAllowed) {
    return c.json({ error: '当前来源不在允许列表中。' }, 403);
  }
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Axiom-Tenant-Id, X-Axiom-User-Id, X-Axiom-Principal, Traceparent');
    c.header('Access-Control-Expose-Headers', 'X-Trace-Id, X-Request-Id, Traceparent');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  if (apiKeyGuard && c.req.path !== '/api/health') {
    const supplied = c.req.header('authorization');
    if (supplied !== `Bearer ${apiKeyGuard}`) return c.json({ error: 'Unauthorized.' }, 401);
  }
  if (process.env.AXIOM_PRINCIPAL_SECRET?.trim() && c.req.path !== '/api/health' && !verifyPrincipal(c.req.raw.headers)) {
    return c.json({ error: 'Signed tenant principal is required.' }, 401);
  }
  const requestId = c.req.header('x-request-id')?.slice(0, 100) || randomUUID();
  const trace = resolveTraceContext(c.req.raw.headers);
  c.header('X-Request-Id', requestId);
  c.header('X-Trace-Id', trace.traceId);
  c.header('traceparent', trace.traceparent);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  const startedAt = Date.now();
  await next();
  metrics.recordRequest(c.res.status, Date.now() - startedAt);
  logger.info({ requestId, traceId: trace.traceId, spanId: trace.spanId, method: c.req.method, path: c.req.path, status: c.res.status, durationMs: Date.now() - startedAt }, 'api request');
});

const modePrompts: Record<NonNullable<ChatRequest['mode']>, string> = {
  analyze:
    'Analyze the request carefully. Surface assumptions, risks, and evidence. Give a concise conclusion followed by actionable detail.',
  build:
    'Act as a senior implementation agent. Turn the request into a concrete, production-minded solution with explicit decisions and executable next steps.',
  decide:
    'Act as a decision partner. Compare the real tradeoffs, recommend one direction, and state the conditions that would change the decision.',
};

const systemPrompt = (mode: NonNullable<ChatRequest['mode']>) => `You are Axiom, an expert agent.
${modePrompts[mode]}
Use the same language as the user. Be direct and technically rigorous. Do not claim to have executed tools or accessed systems unless the conversation explicitly contains that evidence. Use Markdown only where it improves readability. When search sources are provided, distinguish source facts from your reasoning and keep the source URLs in the answer.`;

const encodeEvent = (event: string, data: unknown) =>
  new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

type CleanMessagesResult = {
  messages: ClientMessage[];
  summaryApplied: boolean;
  summarizedMessages: number;
  estimatedTokens: number;
  summaryVersion: string | null;
  summaryCoverage: { start: number; end: number; total: number } | null;
  durableSummaryId?: string;
};

const cleanMessages = async (messages: unknown, persistedSummary?: PersistedContextSummary): Promise<CleanMessagesResult> => {
  if (!Array.isArray(messages)) return {
    messages: [], summaryApplied: false, summarizedMessages: 0, estimatedTokens: 0, summaryVersion: null, summaryCoverage: null,
  };

  const candidates = messages
    .filter(
      (message): message is ClientMessage & { attachments?: ClientAttachment[] } =>
        typeof message === 'object' &&
        message !== null &&
        ('role' in message && (message.role === 'user' || message.role === 'assistant')) &&
        ('content' in message && (typeof message.content === 'string' || Array.isArray(message.content))),
    );
  const durableSources = candidates.every((message) => typeof message.id === 'string' && message.id.length > 0)
    ? candidates as DurableContextSourceMessage[]
    : [];
  const durableSummaryUsed = durableSources.length > 0 && validatePersistedContextSummary(persistedSummary, durableSources);
  const coveredMessageIds = durableSummaryUsed ? new Set(persistedSummary!.coveredMessageIds) : new Set<string>();
  const cleaned = candidates
    .filter((message) => !message.id || !coveredMessageIds.has(message.id))
    .map(async (message) => {
      const rawContent = typeof message.content === 'string' ? message.content.trim().slice(0, 24_000) : '';
      const attachments = message.role === 'user' && Array.isArray(message.attachments)
        ? message.attachments.filter((attachment): attachment is ClientAttachment => typeof attachment === 'object' && attachment !== null).slice(0, 6)
        : [];
      const parts: ClientContentPart[] = [];
      if (rawContent) parts.push({ type: 'text', text: rawContent });
      for (const attachment of attachments) {
        if (attachment.url?.startsWith('data:image/')) parts.push({ type: 'image_url', image_url: { url: attachment.url.slice(0, 12 * 1024 * 1024) } });
        const extracted = await extractAttachmentText(attachment);
        if (extracted) parts.push({ type: 'text', text: `[附件：${attachment.name ?? '未命名文件'}]\n${extracted}` });
        if (/\.pdf$/i.test(attachment.name ?? '')) parts.push(...await attachmentPdfVisualPages(attachment, extracted));
      }
      return { role: message.role, content: parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts };
    });
  const recent = (await Promise.all(cleaned))
    .filter((message) => Array.isArray(message.content) ? message.content.length > 0 : message.content.length > 0);
  const normalized = durableSummaryUsed
    ? [{ role: 'assistant' as const, content: persistedSummary!.content }, ...recent]
    : recent;
  const bounded = buildContextWindow<ClientMessage>(normalized, {
    recentMessages: 12,
    triggerMessages: 16,
    maxMessages: 24,
    maxCharacters: 48_000,
    maxSummaryCharacters: 8_000,
    maxTokens: Math.max(512, Number(process.env.AXIOM_CONTEXT_MAX_TOKENS ?? 12_000)),
  });
  return {
    messages: bounded.messages,
    summaryApplied: durableSummaryUsed || bounded.summaryApplied,
    summarizedMessages: (durableSummaryUsed ? persistedSummary!.coveredMessageIds.length : 0) + bounded.summarizedMessages,
    estimatedTokens: bounded.estimatedTokens,
    summaryVersion: durableSummaryUsed ? `${persistedSummary!.algorithm}@${persistedSummary!.version}` : bounded.summaryVersion,
    summaryCoverage: durableSummaryUsed
      ? { start: 0, end: persistedSummary!.coveredMessageIds.length - 1, total: candidates.length }
      : bounded.summaryCoverage,
    ...(durableSummaryUsed ? { durableSummaryId: persistedSummary!.summaryId } : {}),
  };
};

const messageText = (message: ClientMessage) => Array.isArray(message.content)
  ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  : message.content;

const providerHeaders = (provider: ResolvedProvider, json = true) => ({
  ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

const endpoint = (baseUrl: string, suffix: string) => {
  if (baseUrl.endsWith(suffix)) return baseUrl;
  if (suffix.startsWith('/v1/') && baseUrl.endsWith('/v1')) return `${baseUrl}${suffix.slice(3)}`;
  return `${baseUrl}${suffix}`;
};

const deepSeekApiHost = (baseUrl: string) => {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com');
  } catch {
    return false;
  }
};

const nativeSearchProvider = (provider: ResolvedProvider, override?: ProviderOverride) => {
  if (!nativeSearchEnabled) return null;
  // Search is an independent specialist. A custom conversation provider must
  // not silently disable DeepSeek native search for live-information intents.
  const activeProviderIsDeepSeek = deepSeekApiHost(provider.baseUrl);
  const searchProvider = activeProviderIsDeepSeek
    ? provider
      : {
        apiKey: defaultTextProvider.apiKey,
        baseUrl: defaultTextProvider.baseUrl,
        model: nativeSearchModel,
        location: 'internet' as const,
      };
  if (!searchProvider.apiKey || !deepSeekApiHost(searchProvider.baseUrl)) return null;
  const explicitModel = activeProviderIsDeepSeek ? override?.model?.trim() : undefined;
  return {
    ...searchProvider,
    baseUrl: searchProvider.baseUrl.replace(/\/v1$/i, ''),
    // The user's text model remains untouched. Search is a dedicated Agent and
    // always uses a native-search capable model unless that model was explicitly selected.
    model: explicitModel && /^deepseek-v4-(?:flash|pro)$/i.test(explicitModel) ? explicitModel : nativeSearchModel,
  };
};

const redactSecrets = (message: string) => message.replace(/sk-[A-Za-z0-9_-]{10,}/g, '[redacted-key]');

const requestSignal = (requestSignal: AbortSignal, timeoutMs: number) =>
  AbortSignal.any([requestSignal, AbortSignal.timeout(timeoutMs)]);

const waitForRetry = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

const resolveProvider = (
  override: ProviderOverride | undefined,
  defaults: { apiKey: string; baseUrl: string; model: string },
  label: string,
  options: { apiKeyOptional?: boolean } = {},
): ResolvedProvider => {
  const hasOverride = Boolean(override);
  const location = hasOverride ? override?.location ?? 'internet' : 'internet';
  const apiKey = (hasOverride ? override?.apiKey : defaults.apiKey)?.trim() ?? '';
  if (!apiKey && !options.apiKeyOptional && location !== 'local') throw new Error(`${label} API key is not configured.`);
  const rawBaseUrl = hasOverride ? override?.apiUrl ?? defaults.baseUrl : defaults.baseUrl;
  if (!rawBaseUrl?.trim()) throw new Error(`${label} API URL is not configured.`);
  const model = (hasOverride ? override?.model ?? defaults.model : defaults.model).trim() || defaults.model;
  if (!model) throw new Error(`${label} model is not configured.`);

  return {
    apiKey,
    baseUrl: normalizeProviderBaseUrl(
      rawBaseUrl,
      defaults.baseUrl,
      location,
    ),
    model,
    location,
  };
};

const resolveProviderForRequest = async (
  override: ProviderOverride | undefined,
  defaults: { apiKey: string; baseUrl: string; model: string },
  label: string,
  tenantId: string,
  userId: string,
  kind: ProviderCredentialKind,
  options: { apiKeyOptional?: boolean } = {},
): Promise<ResolvedProvider> => {
  if (!override?.credentialId) return resolveProvider(override, defaults, label, options);
  const credential = await providerCredentialStore.get(override.credentialId, tenantId, userId);
  if (!credential) throw new Error(`${label} credential not found or not owned by the current user.`);
  if (credential.kind !== kind) throw new Error(`${label} credential type does not match this request.`);
  await providerCredentialStore.touch(credential.id, tenantId, userId);
  return resolveProvider({
    apiKey: credential.apiKey,
    apiUrl: credential.apiUrl,
    model: credential.model,
    location: credential.location,
  }, defaults, label, options);
};

const pluginModelFactory = async (override?: ProviderOverride, tenantId = 'local', userId = 'local-user') => {
  if (!override) return runtimeModel;
  const provider = await resolveProviderForRequest(override, defaultTextProvider, '插件设计 Agent 文本模型', tenantId, userId, 'text');
  return new OpenAICompatibleModelClient({
    apiKey: provider.apiKey,
    apiBase: provider.baseUrl,
    model: provider.model,
    apiKeyOptional: provider.location === 'local',
    onUsage: (usage) => metrics.recordUsage(usage),
  });
};

const reportModelFactory = async (credentialId: string | undefined, tenantId: string, userId: string) => {
  if (!credentialId) return runtimeModel;
  const provider = await resolveProviderForRequest({ credentialId }, defaultTextProvider, '报告生成 Agent 文本模型', tenantId, userId, 'text');
  return new OpenAICompatibleModelClient({
    apiKey: provider.apiKey,
    apiBase: provider.baseUrl,
    model: provider.model,
    apiKeyOptional: provider.location === 'local',
    onUsage: (usage) => metrics.recordUsage(usage),
  });
};

app.route('/api', createTaskApi({
  store: taskStore,
  hub: eventHub,
  coordinator,
  metrics,
  model: runtimeModel,
  reportModelFactory,
  scheduleModelFactory: reportModelFactory,
  pluginModelFactory,
  toolRegistry: runtimeTools,
  artifactStore: runtimeArtifactStore,
  artifactCatalog: runtimeArtifactCatalog,
  templates: templateStore,
  plugins: pluginStore,
  agents: agentStore,
  memory: runtimeMemory,
  resolveModelCredential: async (credentialId, tenantId, userId) => {
    const credential = await providerCredentialStore.get(credentialId, tenantId, userId);
    return credential?.kind === 'text' ? { id: credential.id, model: credential.model } : null;
  },
  harnessAdapter,
  outboundNotifications,
  businessCapabilities: businessCapabilityStore,
  integrationCredentials: integrationCredentialStore,
  modelRouting: modelRoutingPolicy,
}));

const parseImageData = (imageData: string) => {
  const match = imageData.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error('Edited images must be sent as a base64 data URL.');
  const [, contentType, encoded] = match;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength > 15 * 1024 * 1024) throw new Error('Edited image is larger than 15 MB.');
  return { bytes, contentType };
};

const readImageResponse = (payload: unknown, prompt: string) => {
  const data = (payload as { data?: Array<{ url?: string; b64_json?: string }> })?.data;
  if (!Array.isArray(data)) return [];

  return data.flatMap((item, index) => {
    const url = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
    return url
      ? [{ id: randomUUID(), url, alt: `${prompt.slice(0, 100)}${index > 0 ? ` ${index + 1}` : ''}` }]
      : [];
  });
};

const extractSearchQuery = (message: string) => {
  const cleaned = message
    .replace(/^\s*(?:请|帮我|麻烦|能否|可以)?\s*(?:联网|上网|网上)?\s*(?:搜索一下|搜一下|搜索|查找|查询|找一下)\s*/i, '')
    .replace(/^\s*(?:现在|目前|当前|最新)?\s*(?:有哪些|有什么|列出|推荐|找出)\s*/i, '')
    .replace(/^\s*(?:search(?:ing)?|look up|find)\s+/i, '')
    .replace(/[，。！？,.!?]+\s*$/u, '')
    .trim();
  return cleaned || message.trim();
};

type SearchRow = {
  title: string;
  url: string;
  snippet: string;
  structured?: boolean;
  sourceType?: 'github' | 'web' | 'weather';
  stars?: number;
  updatedAt?: string;
  license?: string;
  description?: string;
};
const searchTimeZone = process.env.AXIOM_TIME_ZONE?.trim() || 'Asia/Shanghai';
const searchDateParts = () => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: searchTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'long',
}).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])) as Record<string, string>;
const searchDateLabel = () => {
  const parts = searchDateParts();
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const isTemporalSearch = (query: string) => /(今天|今日|现在|当前|最新|最近|热点|实时|today|current|latest|breaking|news)/i.test(query);
const isWeatherSearch = (query: string) => /(天气|气温|温度|预报|weather|temperature|forecast)/i.test(query);
const isAgentProjectSearch = (query: string) => {
  const value = query.toLowerCase();
  const hasAgent = /agent|智能体/.test(value);
  const hasSearchTopic = /搜索|研究|项目|工具|框架|search|research|project|framework/.test(value);
  const hasOpenSource = /开源|open[ -]?source/.test(value);
  return (hasOpenSource && hasAgent && hasSearchTopic) || (/agentic|deep ?research/.test(value) && /search|project|framework/.test(value));
};

const decodeHtml = (value: string) => value
  .replace(/&#(x?[0-9a-f]+);/gi, (_, raw: string) => {
    const code = raw.toLowerCase().startsWith('x') ? Number.parseInt(raw.slice(1), 16) : Number.parseInt(raw, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  })
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&#39;|&apos;/g, "'");

const stripHtml = (value: string) => decodeHtml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const stripDocument = (value: string) => stripHtml(value.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' '));
const canonicalSearchUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
};

const weatherCodeLabels: Record<number, string> = {
  0: '晴', 1: '大部晴朗', 2: '局部多云', 3: '阴',
  45: '雾', 48: '冻雾', 51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪',
  80: '阵雨', 81: '中阵雨', 82: '强阵雨', 95: '雷暴', 96: '雷暴伴小冰雹', 99: '雷暴伴大冰雹',
};

const extractWeatherLocation = (query: string) => query
  .replace(/(今天|今日|明天|后天|现在|当前|实时|天气|气温|温度|预报|weather|temperature|forecast|today|current)/gi, ' ')
  .replace(/(搜索一下|搜一下|搜索|查找|查询|找一下)/g, ' ')
  .replace(/[，。！？,.!?]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim() || '北京';

const fetchLiveWeather = async (query: string, signal: AbortSignal): Promise<SearchRow | null> => {
  const locationQuery = extractWeatherLocation(query).slice(0, 80);
  const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationQuery)}&count=1&language=zh&format=json`;
  const geocodeResponse = await fetch(geocodeUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'Axiom-Agent-Control-Room/1.0' },
    signal: requestSignal(signal, 6_000),
  });
  if (!geocodeResponse.ok) return null;
  const geocode = await geocodeResponse.json() as { results?: Array<{ name?: string; latitude?: number; longitude?: number; timezone?: string; country?: string }> };
  const location = geocode.results?.[0];
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;

  const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=${encodeURIComponent(location.timezone || searchTimeZone)}&forecast_days=1`;
  const forecastResponse = await fetch(forecastUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'Axiom-Agent-Control-Room/1.0' },
    signal: requestSignal(signal, 8_000),
  });
  if (!forecastResponse.ok) return null;
  const forecast = await forecastResponse.json() as {
    current?: { time?: string; temperature_2m?: number; relative_humidity_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number };
    daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[] };
    current_units?: { temperature_2m?: string; relative_humidity_2m?: string; apparent_temperature?: string; wind_speed_10m?: string };
  };
  const current = forecast.current;
  const daily = forecast.daily;
  if (!current?.time) return null;
  const date = current.time.slice(0, 10);
  const unit = forecast.current_units ?? {};
  const weather = weatherCodeLabels[current.weather_code ?? -1] ?? `天气代码 ${current.weather_code ?? '未知'}`;
  const max = daily?.temperature_2m_max?.[0];
  const min = daily?.temperature_2m_min?.[0];
  const rain = daily?.precipitation_probability_max?.[0];
  return {
    title: `${location.name ?? locationQuery}实时天气（${date}）`,
    url: forecastUrl,
    structured: true,
    sourceType: 'weather',
    snippet: [
      `数据时间：${current.time}（${location.timezone || searchTimeZone}）`,
      `天气：${weather}`,
      Number.isFinite(current.temperature_2m) ? `当前温度：${current.temperature_2m}${unit.temperature_2m ?? '°C'}` : '',
      Number.isFinite(current.apparent_temperature) ? `体感温度：${current.apparent_temperature}${unit.apparent_temperature ?? '°C'}` : '',
      Number.isFinite(current.relative_humidity_2m) ? `相对湿度：${current.relative_humidity_2m}${unit.relative_humidity_2m ?? '%'}` : '',
      Number.isFinite(current.wind_speed_10m) ? `风速：${current.wind_speed_10m}${unit.wind_speed_10m ?? 'km/h'}` : '',
      Number.isFinite(min) && Number.isFinite(max) ? `今日温度范围：${min}°C 至 ${max}°C` : '',
      Number.isFinite(rain) ? `今日降水概率：${rain}%` : '',
    ].filter(Boolean).join('；'),
  };
};

const structuredWeatherAnswer = (row: SearchRow | undefined) => {
  if (!row?.structured || row.sourceType !== 'weather' || !row.url.includes('open-meteo.com')) return '';
  const bullets = row.snippet.split('；').map((item) => item.trim()).filter(Boolean).map((item) => `- ${item}`).join('\n');
  return `### ${row.title}\n\n${bullets}\n\n数据来源： [Open-Meteo 实时接口](${row.url})\n\n> 这是结构化天气数据，不使用搜索摘要推断；如需出行决策，请以当地气象部门的预警为准。`;
};

const structuredWeatherUnavailableAnswer = (query: string) =>
  `### 天气 Agent 暂时无法完成结构化查询\n\n当前无法从 Open-Meteo 获取“${query.slice(0, 120)}”的实时结构化数据，因此没有返回温度、天气现象或降水概率，也不会使用普通网页摘要猜测天气。\n\n数据源入口：[Open-Meteo](https://open-meteo.com/)\n\n> 检索基准日期：${searchDateLabel()}（${searchTimeZone}）。请稍后重试，或以当地气象部门的预警为准。`;

const structuredAgentProjectAnswer = (rows: SearchRow[], query: string) => {
  const projects = rows.filter((row) => row.sourceType === 'github' && row.url.startsWith('https://github.com/'));
  if (projects.length === 0) return '';
  const entries = projects.map((row, index) => {
    const stars = typeof row.stars === 'number' ? row.stars.toLocaleString('en-US') : '未返回';
    const updated = row.updatedAt || '未返回';
    const license = row.license || '未返回';
    const description = (row.description || row.snippet || '仓库没有返回描述').replace(/\s+/g, ' ').trim();
    return `${index + 1}. **${row.title}**\n   - 仓库：[GitHub 原始仓库](${row.url})\n   - 定位：${description}\n   - 检索时点：${searchDateLabel()}；Stars：${stars}；最近更新：${updated}；许可证：${license}`;
  }).join('\n\n');
  return `### 开源 Agent 搜索 / 深度研究项目\n\n检索主题：${query}\n\n以下字段直接来自 GitHub Repository Search API，属于 ${searchDateLabel()}（${searchTimeZone}）检索时点数据；项目描述仅保留仓库公开简介，不把模型推断当作事实。\n\n${entries}\n\n### 选型提示\n\n- 通用网页深度研究：优先比较项目的搜索适配器、网页抓取、引用和报告导出能力。\n- 企业私有资料：重点核对数据源权限、索引隔离、审计和部署方式。\n- 接入 Axiom：建议把候选项目作为受控 Search Provider 或研究工作流插件，保留来源、抓取时间和原始 URL，不能只保存模型总结。\n\n> Star、最近更新和许可证均需以打开仓库后的最新页面为准；本答案不替代代码与许可证审查。`;
};

const enrichSearchRow = async (row: SearchRow, signal: AbortSignal): Promise<SearchRow> => {
  if (row.structured) return row;
  try {
    const parsed = new URL(row.url);
    if (/(bing|google|baidu|sogou|so\.com|duckduckgo)\./i.test(parsed.hostname)) return row;
    const response = await fetch(row.url, {
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (Axiom Agent Control Room)' },
      signal: requestSignal(signal, 6_000),
    });
    if (!response.ok) return row;
    const html = (await response.text()).slice(0, 2_000_000);
    const excerpt = stripDocument(html).slice(0, 1_600);
    return excerpt.length >= 120 ? { ...row, snippet: `${row.snippet}\n网页摘录：${excerpt}` } : row;
  } catch {
    return row;
  }
};

const searchGithubAgentProjects = async (signal: AbortSignal): Promise<SearchRow[]> => {
  const query = 'agentic search deep research';
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=8`;
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Axiom-Agent-Control-Room/1.0' },
    signal: requestSignal(signal, 8_000),
  });
  if (!response.ok) throw new Error(`GitHub 项目检索返回 HTTP ${response.status}`);
  const payload = await response.json() as { items?: Array<{ full_name?: string; html_url?: string; description?: string | null; stargazers_count?: number; updated_at?: string; license?: { spdx_id?: string | null } | null }> };
  const rows = (payload.items ?? []).flatMap((item) => {
    if (!item.full_name || !item.html_url) return [];
    const updated = item.updated_at?.slice(0, 10) ?? '未返回';
    const stars = typeof item.stargazers_count === 'number' && Number.isFinite(item.stargazers_count) ? item.stargazers_count : 0;
    return [{
      title: item.full_name,
      url: item.html_url,
      snippet: item.description?.trim() || '仓库没有返回描述',
      description: item.description?.trim() || '仓库没有返回描述',
      structured: true,
      sourceType: 'github',
      stars,
      updatedAt: updated,
      license: item.license?.spdx_id || '未返回',
    } satisfies SearchRow];
  });
  if (rows.length === 0) throw new Error('GitHub 没有返回可用项目');
  return rows;
};

const searchBing = async (query: string, signal: AbortSignal) => {
  const freshness = isTemporalSearch(query) ? '&freshness=Day' : '';
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query.slice(0, 240))}&count=8&setlang=zh-Hans&setmkt=zh-CN${freshness}`;
  const response = await fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (Axiom Agent Control Room)' },
    signal: requestSignal(signal, 12_000),
  });
  if (!response.ok) throw new Error(`Bing 搜索服务返回 HTTP ${response.status}`);
  const html = await response.text();
  const rows = [...html.matchAll(/<li\s+class="b_algo"[\s\S]*?<\/li>/gi)].flatMap((match) => {
    const block = match[0];
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      ?? block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!titleMatch?.[1] || !titleMatch[2]) return [];
    const title = stripHtml(titleMatch[2]);
    const snippet = stripHtml(snippetMatch?.[1] ?? title);
    const resultUrl = decodeHtml(titleMatch[1]);
    return title && /^https?:\/\//i.test(resultUrl) ? [{ title: title.slice(0, 120), url: resultUrl, snippet: snippet.slice(0, 500) } satisfies SearchRow] : [];
  }).slice(0, 6);
  if (rows.length === 0) throw new Error('Bing 未返回可解析的搜索结果');
  return rows;
};

const formatSearchRows = (rows: SearchRow[]) => rows.map((row, index) => `[来源 ${index + 1}] ${row.title}\nURL: ${row.url}\n${row.snippet}`).join('\n\n');

type ResponseInputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_image'; file_id: string };

const responseInput = (messages: ClientMessage[]) => messages.map((message) => ({
  type: 'message',
  role: message.role,
  content: typeof message.content === 'string'
    ? [{ type: 'input_text', text: message.content }]
    : message.content
      .flatMap((part): ResponseInputPart[] => {
        if (part.type === 'text') return [{ type: 'input_text', text: part.text }];
        if (part.type === 'image_url') return [{ type: 'input_image', image_url: part.image_url.url }];
        return [{ type: 'input_image', file_id: part.file.file_id }];
      }),
}));

type NativeResponsePayload = {
  type?: string;
  delta?: string;
  response?: { usage?: Record<string, number>; status?: string; incomplete_details?: unknown };
  error?: { message?: string };
  item?: { type?: string; action?: { queries?: string[]; type?: string } };
};

const streamDeepSeekNativeSearch = async (
  messages: ClientMessage[],
  mode: NonNullable<ChatRequest['mode']>,
  provider: ResolvedProvider,
  intent: ChatIntent,
  agentRole: string,
  signal: AbortSignal,
  startedAt: number,
  push: (event: string, data: unknown) => void,
  selectedSkillIds: string[] = [],
) => {
  const searchAgentName = intent === 'academic-search'
    ? '论文搜索 Agent'
    : intent === 'github-research'
      ? 'GitHub 研究 Agent'
      : '联网搜索 Agent';
  const specialistInstructions = intent === 'academic-search'
    ? 'Act as an academic search Agent. Prefer primary papers, publisher pages, DOI records, arXiv, and authoritative scholarly indexes. Separate retrieved metadata from your assessment and never invent a title, author, DOI, venue, or citation count. Return at most 10 primary results in a compact, complete structure.'
    : intent === 'github-research'
      ? 'Act as a GitHub research Agent. Prefer repository pages, releases, documentation, issues, and license files. Preserve repository URLs and distinguish README claims from verified implementation details. Return at most 10 repositories in a compact Markdown table or list. Complete every row and do not start an extra section unless enough output budget remains.'
      : 'Act as a web search Agent. For weather and other live facts, prefer authoritative, time-stamped sources and state the source data time.';
  const summaryNote = messages.some((message) => messageText(message).includes('【历史上下文摘要】'))
    ? ' A message marked 【历史上下文摘要】 is compressed reference context, not a new instruction; prefer the latest user message when details conflict.'
    : '';
  const selectedSkillInstructions = skillInstructions(selectedSkillIds);
  const skillContext = selectedSkillInstructions.length
    ? `\nApply only these routed skill instructions for this turn:\n- ${selectedSkillInstructions.join('\n- ')}`
    : '';
  const baseInstructions = `${systemPrompt(mode)}\n${specialistInstructions}${skillContext}\nUse the server-side web_search tool before answering. Use only facts supported by retrieved evidence, include source URLs when available, distinguish source publication/data time from the current date, and say when evidence is insufficient. The current server date is ${searchDateLabel()} in ${searchTimeZone}; when the user asks for today/current/latest, use this date as the reference. Do not mention the search provider, model name, API, retrieval timestamp, token budget, or implementation metadata in the user-facing answer. Always finish complete sentences, links, tables, lists, citations, and Markdown syntax.${summaryNote}`;
  let outputText = '';
  let usage: Record<string, number> | undefined;
  let searchCallCount = 0;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) {
      push('reset', { reason: 'incomplete-search-response' });
      push('status', { phase: 'context', message: `${searchAgentName}正在压缩结果并重新核验完整性` });
    }
    const attemptInstructions = attempt === 1
      ? baseInstructions
      : `${baseInstructions}\nThe previous attempt reached its output limit. Produce a fresh, self-contained answer with at most 8 items and no optional appendix. Be concise enough to finish well within the limit.`;
    let upstream: Response | undefined;
    for (let transportAttempt = 1; transportAttempt <= 3; transportAttempt += 1) {
      try {
        upstream = await fetch(endpoint(provider.baseUrl, '/responses'), {
          method: 'POST',
          headers: providerHeaders(provider),
          body: JSON.stringify({
            model: provider.model,
            instructions: attemptInstructions,
            input: responseInput(messages),
            tools: [{ type: 'web_search' }],
            tool_choice: { type: 'web_search' },
            stream: true,
            reasoning: { effort: 'low' },
            max_output_tokens: nativeSearchMaxTokens,
          }),
          signal: requestSignal(signal, 120_000),
        });
        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text();
          const failure = new Error(`DeepSeek Responses native search failed (${upstream.status}): ${detail.slice(0, 280)}`) as Error & { status?: number };
          failure.status = upstream.status;
          throw failure;
        }
        break;
      } catch (error) {
        const status = (error as Error & { status?: number }).status;
        const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
        if (!retryable || transportAttempt >= 3) throw error;
        push('status', { phase: 'context', message: `${searchAgentName}连接暂时不稳定，正在重试（${transportAttempt + 1}/3）` });
        await waitForRetry(Math.min(2_000, 300 * 2 ** (transportAttempt - 1)), signal);
      }
    }
    if (!upstream?.body) throw new Error('DeepSeek native search stream was unavailable.');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let attemptText = '';
    const responseOutcome: { state: 'streaming' | 'completed' | 'incomplete'; incompleteDetails?: unknown } = { state: 'streaming' };
    let emittedSearchStatus = false;

    const processBlock = (block: string) => {
      const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
      const rawData = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (!event || !rawData) return;
      let payload: NativeResponsePayload;
      try {
        payload = JSON.parse(rawData) as NativeResponsePayload;
      } catch {
        return;
      }

      if (event === 'response.reasoning_text.delta' && payload.delta) push('reasoning', { content: payload.delta });
      if (event === 'response.output_text.delta' && payload.delta) {
        attemptText += payload.delta;
        push('token', { content: payload.delta });
      }
      if ((event === 'response.output_item.added' && payload.item?.type === 'web_search_call')
        || event === 'response.web_search_call.in_progress'
        || event === 'response.web_search_call.searching') {
        searchCallCount += 1;
        if (!emittedSearchStatus) {
          emittedSearchStatus = true;
          push('status', { phase: 'context', message: `${searchAgentName}正在检索来源` });
        }
      }
      if (event === 'response.web_search_call.completed' || event === 'response.web_search_call.done') {
        push('status', { phase: 'context', message: `${searchAgentName}已取得检索结果，正在核验证据` });
      }
      if (event === 'response.completed') {
        responseOutcome.state = 'completed';
        usage = payload.response?.usage;
      }
      if (event === 'response.incomplete') {
        responseOutcome.state = 'incomplete';
        responseOutcome.incompleteDetails = payload.response?.incomplete_details;
      }
      if (event === 'response.failed') throw new Error(payload.error?.message || 'DeepSeek native search failed.');
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSseBlocks(buffer, processBlock);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);

    if (responseOutcome.state === 'completed' && attemptText.trim()) {
      outputText = attemptText;
      break;
    }
    if (responseOutcome.state === 'incomplete' && attempt < 2) continue;
    push('reset', { reason: responseOutcome.state === 'incomplete' ? 'search-output-limit' : 'search-stream-interrupted' });
    throw new Error(responseOutcome.state === 'incomplete'
      ? `DeepSeek native search output remained incomplete: ${JSON.stringify(responseOutcome.incompleteDetails ?? 'unknown').slice(0, 240)}`
      : 'DeepSeek native search stream ended without a completed response.');
  }

  if (!outputText.trim()) throw new Error('DeepSeek native search returned no complete text.');
  let outputCharacters = outputText.length;
  if (!/https?:\/\//i.test(outputText)) {
    const evidenceLimitation = '\n\n> 本次检索未返回可点击来源链接。';
    push('token', { content: evidenceLimitation });
    outputText += evidenceLimitation;
    outputCharacters += evidenceLimitation.length;
    push('status', { phase: 'context', message: `${searchAgentName}未取得可点击来源链接` });
  }

  push('complete', {
    durationMs: Date.now() - startedAt,
    outputCharacters,
    usage,
    model: provider.model,
    route: 'deepseek-native-search',
    agentRole,
    intent,
    searchCalls: searchCallCount,
  });
  metrics.recordUsage(usage);
};

const performSearchRows = async (query: string, signal: AbortSignal) => {
  let rows: SearchRow[];
  try {
    rows = isAgentProjectSearch(query) ? await searchGithubAgentProjects(signal) : (await searchBing(query, signal)).map((row) => ({ ...row, sourceType: 'web' as const }));
  } catch (primaryError) {
    if (isAgentProjectSearch(query)) throw primaryError;
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query.slice(0, 240))}&format=json&no_html=1&skip_disambig=1`;
      const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Axiom-Agent-Control-Room/1.0' }, signal: requestSignal(signal, 5_000) });
      if (!response.ok) throw new Error(`DuckDuckGo 搜索服务返回 HTTP ${response.status}`);
      const payload = await response.json() as { AbstractText?: string; AbstractURL?: string; RelatedTopics?: Array<{ Text?: string; FirstURL?: string }> };
      rows = [
        ...(payload.AbstractText ? [{ title: '摘要', url: payload.AbstractURL ?? '', snippet: payload.AbstractText }] : []),
        ...(payload.RelatedTopics ?? []).flatMap((topic) => topic.Text && topic.FirstURL ? [{ title: topic.Text.slice(0, 90), url: topic.FirstURL, snippet: topic.Text }] : []),
      ].filter((row) => row.url).slice(0, 6).map((row) => ({ ...row, sourceType: 'web' as const }));
      if (rows.length === 0) throw new Error('DuckDuckGo 未返回结果');
    } catch (duckError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : '主搜索源失败';
      const duckMessage = duckError instanceof Error ? duckError.message : 'DuckDuckGo 搜索失败';
      throw new Error(`${primaryMessage}；${duckMessage}`);
    }
  }
  const liveWeather = isWeatherSearch(query) ? await fetchLiveWeather(query, signal).catch(() => null) : null;
  const uniqueRows = [...(liveWeather ? [liveWeather] : []), ...rows].filter((row, index, all) => {
    const key = canonicalSearchUrl(row.url);
    return all.findIndex((candidate) => canonicalSearchUrl(candidate.url) === key) === index;
  }).slice(0, 6);
  const enrichedRows = await Promise.all(uniqueRows.map((row) => enrichSearchRow(row, signal)));
  return enrichedRows;
};

const generateChatImages = async (prompt: string, provider: ResolvedProvider, signal: AbortSignal) => {
  const response = await fetch(endpoint(provider.baseUrl, '/v1/images/generations'), {
    method: 'POST',
    headers: providerHeaders(provider),
    body: JSON.stringify({ model: provider.model, prompt: prompt.slice(0, 8_000), size: '1024x1024', n: 1, quality: 'auto' }),
    signal: requestSignal(signal, 600_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`绘图 Agent 请求失败 (${response.status})：${JSON.stringify(payload ?? {}).slice(0, 260)}`);
  const images = readImageResponse(payload, prompt);
  if (images.length === 0) throw new Error('绘图 Agent 没有返回图片。');
  return images;
};

const videoGenerationEndpoint = (baseUrl: string) => {
  const pathname = new URL(baseUrl).pathname.replace(/\/$/, '');
  if (/(?:videos?\/(?:generations?|create)|generate[-_/]?video|video[-_/]?generate)$/i.test(pathname)) return baseUrl;
  return endpoint(baseUrl, '/v1/videos/generations');
};

const videoUrlFromPayload = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const root = payload as Record<string, unknown>;
  const data = Array.isArray(root.data) ? root.data[0] as Record<string, unknown> | undefined : undefined;
  const output = Array.isArray(root.output) ? root.output[0] as Record<string, unknown> | undefined : undefined;
  const result = root.result && typeof root.result === 'object' ? root.result as Record<string, unknown> : undefined;
  const video = root.video && typeof root.video === 'object' ? root.video as Record<string, unknown> : undefined;
  const candidate = root.url ?? root.video_url ?? data?.url ?? data?.video_url ?? output?.url ?? result?.url ?? result?.video_url ?? video?.url;
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  const encoded = data?.b64_json ?? root.b64_json;
  return typeof encoded === 'string' && encoded ? `data:video/mp4;base64,${encoded}` : '';
};

const videoStatusFromPayload = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const root = payload as Record<string, unknown>;
  return String(root.status ?? (root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>).status : '') ?? '').toLowerCase();
};

const waitForVideoPoll = (signal: AbortSignal, delayMs: number) => new Promise<void>((resolveWait, reject) => {
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolveWait();
  }, delayMs);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
});

const generateChatVideo = async (prompt: string, provider: ResolvedProvider, signal: AbortSignal) => {
  const generationUrl = videoGenerationEndpoint(provider.baseUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const response = await fetch(generationUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: provider.model, prompt: prompt.slice(0, 8_000), response_format: 'url' }),
    signal: requestSignal(signal, 600_000),
  });
  let payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error(`视频制作 Agent 请求失败 (${response.status})：${JSON.stringify(payload ?? {}).slice(0, 260)}`);

  let videoUrl = videoUrlFromPayload(payload);
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const taskId = String(root.id ?? root.task_id ?? '').trim();
  const explicitPollUrl = typeof root.status_url === 'string' ? root.status_url.trim() : '';
  if (!videoUrl && (taskId || explicitPollUrl)) {
    const pollUrl = explicitPollUrl || `${generationUrl.replace(/\/$/, '')}/${encodeURIComponent(taskId)}`;
    for (let attempt = 0; attempt < 90 && !videoUrl; attempt += 1) {
      await waitForVideoPoll(signal, 2_000);
      const pollResponse = await fetch(pollUrl, { headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : undefined, signal: requestSignal(signal, 30_000) });
      payload = await pollResponse.json().catch(() => null) as unknown;
      if (!pollResponse.ok) throw new Error(`视频任务查询失败 (${pollResponse.status})：${JSON.stringify(payload ?? {}).slice(0, 260)}`);
      videoUrl = videoUrlFromPayload(payload);
      if (['failed', 'error', 'cancelled', 'canceled'].includes(videoStatusFromPayload(payload))) throw new Error('本地视频服务报告生成失败。');
    }
  }
  if (!videoUrl) throw new Error('视频服务未返回可播放地址；请在提供 API 后确认响应字段或异步查询协议。');
  if (!videoUrl.startsWith('data:')) videoUrl = new URL(videoUrl, generationUrl).toString();
  return { id: randomUUID(), kind: 'video' as const, url: videoUrl, alt: prompt.slice(0, 120) || '生成的视频', mimeType: 'video/mp4' };
};

const localPrincipal = (headers: Headers) => verifyPrincipal(headers) ?? {
  tenantId: headers.get('x-axiom-tenant-id')?.trim().slice(0, 120) || 'local',
  userId: headers.get('x-axiom-user-id')?.trim().slice(0, 120) || 'local-user',
  role: 'member' as const,
};

const providerCredentialKinds = new Set<ProviderCredentialKind>(['text', 'vision', 'image', 'video']);

app.get('/api/providers/credentials', async (c) => {
  const principal = localPrincipal(c.req.raw.headers);
  const requestedKind = c.req.query('kind') as ProviderCredentialKind | undefined;
  if (requestedKind && !providerCredentialKinds.has(requestedKind)) return c.json({ error: 'Invalid provider credential type.' }, 400);
  try {
    return c.json({ credentials: await providerCredentialStore.list(principal.tenantId, principal.userId, requestedKind) });
  } catch (error) {
    return c.json({ error: redactSecrets(error instanceof Error ? error.message : 'Provider credential service unavailable.') }, 503);
  }
});

app.post('/api/providers/credentials', async (c) => {
  const principal = localPrincipal(c.req.raw.headers);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const kind = typeof body?.kind === 'string' ? body.kind as ProviderCredentialKind : undefined;
  const id = typeof body?.id === 'string' ? body.id.trim() : undefined;
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const apiUrl = typeof body?.apiUrl === 'string' ? body.apiUrl.trim() : '';
  const model = typeof body?.model === 'string' ? body.model.trim().slice(0, 160) : '';
  const location = body?.location === 'local' ? 'local' : body?.location === 'internet' ? 'internet' : undefined;
  if (!kind || !providerCredentialKinds.has(kind) || !name || !apiUrl || !model || !location) {
    return c.json({ error: 'Provider credential requires kind, name, apiUrl, model and location.' }, 400);
  }
  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeProviderBaseUrl(apiUrl, apiUrl, location);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid provider URL.' }, 400);
  }
  try {
    const existing = id ? await providerCredentialStore.get(id, principal.tenantId, principal.userId) : null;
    if (id && !existing) return c.json({ error: 'Provider credential not found.' }, 404);
    if (existing && existing.kind !== kind) return c.json({ error: 'Provider credential type cannot be changed.' }, 400);
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : existing?.apiKey ?? '';
    if (!apiKey && location === 'internet') return c.json({ error: 'Internet provider credentials require an API key.' }, 400);
    const credential = await providerCredentialStore.upsert({
      tenantId: principal.tenantId,
      userId: principal.userId,
      kind,
      name,
      apiUrl: normalizedUrl,
      apiKey,
      model,
      location,
    }, id);
    return c.json({ credential }, id ? 200 : 201);
  } catch (error) {
    return c.json({ error: redactSecrets(error instanceof Error ? error.message : 'Provider credential service unavailable.') }, 503);
  }
});

app.delete('/api/providers/credentials/:credentialId', async (c) => {
  const principal = localPrincipal(c.req.raw.headers);
  const credentialId = c.req.param('credentialId');
  try {
    const deleted = await providerCredentialStore.delete(credentialId, principal.tenantId, principal.userId);
    return deleted ? c.body(null, 204) : c.json({ error: 'Provider credential not found.' }, 404);
  } catch (error) {
    return c.json({ error: redactSecrets(error instanceof Error ? error.message : 'Provider credential service unavailable.') }, 503);
  }
});

const runtimeAgentSnapshot = async (headers: Headers, provider: ResolvedProvider, signal: AbortSignal) => {
  const principal = localPrincipal(headers);
  const [customAgents, textHealth] = await Promise.all([
    agentStore.listAgents(principal.tenantId, 100, {
      userId: principal.userId,
      role: principal.role,
    }).catch(() => []),
    new OpenAICompatibleModelClient({
      apiKey: provider.apiKey,
      apiBase: provider.baseUrl,
      model: provider.model,
      maxAttempts: 1,
      timeoutMs: 3_000,
      apiKeyOptional: provider.location === 'local',
    }).health(signal).catch((error) => ({
      configured: true,
      reachable: false,
      detail: redactSecrets(error instanceof Error ? error.message : '模型服务探测失败。'),
    })),
  ]);
  const nativeSearchConfigured = Boolean(defaultTextProvider.apiKey)
    && nativeSearchEnabled
    && deepSeekApiHost(defaultTextProvider.baseUrl);
  const serviceAgents = [
    { id: 'direct-responder', label: '对话 Agent', available: textHealth.reachable, evidence: `当前文本模型服务探测：${textHealth.detail}` },
    { id: 'registry-agent', label: 'Agent Registry', available: true, evidence: '运行时 AgentStore 与内置目录' },
    { id: 'search-agent', label: '联网搜索 Agent', available: nativeSearchConfigured, evidence: `已配置 DeepSeek ${nativeSearchModel} /responses web_search；每次搜索请求都会验证真实检索结果` },
    { id: 'academic-search-agent', label: '论文搜索 Agent', available: nativeSearchConfigured, evidence: 'DeepSeek 原生 web_search 与学术证据指令' },
    { id: 'github-research-agent', label: 'GitHub 研究 Agent', available: nativeSearchConfigured, evidence: 'DeepSeek 原生 web_search 与仓库证据指令' },
    { id: 'vision-agent', label: '视觉分析 Agent', available: Boolean(defaultVisionProvider.apiKey && defaultVisionProvider.model), evidence: defaultVisionProvider.model },
    { id: 'document-agent', label: '文档分析 Agent', available: true, evidence: 'pdf-parse、mammoth、word-extractor 与 Vision 回退能力' },
    { id: 'drawing-agent', label: '绘图 Agent', available: Boolean(defaultImageProvider.apiKey), evidence: defaultImageProvider.model },
    { id: 'video-agent', label: '视频制作 Agent', available: Boolean(defaultVideoProvider.baseUrl && defaultVideoProvider.model), evidence: defaultVideoProvider.model || '等待配置本地视频服务' },
  ];
  return {
    detectedAt: new Date().toISOString(),
    coreAgents: agentCatalog,
    serviceAgents,
    customAgents: customAgents.map((agent) => ({
      id: agent.id,
      roleId: agent.roleId,
      name: agent.name,
      kind: agent.kind,
      status: agent.status,
      visibility: agent.visibility,
      description: agent.description,
      toolAllowlist: agent.definition.toolAllowlist,
    })),
    providers: {
      text: { configured: textHealth.configured, reachable: textHealth.reachable, detail: textHealth.detail, model: provider.model },
      vision: { configured: Boolean(defaultVisionProvider.apiKey && defaultVisionProvider.model), model: defaultVisionProvider.model },
      nativeSearch: { configured: nativeSearchConfigured, model: nativeSearchModel, endpoint: '/responses', tool: 'web_search', verification: 'verified when a search request executes' },
      image: { configured: Boolean(defaultImageProvider.apiKey), model: defaultImageProvider.model },
      video: { configured: Boolean(defaultVideoProvider.baseUrl && defaultVideoProvider.model), model: defaultVideoProvider.model },
    },
  };
};

app.get('/api/health', (c) =>
  c.json({
    configured: Boolean(defaultTextProvider.apiKey),
    model: defaultTextProvider.model,
    visionModel: defaultVisionProvider.model,
    apiBase: defaultTextProvider.baseUrl.replace(/\/$/, ''),
    vision: {
      configured: Boolean(defaultVisionProvider.apiKey && defaultVisionProvider.model),
      model: defaultVisionProvider.model,
      apiBase: defaultVisionProvider.baseUrl.replace(/\/$/, ''),
    },
    nativeSearch: {
      enabled: Boolean(defaultTextProvider.apiKey) && nativeSearchEnabled && deepSeekApiHost(defaultTextProvider.baseUrl),
      model: nativeSearchModel,
      api: '/responses',
      tool: 'web_search',
    },
    capabilities: deepSeekCapabilityInfo({
      baseUrl: defaultTextProvider.baseUrl,
      textModel: defaultTextProvider.model,
      visionModel: defaultTextProvider.visionModel,
      searchEnabled: nativeSearchEnabled,
      searchModel: nativeSearchModel,
      filesEnabled: process.env.DEEPSEEK_FILES_API !== 'false',
    }),
    image: {
      configured: Boolean(defaultImageProvider.apiKey),
      model: defaultImageProvider.model,
      apiBase: defaultImageProvider.baseUrl.replace(/\/$/, ''),
    },
    video: {
      configured: Boolean(defaultVideoProvider.baseUrl && defaultVideoProvider.model),
      model: defaultVideoProvider.model,
      apiBase: defaultVideoProvider.baseUrl.replace(/\/$/, ''),
    },
    service: 'axiom-agent-gateway',
    status: defaultTextProvider.apiKey ? 'ready' : 'missing-key',
  }),
);

app.get('/api/runtime/model-routing', (c) =>
  c.json({
    candidates: modelRoutingPolicy.snapshot(modelRoutingCandidates).candidates,
    selection: '按任务类型、Agent 角色、成功率、平均延迟和成本评分；任务显式模型与用户凭据优先。',
    configuredBy: 'AXIOM_ALLOWED_MODELS',
  }),
);

app.post('/api/chat/route', async (c) => {
  let request: ChatRouteRequest;
  try {
    request = await c.req.json<ChatRouteRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON request body.' }, 400);
  }
  const message = request.message?.trim().slice(0, 8_000) ?? '';
  if (!message) return c.json({ error: 'A message is required for semantic routing.' }, 400);
  const mode = request.mode && request.mode in modePrompts ? request.mode : 'analyze';
  const principal = localPrincipal(c.req.raw.headers);
  let provider: ResolvedProvider;
  try {
    provider = await resolveProviderForRequest(request.provider, defaultTextProvider, 'Text model', principal.tenantId, principal.userId, 'text');
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid text provider.' }, 400);
  }
  const routeModel = new OpenAICompatibleModelClient({
    apiKey: provider.apiKey,
    apiBase: provider.baseUrl,
    model: provider.model,
    maxAttempts: 1,
    timeoutMs: 30_000,
    apiKeyOptional: provider.location === 'local',
  });
  const customAgents = await agentStore.listAgents(principal.tenantId, 100, {
    userId: principal.userId,
    role: principal.role,
  }).catch(() => []);
  const availableAgents = [
    { id: 'direct-responder', label: '对话 Agent', description: '处理自然对话与直接问答。', capabilities: ['conversation', 'answer'], available: true },
    { id: 'registry-agent', label: 'Agent 目录 Agent', description: '读取实时 Agent 与 Skill 目录。', capabilities: ['agent-registry'], available: true },
    { id: 'vision-agent', label: '视觉分析 Agent', description: '分析图片附件。', capabilities: ['image-analysis', 'vision'], available: true },
    { id: 'document-agent', label: '文档分析 Agent', description: '分析 PDF、Word 与文本附件。', capabilities: ['document-analysis'], available: true },
    { id: 'report-agent', label: '报告生成 Agent', description: '按用户要求导出回答或完整会话。', capabilities: ['report-export', 'document-generation'], available: true },
    ...agentCatalog.filter((agent) => agent.kind === 'worker' || agent.kind === 'quality').map((agent) => ({
      id: agent.role,
      label: agent.label,
      description: agent.description,
      capabilities: agent.capabilities,
      available: true,
    })),
    ...workflowSpecialistCatalog().map((agent) => ({ id: agent.id, label: agent.label, description: agent.description, capabilities: agent.capabilities, available: agent.available })),
    ...customAgents.filter((agent) => agent.status === 'published').map((agent) => ({
      id: agent.roleId,
      label: agent.name,
      description: agent.definition.whenToUseHint || agent.description,
      capabilities: ['custom-agent', ...agent.definition.toolAllowlist],
      available: true,
    })),
  ];
  const decision = await routeChatIntent({
    message,
    mode,
    attachments: Array.isArray(request.attachments) ? request.attachments.slice(0, 6) : [],
    conversationContext: Array.isArray(request.conversationContext)
      ? request.conversationContext.slice(-12).flatMap((item) => item?.role === 'user' || item?.role === 'assistant'
        ? [{ role: item.role, content: String(item.content ?? '').slice(0, 2_000) }]
        : [])
      : [],
    currentGraph: request.currentGraph ?? null,
    availableAgents,
    availableSkills: runtimeSkillCatalog.map((skill) => ({ id: skill.id, label: skill.label, description: skill.description })),
    onFallback: (error) => logger.warn({ err: error, model: routeModel.model }, 'Router/Scheduler Agent output was rejected; deterministic fallback selected'),
  }, routeModel, c.req.raw.signal);
  return c.json({ decision });
});

app.post('/api/chat', async (c) => {
  const contentLength = Number(c.req.header('content-length') ?? 0);
  if (contentLength > maxChatRequestBytes) {
    return c.json({ error: '对话请求超过 14 MB 限制。' }, 413);
  }

  let request: ChatRequest;
  try {
    request = await c.req.json<ChatRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON request body.' }, 400);
  }

  const principal = localPrincipal(c.req.raw.headers);
  const persistedSummary = request.sessionId
    ? (await taskStore.listSessions(principal.tenantId, principal.userId, 100).catch(() => []))
      .find((session) => session.id === request.sessionId)?.contextSummary
    : undefined;
  const cleanedMessages = await cleanMessages(request.messages, persistedSummary);
  let messages = cleanedMessages.messages;
  if (messages.length === 0 || messages[messages.length - 1]?.role !== 'user') {
    return c.json({ error: 'A user message is required.' }, 400);
  }

  const mode = request.mode && request.mode in modePrompts ? request.mode : 'analyze';
  let provider: ResolvedProvider;
  try {
    provider = await resolveProviderForRequest(request.provider, defaultTextProvider, 'Text model', principal.tenantId, principal.userId, 'text');
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid text provider.' }, 400);
  }

  const containsImage = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url' || part.type === 'file'));
  if (containsImage) {
    try {
      provider = await resolveProviderForRequest(request.visionProvider, defaultVisionProvider, 'Vision model', principal.tenantId, principal.userId, 'vision');
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid vision provider.' }, 400);
    }
  }

  let uploadedImageFiles = 0;
  if (messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'))) {
    const prepared = await prepareDeepSeekImageFiles(messages, provider, c.req.raw.signal, process.env.DEEPSEEK_FILES_API !== 'false').catch(() => ({ messages, uploaded: 0 }));
    messages = prepared.messages;
    uploadedImageFiles = prepared.uploaded;
  }

  const latestUserMessage = messageText([...messages].reverse().find((message) => message.role === 'user') ?? { role: 'user', content: '' });
  const requestedRouting = request.routing ? chatRouteDecisionSchema.safeParse(request.routing) : null;
  const latestRawUser = [...(request.messages ?? [])].reverse().find((message) => message.role === 'user');
  const latestRawAttachments = latestRawUser?.attachments ?? [];
  const hasDocumentAttachment = latestRawAttachments.some((attachment) => attachment.kind === 'file'
    || (attachment.kind !== 'image'
      && !attachment.mimeType?.startsWith('image/')
      && !attachment.url?.startsWith('data:image/')));
  let fallbackRouting: ChatRouteDecision | undefined;
  const deterministicFallback = () => fallbackRouting ??= fallbackChatRoute({
    message: latestUserMessage,
    mode,
    attachments: [
      ...(containsImage ? [{ kind: 'image', mimeType: 'image/unknown' }] : []),
      ...(hasDocumentAttachment ? [{ kind: 'file', mimeType: 'application/octet-stream' }] : []),
    ],
  });
  let routing: ChatRouteDecision = requestedRouting?.success ? requestedRouting.data as ChatRouteDecision : deterministicFallback();
  const routedAgentRoles: Record<ChatIntent, string> = {
    conversation: 'direct-responder',
    'agent-registry': 'registry-agent',
    'web-search': 'search-agent',
    'academic-search': 'academic-search-agent',
    'github-research': 'github-research-agent',
    'image-generation': 'drawing-agent',
    'video-generation': 'video-agent',
    'image-analysis': 'vision-agent',
    'document-analysis': 'document-agent',
    'report-export': 'report-agent',
    task: 'orchestrator',
  };
  // The browser sends the Router/Scheduler decision so the UI can show the
  // exact plan it received. A retry can make that decision stale; enforce only
  // explicit specialist constraints server-side while preserving a model's
  // ability to combine search with analysis/build steps.
  routing = enforceChatRouteSafety(routing, {
    message: latestUserMessage,
    mode,
    attachments: [
      ...(containsImage ? [{ kind: 'image', mimeType: 'image/unknown' }] : []),
      ...(hasDocumentAttachment ? [{ kind: 'file', mimeType: 'application/octet-stream' }] : []),
    ],
  });
  const expectedGatewayRole = routing.intent === 'task' ? routing.agentRole : routedAgentRoles[routing.intent];
  // Attachment type is a hard capability constraint, not a language rule.
  // Reject a stale/tampered browser route instead of letting it bypass the
  // Vision Agent selected for the actual request payload.
  if (containsImage && (routing.intent !== 'image-analysis' || routing.agentRole !== 'vision-agent')) routing = deterministicFallback();
  else if (routing.execution === 'gateway' && routing.intent !== 'task' && routing.agentRole !== expectedGatewayRole) routing = deterministicFallback();
  const knownSkillIds = new Set(runtimeSkillCatalog.map((skill) => skill.id));
  routing = { ...routing, skillIds: routing.skillIds.filter((id) => knownSkillIds.has(id)) };

  const startedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: string, data: unknown) => controller.enqueue(encodeEvent(event, data));

      try {
        push('status', { phase: 'routing', message: `语义路由已分配：${routing.agentRole}` });
        push('status', { phase: 'context', message: `已组装 ${messages.length} 条消息` });

        if (uploadedImageFiles > 0) push('status', { phase: 'context', message: `DeepSeek Files API 已复用 ${uploadedImageFiles} 张图片` });

        if (cleanedMessages.summaryApplied) {
          push('status', {
            phase: 'context',
            message: cleanedMessages.durableSummaryId
              ? `已恢复持久上下文摘要，覆盖最早的 ${cleanedMessages.summarizedMessages} 条消息。`
              : `已自动整理最早的 ${cleanedMessages.summarizedMessages} 条消息为上下文摘要。`,
          });
        }

        if (routing.intent === 'image-generation') {
          const imageProvider = await resolveProviderForRequest(request.imageProvider, defaultImageProvider, 'Image model', principal.tenantId, principal.userId, 'image');
          push('status', { phase: 'inference', message: `绘图 Agent 使用 ${imageProvider.model}` });
          const images = await generateChatImages(latestUserMessage, imageProvider, c.req.raw.signal);
          images.forEach((attachment) => push('attachment', { attachment }));
          push('token', { content: `绘图 Agent 已完成，共返回 ${images.length} 张图片。` });
          push('complete', { durationMs: Date.now() - startedAt, outputCharacters: 0, model: imageProvider.model, route: 'image-generation', agentRole: 'drawing-agent', intent: routing.intent });
          return;
        }

        if (routing.intent === 'video-generation') {
          let videoProvider: ResolvedProvider;
          try {
            videoProvider = await resolveProviderForRequest(request.videoProvider, defaultVideoProvider, 'Video model', principal.tenantId, principal.userId, 'video', { apiKeyOptional: true });
          } catch {
            throw new Error('视频制作 Agent 尚未配置本地视频服务，请先在模型配置中填写 API URL 和模型名称。');
          }
          push('status', { phase: 'inference', message: `视频制作 Agent 正在使用 ${videoProvider.model}` });
          const attachment = await generateChatVideo(latestUserMessage, videoProvider, c.req.raw.signal);
          push('attachment', { attachment });
          const content = '视频制作 Agent 已完成，视频可在当前对话中播放或下载。';
          push('token', { content });
          push('complete', { durationMs: Date.now() - startedAt, outputCharacters: content.length, model: videoProvider.model, route: 'video-generation', agentRole: 'video-agent', intent: routing.intent });
          return;
        }

        let specialistContext = '';
        let registrySnapshot: Awaited<ReturnType<typeof runtimeAgentSnapshot>> | undefined;
        if (routing.intent === 'agent-registry') {
          registrySnapshot = await runtimeAgentSnapshot(c.req.raw.headers, provider, c.req.raw.signal);
          push('status', { phase: 'context', message: `Registry 已实时检测 ${registrySnapshot.coreAgents.length + registrySnapshot.serviceAgents.length + registrySnapshot.customAgents.length} 项 Agent 定义` });
          specialistContext = `\n\nYou are the Agent Registry specialist. Answer the user's exact question using only the following live runtime snapshot. Counts must be computed from the snapshot and custom Agents must reflect their current status. Never turn configured into reachable or verified: only the text Provider has been probed in this request, while search is verified only by an actual search request. Do not return a canned catalog paragraph or expose raw JSON field names. For a yes/no capability question, answer in 2-4 concise sentences. For an Agent catalog question, use a compact table or short grouped list and omit unrelated implementation detail. Explain orchestration roles, executable workers, gateway specialists, or user-defined Agents only when the distinction answers the question.\nRuntime snapshot:\n${JSON.stringify(registrySnapshot)}`;
        } else if (routing.intent === 'image-analysis') {
          specialistContext = '\n\nYou are the vision analysis Agent. Analyze only visible image evidence, distinguish observation from inference, and say when text or details are unreadable.';
        } else if (routing.intent === 'document-analysis') {
          specialistContext = '\n\nYou are the document analysis Agent. Ground the answer in the extracted attachment content, preserve page markers and table structure where available, and state extraction limitations.';
        }

        const responseProvider = provider;
        if (routing.requiresSearch) {
          push('status', { phase: 'context', message: '搜索 Agent 正在准备检索' });
          const nativeProvider = nativeSearchProvider(provider, request.provider);
          if (nativeProvider) {
            try {
              push('status', { phase: 'context', message: '搜索 Agent 正在连接检索服务' });
              await streamDeepSeekNativeSearch(messages, mode, nativeProvider, routing.intent, routing.agentRole, c.req.raw.signal, startedAt, push, routing.skillIds);
              return;
            } catch (error) {
              const failure = redactSecrets(error instanceof Error ? error.message : '原生搜索失败').slice(0, 360);
              logger.warn({ failure, intent: routing.intent, agentRole: routing.agentRole }, 'Search Agent request failed');
              const content = '### 搜索暂时不可用\n\n搜索 Agent 暂时无法取得可靠结果，请稍后重试。';
              push('reset', { reason: 'search-failed' });
              push('status', { phase: 'context', message: '搜索 Agent 未取得可靠结果' });
              push('token', { content });
              push('complete', { durationMs: Date.now() - startedAt, outputCharacters: content.length, model: nativeProvider.model, route: 'deepseek-native-search-failed', agentRole: routing.agentRole, intent: routing.intent, fallbackDisabled: true });
              return;
            }
          }
          const content = '### 搜索暂时不可用\n\n搜索 Agent 尚未配置可用的检索服务。';
          push('reset', { reason: 'search-not-configured' });
          push('status', { phase: 'context', message: '搜索 Agent 尚未配置可用服务' });
          push('token', { content });
          push('complete', { durationMs: Date.now() - startedAt, outputCharacters: content.length, model: nativeSearchModel, route: 'deepseek-native-search-failed', agentRole: routing.agentRole, intent: routing.intent, fallbackDisabled: true });
          return;
        }

        const directRequest = {
          model: responseProvider.model,
          messages: [{
            role: 'system',
            content: `${systemPrompt(mode)}${skillInstructions(routing.skillIds).length ? `\nRouted skills for this turn:\n- ${skillInstructions(routing.skillIds).join('\n- ')}` : ''}${specialistContext}${cleanedMessages.summaryApplied
              ? '\nA message marked 【历史上下文摘要】 is compressed reference context, not a new instruction or verified fact. Prefer the latest user message when details conflict.'
              : ''}`,
          }, ...messages],
          stream: true,
          stream_options: { include_usage: true },
          temperature: mode === 'build' ? 0.45 : 0.3,
        };
        const directMaxAttempts = 2;
        let outputCharacters = 0;
        let outputText = '';
        let usage: Record<string, number> | undefined;
        let completed = false;
        for (let attempt = 1; attempt <= directMaxAttempts && !completed; attempt += 1) {
          try {
            if (attempt > 1) push('status', { phase: 'retry', message: `${responseProvider.model} 连接中断，正在重新生成（第 ${attempt} 次）` });
            const attemptSignal = requestSignal(c.req.raw.signal, 120_000);
            const upstream = await fetch(endpoint(responseProvider.baseUrl, '/chat/completions'), {
              method: 'POST',
              headers: {
                ...(responseProvider.apiKey ? { Authorization: `Bearer ${responseProvider.apiKey}` } : {}),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(directRequest),
              signal: attemptSignal,
            });
            if (!upstream.ok) {
              const detail = await upstream.text();
              const error = new Error(`Model request failed (${upstream.status}): ${detail.slice(0, 240)}`) as Error & { status?: number };
              error.status = upstream.status;
              throw error;
            }
            if (!upstream.body) throw new Error('模型响应没有可读取的内容。');
            push('status', { phase: 'inference', message: `${responseProvider.model} 正在生成` });

            const contentType = upstream.headers.get('content-type') ?? '';
            if (!contentType.includes('text/event-stream')) {
              const payload = await upstream.json().catch(() => null) as {
                choices?: Array<{ finish_reason?: string | null; message?: { content?: string; reasoning_content?: string } }>;
                usage?: Record<string, number>;
                error?: { message?: string };
              } | null;
              if (payload?.error) throw new Error(payload.error.message || '模型请求失败。');
              const reasoning = payload?.choices?.[0]?.message?.reasoning_content;
              const token = payload?.choices?.[0]?.message?.content;
              if (reasoning) push('reasoning', { content: reasoning });
              if (token) {
                outputText += token;
                outputCharacters += token.length;
                push('token', { content: token });
              }
              if (payload?.usage) usage = payload.usage;
              completed = Boolean(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.finish_reason);
            } else {
              const reader = upstream.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              let providerCompleted = false;
              const processBlock = (block: string) => {
                const rawData = block
                  .split(/\r?\n/)
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trim())
                  .join('');
                if (!rawData) return;
                if (rawData === '[DONE]') { providerCompleted = true; return; }
                try {
                  const payload = JSON.parse(rawData) as {
                    choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string } }>;
                    usage?: Record<string, number>;
                    error?: { message?: string };
                  };
                  if (payload.error) throw new Error(payload.error.message || '模型流式请求失败。');
                  if (payload.choices?.[0]?.finish_reason) providerCompleted = true;
                  const reasoning = payload.choices?.[0]?.delta?.reasoning_content;
                  const token = payload.choices?.[0]?.delta?.content;
                  if (reasoning) push('reasoning', { content: reasoning });
                  if (token) {
                    outputCharacters += token.length;
                    outputText += token;
                    push('token', { content: token });
                  }
                  if (payload.usage) usage = payload.usage;
                } catch (error) {
                  if (error instanceof Error && !/JSON|Unexpected token/i.test(error.message)) throw error;
                  // Keepalive frames and malformed provider metadata do not
                  // become user-visible content; completion is still required.
                }
              };
              const readChunk = async () => {
                if (attemptSignal.aborted) throw attemptSignal.reason ?? new DOMException('Aborted', 'AbortError');
                return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
                  const onAbort = () => {
                    cleanup();
                    void reader.cancel().catch(() => undefined);
                    reject(attemptSignal.reason ?? new DOMException('Aborted', 'AbortError'));
                  };
                  const cleanup = () => attemptSignal.removeEventListener('abort', onAbort);
                  attemptSignal.addEventListener('abort', onAbort, { once: true });
                  reader.read().then((result) => { cleanup(); resolve(result); }, (error) => { cleanup(); reject(error); });
                });
              };
              while (true) {
                const { done, value } = await readChunk();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                buffer = consumeSseBlocks(buffer, processBlock);
              }
              buffer += decoder.decode();
              if (buffer.trim()) consumeSseBlocks(`${buffer}\n\n`, processBlock);
              if (!providerCompleted) throw new Error('模型流式响应未完整结束。');
              completed = true;
            }
            if (completed && !outputText.trim()) throw new Error('模型返回了空回答。');
          } catch (error) {
            if (c.req.raw.signal.aborted) throw error;
            const status = Number((error as { status?: unknown }).status);
            const retryable = error instanceof Error
              && (error.name === 'TimeoutError'
                || /模型流式响应未完整结束|连接中断|fetch failed|网络|terminated|socket|ECONNRESET|UND_ERR/u.test(error.message)
                || status === 408 || status === 409 || status === 429 || status >= 500);
            if (!retryable || attempt >= directMaxAttempts) throw error;
            outputText = '';
            outputCharacters = 0;
            usage = undefined;
            completed = false;
            push('reset', { reason: 'direct-stream-retry' });
          }
        }

        if (routing.intent === 'agent-registry' && registrySnapshot) {
          const supplemented = supplementAgentDirectoryResponse(latestUserMessage, outputText, [
            ...registrySnapshot.coreAgents,
            ...registrySnapshot.serviceAgents,
            ...registrySnapshot.customAgents.filter((agent) => agent.status === 'published'),
          ]);
          if (supplemented.length > outputText.length) {
            const delta = supplemented.startsWith(outputText)
              ? supplemented.slice(outputText.length)
              : supplemented;
            push('token', { content: delta });
            outputText = supplemented;
            outputCharacters = outputText.length;
          }
        }

        push('complete', {
          durationMs: Date.now() - startedAt,
          outputCharacters,
          usage,
          model: responseProvider.model,
          route: routing.intent,
          agentRole: routing.agentRole,
          intent: routing.intent,
        });
        metrics.recordUsage(usage);
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : 'Unknown agent gateway error.');
        push('error', { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
});

app.post('/api/images', async (c) => {
  const contentLength = Number(c.req.header('content-length') ?? 0);
  if (contentLength > maxImageRequestBytes) {
    return c.json({ error: 'Image request is larger than 22 MB.' }, 413);
  }

  let request: ImageRequest;
  try {
    request = await c.req.json<ImageRequest>();
  } catch {
    return c.json({ error: 'Invalid image request body.' }, 400);
  }

  const prompt = request.prompt?.trim().slice(0, 8_000) ?? '';
  if (!prompt) return c.json({ error: 'An image prompt is required.' }, 400);

  const imageMode = request.mode === 'edit' ? 'edit' : 'generate';
  if (imageMode === 'edit' && !request.imageData) {
    return c.json({ error: 'An input image is required for edit mode.' }, 400);
  }

  const principal = localPrincipal(c.req.raw.headers);
  let provider: ResolvedProvider;
  try {
    provider = await resolveProviderForRequest(request.provider, defaultImageProvider, 'Image model', principal.tenantId, principal.userId, 'image');
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid image provider.' }, 400);
  }

  const startedAt = Date.now();
  metrics.recordImage('requested');
  try {
    let response: Response;
    const size = /^\d{2,5}x\d{2,5}$/.test(request.size ?? '') ? request.size : '1024x1024';
    const count = Math.min(4, Math.max(1, Math.floor(request.n ?? 1)));
    const quality = request.quality ?? 'auto';

    if (imageMode === 'edit') {
      const { bytes, contentType } = parseImageData(request.imageData!);
      const form = new FormData();
      form.append('model', provider.model);
      form.append('prompt', prompt);
      form.append('size', size!);
      form.append('n', String(count));
      form.append('quality', quality);
      form.append('image', new Blob([bytes], { type: contentType }), 'source.png');
      response = await fetch(endpoint(provider.baseUrl, '/v1/images/edits'), {
        method: 'POST',
        headers: providerHeaders(provider, false),
        body: form,
        signal: requestSignal(c.req.raw.signal, 600_000),
      });
    } else {
      response = await fetch(endpoint(provider.baseUrl, '/v1/images/generations'), {
        method: 'POST',
        headers: providerHeaders(provider),
        body: JSON.stringify({ model: provider.model, prompt, size, n: count, quality }),
        signal: requestSignal(c.req.raw.signal, 600_000),
      });
    }

    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const detail = JSON.stringify(payload ?? {}).slice(0, 300);
      throw new Error(`Image request failed (${response.status}): ${detail}`);
    }

    const images = readImageResponse(payload, prompt);
    if (!images.length) throw new Error('Image provider returned no usable image data.');

    return c.json({ images, model: provider.model, durationMs: Date.now() - startedAt });
  } catch (error) {
    metrics.recordImage('failed');
    return c.json(
      { error: redactSecrets(error instanceof Error ? error.message : 'Image generation failed.') },
      502,
    );
  }
});

const serveFrontend = !process.argv.includes('--api-only') && process.env.AXIOM_SERVE_FRONTEND !== 'false';
if (serveFrontend) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

const httpServer = serve(
  {
    fetch: app.fetch,
    hostname: process.env.API_HOST ?? '127.0.0.1',
    port,
  },
  (info) => {
    logger.info({ port: info.port, host: process.env.API_HOST ?? '127.0.0.1' }, 'Axiom Agent Gateway listening');
  },
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'graceful shutdown started');
  httpServer.close();
  await coordinator.stop();
  // Harness/Codex is optional. The built-in runtime must shut down cleanly
  // when no sidecar was configured instead of dereferencing `undefined`.
  (harnessAdapter as (DeepSeekHarnessAdapter & { close?: () => void }) | undefined)?.close?.();
  await pluginStore.close();
  await agentStore.close();
  await businessCapabilityStore.close();
  await integrationCredentialStore.close();
  await templateStore.close();
  await taskStore.close();
  await providerCredentialStore.close?.();
  await outboundNotifications.stop();
  await outboundNotificationStore.close();
  memoryCompensationWorker.stop();
  await runtimeMemory.close();
  logger.info({ signal }, 'graceful shutdown completed');
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
