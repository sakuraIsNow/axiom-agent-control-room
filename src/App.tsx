import gsap from 'gsap';
import {
  ArrowLeft,
  Activity,
  Bot,
  Box,
  Check,
  ChevronRight,
  ChevronDown,
  CircleStop,
  Cloud,
  Pause,
  Play,
  Copy,
  Cpu,
  Database,
  FileClock,
  Gauge,
  ImagePlus,
  Info,
  KeyRound,
  Layers3,
  MessageSquare,
  Network,
  Puzzle,
  Send,
  Server,
  ShieldCheck,
  Settings2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamAgentResponse } from './lib/agentStream';
import { generateImage, readImageAsDataUrl } from './lib/imageGeneration';
import { approveWorkflowPlan, approveWorkflowReview, approveWorkflowTool, cancelWorkflowTask, controlWorkflowNode, createWorkflowTask, deleteWorkflowTask, getWorkflowArtifact, getWorkflowTask, listWorkflowTasks, pauseWorkflowTask, rejectWorkflowPlan, rejectWorkflowReview, rejectWorkflowTool, replanWorkflowTask, resumeWorkflowTask, retryWorkflowTask, sendTaskNote, streamWorkflowEvents } from './lib/taskRuntime';
import { createTemplateFromCatalog, exportWorkflowTemplate, importWorkflowTemplate, listBuiltInTemplates, listWorkflowTemplates, publishWorkflowTemplate, shareWorkflowTemplate } from './lib/templateRuntime';
import { createPlugin, deletePlugin as deleteUserPluginRequest, listPlugins, runPlugin, streamPluginWithAgent, updatePlugin } from './lib/pluginRuntime';
import { loadUiTheme, type UiTheme } from './lib/uiTheme';
import { agentDisplayName } from './lib/agentPresentation';
import { MiniAppWindow, type MiniAppAgentProgress } from './components/plugins/MiniAppWindow';
import { PluginWorkspace, type PluginShellDraft } from './components/dashboard/PluginWorkspace';
import { TemplateWorkspace } from './components/dashboard/TemplateWorkspace';
import { taskStatusLabels } from './lib/graphPresentation';
import { readinessStateLabel, taskDifficultyLabel, taskKindLabel, taskRouteLabel } from './lib/taskPresentation';
import { userFacingError } from './lib/errorPresentation';
import type {
  AgentMode,
  AgentPhase,
  AgentGraph,
  BudgetConstraint,
  ChatMessage,
  FileAttachment,
  ImageAttachment,
  CollaborationConflict,
  CollaborationMessage,
  ImageRequest,
  ProviderSettings,
  ProviderLocation,
  RunEvent,
  Session,
  TaskProfile,
  BuiltInTemplate,
  WorkflowTemplate,
  WorkflowTask,
  WorkflowTaskStatus,
  WorkflowTaskSummary,
  UserPlugin,
  PluginVisualEffect,
  TopologyAgent,
  Usage,
  WorkflowEvent,
  ToolApproval,
  ToolDescriptor,
} from './types';
import { compactStoredUserMessage, latestUserInput } from './lib/conversationInput';
import { routeChatMessage } from './lib/chatRouting';
import { deleteConversationSession, listConversationSessions, upsertConversationSession, type RemoteSession } from './lib/sessionRuntime';
import { restoreTaskGraph } from './lib/taskGraphRestoration';
import { taskHistoryState } from './lib/taskHistoryState';
import { useDashboardStore } from './lib/useDashboardStore';
import { acceptGraphEventSequence, parseAgentGraph } from './lib/workflowGraphState';
import { buildConversationContext } from './lib/conversationContext';
import { readDashboardUrlState, subscribeDashboardUrlState, writeDashboardUrlState } from './lib/dashboardUrlState';
import { saveProviderCredential, type ProviderCredentialKind } from './lib/providerCredentials';

const STORAGE_KEY = 'axiom-agent-sessions-v1';
const SETTINGS_KEY = 'axiom-provider-settings-v1';
const THEME_KEY = 'axiom-ui-theme-v1';
const AxiomDashboard = lazy(() =>
  import('./components/dashboard/AxiomDashboard').then((module) => ({ default: module.AxiomDashboard })),
);

const pluginVisualEffects: PluginVisualEffect[] = ['aurora', 'plasma', 'liquid', 'prism', 'solar', 'nebula', 'chrome', 'pulse'];
const randomPluginVisual = () => {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return {
    effect: pluginVisualEffects[values[0] % pluginVisualEffects.length],
    hue: values[1] % 360,
    seed: (values[0] % 999_999) + 1,
  };
};
const escapeMiniAppText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const blankMiniAppHtml = (name: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0e0c;color:#ecf3ef;font:16px/1.6 system-ui,sans-serif}.empty{display:grid;justify-items:center;gap:10px;text-align:center}.mark{width:64px;height:64px;border:1px solid #5c6f65;border-radius:18px;display:grid;place-items:center;background:rgba(255,255,255,.04);font-size:28px}.empty strong{font-size:20px}.empty span{color:#91a097}</style></head><body><main class="empty"><div class="mark">+</div><strong>${escapeMiniAppText(name)}</strong><span>在 Axiom 中告诉插件开发 Agent 要实现的功能</span></main></body></html>`;

const modeLabels: Record<AgentMode, string> = {
  analyze: '分析',
  build: '构建',
  decide: '决策',
};

const phaseLabels: Record<AgentPhase, string> = {
  idle: '待命',
  routing: '路由',
  context: '组装上下文',
  inference: '模型推理',
  complete: '完成',
  error: '异常',
};

const routeLabels: Record<string, string> = {
  direct: '直接回答',
  'single-agent': '单 Agent',
  team: '团队协作',
  'full-workflow': '完整工作流',
};

const difficultyLabels: Record<string, string> = {
  trivial: '简单',
  easy: '较易',
  moderate: '中等',
  hard: '困难',
  complex: '复杂',
};

const taskStatusTone = (status: WorkflowTaskStatus) => {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'paused' || status === 'waiting_for_human' || status === 'awaiting_approval') return 'paused';
  if (status === 'running' || status === 'planning' || status === 'reviewing') return 'running';
  return 'queued';
};

const readinessLabels: Record<string, string> = {
  ready: '运行正常',
  degraded: '主要功能可用',
  blocked: '部分功能暂不可用',
};

type ReadinessInfo = {
  state: 'ready' | 'degraded' | 'blocked';
  deployment: 'local-single-node' | 'production-candidate';
  checkedAt: string;
  checks: Array<{ id: string; label: string; state: 'ready' | 'degraded' | 'blocked'; detail: string; required: boolean }>;
  blockers: string[];
  warnings: string[];
  tools?: ToolDescriptor[];
};

const readinessOverview = (info: ReadinessInfo) => {
  const rank = { ready: 0, degraded: 1, blocked: 2 } as const;
  const groups = [
    { id: 'models', label: '模型服务', ids: ['model-provider', 'image-provider', 'video-provider'], ready: '对话和媒体能力可用', degraded: '对话可用，部分媒体未开启', blocked: '模型服务暂时不可用' },
    { id: 'records', label: '任务记录', ids: ['persistence', 'triggers'], ready: '任务和日程会可靠保存', degraded: '本机保存可用', blocked: '任务记录服务异常' },
    { id: 'tools', label: '文件与工具', ids: ['tool-executor', 'object-storage'], ready: '文件和工具可以使用', degraded: '基础文件能力可用', blocked: '安全工具暂不可用' },
    { id: 'memory', label: '长期记忆', ids: ['memory'], ready: '跨任务记忆已开启', degraded: '当前任务不受影响', blocked: '记忆服务暂不可用' },
  ];
  return groups.map((group) => {
    const checks = group.ids.map((id) => info.checks.find((check) => check.id === id)).filter(Boolean) as ReadinessInfo['checks'];
    const state = checks.reduce<ReadinessInfo['state']>((current, check) => rank[check.state] > rank[current] ? check.state : current, 'ready');
    return { id: group.id, label: group.label, state, detail: group[state] };
  });
};

const suggestions = [
  '评估一个 Agent 平台的技术架构',
  '把模糊需求拆成可执行开发计划',
  '审查一个服务的安全和性能风险',
];

const workflowPhase = (event: WorkflowEvent): AgentPhase => {
  if (event.type === 'task.completed') return 'complete';
  if (event.type === 'task.failed' || event.type === 'agent.failed') return 'error';
  if (event.type === 'task.cancelled') return 'idle';
  if (event.type === 'task.paused') return 'idle';
  if (event.type === 'task.resumed') return 'routing';
  if (event.type.startsWith('memory.')) return 'context';
  if (event.type === 'task.created' || event.type === 'task.queued' || event.type === 'task.started' || event.type.startsWith('routing.') || event.type.startsWith('scheduling.')) return 'routing';
  return 'inference';
};

const workflowEventLabel = (event: WorkflowEvent) => {
  const eventAgentName = agentDisplayName(String(event.payload.role ?? event.agentId?.split('-')[0] ?? 'agent'));
  if (event.type === 'task.completed' && event.payload.route === 'direct') return '直接回答已完成';
  if (event.type === 'task.started' && event.payload.intent === 'conversation') return '直接响应已开始';
  if (event.type === 'task.planning' || event.type === 'task.planned') {
    const profile = event.payload.profile as { route?: string; difficulty?: string; kind?: string } | undefined;
    if (profile?.route) {
      return `任务分类：${taskKindLabel(String(profile.kind ?? 'task'))} · ${taskDifficultyLabel(String(profile.difficulty ?? 'unknown'))} · ${taskRouteLabel(String(profile.route ?? 'direct'))}`;
    }
  }
  if (event.type === 'review.completed') {
    const score = Number(event.payload.score);
    return event.payload.approved === true
      ? `审查员通过质量门禁${Number.isFinite(score) ? ` · ${score}/100` : ''}`
      : `审查员驳回并请求修正${Number.isFinite(score) ? ` · ${score}/100` : ''}`;
  }
  const labels: Record<WorkflowEvent['type'], string> = {
    'task.created': '任务已持久化',
    'task.queued': '任务已进入执行队列',
    'task.started': '调度器已接管任务',
    'routing.started': '路由 Agent 正在理解本轮目标',
    'routing.decided': '路由 Agent 已选出候选能力',
    'scheduling.started': '调度 Agent 正在编排本轮路径',
    'scheduling.decided': '调度 Agent 已确定本轮执行路径',
    'harness.connected': 'Harness 控制面已连接',
    'harness.disconnected': 'Harness 控制面已断开',
    'thread.started': '外部 Thread 已启动',
    'thread.resumed': '外部 Thread 已恢复',
    'thread.forked': '外部 Thread 已创建分支',
    'turn.started': 'Harness Turn 已开始',
    'turn.completed': 'Harness Turn 已完成',
    'turn.interrupted': 'Harness Turn 已中断',
    'turn.failed': 'Harness Turn 执行失败',
    'item.started': 'Harness Item 已开始',
    'item.completed': 'Harness Item 已完成',
    'task.planning': '规划器正在拆解任务',
    'task.planned': '工作流计划已生成',
    'plan.approval_requested': '规划器计划正在等待人工批准',
    'plan.approved': '执行计划已批准',
    'plan.rejected': '执行计划已驳回',
    'plan.replanned': '规划器已开始生成新版本计划',
    'graph.updated': 'Agent Graph 已更新',
    'loop.started': '执行循环已启动',
    'loop.iteration': `Loop 第 ${String(event.payload.iteration ?? '')} 轮`,
    'loop.completed': '执行循环已完成',
    'agent.spawned': `已创建${eventAgentName}`,
    'agent.assigned': `已分配步骤给${eventAgentName}`,
    'agent.started': `${eventAgentName}开始执行`,
    'agent.retrying': `${eventAgentName}正在重试第 ${String(event.payload.nextAttempt ?? '')} 次`,
    'agent.completed': `${eventAgentName}已完成`,
    'agent.failed': `${eventAgentName}执行失败`,
    'agent.message': `${eventAgentName}发送了协作消息`,
    'agent.conflict': '并行 Agent 结论出现冲突，等待验证',
    'agent.interrupted': `${eventAgentName}已中断`,
    'agent.resumed': `${eventAgentName}已恢复`,
    'agent.skipped': `${eventAgentName}本轮无需执行`,
    'graph.extended': '会话 Agent Graph 已加入新能力',
    'queue.updated': '智能体队列已更新',
    'approval.requested': 'Harness 操作等待人工批准',
    'approval.resolved': 'Harness 审批已完成',
    'tool.started': `${String(event.payload.name ?? '工具')} 开始执行`,
    'tool.completed': `${String(event.payload.name ?? '工具')} 执行完成`,
    'tool.failed': `${String(event.payload.name ?? '工具')} 执行失败`,
    'tool.approval_requested': `${String(event.payload.name ?? '工具')} 等待人工批准`,
    'tool.approved': `${String(event.payload.name ?? '工具')} 已获人工批准`,
    'tool.rejected': `${String(event.payload.name ?? '工具')} 已拒绝`,
    'node.retry_requested': '节点已请求重试',
    'node.skip_requested': '节点已由操作员跳过',
    'node.completed_manually': '节点已由操作员标记完成',
    'node.rerun_requested': '已从选定节点重新运行',
    'review.started': '审查员开始验证证据树',
    'review.completed': '审查员已完成质量门禁',
    'review.approval_requested': '审查员未通过，等待人工质量决策',
    'review.approved': '操作员已批准当前审查员结果',
    'review.rejected': '操作员已驳回结果，等待重新规划',
    'checkpoint.saved': '运行检查点已持久化',
    'memory.recall.started': '开始召回智能体记忆',
    'memory.recall.completed': '智能体记忆召回完成',
    'memory.capture.started': '正在沉淀本轮长期记忆',
    'memory.capture.completed': '本轮长期记忆已可靠保存',
    'memory.capture.skipped': '本轮记忆无需重复保存',
    'memory.capture.failed': '长期记忆暂未保存，任务结果不受影响',
    'model.delta': `${eventAgentName}正在组织阶段结果`,
    'model.completed': `${eventAgentName}已完成阶段输出`,
    'budget.exceeded': '任务执行预算已达到上限',
    'budget.constrained': '预算接近上限，已压缩并行步骤',
    'human.note': '操作员指令已加入下一轮上下文',
    'artifact.created': '结果 Artifact 已生成',
    'task.completed': '复杂任务工作流已完成',
    'task.failed': '任务在重试后仍然失败',
    'task.cancelled': '任务已取消',
    'task.paused': 'Loop 已暂停，检查点已保存',
    'task.resumed': 'Loop 已恢复，继续处理未完成步骤',
  };
  return labels[event.type];
};

const gatewayAgentActivity = (role: string, eventPhase: AgentPhase, statusMessage = '') => {
  const name = agentDisplayName(role);
  if (/检索|搜索|web_search/i.test(statusMessage)) return `${name}正在检索并核验来源`;
  if (/图片|视觉|Files API/i.test(statusMessage)) return `${name}正在读取图片证据`;
  if (/文档|附件|文件/i.test(statusMessage)) return `${name}正在解析附件内容`;
  if (eventPhase === 'routing') return '路由 Agent 正在识别任务类型';
  if (eventPhase === 'context') return `${name}正在整理上下文`;
  return `${name}正在分析并组织回答`;
};

const makeId = () => crypto.randomUUID();

const readFileAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result ?? ''));
  reader.onerror = () => reject(new Error(`读取文件 ${file.name} 失败。`));
  reader.readAsDataURL(file);
});

const formatTokens = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return '未返回';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
};

const mergeAgentGraphs = (previous: AgentGraph, incoming: AgentGraph, taskId: string): AgentGraph => {
  const nodes = [...previous.nodes];
  const idMap = new Map<string, string>();
  const namespace = `turn-${taskId.slice(0, 8)}-`;
  // Allocate every incoming id first so dependencies can be remapped even
  // when a later node is referenced by an earlier node.
  for (const node of incoming.nodes) {
    if (node.role === 'orchestrator') {
      idMap.set(node.id, nodes.find((item) => item.role === 'orchestrator')?.id ?? node.id);
      continue;
    }
    const existing = nodes.find((item) => item.role === node.role && item.title === node.title);
    if (existing) {
      idMap.set(node.id, existing.id);
      Object.assign(existing, node, { id: existing.id });
      continue;
    }
    let id = `${namespace}${node.id}`;
    let suffix = 2;
    while (nodes.some((item) => item.id === id)) id = `${namespace}${node.id}-${suffix++}`;
    idMap.set(node.id, id);
    nodes.push({ ...node, id, dependsOn: node.dependsOn.map((dependency) => idMap.get(dependency) ?? dependency) });
  }
  // Existing nodes may have been updated before all ids were allocated.
  for (const node of incoming.nodes) {
    const targetId = idMap.get(node.id);
    if (!targetId) continue;
    const target = nodes.find((item) => item.id === targetId);
    if (target) target.dependsOn = node.dependsOn.map((dependency) => idMap.get(dependency) ?? dependency);
  }
  const edges = [...previous.edges];
  for (const edge of incoming.edges) {
    const mapped = { ...edge, from: idMap.get(edge.from) ?? edge.from, to: idMap.get(edge.to) ?? edge.to };
    if (!edges.some((item) => item.from === mapped.from && item.to === mapped.to && item.kind === mapped.kind)) edges.push(mapped);
  }
  const limitedNodes = nodes.length > 32
    ? [nodes.find((node) => node.role === 'orchestrator') ?? nodes[0]!, ...nodes.filter((node) => node.role !== 'orchestrator').slice(-31)]
    : nodes;
  const visibleIds = new Set(limitedNodes.map((node) => node.id));
  return { nodes: limitedNodes, edges: edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)) };
};

const createSession = (): Session => ({
  id: makeId(),
  title: '新任务',
  messages: [],
  updatedAt: Date.now(),
});

const isSessionPersistable = (session: Session) => session.messages.length > 0 || Boolean(session.activeTaskId);
// Agent Nexus keeps its own runner history and task records. Older builds
// projected those runs into regular conversations with workflow-session IDs;
// recognize both generations so a stale projection can never be resurrected.
const isNexusRunSession = (session: Pick<Session, 'id' | 'title'>) => {
  if (session.id.startsWith('agent-nexus-') || session.id.startsWith('workflow-session-') || session.id.startsWith('qa-workflow-session-')) return true;
  const title = session.title.trim();
  return /(?:agent nexus|agent workflow|智能体枢纽)/i.test(title) && /(?:·|•)\s*(?:执行|run)\s*$/i.test(title);
};

const isNexusWorkflowTask = (task: Pick<WorkflowTask, 'templateId' | 'sessionId' | 'title' | 'plan'>) => Boolean(
  task.templateId
  && (
    task.sessionId.startsWith('agent-nexus-')
    || task.sessionId.startsWith('workflow-session-')
    || (task.plan?.profile?.route === 'full-workflow' && /(?:·|•)\s*(?:执行|run)\s*$/i.test(task.title.trim()))
  ),
);

const sanitizeSearchAnswer = (content: string) => {
  if (/^### DeepSeek 原生搜索(?:暂时不可用|未配置)/u.test(content.trim())) {
    return '### 搜索暂时不可用\n\n搜索 Agent 暂时无法取得可靠结果，请稍后重试。';
  }
  return content
    .replace(/\n{2,}>\s*DeepSeek 原生搜索：[^\n]*服务端检索时间：[^\n]*(?=\n|$)/gu, '')
    .replace(/>\s*证据限制：DeepSeek 原生搜索本次未返回可点击来源链接；严格模式未调用其他搜索服务补充。/gu, '> 本次检索未返回可点击来源链接。')
    .trimEnd();
};

