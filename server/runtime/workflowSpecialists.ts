import { consumeSseBlocks } from './sse.js';
import { attachmentDataUrl, attachmentPdfVisualPages, extractAttachmentText } from './attachmentContent.js';
import { OpenAICompatibleModelClient, type ModelClient } from './modelClient.js';
import type { NexusArtifactSnapshot } from './nexusArtifacts.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ArtifactRef, WorkflowTask } from './contracts.js';
import type { ArtifactStore } from './artifactStore.js';
import type { ArtifactCatalog } from './artifactCatalog.js';
import { ToolExecutionPendingError, type ToolExecution } from './toolRegistry.js';
import { executeSpecialistGeneration, specialistUsage, type SpecialistExecutionContext } from './specialistExecution.js';

export type WorkflowSpecialistAgent = {
  id: 'search-agent' | 'academic-search-agent' | 'github-research-agent' | 'drawing-agent' | 'video-agent';
  role: string;
  label: string;
  kind: 'service';
  capabilities: string[];
  description: string;
  available: boolean;
  unavailableReason?: string;
};

export type WorkflowSpecialistResult = {
  output: string;
  evidence: string[];
  confidence: number;
  model: string;
  usage?: Record<string, number>;
  finishReason?: string;
  completionStatus?: 'complete' | 'partial';
  incompleteReason?: string;
  execution?: ToolExecution;
  artifacts?: ArtifactRef[];
};

export type SpecialistProvider = { apiKey: string; baseUrl: string; model: string; location?: 'internet' | 'local' };
export type SpecialistProviderResolver = (
  task: Pick<WorkflowTask, 'tenantId' | 'userId' | 'providerBindingId'>,
  kind: 'text' | 'vision' | 'image' | 'video' | 'search',
) => Promise<SpecialistProvider | null>;
export type WorkflowSpecialistOptions = {
  execution?: SpecialistExecutionContext;
  providerResolver?: SpecialistProviderResolver;
  task?: WorkflowTask;
  artifactStore?: ArtifactStore | null;
  artifactCatalog?: ArtifactCatalog | null;
  videoPollIntervalMs?: number;
};

export type WorkflowSpecialistAttachment = NexusArtifactSnapshot & { content: Uint8Array };

const endpoint = (baseUrl: string, suffix: string) => {
  const base = baseUrl.replace(/\/$/, '');
  if (base.endsWith(suffix)) return base;
  if (suffix.startsWith('/v1/') && base.endsWith('/v1')) return `${base}${suffix.slice(3)}`;
  return `${base}${suffix}`;
};

const authHeaders = (apiKey: string) => ({
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  'Content-Type': 'application/json',
});

const imageProvider = () => ({
  apiKey: process.env.DMX_API_KEY?.trim() ?? '',
  baseUrl: process.env.DMX_BASE_URL?.trim() || 'https://www.dmxapi.cn',
  model: process.env.DMX_MODEL?.trim() || 'gpt-image-2-03',
});

const searchProvider = () => ({
  apiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? '',
  baseUrl: process.env.DEEPSEEK_API_BASE?.trim() || 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_NATIVE_SEARCH_MODEL?.trim() || 'deepseek-v4-flash',
});

const videoProvider = () => ({
  apiKey: process.env.VIDEO_API_KEY?.trim() ?? '',
  baseUrl: process.env.VIDEO_API_BASE?.trim() ?? '',
  model: process.env.VIDEO_MODEL?.trim() ?? '',
});

const visionProvider = () => ({
  apiKey: process.env.DEEPSEEK_VISION_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim() || '',
  baseUrl: process.env.DEEPSEEK_VISION_API_BASE?.trim() || process.env.DEEPSEEK_API_BASE?.trim() || 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_VISION_MODEL?.trim() || 'deepseek-v4-flash-vision-exp',
});

