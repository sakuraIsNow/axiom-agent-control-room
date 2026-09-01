import { z } from 'zod';
import { agentCatalog } from './agentCatalog.js';
import { workflowSpecialistCatalog } from './workflowSpecialists.js';
import type {
  AgentGraph,
  AgentWorkflowCanvas,
  AgentWorkflowEdge,
  AgentWorkflowNode,
  UserDefinedAgent,
  WorkflowPlan,
  WorkflowStep,
  WorkflowStepAgentContract,
} from './contracts.js';

const safeId = z.string().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
const pointSchema = z.object({
  x: z.number().finite().min(-20_000).max(20_000),
  y: z.number().finite().min(-20_000).max(20_000),
}).strict();

export const agentWorkflowCanvasSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(z.object({
    id: safeId,
    type: z.enum(['input', 'agent', 'output']),
    name: z.string().min(1).max(120),
    description: z.string().max(1_000).optional(),
    position: pointSchema,
    agentRef: z.object({ source: z.enum(['builtin', 'platform', 'workflow']), id: z.string().min(1).max(160) }).strict().optional(),
    objective: z.string().max(4_000).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(500)).max(8).optional(),
    model: z.string().min(1).max(160).optional(),
    toolNames: z.array(z.string().min(1).max(80)).max(32).optional(),
    writeScopes: z.array(z.string().min(1).max(240)).max(16).optional(),
    maxTokens: z.number().int().min(128).max(1_000_000).optional(),
    maxDurationMs: z.number().int().min(1_000).max(3_600_000).optional(),
    failureStrategy: z.enum(['retry', 'skip', 'pause']).optional(),
    icon: z.string().max(16).optional(),
  }).strict()).min(3).max(24),
  edges: z.array(z.object({
    id: safeId,
    source: safeId,
    target: safeId,
    kind: z.enum(['flow', 'loop', 'condition']),
    maxIterations: z.number().int().min(2).max(12).optional(),
    loopId: safeId.optional(),
    condition: z.object({
      expression: z.string().min(1).max(500),
      branch: z.enum(['true', 'false']),
    }).strict().optional(),
  }).strict()).min(2).max(64),
  scopedAgents: z.array(z.object({
    id: safeId,
    roleId: safeId,
    name: z.string().min(1).max(120),
    description: z.string().max(1_000).default(''),
    systemPromptTemplate: z.string().min(1).max(8_000),
    toolAllowlist: z.array(z.string().min(1).max(80)).max(32).default([]),
    model: z.string().min(1).max(160).optional(),
    maxTokens: z.number().int().min(128).max(1_000_000).optional(),
    maxDurationMs: z.number().int().min(1_000).max(3_600_000).optional(),
    failureStrategy: z.enum(['retry', 'skip', 'pause']).optional(),
    icon: z.string().max(16).optional(),
  }).strict()).max(20),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().min(0.35).max(2),
  }).strict().optional(),
}).strict();

export type WorkflowValidationIssue = {
  code: string;
  message: string;
  nodeIds?: string[];
  edgeIds?: string[];
};

export type CompileWorkflowResult = {
  plan: WorkflowPlan;
  issues: WorkflowValidationIssue[];
};

const reachableFrom = (start: string, outgoing: Map<string, AgentWorkflowEdge[]>) => {
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of outgoing.get(current) ?? []) queue.push(edge.target);
  }
  return visited;
};

const ancestorsOf = (start: string, incoming: Map<string, AgentWorkflowEdge[]>) => {
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of incoming.get(current) ?? []) queue.push(edge.source);
  }
  return visited;
};

const hasCycle = (nodeIds: string[], outgoing: Map<string, AgentWorkflowEdge[]>) => {
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (nodeId: string): boolean => {
    const current = state.get(nodeId) ?? 0;
    if (current === 1) return true;
    if (current === 2) return false;
    state.set(nodeId, 1);
    for (const edge of outgoing.get(nodeId) ?? []) if (visit(edge.target)) return true;
    state.set(nodeId, 2);
    return false;
  };
  return nodeIds.some((nodeId) => visit(nodeId));
};

