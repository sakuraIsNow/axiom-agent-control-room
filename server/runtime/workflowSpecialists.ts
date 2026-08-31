import { randomUUID } from 'node:crypto';
import { consumeSseBlocks } from './sse.js';

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
};

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

export const isWorkflowSpecialist = (agentId: string) => workflowSpecialistCatalog().some((agent) => agent.id === agentId);

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

const executeSearch = async (agentId: WorkflowSpecialistAgent['id'], prompt: string, signal: AbortSignal): Promise<WorkflowSpecialistResult> => {
  const provider = searchProvider();
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
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    const processBlock = (block: string) => {
      const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
      const rawData = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (!event || !rawData) return;
      const payload = JSON.parse(rawData) as { delta?: string; error?: { message?: string } };
      if (event === 'response.output_text.delta' && payload.delta) text += payload.delta;
      if (event === 'response.completed') completed = true;
      if (event === 'response.failed') throw new Error(payload.error?.message || '搜索 Agent 请求失败。');
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSseBlocks(buffer, processBlock);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
    if (!completed) throw new Error('搜索 Agent 流式响应未完整结束。');
  } else {
    text = outputText(await response.json().catch(() => null));
  }
  if (!text.trim()) throw new Error('搜索 Agent 没有返回可用结果。');
  return { output: text, evidence: ['DeepSeek web_search 检索结果'], confidence: 0.82, model: provider.model };
};

const executeDrawing = async (prompt: string, signal: AbortSignal): Promise<WorkflowSpecialistResult> => {
  const provider = imageProvider();
  if (!provider.apiKey) throw new Error('服务端绘图模型尚未配置。');
  const response = await fetch(endpoint(provider.baseUrl, '/v1/images/generations'), {
    method: 'POST',
    headers: authHeaders(provider.apiKey),
    body: JSON.stringify({ model: provider.model, prompt: prompt.slice(0, 8_000), size: '1024x1024', n: 1, quality: 'auto' }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
  });
  const payload = await response.json().catch(() => null) as { data?: Array<{ url?: string; b64_json?: string }> } | null;
  if (!response.ok) throw new Error(`绘图 Agent 请求失败 (${response.status})。`);
  const images = payload?.data?.flatMap((item) => {
    if (!item.url && item.b64_json && item.b64_json.length > 32_000) {
      throw new Error('绘图模型返回了过大的内联图片；工作流模式要求 Provider 返回可持久化 URL。');
    }
    const url = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
    return url ? [{ id: randomUUID(), url }] : [];
  }) ?? [];
  if (!images.length) throw new Error('绘图 Agent 没有返回图片。');
  const markdown = images.map((image, index) => `![工作流生成图片 ${index + 1}](${image.url})`).join('\n\n');
  return { output: `${markdown}\n\n绘图 Agent 已完成，共生成 ${images.length} 张图片。`, evidence: [`绘图模型：${provider.model}`], confidence: 0.9, model: provider.model };
};

const videoUrl = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const root = payload as Record<string, unknown>;
  const first = Array.isArray(root.data) && root.data[0] && typeof root.data[0] === 'object' ? root.data[0] as Record<string, unknown> : null;
  return [root.url, root.video_url, first?.url, first?.video_url].find((value): value is string => typeof value === 'string' && value.length > 0) ?? '';
};

const executeVideo = async (prompt: string, signal: AbortSignal): Promise<WorkflowSpecialistResult> => {
  const provider = videoProvider();
  if (!provider.baseUrl || !provider.model) throw new Error('服务端视频模型尚未配置。');
  const path = /(?:videos?\/(?:generations?|create)|generate[-_/]?video|video[-_/]?generate)$/i.test(new URL(provider.baseUrl).pathname)
    ? provider.baseUrl
    : endpoint(provider.baseUrl, '/v1/videos/generations');
  const response = await fetch(path, {
    method: 'POST', headers: authHeaders(provider.apiKey),
    body: JSON.stringify({ model: provider.model, prompt: prompt.slice(0, 8_000) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(900_000)]),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`视频 Agent 请求失败 (${response.status})。`);
  const url = videoUrl(payload);
  if (!url) throw new Error('视频 Agent 没有返回可用视频地址。');
  return { output: `[下载或播放工作流生成视频](${url})`, evidence: [`视频模型：${provider.model}`], confidence: 0.88, model: provider.model };
};

export const executeWorkflowSpecialist = async (agentId: string, prompt: string, signal: AbortSignal) => {
  if (agentId === 'drawing-agent') return executeDrawing(prompt, signal);
  if (agentId === 'video-agent') return executeVideo(prompt, signal);
  if (agentId === 'search-agent' || agentId === 'academic-search-agent' || agentId === 'github-research-agent') return executeSearch(agentId, prompt, signal);
  throw new Error(`不支持的工作流服务 Agent：${agentId}`);
};
