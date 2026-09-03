import type { AgentMode, ExecutionPolicy, PluginAppearance, PluginCompatibilityReport, PluginInputField, PluginInstallation, PluginMarketEntry, PluginMarketRelease, TextProviderSettings, UserPlugin, WorkflowTask } from '../types';
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

export async function listPluginMarketplace(query = '', signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: '50' });
  if (query.trim()) params.set('q', query.trim());
  const response = await fetch(`/api/plugins/market/catalog?${params}`, { signal });
  return (await readJson<{ entries?: PluginMarketEntry[] }>(response, '插件市场读取失败')).entries ?? [];
}

export async function listPluginReviewQueue(signal?: AbortSignal) {
  const response = await fetch('/api/plugins/market/reviews?limit=50', { signal });
  return (await readJson<{ releases?: PluginMarketRelease[] }>(response, '插件审核队列读取失败')).releases ?? [];
}

export async function listPluginMarketSubmissions(signal?: AbortSignal) {
  const response = await fetch('/api/plugins/market/submissions', { signal });
  return (await readJson<{ releases?: PluginMarketRelease[] }>(response, '插件市场状态读取失败')).releases ?? [];
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

export async function inspectPluginCompatibility(pluginId: string) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/compatibility`);
  return (await readJson<{ report: PluginCompatibilityReport }>(response, '插件检查失败')).report;
}

export async function publishPlugin(pluginId: string) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/publish`, { method: 'POST' });
  return readJson<{ plugin: UserPlugin; report: PluginCompatibilityReport }>(response, '插件发布失败');
}

export async function submitPluginToMarket(pluginId: string) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/market-submit`, { method: 'POST' });
  return readJson<{ release: PluginMarketRelease; report: PluginCompatibilityReport }>(response, '插件提交审核失败');
}

export async function reviewPluginMarketRelease(pluginId: string, version: number, decision: 'approved' | 'rejected', note = '') {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/market-review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, decision, note }),
  });
  return (await readJson<{ release: PluginMarketRelease }>(response, '插件审核失败')).release;
}

export async function revokePluginMarketRelease(pluginId: string, version: number, note = '') {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/market-revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, note }),
  });
  return (await readJson<{ release: PluginMarketRelease }>(response, '插件撤回失败')).release;
}

export async function installPlugin(pluginId: string) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/install`, { method: 'POST' });
  return readJson<{ installation: PluginInstallation; plugin: UserPlugin }>(response, '插件安装失败');
}

export async function upgradePlugin(pluginId: string) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/upgrade`, { method: 'POST' });
  return readJson<{ installation: PluginInstallation; plugin: UserPlugin }>(response, '插件升级失败');
}

export async function uninstallPlugin(pluginId: string) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/install`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `插件卸载失败 (${response.status})`);
  }
}

export async function rollbackPlugin(pluginId: string, version: number) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  return readJson<{ plugin: UserPlugin; report: PluginCompatibilityReport }>(response, '插件版本恢复失败');
}

export async function launchMiniApp(pluginId: string) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/launch`, { method: 'POST' });
  return readJson<{ plugin: UserPlugin; report: PluginCompatibilityReport; mode: 'preview' | 'run' }>(response, '插件打开失败');
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
  /** Stable per-run key prevents duplicate workflow tasks after a retry. */
  idempotencyKey?: string;
}) {
  const response = await fetch(`/api/plugins/${encodeURIComponent(input.pluginId)}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(input.idempotencyKey?.trim() ? { 'Idempotency-Key': input.idempotencyKey.trim().slice(0, 160) } : {}),
    },
    body: JSON.stringify({ sessionId: input.sessionId, input: input.input, values: input.values, policy: input.policy }),
  });
  return readJson<{ task: WorkflowTask; eventsUrl: string; pluginId: string; pluginVersion: number }>(response, '插件运行失败');
}