const mapEdges = (edges: AgentWorkflowEdge[], key: 'source' | 'target') => {
  const result = new Map<string, AgentWorkflowEdge[]>();
  for (const edge of edges) result.set(edge[key], [...(result.get(edge[key]) ?? []), edge]);
  return result;
};

const addIssue = (issues: WorkflowValidationIssue[], code: string, message: string, extras: Partial<WorkflowValidationIssue> = {}) => {
  issues.push({ code, message, ...extras });
};

const resolveAgent = (
  node: AgentWorkflowNode,
  canvas: AgentWorkflowCanvas,
  platformAgents: UserDefinedAgent[],
  availableTools: Set<string>,
  issues: WorkflowValidationIssue[],
) => {
  if (!node.agentRef) {
    addIssue(issues, 'agent-reference-required', `Agent“${node.name}”尚未选择智能体。`, { nodeIds: [node.id] });
    return null;
  }
  const { source, id } = node.agentRef;
  if (source === 'builtin') {
    const agent = [...agentCatalog, ...workflowSpecialistCatalog()].find((candidate) => candidate.id === id);
    if (!agent) {
      addIssue(issues, 'builtin-agent-not-found', `内置 Agent“${id}”不存在。`, { nodeIds: [node.id] });
      return null;
    }
    if ('available' in agent && !agent.available) {
      addIssue(issues, 'specialist-unavailable', agent.unavailableReason ?? `服务 Agent“${agent.label}”当前不可用。`, { nodeIds: [node.id] });
      return null;
    }
    const requestedTools = node.toolNames ?? [];
    const missing = requestedTools.filter((name) => !availableTools.has(name));
    if (missing.length) addIssue(issues, 'tool-not-found', `Agent“${node.name}”引用了不可用能力：${missing.join('、')}。`, { nodeIds: [node.id] });
    return {
      roleId: agent.role,
      model: node.model,
      maxTokens: node.maxTokens,
      maxDurationMs: node.maxDurationMs,
      failureStrategy: node.failureStrategy,
      tools: requestedTools.filter((name) => availableTools.has(name)),
      contract: { source, agentId: agent.id, displayName: agent.label, toolAllowlist: requestedTools } satisfies WorkflowStepAgentContract,
    };
  }
  if (source === 'platform') {
    const agent = platformAgents.find((candidate) => candidate.id === id && candidate.status === 'published');
    if (!agent) {
      addIssue(issues, 'platform-agent-not-found', '所选平台 Agent 不存在、未发布或当前用户不可见。', { nodeIds: [node.id] });
      return null;
    }
    const selected = node.toolNames ?? agent.definition.toolAllowlist;
    const tools = selected.filter((name) => agent.definition.toolAllowlist.includes(name) && availableTools.has(name));
    if (tools.length !== selected.length) addIssue(issues, 'tool-not-allowed', `Agent“${node.name}”包含未授权或不可用能力。`, { nodeIds: [node.id] });
    return {
      roleId: agent.roleId,
      model: node.model ?? agent.definition.defaultModel,
      maxTokens: node.maxTokens ?? agent.definition.maxTokensDefault,
      maxDurationMs: node.maxDurationMs ?? agent.definition.maxDurationMsDefault,
      failureStrategy: node.failureStrategy ?? agent.definition.failureStrategyDefault,
      tools,
      contract: {
        source,
        agentId: agent.id,
        displayName: agent.name,
        systemPromptTemplate: agent.definition.systemPromptTemplate,
        toolAllowlist: tools,
      } satisfies WorkflowStepAgentContract,
    };
  }
  const scoped = canvas.scopedAgents.find((candidate) => candidate.id === id);
  if (!scoped) {
    addIssue(issues, 'scoped-agent-not-found', '所选工作流私有 Agent 不存在。', { nodeIds: [node.id] });
    return null;
  }
  const selected = node.toolNames ?? scoped.toolAllowlist;
  const tools = selected.filter((name) => scoped.toolAllowlist.includes(name) && availableTools.has(name));
  if (tools.length !== selected.length) addIssue(issues, 'tool-not-allowed', `Agent“${node.name}”包含未授权或不可用能力。`, { nodeIds: [node.id] });
  return {
    roleId: scoped.roleId,
    model: node.model ?? scoped.model,
    maxTokens: node.maxTokens ?? scoped.maxTokens,
    maxDurationMs: node.maxDurationMs ?? scoped.maxDurationMs,
    failureStrategy: node.failureStrategy ?? scoped.failureStrategy,
    tools,
    contract: {
      source,
      agentId: scoped.id,
      displayName: scoped.name,
      systemPromptTemplate: scoped.systemPromptTemplate,
      toolAllowlist: tools,
    } satisfies WorkflowStepAgentContract,
  };
};

