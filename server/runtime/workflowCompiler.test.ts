import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentWorkflowCanvas, UserDefinedAgent } from './contracts.js';
import { compileAgentWorkflow } from './workflowCompiler.js';

const node = (
  id: string,
  type: 'input' | 'agent' | 'output',
  x: number,
  agentRef?: { source: 'builtin' | 'platform' | 'workflow'; id: string },
) => ({
  id,
  type,
  name: id,
  position: { x, y: 100 },
  ...(agentRef ? { agentRef, objective: `execute ${id}`, acceptanceCriteria: ['done'] } : {}),
});

const base = (): AgentWorkflowCanvas => ({
  schemaVersion: 1,
  nodes: [
    node('input', 'input', 0),
    node('analyze', 'agent', 250, { source: 'builtin', id: 'analyst' }),
    node('output', 'output', 500),
  ],
  edges: [
    { id: 'edge-input', source: 'input', target: 'analyze', kind: 'flow' },
    { id: 'edge-output', source: 'analyze', target: 'output', kind: 'flow' },
  ],
  scopedAgents: [],
});

test('compiles a sequential visual workflow into a deterministic full-workflow plan', () => {
  const compiled = compileAgentWorkflow(base(), [], []);
  assert.deepEqual(compiled.issues, []);
  assert.equal(compiled.plan.profile?.route, 'full-workflow');
  assert.equal(compiled.plan.steps.length, 1);
  assert.equal(compiled.plan.steps[0]?.role, 'analyst');
  assert.equal(compiled.plan.steps[0]?.agentContract?.source, 'builtin');
  assert.equal(compiled.plan.approvalStatus, 'approved');
});

test('preserves branch and join dependencies for real parallel scheduling', () => {
  const canvas: AgentWorkflowCanvas = {
    schemaVersion: 1,
    nodes: [
      node('input', 'input', 0),
      node('research', 'agent', 220, { source: 'builtin', id: 'researcher' }),
      { ...node('analysis', 'agent', 220, { source: 'builtin', id: 'analyst' }), position: { x: 220, y: 300 } },
      node('join', 'agent', 500, { source: 'builtin', id: 'synthesizer' }),
      node('output', 'output', 760),
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'research', kind: 'flow' },
      { id: 'e2', source: 'input', target: 'analysis', kind: 'flow' },
      { id: 'e3', source: 'research', target: 'join', kind: 'flow' },
      { id: 'e4', source: 'analysis', target: 'join', kind: 'flow' },
      { id: 'e5', source: 'join', target: 'output', kind: 'flow' },
    ],
    scopedAgents: [],
  };
  const compiled = compileAgentWorkflow(canvas, [], []);
  assert.deepEqual(compiled.issues, []);
  assert.deepEqual(compiled.plan.steps.find((step) => step.id === 'research')?.dependsOn, []);
  assert.deepEqual(compiled.plan.steps.find((step) => step.id === 'analysis')?.dependsOn, []);
  assert.deepEqual(compiled.plan.steps.find((step) => step.id === 'join')?.dependsOn.sort(), ['analysis', 'research']);
});

test('unrolls a bounded Loop without introducing a dependency cycle', () => {
  const canvas: AgentWorkflowCanvas = {
    schemaVersion: 1,
    nodes: [
      node('input', 'input', 0),
      node('describe', 'agent', 220, { source: 'builtin', id: 'analyst' }),
      node('draw', 'agent', 480, { source: 'builtin', id: 'builder' }),
      node('output', 'output', 740),
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'describe', kind: 'flow' },
      { id: 'e2', source: 'describe', target: 'draw', kind: 'flow' },
      { id: 'e3', source: 'draw', target: 'output', kind: 'flow' },
      { id: 'loop-review', source: 'draw', target: 'describe', kind: 'loop', maxIterations: 3 },
    ],
    scopedAgents: [],
  };
  const compiled = compileAgentWorkflow(canvas, [], []);
  assert.deepEqual(compiled.issues, []);
  assert.equal(compiled.plan.steps.length, 6);
  assert.deepEqual(compiled.plan.steps.find((step) => step.id === 'describe-loop-2')?.dependsOn, ['draw']);
  assert.deepEqual(compiled.plan.steps.find((step) => step.id === 'draw-loop-2')?.dependsOn, ['describe-loop-2']);
  assert.equal(compiled.plan.steps.find((step) => step.id === 'describe-loop-3')?.loop?.iteration, 3);
  assert.equal(compiled.plan.graph?.nodes.length, 6);
});