export const workflowSpecialistCatalog = (): WorkflowSpecialistAgent[] => {
  const search = searchProvider();
  const image = imageProvider();
  const video = videoProvider();
  const searchAvailable = Boolean(search.apiKey && process.env.DEEPSEEK_NATIVE_SEARCH !== 'false');
  return [
    {
      id: 'search-agent', role: 'search-agent', label: '联网搜索 Agent', kind: 'service',
      capabilities: ['web-search', 'current-facts', 'source-links'],
      description: '使用 DeepSeek 原生 web_search 检索并核验时效性信息。',
      available: searchAvailable,
      ...(!searchAvailable ? { unavailableReason: '尚未配置 DeepSeek 原生搜索。' } : {}),
    },
    {
      id: 'academic-search-agent', role: 'academic-search-agent', label: '论文搜索 Agent', kind: 'service',
      capabilities: ['academic-search', 'doi', 'primary-sources'],
      description: '检索论文、DOI 与权威学术来源。',
      available: searchAvailable,
      ...(!searchAvailable ? { unavailableReason: '尚未配置 DeepSeek 原生搜索。' } : {}),
    },
    {
      id: 'github-research-agent', role: 'github-research-agent', label: 'GitHub 研究 Agent', kind: 'service',
      capabilities: ['github-search', 'releases', 'licenses'],
      description: '检索仓库、Release、文档、Issue 与许可证。',
      available: searchAvailable,
      ...(!searchAvailable ? { unavailableReason: '尚未配置 DeepSeek 原生搜索。' } : {}),
    },
    {
      id: 'drawing-agent', role: 'drawing-agent', label: '绘图 Agent', kind: 'service',
      capabilities: ['image-generation', 'image-output'],
      description: '调用平台绘图模型生成图片，并把图片结果交给下游 Agent 或输出端。',
      available: Boolean(image.apiKey),
      ...(!image.apiKey ? { unavailableReason: '尚未配置服务端绘图模型。' } : {}),
    },
    {
      id: 'video-agent', role: 'video-agent', label: '视频制作 Agent', kind: 'service',
      capabilities: ['video-generation', 'video-output'],
      description: '调用平台视频服务生成可播放或下载的视频。',
      available: Boolean(video.baseUrl && video.model),
      ...(!(video.baseUrl && video.model) ? { unavailableReason: '尚未配置服务端视频模型。' } : {}),
    },
  ];
};

export const isWorkflowSpecialist = (agentId: string) => agentId === 'vision-agent'
  || agentId === 'document-agent'
  || workflowSpecialistCatalog().some((agent) => agent.id === agentId);

const outputText = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const root = payload as Record<string, unknown>;
  if (typeof root.output_text === 'string') return root.output_text;
  const output = Array.isArray(root.output) ? root.output : [];
  return output.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const content = Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : [];
    return content.flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const value = part as Record<string, unknown>;
      return typeof value.text === 'string' ? [value.text] : [];
    });
  }).join('');
};