const normalizeRestoredSession = (session: Session, preserveActiveRuntime = false): Session => {
  const activeTaskId = preserveActiveRuntime ? session.activeTaskId : undefined;
  const activeAssistantId = activeTaskId ? session.activeAssistantId : undefined;
  return {
    ...session,
    activeTaskId,
    activeAssistantId,
    messages: [...new Map(session.messages.map((message) => {
      const normalized = {
        ...message,
        content: message.role === 'assistant' ? sanitizeSearchAnswer(message.content) : message.content,
        pending: preserveActiveRuntime && message.role === 'assistant' && message.id === activeAssistantId ? Boolean(message.pending) : false,
      };
      return [`${normalized.role}\u0000${normalized.createdAt}\u0000${normalized.content}`, normalized] as const;
    })).values()],
  };
};

const defaultProviderSettings: ProviderSettings = {
  text: { useCustom: false, location: 'internet', apiUrl: '', apiKey: '', model: '' },
  vision: { useCustom: false, location: 'internet', apiUrl: '', apiKey: '', model: '' },
  image: { useCustom: false, location: 'internet', apiUrl: '', apiKey: '', model: '' },
  video: { useCustom: false, location: 'local', apiUrl: '', apiKey: '', model: '' },
};

const inferProviderLocation = (apiUrl: string | undefined, fallback: 'internet' | 'local') => {
  if (!apiUrl?.trim()) return fallback;
  try {
    const hostname = new URL(apiUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname === '::1' || hostname === 'host.docker.internal' || hostname.endsWith('.local')) return 'local' as const;
    if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)) return 'local' as const;
    const match = hostname.match(/^172\.(\d{1,3})\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return 'local' as const;
    return 'internet' as const;
  } catch {
    return fallback;
  }
};

const loadProviderSettings = (): ProviderSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultProviderSettings;
    const parsed = JSON.parse(raw) as Partial<ProviderSettings>;
    const restore = <T extends keyof ProviderSettings>(key: T): ProviderSettings[T] => {
      const saved = parsed[key];
      const defaults = defaultProviderSettings[key];
      return {
        ...defaults,
        ...(saved ?? {}),
        location: saved?.location === 'local' || saved?.location === 'internet'
          ? saved.location
          : inferProviderLocation(saved?.apiUrl, defaults.location),
        apiKey: '',
      } as ProviderSettings[T];
    };
    return { text: restore('text'), vision: restore('vision'), image: restore('image'), video: restore('video') };
  } catch {
    return defaultProviderSettings;
  }
};

const loadSessions = (): Session[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [createSession()];
    const parsed = JSON.parse(raw) as Session[];
    const compacted = parsed.map((session) => normalizeRestoredSession({
      ...session,
      messages: session.messages.map((message) => message.role === 'user'
        ? { ...message, content: compactStoredUserMessage(message.content) }
        : message),
    }));
    const latestById = new Map<string, Session>();
    compacted.forEach((session) => {
      const previous = latestById.get(session.id);
      if (!previous || session.updatedAt >= previous.updatedAt) latestById.set(session.id, session);
    });
    const deduped = [...latestById.values()].filter((session) => !isNexusRunSession(session) && isSessionPersistable(session));
    return deduped.length > 0 ? deduped.sort((a, b) => b.updatedAt - a.updatedAt) : [createSession()];
  } catch {
    return [createSession()];
  }
};

const sessionFromRemote = (remote: RemoteSession): Session => normalizeRestoredSession({
  id: remote.id,
  title: remote.title,
  updatedAt: remote.updatedAt,
  activeTaskId: remote.activeTaskId,
  activeAssistantId: remote.activeAssistantId,
  agentGraph: remote.agentGraph,
  messages: remote.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    pending: message.pending,
    taskId: message.taskId,
    route: message.route,
    agentRole: message.agentRole,
    attachments: message.attachments?.map((attachment) => attachment.kind === 'video'
      ? { id: attachment.id, kind: 'video' as const, url: attachment.url ?? '', alt: attachment.alt ?? attachment.name ?? '视频', mimeType: attachment.mimeType, poster: attachment.poster }
      : attachment.kind === 'file' || !attachment.url ? {
          id: attachment.id,
          kind: 'file' as const,
          name: attachment.name ?? '附件',
          mimeType: attachment.mimeType ?? 'application/octet-stream',
          size: attachment.size ?? 0,
          text: attachment.text,
        }
        : { id: attachment.id, kind: 'image' as const, url: attachment.url, alt: attachment.alt ?? attachment.name ?? '图片' }),
  })),
}, true);

const preferSession = (local: Session, remote: Session) => {
  if (remote.updatedAt > local.updatedAt) return remote;
  if (remote.updatedAt < local.updatedAt) return local;
  return remote.messages.length > local.messages.length ? remote : local;
};

const mergeSessionSnapshots = (local: Session[], remote: RemoteSession[], deletedIds: string[]) => {
  const deleted = new Set(deletedIds);
  const byId = new Map(local.filter((session) => !deleted.has(session.id) && !isNexusRunSession(session)).map((session) => [session.id, session]));
  remote.forEach((item) => {
    if (deleted.has(item.id) || isNexusRunSession(item)) return;
    const next = sessionFromRemote(item);
    const previous = byId.get(next.id);
    if (!previous) {
      byId.set(next.id, next);
      return;
    }
    // Message content may be newer locally, but only the server can confirm
    // whether a durable task is still active. Never let stale local runtime
    // flags resurrect a terminal response as permanently pending.
    const preferred = next.activeTaskId ? next : preferSession(previous, next);
    const remotePending = new Set(next.messages.filter((message) => message.pending).map((message) => message.id));
    byId.set(next.id, {
      ...preferred,
      activeTaskId: next.activeTaskId,
      activeAssistantId: next.activeAssistantId,
      messages: preferred.messages.map((message) => ({
        ...message,
        pending: message.id === next.activeAssistantId && remotePending.has(message.id),
      })),
    });
  });
  return [...byId.values()]
    .filter((session) => !isNexusRunSession(session) && isSessionPersistable(session))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 18);
};

const directDrawingPrompt = (value: string) => /((生成|绘制|画一张|画出|绘图|制作|设计).{0,12}(图片|图像|海报|插画|封面)?|image generation|\bdraw\b)/i.test(value);
const directVideoPrompt = (value: string) => /(?:生成|制作|创建|剪辑|合成).{0,18}(?:视频|短片|动画|影片)|(?:generate|create|make|edit).{0,18}(?:video|movie|clip|animation)/i.test(value);
const directSearchPrompt = (value: string) => /(联网|上网|搜索|查找最新|新闻|网页|资料来源|web search|internet|latest|\bsearch(?:ing)?\b|(?:开源|open[ -]?source).{0,28}(?:agent|搜索|研究|项目|工具|框架)|(?:最新|目前|现在).{0,24}(?:新闻|热点|版本|项目|开源|资料|天气|价格|数据))/i.test(value);
const directWeatherPrompt = (value: string) => /(天气|气温|温度|预报|weather|temperature|forecast)/i.test(value);
const directAgentRole = (session: Session) => {
  const latestUser = [...session.messages].reverse().find((message) => message.role === 'user');
  const latestAssistant = [...session.messages].reverse().find((message) => message.role === 'assistant');
  if (latestAssistant?.agentRole) return latestAssistant.agentRole;
  const text = latestUser?.content ?? '';
  const hasImage = latestUser?.attachments?.some((attachment) => 'url' in attachment) ?? false;
  if (directVideoPrompt(text)) return 'video-agent';
  if (directDrawingPrompt(text)) return 'drawing-agent';
  if (directWeatherPrompt(text)) return 'search-agent';
  if (directSearchPrompt(text)) return 'search-agent';
  if (hasImage) return 'vision-agent';
  return 'direct-responder';
};

const taskAssistantIndex = (session: Session | undefined, task: WorkflowTask) => {
  if (!session) return -1;
  const explicit = session.messages.findIndex((message) => message.role === 'assistant' && message.taskId === task.id);
  if (explicit >= 0) return explicit;
  if (session.activeTaskId === task.id && session.activeAssistantId) {
    const active = session.messages.findIndex((message) => message.id === session.activeAssistantId && message.role === 'assistant');
    if (active >= 0) return active;
  }
  const taskInput = compactStoredUserMessage(latestUserInput(task.input)).trim();
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role !== 'user' || compactStoredUserMessage(message.content).trim() !== taskInput) continue;
    const assistant = session.messages.slice(index + 1).findIndex((candidate) => candidate.role === 'assistant');
    if (assistant >= 0) return index + 1 + assistant;
  }
  return -1;
};

const runtimeTaskIdForSession = (session: Session, catalog: WorkflowTaskSummary[]) => {
  if (session.activeTaskId) return session.activeTaskId;
  const taskMessages = [...session.messages]
    .reverse()
    .filter((message) => message.role === 'assistant' && Boolean(message.taskId));
  const substantive = taskMessages.find((message) => !['direct', 'conversation'].includes(message.route ?? ''));
  if (substantive?.taskId) return substantive.taskId;
  if (taskMessages[0]?.taskId) return taskMessages[0].taskId;
  const sessionTasks = catalog
    .filter((task) => task.sessionId === session.id)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  return sessionTasks.find((task) => task.profile?.route !== 'direct' && task.totalSteps > 0)?.id
    ?? sessionTasks[0]?.id;
};

function ProviderLocationControl({
  value,
  disabled,
  onChange,
}: {
  value: ProviderLocation;
  disabled: boolean;
  onChange: (value: ProviderLocation) => void;
}) {
  return <div className="provider-location-control" aria-label="服务来源">
    <button type="button" className={value === 'internet' ? 'active' : ''} disabled={disabled} aria-pressed={value === 'internet'} onClick={() => onChange('internet')}><Cloud size={13} />互联网 API</button>
    <button type="button" className={value === 'local' ? 'active' : ''} disabled={disabled} aria-pressed={value === 'local'} onClick={() => onChange('local')}><Server size={13} />本地服务</button>
  </div>;
}

function ProviderVaultAction({ kind, name, settings, state, onSave }: {
  kind: ProviderCredentialKind;
  name: string;
  settings: ProviderSettings[ProviderCredentialKind];
  state: 'idle' | 'saving' | 'saved' | 'error';
  onSave: (kind: ProviderCredentialKind, settings: ProviderSettings[ProviderCredentialKind], name: string) => void;
}) {
  const label = state === 'saving' ? '保存中…' : state === 'saved' ? '已安全保存' : state === 'error' ? '重试保存' : settings.credentialId ? '更新安全凭据' : '安全保存凭据';
  return <button
    className={`provider-vault-action ${state}`}
    type="button"
    disabled={!settings.useCustom || state === 'saving' || !settings.apiUrl.trim() || !settings.model.trim()}
    onClick={() => onSave(kind, settings, name)}
    title="API Key 仅加密保存在服务端，不会写入浏览器存储"
  >
    <KeyRound size={13} aria-hidden="true" />
    {label}
  </button>;
}