test('expands independent nested Loops with stable paths and previous-round back edges', () => {
  const canvas: AgentWorkflowCanvas = {
    schemaVersion: 1,
    nodes: [
      node('input', 'input', 0),
      node('a', 'agent', 160, { source: 'builtin', id: 'analyst' }),
      node('b', 'agent', 320, { source: 'builtin', id: 'builder' }),
      node('c', 'agent', 480, { source: 'builtin', id: 'analyst' }),
      node('d', 'agent', 640, { source: 'builtin', id: 'builder' }),
      node('output', 'output', 800),
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'a', kind: 'flow' },
      { id: 'e2', source: 'a', target: 'b', kind: 'flow' },
      { id: 'e3', source: 'b', target: 'c', kind: 'flow' },
      { id: 'e4', source: 'c', target: 'd', kind: 'flow' },
      { id: 'e5', source: 'd', target: 'output', kind: 'flow' },
      { id: 'outer', source: 'd', target: 'a', kind: 'loop', loopId: 'outer', maxIterations: 2 },
      { id: 'inner', source: 'c', target: 'b', kind: 'loop', loopId: 'inner', maxIterations: 2 },
    ],
    scopedAgents: [],
  };
  const compiled = compileAgentWorkflow(canvas, [], []);
  assert.deepEqual(compiled.issues, []);
  assert.equal(compiled.plan.steps.length, 12);
  const nested = compiled.plan.steps.find((step) => step.id === 'b~outer-2~inner-2');
  assert.ok(nested);
  assert.deepEqual(nested?.loopPath?.map((loop) => [loop.id, loop.iteration]), [['outer', 2], ['inner', 2]]);
  assert.ok(nested?.dependsOn.includes('c~outer-2~inner-1'));
  const outerEntry = compiled.plan.steps.find((step) => step.id === 'a-loop-2');
  assert.ok(outerEntry?.dependsOn.includes('d'));
});

test('carries condition branch expressions into compiled Agent steps', () => {
  const canvas: AgentWorkflowCanvas = {
    schemaVersion: 1,
    nodes: [
      node('input', 'input', 0),
      node('source', 'agent', 240, { source: 'builtin', id: 'analyst' }),
      node('yes', 'agent', 480, { source: 'builtin', id: 'builder' }),
      node('no', 'agent', 480, { source: 'builtin', id: 'researcher' }),
      node('output', 'output', 720),
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'source', kind: 'flow' },
      { id: 'yes-edge', source: 'source', target: 'yes', kind: 'condition', condition: { expression: 'contains("approve")', branch: 'true' } },
      { id: 'no-edge', source: 'source', target: 'no', kind: 'condition', condition: { expression: 'contains("approve")', branch: 'false' } },
      { id: 'e4', source: 'yes', target: 'output', kind: 'flow' },
      { id: 'e5', source: 'no', target: 'output', kind: 'flow' },
    ],
    scopedAgents: [],
  };
  const compiled = compileAgentWorkflow(canvas, [], []);
  assert.deepEqual(compiled.issues, []);
  assert.deepEqual(compiled.plan.steps.find((step) => step.id === 'yes')?.conditions, [{ sourceStepId: 'source', expression: 'contains("approve")', branch: 'true' }]);
  assert.deepEqual(compiled.plan.steps.find((step) => step.id === 'no')?.conditions, [{ sourceStepId: 'source', expression: 'contains("approve")', branch: 'false' }]);
});

test('snapshots a workflow-scoped Agent contract without adding a platform Agent', () => {
  const canvas = base();
  canvas.nodes[1] = {
    ...canvas.nodes[1]!,
    agentRef: { source: 'workflow', id: 'scoped-image-prompt' },
    toolNames: ['workspace.read'],
  };
  canvas.scopedAgents = [{
    id: 'scoped-image-prompt',
    roleId: 'image-prompt-designer',
    name: '绘图描述 Agent',
    description: '只属于当前工作流',
    systemPromptTemplate: '将输入改写为结构化绘图提示。',
    toolAllowlist: ['workspace.read'],
    model: 'workflow-model',
  }];
  const platformAgents: UserDefinedAgent[] = [];
  const compiled = compileAgentWorkflow(canvas, platformAgents, ['workspace.read']);
  assert.deepEqual(compiled.issues, []);
  assert.equal(platformAgents.length, 0);
  assert.equal(compiled.plan.steps[0]?.role, 'image-prompt-designer');
  assert.equal(compiled.plan.steps[0]?.model, 'workflow-model');
  assert.deepEqual(compiled.plan.steps[0]?.toolNames, ['workspace.read']);
  assert.equal(compiled.plan.steps[0]?.agentContract?.source, 'workflow');
  assert.match(compiled.plan.steps[0]?.agentContract?.systemPromptTemplate ?? '', /结构化绘图提示/);
});

test('rejects ordinary cycles, missing Agent references and unbounded graph ambiguity', () => {
  const canvas = base();
  canvas.nodes.splice(2, 0, node('second', 'agent', 400, { source: 'builtin', id: 'builder' }));
  canvas.edges = [
    { id: 'e1', source: 'input', target: 'analyze', kind: 'flow' },
    { id: 'e2', source: 'analyze', target: 'second', kind: 'flow' },
    { id: 'e3', source: 'second', target: 'analyze', kind: 'flow' },
    { id: 'e4', source: 'second', target: 'output', kind: 'flow' },
  ];
  const compiled = compileAgentWorkflow(canvas, [], []);
  assert.ok(compiled.issues.some((issue) => issue.code === 'flow-cycle'));
  assert.equal(compiled.plan.steps.length, 0);

  const missing = base();
  missing.nodes[1] = { ...missing.nodes[1]!, agentRef: { source: 'platform', id: 'missing-agent' } };
  const missingCompiled = compileAgentWorkflow(missing, [], []);
  assert.ok(missingCompiled.issues.some((issue) => issue.code === 'platform-agent-not-found'));
});