const executeSearch = async (agentId: WorkflowSpecialistAgent['id'], prompt: string, signal: AbortSignal, provider: SpecialistProvider): Promise<WorkflowSpecialistResult> => {
  if (!provider.apiKey || process.env.DEEPSEEK_NATIVE_SEARCH === 'false') throw new Error('DeepSeek 原生搜索尚未配置。');
  const specialty = agentId === 'academic-search-agent'
    ? '优先论文原文、出版社、DOI、arXiv 与权威学术索引，不得编造题名、作者或 DOI。'
    : agentId === 'github-research-agent'
      ? '优先 GitHub 仓库、Release、README、Issue 和 LICENSE，区分项目声明与已核验实现。'
      : '优先权威且有时间标记的来源，实时事实必须注明来源数据时间。';
  const response = await fetch(endpoint(provider.baseUrl, '/responses'), {
    method: 'POST',
    headers: authHeaders(provider.apiKey),
    body: JSON.stringify({
      model: provider.model,
      instructions: `你是 Agent 工作流中的专用搜索 Agent。${specialty} 使用 web_search 后再回答，只输出可交给下游 Agent 的完整结果，保留来源 URL，不展示 Provider、模型或 API 实现信息。`,
      input: prompt.slice(0, 24_000),
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      stream: true,
      reasoning: { effort: 'low' },
      max_output_tokens: 6_144,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) throw new Error(`搜索 Agent 请求失败 (${response.status})。`);
  let text = '';
  let providerCompleted = false;
  let incompleteReason: string | undefined;
  let usage: Record<string, number> | undefined;
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    const processBlock = (block: string) => {
      const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
      const rawData = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (!event || !rawData) return;
      const payload = JSON.parse(rawData) as { delta?: string; error?: { message?: string }; response?: { usage?: Record<string, number>; incomplete_details?: { reason?: string } }; usage?: Record<string, number> };
      if (event === 'response.output_text.delta' && payload.delta) text += payload.delta;
      if (event === 'response.completed') { completed = true; providerCompleted = true; }
      if (event === 'response.incomplete') { completed = true; incompleteReason = payload.response?.incomplete_details?.reason || 'incomplete'; }
      usage = specialistUsage(payload.response?.usage ?? payload.usage) ?? usage;
      if (event === 'response.failed') { completed = true; incompleteReason = 'provider-failed'; }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = consumeSseBlocks(buffer, processBlock);
      }
      buffer += decoder.decode();
      if (buffer.trim()) processBlock(buffer);
    } catch {
      signal.throwIfAborted();
      incompleteReason = 'stream-disconnected';
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!completed) incompleteReason = 'stream-disconnected';
  } else {
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    text = outputText(payload);
    usage = specialistUsage(payload?.usage);
    providerCompleted = payload?.status === 'completed';
    if (!providerCompleted) incompleteReason = String((payload?.incomplete_details as { reason?: string } | undefined)?.reason ?? 'completion-unconfirmed');
  }
  if (!text.trim() && providerCompleted) {
    return {
      output: '本轮检索已正常结束，但没有找到可核验的结果。建议下游 Agent 缩小主题、补充英文关键词或调整时间范围；不得把零结果解释为已验证的否定结论。',
      evidence: [],
      confidence: 0.2,
      model: provider.model,
      usage,
      completionStatus: 'complete',
      finishReason: 'stop',
    };
  }
  if (!text.trim()) throw new Error('搜索 Agent 返回了空响应，无法确认检索是否完成。');
  return { output: text, evidence: ['DeepSeek web_search 检索结果'], confidence: incompleteReason ? 0.4 : 0.82, model: provider.model,
    usage, completionStatus: incompleteReason ? 'partial' : 'complete', finishReason: incompleteReason ?? 'stop', incompleteReason };
};

const persistInlineMedia = async (options: WorkflowSpecialistOptions, execution: ToolExecution, index: number, inline: string, defaultMimeType: string) => {
  if (!options.execution || !execution.call.id || !options.artifactStore?.putBinary || !options.artifactCatalog) throw new Error('生成文件的持久存储暂不可用。');
  const match = /^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(inline);
  const mimeType = match?.[1] ?? defaultMimeType;
  const base64 = match?.[2] ?? inline;
  if (!/^(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|webm))$/u.test(mimeType) || !/^[A-Za-z0-9+/=\r\n]+$/u.test(base64)) throw new Error('生成文件格式无效。');
  const content = Buffer.from(base64, 'base64');
  if (!content.length || content.length > 48_000_000) throw new Error('生成文件大小不受支持。');
  const { task, stepId } = options.execution;
  const id = `media:${task.id}:${execution.call.id}:${index}`;
  const stored = await options.artifactStore.putBinary(id, content, task.tenantId, mimeType);
  const artifact: ArtifactRef = { id, kind: 'result', name: `Generated ${mimeType.startsWith('image/') ? 'image' : 'video'} ${index + 1}`, key: stored.key, bytes: stored.bytes, mimeType,
    sourceStepId: stepId, sourceToolCallId: execution.call.id, lineage: { taskId: task.id, stepId, toolCallId: execution.call.id }, createdAt: new Date().toISOString() };
  await options.artifactCatalog.register({ id, tenantId: task.tenantId, taskId: task.id, source: 'result', storageKey: stored.key, bytes: stored.bytes, mimeType, referenceKey: `task:${task.id}:media:${execution.call.id}:${index}` });
  return { artifact, url: `/api/tasks/${encodeURIComponent(task.id)}/artifacts/media/${encodeURIComponent(id)}` };
};

