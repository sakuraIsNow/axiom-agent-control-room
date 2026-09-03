import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  Circle,
  FileUp,
  FlaskConical,
  GitCompareArrows,
  GitBranch,
  Link2,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Plus,
  PackageCheck,
  RotateCcw,
  Rocket,
  Save,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cancelWorkflowTask, getWorkflowTask, listWorkflowTasks, streamWorkflowEvents } from '../../lib/taskRuntime';
import { userFacingError } from '../../lib/errorPresentation';
import {
  deleteAgentWorkflow,
  createNexusTest,
  createNexusWorkflowPlugin,
  compareNexusReleases,
  linkNexusArtifact,
  listAgentWorkflows,
  listNexusArtifacts,
  listNexusReleases,
  listNexusTestRuns,
  listNexusTests,
  listReusableArtifacts,
  listWorkflowAgentSources,
  publishNexus,
  restoreNexusRelease,
  runNexusTests,
  runAgentWorkflow,
  saveAgentWorkflow,
  validateAgentWorkflow,
  uploadNexusArtifact,
  waitForNexusTestRuns,
  type BuiltinWorkflowAgent,
  type SavedAgentWorkflow,
  type NexusBusinessRecord,
  type NexusReleaseDiff,
  type ReusableArtifact,
  type WorkflowCanvas,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode,
  type WorkflowScopedAgent,
  type WorkflowValidationIssue,
} from '../../lib/workflowRuntime';
import type { UserDefinedAgent } from '../../types';
import { buildConversationContext } from '../../lib/conversationContext';
import '../../styles/workflow-release.css';

type CanvasSelection = { type: 'node'; id: string } | { type: 'edge'; id: string } | null;
type NodeRunStatus = 'queued' | 'running' | 'completed' | 'failed';
type RunnerMessage = { id: string; role: 'user' | 'assistant'; content: string; pending?: boolean };

const makeId = (prefix: string) => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

const defaultCanvas = (): WorkflowCanvas => ({
  schemaVersion: 1,
  nodes: [
    { id: 'input-main', type: 'input', name: '输入', position: { x: 90, y: 150 } },
    {
      id: 'agent-main',
      type: 'agent',
      name: '分析员',
      description: '理解输入并生成可交付结果。',
      position: { x: 390, y: 135 },
      agentRef: { source: 'builtin', id: 'analyst' },
      icon: '🧠',
      objective: '分析用户输入，给出完整、清晰且可验证的结果。',
      acceptanceCriteria: ['结论直接回应用户输入。'],
      toolNames: [],
      failureStrategy: 'retry',
    },
    { id: 'output-main', type: 'output', name: '输出', position: { x: 720, y: 150 } },
  ],
  edges: [
    { id: 'edge-input-agent', source: 'input-main', target: 'agent-main', kind: 'flow' },
    { id: 'edge-agent-output', source: 'agent-main', target: 'output-main', kind: 'flow' },
  ],
  scopedAgents: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});

const baseStepId = (stepId: string) => stepId.replace(/-loop-\d+$/, '');
const latestUserInput = (input: string) => {
  const matches = [...input.matchAll(/(?:^|\n\n)USER:\n([\s\S]*?)(?=\n\n(?:USER|ASSISTANT):\n|$)/gi)];
  return (matches.at(-1)?.[1] ?? input).trim();
};
const nodeTone: Record<WorkflowCanvasNode['type'], string> = { input: '输入', agent: 'Agent', output: '输出' };
const statusLabel: Record<NodeRunStatus, string> = { queued: '等待', running: '执行中', completed: '完成', failed: '失败' };

const nodeDimensions = (node: WorkflowCanvasNode) => node.type === 'agent'
  ? { width: 184, height: 86 }
  : { width: 150, height: 70 };

const iconForIdentity = (identity: string) => {
  if (/research|search|搜索|研究|论文|github/i.test(identity)) return '🔎';
  if (/analyst|分析/i.test(identity)) return '🧠';
  if (/builder|工程|绘图|drawing/i.test(identity)) return '🎨';
  if (/review|审查|复核/i.test(identity)) return '✅';
  if (/synth|汇总/i.test(identity)) return '✨';
  if (/video|视频/i.test(identity)) return '🎬';
  if (/联网|web/i.test(identity)) return '🌐';
  return '🤖';
};

const agentIcon = (node: WorkflowCanvasNode) => node.icon || iconForIdentity(`${node.agentRef?.id ?? ''} ${node.name}`);
const nexusDisplayName = (value: string) => value.replaceAll('工作流', 'Nexus');

const toolPresentation: Record<string, { label: string; description: string }> = {
  'agent.propose': { label: '创建 Agent 草稿', description: '生成待审核的自定义 Agent，不会自动发布。' },
  'workspace.search': { label: '搜索工作区', description: '在已挂载工作区中查找文件和内容。' },
  'workspace.read': { label: '阅读工作区文件', description: '读取工作区中的文本文件。' },
  'document.read': { label: '阅读文档', description: '读取 Markdown、JSON、YAML、XML 和文本文件。' },
  'table.read': { label: '读取表格', description: '读取 CSV 或 JSON 表格。' },
  'http.fetch': { label: '获取网页或 API', description: '读取允许访问的 HTTP/HTTPS 内容。' },
  'browser.open': { label: '打开网页', description: '打开允许访问的公开网页并读取正文。' },
  'database.query': { label: '查询数据库', description: '执行只读查询，不会修改数据。' },
  'workspace.git-status': { label: '查看代码状态', description: '查看工作区 Git 状态。' },
  'workspace.git-diff': { label: '查看代码差异', description: '查看当前代码改动。' },
  'workspace.git-branch': { label: '查看代码分支', description: '查看当前分支信息。' },
  'workspace.git-commits': { label: '查看提交记录', description: '查看近期本地 Git 提交。' },
  'workspace.test': { label: '运行测试', description: '运行受限的项目测试命令。' },
  'workspace.write': { label: '写入文件', description: '经人工批准后写入工作区文件。' },
  'workspace.patch': { label: '修改文件', description: '经人工批准后精确修改工作区文件。' },
};

const edgePath = (source: WorkflowCanvasNode, target: WorkflowCanvasNode, kind: WorkflowCanvasEdge['kind']) => {
  const sourceSize = nodeDimensions(source);
  const targetSize = nodeDimensions(target);
  const x1 = source.position.x + sourceSize.width;
  const y1 = source.position.y + sourceSize.height / 2;
  const x2 = target.position.x;
  const y2 = target.position.y + targetSize.height / 2;
  if (kind === 'loop') {
    const lift = Math.max(120, Math.abs(x1 - x2) * 0.26);
    return `M ${x1} ${y1} C ${x1 + 70} ${y1 - lift}, ${x2 - 70} ${y2 - lift}, ${x2} ${y2}`;
  }
  const bend = Math.max(70, Math.abs(x2 - x1) * 0.42);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
};