function App() {
  const [sessions, setSessions] = useState<Session[]>(loadSessions);
  const initialUrlState = useMemo(() => readDashboardUrlState(), []);
  const initialSessionId = initialUrlState.sessionId && sessions.some((session) => session.id === initialUrlState.sessionId)
    ? initialUrlState.sessionId
    : sessions[0]!.id;
  const [activeSessionId, setActiveSessionId] = useState(() => initialSessionId);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(loadProviderSettings);
  const [providerSaveState, setProviderSaveState] = useState<Record<ProviderCredentialKind, 'idle' | 'saving' | 'saved' | 'error'>>({ text: 'idle', vision: 'idle', image: 'idle', video: 'idle' });
  const [providerSaveMessage, setProviderSaveMessage] = useState('');
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => loadUiTheme(THEME_KEY));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [systemPageOpen, setSystemPageOpen] = useState(false);
  const [imageComposerOpen, setImageComposerOpen] = useState(false);
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageMode, setImageMode] = useState<ImageRequest['mode']>('generate');
  const [imageSize, setImageSize] = useState('1024x1024');
  const [imageQuality, setImageQuality] = useState<ImageRequest['quality']>('high');
  const [imageCount, setImageCount] = useState(1);
  const [imageData, setImageData] = useState<string | undefined>();
  const [imageFileName, setImageFileName] = useState('');
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [mode, setMode] = useState<AgentMode>('analyze');
  const [draft, setDraft] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<Array<ImageAttachment | FileAttachment>>([]);
  const [phase, setPhase] = useState<AgentPhase>('idle');
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [collaborationMessages, setCollaborationMessages] = useState<CollaborationMessage[]>([]);
  const [collaborationConflicts, setCollaborationConflicts] = useState<CollaborationConflict[]>([]);
  const [budgetConstraints, setBudgetConstraints] = useState<BudgetConstraint[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [agentActivity, setAgentActivity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<'checking' | 'ready' | 'error'>('checking');
  const [healthInfo, setHealthInfo] = useState<{
    model: string;
    apiBase: string;
    vision: { configured: boolean; model: string; apiBase: string };
    image: { configured: boolean; model: string; apiBase: string };
    video: { configured: boolean; model: string; apiBase: string };
  }>({
    model: 'deepseek-chat',
    apiBase: 'https://api.deepseek.com',
    vision: { configured: false, model: 'deepseek-v4-flash-vision-exp', apiBase: 'https://api.deepseek.com' },
    image: { configured: false, model: 'gpt-image-2-03', apiBase: 'https://www.dmxapi.cn' },
    video: { configured: false, model: '', apiBase: '' },
  });
  const [usage, setUsage] = useState<Usage>({});
  const [durationMs, setDurationMs] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [failedTaskId, setFailedTaskId] = useState<string | null>(null);
  const [taskProfile, setTaskProfile] = useState<TaskProfile | null>(null);
  const [reviewResult, setReviewResult] = useState<{ approved: boolean; score: number; summary: string; gaps: string[]; requiredCorrections: string[] } | null>(null);
  const [catalogCount, setCatalogCount] = useState(6);
  const [topologyAgents, setTopologyAgents] = useState<TopologyAgent[]>([]);
  const [agentGraph, setAgentGraph] = useState<AgentGraph | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [planApproval, setPlanApproval] = useState<{ taskId: string; version: number; summary: string } | null>(null);
  const [reviewApproval, setReviewApproval] = useState<{ taskId: string; score: number; summary: string; gaps: string[]; requiredCorrections: string[] } | null>(null);
  const [toolApproval, setToolApproval] = useState<{ taskId: string; approval: ToolApproval } | null>(null);
  const [nodeActionBusy, setNodeActionBusy] = useState(false);
  const [loopState, setLoopState] = useState({ id: '', iteration: 0, maxIterations: 0, readySteps: [] as string[], completedSteps: [] as string[], phase: 'idle' });
  const [inspectorView, setInspectorView] = useState<'topology' | 'graph' | 'collab'>('topology');
  const [operatorNote, setOperatorNote] = useState('');
  const [isSendingNote, setIsSendingNote] = useState(false);
  const [pausedTaskId, setPausedTaskId] = useState<string | null>(null);
  const [pausedAssistantId, setPausedAssistantId] = useState<string | null>(null);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [taskCatalog, setTaskCatalog] = useState<WorkflowTaskSummary[]>([]);
  const [taskStatusFilter, setTaskStatusFilter] = useState<WorkflowTaskStatus | 'all'>('all');
  const [taskCatalogOpen, setTaskCatalogOpen] = useState(true);
  const [taskCatalogBusy, setTaskCatalogBusy] = useState(false);
  const [taskCatalogError, setTaskCatalogError] = useState<string | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [workflowTemplates, setWorkflowTemplates] = useState<WorkflowTemplate[]>([]);
  const [builtInTemplateCatalog, setBuiltInTemplateCatalog] = useState<BuiltInTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<{ taskId: string; title: string; content: string } | null>(null);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [userPlugins, setUserPlugins] = useState<UserPlugin[]>([]);
  const [selectedPlugin, setSelectedPlugin] = useState<UserPlugin | null>(null);
  const [miniAppPlugin, setMiniAppPlugin] = useState<UserPlugin | null>(null);

  const saveProvider = useCallback(async (kind: ProviderCredentialKind, settings: ProviderSettings[ProviderCredentialKind], name: string) => {
    setProviderSaveState((current) => ({ ...current, [kind]: 'saving' }));
    setProviderSaveMessage('');
    try {
      const credential = await saveProviderCredential({ kind, name, settings });
      setProviderSettings((current) => ({
        ...current,
        [kind]: { ...current[kind], credentialId: credential.id, apiKey: '' },
      }));
      setProviderSaveState((current) => ({ ...current, [kind]: 'saved' }));
      setProviderSaveMessage(`${name}已安全保存，后续任务只使用服务端凭据引用。`);
    } catch (caught) {
      setProviderSaveState((current) => ({ ...current, [kind]: 'error' }));
      setProviderSaveMessage(caught instanceof Error ? caught.message : '凭据保存失败，请检查服务配置。');
    }
  }, []);
  const [pluginValues, setPluginValues] = useState<Record<string, string>>({});
  const [pluginFreeform, setPluginFreeform] = useState('');
  const [pluginCreateOpen, setPluginCreateOpen] = useState(false);
  const [pluginDesignerInput, setPluginDesignerInput] = useState('');
  const [pluginAgentLive, setPluginAgentLive] = useState<{ user: string; status: string; progress: string; error?: string } | null>(null);
  const [newPluginName, setNewPluginName] = useState('');
  const [newPluginDescription, setNewPluginDescription] = useState('');
  const [newPluginVisibility, setNewPluginVisibility] = useState<'private' | 'team'>('private');
  const [newPluginWidth, setNewPluginWidth] = useState(720);
  const [newPluginHeight, setNewPluginHeight] = useState(520);
  const [newPluginEffect, setNewPluginEffect] = useState<PluginVisualEffect | 'random'>('random');
  const [newPluginHue, setNewPluginHue] = useState(() => Math.floor(Math.random() * 360));
  const [readiness, setReadiness] = useState<ReadinessInfo>({
    state: 'degraded',
    deployment: 'local-single-node',
    checkedAt: '',
    checks: [],
    blockers: [],
    warnings: [],
    tools: [],
  });
  const [harnessStatus, setHarnessStatus] = useState({
    kind: 'builtin',
    protocol: 'builtin/v1',
    version: '1',
    configured: false,
    compatible: false,
    active: false,
    reason: '内置调度器当前生效',
    capabilities: [] as string[],
  });
  const abortRef = useRef<AbortController | null>(null);
  const pluginAgentAbortRef = useRef<AbortController | null>(null);
  const imageAbortRef = useRef<AbortController | null>(null);
  const sessionRuntimeRevisionRef = useRef(0);
  const sessionRestoreKeyRef = useRef<string | null>(null);
  const sessionsHydratedRef = useRef(false);
  const urlSessionAppliedRef = useRef(Boolean(initialUrlState.sessionId && sessions.some((session) => session.id === initialUrlState.sessionId)));
  const sessionSyncTimerRef = useRef<number | null>(null);
  const sessionSyncPendingRef = useRef(new Map<string, Session>());
  const sessionSyncInFlightRef = useRef(new Set<string>());
  const resumeAttemptsRef = useRef(new Set<string>());
  const resumeAfterSequenceRef = useRef(new Map<string, number>());
  const modelUsageEventsRef = useRef(new Set<string>());
  const collaborationEventKeysRef = useRef(new Set<string>());
  const graphEventSequenceRef = useRef(new Map<string, number>());
  const graphTaskIdRef = useRef<string | null>(null);
  const turnGraphBaseRef = useRef<{ taskId: string; graph: AgentGraph | null } | null>(null);
  const agentGraphRef = useRef<AgentGraph | null>(null);
  // Session Graph and the currently displayed Graph are intentionally kept
  // separate. A task replay may temporarily populate the inspector with a
  // TaskStore graph; that graph must never be written into a conversation
  // Session snapshot when a later direct Agent is routed.
  const sessionGraphRef = useRef<AgentGraph | null>(null);
  const sessionGraphSessionIdRef = useRef<string | null>(null);
  const pluginRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const templateRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const applyWorkflowEventRef = useRef<((event: WorkflowEvent, sessionId: string, assistantId: string) => void) | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0]!,
    [activeSessionId, sessions],
  );
  const dashboardNav = useDashboardStore((state) => state.nav);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  if (sessionGraphSessionIdRef.current !== activeSession.id) {
    sessionGraphSessionIdRef.current = activeSession.id;
    sessionGraphRef.current = activeSession.agentGraph ?? null;
  }
  agentGraphRef.current = agentGraph;
  const collaborationTaskId = activeTaskId ?? pausedTaskId;

  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const context = gsap.context(() => {
      gsap.from('.sidebar-animate', { x: -18, opacity: 0, duration: 0.5, ease: 'power2.out' });
      gsap.from('.topbar-animate', { y: -12, opacity: 0, duration: 0.45, delay: 0.08 });
      gsap.from('.workspace-animate', { opacity: 0, duration: 0.6, delay: 0.14 });
    });
    return () => context.revert();
  }, []);

  useEffect(() => {
    const persisted = sessions.filter(isSessionPersistable).map((session) => ({
      ...session,
      messages: session.messages.map((message) => ({
        ...message,
        attachments: message.attachments?.map((attachment) => attachment.kind === 'video'
          ? { id: attachment.id, kind: attachment.kind, url: attachment.url, alt: attachment.alt, mimeType: attachment.mimeType, poster: attachment.poster }
          : attachment.kind === 'file'
            ? { id: attachment.id, kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, text: attachment.text }
            : { id: attachment.id, kind: attachment.kind, url: attachment.url, alt: attachment.alt }),
      })),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  }, [sessions]);

  useEffect(() => {
    const controller = new AbortController();
    void listConversationSessions(50, controller.signal)
      .then(({ sessions: remoteSessions, deletedSessionIds }) => {
        if (controller.signal.aborted) return;
        const legacyProjectionIds = remoteSessions.filter(isNexusRunSession).map((session) => session.id);
        if (legacyProjectionIds.length > 0) {
          // These records were created by the short-lived projection behavior;
          // remove them from the regular session store as the separation rolls
          // out, while Nexus tasks remain available in the task catalog.
          void Promise.allSettled(legacyProjectionIds.map((sessionId) => deleteConversationSession(sessionId)));
        }
        setSessions((current) => {
          const localWasOnlyBlank = current.length === 1 && current[0]?.messages.length === 0;
          const merged = mergeSessionSnapshots(current, remoteSessions, deletedSessionIds);
          const next = localWasOnlyBlank && remoteSessions.length > 0
            ? merged.filter((session) => remoteSessions.some((remote) => remote.id === session.id))
            : merged;
          const normalized = next.length > 0 ? next : [createSession()];
          return normalized;
        });
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError((current) => current ?? userFacingError(caught, '会话同步失败'));
      })
      .finally(() => {
        if (!controller.signal.aborted) sessionsHydratedRef.current = true;
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (sessions.length === 0) return;
    if (!sessions.some((session) => session.id === activeSessionId)) setActiveSessionId(sessions[0]!.id);
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (urlSessionAppliedRef.current) return;
    const sessionId = readDashboardUrlState().sessionId;
    if (sessionId && sessions.some((session) => session.id === sessionId)) {
      urlSessionAppliedRef.current = true;
      setActiveSessionId(sessionId);
    } else if (sessionsHydratedRef.current) {
      urlSessionAppliedRef.current = true;
    }
  }, [sessions]);

  useEffect(() => subscribeDashboardUrlState((state) => {
    if (!state.sessionId || !sessions.some((session) => session.id === state.sessionId)) return;
    if (state.sessionId === activeSessionIdRef.current) return;
    abortRef.current?.abort(new DOMException('Session changed', 'AbortError'));
    abortRef.current = null;
    setIsRunning(false);
    setActiveSessionId(state.sessionId);
    setError(null);
    setSelectedNodeId(null);
    agentGraphRef.current = null;
    setAgentGraph(null);
    setTopologyAgents([]);
    const selectedSession = sessions.find((session) => session.id === state.sessionId);
    const runtimeTaskId = selectedSession ? runtimeTaskIdForSession(selectedSession, taskCatalog) : undefined;
    if (selectedSession) sessionRestoreKeyRef.current = `${selectedSession.id}:${runtimeTaskId ?? 'direct'}`;
    if (runtimeTaskId && selectedSession) void openCatalogTask({ id: runtimeTaskId }, selectedSession);
    else if (selectedSession) restoreDirectSessionRuntime(selectedSession);
  }), [sessions, taskCatalog]);

  useEffect(() => {
    if (!activeSession?.id) return;
    writeDashboardUrlState({ sessionId: activeSession.id });
  }, [activeSession?.id]);

  useEffect(() => {
    if (!sessionsHydratedRef.current) return;
    const persistable = sessions.filter(isSessionPersistable);
    const persistableIds = new Set(persistable.map((session) => session.id));
    for (const sessionId of sessionSyncPendingRef.current.keys()) {
      if (!persistableIds.has(sessionId)) sessionSyncPendingRef.current.delete(sessionId);
    }
    persistable.forEach((session) => sessionSyncPendingRef.current.set(session.id, session));

    const flush = () => {
      sessionSyncTimerRef.current = null;
      const pending = [...sessionSyncPendingRef.current.entries()];
      pending.forEach(([sessionId, session]) => {
        if (sessionSyncInFlightRef.current.has(sessionId)) return;
        sessionSyncPendingRef.current.delete(sessionId);
        sessionSyncInFlightRef.current.add(sessionId);
        void upsertConversationSession(session)
          .catch(() => {
            // Keep local history authoritative while the API is unavailable;
            // the latest snapshot remains queued for a later retry.
            sessionSyncPendingRef.current.set(sessionId, session);
          })
          .finally(() => {
            sessionSyncInFlightRef.current.delete(sessionId);
            if (sessionSyncPendingRef.current.has(sessionId) && sessionSyncTimerRef.current === null) {
              sessionSyncTimerRef.current = window.setTimeout(flush, 2_000);
            }
          });
      });
    };

    if (sessionSyncTimerRef.current !== null) window.clearTimeout(sessionSyncTimerRef.current);
    sessionSyncTimerRef.current = window.setTimeout(flush, 350);
    return () => {
      if (sessionSyncTimerRef.current !== null) {
        window.clearTimeout(sessionSyncTimerRef.current);
        sessionSyncTimerRef.current = null;
      }
    };
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        text: { ...providerSettings.text, apiKey: '' },
        vision: { ...providerSettings.vision, apiKey: '' },
        image: { ...providerSettings.image, apiKey: '' },
        video: { ...providerSettings.video, apiKey: '' },
      }),
    );
  }, [providerSettings]);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, uiTheme);
  }, [uiTheme]);

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then(
        (data: {
          configured?: boolean;
          model?: string;
          visionModel?: string;
          apiBase?: string;
          vision?: { configured?: boolean; model?: string; apiBase?: string };
          image?: { configured?: boolean; model?: string; apiBase?: string };
          video?: { configured?: boolean; model?: string; apiBase?: string };
        }) => {
          setHealth(data.configured ? 'ready' : 'error');
          setHealthInfo({
            model: data.model ?? 'deepseek-chat',
            apiBase: data.apiBase ?? 'https://api.deepseek.com',
            vision: {
              configured: Boolean(data.vision?.configured ?? data.configured),
              model: data.vision?.model ?? data.visionModel ?? 'deepseek-v4-flash-vision-exp',
              apiBase: data.vision?.apiBase ?? data.apiBase ?? 'https://api.deepseek.com',
            },
            image: {
              configured: Boolean(data.image?.configured),
              model: data.image?.model ?? 'gpt-image-2-03',
              apiBase: data.image?.apiBase ?? 'https://www.dmxapi.cn',
            },
            video: {
              configured: Boolean(data.video?.configured),
              model: data.video?.model ?? '',
              apiBase: data.video?.apiBase ?? '',
            },
          });
        },
      )
      .catch(() => setHealth('error'));
    fetch('/api/agents')
      .then((response) => response.json())
      .then((data: { agents?: unknown[] }) => setCatalogCount(Array.isArray(data.agents) ? data.agents.length : 6))
      .catch(() => undefined);
    fetch('/api/runtime/readiness')
      .then((response) => response.json())
      .then((data: ReadinessInfo) => setReadiness(data))
      .catch(() => undefined);
    fetch('/api/runtime/capabilities')
      .then((response) => response.json())
      .then((data: { harness?: typeof harnessStatus; execution?: { tools?: ToolDescriptor[] } }) => {
        if (data.harness) setHarnessStatus(data.harness);
        if (data.execution?.tools) setReadiness((current) => ({ ...current, tools: data.execution?.tools ?? [] }));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!settingsOpen && !imageComposerOpen && !miniAppPlugin) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSettingsOpen(false);
      setImageComposerOpen(false);
      setMiniAppPlugin(null);
      setSystemPageOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [imageComposerOpen, miniAppPlugin, settingsOpen]);

  // A plugin design stream belongs to the currently open design surface.
  // Abort it when that surface changes so late events cannot update another plugin.
  useEffect(() => {
    return () => {
      pluginAgentAbortRef.current?.abort();
      pluginAgentAbortRef.current = null;
      setPluginAgentLive(null);
    };
  }, [selectedPlugin?.id]);

  const updateSession = useCallback(
    (sessionId: string, update: (session: Session) => Session) => {
      setSessions((current) => current.map((session) => (session.id === sessionId ? update(session) : session)));
    },
    [],
  );

  const persistSessionGraph = useCallback((sessionId: string, graph: AgentGraph | null, displayGraph = graph) => {
    // Keep the synchronous ref in lockstep with the persisted snapshot. Direct
    // specialist callbacks can arrive several times before React renders again,
    // so deriving the next graph from state alone would race and drop updates.
    sessionGraphSessionIdRef.current = sessionId;
    sessionGraphRef.current = graph;
    agentGraphRef.current = displayGraph;
    setAgentGraph(displayGraph);
    updateSession(sessionId, (session) => ({
      ...session,
      agentGraph: graph ?? undefined,
      updatedAt: Date.now(),
    }));
  }, [updateSession]);

  const resetSessionRuntime = useCallback(() => {
    sessionRuntimeRevisionRef.current += 1;
    setPhase('idle');
    setAgentActivity('');
    setRunEvents([]);
    setCollaborationMessages([]);
    setCollaborationConflicts([]);
    setBudgetConstraints([]);
    collaborationEventKeysRef.current.clear();
    setUsage({});
    setDurationMs(0);
    setActiveTaskId(null);
    setPausedTaskId(null);
    setPausedAssistantId(null);
    setToolApproval(null);
    setPlanApproval(null);
    setReviewApproval(null);
    setTaskProfile(null);
    setReviewResult(null);
    agentGraphRef.current = null;
    setAgentGraph(null);
    graphTaskIdRef.current = null;
    turnGraphBaseRef.current = null;
    setTopologyAgents([]);
    setSelectedNodeId(null);
    setLoopState({ id: '', iteration: 0, maxIterations: 0, readySteps: [], completedSteps: [], phase: 'idle' });
    setInspectorView('topology');
  }, []);

  const refreshTaskCatalog = useCallback(async () => {
    setTaskCatalogBusy(true);
    try {
      setTaskCatalog(await listWorkflowTasks(30));
      setTaskCatalogError(null);
    } catch (caught) {
      setTaskCatalogError(userFacingError(caught, '任务列表暂时不可用'));
    } finally {
      setTaskCatalogBusy(false);
    }
  }, []);

  const refreshTemplates = useCallback(() => {
    if (templateRefreshInFlightRef.current) return templateRefreshInFlightRef.current;
    setTemplateBusy(true);
    setTemplateError(null);
    const request: Promise<void> = Promise.all([listWorkflowTemplates(), listBuiltInTemplates()])
      .then(([templates, catalog]) => {
        setWorkflowTemplates(templates);
        setBuiltInTemplateCatalog(catalog);
        setTemplateError(null);
      })
      .catch((caught) => {
        setTemplateError(userFacingError(caught, '模板列表暂时不可用'));
      })
      .finally(() => {
        if (templateRefreshInFlightRef.current !== request) return;
        templateRefreshInFlightRef.current = null;
        setTemplateBusy(false);
      });
    templateRefreshInFlightRef.current = request;
    return request;
  }, []);

  const createCatalogTemplate = useCallback(async (catalogId: string) => {
    setTemplateBusy(true);
    try {
      const created = await createTemplateFromCatalog(catalogId);
      setWorkflowTemplates((current) => [created, ...current]);
      setTemplateError(null);
    } catch (caught) {
      setTemplateError(userFacingError(caught, '标准模板创建失败'));
    } finally {
      setTemplateBusy(false);
    }
  }, []);

  const updateTemplateVisibility = useCallback(async (template: WorkflowTemplate) => {
    setTemplateBusy(true);
    try {
      const updated = await shareWorkflowTemplate(template.id, template.visibility !== 'team');
      setWorkflowTemplates((current) => current.map((item) => item.id === updated.id ? updated : item));
      setTemplateError(null);
    } catch (caught) {
      setTemplateError(userFacingError(caught, '模板共享状态更新失败'));
    } finally {
      setTemplateBusy(false);
    }
  }, []);

  const publishTemplate = useCallback(async (templateId: string) => {
    setTemplateBusy(true);
    try {
      const updated = await publishWorkflowTemplate(templateId);
      setWorkflowTemplates((current) => current.map((item) => item.id === updated.id ? updated : item));
      setTemplateError(null);
    } catch (caught) {
      setTemplateError(userFacingError(caught, '模板发布失败'));
    } finally {
      setTemplateBusy(false);
    }
  }, []);

  const handleTemplateExport = useCallback(async (template: WorkflowTemplate) => {
    setTemplateBusy(true);
    try {
      await exportWorkflowTemplate(template);
      setTemplateError(null);
    } catch (caught) {
      setTemplateError(userFacingError(caught, '模板导出失败'));
    } finally {
      setTemplateBusy(false);
    }
  }, []);

  const refreshPlugins = useCallback(() => {
    if (pluginRefreshInFlightRef.current) return pluginRefreshInFlightRef.current;
    setPluginBusy(true);
    setPluginError(null);
    const request: Promise<void> = listPlugins()
      .then((plugins) => {
        setUserPlugins(plugins);
        setPluginError(null);
      })
      .catch((caught) => {
        setPluginError(userFacingError(caught, '插件列表暂时不可用'));
      })
      .finally(() => {
        if (pluginRefreshInFlightRef.current !== request) return;
        pluginRefreshInFlightRef.current = null;
        setPluginBusy(false);
      });
    pluginRefreshInFlightRef.current = request;
    return request;
  }, []);

  const createUserPluginShell = useCallback(async () => {
    const name = newPluginName.trim();
    if (!name || pluginBusy) return;
    setPluginBusy(true);
    setPluginError(null);
    try {
      const generatedAppearance = randomPluginVisual();
      const plugin = await createPlugin({
        name,
        description: newPluginDescription.trim(),
        visibility: newPluginVisibility,
        mode: 'build',
        kind: 'mini-app',
        htmlContent: blankMiniAppHtml(name),
        width: Math.min(1_200, Math.max(320, Math.floor(newPluginWidth || 720))),
        height: Math.min(900, Math.max(240, Math.floor(newPluginHeight || 520))),
        appearance: {
          ...generatedAppearance,
          effect: newPluginEffect === 'random' ? generatedAppearance.effect : newPluginEffect,
          hue: newPluginHue,
        },
        agentEnabled: false,
      });
      setUserPlugins((current) => [plugin, ...current]);
      setSelectedPlugin(plugin);
      setNewPluginName('');
      setNewPluginDescription('');
      setNewPluginVisibility('private');
      setNewPluginWidth(720);
      setNewPluginHeight(520);
      setNewPluginEffect('random');
      setNewPluginHue(Math.floor(Math.random() * 360));
      setPluginDesignerInput('');
      setPluginCreateOpen(false);
      setPluginError(null);
    } catch (caught) {
      setPluginError(userFacingError(caught, '空白插件创建失败'));
    } finally {
      setPluginBusy(false);
    }
  }, [newPluginDescription, newPluginEffect, newPluginHeight, newPluginHue, newPluginName, newPluginVisibility, newPluginWidth, pluginBusy]);

  const designUserPluginWithAgent = useCallback(async () => {
    const instruction = pluginDesignerInput.trim();
    if (!selectedPlugin || selectedPlugin.kind !== 'mini-app' || instruction.length < 2 || pluginBusy) return;
    setPluginBusy(true);
    setPluginError(null);
    const controller = new AbortController();
    pluginAgentAbortRef.current = controller;
    setPluginAgentLive({ user: instruction, status: '插件 Agent 正在连接', progress: '' });
    try {
      await streamPluginWithAgent({
        pluginId: selectedPlugin.id,
        instruction,
        provider: providerSettings.text,
        signal: controller.signal,
        handlers: {
          onStatus: (message) => setPluginAgentLive((current) => current ? { ...current, status: message, error: undefined } : current),
          onProgress: (message) => setPluginAgentLive((current) => current ? { ...current, progress: message } : current),
          onComplete: ({ plugin }) => {
            setUserPlugins((current) => current.map((item) => item.id === plugin.id ? plugin : item));
            setSelectedPlugin(plugin);
            setPluginDesignerInput('');
            setPluginAgentLive(null);
          },
        },
      });
    } catch (caught) {
      if (!controller.signal.aborted) {
        const message = userFacingError(caught, '插件开发 Agent 修改失败');
        setPluginError(message);
        setPluginAgentLive((current) => current ? { ...current, status: '插件 Agent 暂停', error: message } : current);
      }
    } finally {
      if (pluginAgentAbortRef.current === controller) pluginAgentAbortRef.current = null;
      setPluginBusy(false);
    }
  }, [pluginBusy, pluginDesignerInput, providerSettings.text, selectedPlugin]);

  const deleteUserPlugin = useCallback(async (plugin: UserPlugin) => {
    if (pluginBusy) return;
    setPluginBusy(true);
    setPluginError(null);
    try {
      await deleteUserPluginRequest(plugin.id);
      setUserPlugins((current) => current.filter((item) => item.id !== plugin.id));
      setSelectedPlugin((current) => current?.id === plugin.id ? null : current);
      setMiniAppPlugin((current) => current?.id === plugin.id ? null : current);
    } catch (caught) {
      setPluginError(userFacingError(caught, '插件删除失败'));
      throw caught;
    } finally {
      setPluginBusy(false);
    }
  }, [pluginBusy]);

  const runMiniAppAgentRequest = useCallback(async (
    plugin: UserPlugin,
    prompt: string,
    signal: AbortSignal,
    onProgress: (progress: MiniAppAgentProgress) => void,
  ) => {
    const routing = await routeChatMessage(prompt, plugin.definition.mode, [], providerSettings.text, signal);
    const instruction = plugin.definition.agentInstructions?.trim();
    const content = [
      `你正在响应 Mini App“${plugin.name}”内的用户请求。`,
      instruction ? `插件内 Agent 职责：${instruction}` : '',
      `用户请求：${prompt}`,
    ].filter(Boolean).join('\n\n');
    let output = '';
    let reportedError = '';
    await streamAgentResponse(
      [{ id: makeId(), role: 'user', content, createdAt: Date.now() }],
      plugin.definition.mode,
      `plugin-${plugin.id}`,
      signal,
      {
        onStatus: (_phase, message) => onProgress({ status: message }),
        onToken: (token) => { output += token; onProgress({ content: token }); },
        onReset: () => { output = ''; onProgress({ reset: true }); },
        onReasoning: () => undefined,
        onAttachment: (attachment) => onProgress({ attachment }),
        onComplete: () => undefined,
        onError: (message) => { reportedError = message; },
      },
      providerSettings.text,
      providerSettings.vision,
      providerSettings.image,
      providerSettings.video,
      routing,
    );
    if (reportedError) throw new Error(reportedError);
    if (!output.trim()) throw new Error('平台 Agent 没有返回内容。');
    return output;
  }, [providerSettings.image, providerSettings.text, providerSettings.video, providerSettings.vision]);

  const publishUserPlugin = useCallback(async (plugin: UserPlugin) => {
    if (pluginBusy) return;
    setPluginBusy(true);
    try {
      const updated = await updatePlugin(plugin.id, { status: 'published' });
      setUserPlugins((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelectedPlugin((current) => current?.id === updated.id ? null : current);
      setPluginError(null);
    } catch (caught) {
      setPluginError(userFacingError(caught, '插件发布失败'));
    } finally {
      setPluginBusy(false);
    }
  }, [pluginBusy]);

  const resizeUserPluginWindow = useCallback(async (plugin: UserPlugin, width: number, height: number) => {
    if (pluginBusy || plugin.kind !== 'mini-app') return;
    setPluginBusy(true);
    setPluginError(null);
    try {
      const updated = await updatePlugin(plugin.id, {
        definition: { ...plugin.definition, width, height },
      });
      setUserPlugins((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelectedPlugin((current) => current?.id === updated.id ? updated : current);
      setMiniAppPlugin((current) => current?.id === updated.id ? updated : current);
    } catch (caught) {
      setPluginError(userFacingError(caught, '插件窗口大小保存失败'));
      throw caught;
    } finally {
      setPluginBusy(false);
    }
  }, [pluginBusy]);

  const runSelectedPlugin = useCallback(async () => {
    if (!selectedPlugin || isRunning || pluginBusy) return;
    setPluginBusy(true);
    setError(null);
    const userInput = pluginFreeform.trim();
    const assistantId = makeId();
    const userMessage: ChatMessage = { id: makeId(), role: 'user', content: userInput || selectedPlugin.name, createdAt: Date.now() };
    const title = activeSession.messages.length === 0 ? selectedPlugin.name : activeSession.title;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setPhase('routing');
    setRunEvents([]);
    setTopologyAgents([]);
    agentGraphRef.current = null;
    setAgentGraph(null);
    updateSession(activeSession.id, (session) => ({
      ...session,
      title,
      messages: [...session.messages, userMessage, { id: assistantId, role: 'assistant', content: '', createdAt: Date.now(), pending: true }],
      updatedAt: Date.now(),
    }));
    try {
      const result = await runPlugin({ pluginId: selectedPlugin.id, sessionId: activeSession.id, input: userInput, values: pluginValues });
      useDashboardStore.getState().setNav('chat');
      setSelectedPlugin(null);
      setPluginValues({});
      setPluginFreeform('');
      setActiveTaskId(result.task.id);
      updateSession(activeSession.id, (session) => ({ ...session, activeTaskId: result.task.id, activeAssistantId: assistantId, updatedAt: Date.now() }));
      await streamWorkflowEvents(result.task.id, controller.signal, (event) => applyWorkflowEventRef.current?.(event, activeSession.id, assistantId));
      void refreshTaskCatalog();
    } catch (caught) {
      if (!controller.signal.aborted) setError(userFacingError(caught, '插件运行失败'));
    } finally {
      setPluginBusy(false);
      setIsRunning(false);
      setActiveTaskId(null);
      if (abortRef.current === controller) abortRef.current = null;
      updateSession(activeSession.id, (session) => ({ ...session, messages: session.messages.map((message) => message.id === assistantId ? { ...message, pending: false } : message), updatedAt: Date.now() }));
    }
  }, [activeSession, isRunning, pluginBusy, pluginFreeform, pluginValues, refreshTaskCatalog, selectedPlugin, updateSession]);

  const handleTemplateImport = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setTemplateBusy(true);
    try {
      const bundle = JSON.parse(await file.text()) as unknown;
      const imported = await importWorkflowTemplate(bundle);
      setWorkflowTemplates((current) => [imported, ...current]);
      setTemplateError(null);
    } catch (caught) {
      setTemplateError(userFacingError(caught, '模板导入失败'));
    } finally {
      setTemplateBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshTaskCatalog();
    const timer = window.setInterval(() => void refreshTaskCatalog(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshTaskCatalog]);

  useEffect(() => {
    const handleCatalogMutation = () => {
      void refreshTaskCatalog();
    };
    window.addEventListener('axiom:task-catalog-mutated', handleCatalogMutation);
    return () => window.removeEventListener('axiom:task-catalog-mutated', handleCatalogMutation);
  }, [refreshTaskCatalog]);

  const restoreDirectSessionRuntime = useCallback((session: Session) => {
    const latestUserIndex = session.messages.map((message) => message.role).lastIndexOf('user');
    const latestUser = latestUserIndex >= 0 ? session.messages[latestUserIndex] : undefined;
    const latestAssistant = latestUserIndex >= 0
      ? session.messages.slice(latestUserIndex + 1).find((message) => message.role === 'assistant')
      : [...session.messages].reverse().find((message) => message.role === 'assistant');
    const role = directAgentRole(session);
    const hasAnswer = Boolean(latestAssistant?.content);
    resetSessionRuntime();
    // Direct specialist turns are not backed by a WorkflowTask. Restore the
    // session-scoped graph snapshot instead of showing an empty or stale graph.
    sessionGraphSessionIdRef.current = session.id;
    sessionGraphRef.current = session.agentGraph ?? null;
    agentGraphRef.current = session.agentGraph ?? null;
    setAgentGraph(session.agentGraph ?? null);
    graphTaskIdRef.current = null;
    setAgentActivity(latestAssistant?.pending ? `${agentDisplayName(role)}正在恢复任务状态` : '');
    setTopologyAgents(latestUser ? [{
      id: `direct-provider-${session.id}`,
      label: agentDisplayName(role),
      role,
      status: latestAssistant?.pending ? 'running' : latestAssistant?.content ? 'completed' : 'queued',
      stepId: 'direct-response',
      output: latestAssistant?.content || undefined,
    }] : []);
    setPhase(latestAssistant?.pending ? 'inference' : hasAnswer ? 'complete' : 'idle');
    setInspectorView(session.agentGraph ? 'graph' : 'topology');
  }, [resetSessionRuntime]);

  const openCatalogTask = useCallback(async (summary: { id: string }, fallbackSession?: Session) => {
    // Clear the previous session's graph immediately; stale async responses cannot win later.
    resetSessionRuntime();
    const revision = sessionRuntimeRevisionRef.current;
    setTaskCatalogBusy(true);
    try {
      const task = await getWorkflowTask(summary.id);
      if (revision !== sessionRuntimeRevisionRef.current) return;
      const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
      const historyState = taskHistoryState(task);
      const nexusTask = isNexusWorkflowTask(task);
      // Nexus has an independent runner history. Opening it from the task
      // board must never create a regular conversation session as a side
      // effect; only ordinary tasks are projected into the chat transcript.
      const targetSessionId = nexusTask ? activeSessionIdRef.current : (fallbackSession?.id ?? task.sessionId);
      const existing = nexusTask ? undefined : (fallbackSession ?? sessions.find((session) => session.id === task.sessionId));
      const matchingAssistantIndex = taskAssistantIndex(existing, task);
      const assistantContent = historyState.content
        || (matchingAssistantIndex >= 0 ? existing!.messages[matchingAssistantIndex]!.content : '')
        || (task.status === 'completed' ? '任务已完成，但没有返回文本结果。' : '');
      const assistantId = matchingAssistantIndex >= 0 ? existing!.messages[matchingAssistantIndex]!.id : makeId();
      const taskRoute = task.plan?.profile?.route ?? 'workflow';
      const nextMessages = existing?.messages?.length
        ? matchingAssistantIndex >= 0
          ? existing.messages.map((message, index) => index === matchingAssistantIndex
            ? {
                ...message,
                ...(assistantContent ? { content: assistantContent } : {}),
                pending: historyState.pending,
                taskId: task.id,
                route: taskRoute,
                agentRole: taskRoute === 'direct' ? 'direct-responder' : 'orchestrator',
              }
            : message)
          : [
              ...existing.messages,
              { id: makeId(), role: 'user' as const, content: latestUserInput(task.input), createdAt: new Date(task.createdAt).getTime() },
              { id: assistantId, role: 'assistant' as const, content: assistantContent, createdAt: new Date(task.updatedAt).getTime(), pending: historyState.pending, taskId: task.id, route: taskRoute, agentRole: taskRoute === 'direct' ? 'direct-responder' : 'orchestrator' },
            ]
        : [
            { id: makeId(), role: 'user' as const, content: latestUserInput(task.input), createdAt: new Date(task.createdAt).getTime() },
            { id: assistantId, role: 'assistant' as const, content: assistantContent, createdAt: new Date(task.updatedAt).getTime(), pending: historyState.pending, taskId: task.id, route: taskRoute, agentRole: taskRoute === 'direct' ? 'direct-responder' : 'orchestrator' },
          ];
      if (!nexusTask) {
        setSessions((current) => {
          const index = current.findIndex((session) => session.id === targetSessionId);
          if (index < 0) return [{ id: targetSessionId, title: fallbackSession?.title ?? task.title, messages: nextMessages, updatedAt: new Date(task.updatedAt).getTime() }, ...current].slice(0, 18);
          return current.map((session, currentIndex) => currentIndex === index
            ? { ...session, title: fallbackSession?.title ?? task.title, messages: nextMessages, updatedAt: Math.max(session.updatedAt, new Date(task.updatedAt).getTime()) }
            : session);
        });
        setActiveSessionId(targetSessionId);
      }
      setTaskProfile(task.plan?.profile ?? null);
      setReviewResult(task.review ?? null);
      const taskGraph = restoreTaskGraph(task);
      const restoredGraph = existing?.agentGraph
        ? taskGraph && !terminal
          ? mergeAgentGraphs(existing.agentGraph, taskGraph, task.id)
          : existing.agentGraph
        : taskGraph;
      agentGraphRef.current = restoredGraph;
      setAgentGraph(restoredGraph);
      graphTaskIdRef.current = restoredGraph ? task.id : null;
      turnGraphBaseRef.current = null;
      if (!nexusTask) {
        sessionGraphSessionIdRef.current = targetSessionId;
        sessionGraphRef.current = restoredGraph;
      }
      setPhase(task.status === 'completed'
        ? 'complete'
        : task.status === 'failed' || task.status === 'cancelled'
          ? 'error'
          : task.status === 'running' || task.status === 'planning' || task.status === 'reviewing'
            ? 'inference'
            : 'idle');
      setAgentActivity(historyState.activity);
      const persistedAgents: TopologyAgent[] = task.stepResults.map((result) => ({
        id: result.agentId,
        label: agentDisplayName(result.role),
        role: result.role,
        status: result.status,
        stepId: result.stepId,
        output: result.output,
        evidence: result.evidence,
        confidence: result.confidence,
        attempts: result.attempts,
        durationMs: result.durationMs,
        tokens: result.tokens,
        toolCalls: result.toolCalls,
        artifacts: result.artifacts,
      }));
      const directRoute = task.plan?.profile?.route === 'direct';
      setTopologyAgents(persistedAgents.length > 0 ? persistedAgents : directRoute ? [{
        id: `direct-responder-${task.id.slice(0, 8)}`,
        label: agentDisplayName('direct-responder'),
        role: 'direct-responder',
        status: task.status === 'failed' ? 'failed' : historyState.pending ? 'running' : 'completed',
        stepId: 'direct-response',
        output: task.result ?? undefined,
        durationMs: Math.max(0, new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime()),
      }] : []);
      setInspectorView(restoredGraph ? 'graph' : 'topology');
      setError(null);
      const pendingToolApproval = task.toolApprovals?.find((approval) => approval.status === 'pending');
      setToolApproval(pendingToolApproval ? { taskId: task.id, approval: pendingToolApproval } : null);
      setReviewApproval(task.status === 'waiting_for_human' && task.review && !pendingToolApproval ? {
        taskId: task.id,
        score: task.review.score,
        summary: task.review.summary,
        gaps: task.review.gaps,
        requiredCorrections: task.review.requiredCorrections,
      } : null);
      setOperatorNote('');
      if (terminal || task.status === 'paused' || task.status === 'waiting_for_human' || task.status === 'awaiting_approval') {
        setActiveTaskId(null);
        setPausedTaskId(task.status === 'paused' || task.status === 'waiting_for_human' || task.status === 'awaiting_approval' ? task.id : null);
        setPausedAssistantId(task.status === 'paused' || task.status === 'waiting_for_human' || task.status === 'awaiting_approval' ? assistantId : null);
        if (!nexusTask) updateSession(targetSessionId, (session) => ({
          ...session,
          activeTaskId: undefined,
          activeAssistantId: undefined,
        }));
        if (task.status === 'waiting_for_human' || task.status === 'awaiting_approval') setInspectorView('collab');
      } else {
        resumeAttemptsRef.current.delete(task.id);
        if (!nexusTask) updateSession(targetSessionId, (session) => ({
          ...session,
          activeTaskId: task.id,
          activeAssistantId: assistantId,
        }));
      }
      return true;
    } catch (caught) {
      if (revision === sessionRuntimeRevisionRef.current) {
        if (fallbackSession) {
          setTaskCatalogError(null);
          // restoreDirectSessionRuntime advances the runtime revision, so clear this request first.
          setTaskCatalogBusy(false);
          restoreDirectSessionRuntime(fallbackSession);
        } else {
          setTaskCatalogError(userFacingError(caught, '无法打开任务'));
        }
      }
      return false;
    } finally {
      if (revision === sessionRuntimeRevisionRef.current) setTaskCatalogBusy(false);
    }
  }, [resetSessionRuntime, restoreDirectSessionRuntime, sessions, updateSession]);

  useEffect(() => {
    if (dashboardNav !== 'chat' || isRunning || activeTaskId) return;
    const runtimeTaskId = runtimeTaskIdForSession(activeSession, taskCatalog);
    const restoreKey = `${activeSession.id}:${runtimeTaskId ?? 'direct'}`;
    if (sessionRestoreKeyRef.current === restoreKey) return;
    sessionRestoreKeyRef.current = restoreKey;

    if (!runtimeTaskId) {
      restoreDirectSessionRuntime(activeSession);
      return;
    }
    if (graphTaskIdRef.current === runtimeTaskId) return;

    void openCatalogTask({ id: runtimeTaskId }, activeSession).then((opened) => {
      if (!opened && sessionRestoreKeyRef.current === restoreKey) sessionRestoreKeyRef.current = null;
    });
  }, [activeSession, activeTaskId, dashboardNav, isRunning, openCatalogTask, restoreDirectSessionRuntime, taskCatalog]);

  const previewCatalogArtifact = useCallback(async (summary: WorkflowTaskSummary) => {
    try {
      const artifact = await getWorkflowArtifact(summary.id);
      setArtifactPreview({ taskId: summary.id, title: summary.title, content: artifact.content ?? '' });
    } catch (caught) {
      setTaskCatalogError(userFacingError(caught, 'Artifact 暂不可用'));
    }
  }, []);

  const retryCatalogTask = useCallback(async (summary: WorkflowTaskSummary) => {
    try {
      await retryWorkflowTask(summary.id);
      await refreshTaskCatalog();
    } catch (caught) {
      setTaskCatalogError(userFacingError(caught, '任务重试失败'));
    }
  }, [refreshTaskCatalog]);

  const filteredTaskCatalog = useMemo(
    () => taskCatalog.filter((task) => taskStatusFilter === 'all' || task.status === taskStatusFilter),
    [taskCatalog, taskStatusFilter],
  );

  const formatTaskDuration = (duration: number) => duration < 1_000 ? '不足 1 秒' : `${(duration / 1_000).toFixed(duration >= 60_000 ? 0 : 1)} 秒`;

  const addRunEvent = useCallback((eventPhase: AgentPhase, label: string) => {
    setRunEvents((current) => [
      ...current,
      { id: makeId(), phase: eventPhase, label, at: Date.now() },
    ].slice(-30));
  }, []);

  const applyWorkflowEvent = useCallback((event: WorkflowEvent, sessionId: string, assistantId: string) => {
    if (sessionId !== activeSessionIdRef.current) return;
    const nextPhase = workflowPhase(event);
    setPhase(nextPhase);
    setAgentActivity(nextPhase === 'complete' || nextPhase === 'error' || event.type === 'task.cancelled' || event.type === 'task.paused'
      ? ''
      : workflowEventLabel(event));
    addRunEvent(nextPhase, workflowEventLabel(event));

    const upsertAgent = (agent: TopologyAgent) => {
      setTopologyAgents((current) => {
        const existing = current.findIndex((item) => item.id === agent.id
          || (agent.stepId === 'direct-response' && item.stepId === 'direct-response' && item.role === agent.role));
        if (existing < 0) return [...current, agent].slice(-24);
        return current.map((item, index) => index === existing ? {
          ...item,
          ...agent,
          id: item.id,
          role: agent.role || item.role,
          label: agent.label || item.label,
        } : item);
      });
    };

    const rawGraphPayload = event.payload.graph
      ?? (event.payload.plan as { graph?: AgentGraph } | undefined)?.graph;
    const graphPayload = parseAgentGraph(rawGraphPayload);
    const setSequencedGraph = (nextGraph: AgentGraph | null) => {
      if (!acceptGraphEventSequence(graphEventSequenceRef.current, event.taskId, event.sequence)) return;
      if (!nextGraph) {
        // A direct turn does not invalidate the cumulative conversation Graph.
        return;
      }
      if (turnGraphBaseRef.current?.taskId !== event.taskId) {
        turnGraphBaseRef.current = {
          taskId: event.taskId,
          graph: sessionGraphSessionIdRef.current === sessionId ? sessionGraphRef.current : null,
        };
      }
      const base = turnGraphBaseRef.current.graph;
      const resolved = base ? mergeAgentGraphs(base, nextGraph, event.taskId) : nextGraph;
      agentGraphRef.current = resolved;
      sessionGraphSessionIdRef.current = sessionId;
      sessionGraphRef.current = resolved;
      setAgentGraph(resolved);
      graphTaskIdRef.current = event.taskId;
      updateSession(sessionId, (session) => ({ ...session, agentGraph: resolved, updatedAt: Date.now() }));
    };
    if (graphPayload) setSequencedGraph(graphPayload);
    const eventProfile = event.payload.profile as Partial<TaskProfile> | undefined;
    const isDirectRoute = eventProfile?.route === 'direct' || event.payload.route === 'direct';

    // Keep collaboration telemetry lossless enough for inspection while making
    // replay/reconnect idempotent. The event stream remains the source of truth.
    if (event.type === 'agent.message' || event.type === 'agent.conflict' || event.type === 'budget.constrained') {
      const eventKey = `${event.taskId}:${event.id}`;
      if (!collaborationEventKeysRef.current.has(eventKey)) {
        collaborationEventKeysRef.current.add(eventKey);
        if (event.type === 'agent.message') {
          setCollaborationMessages((current) => [...current, {
            eventId: event.id,
            taskId: event.taskId,
            sequence: event.sequence,
            fromAgentId: String(event.payload.fromAgentId ?? event.agentId ?? 'unknown'),
            toAgentId: String(event.payload.toAgentId ?? 'orchestrator'),
            kind: String(event.payload.kind ?? 'dependency-context'),
            content: String(event.payload.content ?? ''),
            artifactIds: Array.isArray(event.payload.artifactIds)
              ? event.payload.artifactIds.filter((value): value is string => typeof value === 'string')
              : [],
            at: event.timestamp,
          }].slice(-100));
        }
        if (event.type === 'agent.conflict') {
          setCollaborationConflicts((current) => [...current, {
            eventId: event.id,
            taskId: event.taskId,
            sequence: event.sequence,
            stepIds: Array.isArray(event.payload.stepIds)
              ? event.payload.stepIds.filter((value): value is string => typeof value === 'string')
              : [],
            signals: Array.isArray(event.payload.signals)
              ? event.payload.signals.filter((value): value is string => typeof value === 'string')
              : [],
            summary: String(event.payload.summary ?? '并行 Agent 输出需要进一步审查。'),
            resolution: String(event.payload.resolution ?? 'reviewer-validation-required'),
            iteration: Number.isFinite(Number(event.payload.iteration)) ? Number(event.payload.iteration) : undefined,
            at: event.timestamp,
          }].slice(-50));
        }
        if (event.type === 'budget.constrained') {
          const rawSteps = Array.isArray(event.payload.steps) ? event.payload.steps : [];
          setBudgetConstraints((current) => [...current, {
            eventId: event.id,
            taskId: event.taskId,
            sequence: event.sequence,
            iteration: Number.isFinite(Number(event.payload.iteration)) ? Number(event.payload.iteration) : undefined,
            usedTokens: Number(event.payload.usedTokens ?? 0),
            maxTokens: Number(event.payload.maxTokens ?? 0),
            reserveTokens: Number(event.payload.reserveTokens ?? 0),
            estimatedBatchTokens: Number(event.payload.estimatedBatchTokens ?? 0),
            availableForBatch: Number(event.payload.availableForBatch ?? 0),
            reason: String(event.payload.reason ?? '步骤 Token 预算已受到限制。'),
            steps: rawSteps.flatMap((value) => {
              if (!value || typeof value !== 'object') return [];
              const item = value as Record<string, unknown>;
              return [{
                stepId: String(item.stepId ?? 'step'),
                originalMaxTokens: Number(item.originalMaxTokens ?? 0),
                maxTokens: Number(item.maxTokens ?? 0),
              }];
            }),
            at: event.timestamp,
          }].slice(-50));
        }
      }
    }

    if (event.type === 'model.completed') {
      // A resumed task replays its event history. De-duplicate by event identity while
      // using the server's cumulative total when available.
      const usageEventKey = `${event.taskId}:${event.id}`;
      const cumulative = event.payload.cumulative as { tokens?: number } | undefined;
      if (!modelUsageEventsRef.current.has(usageEventKey)) {
        modelUsageEventsRef.current.add(usageEventKey);
        const promptTokens = Number(event.payload.promptTokens ?? 0);
        const completionTokens = Number(event.payload.completionTokens ?? 0);
        const totalTokens = Number(event.payload.totalTokens ?? promptTokens + completionTokens);
        setUsage((current) => {
          const cumulativeTotal = Number(cumulative?.tokens);
          return {
            prompt_tokens: (current.prompt_tokens ?? 0) + promptTokens,
            completion_tokens: (current.completion_tokens ?? 0) + completionTokens,
            total_tokens: Number.isFinite(cumulativeTotal) && cumulativeTotal >= 0
              ? Math.max(current.total_tokens ?? 0, cumulativeTotal)
              : (current.total_tokens ?? 0) + totalTokens,
          };
        });
      }
      if (Number.isFinite(Number(event.payload.durationMs))) {
        setDurationMs((current) => Math.max(current, Number(event.payload.durationMs)));
      }
    }
    if (event.type === 'model.delta') {
      const stage = String(event.payload.stage ?? '');
      const content = typeof event.payload.content === 'string' ? event.payload.content : '';
      const userFacing = stage === 'direct-response' || stage === 'synthesizer' || stage.startsWith('single-agent:');
      if (userFacing && event.payload.reset === true) {
        updateSession(sessionId, (session) => ({
          ...session,
          messages: session.messages.map((message) => message.id === assistantId ? { ...message, content: '', pending: true } : message),
          updatedAt: Date.now(),
        }));
      } else if (content && userFacing) {
        updateSession(sessionId, (session) => ({
          ...session,
          messages: session.messages.map((message) => message.id === assistantId
            ? { ...message, content: message.content + content, pending: true }
            : message),
          updatedAt: Date.now(),
        }));
      }
    }
    if (event.type === 'loop.started') {
      setLoopState((current) => ({
        ...current,
        id: typeof event.payload.loopId === 'string' ? event.payload.loopId : current.id,
        iteration: Number(event.payload.startIteration ?? current.iteration ?? 0),
        maxIterations: Number(event.payload.maxIterations ?? current.maxIterations ?? 0),
        phase: 'running',
      }));
    }
    if (event.type === 'loop.iteration') {
      setLoopState((current) => ({
        ...current,
        iteration: Number(event.payload.iteration ?? current.iteration),
        readySteps: Array.isArray(event.payload.readySteps)
          ? event.payload.readySteps.filter((value): value is string => typeof value === 'string')
          : current.readySteps,
        completedSteps: Array.isArray(event.payload.completedSteps)
          ? event.payload.completedSteps.filter((value): value is string => typeof value === 'string')
          : current.completedSteps,
        phase: 'running',
      }));
    }
    if (event.type === 'loop.completed') {
      setLoopState((current) => ({
        ...current,
        iteration: Number(event.payload.iterations ?? current.iteration),
        phase: 'completed',
      }));
    }

    if (event.type === 'task.planning') {
      if (event.payload.profile) setTaskProfile(event.payload.profile as TaskProfile);
      if (isDirectRoute) {
        setSequencedGraph(null);
      } else {
        const planningRole = event.payload.source === 'scheduler-agent' ? 'scheduler-agent' : 'planner';
        upsertAgent({ id: planningRole, label: agentDisplayName(planningRole), role: planningRole, status: 'running' });
      }
    }
    if (event.type === 'task.planned') {
      if (event.payload.profile) setTaskProfile(event.payload.profile as TaskProfile);
      if (!isDirectRoute) {
        const planningRole = event.payload.source === 'scheduler-agent' ? 'scheduler-agent' : 'planner';
        upsertAgent({ id: planningRole, label: agentDisplayName(planningRole), role: planningRole, status: 'completed' });
      }
      if (isDirectRoute) setSequencedGraph(null);
    }
    if (event.type === 'routing.started') upsertAgent({ id: 'router-agent', label: agentDisplayName('router-agent'), role: 'router-agent', status: 'running' });
    if (event.type === 'routing.decided') upsertAgent({ id: 'router-agent', label: agentDisplayName('router-agent'), role: 'router-agent', status: 'completed' });
    if (event.type === 'scheduling.started') upsertAgent({ id: 'scheduler-agent', label: agentDisplayName('scheduler-agent'), role: 'scheduler-agent', status: 'running' });
    if (event.type === 'scheduling.decided') upsertAgent({ id: 'scheduler-agent', label: agentDisplayName('scheduler-agent'), role: 'scheduler-agent', status: 'completed' });
    if (event.type === 'plan.approval_requested') {
      const plan = event.payload.plan as { summary?: string; version?: number } | undefined;
      setPlanApproval({
        taskId: event.taskId,
        version: Number(event.payload.version ?? plan?.version ?? 1),
        summary: String(plan?.summary ?? '规划器已生成可执行计划，等待人工确认。'),
      });
      setPausedTaskId(event.taskId);
      setPausedAssistantId(assistantId);
      updateSession(sessionId, (session) => ({
        ...session,
        activeTaskId: undefined,
        activeAssistantId: undefined,
        messages: session.messages.map((message) => message.id === assistantId
          ? { ...message, pending: false, content: '规划器已生成执行计划，等待批准。' }
          : message),
        updatedAt: Date.now(),
      }));
    }
    if (event.type === 'plan.approved' || event.type === 'plan.replanned') {
      setPlanApproval(null);
    }
    if (event.type === 'review.approval_requested') {
      setReviewApproval({
        taskId: event.taskId,
        score: Number(event.payload.score ?? 0),
        summary: String(event.payload.summary ?? '审查员未通过当前质量门禁。'),
        gaps: Array.isArray(event.payload.gaps) ? event.payload.gaps.filter((value): value is string => typeof value === 'string') : [],
        requiredCorrections: Array.isArray(event.payload.requiredCorrections)
          ? event.payload.requiredCorrections.filter((value): value is string => typeof value === 'string')
          : [],
      });
      setPausedTaskId(event.taskId);
      setPausedAssistantId(assistantId);
      updateSession(sessionId, (session) => ({
        ...session,
        activeTaskId: undefined,
        activeAssistantId: undefined,
        messages: session.messages.map((message) => message.id === assistantId
          ? { ...message, pending: false, content: `审查员暂停交付：${String(event.payload.summary ?? '需要人工质量决策。')}` }
          : message),
        updatedAt: Date.now(),
      }));
    }
    if (event.type === 'review.approved' || event.type === 'review.rejected') {
      setReviewApproval(null);
    }
    if (event.type === 'tool.approval_requested') {
      const approval = event.payload.approval as ToolApproval | undefined;
      if (approval) setToolApproval({ taskId: event.taskId, approval });
      setPausedTaskId(event.taskId);
      setPausedAssistantId(assistantId);
      updateSession(sessionId, (session) => ({
        ...session,
        activeTaskId: undefined,
        activeAssistantId: undefined,
        messages: session.messages.map((message) => message.id === assistantId
          ? { ...message, pending: false, content: `工具 ${String(event.payload.name ?? approval?.name ?? '')} 需要人工批准后才能继续。` }
          : message),
        updatedAt: Date.now(),
      }));
    }
    if (event.type === 'tool.approved' || event.type === 'tool.rejected') {
      setToolApproval(null);
    }
    if (event.type === 'agent.spawned' && event.agentId) {
      const role = String(event.payload.role ?? event.agentId.split('-')[0] ?? 'agent');
      const dependsOn = Array.isArray(event.payload.dependsOn) ? event.payload.dependsOn.filter((value): value is string => typeof value === 'string') : [];
      upsertAgent({
        id: event.agentId,
        label: agentDisplayName(role, String(event.payload.title ?? '')),
        role,
        status: 'queued',
        stepId: typeof event.payload.stepId === 'string' ? event.payload.stepId : undefined,
        title: String(event.payload.title ?? role),
        dependsOn,
        parentId: dependsOn[0] ? `${role}-${dependsOn[0]}` : 'orchestrator',
        skillIds: Array.isArray(event.payload.skillIds) ? event.payload.skillIds.filter((value): value is string => typeof value === 'string') : undefined,
      });
    }
    if (event.type === 'agent.started' && event.agentId) {
      const role = String(event.payload.role ?? event.agentId.split('-')[0] ?? 'agent');
      upsertAgent({
        id: event.agentId,
        label: agentDisplayName(role, String(event.payload.title ?? '')),
        role,
        status: 'running',
        stepId: typeof event.payload.stepId === 'string' ? event.payload.stepId : undefined,
        dependsOn: Array.isArray(event.payload.dependsOn) ? event.payload.dependsOn.filter((value): value is string => typeof value === 'string') : undefined,
        skillIds: Array.isArray(event.payload.skillIds) ? event.payload.skillIds.filter((value): value is string => typeof value === 'string') : undefined,
      });
    }
    if (event.type === 'agent.retrying' && event.agentId) {
      const role = String(event.payload.role ?? '');
      upsertAgent({ id: event.agentId, label: agentDisplayName(role), role, status: 'running', skillIds: Array.isArray(event.payload.skillIds) ? event.payload.skillIds.filter((value): value is string => typeof value === 'string') : undefined });
    }
    if (event.type === 'agent.completed' && event.agentId) {
      const role = String(event.payload.role ?? event.agentId.split('-')[0] ?? 'agent');
      upsertAgent({
        id: event.agentId,
        label: agentDisplayName(role, String(event.payload.title ?? '')),
        role,
        status: 'completed',
        stepId: typeof event.payload.stepId === 'string' ? event.payload.stepId : undefined,
        objective: typeof event.payload.objective === 'string' ? event.payload.objective : undefined,
        dependsOn: Array.isArray(event.payload.dependsOn) ? event.payload.dependsOn.filter((value): value is string => typeof value === 'string') : undefined,
        confidence: Number(event.payload.confidence ?? 0),
        output: typeof event.payload.output === 'string' ? event.payload.output : undefined,
        evidence: Array.isArray(event.payload.evidence) ? event.payload.evidence.filter((value): value is string => typeof value === 'string') : undefined,
        attempts: Number(event.payload.stepAttempts ?? 0),
        durationMs: Number(event.payload.durationMs ?? 0),
        tokens: Number((event.payload.usage as Usage | undefined)?.total_tokens ?? 0),
        toolCalls: Array.isArray(event.payload.toolCalls) ? event.payload.toolCalls as TopologyAgent['toolCalls'] : undefined,
        artifacts: Array.isArray(event.payload.artifacts) ? event.payload.artifacts as TopologyAgent['artifacts'] : undefined,
        skillIds: Array.isArray(event.payload.skillIds) ? event.payload.skillIds.filter((value): value is string => typeof value === 'string') : undefined,
      });
    }
    if (event.type === 'agent.failed' && event.agentId) {
      const role = String(event.payload.role ?? '');
      upsertAgent({
        id: event.agentId,
        label: role ? agentDisplayName(role, String(event.payload.title ?? '')) : '',
        role,
        status: 'failed',
        stepId: typeof event.payload.stepId === 'string' ? event.payload.stepId : undefined,
        objective: typeof event.payload.objective === 'string' ? event.payload.objective : undefined,
        dependsOn: Array.isArray(event.payload.dependsOn) ? event.payload.dependsOn.filter((value): value is string => typeof value === 'string') : undefined,
        failureReason: typeof event.payload.error === 'string' ? event.payload.error : undefined,
        skillIds: Array.isArray(event.payload.skillIds) ? event.payload.skillIds.filter((value): value is string => typeof value === 'string') : undefined,
      });
    }
    if (event.type === 'review.started') {
      upsertAgent({ id: 'reviewer-final', label: agentDisplayName('reviewer'), role: 'reviewer', status: 'running' });
    }
    if (event.type === 'review.completed') {
      if (!event.payload.skipped || !isDirectRoute) {
        upsertAgent({
          id: 'reviewer-final',
          label: agentDisplayName('reviewer'),
          role: 'reviewer',
          status: event.payload.approved === true ? 'completed' : 'failed',
        });
      }
      setReviewResult({
        approved: Boolean(event.payload.approved),
        score: Number(event.payload.score ?? 0),
        summary: String(event.payload.summary ?? ''),
        gaps: Array.isArray(event.payload.gaps) ? event.payload.gaps.filter((value): value is string => typeof value === 'string') : [],
        requiredCorrections: Array.isArray(event.payload.requiredCorrections)
          ? event.payload.requiredCorrections.filter((value): value is string => typeof value === 'string')
          : [],
      });
    }
    if (event.type === 'human.note') {
      setError(null);
    }
    if (event.type === 'task.completed') {
      setFailedTaskId(null);
      const result = String(event.payload.result ?? '任务已完成，但没有返回文本结果。');
      if (!isDirectRoute) upsertAgent({ id: 'synthesizer', label: agentDisplayName('synthesizer'), role: 'synthesizer', status: 'completed' });
      updateSession(sessionId, (session) => ({
        ...session,
        activeTaskId: undefined,
        activeAssistantId: undefined,
        messages: session.messages.map((message) =>
          message.id === assistantId ? { ...message, content: result, pending: false, taskId: event.taskId, route: eventProfile?.route ?? 'workflow', agentRole: isDirectRoute ? 'direct-responder' : 'orchestrator' } : message,
        ),
        updatedAt: Date.now(),
      }));
    }
    if (event.type === 'task.failed') {
      const message = userFacingError(String(event.payload.error ?? ''), 'Agent 工作流执行失败。');
      setError(message);
      setFailedTaskId(event.taskId);
      updateSession(sessionId, (session) => ({
        ...session,
        activeTaskId: undefined,
        activeAssistantId: undefined,
        messages: session.messages.map((item) =>
          item.id === assistantId ? { ...item, content: `工作流失败：${message}`, pending: false, taskId: event.taskId, route: eventProfile?.route ?? 'workflow', agentRole: isDirectRoute ? 'direct-responder' : 'orchestrator' } : item,
        ),
        updatedAt: Date.now(),
      }));
    }
    if (event.type === 'task.cancelled') {
      setFailedTaskId(null);
      updateSession(sessionId, (session) => ({
        ...session,
        activeTaskId: undefined,
        activeAssistantId: undefined,
        messages: session.messages.map((item) =>
          item.id === assistantId ? { ...item, content: '任务已取消。', pending: false, taskId: event.taskId, route: eventProfile?.route ?? 'workflow', agentRole: isDirectRoute ? 'direct-responder' : 'orchestrator' } : item,
        ),
        updatedAt: Date.now(),
      }));
    }
  }, [addRunEvent, updateSession]);

  applyWorkflowEventRef.current = applyWorkflowEvent;

  useEffect(() => {
    const taskId = activeSession.activeTaskId;
    const assistantId = activeSession.activeAssistantId;
    if (!sessionsHydratedRef.current || !taskId || !assistantId || isRunning || abortRef.current || resumeAttemptsRef.current.has(taskId)) return;

    resumeAttemptsRef.current.add(taskId);
    const controller = new AbortController();
    abortRef.current = controller;
    setActiveTaskId(taskId);
    setTopologyAgents([]);
    agentGraphRef.current = null;
    setAgentGraph(null);
    setLoopState({ id: '', iteration: 0, maxIterations: 0, readySteps: [], completedSteps: [], phase: 'idle' });
    setRunEvents([]);
    setCollaborationMessages([]);
    setCollaborationConflicts([]);
    setBudgetConstraints([]);
    collaborationEventKeysRef.current.clear();
    setError(null);
    setPhase('routing');
    setIsRunning(true);
    addRunEvent('routing', '正在恢复持久化任务事件流');

    const afterSequence = resumeAfterSequenceRef.current.get(taskId) ?? 0;
    resumeAfterSequenceRef.current.delete(taskId);
    void streamWorkflowEvents(taskId, controller.signal, (event) => {
      applyWorkflowEvent(event, activeSession.id, assistantId);
    }, afterSequence).then(async () => {
      // A task can become terminal between the approval response and the SSE
      // subscription. Reconcile from the durable task record so the final
      // result is never lost merely because no new stream frame was observed.
      const task = await getWorkflowTask(taskId, controller.signal);
      if (task.status === 'completed' && task.result) {
        updateSession(activeSession.id, (session) => ({
          ...session,
          activeTaskId: undefined,
          activeAssistantId: undefined,
          messages: session.messages.map((message) => message.id === assistantId
            ? { ...message, content: task.result!, pending: false, taskId, route: task.plan?.profile?.route ?? 'workflow', agentRole: 'orchestrator' }
            : message),
          updatedAt: Date.now(),
        }));
        setPhase('complete');
        setAgentActivity('');
      }
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      setPhase('error');
      setError(userFacingError(caught, '任务事件流恢复失败。'));
      addRunEvent('error', '任务仍在服务端执行，事件流恢复失败');
    }).finally(() => {
      if (abortRef.current !== controller) return;
      abortRef.current = null;
      setActiveTaskId(null);
      setIsRunning(false);
    });

    return () => {
      controller.abort(new DOMException('Session changed', 'AbortError'));
      resumeAttemptsRef.current.delete(taskId);
      if (abortRef.current === controller) {
        abortRef.current = null;
        setActiveTaskId(null);
        setIsRunning(false);
      }
    };
  }, [activeSession.activeAssistantId, activeSession.activeTaskId, activeSession.id, addRunEvent, applyWorkflowEvent, updateSession]);

  const stopRun = useCallback(() => {
    const taskId = activeTaskId;
    if (taskId) {
      void cancelWorkflowTask(taskId).catch((caught) => {
        setError(userFacingError(caught, '任务取消请求失败。'));
      });
    }
    abortRef.current?.abort();
    imageAbortRef.current?.abort();
    abortRef.current = null;
    imageAbortRef.current = null;
    setIsRunning(false);
    setIsGeneratingImage(false);
    setActiveTaskId(null);
    setPhase('idle');
    addRunEvent('idle', '任务已停止');
    updateSession(activeSessionId, (session) => ({
      ...session,
      activeTaskId: undefined,
      activeAssistantId: undefined,
      messages: session.messages
        .map((message) => (message.pending ? { ...message, pending: false } : message))
        .filter((message) => message.role !== 'assistant' || message.content.length > 0),
      updatedAt: Date.now(),
    }));
  }, [activeSessionId, activeTaskId, addRunEvent, updateSession]);

  const pauseRun = useCallback(async () => {
    const taskId = activeTaskId;
    const assistantId = activeSession.activeAssistantId;
    if (!taskId || !assistantId) return;
    try {
      await pauseWorkflowTask(taskId, '操作员暂停任务以进行检查。');
      setPausedTaskId(taskId);
      setPausedAssistantId(assistantId);
      abortRef.current?.abort(new DOMException('Task paused', 'AbortError'));
      abortRef.current = null;
      setActiveTaskId(null);
      setIsRunning(false);
      setPhase('idle');
      addRunEvent('idle', 'Loop 已暂停，检查点可继续');
      updateSession(activeSession.id, (session) => ({
        ...session,
        activeTaskId: undefined,
        activeAssistantId: undefined,
        messages: session.messages.map((message) => message.id === assistantId
          ? { ...message, pending: false, content: message.content || '任务已暂停，可在协作面板继续。' }
          : message),
        updatedAt: Date.now(),
      }));
    } catch (caught) {
      setError(userFacingError(caught, '暂停任务失败'));
    }
  }, [activeSession.activeAssistantId, activeSession.id, activeTaskId, addRunEvent, updateSession]);

  const resumeRun = useCallback(async () => {
    const taskId = pausedTaskId;
    const assistantId = pausedAssistantId;
    if (!taskId || !assistantId || isRunning) return;
    try {
      await resumeWorkflowTask(taskId);
      resumeAttemptsRef.current.delete(taskId);
      setPausedTaskId(null);
      setPausedAssistantId(null);
      setError(null);
      updateSession(activeSession.id, (session) => ({
        ...session,
        activeTaskId: taskId,
        activeAssistantId: assistantId,
        messages: session.messages.map((message) => message.id === assistantId
          ? { ...message, pending: true, content: '' }
          : message),
        updatedAt: Date.now(),
      }));
      addRunEvent('routing', '从检查点恢复 Loop');
    } catch (caught) {
      setError(userFacingError(caught, '恢复任务失败'));
    }
  }, [activeSession.id, addRunEvent, isRunning, pausedAssistantId, pausedTaskId, updateSession]);

  const submitOperatorNote = useCallback(async () => {
    const taskId = activeTaskId ?? pausedTaskId;
    const note = operatorNote.trim();
    if (!taskId || !note || isSendingNote) return;
    setIsSendingNote(true);
    try {
      await sendTaskNote(taskId, note);
      setOperatorNote('');
      addRunEvent('context', '操作员反馈已加入下一轮 Agent 上下文');
    } catch (caught) {
      setError(userFacingError(caught, '操作员反馈发送失败。'));
    } finally {
      setIsSendingNote(false);
    }
  }, [activeTaskId, addRunEvent, isSendingNote, operatorNote, pausedTaskId]);

  const continueControlledTask = useCallback((taskId: string, afterSequence = 0) => {
    const assistantId = pausedAssistantId ?? activeSession.activeAssistantId;
    if (!assistantId) return;
    if (afterSequence > 0) resumeAfterSequenceRef.current.set(taskId, afterSequence);
    resumeAttemptsRef.current.delete(taskId);
    setPausedTaskId(null);
    setPausedAssistantId(null);
    updateSession(activeSession.id, (session) => ({
      ...session,
      activeTaskId: taskId,
      activeAssistantId: assistantId,
      messages: session.messages.map((message) => message.id === assistantId ? { ...message, pending: true, content: '' } : message),
      updatedAt: Date.now(),
    }));
  }, [activeSession.activeAssistantId, activeSession.id, pausedAssistantId, updateSession]);

  const approvePlan = useCallback(async () => {
    if (!planApproval || nodeActionBusy) return;
    setNodeActionBusy(true);
    try {
      const control = await approveWorkflowPlan(planApproval.taskId, operatorNote.trim());
      setOperatorNote('');
      setPlanApproval(null);
      continueControlledTask(planApproval.taskId, control.event?.sequence);
      addRunEvent('routing', `计划 v${planApproval.version} 已批准，继续执行`);
    } catch (caught) {
      setError(userFacingError(caught, '计划批准失败'));
    } finally {
      setNodeActionBusy(false);
    }
  }, [addRunEvent, continueControlledTask, nodeActionBusy, operatorNote, planApproval]);

  const approveReview = useCallback(async () => {
    if (!reviewApproval || nodeActionBusy) return false;
    setNodeActionBusy(true);
    try {
      const control = await approveWorkflowReview(reviewApproval.taskId, operatorNote.trim());
      setOperatorNote('');
      setReviewApproval(null);
      setError(null);
      await refreshTaskCatalog();
      continueControlledTask(reviewApproval.taskId, control.event?.sequence);
      addRunEvent('routing', '当前审查员结果已由操作员批准，继续交付');
      return true;
    } catch (caught) {
      setError(userFacingError(caught, '审查员人工批准失败'));
      return false;
    } finally {
      setNodeActionBusy(false);
    }
  }, [addRunEvent, continueControlledTask, nodeActionBusy, operatorNote, refreshTaskCatalog, reviewApproval]);

  const rejectReview = useCallback(async () => {
    if (!reviewApproval || nodeActionBusy) return false;
    const decision = reviewApproval;
    const correctionInstruction = operatorNote.trim() || [
      '根据审查意见重新规划并修正后再次提交质量检查。',
      ...decision.requiredCorrections,
      ...decision.gaps,
    ].filter(Boolean).slice(0, 6).join('\n');
    let rejectionRecorded = false;
    setNodeActionBusy(true);
    try {
      await rejectWorkflowReview(decision.taskId, correctionInstruction);
      rejectionRecorded = true;
      const control = await replanWorkflowTask(decision.taskId, correctionInstruction, false);
      setOperatorNote('');
      setReviewApproval(null);
      setReviewResult(null);
      setAgentActivity('规划 Agent 正在根据审查意见重新安排任务');
      setPhase('routing');
      setError(null);
      await refreshTaskCatalog();
      continueControlledTask(decision.taskId, control.event?.sequence);
      addRunEvent('routing', '审查结果已退回，Agent 开始重新规划并整改');
      return true;
    } catch (caught) {
      setError(userFacingError(caught, rejectionRecorded
        ? '审查结果已退回，但重新规划启动失败；任务保持暂停，可再次操作'
        : '审查结果退回失败'));
      if (rejectionRecorded) {
        setPausedTaskId(decision.taskId);
        setPhase('idle');
      }
      return false;
    } finally {
      setNodeActionBusy(false);
    }
  }, [addRunEvent, continueControlledTask, nodeActionBusy, operatorNote, refreshTaskCatalog, reviewApproval]);

  const approveTool = useCallback(async () => {
    if (!toolApproval || nodeActionBusy) return;
    setNodeActionBusy(true);
    try {
      const control = await approveWorkflowTool(toolApproval.taskId, toolApproval.approval.id, operatorNote.trim());
      setOperatorNote('');
      setToolApproval(null);
      continueControlledTask(toolApproval.taskId, control.event?.sequence);
      addRunEvent('routing', `工具 ${toolApproval.approval.name} 已获批准，继续执行`);
    } catch (caught) {
      setError(userFacingError(caught, '工具批准失败'));
    } finally {
      setNodeActionBusy(false);
    }
  }, [addRunEvent, continueControlledTask, nodeActionBusy, operatorNote, toolApproval]);

  const rejectTool = useCallback(async () => {
    if (!toolApproval || nodeActionBusy) return;
    setNodeActionBusy(true);
    try {
      await rejectWorkflowTool(toolApproval.taskId, toolApproval.approval.id, operatorNote.trim());
      setToolApproval(null);
      setPausedTaskId(toolApproval.taskId);
      addRunEvent('idle', `工具 ${toolApproval.approval.name} 已驳回`);
    } catch (caught) {
      setError(userFacingError(caught, '工具驳回失败'));
    } finally {
      setNodeActionBusy(false);
    }
  }, [addRunEvent, nodeActionBusy, operatorNote, toolApproval]);

  const rejectPlan = useCallback(async () => {
    if (!planApproval || nodeActionBusy) return;
    setNodeActionBusy(true);
    try {
      await rejectWorkflowPlan(planApproval.taskId, operatorNote.trim() || '需要重新规划');
      setPlanApproval(null);
      setPausedTaskId(planApproval.taskId);
      addRunEvent('idle', `计划 v${planApproval.version} 已驳回`);
    } catch (caught) {
      setError(userFacingError(caught, '计划驳回失败'));
    } finally {
      setNodeActionBusy(false);
    }
  }, [addRunEvent, nodeActionBusy, operatorNote, planApproval]);

  const replanTask = useCallback(async () => {
    const taskId = planApproval?.taskId ?? pausedTaskId ?? activeTaskId;
    const instruction = operatorNote.trim();
    if (!taskId || !instruction || nodeActionBusy) return;
    setNodeActionBusy(true);
    try {
      await replanWorkflowTask(taskId, instruction, false);
      setOperatorNote('');
      setPlanApproval(null);
      continueControlledTask(taskId);
      addRunEvent('routing', '已提交重规划指令');
    } catch (caught) {
      setError(userFacingError(caught, '重新规划失败'));
    } finally {
      setNodeActionBusy(false);
    }
  }, [activeTaskId, addRunEvent, continueControlledTask, nodeActionBusy, operatorNote, pausedTaskId, planApproval]);

  const controlNode = useCallback(async (action: 'retry' | 'rerun' | 'skip' | 'complete') => {
    const taskId = activeTaskId ?? pausedTaskId;
    if (!taskId || !selectedNodeId || nodeActionBusy) return;
    setNodeActionBusy(true);
    try {
      await controlWorkflowNode(taskId, selectedNodeId, action, {
        reason: operatorNote.trim(),
        output: action === 'complete' ? operatorNote.trim() || '由操作员确认完成。' : undefined,
      });
      setOperatorNote('');
      continueControlledTask(taskId);
      addRunEvent('routing', `节点 ${selectedNodeId} 已提交 ${action}`);
    } catch (caught) {
      setError(userFacingError(caught, '节点操作失败'));
    } finally {
      setNodeActionBusy(false);
    }
  }, [activeTaskId, addRunEvent, continueControlledTask, nodeActionBusy, operatorNote, pausedTaskId, selectedNodeId]);

  const sendMessage = useCallback(
    async (override?: string, overrideAttachments?: Array<ImageAttachment | FileAttachment>) => {
      const outgoingAttachments = overrideAttachments ?? draftAttachments;
      const content = (override ?? draft).trim() || (outgoingAttachments.length > 0 ? '请分析我上传的附件。' : '');
      if (!content || isRunning) return;

      const userMessage: ChatMessage = {
        id: makeId(),
        role: 'user',
        content,
        createdAt: Date.now(),
        attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
      };
      const assistantId = makeId();
      const requestMessages = [...activeSession.messages, userMessage];
      const title = activeSession.messages.length === 0 ? content.slice(0, 34) : activeSession.title;

      setDraft('');
      setDraftAttachments([]);
      setSelectedTemplateId(null);
      setError(null);
      setFailedTaskId(null);
      setToolApproval(null);
      setUsage({});
      modelUsageEventsRef.current.clear();
      setDurationMs(0);
      setPhase('routing');
      setAgentActivity('路由 Agent 正在识别任务类型');
      setRunEvents([]);
      setCollaborationMessages([]);
      setCollaborationConflicts([]);
      setBudgetConstraints([]);
      collaborationEventKeysRef.current.clear();
      setLoopState({ id: '', iteration: 0, maxIterations: 0, readySteps: [], completedSteps: [], phase: 'idle' });
      setTaskProfile(null);
      setReviewResult(null);
      setIsRunning(true);
      addRunEvent('routing', '语义路由正在识别任务类型');

      updateSession(activeSession.id, (session) => ({
        ...session,
        title,
        messages: [
          ...session.messages,
          userMessage,
          {
            id: assistantId,
            role: 'assistant',
            content: '',
            createdAt: Date.now(),
            pending: true,
          },
        ],
        updatedAt: Date.now(),
      }));

      const controller = new AbortController();
      abortRef.current = controller;
      const hadSubstantiveGraph = Boolean(
        agentGraphRef.current?.nodes.some((node) => node.role !== 'direct-responder')
        || sessionGraphRef.current?.nodes.some((node) => node.role !== 'direct-responder'),
      )
        || topologyAgents.some((agent) => !['direct-responder', 'registry-agent'].includes(agent.role));
      let usedDirectGateway = false;
      let directGraphAgentId: string | null = null;
      let directGraphNodeId: string | null = null;

      const updateDirectGraphNode = (patch: Partial<AgentGraph['nodes'][number]>) => {
        if (!directGraphNodeId) return;
        const displayGraph = agentGraphRef.current;
        if (!displayGraph) return;
        const nextDisplay = {
          ...displayGraph,
          nodes: displayGraph.nodes.map((node) => node.id === directGraphNodeId ? { ...node, ...patch } : node),
        };
        const sessionGraph = sessionGraphRef.current;
        const sessionNode = sessionGraph?.nodes.find((node) => node.id === directGraphNodeId);
        const displayNode = nextDisplay.nodes.find((node) => node.id === directGraphNodeId);
        const nextSession = sessionGraph
          ? sessionNode
            ? {
                ...sessionGraph,
                nodes: sessionGraph.nodes.map((node) => node.id === directGraphNodeId ? { ...node, ...patch } : node),
              }
            : displayNode
              ? {
                  nodes: [...sessionGraph.nodes, displayNode],
                  edges: [
                    ...sessionGraph.edges,
                    ...(sessionGraph.edges.some((edge) => edge.from === 'orchestrator' && edge.to === directGraphNodeId)
                      ? []
                      : [{ from: 'orchestrator', to: directGraphNodeId, kind: 'delegation' as const }]),
                  ],
                }
              : sessionGraph
          : displayNode
            ? {
                nodes: [displayNode],
                edges: [{ from: 'orchestrator', to: directGraphNodeId, kind: 'delegation' as const }],
              }
            : null;
        persistSessionGraph(activeSession.id, nextSession, nextDisplay);
      };

      const appendAssistant = (token: string) => {
        updateSession(activeSession.id, (session) => ({
          ...session,
          messages: session.messages.map((message) =>
            message.id === assistantId ? { ...message, content: message.content + token } : message,
          ),
          updatedAt: Date.now(),
        }));
      };

      try {
        const routing = await routeChatMessage(content, mode, outgoingAttachments, providerSettings.text, controller.signal, {
          messages: requestMessages,
          graph: agentGraphRef.current ?? sessionGraphRef.current,
        });
        // A saved credential can be bound to a durable workflow task. A
        // one-time API key cannot be persisted safely, so those requests stay
        // on the direct gateway compatibility path.
        const usesDirectGateway = routing.execution === 'gateway'
          || (providerSettings.text.useCustom && !providerSettings.text.credentialId);
        usedDirectGateway = usesDirectGateway;
        directGraphAgentId = `${routing.agentRole}-${activeSession.id}`;
        // A conversation may span multiple routed tasks. Keep the graph from
        // earlier turns and let the new task append only the Agents it used;
        // direct turns do not force unrelated workflow Agents to run again.
        const preserveConversationGraph = hadSubstantiveGraph;
        updateSession(activeSession.id, (session) => ({
          ...session,
          messages: session.messages.map((message) => message.id === assistantId
            ? { ...message, agentRole: routing.agentRole, route: routing.workflowRoute }
            : message),
          updatedAt: Date.now(),
        }));
        if (!preserveConversationGraph) {
          persistSessionGraph(activeSession.id, null);
          graphTaskIdRef.current = null;
          setTopologyAgents(usesDirectGateway ? [{
            id: `${routing.agentRole}-${activeSession.id}`,
            label: agentDisplayName(routing.agentRole),
            role: routing.agentRole,
            status: 'running',
            stepId: 'direct-response',
            skillIds: routing.skillIds,
          }] : []);
        } else if (usesDirectGateway) {
          setTopologyAgents((current) => [...current.filter((agent) => !(agent.stepId === 'direct-response' && agent.role === routing.agentRole)), {
            id: `${routing.agentRole}-${activeSession.id}`,
            label: agentDisplayName(routing.agentRole),
            role: routing.agentRole,
            status: 'running' as const,
            stepId: 'direct-response',
            skillIds: routing.skillIds,
          }].slice(-24));
        }
        // A specialist direct turn still participates in the conversation's
        // Agent Graph when a substantive workflow already exists. The current
        // turn's actual direct or specialist Agent becomes visible, while old
        // but unused Agents remain completed and are not executed again.
        if (preserveConversationGraph && usesDirectGateway) {
          const graphAgentTitle = agentDisplayName(routing.agentRole);
          const currentGraph = agentGraphRef.current;
          const existingNode = currentGraph?.nodes.find((node) => node.role === routing.agentRole && node.title === graphAgentTitle);
          const nextDirectGraphNodeId = existingNode?.id ?? `direct-${routing.agentRole}-${assistantId}`;
          directGraphNodeId = nextDirectGraphNodeId;
          if (currentGraph) {
            const existing = currentGraph.nodes.find((node) => node.id === nextDirectGraphNodeId);
            const nextDisplay: AgentGraph = existing
              ? {
                  ...currentGraph,
                  nodes: currentGraph.nodes.map((node) => node.id === nextDirectGraphNodeId
                    ? { ...node, status: 'running' as const, skillIds: routing.skillIds, failureReason: undefined }
                    : node),
                }
              : (() => {
                  const node: AgentGraph['nodes'][number] = {
                    id: nextDirectGraphNodeId,
                    stepId: 'direct-response',
                    agentId: directGraphAgentId ?? `${routing.agentRole}-${activeSession.id}`,
                    role: routing.agentRole,
                    title: graphAgentTitle,
                    dependsOn: [],
                    skillIds: routing.skillIds,
                    status: 'running',
                  };
                  return {
                    nodes: [...currentGraph.nodes, node],
                    edges: currentGraph.edges.some((edge) => edge.from === 'orchestrator' && edge.to === node.id)
                      ? currentGraph.edges
                      : [...currentGraph.edges, { from: 'orchestrator', to: node.id, kind: 'delegation' as const }],
                  };
                })();
            const currentSessionGraph = sessionGraphRef.current;
            const sessionNode = currentSessionGraph?.nodes.find((node) => node.id === nextDirectGraphNodeId);
            const nextSessionGraph: AgentGraph = sessionNode
              ? {
                  ...currentSessionGraph!,
                  nodes: currentSessionGraph!.nodes.map((node) => node.id === nextDirectGraphNodeId
                    ? { ...node, status: 'running' as const, skillIds: routing.skillIds, failureReason: undefined }
                    : node),
                }
              : {
                  nodes: [...(currentSessionGraph?.nodes ?? []), nextDisplay.nodes.find((node) => node.id === nextDirectGraphNodeId)!],
                  edges: [
                    ...(currentSessionGraph?.edges ?? []),
                    ...(currentSessionGraph?.edges.some((edge) => edge.from === 'orchestrator' && edge.to === nextDirectGraphNodeId)
                      ? []
                      : [{ from: 'orchestrator', to: nextDirectGraphNodeId, kind: 'delegation' as const }]),
                  ],
                };
            persistSessionGraph(activeSession.id, nextSessionGraph, nextDisplay);
          }
        }
        addRunEvent('routing', `已分配${agentDisplayName(routing.agentRole)}：${routing.reason}`);
        setAgentActivity(`${agentDisplayName(routing.agentRole)}正在准备执行`);

        if (usedDirectGateway) {
          await streamAgentResponse(
            requestMessages,
            mode,
            activeSession.id,
            controller.signal,
            {
              onStatus: (nextPhase, message) => {
                const validPhase = nextPhase as AgentPhase;
                setPhase(validPhase);
                setAgentActivity(gatewayAgentActivity(routing.agentRole, validPhase, message));
                addRunEvent(validPhase, message);
              },
              onToken: (token) => {
                setAgentActivity(`${agentDisplayName(routing.agentRole)}正在组织回答`);
                appendAssistant(token);
              },
              onReset: () => updateSession(activeSession.id, (session) => ({
                ...session,
                messages: session.messages.map((message) => message.id === assistantId ? { ...message, content: '' } : message),
                updatedAt: Date.now(),
              })),
              onReasoning: () => undefined,
              onAttachment: (attachment) => updateSession(activeSession.id, (session) => ({
                ...session,
                messages: session.messages.map((message) => message.id === assistantId
                  ? { ...message, attachments: [...(message.attachments ?? []), attachment] }
                  : message),
                updatedAt: Date.now(),
              })),
              onComplete: (data) => {
                setPhase('complete');
                setAgentActivity('');
                setDurationMs(data.durationMs);
                setUsage(data.usage ?? {});
                setTopologyAgents((current) => current.map((agent) => agent.id === `${routing.agentRole}-${activeSession.id}`
                  ? {
                    ...agent,
                    status: 'completed' as const,
                    durationMs: data.durationMs,
                    tokens: data.usage?.total_tokens ?? 0,
                  }
                  : agent));
                updateDirectGraphNode({
                  status: 'completed',
                  durationMs: data.durationMs,
                  tokens: data.usage?.total_tokens ?? 0,
                });
                updateSession(activeSession.id, (session) => ({
                  ...session,
                  messages: session.messages.map((message) => message.id === assistantId
                    ? { ...message, agentRole: data.agentRole ?? routing.agentRole, route: data.route ?? routing.intent }
                    : message),
                  updatedAt: Date.now(),
                }));
                addRunEvent('complete', `${agentDisplayName(data.agentRole ?? routing.agentRole)}已完成`);
              },
              onError: (message) => {
                setPhase('error');
                setAgentActivity('');
                const displayMessage = userFacingError(message, '自定义模型请求失败。');
                setError(displayMessage);
                setTopologyAgents((current) => current.map((agent) => agent.id === `${routing.agentRole}-${activeSession.id}`
                  ? { ...agent, status: 'failed' as const, failureReason: displayMessage }
                  : agent));
                updateDirectGraphNode({ status: 'failed', failureReason: displayMessage });
                addRunEvent('error', '自定义模型请求失败');
              },
            },
            providerSettings.text,
            providerSettings.vision,
            providerSettings.image,
            providerSettings.video,
            routing,
          );
        } else {
          const workflowContext = buildConversationContext(requestMessages);
          if (workflowContext.summaryApplied) {
            addRunEvent('context', `已自动整理最早的 ${workflowContext.summarizedMessages} 条消息，保留最新上下文执行。`);
          }
          const workflowInput = workflowContext.messages
            .map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${message.content}`)
            .join('\n\n');
          const startedAt = performance.now();
          const task = await createWorkflowTask({
            sessionId: activeSession.id,
            title,
            prompt: workflowInput,
            mode,
            templateId: selectedTemplateId ?? undefined,
            modelCredentialId: providerSettings.text.useCustom ? providerSettings.text.credentialId : undefined,
            routing,
            signal: controller.signal,
          });
          void refreshTaskCatalog();
          setActiveTaskId(task.id);
          updateSession(activeSession.id, (session) => ({
            ...session,
            activeTaskId: task.id,
            activeAssistantId: assistantId,
            messages: session.messages.map((message) => message.id === assistantId
              ? { ...message, taskId: task.id, agentRole: routing.agentRole, route: routing.workflowRoute }
              : message),
            updatedAt: Date.now(),
          }));
          await streamWorkflowEvents(task.id, controller.signal, (event) => {
            applyWorkflowEvent(event, activeSession.id, assistantId);
          });
          setDurationMs(Math.round(performance.now() - startedAt));
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        const message = userFacingError(caught, '无法连接 Agent 网关。');
        setPhase('error');
        setAgentActivity('');
        setError(message);
        if (usedDirectGateway) {
          setTopologyAgents((current) => current.map((agent) => agent.id === directGraphAgentId
            ? { ...agent, status: 'failed' as const, failureReason: message }
            : agent));
          updateDirectGraphNode({ status: 'failed', failureReason: message });
          updateSession(activeSession.id, (session) => ({
            ...session,
            messages: session.messages.map((item) => item.id === assistantId
              ? { ...item, content: 'Agent 执行中断，未保存不完整回答，请重试。', pending: false }
              : item),
            updatedAt: Date.now(),
          }));
        }
        addRunEvent('error', '网关连接失败');
      } finally {
        if (!controller.signal.aborted) {
          updateSession(activeSession.id, (session) => ({
            ...session,
            messages: session.messages
              .map((message) => (message.id === assistantId ? { ...message, pending: false } : message))
              .filter((message) => message.id !== assistantId || message.content.length > 0),
            updatedAt: Date.now(),
          }));
        }
        setIsRunning(false);
        setAgentActivity('');
        setActiveTaskId(null);
        void refreshTaskCatalog();
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [activeSession, addRunEvent, applyWorkflowEvent, draft, draftAttachments, isRunning, mode, persistSessionGraph, providerSettings.image, providerSettings.text, providerSettings.video, providerSettings.vision, refreshTaskCatalog, selectedTemplateId, topologyAgents, updateSession],
  );

  const retryFailedTask = useCallback(() => {
    if (!failedTaskId || isRunning) return;
    const lastUserMessage = [...activeSession.messages].reverse().find((message) => message.role === 'user');
    if (!lastUserMessage) return;
    void sendMessage(lastUserMessage.content);
  }, [activeSession.messages, failedTaskId, isRunning, sendMessage]);

  const handleImageFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('请选择 PNG、JPEG、WEBP 或其他图片文件。');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('编辑图片不能超过 15 MB。');
      return;
    }
    try {
      setImageData(await readImageAsDataUrl(file));
      setImageFileName(file.name);
      setError(null);
    } catch (caught) {
      setError(userFacingError(caught, '读取图片失败。'));
    }
  };

  const handleConversationAttachments = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const accepted: Array<ImageAttachment | FileAttachment> = [];
    for (const file of Array.from(files).slice(0, 6)) {
      if (file.size > 12 * 1024 * 1024) {
        setError(`文件 ${file.name} 超过 12 MB，已跳过。`);
        continue;
      }
      const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
      const isImage = file.type.startsWith('image/') && !isSvg;
      const isText = file.type.startsWith('text/') || /\.(txt|md|markdown|csv|json|log|svg|html|htm)$/i.test(file.name);
      const isDocument = isText || /\.(pdf|doc|docx)$/i.test(file.name);
      if (!isImage && !isDocument) {
        setError(`暂不支持 ${file.name}，请上传图片、Markdown、SVG、HTML、PDF 或 Word 文件。`);
        continue;
      }
      try {
        if (isImage) {
          const dataUrl = await readFileAsDataUrl(file);
          accepted.push({ id: makeId(), url: dataUrl, alt: file.name });
        } else {
          const text = isText ? (await file.text()).slice(0, 120_000) : undefined;
          const dataUrl = text ? undefined : await readFileAsDataUrl(file);
          accepted.push({ id: makeId(), kind: 'file', name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, dataUrl, text });
        }
      } catch (caught) {
        setError(userFacingError(caught, `读取文件 ${file.name} 失败。`));
      }
    }
    if (accepted.length > 0) {
      setDraftAttachments((current) => [...current, ...accepted].slice(0, 6));
      setError(null);
    }
  };

  const createImage = async () => {
    const prompt = imagePrompt.trim();
    if (!prompt || isGeneratingImage || isRunning || (imageMode === 'edit' && !imageData)) return;

    const userMessage: ChatMessage = {
      id: makeId(),
      role: 'user',
      content: imageMode === 'edit' ? `编辑图片：${prompt}` : `生成图片：${prompt}`,
      createdAt: Date.now(),
    };
    const assistantId = makeId();
    const request: ImageRequest = {
      prompt,
      mode: imageMode,
      size: imageSize,
      quality: imageQuality,
      n: imageCount,
      imageData,
    };

    setError(null);
    setIsGeneratingImage(true);
    setImageComposerOpen(false);
    setImagePrompt('');
    setPhase('routing');
    setRunEvents([]);
    setCollaborationMessages([]);
    setCollaborationConflicts([]);
    setBudgetConstraints([]);
    collaborationEventKeysRef.current.clear();
    addRunEvent('routing', '绘图任务进入媒体网关');
    updateSession(activeSession.id, (session) => ({
      ...session,
      title: session.messages.length === 0 ? prompt.slice(0, 34) : session.title,
      messages: [
        ...session.messages,
        userMessage,
        { id: assistantId, role: 'assistant', content: '', createdAt: Date.now(), pending: true },
      ],
      updatedAt: Date.now(),
    }));

    const controller = new AbortController();
    imageAbortRef.current = controller;
    try {
      const result = await generateImage(request, providerSettings.image, controller.signal);
      updateSession(activeSession.id, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: `已使用 ${result.model} ${imageMode === 'edit' ? '完成图片编辑' : '完成图片生成'}。`,
                attachments: result.images,
                pending: false,
              }
            : message,
        ),
        updatedAt: Date.now(),
      }));
      setPhase('complete');
      setDurationMs(result.durationMs);
      addRunEvent('complete', `已返回 ${result.images.length} 张图片`);
    } catch (caught) {
      if (controller.signal.aborted) return;
      const message = userFacingError(caught, '绘图请求失败。');
      setPhase('error');
      setError(message);
      addRunEvent('error', '绘图请求失败');
      updateSession(activeSession.id, (session) => ({
        ...session,
        messages: session.messages.filter((item) => item.id !== assistantId),
        updatedAt: Date.now(),
      }));
    } finally {
      if (!controller.signal.aborted) {
        setIsGeneratingImage(false);
        imageAbortRef.current = null;
      }
    }
  };

  const newSession = () => {
    if (isRunning) {
      // Starting another conversation detaches this client from the stream;
      // the durable workflow keeps running and can be reattached on return.
      abortRef.current?.abort(new DOMException('Session changed', 'AbortError'));
      imageAbortRef.current?.abort(new DOMException('Session changed', 'AbortError'));
      abortRef.current = null;
      imageAbortRef.current = null;
      setIsRunning(false);
      setIsGeneratingImage(false);
      setActiveTaskId(null);
    }
    resetSessionRuntime();
    setDraftAttachments([]);
    const currentSession = sessions.find((session) => session.id === activeSessionId);
    if (currentSession && !isSessionPersistable(currentSession)) {
      setError(null);
      setSystemPageOpen(false);
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    const session = createSession();
    setSessions((current) => [session, ...current.filter(isSessionPersistable)].slice(0, 18));
    setActiveSessionId(session.id);
    setError(null);
    setSystemPageOpen(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const deleteSession = async (sessionId: string) => {
    try {
      await deleteConversationSession(sessionId);
    } catch (caught) {
      setError(userFacingError(caught, '会话删除失败'));
      return;
    }
    sessionSyncPendingRef.current.delete(sessionId);

    const deletingActive = sessionId === activeSessionId;
    if (deletingActive) {
      // Deleting a conversation must not cancel its durable workflow. Detach
      // only this browser from the event stream; task management remains the
      // source of truth for the running task.
      abortRef.current?.abort(new DOMException('Session deleted', 'AbortError'));
      imageAbortRef.current?.abort(new DOMException('Session deleted', 'AbortError'));
      abortRef.current = null;
      imageAbortRef.current = null;
      setIsRunning(false);
      setIsGeneratingImage(false);
      resetSessionRuntime();
    }
    setSessions((current) => {
      const remaining = current.filter((session) => session.id !== sessionId).sort((a, b) => b.updatedAt - a.updatedAt);
      const next = remaining.length > 0 ? remaining : [createSession()];
      if (deletingActive) setActiveSessionId(next[0]!.id);
      return next;
    });
    // Keep the task board in sync with the deleted conversation. The API has
    // removed its terminal runs; refresh immediately instead of waiting for
    // the polling interval.
    await refreshTaskCatalog();
    window.dispatchEvent(new CustomEvent('axiom:task-catalog-mutated', { detail: { sessionId, kind: 'session-deleted' } }));
  };

  const deleteTask = async (taskId: string, taskIds: string[] = [taskId]) => {
    setTaskCatalogError(null);
    try {
      const ids = [...new Set([taskId, ...taskIds].filter(Boolean))];
      // Delete each represented terminal run. The API keeps its terminal
      // status guard, so an active run is never silently removed.
      for (const id of ids) await deleteWorkflowTask(id);

      setTaskCatalog((current) => current.filter((task) => !ids.includes(task.id)));
      if (activeTaskId && ids.includes(activeTaskId)) setActiveTaskId(null);
      resetSessionRuntime();

      // Fetch the authoritative list after deletion. Do not open a task from
      // the old closure here: that could rehydrate a deleted run into the UI.
      await refreshTaskCatalog();
      window.dispatchEvent(new CustomEvent('axiom:task-catalog-mutated', { detail: { taskIds: ids, kind: 'task-deleted' } }));
      return true;
    } catch (caught) {
      const message = userFacingError(caught, '删除任务失败。');
      setTaskCatalogError(message);
      setError(message);
      return false;
    }
  };

  const copyMessage = async (message: ChatMessage) => {
    await navigator.clipboard.writeText(message.content);
    setCopiedId(message.id);
    window.setTimeout(() => setCopiedId(null), 1400);
  };

  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const pluginShellDraft: PluginShellDraft = {
    name: newPluginName,
    description: newPluginDescription,
    visibility: newPluginVisibility,
    width: newPluginWidth,
    height: newPluginHeight,
    effect: newPluginEffect,
    hue: newPluginHue,
  };
  const updatePluginShellDraft = (patch: Partial<PluginShellDraft>) => {
    if (patch.name !== undefined) setNewPluginName(patch.name);
    if (patch.description !== undefined) setNewPluginDescription(patch.description);
    if (patch.visibility !== undefined) setNewPluginVisibility(patch.visibility);
    if (patch.width !== undefined) setNewPluginWidth(patch.width);
    if (patch.height !== undefined) setNewPluginHeight(patch.height);
    if (patch.effect !== undefined) setNewPluginEffect(patch.effect);
    if (patch.hue !== undefined) setNewPluginHue(patch.hue);
  };

  const activeProvider = topologyAgents[0]?.role === 'vision-agent'
    ? (providerSettings.vision.useCustom ? providerSettings.vision.model || healthInfo.vision.model : healthInfo.vision.model)
    : topologyAgents[0]?.role === 'drawing-agent'
      ? (providerSettings.image.useCustom ? providerSettings.image.model || healthInfo.image.model : healthInfo.image.model)
      : topologyAgents[0]?.role === 'video-agent'
        ? (providerSettings.video.useCustom ? providerSettings.video.model || '本地视频模型' : healthInfo.video.model || '视频服务未配置')
      : (providerSettings.text.useCustom ? providerSettings.text.model || '自定义模型服务' : healthInfo.model);

  return (
    <div className="app-shell" data-theme={uiTheme}>
      <Suspense fallback={<div className="immersive-loading"><Sparkles size={18} />正在加载任务台</div>}>
        <AxiomDashboard
            phase={phase}
            mode={mode}
            onModeChange={setMode}
            draft={draft}
            onDraftChange={setDraft}
            onSend={() => void sendMessage()}
            onNewTask={newSession}
            onOpenSettings={() => setSettingsOpen(true)}
            onRefreshTemplates={refreshTemplates}
            templateWorkspace={<TemplateWorkspace
              templates={workflowTemplates}
              catalog={builtInTemplateCatalog}
              busy={templateBusy}
              error={templateError}
              selectedTemplateId={selectedTemplateId}
              onRefresh={() => { void refreshTemplates(); }}
              onImport={(event) => { void handleTemplateImport(event); }}
              onCreateFromCatalog={(catalogId) => { void createCatalogTemplate(catalogId); }}
              onPublish={(templateId) => { void publishTemplate(templateId); }}
              onShare={(template) => { void updateTemplateVisibility(template); }}
              onExport={(template) => { void handleTemplateExport(template); }}
              onUse={(template) => {
                setSelectedTemplateId(template.id);
                setMode(template.definition.mode);
                useDashboardStore.getState().setNav('tasks');
                window.requestAnimationFrame(() => composerRef.current?.focus());
              }}
            />}
            onOpenPlugins={refreshPlugins}
            pluginWorkspace={<PluginWorkspace
              plugins={userPlugins}
              selectedPlugin={selectedPlugin}
              busy={pluginBusy}
              running={isRunning}
              error={pluginError}
              values={pluginValues}
              freeform={pluginFreeform}
              createOpen={pluginCreateOpen}
              shellDraft={pluginShellDraft}
              designerInput={pluginDesignerInput}
              agentLive={pluginAgentLive}
              onRefresh={() => { void refreshPlugins(); }}
              onSelect={(plugin) => { setSelectedPlugin(plugin); setPluginValues({}); }}
              onOpenMiniApp={setMiniAppPlugin}
              onPublish={(plugin) => { void publishUserPlugin(plugin); }}
              onResize={resizeUserPluginWindow}
              onDelete={deleteUserPlugin}
              onRun={() => { void runSelectedPlugin(); }}
              onValuesChange={setPluginValues}
              onFreeformChange={setPluginFreeform}
              onOpenCreate={() => {
                setPluginCreateOpen(true);
                setPluginError(null);
              }}
              onCloseCreate={() => setPluginCreateOpen(false)}
              onShellDraftChange={updatePluginShellDraft}
              onCreateShell={() => { void createUserPluginShell(); }}
              onDesignerInputChange={setPluginDesignerInput}
              onDesignWithAgent={() => { void designUserPluginWithAgent(); }}
            />}
            onOpenReadiness={() => setReadinessOpen(true)}
            onStop={stopRun}
            onPause={() => void pauseRun()}
            onResume={() => void resumeRun()}
            isRunning={isRunning}
            agentActivity={agentActivity}
            theme={uiTheme}
            agents={topologyAgents}
            graph={agentGraph}
            selectedNodeId={selectedNodeId}
            onSelectAgent={(agentId) => { setSelectedNodeId(agentId); setInspectorView('graph'); }}
            taskProfile={taskProfile}
            reviewResult={reviewResult}
            reviewApprovalTaskId={reviewApproval?.taskId ?? null}
            reviewNote={operatorNote}
            reviewActionBusy={nodeActionBusy}
            onReviewNoteChange={setOperatorNote}
            onApproveReview={approveReview}
            onRejectReview={rejectReview}
            taskCatalog={taskCatalog}
            onOpenTask={(taskId) => { void openCatalogTask({ id: taskId }); }}
            onDeleteTask={deleteTask}
            sessionId={activeSession.id}
            sessions={sessions}
            activeSession={activeSession}
            onSelectSession={(sessionId) => {
              useDashboardStore.getState().setNav('chat');
              if (sessionId === activeSessionId) return;
              abortRef.current?.abort(new DOMException('Session changed', 'AbortError'));
              abortRef.current = null;
              setIsRunning(false);
              setActiveSessionId(sessionId);
              setError(null);
              setSelectedNodeId(null);
              agentGraphRef.current = null;
              setAgentGraph(null);
              setTopologyAgents([]);
              const selectedSession = sessions.find((session) => session.id === sessionId);
              const runtimeTaskId = selectedSession ? runtimeTaskIdForSession(selectedSession, taskCatalog) : undefined;
              if (selectedSession) sessionRestoreKeyRef.current = `${selectedSession.id}:${runtimeTaskId ?? 'direct'}`;
              if (runtimeTaskId && selectedSession) void openCatalogTask({ id: runtimeTaskId }, selectedSession);
              else if (selectedSession) restoreDirectSessionRuntime(selectedSession);
              else { setTaskProfile(null); setReviewResult(null); setAgentGraph(null); setTopologyAgents([]); }
            }}
            onDeleteSession={deleteSession}
            attachments={draftAttachments}
            onAddAttachments={(files) => void handleConversationAttachments(files)}
            onRemoveAttachment={(id) => setDraftAttachments((current) => current.filter((attachment) => attachment.id !== id))}
            error={error}
            readiness={readiness.state}
            provider={activeProvider}
            onThemeChange={setUiTheme}
          />
      </Suspense>

      {imageComposerOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setImageComposerOpen(false)}>
          <section
            className="modal-panel image-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="image-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">绘图运行态</span>
                <h2 id="image-dialog-title">绘图与图片编辑</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭绘图工具"
                data-tooltip="关闭"
                onClick={() => setImageComposerOpen(false)}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>

            <div className="image-mode-control" role="group" aria-label="图片任务类型">
              <button
                type="button"
                className={imageMode === 'generate' ? 'active' : ''}
                onClick={() => {
                  setImageMode('generate');
                  setImageData(undefined);
                  setImageFileName('');
                }}
              >
                文生图
              </button>
              <button
                type="button"
                className={imageMode === 'edit' ? 'active' : ''}
                onClick={() => setImageMode('edit')}
              >
                编辑图片
              </button>
            </div>

            <label className="field-label" htmlFor="image-prompt">描述你想要的画面</label>
            <textarea
              id="image-prompt"
              className="field-control image-prompt"
              value={imagePrompt}
              onChange={(event) => setImagePrompt(event.target.value)}
              placeholder={imageMode === 'edit' ? '例如：保留主体，把背景改成霓虹城市夜景' : '例如：一座悬浮在云海上的赛博朋克控制室'}
              rows={4}
            />

            {imageMode === 'edit' && (
              <label className="upload-control">
                <Upload size={16} aria-hidden="true" />
                <span>{imageFileName || '选择要编辑的图片'}</span>
                <input type="file" accept="image/*" onChange={(event) => void handleImageFile(event)} />
              </label>
            )}

            <div className="field-grid">
              <label className="field-label">
                尺寸
                <select className="field-control" value={imageSize} onChange={(event) => setImageSize(event.target.value)}>
                  <option value="1024x1024">1:1 · 1K</option>
                  <option value="1280x720">16:9 · 1K</option>
                  <option value="1920x1080">16:9 · 2K</option>
                  <option value="2048x2048">1:1 · 2K</option>
                  <option value="2160x3840">9:16 · 4K</option>
                </select>
              </label>
              <label className="field-label">
                质量
                <select
                  className="field-control"
                  value={imageQuality}
                  onChange={(event) => setImageQuality(event.target.value as ImageRequest['quality'])}
                >
                  <option value="auto">自动</option>
                  <option value="low">快速</option>
                  <option value="medium">标准</option>
                  <option value="high">高质量</option>
                </select>
              </label>
              <label className="field-label">
                数量
                <select className="field-control" value={imageCount} onChange={(event) => setImageCount(Number(event.target.value))}>
                  <option value={1}>1 张</option>
                  <option value={2}>2 张</option>
                  <option value={3}>3 张</option>
                  <option value={4}>4 张</option>
                </select>
              </label>
            </div>

            <div className="modal-actions">
              <span className="modal-hint">当前会话模型不影响绘图模型</span>
              <button
                className="primary-action"
                type="button"
                onClick={() => void createImage()}
                disabled={!imagePrompt.trim() || (imageMode === 'edit' && !imageData) || isGeneratingImage}
              >
                <Sparkles size={16} aria-hidden="true" />
                {isGeneratingImage ? '生成中...' : imageMode === 'edit' ? '开始编辑' : '开始绘图'}
              </button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section
            className="modal-panel settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">模型服务</span>
                <h2 id="settings-dialog-title">模型配置</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭设置"
                data-tooltip="关闭"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>

            <div className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <strong>文本模型</strong>
                  <span>{providerSettings.text.useCustom ? `使用${providerSettings.text.location === 'local' ? '本地服务' : '互联网 API'}` : `默认使用 ${healthInfo.model}`}</span>
                </div>
                <div className="settings-section-controls">
                  <ProviderLocationControl value={providerSettings.text.location} disabled={!providerSettings.text.useCustom} onChange={(location) => setProviderSettings((current) => ({ ...current, text: { ...current.text, location } }))} />
                  <label className="switch-control">
                    <input
                      type="checkbox"
                      checked={providerSettings.text.useCustom}
                      onChange={(event) =>
                        setProviderSettings((current) => ({
                          ...current,
                          text: { ...current.text, useCustom: event.target.checked },
                        }))
                      }
                    />
                    <span />
                  </label>
                  <ProviderVaultAction kind="text" name="文本模型" settings={providerSettings.text} state={providerSaveState.text} onSave={saveProvider} />
                </div>
              </div>
              <div className="settings-fields">
                <label className="field-label">
                  API URL
                  <input
                    className="field-control"
                    type="url"
                    value={providerSettings.text.apiUrl}
                    onChange={(event) =>
                      setProviderSettings((current) => ({
                        ...current,
                        text: { ...current.text, apiUrl: event.target.value },
                      }))
                    }
                    placeholder={providerSettings.text.location === 'local' ? 'http://127.0.0.1:11434/v1' : healthInfo.apiBase}
                  />
                </label>
                <label className="field-label">
                  API Key{providerSettings.text.location === 'local' ? '（可选）' : ''}
                  <span className="field-input-wrap">
                    <KeyRound size={14} aria-hidden="true" />
                    <input
                      className="field-control"
                      type="password"
                      value={providerSettings.text.apiKey}
                      onChange={(event) =>
                        setProviderSettings((current) => ({
                          ...current,
                          text: { ...current.text, apiKey: event.target.value },
                        }))
                      }
                      placeholder={providerSettings.text.location === 'local' ? '本地服务无需密钥时留空' : '输入互联网 API 密钥'}
                      autoComplete="off"
                    />
                  </span>
                </label>
                <label className="field-label">
                  模型名称
                  <input
                    className="field-control"
                    value={providerSettings.text.model}
                    onChange={(event) =>
                      setProviderSettings((current) => ({
                        ...current,
                        text: { ...current.text, model: event.target.value },
                      }))
                    }
                    placeholder={healthInfo.model}
                  />
                </label>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <strong>视觉模型</strong>
                  <span>{providerSettings.vision.useCustom ? `使用${providerSettings.vision.location === 'local' ? '本地服务' : '互联网 API'}` : healthInfo.vision.configured ? `默认使用 ${healthInfo.vision.model}` : '服务端视觉模型未就绪'}</span>
                </div>
                <div className="settings-section-controls">
                  <ProviderLocationControl value={providerSettings.vision.location} disabled={!providerSettings.vision.useCustom} onChange={(location) => setProviderSettings((current) => ({ ...current, vision: { ...current.vision, location } }))} />
                  <label className="switch-control">
                    <input type="checkbox" checked={providerSettings.vision.useCustom} onChange={(event) => setProviderSettings((current) => ({ ...current, vision: { ...current.vision, useCustom: event.target.checked } }))} />
                    <span />
                  </label>
                  <ProviderVaultAction kind="vision" name="视觉模型" settings={providerSettings.vision} state={providerSaveState.vision} onSave={saveProvider} />
                </div>
              </div>
              <div className="settings-fields">
                <label className="field-label">API URL<input className="field-control" type="url" value={providerSettings.vision.apiUrl} onChange={(event) => setProviderSettings((current) => ({ ...current, vision: { ...current.vision, apiUrl: event.target.value } }))} placeholder={providerSettings.vision.location === 'local' ? 'http://127.0.0.1:11434/v1' : healthInfo.vision.apiBase} /></label>
                <label className="field-label">API Key{providerSettings.vision.location === 'local' ? '（可选）' : ''}<span className="field-input-wrap"><KeyRound size={14} aria-hidden="true" /><input className="field-control" type="password" value={providerSettings.vision.apiKey} onChange={(event) => setProviderSettings((current) => ({ ...current, vision: { ...current.vision, apiKey: event.target.value } }))} placeholder={providerSettings.vision.location === 'local' ? '本地服务无需密钥时留空' : '输入互联网 API 密钥'} autoComplete="off" /></span></label>
                <label className="field-label">模型名称<input className="field-control" value={providerSettings.vision.model} onChange={(event) => setProviderSettings((current) => ({ ...current, vision: { ...current.vision, model: event.target.value } }))} placeholder={healthInfo.vision.model} /></label>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <strong>绘图模型</strong>
                  <span>{providerSettings.image.useCustom ? `使用${providerSettings.image.location === 'local' ? '本地服务' : '互联网 API'}` : healthInfo.image.configured ? `默认使用 ${healthInfo.image.model}` : '未配置服务端绘图密钥'}</span>
                </div>
                <div className="settings-section-controls">
                  <ProviderLocationControl value={providerSettings.image.location} disabled={!providerSettings.image.useCustom} onChange={(location) => setProviderSettings((current) => ({ ...current, image: { ...current.image, location } }))} />
                  <label className="switch-control">
                    <input
                      type="checkbox"
                      checked={providerSettings.image.useCustom}
                      onChange={(event) =>
                        setProviderSettings((current) => ({
                          ...current,
                          image: { ...current.image, useCustom: event.target.checked },
                        }))
                      }
                    />
                    <span />
                  </label>
                  <ProviderVaultAction kind="image" name="绘图模型" settings={providerSettings.image} state={providerSaveState.image} onSave={saveProvider} />
                </div>
              </div>
              <div className="settings-fields">
                <label className="field-label">
                  API URL
                  <input
                    className="field-control"
                    type="url"
                    value={providerSettings.image.apiUrl}
                    onChange={(event) =>
                      setProviderSettings((current) => ({
                        ...current,
                        image: { ...current.image, apiUrl: event.target.value },
                      }))
                    }
                    placeholder={providerSettings.image.location === 'local' ? 'http://127.0.0.1:7860/v1' : healthInfo.image.apiBase}
                  />
                </label>
                <label className="field-label">
                  API Key{providerSettings.image.location === 'local' ? '（可选）' : ''}
                  <span className="field-input-wrap">
                    <KeyRound size={14} aria-hidden="true" />
                    <input
                      className="field-control"
                      type="password"
                      value={providerSettings.image.apiKey}
                      onChange={(event) =>
                        setProviderSettings((current) => ({
                          ...current,
                          image: { ...current.image, apiKey: event.target.value },
                        }))
                      }
                      placeholder={providerSettings.image.location === 'local' ? '本地服务无需密钥时留空' : '输入互联网 API 密钥'}
                      autoComplete="off"
                    />
                  </span>
                </label>
                <label className="field-label">
                  模型名称
                  <input
                    className="field-control"
                    value={providerSettings.image.model}
                    onChange={(event) =>
                      setProviderSettings((current) => ({
                        ...current,
                        image: { ...current.image, model: event.target.value },
                      }))
                    }
                    placeholder={healthInfo.image.model}
                  />
                </label>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-heading">
                <div>
                  <strong>视频模型</strong>
                  <span>{providerSettings.video.useCustom ? `使用${providerSettings.video.location === 'local' ? '本地服务' : '互联网 API'}` : healthInfo.video.configured ? `默认使用 ${healthInfo.video.model}` : '尚未配置，视频制作 Agent 暂不可用'}</span>
                </div>
                <div className="settings-section-controls">
                  <ProviderLocationControl value={providerSettings.video.location} disabled={!providerSettings.video.useCustom} onChange={(location) => setProviderSettings((current) => ({ ...current, video: { ...current.video, location } }))} />
                  <label className="switch-control">
                    <input type="checkbox" checked={providerSettings.video.useCustom} onChange={(event) => setProviderSettings((current) => ({ ...current, video: { ...current.video, useCustom: event.target.checked } }))} />
                    <span />
                  </label>
                  <ProviderVaultAction kind="video" name="视频模型" settings={providerSettings.video} state={providerSaveState.video} onSave={saveProvider} />
                </div>
              </div>
              <div className="settings-fields">
                <label className="field-label">API URL<input className="field-control" type="url" value={providerSettings.video.apiUrl} onChange={(event) => setProviderSettings((current) => ({ ...current, video: { ...current.video, apiUrl: event.target.value } }))} placeholder={providerSettings.video.location === 'local' ? 'http://127.0.0.1:端口' : healthInfo.video.apiBase || 'https://api.example.com'} /></label>
                <label className="field-label">API Key（可选）<span className="field-input-wrap"><KeyRound size={14} aria-hidden="true" /><input className="field-control" type="password" value={providerSettings.video.apiKey} onChange={(event) => setProviderSettings((current) => ({ ...current, video: { ...current.video, apiKey: event.target.value } }))} placeholder={providerSettings.video.location === 'local' ? '本地服务无需密钥时留空' : '输入互联网 API 密钥'} autoComplete="off" /></span></label>
                <label className="field-label">模型名称<input className="field-control" value={providerSettings.video.model} onChange={(event) => setProviderSettings((current) => ({ ...current, video: { ...current.video, model: event.target.value } }))} placeholder={healthInfo.video.model || '填写本地视频模型名称'} /></label>
              </div>
            </div>

            <div className="settings-notice">
              <KeyRound size={14} aria-hidden="true" />
              API Key 默认仅用于当前请求；点击“安全保存凭据”后会加密保存在服务端，浏览器只保留引用 ID。
            </div>
            {providerSaveMessage && <div className="settings-notice provider-save-message"><ShieldCheck size={14} aria-hidden="true" />{providerSaveMessage}</div>}
            <div className="modal-actions">
              <span className="modal-hint">系统会自动选择任务所需的模型</span>
              <button className="primary-action" type="button" onClick={() => setSettingsOpen(false)}>
                <Check size={16} aria-hidden="true" />
                应用设置
              </button>
            </div>
          </section>
        </div>
      )}

      {artifactPreview && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setArtifactPreview(null)}>
          <section className="modal-panel artifact-panel" role="dialog" aria-modal="true" aria-labelledby="artifact-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">结果 Artifact</span>
                <h2 id="artifact-dialog-title">{artifactPreview.title}</h2>
              </div>
              <button className="icon-button" type="button" aria-label="关闭 Artifact" data-tooltip="关闭" onClick={() => setArtifactPreview(null)}><X size={17} aria-hidden="true" /></button>
            </div>
            <div className="artifact-meta"><FileClock size={13} /> {artifactPreview.taskId.slice(0, 8).toUpperCase()} · 持久化结果</div>
            <div className="artifact-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{artifactPreview.content || 'Artifact 没有可显示内容。'}</ReactMarkdown></div>
          </section>
        </div>
      )}

      {readinessOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setReadinessOpen(false)}>
          <section
            className="modal-panel readiness-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="readiness-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">实时检测</span>
                <h2 id="readiness-dialog-title">系统运行状态</h2>
              </div>
              <button className="icon-button" type="button" aria-label="关闭系统运行状态" data-tooltip="关闭" onClick={() => setReadinessOpen(false)}>
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            <div className={`readiness-hero ${readiness.state}`}>
              <div className="readiness-hero-icon"><ShieldCheck size={22} aria-hidden="true" /></div>
              <div><strong>{readinessLabels[readiness.state]}</strong><span>{readiness.state === 'ready' ? '所有主要服务均已通过实时检测。' : readiness.state === 'degraded' ? '可以继续使用，少数增强能力尚未开启。' : '请先处理下方标红的服务。'}</span></div>
            </div>
            <div className="readiness-overview-grid">
              {readinessOverview(readiness).map((item) => <div className={`readiness-overview-item ${item.state}`} key={item.id}>
                <span className="check-led" /><div><strong>{item.label}</strong><p>{item.detail}</p></div><span>{readinessStateLabel(item.state)}</span>
              </div>)}
            </div>
            <details className="readiness-technical">
              <summary>查看技术详情</summary>
              <div className="readiness-grid">
                {readiness.checks.map((check) => <div className={`readiness-check ${check.state}`} key={check.id}>
                  <div className="readiness-check-top"><span className="check-led" /><strong>{check.label}</strong><span className="check-state">{readinessStateLabel(check.state)}</span></div>
                  <p>{check.detail}</p>
                  {check.required && <span className="required-mark">上线前需处理</span>}
                </div>)}
              </div>
              {readiness.tools && readiness.tools.length > 0 && <section className="tool-registry-panel" aria-label="工具注册表">
                <div className="tool-registry-heading"><strong>可用工具</strong><span>{readiness.tools.length} 个</span></div>
                <div className="tool-registry-list">{readiness.tools.map((tool) => <div className="tool-registry-item" key={tool.name}>
                  <div><strong>{tool.name}</strong><small>{tool.description}</small></div>
                  <span className={`tool-risk ${tool.risk}`}>{tool.risk === 'low' ? '低风险' : tool.risk === 'medium' ? '中风险' : tool.risk === 'high' ? '高风险' : '严重风险'}{tool.approvalRequired ? ' · 需确认' : ''}</span>
                </div>)}</div>
              </section>}
            </details>
            <div className="readiness-footer"><Database size={13} aria-hidden="true" /><span>{readiness.blockers.length ? `${readiness.blockers.length} 项需要处理` : '主要服务已通过检测'}</span></div>
          </section>
        </div>
      )}
      {miniAppPlugin && <MiniAppWindow plugin={miniAppPlugin} onClose={() => setMiniAppPlugin(null)} onAgentRequest={runMiniAppAgentRequest} />}
    </div>
  );
}

export default App;