const executeDrawing = async (prompt: string, signal: AbortSignal, provider: SpecialistProvider, attachments: WorkflowSpecialistAttachment[], options: WorkflowSpecialistOptions): Promise<WorkflowSpecialistResult> => {
  const context = options.execution;
  if (!provider.apiKey && provider.location !== 'local') throw new Error('服务端绘图模型尚未配置。');
  if (!context) throw new Error('绘图 Agent 需要持久任务执行记录。');
  const mediaRequest = options.task?.plan?.mediaRequest;
  const sourceImage = mediaRequest?.mode === 'generate' ? undefined : attachments.find((attachment) => /^image\/(?:png|jpeg|webp)$/u.test(attachment.mimeType));
  if (mediaRequest?.mode === 'edit' && !sourceImage) throw new Error('图片编辑需要当前请求提供原图。');
  const generated = await executeSpecialistGeneration({
    context, toolName: 'service.image.generate', url: endpoint(provider.baseUrl, sourceImage ? '/v1/images/edits' : '/v1/images/generations'), apiKey: provider.apiKey,
    body: { model: provider.model, prompt: prompt.slice(0, 8_000), size: mediaRequest?.size ?? '1024x1024', n: mediaRequest?.count ?? 1, quality: mediaRequest?.quality ?? 'auto' },
    ...(sourceImage ? { image: { content: sourceImage.content, mimeType: sourceImage.mimeType, name: sourceImage.name } } : {}),
    signal, timeoutMs: 600_000,
  });
  if (!generated.response) return humanConfirmedResult(generated.receipt, provider);
  if (generated.receipt.exitCode !== 0) throw new Error(`绘图 Agent 请求失败 (${generated.response.status})。`);
  const payload = generated.response.payload as { data?: Array<{ url?: string; b64_json?: string }>; usage?: unknown };
  const images: Array<{ url: string; artifact?: ArtifactRef }> = [];
  try {
    for (const [index, item] of (payload.data ?? []).slice(0, 4).entries()) {
      signal.throwIfAborted();
      if (item.b64_json || item.url?.startsWith('data:')) images.push(await persistInlineMedia(options, generated.receipt, index, item.b64_json || item.url!, 'image/png'));
      else if (item.url && /^https?:\/\//u.test(item.url)) images.push({ url: item.url });
    }
  } catch { throw new ToolExecutionPendingError(generated.record); }
  if (!images.length) return { output: '绘图服务已返回受理回执，但未提供可用图片。请核对服务端任务结果后再明确重新生成。', evidence: [], confidence: 0.2, model: provider.model,
    execution: generated.receipt, completionStatus: 'partial', finishReason: 'result-unavailable', incompleteReason: '尚未收到生成图片。', usage: specialistUsage(payload.usage) };
  const markdown = images.map((image, index) => `![工作流生成图片 ${index + 1}](${image.url})`).join('\n\n');
  return { output: `${markdown}\n\n绘图 Agent 已完成，共生成 ${images.length} 张图片。`, evidence: [`绘图服务回执：${generated.receipt.auditId}`], confidence: 0.9, model: provider.model,
    usage: specialistUsage(payload.usage), completionStatus: 'complete', finishReason: 'stop', execution: generated.receipt,
    artifacts: images.flatMap((image) => image.artifact ? [image.artifact] : []) };
};

const humanConfirmedResult = (execution: ToolExecution, provider: SpecialistProvider): WorkflowSpecialistResult => ({
  output: `操作结果已由人工核对：${execution.humanConfirmation?.note ?? execution.output}\n\n平台没有收到可自动验证或下载的生成结果，请保留外部结果和核对依据。`,
  evidence: [], confidence: 0.4, model: provider.model, execution, completionStatus: 'partial', finishReason: 'human-confirmed',
  incompleteReason: '只有人工核对依据，平台尚未收到生成文件。',
});

const videoUrl = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const root = payload as Record<string, unknown>;
  const first = Array.isArray(root.data) && root.data[0] && typeof root.data[0] === 'object' ? root.data[0] as Record<string, unknown> : null;
  const output = Array.isArray(root.output) && root.output[0] && typeof root.output[0] === 'object' ? root.output[0] as Record<string, unknown> : null;
  const result = root.result && typeof root.result === 'object' ? root.result as Record<string, unknown> : null;
  const video = root.video && typeof root.video === 'object' ? root.video as Record<string, unknown> : null;
  return [root.url, root.video_url, first?.url, first?.video_url, output?.url, result?.url, result?.video_url, video?.url].find((value): value is string => typeof value === 'string' && value.length > 0)?.trim() ?? '';
};

