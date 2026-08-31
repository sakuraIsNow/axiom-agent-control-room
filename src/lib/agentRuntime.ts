import type { UserDefinedAgent, UserDefinedAgentDefinition, UserDefinedAgentKind } from '../types';

const readJson = async <T>(response: Response, fallback: string) => {
  const body = await response.json().catch(() => null) as T & { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `${fallback} (${response.status})`);
  return body as T;
};

export async function listCustomAgents(signal?: AbortSignal) {
  const response = await fetch('/api/agents/custom?limit=100', { signal });
  const body = await readJson<{ agents?: UserDefinedAgent[] }>(response, '自定义 Agent 列表读取失败');
  return body.agents ?? [];
}

export async function createCustomAgent(input: {
  roleId: string;
  name: string;
  description?: string;
  icon?: string;
  kind?: UserDefinedAgentKind;
  visibility?: 'private' | 'team';
  definition: UserDefinedAgentDefinition;
}) {
  const response = await fetch('/api/agents/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roleId: input.roleId,
      name: input.name,
      description: input.description ?? '',
      icon: input.icon,
      kind: input.kind ?? 'worker',
      visibility: input.visibility ?? 'private',
      definition: input.definition,
    }),
  });
  return (await readJson<{ agent: UserDefinedAgent }>(response, '自定义 Agent 创建失败')).agent;
}

export async function updateCustomAgent(agentId: string, patch: Partial<Pick<UserDefinedAgent, 'name' | 'description' | 'icon' | 'visibility' | 'status'>> & { definition?: UserDefinedAgentDefinition }) {
  const response = await fetch(`/api/agents/custom/${encodeURIComponent(agentId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  return (await readJson<{ agent: UserDefinedAgent }>(response, '自定义 Agent 更新失败')).agent;
}

export async function publishCustomAgent(agentId: string) {
  const response = await fetch(`/api/agents/custom/${encodeURIComponent(agentId)}/publish`, { method: 'POST' });
  return (await readJson<{ agent: UserDefinedAgent }>(response, '自定义 Agent 发布失败')).agent;
}

export async function archiveCustomAgent(agentId: string) {
  const response = await fetch(`/api/agents/custom/${encodeURIComponent(agentId)}/archive`, { method: 'POST' });
  return (await readJson<{ agent: UserDefinedAgent }>(response, '自定义 Agent 归档失败')).agent;
}
