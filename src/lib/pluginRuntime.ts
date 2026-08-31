import type { AgentMode, ExecutionPolicy, PluginAppearance, PluginInputField, TextProviderSettings, UserPlugin, WorkflowTask } from '../types';
import { consumeSseBlocks } from './sse';

const readJson = async <T>(response: Response, fallback: string) => {
  const body = await response.json().catch(() => null) as T & { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `${fallback} (${response.status})`);
  return body as T;
};

export async function listPlugins(signal?: AbortSignal) {
  const response = await fetch('/api/plugins?limit=50', { signal });
  const body = await readJson<{ plugins?: UserPlugin[] }>(response, '插件列表读取失败');
  return body.plugins ?? [];
}

export async function createPlugin(input: {
  name: string;
  description?: string;
  icon?: string;
  visibility?: 'private' | 'team';
  mode: AgentMode;
  promptPrefix?: string;
  model?: string;
  fields?: PluginInputField[];
  kind?: 'prompt' | 'mini-app';
  htmlContent?: string;
  width?: number;
  height?: number;
  appearance?: PluginAppearance;
  agentEnabled?: boolean;
  agentInstructions?: string;
}) {
  const response = await fetch('/api/plugins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      description: input.description ?? '',
      icon: input.icon,
      visibility: input.visibility ?? 'private',
      kind: input.kind ?? 'prompt',
      definition: {
        mode: input.mode,
        promptPrefix: input.promptPrefix,
        model: input.model,
        inputSchema: input.fields?.length ? { fields: input.fields } : undefined,
        ...(input.kind === 'mini-app' ? {
          htmlContent: input.htmlContent ?? '',
          width: input.width,
          height: input.height,
          appearance: input.appearance,
          agentEnabled: input.agentEnabled,
          agentInstructions: input.agentInstructions,
        } : {}),
      },
    }),
  });
  return (await readJson<{ plugin: UserPlugin }>(response, '插件创建失败')).plugin;
}

export async function createPluginWithAgent(input: {
  goal: string;
  visibility: 'private' | 'team';
  provider: TextProviderSettings;
}) {
  const response = await fetch('/api/plugins/agent-create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: input.goal.trim(),
      visibility: input.visibility,
      provider: input.provider.useCustom
        ? {
            ...(input.provider.credentialId ? { credentialId: input.provider.credentialId } : { apiUrl: input.provider.apiUrl.trim(), apiKey: input.provider.apiKey }),
            model: input.provider.model.trim(),
            location: input.provider.location,
          }
        : undefined,
    }),
  });
  return (await readJson<{ plugin: UserPlugin; generatedBy: { agent: string; model: string } }>(response, '插件设计 Agent 创建失败')).plugin;
}

export async function updatePlugin(pluginId: string, patch: Partial<Pick<UserPlugin, 'name' | 'description' | 'icon' | 'visibility' | 'status' | 'definition'>>) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  return (await readJson<{ plugin: UserPlugin }>(response, '插件更新失败')).plugin;
}

export async function updatePluginWithAgent(input: {
  pluginId: string;
  instruction: string;
  provider: TextProviderSettings;
}) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(input.pluginId)}/agent-edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instruction: input.instruction.trim(),
      provider: input.provider.useCustom
        ? {
            ...(input.provider.credentialId ? { credentialId: input.provider.credentialId } : { apiUrl: input.provider.apiUrl.trim(), apiKey: input.provider.apiKey }),
            model: input.provider.model.trim(),
            location: input.provider.location,
          }
        : undefined,
    }),
  });
  return readJson<{ plugin: UserPlugin; message: string; generatedBy: { agent: string; model: string } }>(response, '插件开发 Agent 修改失败');
}

export type PluginAgentStreamHandlers = {
  onStatus: (message: string, phase?: string) => void;
  onProgress: (message: string) => void;
  onComplete: (data: { plugin: UserPlugin; message: string; generatedBy: { agent: string; model: string }; durationMs: number }) => void;
};

/** Stream plugin design progress while the server keeps the generated HTML private until validated. */
export async function streamPluginWithAgent(input: {
  pluginId: string;
  instruction: string;
  provider: TextProviderSettings;
  signal: AbortSignal;
  handlers: PluginAgentStreamHandlers;
}) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(input.pluginId)}/agent-edit/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      instruction: input.instruction.trim(),
      provider: input.provider.useCustom
        ? {
            ...(input.provider.credentialId ? { credentialId: input.provider.credentialId } : { apiUrl: input.provider.apiUrl.trim(), apiKey: input.provider.apiKey }),
            model: input.provider.model.trim(),
            location: input.provider.location,
          }
        : undefined,
    }),
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `插件开发 Agent 返回 HTTP ${response.status}。`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  const dispatch = (block: string) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const rawData = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
    if (!event || !rawData) return;
    const data = JSON.parse(rawData) as Record<string, unknown>;
    if (event === 'status') input.handlers.onStatus(String(data.message ?? ''), String(data.phase ?? 'inference'));
    if (event === 'progress') input.handlers.onProgress(String(data.message ?? ''));
    if (event === 'complete' && data.plugin && typeof data.plugin === 'object') {
      completed = true;
      input.handlers.onComplete({
        plugin: data.plugin as UserPlugin,
        message: String(data.message ?? ''),
        generatedBy: (data.generatedBy ?? { agent: 'mini-app-builder', model: 'unknown' }) as { agent: string; model: string },
        durationMs: Number(data.durationMs ?? 0),
      });
    }
    if (event === 'error') throw new Error(String(data.message ?? '插件开发 Agent 请求失败。'));
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = consumeSseBlocks(buffer, dispatch);
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatch(buffer);
  if (!completed && !input.signal.aborted) throw new Error('插件开发 Agent 响应流在完成前中断。');
}

export async function deletePlugin(pluginId: string) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `插件删除失败 (${response.status})`);
  }
}

export async function runPlugin(input: {
  pluginId: string;
  sessionId: string;
  input?: string;
  values?: Record<string, string | number>;
  policy?: Partial<ExecutionPolicy>;
}) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(input.pluginId)}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: input.sessionId, input: input.input, values: input.values, policy: input.policy }),
  });
  return readJson<{ task: WorkflowTask; eventsUrl: string; pluginId: string; pluginVersion: number }>(response, '插件运行失败');
}