const executeVideo = async (prompt: string, signal: AbortSignal, provider: SpecialistProvider, options: WorkflowSpecialistOptions): Promise<WorkflowSpecialistResult> => {
  const context = options.execution;
  if (!provider.baseUrl || !provider.model) throw new Error('服务端视频模型尚未配置。');
  if (!context) throw new Error('视频 Agent 需要持久任务执行记录。');
  const path = /(?:videos?\/(?:generations?|create)|generate[-_/]?video|video[-_/]?generate)$/i.test(new URL(provider.baseUrl).pathname)
    ? provider.baseUrl
    : endpoint(provider.baseUrl, '/v1/videos/generations');
  const generated = await executeSpecialistGeneration({
    context, toolName: 'service.video.generate', url: path, apiKey: provider.apiKey,
    body: { model: provider.model, prompt: prompt.slice(0, 8_000), response_format: 'url' }, signal, timeoutMs: 900_000,
  });
  if (!generated.response) return humanConfirmedResult(generated.receipt, provider);
  if (generated.receipt.exitCode !== 0) throw new Error(`视频 Agent 请求失败 (${generated.response.status})。`);
  let payload = generated.response.payload;
  let url = videoUrl(payload);
  const artifacts: ArtifactRef[] = [];
  const providerTaskId = [payload.id, payload.task_id, payload.job_id].find((value): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/u.test(value));
  const inlineVideo = (item: Record<string, unknown>) => {
    const first = Array.isArray(item.data) && item.data[0] && typeof item.data[0] === 'object' ? item.data[0] as Record<string, unknown> : undefined;
    const inline = [item.b64_json, item.video_base64, first?.b64_json, first?.video_base64].find((value): value is string => typeof value === 'string' && value.length > 0);
    return inline || (videoUrl(item).startsWith('data:') ? videoUrl(item) : '');
  };
  const explicitPollingUrl = typeof payload.status_url === 'string' ? payload.status_url.trim() : '';
  if (!url && !inlineVideo(payload) && (providerTaskId || explicitPollingUrl)) {
    const pollingUrl = new URL(explicitPollingUrl || path.replace(/\/(?:generations?|create)$/u, '') + `/${encodeURIComponent(providerTaskId!)}`, path);
    if (pollingUrl.origin !== new URL(path).origin || pollingUrl.username || pollingUrl.password) throw new Error('视频任务查询地址不属于已配置的服务。');
    const pollingSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    for (let attempt = 0; attempt < 90 && !url && !inlineVideo(payload); attempt += 1) {
      try {
        if (attempt > 0) await delay(Math.max(1, options.videoPollIntervalMs ?? 2_000), undefined, { signal: pollingSignal });
        const response = await fetch(pollingUrl, { headers: authHeaders(provider.apiKey), signal: AbortSignal.any([pollingSignal, AbortSignal.timeout(30_000)]), redirect: 'error' });
        if (!response.ok) throw new Error('Video status is temporarily unavailable.');
        payload = await response.json() as Record<string, unknown>;
        url = videoUrl(payload);
      } catch { throw new ToolExecutionPendingError(generated.record); }
      const status = String(payload.status ?? (payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>).status : '')).toLowerCase();
      if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) throw new Error('视频服务确认生成未完成；可检查服务端原因后明确重新生成。');
    }
    if (!url && !inlineVideo(payload)) throw new ToolExecutionPendingError(generated.record);
  }
  if (inlineVideo(payload)) {
    try {
      const media = await persistInlineMedia(options, generated.receipt, 0, inlineVideo(payload), 'video/mp4');
      artifacts.push(media.artifact);
      url = media.url;
    } catch { throw new ToolExecutionPendingError(generated.record); }
  }
  if (!url) return { output: '视频服务已返回受理回执，但未提供视频地址或可查询的任务 ID。请核对服务端任务结果后再明确重新生成。', evidence: [], confidence: 0.2, model: provider.model,
    execution: generated.receipt, completionStatus: 'partial', finishReason: 'result-unavailable', incompleteReason: '尚未收到生成视频。', usage: specialistUsage(payload.usage) };
  if (!url.startsWith('/api/tasks/')) {
    const resolvedUrl = new URL(url, path);
    if (!['http:', 'https:'].includes(resolvedUrl.protocol) || resolvedUrl.username || resolvedUrl.password) throw new Error('视频服务返回了不支持的播放地址。');
    url = resolvedUrl.href;
  }
  return { output: `[下载或播放工作流生成视频](${url})`, evidence: [`视频服务回执：${generated.receipt.auditId}`], confidence: 0.88, model: provider.model,
    usage: specialistUsage(payload.usage ?? generated.response.payload.usage), completionStatus: 'complete', finishReason: 'stop', execution: generated.receipt, artifacts };
};

