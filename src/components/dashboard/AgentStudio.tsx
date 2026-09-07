import { useCallback, useEffect, useState } from 'react';
import { Archive, Bot, Plus, Rocket, Save } from 'lucide-react';
import { archiveCustomAgent, createCustomAgent, listCustomAgents, publishCustomAgent } from '../../lib/agentRuntime';
import type { UserDefinedAgent, UserDefinedAgentKind } from '../../types';
import { customAgentKindLabel, publicationStatusLabel } from '../../lib/taskPresentation';
import { userFacingError } from '../../lib/errorPresentation';

const emptyDraft = {
  roleId: '',
  name: '',
  description: '',
  kind: 'worker' as UserDefinedAgentKind,
  visibility: 'private' as 'private' | 'team',
  systemPromptTemplate: '',
  whenToUseHint: '',
  toolAllowlist: '',
};

const generatedRoleId = (name: string) => {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || `custom-agent-${Date.now()}`;
};

export function AgentStudio() {
  const [agents, setAgents] = useState<UserDefinedAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setAgents(await listCustomAgents());
    } catch (caught) {
      setError(userFacingError(caught, '加载自定义 Agent 失败。'));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async () => {
    if (!draft.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const name = draft.name.trim();
      const description = draft.description.trim() || name;
      const whenToUseHint = draft.whenToUseHint.trim() || `当任务需要${description}时使用`;
      const systemPromptTemplate = draft.systemPromptTemplate.trim() || `你是“${name}”Agent。请围绕用户目标完成${description}，给出清晰、可验证的结果。`;
      await createCustomAgent({
        roleId: draft.roleId.trim() || generatedRoleId(name),
        name,
        description,
        kind: draft.kind,
        visibility: draft.visibility,
        definition: {
          systemPromptTemplate,
          whenToUseHint,
          toolAllowlist: draft.toolAllowlist.split(',').map((item) => item.trim()).filter(Boolean),
          memoryRecall: false,
        },
      });
      setDraft(emptyDraft);
      setCreating(false);
      await refresh();
    } catch (caught) {
      setError(userFacingError(caught, '创建 Agent 失败。'));
    } finally {
      setBusy(false);
    }
  };

  const publish = async (agentId: string) => {
    setBusy(true);
    try { await publishCustomAgent(agentId); await refresh(); } catch (caught) { setError(userFacingError(caught, '发布失败。')); } finally { setBusy(false); }
  };

  const archive = async (agentId: string) => {
    setBusy(true);
    try { await archiveCustomAgent(agentId); await refresh(); } catch (caught) { setError(userFacingError(caught, '归档失败。')); } finally { setBusy(false); }
  };

  return <div className="dash-agent-studio">
    <div className="dash-agent-studio-head">
      <div><Bot size={16} /><span>Agent 工作室</span><small>用一句话描述你想要的 Agent，平台会自动接入调度。</small></div>
      <button type="button" onClick={() => setCreating((value) => !value)}><Plus size={14} />新建 Agent</button>
    </div>
    {error && <div className="dash-agent-studio-error">{error}</div>}
    {creating && <div className="dash-agent-studio-form">
      <div className="dash-form-row"><label>Agent 名称</label><input value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} placeholder="例如：旅行规划师" autoFocus /></div>
      <div className="dash-form-row"><label>它要帮你做什么</label><textarea rows={3} value={draft.description} onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))} placeholder="用自然语言描述目标，越具体越容易得到稳定结果" /></div>
      <div className="dash-form-row"><label>什么时候使用</label><input value={draft.whenToUseHint} onChange={(event) => setDraft((value) => ({ ...value, whenToUseHint: event.target.value }))} placeholder="例如：需要规划路线、预算和行程时" /></div>
      <details className="agent-studio-advanced">
        <summary>高级设置</summary>
        <div className="dash-form-row"><label>内部标识</label><input value={draft.roleId} onChange={(event) => setDraft((value) => ({ ...value, roleId: event.target.value }))} placeholder="留空则自动生成" /></div>
        <div className="dash-form-row"><label>行为指引</label><textarea rows={4} value={draft.systemPromptTemplate} onChange={(event) => setDraft((value) => ({ ...value, systemPromptTemplate: event.target.value }))} placeholder="留空则根据上面的描述自动生成" /></div>
        <div className="dash-form-row"><label>可用工具</label><input value={draft.toolAllowlist} onChange={(event) => setDraft((value) => ({ ...value, toolAllowlist: event.target.value }))} placeholder="留空则由平台按安全策略分配" /></div>
        <div className="dash-form-row">
          <label>Agent 类型</label>
          <select value={draft.kind} onChange={(event) => setDraft((value) => ({ ...value, kind: event.target.value as UserDefinedAgentKind }))}>
            <option value="worker">{customAgentKindLabel('worker')}</option>
            <option value="quality">{customAgentKindLabel('quality')}</option>
            <option value="output">{customAgentKindLabel('output')}</option>
          </select>
        </div>
      </details>
      <button type="button" className="dash-form-submit" disabled={busy || !draft.name.trim()} onClick={() => void submit()}><Save size={14} />保存 Agent</button>
    </div>}
    <div className="dash-agent-studio-list">
      {agents.length === 0 && <div className="dash-empty">暂无自定义 Agent，点击“新建 Agent”开始。</div>}
      {agents.map((agent) => <div key={agent.id} className={`dash-agent-card status-${agent.status}`}>
        <div className="dash-agent-card-head"><strong data-i18n-ignore="true">{agent.name}</strong><span data-i18n-ignore="true">{agent.roleId}</span><em>{publicationStatusLabel(agent.status)}</em></div>
        <p data-i18n-ignore="true">{agent.description || agent.definition.whenToUseHint}</p>
        <div className="dash-agent-card-actions">
          {agent.status !== 'published' && <button type="button" disabled={busy} onClick={() => void publish(agent.id)}><Rocket size={13} />发布</button>}
          {agent.status !== 'archived' && <button type="button" disabled={busy} onClick={() => void archive(agent.id)}><Archive size={13} />归档</button>}
        </div>
      </div>)}
    </div>
  </div>;
}