export function WorkflowStudio() {
  const [workflows, setWorkflows] = useState<SavedAgentWorkflow[]>([]);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [name, setName] = useState('新的 Agent Nexus');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'team'>('private');
  const [canvas, setCanvas] = useState<WorkflowCanvas>(defaultCanvas);
  const [builtinAgents, setBuiltinAgents] = useState<BuiltinWorkflowAgent[]>([]);
  const [platformAgents, setPlatformAgents] = useState<UserDefinedAgent[]>([]);
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([]);
  const [selection, setSelection] = useState<CanvasSelection>({ type: 'node', id: 'agent-main' });
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [nexusSettingsOpen, setNexusSettingsOpen] = useState(false);
  const [nexusDeleteConfirm, setNexusDeleteConfirm] = useState(false);
  const [releaseCenterOpen, setReleaseCenterOpen] = useState(false);
  const [releaseCenterTab, setReleaseCenterTab] = useState<'tests' | 'artifacts' | 'releases'>('tests');
  const [nexusArtifacts, setNexusArtifacts] = useState<NexusBusinessRecord[]>([]);
  const [nexusTests, setNexusTests] = useState<NexusBusinessRecord[]>([]);
  const [nexusTestRuns, setNexusTestRuns] = useState<NexusBusinessRecord[]>([]);
  const [nexusReleases, setNexusReleases] = useState<NexusBusinessRecord[]>([]);
  const [reusableArtifacts, setReusableArtifacts] = useState<ReusableArtifact[]>([]);
  const [selectedReusableArtifactId, setSelectedReusableArtifactId] = useState('');
  const [releaseDiff, setReleaseDiff] = useState<NexusReleaseDiff | null>(null);
  const [testDraft, setTestDraft] = useState({ name: '', input: '', expected: '' });
  const [releaseNote, setReleaseNote] = useState('');
  const [edgeMode, setEdgeMode] = useState<'flow' | 'loop'>('flow');
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<WorkflowValidationIssue[]>([]);
  const [showScopedAgentForm, setShowScopedAgentForm] = useState(false);
  const [scopedDraft, setScopedDraft] = useState({ name: '', roleId: '', prompt: '', tools: '' });
  const [messages, setMessages] = useState<RunnerMessage[]>([]);
  const [runnerInput, setRunnerInput] = useState('');
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [runActivity, setRunActivity] = useState('Agent Nexus 待命');
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, NodeRunStatus>>({});
  const dragRef = useRef<{ kind: 'node' | 'pan'; id?: string; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const dragMovedRef = useRef(false);
  const runControllerRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef(`workflow-session-${crypto.randomUUID()}`);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);

  const restoreWorkflowHistory = useCallback(async (targetWorkflowId: string, signal: AbortSignal, replace = false) => {
    try {
      const summaries = await listWorkflowTasks(100, signal);
      const candidates = summaries
        .filter((task) => task.templateId === targetWorkflowId && !task.sessionId.startsWith('agent-nexus-test-'))
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
      if (!candidates.length) {
        if (replace && !signal.aborted) setMessages([]);
        return;
      }
      const details = await Promise.all(candidates.map((task) => getWorkflowTask(task.id, signal)));
      if (signal.aborted) return;
      const restored = details.flatMap((task) => {
        const userContent = latestUserInput(task.input ?? '');
        const assistantContent = task.result || (task.error ? `Agent Nexus 执行失败：${task.error}` : task.status === 'cancelled' ? '本次 Agent Nexus 已停止。' : '');
        const restoredMessages: RunnerMessage[] = userContent ? [{ id: `${task.id}-user`, role: 'user', content: userContent }] : [];
        if (assistantContent.trim()) restoredMessages.push({ id: `${task.id}-assistant`, role: 'assistant', content: assistantContent, pending: false });
        return restoredMessages;
      });
      if (restored.length) {
        setMessages((current) => replace ? restored : current.length ? current : restored);
      } else if (replace) {
        setMessages([]);
      }
    } catch (caught) {
      if (!signal.aborted) setError((current) => current ?? userFacingError(caught, 'Agent Nexus 历史读取失败。'));
    }
  }, []);

  useEffect(() => {
    if (!workflowId) return;
    const controller = new AbortController();
    void restoreWorkflowHistory(workflowId, controller.signal);
    const handleCatalogMutation = (event: Event) => {
      const detail = (event as CustomEvent<{ workflowId?: string; kind?: string }>).detail;
      if (detail?.kind && !['task-deleted', 'workflow-deleted', 'session-deleted'].includes(detail.kind)) return;
      if (detail?.workflowId && detail.workflowId !== workflowId) return;
      // The task catalog is authoritative. Replace the in-memory transcript
      // after deletion so removed Nexus runs cannot reappear.
      void restoreWorkflowHistory(workflowId, controller.signal, true);
    };
    window.addEventListener('axiom:task-catalog-mutated', handleCatalogMutation);
    return () => {
      controller.abort();
      window.removeEventListener('axiom:task-catalog-mutated', handleCatalogMutation);
    };
  }, [restoreWorkflowHistory, workflowId]);

  const refresh = useCallback(async () => {
    const items = await listAgentWorkflows();
    setWorkflows(items);
    return items;
  }, []);

  const refreshReleaseCenter = useCallback(async (targetWorkflowId: string) => {
    const [artifacts, tests, testRuns, releases, reusable] = await Promise.all([
      listNexusArtifacts(targetWorkflowId), listNexusTests(targetWorkflowId),
      listNexusTestRuns(targetWorkflowId), listNexusReleases(targetWorkflowId), listReusableArtifacts(),
    ]);
    setNexusArtifacts(artifacts);
    setNexusTests(tests);
    setNexusTestRuns(testRuns);
    setNexusReleases(releases);
    setReusableArtifacts(reusable.filter((candidate) => !artifacts.some((artifact) => artifact.data.artifactId === candidate.id)));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([listAgentWorkflows(controller.signal), listWorkflowAgentSources(controller.signal)])
      .then(([savedResult, sourcesResult]) => {
        if (savedResult.status === 'fulfilled') {
          setWorkflows(savedResult.value);
          if (savedResult.value[0]) openSavedWorkflow(savedResult.value[0]);
          else setDirty(true);
        } else if (!controller.signal.aborted) {
          setError(userFacingError(savedResult.reason, 'Agent Nexus 列表读取失败。'));
          setDirty(true);
        }
        if (sourcesResult.status === 'fulfilled') {
          setBuiltinAgents(sourcesResult.value.builtin);
          setPlatformAgents(sourcesResult.value.platform);
          setTools(sourcesResult.value.tools);
        } else if (!controller.signal.aborted && savedResult.status === 'fulfilled') {
          setError(userFacingError(sourcesResult.reason, 'Agent 能力列表读取失败。'));
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const container = messagesScrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, runActivity]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setInspectorOpen(false);
        setNexusSettingsOpen(false);
        setNexusDeleteConfirm(false);
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      removeSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const selectedNode = selection?.type === 'node' ? canvas.nodes.find((node) => node.id === selection.id) ?? null : null;
  const selectedEdge = selection?.type === 'edge' ? canvas.edges.find((edge) => edge.id === selection.id) ?? null : null;

  function openSavedWorkflow(workflow: SavedAgentWorkflow) {
    setWorkflowId(workflow.id);
    setName(nexusDisplayName(workflow.name));
    setDescription(workflow.description);
    setVisibility(workflow.visibility);
    setCanvas(workflow.definition.workflow);
    setPan({ x: workflow.definition.workflow.viewport?.x ?? 0, y: workflow.definition.workflow.viewport?.y ?? 0 });
    setZoom(workflow.definition.workflow.viewport?.zoom ?? 1);
    setSelection(null);
    setConnectingFrom(null);
    setIssues([]);
    setMessages([]);
    setNodeStatuses({});
    setRunActivity('Agent Nexus 待命');
    setInspectorOpen(false);
    setNexusSettingsOpen(false);
    setNexusDeleteConfirm(false);
    setReleaseCenterOpen(false);
    setDirty(false);
    setError(null);
  }

  const createNewWorkflow = () => {
    if (runningTaskId) return;
    const next = defaultCanvas();
    setWorkflowId(null);
    setName('新的 Agent Nexus');
    setDescription('');
    setVisibility('private');
    setCanvas(next);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setSelection({ type: 'node', id: 'agent-main' });
    setInspectorOpen(false);
    setNexusSettingsOpen(false);
    setNexusDeleteConfirm(false);
    setReleaseCenterOpen(false);
    setMessages([]);
    setIssues([]);
    setNodeStatuses({});
    setDirty(true);
    setError(null);
  };

  const commitCanvas = (updater: (current: WorkflowCanvas) => WorkflowCanvas) => {
    setCanvas((current) => updater(current));
    setDirty(true);
    setIssues([]);
  };

  const addAgentNode = (source: 'builtin' | 'platform' | 'workflow', agent: BuiltinWorkflowAgent | UserDefinedAgent | WorkflowScopedAgent) => {
    const isBuiltin = source === 'builtin';
    const isPlatform = source === 'platform';
    const label = isBuiltin
      ? (agent as BuiltinWorkflowAgent).label
      : isPlatform
        ? (agent as UserDefinedAgent).name
        : (agent as WorkflowScopedAgent).name;
    const id = isBuiltin ? (agent as BuiltinWorkflowAgent).id : agent.id;
    const descriptionText = agent.description || (isPlatform ? (agent as UserDefinedAgent).definition.whenToUseHint : '');
    const nodeId = makeId('agent');
    const count = canvas.nodes.filter((node) => node.type === 'agent').length;
    const platform = isPlatform ? agent as UserDefinedAgent : null;
    const scoped = source === 'workflow' ? agent as WorkflowScopedAgent : null;
    const node: WorkflowCanvasNode = {
      id: nodeId,
      type: 'agent',
      name: label,
      description: descriptionText,
      position: { x: 330 + (count % 3) * 250, y: 130 + Math.floor(count / 3) * 160 },
      agentRef: { source, id },
      objective: descriptionText || `完成“${label}”Agent 的工作，并把结果交给下一位 Agent。`,
      acceptanceCriteria: ['输出完整并可供下游 Agent 使用。'],
      toolNames: platform?.definition.toolAllowlist ?? scoped?.toolAllowlist ?? [],
      icon: scoped?.icon || iconForIdentity(`${id} ${label}`),
      ...(platform?.definition.defaultModel || scoped?.model ? { model: platform?.definition.defaultModel ?? scoped?.model } : {}),
      failureStrategy: platform?.definition.failureStrategyDefault ?? scoped?.failureStrategy ?? 'retry',
    };
    commitCanvas((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelection({ type: 'node', id: nodeId });
    setInspectorOpen(true);
  };

  const createScopedAgent = () => {
    if (!scopedDraft.name.trim() || !scopedDraft.roleId.trim() || !scopedDraft.prompt.trim()) return;
    const normalizedRole = scopedDraft.roleId.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    if (!/^[a-zA-Z]/.test(normalizedRole)) {
      setError('私有 Agent 的角色 ID 必须以英文字母开头。');
      return;
    }
    const scoped: WorkflowScopedAgent = {
      id: makeId('scoped'),
      roleId: normalizedRole.slice(0, 64),
      name: scopedDraft.name.trim(),
      description: '',
      systemPromptTemplate: scopedDraft.prompt.trim(),
      toolAllowlist: scopedDraft.tools.split(',').map((item) => item.trim()).filter(Boolean),
      failureStrategy: 'retry',
      icon: '🧩',
    };
    commitCanvas((current) => ({ ...current, scopedAgents: [...current.scopedAgents, scoped] }));
    setScopedDraft({ name: '', roleId: '', prompt: '', tools: '' });
    setShowScopedAgentForm(false);
    addAgentNode('workflow', scoped);
  };

  const updateNode = (nodeId: string, patch: Partial<WorkflowCanvasNode>) => {
    commitCanvas((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node) }));
  };

  const connectTo = (targetId: string) => {
    if (!connectingFrom || connectingFrom === targetId) return;
    const source = canvas.nodes.find((node) => node.id === connectingFrom);
    const target = canvas.nodes.find((node) => node.id === targetId);
    if (!source || !target) return;
    if (edgeMode === 'flow' && (source.type === 'output' || target.type === 'input')) {
      setError('普通连接只能从输入或 Agent 连到 Agent 或输出。');
      setConnectingFrom(null);
      return;
    }
    if (edgeMode === 'loop' && (source.type !== 'agent' || target.type !== 'agent')) {
      setError('Loop 回边只能连接两位 Agent。');
      setConnectingFrom(null);
      return;
    }
    const exists = canvas.edges.some((edge) => edge.source === connectingFrom && edge.target === targetId && edge.kind === edgeMode);
    if (!exists) {
      const edge: WorkflowCanvasEdge = {
        id: makeId(edgeMode === 'loop' ? 'loop' : 'edge'),
        source: connectingFrom,
        target: targetId,
        kind: edgeMode,
        ...(edgeMode === 'loop' ? { maxIterations: 2 } : {}),
      };
      commitCanvas((current) => ({ ...current, edges: [...current.edges, edge] }));
      setSelection({ type: 'edge', id: edge.id });
      setInspectorOpen(true);
    }
    setConnectingFrom(null);
  };

  function removeSelection() {
    if (!selection) return;
    if (selection.type === 'edge') {
      commitCanvas((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== selection.id) }));
      setSelection(null);
      setInspectorOpen(false);
      return;
    }
    const node = canvas.nodes.find((candidate) => candidate.id === selection.id);
    if (!node || node.type !== 'agent') return;
    commitCanvas((current) => ({
      ...current,
      nodes: current.nodes.filter((candidate) => candidate.id !== node.id),
      edges: current.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id),
    }));
    setSelection(null);
    setInspectorOpen(false);
  }

  const onNodePointerDown = (event: ReactPointerEvent<HTMLDivElement>, node: WorkflowCanvasNode) => {
    if ((event.target as HTMLElement).closest('button')) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragMovedRef.current = false;
    dragRef.current = { kind: 'node', id: node.id, startX: event.clientX, startY: event.clientY, originX: node.position.x, originY: node.position.y };
    setSelection({ type: 'node', id: node.id });
  };

  const onNodePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.kind !== 'node' || !drag.id) return;
    if (event.clientX !== drag.startX || event.clientY !== drag.startY) dragMovedRef.current = true;
    const x = drag.originX + (event.clientX - drag.startX) / zoom;
    const y = drag.originY + (event.clientY - drag.startY) / zoom;
    setCanvas((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === drag.id ? { ...node, position: { x: Math.round(x), y: Math.round(y) } } : node) }));
    setDirty(true);
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && (event.target as HTMLElement).closest('.workflow-world')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y };
    setSelection(null);
    setInspectorOpen(false);
    setConnectingFrom(null);
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.kind !== 'pan') return;
    setPan({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
  };

  const stopDragging = () => {
    dragRef.current = null;
    window.setTimeout(() => { dragMovedRef.current = false; }, 0);
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const next = Math.min(1.6, Math.max(0.45, zoom - event.deltaY * 0.001));
    setZoom(Number(next.toFixed(2)));
  };
  const resetViewport = () => { setPan({ x: 0, y: 0 }); setZoom(1); };

  const canvasWithViewport = useMemo(() => ({ ...canvas, viewport: { x: pan.x, y: pan.y, zoom } }), [canvas, pan.x, pan.y, zoom]);

  const save = async () => {
    if (!name.trim()) { setError('请先填写 Agent Nexus 名称。'); return null; }
    setBusy(true);
    setError(null);
    try {
      const workflow = await saveAgentWorkflow({ id: workflowId ?? undefined, name: name.trim(), description: description.trim(), visibility, canvas: canvasWithViewport });
      setWorkflowId(workflow.id);
      setCanvas(workflow.definition.workflow);
      setDirty(false);
      setIssues([]);
      await refresh();
      window.dispatchEvent(new CustomEvent('axiom:task-catalog-mutated', { detail: { workflowId: workflow.id, kind: 'workflow-updated' } }));
      return workflow;
    } catch (caught) {
      const withIssues = caught as Error & { issues?: WorkflowValidationIssue[] };
      setIssues(withIssues.issues ?? []);
      setError(userFacingError(caught, 'Agent Nexus 保存失败。'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const validate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await validateAgentWorkflow(canvasWithViewport);
      setIssues(result.issues);
      if (result.valid) setRunActivity('校验通过，可以执行');
    } catch (caught) {
      setError(userFacingError(caught, 'Agent Nexus 校验失败。'));
    } finally {
      setBusy(false);
    }
  };

  const removeWorkflow = async () => {
    if (!workflowId || runningTaskId) return;
    setBusy(true);
    try {
      const deletedWorkflowId = workflowId;
      await deleteAgentWorkflow(deletedWorkflowId);
      window.dispatchEvent(new CustomEvent('axiom:task-catalog-mutated', { detail: { workflowId: deletedWorkflowId, kind: 'workflow-deleted' } }));
      const remaining = await refresh();
      if (remaining[0]) openSavedWorkflow(remaining[0]);
      else createNewWorkflow();
    } catch (caught) {
      setError(userFacingError(caught, 'Agent Nexus 删除失败。'));
    } finally {
      setBusy(false);
    }
  };

  const saveInspector = async () => {
    if (dirty) {
      const saved = await save();
      if (!saved) return;
    }
    setInspectorOpen(false);
  };

  const saveNexusSettings = async () => {
    const saved = await save();
    if (saved) setNexusSettingsOpen(false);
  };

  const openReleaseCenter = async () => {
    let targetId = workflowId;
    if (dirty || !targetId) targetId = (await save())?.id ?? null;
    if (!targetId) return;
    setReleaseCenterOpen(true);
    setBusy(true);
    try { await refreshReleaseCenter(targetId); }
    catch (caught) { setError(userFacingError(caught, 'Nexus 发布中心读取失败。')); }
    finally { setBusy(false); }
  };

  const addNexusTest = async () => {
    if (!workflowId || !testDraft.name.trim() || !testDraft.input.trim()) return;
    setBusy(true); setError(null);
    try {
      await createNexusTest(workflowId, { name: testDraft.name.trim(), input: testDraft.input.trim(), expectedIncludes: testDraft.expected.split('\n').map((item) => item.trim()).filter(Boolean) });
      setTestDraft({ name: '', input: '', expected: '' });
      await refreshReleaseCenter(workflowId);
    } catch (caught) { setError(userFacingError(caught, '测试用例保存失败。')); }
    finally { setBusy(false); }
  };

  const executeNexusTests = async () => {
    if (!workflowId) return;
    setBusy(true); setError(null);
    try {
      const result = await runNexusTests(workflowId);
      setRunActivity(`正在运行 ${result.runs.length} 个真实测试任务`);
      const finalRuns = await waitForNexusTestRuns(workflowId, result.runs.map((run) => run.id), {
        onUpdate: (runs) => {
          setNexusTestRuns((current) => [...runs, ...current.filter((candidate) => !runs.some((run) => run.id === candidate.id))]);
          setRunActivity(`Nexus 测试 ${runs.filter((run) => run.status !== 'running').length}/${result.runs.length}`);
        },
      });
      const failed = finalRuns.filter((run) => run.status !== 'passed').length;
      setRunActivity(failed ? `${failed} 个测试未通过` : `${finalRuns.length} 个测试全部通过`);
      await refreshReleaseCenter(workflowId);
    } catch (caught) { setError(userFacingError(caught, 'Nexus 测试启动失败。')); }
    finally { setBusy(false); }
  };

  const publishCurrentNexus = async () => {
    if (!workflowId || dirty) { setError('请先保存当前草稿，再发布固定版本。'); return; }
    setBusy(true); setError(null);
    try {
      const result = await publishNexus(workflowId, releaseNote.trim());
      setReleaseNote('');
      setRunActivity(result.idempotent ? '当前版本已经发布' : `Nexus v${result.workflow.version} 已发布`);
      await Promise.all([refresh(), refreshReleaseCenter(workflowId)]);
    } catch (caught) { setError(userFacingError(caught, 'Nexus 发布失败。')); }
    finally { setBusy(false); }
  };

  const restoreRelease = async (releaseId: string) => {
    if (!workflowId) return;
    setBusy(true); setError(null);
    try {
      const workflow = await restoreNexusRelease(workflowId, releaseId);
      openSavedWorkflow(workflow);
      setReleaseCenterOpen(true);
      setRunActivity('已恢复为新草稿，生产版本保持不变');
      await refreshReleaseCenter(workflow.id);
    } catch (caught) { setError(userFacingError(caught, 'Nexus 版本恢复失败。')); }
    finally { setBusy(false); }
  };

  const makeWorkflowPlugin = async () => {
    if (!workflowId) return;
    setBusy(true); setError(null);
    try {
      const result = await createNexusWorkflowPlugin(workflowId);
      setRunActivity(`Workflow Plugin“${result.plugin.name}”已发布`);
    } catch (caught) { setError(userFacingError(caught, 'Workflow Plugin 生成失败。')); }
    finally { setBusy(false); }
  };

  const uploadArtifact = async (files: FileList | null) => {
    if (!workflowId || !files?.[0]) return;
    setBusy(true); setError(null);
    try { await uploadNexusArtifact(workflowId, files[0]); await refreshReleaseCenter(workflowId); }
    catch (caught) { setError(userFacingError(caught, 'Nexus 附件上传失败。')); }
    finally { setBusy(false); }
  };

  const linkArtifact = async () => {
    if (!workflowId || !selectedReusableArtifactId) return;
    setBusy(true); setError(null);
    try {
      const artifact = reusableArtifacts.find((candidate) => candidate.id === selectedReusableArtifactId);
      const result = await linkNexusArtifact(workflowId, selectedReusableArtifactId, artifact?.id);
      setRunActivity(result.idempotent ? '该 Artifact 已在当前 Nexus 中' : '已绑定已有 Artifact');
      setSelectedReusableArtifactId('');
      await refreshReleaseCenter(workflowId);
    } catch (caught) { setError(userFacingError(caught, 'Nexus Artifact 绑定失败。')); }
    finally { setBusy(false); }
  };

  const compareRelease = async (leftId: string, rightId: string) => {
    if (!workflowId) return;
    setBusy(true); setError(null);
    try { setReleaseDiff(await compareNexusReleases(workflowId, leftId, rightId)); }
    catch (caught) { setError(userFacingError(caught, 'Nexus 版本差异读取失败。')); }
    finally { setBusy(false); }
  };

  const setAssistantMessage = (id: string, updater: (message: RunnerMessage) => RunnerMessage) => {
    setMessages((current) => current.map((message) => message.id === id ? updater(message) : message));
  };

  const execute = async () => {
    const text = runnerInput.trim();
    if (!text || runningTaskId) return;
    let executableId = workflowId;
    if (dirty || !executableId) {
      const saved = await save();
      executableId = saved?.id ?? null;
    }
    if (!executableId) return;
    const executionSessionId = executableId ? `agent-nexus-${executableId}` : sessionIdRef.current;
    const controller = new AbortController();
    runControllerRef.current = controller;
    let streamedOutput = '';
    const userMessage: RunnerMessage = { id: makeId('message'), role: 'user', content: text };
    const assistantId = makeId('message');
    const assistantMessage: RunnerMessage = { id: assistantId, role: 'assistant', content: '', pending: true };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setRunnerInput('');
    setNodeStatuses({});
    setRunActivity('调度器正在启动 Agent Nexus');
    setError(null);
    try {
      const contextResult = buildConversationContext([...messages, userMessage]);
      if (contextResult.summaryApplied) {
        setRunActivity(`已整理最早的 ${contextResult.summarizedMessages} 条消息，正在继续执行 Agent Nexus`);
      }
      const nexusInput = contextResult.messages
        .map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${message.content}`)
        .join('\n\n');
      const task = await runAgentWorkflow({ workflowId: executableId, sessionId: executionSessionId, text: nexusInput, signal: controller.signal });
      setRunningTaskId(task.id);
      await streamWorkflowEvents(task.id, controller.signal, (event) => {
        const stepId = typeof event.payload.stepId === 'string' ? baseStepId(event.payload.stepId) : null;
        if (stepId && ['agent.spawned', 'agent.assigned'].includes(event.type)) setNodeStatuses((current) => ({ ...current, [stepId]: 'queued' }));
        if (stepId && event.type === 'agent.started') {
          setNodeStatuses((current) => ({ ...current, [stepId]: 'running' }));
          setRunActivity(`${String(event.payload.agentName ?? event.payload.title ?? 'Agent')}正在执行`);
        }
        if (stepId && event.type === 'agent.completed') setNodeStatuses((current) => ({ ...current, [stepId]: 'completed' }));
        if (stepId && event.type === 'agent.failed') setNodeStatuses((current) => ({ ...current, [stepId]: 'failed' }));
        if (event.type === 'loop.iteration' && event.payload.scope === 'workflow-loop') {
          setRunActivity(`Loop 第 ${Number(event.payload.iteration ?? 1)} / ${Number(event.payload.maxIterations ?? 1)} 轮`);
        }
        if (event.type === 'model.delta' && event.payload.stage === 'synthesizer') {
          if (event.payload.reset === true) {
            streamedOutput = '';
            setAssistantMessage(assistantId, (message) => ({ ...message, content: '' }));
          }
          const content = typeof event.payload.content === 'string' ? event.payload.content : '';
          if (content) {
            streamedOutput += content;
            setAssistantMessage(assistantId, (message) => ({ ...message, content: `${message.content}${content}` }));
          }
          setRunActivity('汇总 Agent 正在生成 Nexus 输出');
        }
        if (event.type === 'review.started') setRunActivity('质量检查正在进行');
      });
      const completed = await getWorkflowTask(task.id, controller.signal);
      setAssistantMessage(assistantId, (message) => ({ ...message, content: completed.result || streamedOutput || completed.error || 'Agent Nexus 已结束，但没有返回内容。', pending: false }));
      setRunActivity(completed.status === 'completed' ? 'Agent Nexus 执行完成' : `Agent Nexus 已${completed.status}`);
    } catch (caught) {
      if (controller.signal.aborted) {
        setAssistantMessage(assistantId, (message) => ({ ...message, content: message.content || '本次 Agent Nexus 已停止。', pending: false }));
        setRunActivity('Agent Nexus 已停止');
      } else {
        const message = userFacingError(caught, 'Agent Nexus 执行失败。');
        setAssistantMessage(assistantId, (current) => ({ ...current, content: current.content || message, pending: false }));
        setError(message);
        setRunActivity('Agent Nexus 执行失败');
      }
    } finally {
      setRunningTaskId(null);
      runControllerRef.current = null;
    }
  };

  const stop = async () => {
    if (!runningTaskId) return;
    await cancelWorkflowTask(runningTaskId).catch(() => undefined);
    runControllerRef.current?.abort();
  };

  return <div className="dash-workflow-studio">
    <header className="workflow-studio-header">
      <div className="workflow-title-block">
        <span className="workflow-title-icon"><Workflow size={18} /></span>
        <div><small>Agent Nexus · 智能体枢纽</small><div className="workflow-name-row">{dirty && <i role="status" aria-label="存在未保存更改" title="存在未保存更改" />}<input aria-label="Agent Nexus 名称" value={name} onChange={(event) => { setName(event.target.value); setDirty(true); }} /></div></div>
      </div>
      <div className="workflow-header-actions">
        <button type="button" onClick={createNewWorkflow}><Plus size={15} />新建</button>
        <button type="button" onClick={() => void validate()} disabled={busy}><Check size={15} />校验</button>
        <button type="button" onClick={() => void openReleaseCenter()} disabled={busy}><Rocket size={15} />测试与发布</button>
        <button type="button" aria-label="Nexus 设置" title="Nexus 设置" onClick={() => { setNexusDeleteConfirm(false); setNexusSettingsOpen(true); }}><Settings2 size={15} />设置</button>
        <button type="button" className="primary" onClick={() => void save()} disabled={busy || !dirty}><Save size={15} />{busy ? '保存中' : '保存'}</button>
      </div>
    </header>

    {error && <div className="workflow-error"><AlertCircle size={15} /><span>{error}</span><button type="button" aria-label="关闭错误" onClick={() => setError(null)}><X size={14} /></button></div>}

    <div className="workflow-studio-grid">
      <aside className="workflow-library glass-panel">
        <section className="workflow-library-section saved">
          <div className="workflow-pane-title"><span>Agent Nexus</span><em>{workflows.length}</em></div>
          <div className="workflow-saved-list">
            {workflows.map((workflow) => <button type="button" key={workflow.id} className={workflow.id === workflowId ? 'active' : ''} onClick={() => openSavedWorkflow(workflow)}>
              <span><Workflow size={14} /><strong>{nexusDisplayName(workflow.name)}</strong></span><small>v{workflow.version}</small>
            </button>)}
            {workflows.length === 0 && <p>尚未保存 Agent Nexus</p>}
          </div>
        </section>
        <section className="workflow-library-section agents">
          <div className="workflow-pane-title"><span>平台 Agent</span></div>
          <div className="workflow-agent-list">
            {builtinAgents.map((agent) => <button type="button" key={`builtin-${agent.id}`} disabled={agent.available === false} title={agent.unavailableReason} onClick={() => addAgentNode('builtin', agent)}>
               <span className={`workflow-agent-source kind-${agent.kind}`}><b className="workflow-agent-emoji" aria-hidden="true">{iconForIdentity(`${agent.id} ${agent.label}`)}</b></span><span><strong>{agent.label}</strong><small>{agent.available === false ? agent.unavailableReason : agent.description}</small></span>{agent.available === false ? <AlertCircle size={13} /> : <Plus size={13} />}
            </button>)}
            {platformAgents.map((agent) => <button type="button" key={`platform-${agent.id}`} onClick={() => addAgentNode('platform', agent)}>
               <span className="workflow-agent-source custom"><b className="workflow-agent-emoji" aria-hidden="true">{iconForIdentity(`${agent.roleId} ${agent.name}`)}</b></span><span><strong>{agent.name}</strong><small>{agent.description || agent.definition.whenToUseHint}</small></span><Plus size={13} />
            </button>)}
          </div>
        </section>
        <section className="workflow-library-section scoped">
          <div className="workflow-pane-title"><span>仅此 Nexus</span><button type="button" aria-label="创建 Nexus 私有 Agent" onClick={() => setShowScopedAgentForm((value) => !value)}><Plus size={14} /></button></div>
          {showScopedAgentForm && <div className="workflow-scoped-form">
            <input value={scopedDraft.name} onChange={(event) => setScopedDraft((value) => ({ ...value, name: event.target.value }))} placeholder="Agent 名称" />
            <input value={scopedDraft.roleId} onChange={(event) => setScopedDraft((value) => ({ ...value, roleId: event.target.value }))} placeholder="角色 ID，如 prompt-designer" />
            <textarea rows={3} value={scopedDraft.prompt} onChange={(event) => setScopedDraft((value) => ({ ...value, prompt: event.target.value }))} placeholder="系统提示词" />
            <input value={scopedDraft.tools} onChange={(event) => setScopedDraft((value) => ({ ...value, tools: event.target.value }))} placeholder="工具名，逗号分隔" />
            <button type="button" className="primary" onClick={createScopedAgent}>创建并加入画布</button>
          </div>}
          <div className="workflow-scoped-list">{canvas.scopedAgents.map((agent) => <button type="button" key={agent.id} onClick={() => addAgentNode('workflow', agent)}><b className="workflow-agent-emoji" aria-hidden="true">{agent.icon || '🧩'}</b><span>{agent.name}</span><Plus size={12} /></button>)}</div>
        </section>
      </aside>

      <section className="workflow-canvas-shell glass-panel">
        <div className="workflow-canvas-toolbar">
          <div className="workflow-edge-mode" aria-label="连线类型">
            <button type="button" className={edgeMode === 'flow' ? 'active' : ''} onClick={() => { setEdgeMode('flow'); setConnectingFrom(null); }}><Link2 size={13} />普通连线</button>
            <button type="button" className={edgeMode === 'loop' ? 'active loop' : ''} onClick={() => { setEdgeMode('loop'); setConnectingFrom(null); }}><RotateCcw size={13} />Loop 回边</button>
          </div>
          <span className={connectingFrom ? 'connecting' : ''}>{connectingFrom ? '选择目标端口' : `${canvas.nodes.filter((node) => node.type === 'agent').length} 个 Agent · ${canvas.edges.length} 条连接`}</span>
          <div className="workflow-zoom-controls">
            <button type="button" aria-label="缩小" onClick={() => setZoom((value) => Math.max(.45, Number((value - .1).toFixed(2))))}><ZoomOut size={14} /></button>
            <em>{Math.round(zoom * 100)}%</em>
            <button type="button" aria-label="放大" onClick={() => setZoom((value) => Math.min(1.6, Number((value + .1).toFixed(2))))}><ZoomIn size={14} /></button>
            <button type="button" aria-label="重置画布" onClick={resetViewport}><Maximize2 size={14} /></button>
          </div>
        </div>
        <div className="workflow-canvas" onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={stopDragging} onPointerCancel={stopDragging} onWheel={onWheel}>
          <div className="workflow-grid-field" />
          <div className="workflow-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <svg className="workflow-edges" width="1800" height="1100" viewBox="0 0 1800 1100" aria-label="Agent Nexus 连线">
              <defs>
                <marker id="workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
                <marker id="workflow-loop-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
              </defs>
              {canvas.edges.map((edge) => {
                const source = canvas.nodes.find((node) => node.id === edge.source);
                const target = canvas.nodes.find((node) => node.id === edge.target);
                if (!source || !target) return null;
                const d = edgePath(source, target, edge.kind);
                return <g key={edge.id} data-source={source.id} data-target={target.id} className={`workflow-edge ${edge.kind} ${selection?.type === 'edge' && selection.id === edge.id ? 'selected' : ''}`} onPointerDown={(event) => { event.stopPropagation(); setSelection({ type: 'edge', id: edge.id }); }} onClick={() => setInspectorOpen(true)}>
                  <path className="hit" d={d} />
                  <path className="line" d={d} markerEnd={`url(#workflow-${edge.kind === 'loop' ? 'loop-' : ''}arrow)`} />
                   {edge.kind === 'loop' && <text x={(source.position.x + nodeDimensions(source).width + target.position.x) / 2} y={Math.min(source.position.y, target.position.y) - 65}>Loop × {edge.maxIterations ?? 2}</text>}
                </g>;
              })}
            </svg>
            {canvas.nodes.map((node) => {
              const status = nodeStatuses[node.id];
              const selected = selection?.type === 'node' && selection.id === node.id;
              const sourceName = node.agentRef?.source === 'workflow' ? '私有' : node.agentRef?.source === 'platform' ? '平台' : '内置';
              return <div
                key={node.id}
                data-node-id={node.id}
                className={`workflow-node type-${node.type} ${selected ? 'selected' : ''} ${status ? `status-${status}` : ''}`}
                style={{ transform: `translate(${node.position.x}px, ${node.position.y}px)` }}
                onPointerDown={(event) => onNodePointerDown(event, node)}
                onPointerMove={onNodePointerMove}
                onPointerUp={stopDragging}
                onPointerCancel={stopDragging}
                onClick={(event) => {
                  if (dragMovedRef.current || (event.target as HTMLElement).closest('button')) return;
                  setInspectorOpen(true);
                }}
              >
                {node.type !== 'input' && <button type="button" className={`workflow-port input ${connectingFrom ? 'ready' : ''}`} aria-label={`连接到 ${node.name}`} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => { event.stopPropagation(); if (connectingFrom) connectTo(node.id); }} onClick={() => connectTo(node.id)} />}
                <div className="workflow-node-head"><span>{node.type === 'agent' ? <b className="workflow-agent-emoji" aria-hidden="true">{agentIcon(node)}</b> : node.type === 'input' ? <MessageSquareText size={14} /> : <ChevronRight size={14} />}{nodeTone[node.type]}</span>{status && <em>{status === 'running' ? <LoaderCircle className="spin" size={12} /> : status === 'completed' ? <Check size={12} /> : status === 'failed' ? <AlertCircle size={12} /> : <Circle size={10} />}{statusLabel[status]}</em>}</div>
                <strong>{node.name}</strong>
                {node.type === 'agent' && <small>{sourceName} Agent</small>}
                {node.type !== 'output' && <button type="button" className={`workflow-port output ${connectingFrom === node.id ? 'active' : ''}`} aria-label={`从 ${node.name} 开始连线`} onPointerDown={(event) => event.stopPropagation()} onClick={() => setConnectingFrom((current) => current === node.id ? null : node.id)} />}
              </div>;
            })}
          </div>
        </div>
      </section>

      {inspectorOpen && selection && (selectedNode || selectedEdge) && <div className="workflow-inspector-modal" role="dialog" aria-modal="true" aria-label={selectedNode?.type === 'agent' ? 'Agent 设置' : selectedNode ? 'Nexus 端点设置' : '连接设置'} onPointerDown={(event) => { if (event.target === event.currentTarget) setInspectorOpen(false); }}>
        <aside className="workflow-inspector-modal-panel workflow-inspector glass-panel" onPointerDown={(event) => event.stopPropagation()}>
          <div className="workflow-inspector-modal-header"><div className="workflow-pane-title"><span>{selectedNode?.type === 'agent' ? 'Agent 设置' : selectedNode ? 'Nexus 端点设置' : '连接设置'}</span>{selection && <button type="button" aria-label="移除当前选择" onClick={removeSelection} disabled={selectedNode?.type !== 'agent' && !selectedEdge}><Trash2 size={14} /></button>}</div><button type="button" className="workflow-inspector-close" aria-label="关闭设置" onClick={() => setInspectorOpen(false)}><X size={16} /></button></div>
          {selectedNode ? <div className="workflow-inspector-form">
            <label><span>名称</span><input value={selectedNode.name} onChange={(event) => updateNode(selectedNode.id, { name: event.target.value })} /></label>
            {selectedNode.type === 'agent' && <>
              <label><span>Agent 目标</span><textarea rows={4} value={selectedNode.objective ?? ''} onChange={(event) => updateNode(selectedNode.id, { objective: event.target.value })} /></label>
              <div className="workflow-agent-auto-settings"><Sparkles size={14} /><span>执行参数由 AXIOM 自动安排，失败时会自动恢复。</span></div>
              {tools.length > 0 && <div className="workflow-tool-picker"><span>Agent 能力</span>{tools.map((tool) => {
                const checked = selectedNode.toolNames?.includes(tool.name) ?? false;
                const presentation = toolPresentation[tool.name] ?? { label: tool.name, description: tool.description };
                return <div key={tool.name} className="workflow-tool-item"><label title={presentation.description}><input type="checkbox" checked={checked} onChange={() => updateNode(selectedNode.id, { toolNames: checked ? (selectedNode.toolNames ?? []).filter((name) => name !== tool.name) : [...(selectedNode.toolNames ?? []), tool.name] })} /><span>{presentation.label}</span></label><details><summary>查看</summary><p>{presentation.description}</p></details></div>;
              })}</div>}
            </>}
          </div> : selectedEdge ? <div className="workflow-inspector-form edge">
            <div className={`workflow-edge-kind ${selectedEdge.kind}`}><GitBranch size={16} /><span>{selectedEdge.kind === 'loop' ? '有界 Loop 回边' : '依赖连线'}</span></div>
            {selectedEdge.kind === 'loop' && <label><span>最大执行轮次</span><input type="number" min={2} max={12} value={selectedEdge.maxIterations ?? 2} onChange={(event) => commitCanvas((current) => ({ ...current, edges: current.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, maxIterations: Math.min(12, Math.max(2, Number(event.target.value))) } : edge) }))} /></label>}
            <label><span>传递内容</span><select value={selectedEdge.transfer?.mode ?? 'summary'} onChange={(event) => commitCanvas((current) => ({ ...current, edges: current.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, transfer: { ...edge.transfer, mode: event.target.value as 'summary' | 'full' | 'fields' | 'reference' } } : edge) }))}><option value="summary">结构化摘要</option><option value="full">完整内容</option><option value="fields">指定字段</option><option value="reference">仅 Artifact 引用</option></select></label>
            {(selectedEdge.transfer?.mode ?? 'summary') === 'fields' && <label><span>字段名</span><input value={(selectedEdge.transfer?.fields ?? []).join(', ')} placeholder="summary, risks, actions" onChange={(event) => commitCanvas((current) => ({ ...current, edges: current.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, transfer: { mode: 'fields', fields: event.target.value.split(',').map((field) => field.trim()).filter(Boolean).slice(0, 32) } } : edge) }))} /></label>}
            <p>{canvas.nodes.find((node) => node.id === selectedEdge.source)?.name} <ChevronRight size={13} /> {canvas.nodes.find((node) => node.id === selectedEdge.target)?.name}</p>
          </div> : null}
          {issues.length > 0 && <div className="workflow-issues"><strong>需要处理</strong>{issues.slice(0, 6).map((issue, index) => <button type="button" key={`${issue.code}-${index}`} onClick={() => { if (issue.nodeIds?.[0]) setSelection({ type: 'node', id: issue.nodeIds[0] }); else if (issue.edgeIds?.[0]) setSelection({ type: 'edge', id: issue.edgeIds[0] }); setInspectorOpen(true); }}><AlertCircle size={13} /><span>{issue.message}</span></button>)}</div>}
          <footer className="workflow-inspector-actions"><button type="button" className="primary" disabled={busy} onClick={() => void saveInspector()}><Check size={14} />保存并关闭</button></footer>
        </aside>
      </div>}

      {nexusSettingsOpen && <div className="workflow-inspector-modal" role="dialog" aria-modal="true" aria-label="Nexus 设置" onPointerDown={(event) => { if (event.target === event.currentTarget) setNexusSettingsOpen(false); }}>
        <aside className="workflow-inspector-modal-panel workflow-inspector glass-panel" onPointerDown={(event) => event.stopPropagation()}>
          <div className="workflow-inspector-modal-header"><div className="workflow-pane-title"><span>Nexus 设置</span></div><button type="button" className="workflow-inspector-close" aria-label="关闭 Nexus 设置" onClick={() => setNexusSettingsOpen(false)}><X size={16} /></button></div>
          {!nexusDeleteConfirm ? <>
            <div className="workflow-inspector-form">
              <label><span>Nexus 名称</span><input value={name} onChange={(event) => { setName(event.target.value); setDirty(true); }} /></label>
              <label><span>说明</span><textarea rows={4} value={description} onChange={(event) => { setDescription(event.target.value); setDirty(true); }} placeholder="告诉团队这条 Agent 编排适合处理什么任务" /></label>
              <label><span>可见范围</span><select value={visibility} onChange={(event) => { setVisibility(event.target.value as 'private' | 'team'); setDirty(true); }}><option value="private">仅自己可见</option><option value="team">团队可见</option></select></label>
            </div>
            {workflowId && <button type="button" className="workflow-nexus-delete" onClick={() => setNexusDeleteConfirm(true)}><Trash2 size={14} />删除这个 Nexus</button>}
            <footer className="workflow-inspector-actions"><button type="button" onClick={() => setNexusSettingsOpen(false)}>取消</button><button type="button" className="primary" disabled={busy} onClick={() => void saveNexusSettings()}><Check size={14} />保存并关闭</button></footer>
          </> : <div className="workflow-nexus-delete-confirm">
            <Trash2 size={22} />
            <strong>确定删除这个 Nexus？</strong>
            <p>删除后无法恢复，画布和运行记录也不会再出现在列表中。</p>
            <footer className="workflow-inspector-actions"><button type="button" onClick={() => setNexusDeleteConfirm(false)}>返回设置</button><button type="button" className="danger" disabled={busy} onClick={() => void removeWorkflow()}><Trash2 size={14} />确认删除</button></footer>
          </div>}
        </aside>
      </div>}

      {releaseCenterOpen && workflowId && <div className="workflow-inspector-modal workflow-release-modal" role="dialog" aria-modal="true" aria-label="Nexus 测试与发布" onPointerDown={(event) => { if (event.target === event.currentTarget) setReleaseCenterOpen(false); }}>
        <aside className="workflow-release-panel glass-panel" onPointerDown={(event) => event.stopPropagation()}>
          <header><div><small>固定版本交付</small><h2>测试与发布</h2></div><button type="button" aria-label="关闭" onClick={() => setReleaseCenterOpen(false)}><X size={16} /></button></header>
          <nav>{([['tests', '测试', FlaskConical], ['artifacts', '附件', FileUp], ['releases', '版本', Rocket]] as const).map(([id, label, Icon]) => <button type="button" key={id} className={releaseCenterTab === id ? 'active' : ''} onClick={() => setReleaseCenterTab(id)}><Icon size={14} />{label}</button>)}</nav>
          {releaseCenterTab === 'tests' && <div className="workflow-release-content tests">
            <div className="workflow-test-form"><input value={testDraft.name} onChange={(event) => setTestDraft((current) => ({ ...current, name: event.target.value }))} placeholder="测试名称" /><textarea rows={3} value={testDraft.input} onChange={(event) => setTestDraft((current) => ({ ...current, input: event.target.value }))} placeholder="真实测试输入" /><textarea rows={2} value={testDraft.expected} onChange={(event) => setTestDraft((current) => ({ ...current, expected: event.target.value }))} placeholder="结果必须包含，每行一条" /><button type="button" disabled={busy || !testDraft.name.trim() || !testDraft.input.trim()} onClick={() => void addNexusTest()}><Plus size={13} />添加用例</button></div>
            <div className="workflow-release-list">{nexusTests.map((testCase) => { const latestRun = nexusTestRuns.find((run) => run.data.testCaseId === testCase.id); return <article key={testCase.id}><span><strong>{String(testCase.data.name ?? '测试用例')}</strong><small>{String(testCase.data.input ?? '')}</small></span><em className={latestRun?.status ?? 'draft'}>{latestRun?.status === 'passed' ? '通过' : latestRun?.status === 'failed' ? '未通过' : latestRun?.status === 'running' ? '运行中' : '未运行'}</em></article>; })}{nexusTests.length === 0 && <p>添加至少一个测试用例后才能发布。</p>}</div>
            <button type="button" className="workflow-release-primary" disabled={busy || nexusTests.length === 0} onClick={() => void executeNexusTests()}>{busy ? <LoaderCircle className="spin" size={14} /> : <FlaskConical size={14} />}运行全部测试</button>
          </div>}
          {releaseCenterTab === 'artifacts' && <div className="workflow-release-content artifacts">
            <label className="workflow-artifact-upload"><FileUp size={18} /><span>上传 Nexus 可复用附件<small>单文件不超过 10 MB</small></span><input type="file" onChange={(event) => void uploadArtifact(event.target.files)} /></label>
            <div className="workflow-artifact-link"><select aria-label="选择已有 Artifact" value={selectedReusableArtifactId} onChange={(event) => setSelectedReusableArtifactId(event.target.value)}><option value="">选择任务或工具已生成的 Artifact</option>{reusableArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.id} · {artifact.mimeType ?? '未知类型'} · {artifact.bytes.toLocaleString()} 字节</option>)}</select><button type="button" disabled={busy || !selectedReusableArtifactId} onClick={() => void linkArtifact()}><Link2 size={13} />绑定</button></div>
            <div className="workflow-release-list">{nexusArtifacts.map((artifact) => <article key={artifact.id}><span><strong>{String(artifact.data.name ?? '附件')}</strong><small>{String(artifact.data.mimeType ?? '')} · {Number(artifact.data.bytes ?? 0).toLocaleString()} 字节</small></span><em>{artifact.data.linked ? '已绑定' : `v${String(artifact.data.workflowVersion ?? 1)}`}</em></article>)}{nexusArtifacts.length === 0 && <p>尚未添加附件。</p>}</div>
          </div>}
          {releaseCenterTab === 'releases' && <div className="workflow-release-content releases"><div className="workflow-publish-row"><input value={releaseNote} onChange={(event) => setReleaseNote(event.target.value)} placeholder="本次发布说明（可选）" /><button type="button" disabled={busy || dirty} onClick={() => void publishCurrentNexus()}><Rocket size={13} />发布当前草稿</button></div><div className="workflow-release-list">{nexusReleases.map((release, index) => <article key={release.id}><span><strong>v{String(release.data.workflowVersion ?? '?')}</strong><small>{String(release.data.note || '正式版本')} · {new Date(release.createdAt).toLocaleString('zh-CN')}</small></span><div className="workflow-release-actions">{nexusReleases[index + 1] && <button type="button" disabled={busy} onClick={() => void compareRelease(nexusReleases[index + 1]!.id, release.id)}><GitCompareArrows size={12} />与上一版比较</button>}<button type="button" disabled={busy} onClick={() => void restoreRelease(release.id)}><RotateCcw size={12} />恢复为草稿</button></div></article>)}{nexusReleases.length === 0 && <p>当前还没有正式发布版本。</p>}</div>{releaseDiff && <div className="workflow-release-diff"><header><strong>v{releaseDiff.left.version} → v{releaseDiff.right.version}</strong><span>{releaseDiff.changed ? '存在变更' : '内容一致'}</span><button type="button" aria-label="关闭版本差异" onClick={() => setReleaseDiff(null)}><X size={12} /></button></header><div><span>Agent {releaseDiff.nodeCount.left} → {releaseDiff.nodeCount.right}</span><span>连接 {releaseDiff.edgeCount.left} → {releaseDiff.edgeCount.right}</span><span>步骤 {releaseDiff.stepCount.left} → {releaseDiff.stepCount.right}</span></div><p>新增 {releaseDiff.changes.nodes.added.length + releaseDiff.changes.steps.added.length} · 删除 {releaseDiff.changes.nodes.removed.length + releaseDiff.changes.steps.removed.length} · 修改 {releaseDiff.changes.nodes.changed.length + releaseDiff.changes.steps.changed.length + releaseDiff.changes.edges.changed.length}</p></div>}<button type="button" className="workflow-release-primary secondary" disabled={busy || nexusReleases.length === 0} onClick={() => void makeWorkflowPlugin()}><PackageCheck size={14} />生成 Workflow Plugin</button></div>}
        </aside>
      </div>}

      <section className="workflow-runner glass-panel">
        <header><div><MessageSquareText size={15} /><strong>运行 Agent Nexus</strong></div><span className={runningTaskId ? 'running' : ''}>{runningTaskId && <LoaderCircle className="spin" size={12} />}{runActivity}</span></header>
        <div ref={messagesScrollRef} className="workflow-runner-messages">
           {messages.length === 0 && <div className="workflow-runner-empty"><Workflow size={22} /><strong>输入内容，按当前 Agent 流水线执行</strong><span>Agent 状态、分支和 Loop 轮次会实时显示在画布中。</span></div>}
          {messages.map((message) => <article key={message.id} className={message.role}>
            <span>{message.role === 'user' ? '你' : 'W'}</span>
            <div>{message.pending && !message.content && <p className="workflow-pending"><LoaderCircle className="spin" size={14} />{runActivity}</p>}{message.content && <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>}</div>
          </article>)}
        </div>
        <footer>
          <textarea rows={2} value={runnerInput} disabled={Boolean(runningTaskId)} onChange={(event) => setRunnerInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void execute(); } }} placeholder="向 Agent Nexus 输入内容" />
          <button type="button" className={runningTaskId ? 'stop' : 'send'} aria-label={runningTaskId ? '停止 Agent Nexus' : '运行 Agent Nexus'} disabled={!runningTaskId && !runnerInput.trim()} onClick={() => runningTaskId ? void stop() : void execute()}>{runningTaskId ? <Square size={15} /> : <Send size={15} />}</button>
        </footer>
      </section>
    </div>
  </div>;
}
