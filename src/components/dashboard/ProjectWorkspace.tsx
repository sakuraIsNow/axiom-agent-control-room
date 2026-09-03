import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive, BarChart3, Bell, BookOpenCheck, Boxes, BrainCircuit, Check, CheckCircle2, ChevronRight, CircleGauge,
  Download, FolderKanban, Link2, LoaderCircle, MemoryStick, MessageSquarePlus, Network, Plus,
  Play, RefreshCw, Save, Send, ShieldCheck, Sparkles, Trash2, UserPlus, Wrench, X, XCircle,
} from 'lucide-react';
import type { AgentMode } from '../../types';
import {
  archiveProject, assignProjectReviewer, checkToolSourceHealth, createMemory, createProject, createProjectComment, createProjectDecision,
  createProjectTask, createToolSource, decideProjectReview, decideToolApproval, deleteMemory, estimateTask,
  getModelSelection, linkProjectResource, listMemories, listProjectComments, listProjectDecisions,
  listProjectNotifications, listProjectReviews, listProjects, listSolutions, listToolApprovals, listToolSources,
  markProjectNotificationRead, removeProjectMember, setProjectMember, unlinkProjectResource, updateMemory,
  updateProject, updateProjectDecision, updateToolSource, type BusinessRecord, type MemoryRecord, type ModelSelection,
  type ProjectDecisionRecord, type ProjectNotificationRecord, type ProjectRecord, type ReviewAssignmentRecord,
  type SolutionDefinition, type TaskEstimate, type ToolApprovalRecord, type ToolSourceRecord,
} from '../../lib/businessRuntime';
import { userFacingError } from '../../lib/errorPresentation';
import '../../styles/project-workspace.css';

type WorkspaceTab = 'projects' | 'memory' | 'tools' | 'solutions' | 'intelligence';

const tabs: Array<{ id: WorkspaceTab; label: string; icon: typeof FolderKanban }> = [
  { id: 'projects', label: '项目', icon: FolderKanban },
  { id: 'memory', label: '记忆', icon: MemoryStick },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'solutions', label: '方案', icon: Boxes },
  { id: 'intelligence', label: '效能', icon: CircleGauge },
];

const fmtTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const fmtDuration = (value: number) => value < 60_000 ? `${Math.max(1, Math.round(value / 1_000))} 秒` : `${Math.max(1, Math.round(value / 60_000))} 分钟`;
const compact = (value: number | null) => value === null ? '等待样本' : new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const confidenceLabel = { low: '样本较少', medium: '中等可信', high: '高可信' } as const;
const memoryLayerLabel = { L0: '当前事实', L1: '近期偏好', L2: '项目知识', L3: '长期经验' } as const;
const memoryScopeLabel = { user: '当前用户', project: '项目', session: '会话', agent: '指定 Agent' } as const;
const memorySyncLabel = { syncing: '正在同步', synced: '已同步', 'pending-extraction': '等待提取', 'local-policy': '本地策略', failed: '同步失败' } as const;
const projectRoleLabel = { editor: '可编辑', reviewer: '审核人', viewer: '只读' } as const;
const projectDecisionLabel = { proposed: '待确认', accepted: '已采纳', rejected: '已驳回', superseded: '已替代' } as const;
const toolHealthLabel = { healthy: '可用', unhealthy: '异常', pending: '检查中', unknown: '待检查' } as const;
const toolCategoryLabel: Record<string, string> = { office: '办公', research: '研究', development: '开发', business: '业务', content: '内容', operations: '运维', data: '数据', custom: '自定义' };