export const compileAgentWorkflow = (
  canvas: AgentWorkflowCanvas,
  platformAgents: UserDefinedAgent[],
  toolNames: string[],
): CompileWorkflowResult => {
  const issues: WorkflowValidationIssue[] = [];
  const nodeById = new Map(canvas.nodes.map((node) => [node.id, node]));
  if (nodeById.size !== canvas.nodes.length) addIssue(issues, 'duplicate-node-id', '工作流包含重复 Agent ID。');
  const edgeIds = new Set(canvas.edges.map((edge) => edge.id));
  if (edgeIds.size !== canvas.edges.length) addIssue(issues, 'duplicate-edge-id', '工作流包含重复连线 ID。');
  const inputs = canvas.nodes.filter((node) => node.type === 'input');
  const outputs = canvas.nodes.filter((node) => node.type === 'output');
  if (inputs.length !== 1) addIssue(issues, 'single-input-required', '工作流必须且只能有一个输入端。', { nodeIds: inputs.map((node) => node.id) });
  if (outputs.length !== 1) addIssue(issues, 'single-output-required', '工作流必须且只能有一个输出端。', { nodeIds: outputs.map((node) => node.id) });

  for (const edge of canvas.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) addIssue(issues, 'edge-endpoint-not-found', '连接指向了不存在的 Agent 或端点。', { edgeIds: [edge.id] });
    if (edge.source === edge.target) addIssue(issues, 'self-edge', 'Agent 不能连接到自身。', { edgeIds: [edge.id] });
  }
  const pairKeys = new Set<string>();
  for (const edge of canvas.edges) {
    const key = `${edge.kind}:${edge.source}:${edge.target}`;
    if (pairKeys.has(key)) addIssue(issues, 'duplicate-edge', '工作流包含重复连线。', { edgeIds: [edge.id] });
    pairKeys.add(key);
  }

  const flowEdges = canvas.edges.filter((edge) => (edge.kind === 'flow' || edge.kind === 'condition') && nodeById.has(edge.source) && nodeById.has(edge.target));
  const loopEdges = canvas.edges.filter((edge) => edge.kind === 'loop' && nodeById.has(edge.source) && nodeById.has(edge.target));
  for (const edge of canvas.edges.filter((candidate) => candidate.kind === 'condition')) {
    if (!edge.condition?.expression?.trim()) addIssue(issues, 'condition-expression-required', 'Condition branch requires an expression.', { edgeIds: [edge.id] });
    if (edge.condition?.expression && !/^[\w\s().,'"=!<>:+\-*/?&|\u4e00-\u9fff]{1,500}$/.test(edge.condition.expression)) {
      addIssue(issues, 'condition-expression-unsafe', 'Condition expression contains unsupported characters.', { edgeIds: [edge.id] });
    }
  }
  const outgoing = mapEdges(flowEdges, 'source');
  const incoming = mapEdges(flowEdges, 'target');
  if (hasCycle(canvas.nodes.map((node) => node.id), outgoing)) addIssue(issues, 'flow-cycle', '普通连线必须是无环图；循环请使用 Loop 回边。');

  const input = inputs[0];
  const output = outputs[0];
  if (input && (incoming.get(input.id)?.length ?? 0) > 0) addIssue(issues, 'input-has-incoming', '输入端不能有入线。', { nodeIds: [input.id] });
  if (output && (outgoing.get(output.id)?.length ?? 0) > 0) addIssue(issues, 'output-has-outgoing', '输出端不能有出线。', { nodeIds: [output.id] });
  if (input) {
    const reachable = reachableFrom(input.id, outgoing);
    const orphaned = canvas.nodes.filter((node) => !reachable.has(node.id));
    if (orphaned.length) addIssue(issues, 'orphaned-node', `存在无法从输入到达的 Agent：${orphaned.map((node) => node.name).join('、')}。`, { nodeIds: orphaned.map((node) => node.id) });
    if (output && !reachable.has(output.id)) addIssue(issues, 'output-unreachable', '输出端无法从输入端到达。', { nodeIds: [output.id] });
  }
  for (const node of canvas.nodes.filter((candidate) => candidate.type === 'agent')) {
    if (!(incoming.get(node.id)?.length)) addIssue(issues, 'agent-missing-input', `Agent“${node.name}”没有输入连线。`, { nodeIds: [node.id] });
    if (!(outgoing.get(node.id)?.length)) addIssue(issues, 'agent-missing-output', `Agent“${node.name}”没有输出连线。`, { nodeIds: [node.id] });
  }

  const loops: Array<{ edge: AgentWorkflowEdge; id: string; members: Set<string>; maxIterations: number }> = [];
  for (const loopEdge of loopEdges) {
    const sourceNode = nodeById.get(loopEdge.source);
    const targetNode = nodeById.get(loopEdge.target);
    if (sourceNode?.type !== 'agent' || targetNode?.type !== 'agent') addIssue(issues, 'loop-agent-endpoints', 'Loop 回边的起点和终点都必须是 Agent。', { edgeIds: [loopEdge.id] });
    const descendants = reachableFrom(loopEdge.target, outgoing);
    const ancestors = ancestorsOf(loopEdge.source, incoming);
    const members = new Set([...descendants].filter((id) => ancestors.has(id) && nodeById.get(id)?.type === 'agent'));
    if (!descendants.has(loopEdge.source) || members.size === 0) addIssue(issues, 'invalid-loop-path', 'Loop 回边必须返回到其上游 Agent，并形成一段可执行路径。', { edgeIds: [loopEdge.id] });
    const leaking = [...members].flatMap((id) => outgoing.get(id) ?? []).filter((edge) => !members.has(edge.target) && edge.source !== loopEdge.source && nodeById.get(edge.target)?.type !== 'output');
    if (leaking.length) addIssue(issues, 'loop-side-exit', 'Loop 内部只能从回边起点离开循环，以保证每轮输出确定。', { edgeIds: leaking.map((edge) => edge.id) });
    if (descendants.has(loopEdge.source) && members.size > 0) loops.push({ edge: loopEdge, id: loopEdge.loopId ?? loopEdge.id, members, maxIterations: loopEdge.maxIterations ?? 2 });
  }
  for (let index = 0; index < loops.length; index += 1) {
    for (let next = index + 1; next < loops.length; next += 1) {
      const left = loops[index]!.members;
      const right = loops[next]!.members;
      const overlap = [...left].some((id) => right.has(id));
      const nested = [...left].every((id) => right.has(id)) || [...right].every((id) => left.has(id));
      if (overlap && !nested) addIssue(issues, 'overlapping-loops', '多个 Loop 的 Agent 区域必须互不重叠或完整嵌套。', { edgeIds: [loops[index]!.edge.id, loops[next]!.edge.id] });
    }
  }
  const loopIds = new Set<string>();
  for (const loop of loops) {
    if (loopIds.has(loop.id)) addIssue(issues, 'duplicate-loop-id', `Loop 标识“${loop.id}”重复。`, { edgeIds: [loop.edge.id] });
    loopIds.add(loop.id);
  }

  const availableTools = new Set(toolNames);
  const resolved = new Map<string, NonNullable<ReturnType<typeof resolveAgent>>>();
  for (const node of canvas.nodes.filter((candidate) => candidate.type === 'agent')) {
    const agent = resolveAgent(node, canvas, platformAgents, availableTools, issues);
    if (agent) resolved.set(node.id, agent);
  }
  if (issues.length > 0) return { plan: { summary: '', routingReason: '', steps: [] }, issues };

  const agentNodes = canvas.nodes.filter((node) => node.type === 'agent');
  type LoopAssignment = Map<string, number>;
  type ExpandedStep = { node: AgentWorkflowNode; agent: NonNullable<ReturnType<typeof resolveAgent>>; assignment: LoopAssignment; id: string };
  const loopsForNode = (nodeId: string) => loops
    .filter((candidate) => candidate.members.has(nodeId))
    // Larger regions are outer loops. This makes nested loop paths stable.
    .sort((left, right) => right.members.size - left.members.size || left.id.localeCompare(right.id));
  const assignmentsFor = (nodeId: string): LoopAssignment[] => {
    const owned = loopsForNode(nodeId);
    if (owned.length === 0) return [new Map()];
    const assignments: LoopAssignment[] = [new Map()];
    for (const loop of owned) {
      const next: LoopAssignment[] = [];
      for (const current of assignments) {
        for (let iteration = 1; iteration <= loop.maxIterations; iteration += 1) {
          next.push(new Map(current).set(loop.id, iteration));
        }
      }
      assignments.splice(0, assignments.length, ...next);
    }
    return assignments;
  };
  const assignmentKey = (assignment: LoopAssignment) => [...assignment.entries()].map(([id, iteration]) => `${id}-${iteration}`).join('~');
  const expandedByNode = new Map<string, ExpandedStep[]>();
  let expandedCount = 0;
  for (const node of agentNodes) {
    const agent = resolved.get(node.id)!;
    const expanded = assignmentsFor(node.id).map((assignment) => {
      const suffix = assignmentKey(assignment);
      // Preserve legacy single-loop IDs; multi-loop IDs include each stable loop id.
      const id = suffix.length === 0 ? node.id
        : loopsForNode(node.id).length === 1
          ? (assignment.get(loopsForNode(node.id)[0]!.id) === 1 ? node.id : `${node.id}-loop-${assignment.get(loopsForNode(node.id)[0]!.id)}`)
          : `${node.id}~${suffix}`;
      return { node, agent, assignment, id };
    });
    expandedCount += expanded.length;
    if (expandedCount > 256) {
      addIssue(issues, 'workflow-expansion-limit', 'Loop 展开后的 Agent 步骤超过 256 个上限，请减少循环轮数或拆分工作流。', { nodeIds: [node.id] });
      break;
    }
    expandedByNode.set(node.id, expanded);
  }
  if (issues.length > 0) return { plan: { summary: '', routingReason: '', steps: [] }, issues };
  const assignmentForDependency = (target: ExpandedStep, predecessor: AgentWorkflowNode, predecessorExpanded: ExpandedStep[], overrides = new Map<string, number>()) => {
    const candidates = predecessorExpanded.filter((candidate) => {
      for (const loop of loops) {
        const targetIteration = target.assignment.get(loop.id);
        const sourceIteration = candidate.assignment.get(loop.id);
        const expectedSourceIteration = overrides.get(loop.id) ?? sourceIteration;
        if (overrides.has(loop.id) && sourceIteration !== expectedSourceIteration) return false;
        if (!overrides.has(loop.id) && targetIteration !== undefined && sourceIteration !== undefined && targetIteration !== sourceIteration) return false;
        if (targetIteration !== undefined && sourceIteration === undefined && targetIteration !== 1) return false;
        if (targetIteration === undefined && sourceIteration !== undefined && sourceIteration !== loop.maxIterations) return false;
      }
      return true;
    });
    return candidates[0];
  };
  const steps: WorkflowStep[] = [];
  for (const node of agentNodes) {
    const agent = resolved.get(node.id)!;
    for (const expanded of expandedByNode.get(node.id) ?? []) {
      const dependencies: string[] = [];
      const conditions: NonNullable<WorkflowStep['conditions']> = [];
      for (const edge of incoming.get(node.id) ?? []) {
        const predecessor = nodeById.get(edge.source);
        if (!predecessor || predecessor.type === 'input') continue;
        const predecessorStep = assignmentForDependency(expanded, predecessor, expandedByNode.get(predecessor.id) ?? []);
        if (!predecessorStep) continue;
        dependencies.push(predecessorStep.id);
        if (edge.kind === 'condition' && edge.condition) {
          conditions.push({ sourceStepId: predecessorStep.id, expression: edge.condition.expression, branch: edge.condition.branch });
        }
      }
      for (const loop of loops) {
        const iteration = expanded.assignment.get(loop.id);
        if (iteration === undefined || expanded.node.id !== loop.edge.target || iteration <= 1) continue;
        const sourceStep = assignmentForDependency(
          expanded,
          nodeById.get(loop.edge.source)!,
          expandedByNode.get(loop.edge.source) ?? [],
          new Map([[loop.id, iteration - 1]]),
        );
        if (sourceStep) dependencies.push(sourceStep.id);
      }
      const loopPath = loopsForNode(node.id).flatMap((loop) => {
        const iteration = expanded.assignment.get(loop.id);
        return iteration === undefined ? [] : [{ id: loop.id, iteration, maxIterations: loop.maxIterations, entry: node.id === loop.edge.target }];
      });
      const firstLoop = loopPath[0];
      steps.push({
        id: expanded.id,
        title: firstLoop && loopPath.length === 1 && firstLoop.iteration > 1 ? `${node.name} · 第 ${firstLoop.iteration} 轮` : node.name,
        role: agent.roleId,
        objective: node.objective?.trim() || node.description?.trim() || `完成“${node.name}”Agent 的职责，并将可用结果传递给下游 Agent。`,
        dependsOn: [...new Set(dependencies)],
        acceptanceCriteria: node.acceptanceCriteria?.length ? node.acceptanceCriteria : ['输出完整、可验证，并满足当前 Agent 目标。'],
        ...(conditions.length ? { conditions } : {}),
        ...(loopPath.length ? { loopPath } : {}),
        ...(loopPath.length === 1 ? { loop: { id: loopPath[0]!.id, iteration: loopPath[0]!.iteration, maxIterations: loopPath[0]!.maxIterations, entry: loopPath[0]!.entry } } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        toolNames: agent.tools,
        ...(node.writeScopes?.length ? { writeScopes: [...new Set(node.writeScopes.map((scope) => scope.trim()).filter(Boolean))] } : {}),
        maxTokens: agent.maxTokens ?? 6_144,
        maxDurationMs: agent.maxDurationMs ?? 120_000,
        failureStrategy: agent.failureStrategy ?? 'retry',
        agentContract: agent.contract,
      });
    }
  }

  const graph: AgentGraph = {
    nodes: steps.map((step) => ({
      id: `agent-${step.id}`,
      stepId: step.id,
      agentId: `${step.role}-${step.id}`,
      role: step.role,
      title: step.title,
      dependsOn: step.dependsOn,
      writeScopes: step.writeScopes,
      status: 'queued',
    })),
    edges: steps.flatMap((step) => step.dependsOn.map((dependency) => ({
      from: `agent-${dependency}`,
      to: `agent-${step.id}`,
      kind: 'dependency' as const,
    }))),
  };
  const loopSummary = loops.length ? `，包含 ${loops.length} 个有界 Loop` : '';
  const plan: WorkflowPlan = {
    summary: `执行手动编排的 Agent 工作流，共 ${steps.length} 个执行步骤${loopSummary}。`,
    routingReason: '用户选择了已保存的确定性工作流，运行时跳过自动 Planner，按画布依赖和 Loop 配置调度。',
    steps,
    profile: {
      kind: 'operations',
      difficulty: steps.length > 6 ? 'complex' : steps.length > 3 ? 'hard' : 'moderate',
      route: 'full-workflow',
      score: Math.min(100, 40 + steps.length * 6),
      reasons: ['manual-agent-workflow', ...(loops.length ? ['bounded-loop'] : []), ...(flowEdges.length > agentNodes.length + 1 ? ['branching-graph'] : [])],
      maxSteps: steps.length,
      requiresReview: false,
    },
    graph,
    version: 1,
    approvalStatus: 'approved',
    approvedAt: new Date().toISOString(),
    approvedBy: 'workflow-owner',
  };
  return { plan, issues };
};