const executeVision = async (
  prompt: string,
  signal: AbortSignal,
  attachments: WorkflowSpecialistAttachment[],
  provider: SpecialistProvider,
): Promise<WorkflowSpecialistResult> => {
  if (!provider.apiKey && provider.location !== 'local') throw new Error('视觉模型尚未配置。');
  const visualParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    { type: 'text', text: prompt.slice(0, 24_000) },
  ];
  for (const attachment of attachments.slice(0, 6)) {
    const dataUrl = attachmentDataUrl(attachment.content, attachment.mimeType);
    if (attachment.mimeType.startsWith('image/')) {
      visualParts.push({ type: 'text', text: `[图片附件：${attachment.name}]` });
      visualParts.push({ type: 'image_url', image_url: { url: dataUrl } });
      continue;
    }
    if (attachment.mimeType === 'application/pdf' || /\.pdf$/iu.test(attachment.name)) {
      const text = await extractAttachmentText({ dataUrl, name: attachment.name, mimeType: attachment.mimeType });
      visualParts.push(...await attachmentPdfVisualPages({ dataUrl, name: attachment.name, mimeType: attachment.mimeType }, text));
    }
  }
  if (!visualParts.some((part) => part.type === 'image_url')) throw new Error('视觉 Agent 没有收到可分析的图片或扫描 PDF 页面。');
  const model = new OpenAICompatibleModelClient({
    apiKey: provider.apiKey,
    apiBase: provider.baseUrl,
    model: provider.model,
    apiKeyOptional: provider.location === 'local',
    maxAttempts: 2,
  });
  const completion = await model.complete({
    signal,
    system: '你是 Agent Nexus 中的视觉分析 Agent。只根据可见内容回答；明确区分观察、推断和无法辨认的信息，不得虚构图中文字或细节。',
    user: prompt,
    userContent: visualParts,
    maxTokens: 6_144,
    temperature: 0.1,
  });
  return {
    output: completion.content,
    evidence: attachments.filter((attachment) => attachment.mimeType.startsWith('image/') || attachment.mimeType === 'application/pdf').map((attachment) => `视觉附件：${attachment.name}`),
    confidence: 0.86,
    model: provider.model,
    usage: specialistUsage(completion.usage),
    finishReason: completion.finishReason,
    completionStatus: completion.finishReason === 'length' ? 'partial' : 'complete',
    ...(completion.finishReason === 'length' ? { incompleteReason: '视觉模型响应达到输出上限。' } : {}),
  };
};