export function ProjectWorkspace({ onUseSolution }: { onUseSolution: (input: string, mode: AgentMode) => void }) {
  const [tab, setTab] = useState<WorkspaceTab>('projects');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [comments, setComments] = useState<BusinessRecord[]>([]);
  const [decisions, setDecisions] = useState<ProjectDecisionRecord[]>([]);
  const [reviews, setReviews] = useState<ReviewAssignmentRecord[]>([]);
  const [notifications, setNotifications] = useState<ProjectNotificationRecord[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [memoryCore, setMemoryCore] = useState<'configured' | 'degraded-local-policy'>('degraded-local-policy');
  const [toolSources, setToolSources] = useState<ToolSourceRecord[]>([]);
  const [toolApprovals, setToolApprovals] = useState<Record<string, ToolApprovalRecord[]>>({});
  const [solutions, setSolutions] = useState<SolutionDefinition[]>([]);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [estimate, setEstimate] = useState<TaskEstimate | null>(null);
  const [estimateInput, setEstimateInput] = useState('');
  const [estimateMode, setEstimateMode] = useState<AgentMode>('analyze');
  const [projectDraft, setProjectDraft] = useState({ name: '', goal: '', acceptance: '', strategy: '' });
  const [memoryDraft, setMemoryDraft] = useState({ content: '', source: '用户创建', layer: 'L1' as MemoryRecord['data']['layer'], confidence: .9, scope: 'user' as MemoryRecord['data']['scope'], scopeId: '', expiresAt: '' });
  const [editingMemory, setEditingMemory] = useState<MemoryRecord | null>(null);
  const [toolDraft, setToolDraft] = useState({ name: '', description: '', protocol: 'openapi' as 'openapi' | 'mcp', location: 'internet' as 'internet' | 'local', version: '1.0.0', categories: '', capabilityTags: '', riskLevel: 'low' as 'low' | 'medium' | 'high', authType: 'none' as 'none' | 'api-key' | 'oauth2' | 'service-account', visibility: 'private' as 'private' | 'tenant', allowedAgents: '', specification: '' });
  const [commentDraft, setCommentDraft] = useState('');
  const [memberDraft, setMemberDraft] = useState({ userId: '', role: 'viewer' as 'editor' | 'reviewer' | 'viewer' });
  const [resourceDraft, setResourceDraft] = useState({ type: 'task' as 'task' | 'session' | 'nexus' | 'schedule' | 'artifact' | 'decision', id: '' });
  const [taskDraft, setTaskDraft] = useState({ title: '', input: '', mode: 'analyze' as AgentMode });
  const [decisionDraft, setDecisionDraft] = useState({ title: '', decision: '', rationale: '' });
  const [reviewDraft, setReviewDraft] = useState({ reviewerId: '', targetType: 'task' as 'task' | 'nexus' | 'artifact', targetId: '', note: '' });
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [openComposer, setOpenComposer] = useState<'project' | 'memory' | 'tool' | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null;
  const projectReadOnly = selectedProject?.status === 'archived';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    try {
      const [nextProjects, memoryResult, nextTools, nextSolutions, nextSelection, nextNotifications] = await Promise.all([
        listProjects(controller.signal), listMemories(controller.signal), listToolSources(controller.signal),
        listSolutions(controller.signal), getModelSelection(controller.signal), listProjectNotifications(controller.signal),
      ]);
      setProjects(nextProjects);
      setSelectedProjectId((current) => current && nextProjects.some((project) => project.id === current) ? current : nextProjects[0]?.id ?? null);
      setMemories(memoryResult.memories);
      setMemoryCore(memoryResult.memoryCore);
      setToolSources(nextTools);
      const approvalResults = await Promise.allSettled(nextTools.map(async (source) => [source.id, await listToolApprovals(source.id, controller.signal)] as const));
      setToolApprovals(Object.fromEntries(approvalResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])));
      setSolutions(nextSolutions);
      setSelection(nextSelection);
      setNotifications(nextNotifications);
    } catch (caught) {
      setError(userFacingError(caught, '业务空间读取失败。'));
    } finally {
      setLoading(false);
    }
    return () => controller.abort();
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedProject) { setComments([]); setDecisions([]); setReviews([]); return; }
    const controller = new AbortController();
    Promise.all([
      listProjectComments(selectedProject.id, controller.signal),
      listProjectDecisions(selectedProject.id, controller.signal),
      listProjectReviews(selectedProject.id, controller.signal),
    ]).then(([nextComments, nextDecisions, nextReviews]) => {
      setComments(nextComments);
      setDecisions(nextDecisions);
      setReviews(nextReviews);
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(userFacingError(caught, '项目评论读取失败。'));
    });
    return () => controller.abort();
  }, [selectedProject?.id]);

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await operation(); } catch (caught) { setError(userFacingError(caught, '操作没有完成。')); } finally { setBusy(false); }
  };

  const submitProject = () => void run(async () => {
    const project = await createProject({
      name: projectDraft.name.trim(), goal: projectDraft.goal.trim(),
      acceptanceCriteria: projectDraft.acceptance.split('\n').map((item) => item.trim()).filter(Boolean),
      strategy: projectDraft.strategy.trim(),
    });
    setProjects((current) => [project, ...current]);
    setSelectedProjectId(project.id);
    setProjectDraft({ name: '', goal: '', acceptance: '', strategy: '' });
    setOpenComposer(null);
  });

  const saveProject = () => selectedProject && void run(async () => {
    const project = await updateProject(selectedProject.id, {
      revision: selectedProject.revision,
      name: projectDraft.name.trim() || selectedProject.data.name,
      goal: projectDraft.goal.trim() || selectedProject.data.goal,
      acceptanceCriteria: projectDraft.acceptance.trim()
        ? projectDraft.acceptance.split('\n').map((item) => item.trim()).filter(Boolean)
        : selectedProject.data.acceptanceCriteria,
      strategy: projectDraft.strategy.trim() || selectedProject.data.strategy,
    });
    setProjects((current) => current.map((item) => item.id === project.id ? project : item));
    setProjectDraft({ name: '', goal: '', acceptance: '', strategy: '' });
  });

  const addComment = () => selectedProject && commentDraft.trim() && void run(async () => {
    const comment = await createProjectComment(selectedProject.id, commentDraft.trim());
    setComments((current) => [comment, ...current]);
    setCommentDraft('');
  });

  const addMember = () => selectedProject && memberDraft.userId.trim() && void run(async () => {
    const project = await setProjectMember(selectedProject.id, { ...memberDraft, userId: memberDraft.userId.trim(), revision: selectedProject.revision });
    setProjects((current) => current.map((item) => item.id === project.id ? project : item));
    setMemberDraft({ userId: '', role: 'viewer' });
  });

  const removeMember = (userId: string) => selectedProject && void run(async () => {
    const project = await removeProjectMember(selectedProject.id, userId, selectedProject.revision);
    setProjects((current) => current.map((item) => item.id === project.id ? project : item));
  });

  const addResource = () => selectedProject && resourceDraft.id.trim() && void run(async () => {
    const project = await linkProjectResource(selectedProject.id, { resourceType: resourceDraft.type, resourceId: resourceDraft.id.trim(), revision: selectedProject.revision });
    setProjects((current) => current.map((item) => item.id === project.id ? project : item));
    setResourceDraft((current) => ({ ...current, id: '' }));
  });

  const removeResource = (resourceType: string, resourceId: string) => selectedProject && void run(async () => {
    const project = await unlinkProjectResource(selectedProject.id, resourceType, resourceId, selectedProject.revision);
    setProjects((current) => current.map((item) => item.id === project.id ? project : item));
  });

  const submitProjectTask = () => selectedProject && taskDraft.title.trim() && taskDraft.input.trim() && void run(async () => {
    const result = await createProjectTask(selectedProject.id, { ...taskDraft, title: taskDraft.title.trim(), input: taskDraft.input.trim() });
    setProjects((current) => current.map((item) => item.id === result.project.id ? result.project : item));
    setTaskDraft({ title: '', input: '', mode: 'analyze' });
  });

  const submitDecision = () => selectedProject && decisionDraft.title.trim() && decisionDraft.decision.trim() && void run(async () => {
    const decision = await createProjectDecision(selectedProject.id, { ...decisionDraft, title: decisionDraft.title.trim(), decision: decisionDraft.decision.trim(), rationale: decisionDraft.rationale.trim() });
    setDecisions((current) => [decision, ...current]);
    setDecisionDraft({ title: '', decision: '', rationale: '' });
  });

  const submitReview = () => selectedProject && reviewDraft.reviewerId.trim() && reviewDraft.targetId.trim() && void run(async () => {
    const review = await assignProjectReviewer(selectedProject.id, { ...reviewDraft, reviewerId: reviewDraft.reviewerId.trim(), targetId: reviewDraft.targetId.trim(), note: reviewDraft.note.trim() });
    setReviews((current) => [review, ...current]);
    setReviewDraft({ reviewerId: '', targetType: 'task', targetId: '', note: '' });
  });

  const decideReview = (review: ReviewAssignmentRecord, decision: 'approved' | 'changes_requested') => selectedProject && void run(async () => {
    const note = reviewNotes[review.id]?.trim();
    if (!note) throw new Error(decision === 'approved' ? '请填写通过依据。' : '请填写需要修改的具体内容。');
    const updated = await decideProjectReview(selectedProject.id, review.id, { revision: review.revision, decision, note });
    setReviews((current) => current.map((item) => item.id === updated.id ? updated : item));
    setReviewNotes((current) => { const next = { ...current }; delete next[review.id]; return next; });
  });

  const changeDecisionStatus = (decision: ProjectDecisionRecord, status: ProjectDecisionRecord['data']['status']) => selectedProject && void run(async () => {
    const updated = await updateProjectDecision(selectedProject.id, decision.id, { revision: decision.revision, status });
    setDecisions((current) => current.map((item) => item.id === updated.id ? updated : item));
  });

  const readNotification = (notification: ProjectNotificationRecord) => void run(async () => {
    if (notification.status === 'unread') {
      const updated = await markProjectNotificationRead(notification.id);
      setNotifications((current) => current.map((item) => item.id === updated.id ? updated : item));
    }
    const projectId = typeof notification.data.projectId === 'string' ? notification.data.projectId : notification.projectId;
    if (projectId && projects.some((project) => project.id === projectId)) {
      setSelectedProjectId(projectId);
      setTab('projects');
      setNotificationsOpen(false);
    }
  });

  const submitMemory = () => void run(async () => {
    const input = {
      content: memoryDraft.content.trim(), source: memoryDraft.source.trim(), layer: memoryDraft.layer,
      confidence: memoryDraft.confidence, scope: memoryDraft.scope,
      ...(memoryDraft.scopeId.trim() ? { scopeId: memoryDraft.scopeId.trim() } : {}),
      ...(memoryDraft.expiresAt ? { expiresAt: new Date(memoryDraft.expiresAt).toISOString() } : {}),
      enabled: editingMemory ? editingMemory.status === 'active' : true,
    };
    const memory = editingMemory
      ? await updateMemory(editingMemory.id, { ...input, revision: editingMemory.revision })
      : await createMemory(input);
    setMemories((current) => editingMemory ? current.map((item) => item.id === memory.id ? memory : item) : [memory, ...current]);
    setMemoryDraft({ content: '', source: '用户创建', layer: 'L1', confidence: .9, scope: 'user', scopeId: '', expiresAt: '' });
    setEditingMemory(null);
    setOpenComposer(null);
  });

  const editMemory = (memory: MemoryRecord) => {
    setEditingMemory(memory);
    setMemoryDraft({
      content: memory.data.content,
      source: memory.data.source,
      layer: memory.data.layer,
      confidence: memory.data.confidence,
      scope: memory.data.scope,
      scopeId: memory.data.scopeId ?? '',
      expiresAt: memory.data.expiresAt ? new Date(memory.data.expiresAt).toISOString().slice(0, 16) : '',
    });
    setOpenComposer('memory');
  };

  const toggleMemory = (memory: MemoryRecord) => void run(async () => {
    const updated = await updateMemory(memory.id, { revision: memory.revision, enabled: memory.status !== 'active' });
    setMemories((current) => current.map((item) => item.id === updated.id ? updated : item));
  });

  const removeMemory = (memory: MemoryRecord) => void run(async () => {
    await deleteMemory(memory.id);
    setMemories((current) => current.filter((item) => item.id !== memory.id));
  });

  const submitTool = () => void run(async () => {
    let specification: Record<string, unknown>;
    try { specification = JSON.parse(toolDraft.specification) as Record<string, unknown>; }
    catch { throw new Error('工具定义必须是有效 JSON。'); }
    const source = await createToolSource({
      name: toolDraft.name.trim(), protocol: toolDraft.protocol, location: toolDraft.location, version: toolDraft.version.trim(), enabled: false,
      description: toolDraft.description.trim(),
      categories: toolDraft.categories.split(',').map((item) => item.trim()).filter(Boolean),
      capabilityTags: toolDraft.capabilityTags.split(',').map((item) => item.trim()).filter(Boolean),
      riskLevel: toolDraft.riskLevel, authType: toolDraft.authType, visibility: toolDraft.visibility,
      allowedAgentIds: toolDraft.allowedAgents.split(',').map((item) => item.trim()).filter(Boolean), specification,
    });
    setToolSources((current) => [source, ...current]);
    setToolDraft({ name: '', description: '', protocol: 'openapi', location: 'internet', version: '1.0.0', categories: '', capabilityTags: '', riskLevel: 'low', authType: 'none', visibility: 'private', allowedAgents: '', specification: '' });
    setOpenComposer(null);
  });

  const toggleTool = (source: ToolSourceRecord) => void run(async () => {
    const updated = await updateToolSource(source.id, { revision: source.revision, enabled: source.status !== 'enabled' });
    setToolSources((current) => current.map((item) => item.id === updated.id ? updated : item));
  });

  const checkTool = (source: ToolSourceRecord) => void run(async () => {
    const updated = await checkToolSourceHealth(source.id);
    setToolSources((current) => current.map((item) => item.id === updated.id ? updated : item));
  });

  const decideApproval = (sourceId: string, approval: ToolApprovalRecord, approved: boolean) => void run(async () => {
    const updated = await decideToolApproval(sourceId, approval.id, { approved, revision: approval.revision, note: approved ? '允许本次固定参数调用。' : '拒绝本次工具调用。' });
    setToolApprovals((current) => ({ ...current, [sourceId]: (current[sourceId] ?? []).map((item) => item.id === updated.id ? updated : item) }));
  });

  const runEstimate = () => estimateInput.trim() && void run(async () => {
    setEstimate(await estimateTask(estimateInput.trim(), estimateMode));
  });

  const solutionGroups = useMemo(() => [solutions.slice(0, 5), solutions.slice(5)], [solutions]);

  return <div className="business-workspace">
    <header className="business-header">
      <div><span className="business-kicker"><Network size={14} />协作与业务资产</span><h1>项目空间</h1></div>
      <div className="business-header-actions"><button type="button" className={notifications.some((item) => item.status === 'unread') ? 'has-notice' : ''} onClick={() => setNotificationsOpen((current) => !current)} title="项目通知"><Bell size={15} /><span>{notifications.filter((item) => item.status === 'unread').length}</span></button><button type="button" onClick={() => void load()} disabled={loading || busy} title="刷新"><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>{tab === 'projects' && <button type="button" className="primary" onClick={() => setOpenComposer('project')}><Plus size={15} />新建项目</button>}{tab === 'memory' && <button type="button" className="primary" onClick={() => { setEditingMemory(null); setMemoryDraft({ content: '', source: '用户创建', layer: 'L1', confidence: .9, scope: 'user', scopeId: '', expiresAt: '' }); setOpenComposer('memory'); }}><Plus size={15} />添加记忆</button>}{tab === 'tools' && <button type="button" className="primary" onClick={() => setOpenComposer('tool')}><Plus size={15} />导入工具</button>}</div>
    </header>

    {notificationsOpen && <section className="business-notifications glass-panel"><div className="business-pane-head"><span>项目通知</span><button type="button" aria-label="关闭通知" onClick={() => setNotificationsOpen(false)}><X size={14} /></button></div>{notifications.map((notification) => <button type="button" key={notification.id} className={notification.status === 'unread' ? 'unread' : ''} onClick={() => readNotification(notification)}><Bell size={13} /><span><strong>{notification.data.type === 'mention' ? '有人提到了你' : notification.data.type === 'review-assignment' ? '新的审核任务' : '审核已有结果'}</strong><small>{String(notification.data.preview ?? notification.data.targetId ?? '')}</small></span><em>{fmtTime(notification.updatedAt)}</em></button>)}{notifications.length === 0 && <div className="business-empty">暂无项目通知</div>}</section>}

    <nav className="business-tabs" aria-label="项目空间栏目">{tabs.map((item) => { const Icon = item.icon; return <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><Icon size={15} />{item.label}</button>; })}</nav>
    {error && <div className="business-error"><span>{error}</span><button type="button" aria-label="关闭" onClick={() => setError(null)}><X size={14} /></button></div>}

    {tab === 'projects' && <div className="business-project-layout">
      <aside className="business-project-list glass-panel">
        <div className="business-pane-head"><span>进行中的项目</span><em>{projects.filter((project) => project.status === 'active').length}</em></div>
        <div className="business-scroll-list">{projects.map((project) => <button type="button" key={project.id} className={selectedProject?.id === project.id ? 'active' : ''} onClick={() => setSelectedProjectId(project.id)}><span><i /><strong>{project.data.name}</strong></span><small>{project.data.goal}</small><em>{fmtTime(project.updatedAt)}</em></button>)}{!loading && projects.length === 0 && <div className="business-empty"><FolderKanban size={22} /><span>还没有项目</span></div>}</div>
      </aside>
      <section className="business-project-main glass-panel">{selectedProject ? <>
        <div className="business-project-title"><div><small>{projectReadOnly ? '已归档，只读查看' : '项目目标'}</small><h2>{selectedProject.data.name}</h2><p>{selectedProject.data.goal}</p></div><div><a href={`/api/capabilities/projects/${encodeURIComponent(selectedProject.id)}/export`} download title="导出项目"><Download size={15} /></a>{!projectReadOnly && <button type="button" title="归档" onClick={() => void run(async () => { const archived = await archiveProject(selectedProject.id, selectedProject.revision); setProjects((current) => current.map((item) => item.id === archived.id ? archived : item)); })}><Archive size={15} /></button>}</div></div>
        <fieldset className="business-project-fields" disabled={projectReadOnly || busy}>
        <div className="business-project-grid">
          <section><div className="business-pane-head"><span>验收标准</span><BookOpenCheck size={14} /></div><ul className="business-check-list">{selectedProject.data.acceptanceCriteria.map((item) => <li key={item}><Check size={13} />{item}</li>)}{selectedProject.data.acceptanceCriteria.length === 0 && <li className="muted">尚未设置</li>}</ul><div className="business-inline-editor"><input value={projectDraft.acceptance} onChange={(event) => setProjectDraft((current) => ({ ...current, acceptance: event.target.value }))} placeholder="补充验收标准，每行一条" /><button type="button" onClick={saveProject} disabled={!projectDraft.acceptance.trim() || busy}><Save size={14} /></button></div></section>
          <section><div className="business-pane-head"><span>成员</span><UserPlus size={14} /></div><div className="business-member-list"><span><b>{selectedProject.ownerId.slice(0, 1).toUpperCase()}</b><em>{selectedProject.ownerId}</em><small>负责人</small></span>{selectedProject.data.members.map((member) => <span key={member.userId}><b>{member.userId.slice(0, 1).toUpperCase()}</b><em>{member.userId}</em><small>{projectRoleLabel[member.role]}</small><button type="button" aria-label={`移除成员 ${member.userId}`} onClick={() => removeMember(member.userId)}><X size={12} /></button></span>)}</div><div className="business-inline-editor triple"><input value={memberDraft.userId} onChange={(event) => setMemberDraft((current) => ({ ...current, userId: event.target.value }))} placeholder="成员账号" /><select value={memberDraft.role} onChange={(event) => setMemberDraft((current) => ({ ...current, role: event.target.value as typeof memberDraft.role }))}><option value="editor">可编辑</option><option value="reviewer">审核人</option><option value="viewer">只读</option></select><button type="button" onClick={addMember} disabled={!memberDraft.userId.trim() || busy}><Plus size={14} /></button></div></section>
          <section><div className="business-pane-head"><span>业务资产</span><Link2 size={14} /></div><div className="business-resource-list">{Object.entries(selectedProject.data.resources ?? {}).flatMap(([kind, ids]) => ids.map((id) => <span key={`${kind}:${id}`}><em>{kind}</em><small>{id}</small><button type="button" aria-label={`解绑 ${kind}`} onClick={() => removeResource(kind, id)}><X size={11} /></button></span>))}{Object.values(selectedProject.data.resources ?? {}).every((ids) => ids.length === 0) && <small>把任务、Nexus、Artifact 或日程关联到项目。</small>}</div><div className="business-inline-editor triple"><select value={resourceDraft.type} onChange={(event) => setResourceDraft((current) => ({ ...current, type: event.target.value as typeof current.type }))}><option value="task">任务</option><option value="session">会话</option><option value="nexus">Nexus</option><option value="schedule">日程</option><option value="artifact">Artifact</option><option value="decision">决策</option></select><input value={resourceDraft.id} onChange={(event) => setResourceDraft((current) => ({ ...current, id: event.target.value }))} placeholder="资源 ID" /><button type="button" onClick={addResource} disabled={!resourceDraft.id.trim() || busy}><Plus size={14} /></button></div></section>
          <section><div className="business-pane-head"><span>评论与交接</span><MessageSquarePlus size={14} /></div><div className="business-comments">{comments.slice(0, 6).map((comment) => <article key={comment.id}><strong>{comment.ownerId}</strong><p>{String(comment.data.body ?? '')}</p><small>{fmtTime(comment.updatedAt)}</small></article>)}{comments.length === 0 && <small>还没有评论，可用 @账号 提及成员。</small>}</div><div className="business-inline-editor"><input value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} placeholder="评论或 @成员" onKeyDown={(event) => { if (event.key === 'Enter') addComment(); }} /><button type="button" onClick={addComment} disabled={!commentDraft.trim() || busy}><ChevronRight size={14} /></button></div></section>
          <section><div className="business-pane-head"><span>从项目发起任务</span><Play size={14} /></div><div className="business-stack-editor"><input value={taskDraft.title} onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))} placeholder="任务名称" /><textarea rows={2} value={taskDraft.input} onChange={(event) => setTaskDraft((current) => ({ ...current, input: event.target.value }))} placeholder="要完成什么；项目目标与验收标准会自动加入上下文" /><div><select value={taskDraft.mode} onChange={(event) => setTaskDraft((current) => ({ ...current, mode: event.target.value as AgentMode }))}><option value="analyze">分析</option><option value="build">构建</option><option value="decide">决策</option></select><button type="button" onClick={submitProjectTask} disabled={!taskDraft.title.trim() || !taskDraft.input.trim() || busy}><Send size={13} />启动</button></div></div></section>
          <section><div className="business-pane-head"><span>决策记录</span><CheckCircle2 size={14} /></div><div className="business-decision-list">{decisions.slice(0, 4).map((decision) => <article key={decision.id}><strong>{decision.data.title}</strong><p>{decision.data.decision}</p><small>{projectDecisionLabel[decision.data.status] ?? projectDecisionLabel.proposed} · {fmtTime(decision.updatedAt)}</small>{decision.status === 'proposed' && <span><button type="button" onClick={() => changeDecisionStatus(decision, 'accepted')}><Check size={12} />采纳</button><button type="button" onClick={() => changeDecisionStatus(decision, 'rejected')}><XCircle size={12} />驳回</button></span>}{decision.status === 'accepted' && <button type="button" onClick={() => changeDecisionStatus(decision, 'superseded')}>标记已替代</button>}</article>)}{decisions.length === 0 && <small>保留关键选择和理由，避免团队反复讨论。</small>}</div><div className="business-stack-editor compact"><input value={decisionDraft.title} onChange={(event) => setDecisionDraft((current) => ({ ...current, title: event.target.value }))} placeholder="决策标题" /><input value={decisionDraft.decision} onChange={(event) => setDecisionDraft((current) => ({ ...current, decision: event.target.value }))} placeholder="最终选择" /><button type="button" onClick={submitDecision} disabled={!decisionDraft.title.trim() || !decisionDraft.decision.trim() || busy}><Plus size={13} />记录</button></div></section>
          <section className="business-review-section"><div className="business-pane-head"><span>审核交接</span><ShieldCheck size={14} /></div><div className="business-review-list">{reviews.slice(0, 5).map((review) => <article key={review.id}><div><strong>{review.data.reviewerId}</strong><small>{review.data.targetType} · {review.data.targetId}</small></div><em className={review.status}>{review.status === 'assigned' ? '待审核' : review.status === 'approved' ? '已通过' : '需修改'}</em>{review.status === 'assigned' && <><input value={reviewNotes[review.id] ?? ''} onChange={(event) => setReviewNotes((current) => ({ ...current, [review.id]: event.target.value }))} placeholder="填写审核依据或修改意见" /><span><button type="button" onClick={() => decideReview(review, 'approved')} disabled={!reviewNotes[review.id]?.trim()}><Check size={12} />通过</button><button type="button" onClick={() => decideReview(review, 'changes_requested')} disabled={!reviewNotes[review.id]?.trim()}><XCircle size={12} />需修改</button></span></>}{review.data.reviewNote && <p>{review.data.reviewNote}</p>}</article>)}{reviews.length === 0 && <small>把项目中的任务、Nexus 或 Artifact 交给审核人。</small>}</div><div className="business-review-editor"><input value={reviewDraft.reviewerId} onChange={(event) => setReviewDraft((current) => ({ ...current, reviewerId: event.target.value }))} placeholder="审核人账号" /><select value={reviewDraft.targetType} onChange={(event) => setReviewDraft((current) => ({ ...current, targetType: event.target.value as typeof current.targetType }))}><option value="task">任务</option><option value="nexus">Nexus</option><option value="artifact">Artifact</option></select><input value={reviewDraft.targetId} onChange={(event) => setReviewDraft((current) => ({ ...current, targetId: event.target.value }))} placeholder="目标 ID" /><button type="button" onClick={submitReview} disabled={!reviewDraft.reviewerId.trim() || !reviewDraft.targetId.trim() || busy}><UserPlus size={13} />分配</button></div></section>
        </div>
        </fieldset>
      </> : <div className="business-empty large"><FolderKanban size={30} /><strong>创建第一个项目</strong><span>把目标、任务、Nexus 和交付放在同一处。</span></div>}</section>
    </div>}

    {tab === 'memory' && <section className="business-section glass-panel">
      <div className="business-section-head"><div><span>长期记忆</span><p>可追溯、可停用、可过期。</p></div><em className={memoryCore === 'configured' ? 'ready' : 'degraded'}>{memoryCore === 'configured' ? 'MemoryCore 已连接' : '本地策略模式'}</em></div>
      <div className="business-memory-list">{memories.map((memory) => <article key={memory.id} className={`${memory.status !== 'active' ? 'disabled ' : ''}${memory.data.syncState === 'failed' ? 'sync-failed' : ''}`}><div className="business-memory-meta"><span>{memoryLayerLabel[memory.data.layer]}</span><em>{Math.round(memory.data.confidence * 100)}%</em><small>{memoryScopeLabel[memory.data.scope]}</small></div><p>{memory.data.content}</p><div className={`business-memory-sync ${memory.data.syncState ?? 'local-policy'}`} title={memory.data.syncMessage}><i />{memorySyncLabel[memory.data.syncState ?? 'local-policy']}<small>{memory.data.syncMessage}</small></div><footer><span>{memory.data.source} · {fmtTime(memory.updatedAt)}{memory.data.expiresAt ? ` · ${new Date(memory.data.expiresAt).toLocaleDateString('zh-CN')} 过期` : ''}</span><button type="button" onClick={() => editMemory(memory)}>编辑</button><button type="button" onClick={() => toggleMemory(memory)}>{memory.status === 'active' ? '停用' : '启用'}</button><button type="button" className="danger" aria-label="删除记忆" onClick={() => removeMemory(memory)}><Trash2 size={13} /></button></footer></article>)}{!loading && memories.length === 0 && <div className="business-empty"><BrainCircuit size={24} /><span>还没有可管理的长期记忆</span></div>}</div>
    </section>}

    {tab === 'tools' && <section className="business-section glass-panel">
      <div className="business-section-head"><div><span>MCP / OpenAPI 能力目录</span><p>Agent 会按任务自动选择少量可用工具。</p></div><em>{toolSources.filter((item) => item.status === 'enabled' && item.data.healthStatus === 'healthy' && item.data.authorizationStatus !== 'pending').length} 个可用</em></div>
      <div className="business-tool-list">{toolSources.map((source) => {
        const approvals = (toolApprovals[source.id] ?? []).filter((approval) => approval.status === 'awaiting_approval');
        const health = source.data.healthStatus ?? 'unknown';
        const pendingAuthorization = source.data.authorizationStatus === 'pending';
        const available = source.status === 'enabled' && health === 'healthy' && !pendingAuthorization;
        return <article key={source.id} className={`tool-health-${health}${pendingAuthorization ? ' tool-auth-pending' : ''}`}>
          <header><div><strong>{source.data.name}</strong><small>{source.data.protocol.toUpperCase()} · v{source.data.version} · {source.data.location === 'local' ? '本地' : '互联网'}</small></div><div className="business-tool-actions"><button type="button" className="icon-action" onClick={() => checkTool(source)} title="重新检查"><RefreshCw size={13} /></button><button type="button" className={available ? 'toggle active' : 'toggle'} onClick={() => toggleTool(source)} aria-label={source.status === 'enabled' ? '停用工具' : '启用工具'}><i /></button></div></header>
          <div className="business-tool-state"><span className={pendingAuthorization ? 'pending' : health}>{pendingAuthorization ? '待授权' : toolHealthLabel[health]}</span>{(source.data.categories ?? []).slice(0, 3).map((category) => <em key={category}>{toolCategoryLabel[category] ?? category}</em>)}</div>
          <p>{source.data.description || source.data.endpoint}</p>
          <div className="business-tool-capabilities">{(source.data.capabilityTags ?? []).slice(0, 6).map((name) => <span key={name}>{name}</span>)}{(source.data.capabilityTags ?? []).length === 0 && <span>系统会根据工具说明自动识别能力</span>}</div>
          <div className="business-tool-metrics"><span><small>成功率</small><strong>{source.data.successRate == null ? '等待调用' : `${Math.round(source.data.successRate * 100)}%`}</strong></span><span><small>探测延迟</small><strong>{source.data.latencyMs == null ? '-' : `${source.data.latencyMs} ms`}</strong></span><span><small>使用次数</small><strong>{source.data.usageCount ?? 0}</strong></span></div>
          <footer><span>可使用：{source.data.allowedAgentIds.length ? source.data.allowedAgentIds.join('、') : '全部 Agent'}</span><em>{source.data.riskLevel === 'high' ? '高风险需确认' : source.data.riskLevel === 'low' ? '低风险' : '中风险'}</em></footer>
          {source.data.healthMessage && health === 'unhealthy' && <small className="business-tool-warning">{source.data.healthMessage}</small>}
          {approvals.map((approval) => <div className="business-tool-approval" key={approval.id}><span><strong>高风险调用待确认</strong><small>{approval.data.operationId} · {approval.data.agentId}</small></span><button type="button" onClick={() => decideApproval(source.id, approval, false)}>拒绝</button><button type="button" className="approve" onClick={() => decideApproval(source.id, approval, true)}>允许本次</button></div>)}
        </article>;
      })}{!loading && toolSources.length === 0 && <div className="business-empty"><Wrench size={24} /><span>尚未导入外部工具</span></div>}</div>
    </section>}

    {tab === 'solutions' && <section className="business-section glass-panel solutions">
      <div className="business-section-head"><div><span>可执行方案</span><p>选择场景后直接进入对话，路由会按任务难度安排 Agent。</p></div><em>{solutions.length} 类</em></div>
      <div className="business-solutions">{solutionGroups.flatMap((group) => group).map((solution, index) => <button type="button" key={solution.id} onClick={() => onUseSolution(`请使用“${solution.name}”方案完成以下目标：\n\n`, solution.mode)}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{solution.name}</strong><p>{solution.description}</p><small>{solution.workflowDefinition.join(' · ')}</small></div><ChevronRight size={15} /></button>)}</div>
    </section>}

    {tab === 'intelligence' && <div className="business-intelligence-layout">
      <section className="business-estimator glass-panel"><div className="business-section-head"><div><span>运行前预估</span><p>使用同类真实任务，不显示固定倒计时。</p></div><BarChart3 size={17} /></div><textarea rows={5} value={estimateInput} onChange={(event) => setEstimateInput(event.target.value)} placeholder="输入准备执行的任务" /><div className="business-estimate-controls"><div>{(['analyze', 'build', 'decide'] as const).map((mode) => <button type="button" key={mode} className={estimateMode === mode ? 'active' : ''} onClick={() => setEstimateMode(mode)}>{mode === 'analyze' ? '分析' : mode === 'build' ? '构建' : '决策'}</button>)}</div><button type="button" className="primary" disabled={!estimateInput.trim() || busy} onClick={runEstimate}>{busy ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}预估</button></div>{estimate && <div className="business-estimate-result"><div><small>预计耗时</small><strong>{fmtDuration(estimate.durationMs.likely)}</strong><span>{fmtDuration(estimate.durationMs.low)} - {fmtDuration(estimate.durationMs.high)}</span></div><div><small>Agent</small><strong>{estimate.agentCount}</strong><span>{estimate.profile.route}</span></div><div><small>Token</small><strong>{compact(estimate.tokens.likely)}</strong><span>{compact(estimate.tokens.low)} - {compact(estimate.tokens.high)}</span></div><div><small>成功率</small><strong>{estimate.successRate === null ? '等待样本' : `${Math.round(estimate.successRate * 100)}%`}</strong><span>{confidenceLabel[estimate.confidence]} · {estimate.sampleSize} 个样本</span></div><p>{estimate.basis}</p></div>}</section>
      <section className="business-model-policy glass-panel"><div className="business-section-head"><div><span>模型选择</span><p>每次选择都有可解释依据。</p></div><ShieldCheck size={17} /></div><div className="business-model-list">{selection?.candidates.map((candidate) => <article key={candidate.model}><div><strong>{candidate.model}</strong><em>{candidate.attempts} 次</em></div><p>{candidate.explanation}</p><span><i style={{ width: `${Math.max(4, Math.round((candidate.successRate ?? (candidate.attempts ? candidate.successes / candidate.attempts : 0)) * 100))}%` }} /></span></article>)}{selection?.candidates.length === 0 && <div className="business-empty"><CircleGauge size={23} /><span>模型统计会在真实任务完成后出现</span></div>}</div><footer>{selection?.selectionPolicy}</footer></section>
    </div>}

    {openComposer && <div className="business-modal" role="dialog" aria-modal="true" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpenComposer(null); }}><form className="business-modal-panel glass-panel" onSubmit={(event) => { event.preventDefault(); if (openComposer === 'project') submitProject(); else if (openComposer === 'memory') submitMemory(); else submitTool(); }}><header><div><small>{openComposer === 'project' ? '新的协作空间' : openComposer === 'memory' ? '可控长期记忆' : '外部能力目录'}</small><h2>{openComposer === 'project' ? '创建项目' : openComposer === 'memory' ? editingMemory ? '编辑记忆' : '添加记忆' : '导入工具'}</h2></div><button type="button" aria-label="关闭" onClick={() => setOpenComposer(null)}><X size={16} /></button></header>
      {openComposer === 'project' && <div className="business-form"><label><span>项目名称</span><input required maxLength={120} value={projectDraft.name} onChange={(event) => setProjectDraft((current) => ({ ...current, name: event.target.value }))} /></label><label><span>目标</span><textarea required rows={4} value={projectDraft.goal} onChange={(event) => setProjectDraft((current) => ({ ...current, goal: event.target.value }))} /></label><label><span>验收标准</span><textarea rows={4} placeholder="每行一条" value={projectDraft.acceptance} onChange={(event) => setProjectDraft((current) => ({ ...current, acceptance: event.target.value }))} /></label><label><span>项目策略</span><textarea rows={3} value={projectDraft.strategy} onChange={(event) => setProjectDraft((current) => ({ ...current, strategy: event.target.value }))} /></label></div>}
      {openComposer === 'memory' && <div className="business-form"><label><span>记忆内容</span><textarea required rows={6} value={memoryDraft.content} onChange={(event) => setMemoryDraft((current) => ({ ...current, content: event.target.value }))} /></label><div className="business-form-row"><label><span>层级</span><select value={memoryDraft.layer} onChange={(event) => setMemoryDraft((current) => ({ ...current, layer: event.target.value as typeof current.layer }))}>{Object.entries(memoryLayerLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>作用域</span><select value={memoryDraft.scope} onChange={(event) => setMemoryDraft((current) => ({ ...current, scope: event.target.value as typeof current.scope }))}><option value="user">用户</option><option value="project">项目</option><option value="session">会话</option><option value="agent">Agent</option></select></label></div>{memoryDraft.scope !== 'user' && <label><span>{memoryDraft.scope === 'project' ? '项目 ID' : memoryDraft.scope === 'session' ? '会话 ID' : 'Agent ID'}</span><input required value={memoryDraft.scopeId} onChange={(event) => setMemoryDraft((current) => ({ ...current, scopeId: event.target.value }))} /></label>}<div className="business-form-row"><label><span>置信度</span><input type="number" min="0" max="1" step="0.05" value={memoryDraft.confidence} onChange={(event) => setMemoryDraft((current) => ({ ...current, confidence: Number(event.target.value) }))} /></label><label><span>过期时间（可选）</span><input type="datetime-local" value={memoryDraft.expiresAt} onChange={(event) => setMemoryDraft((current) => ({ ...current, expiresAt: event.target.value }))} /></label></div><label><span>来源</span><input required value={memoryDraft.source} onChange={(event) => setMemoryDraft((current) => ({ ...current, source: event.target.value }))} /></label></div>}
      {openComposer === 'tool' && <div className="business-form">
        <div className="business-form-row"><label><span>名称</span><input required value={toolDraft.name} onChange={(event) => setToolDraft((current) => ({ ...current, name: event.target.value }))} /></label><label><span>版本</span><input required value={toolDraft.version} onChange={(event) => setToolDraft((current) => ({ ...current, version: event.target.value }))} /></label></div>
        <label><span>这个工具能做什么</span><input value={toolDraft.description} onChange={(event) => setToolDraft((current) => ({ ...current, description: event.target.value }))} placeholder="例如：查询天气和未来七天预报" /></label>
        <div className="business-form-row"><label><span>协议</span><select value={toolDraft.protocol} onChange={(event) => setToolDraft((current) => ({ ...current, protocol: event.target.value as typeof current.protocol }))}><option value="openapi">OpenAPI 3.x</option><option value="mcp">MCP HTTP</option></select></label><label><span>服务位置</span><select value={toolDraft.location} onChange={(event) => setToolDraft((current) => ({ ...current, location: event.target.value as typeof current.location }))}><option value="internet">互联网</option><option value="local">本地网络</option></select></label></div>
        <div className="business-form-row"><label><span>能力分类</span><input value={toolDraft.categories} onChange={(event) => setToolDraft((current) => ({ ...current, categories: event.target.value }))} placeholder="研究, 办公；留空自动识别" /></label><label><span>能力关键词</span><input value={toolDraft.capabilityTags} onChange={(event) => setToolDraft((current) => ({ ...current, capabilityTags: event.target.value }))} placeholder="天气, 预报；留空自动识别" /></label></div>
        <div className="business-form-row"><label><span>认证方式</span><select value={toolDraft.authType} onChange={(event) => setToolDraft((current) => ({ ...current, authType: event.target.value as typeof current.authType }))}><option value="none">无需认证</option><option value="api-key">API Key（导入后待授权）</option><option value="oauth2">OAuth 2（导入后待授权）</option><option value="service-account">服务账号（导入后待授权）</option></select></label><label><span>可见范围</span><select value={toolDraft.visibility} onChange={(event) => setToolDraft((current) => ({ ...current, visibility: event.target.value as typeof current.visibility }))}><option value="private">仅自己</option><option value="tenant">当前团队</option></select></label></div>
        <label><span>允许使用的 Agent</span><input value={toolDraft.allowedAgents} onChange={(event) => setToolDraft((current) => ({ ...current, allowedAgents: event.target.value }))} placeholder="逗号分隔；留空表示全部" /></label>
        <label><span>{toolDraft.protocol === 'openapi' ? 'OpenAPI JSON' : 'MCP 配置 JSON'}</span><textarea required rows={9} spellCheck={false} value={toolDraft.specification} onChange={(event) => setToolDraft((current) => ({ ...current, specification: event.target.value }))} placeholder={toolDraft.protocol === 'mcp' ? '{"endpoint":"https://.../mcp"}' : '{"openapi":"3.1.0","servers":[...],"paths":{...}}'} /></label>
      </div>}
      <footer><button type="button" onClick={() => setOpenComposer(null)}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}确认</button></footer>
    </form></div>}
  </div>;
}