const executeDocument = async (
  prompt: string,
  signal: AbortSignal,
  attachments: WorkflowSpecialistAttachment[],
  model?: ModelClient,
): Promise<WorkflowSpecialistResult> => {
  const sections: string[] = [];
  for (const attachment of attachments.slice(0, 12)) {
    const text = await extractAttachmentText({
      dataUrl: attachmentDataUrl(attachment.content, attachment.mimeType),
      name: attachment.name,
      mimeType: attachment.mimeType,
    });
    if (text.trim()) sections.push(`## ${attachment.name}\n${text}`);
  }
  if (!sections.length) throw new Error('文档 Agent 没有收到可解析的 PDF、Word 或文本附件。');
  const selectedModel = model ?? new OpenAICompatibleModelClient();
  const completion = await selectedModel.complete({
    signal,
    system: '你是 Agent Nexus 中的文档分析 Agent。基于附件原文提取事实、结构、表格与结论，引用附件名称；区分原文事实和你的推断，信息缺失时明确说明。',
    user: `${prompt.slice(0, 24_000)}\n\n${sections.join('\n\n').slice(0, 120_000)}`,
    maxTokens: 8_192,
    temperature: 0.1,
  });
  return {
    output: completion.content,
    evidence: sections.map((section) => `文档附件：${section.match(/^## (.+)$/m)?.[1] ?? '未命名文档'}`),
    confidence: 0.88,
    model: selectedModel.model,
    usage: specialistUsage(completion.usage),
    finishReason: completion.finishReason,
    completionStatus: completion.finishReason === 'length' ? 'partial' : 'complete',
    ...(completion.finishReason === 'length' ? { incompleteReason: '文档模型响应达到输出上限。' } : {}),
  };
};

export const executeWorkflowSpecialist = async (
  agentId: string,
  prompt: string,
  signal: AbortSignal,
  attachments: WorkflowSpecialistAttachment[] = [],
  model?: ModelClient,
  options: WorkflowSpecialistOptions = {},
) => {
  const provider = async (kind: 'vision' | 'image' | 'video' | 'search', fallback: () => SpecialistProvider) => {
    if (!options.providerResolver) return fallback();
    if (!options.task) throw new Error('Missing task owner for the selected specialist provider.');
    const selected = await options.providerResolver(options.task, kind);
    if (!selected) throw new Error(`The selected ${kind} provider is not configured.`);
    return selected;
  };
  if (agentId === 'drawing-agent') return executeDrawing(prompt, signal, await provider('image', imageProvider), attachments, options);
  if (agentId === 'video-agent') return executeVideo(prompt, signal, await provider('video', videoProvider), options);
  if (agentId === 'vision-agent') return executeVision(prompt, signal, attachments, await provider('vision', visionProvider));
  if (agentId === 'document-agent') return executeDocument(prompt, signal, attachments, model);
  if (agentId === 'search-agent' || agentId === 'academic-search-agent' || agentId === 'github-research-agent') return executeSearch(agentId, prompt, signal, await provider('search', searchProvider));
  throw new Error(`不支持的工作流服务 Agent：${agentId}`);
};
