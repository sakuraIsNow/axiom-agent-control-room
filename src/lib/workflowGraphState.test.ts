import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptGraphEventSequence, MAX_DASHBOARD_GRAPH_NODES, parseAgentGraph, visibleGraphNodes } from './workflowGraphState';

const validGraph = {
  nodes: [
    { id: 'orchestrator', role: 'orchestrator', title: 'Orchestrator', dependsOn: [], status: 'running' },
    { id: 'research', role: 'researcher', title: 'Research', dependsOn: ['orchestrator'], status: 'queued' },
  ],
  edges: [{ from: 'orchestrator', to: 'research', kind: 'delegation' }],
};

test('graph sequence cursors reject duplicate and stale updates per task', () => {
  const cursors = new Map<string, number>();

  assert.equal(acceptGraphEventSequence(cursors, 'task-a', 4), true);
  assert.equal(acceptGraphEventSequence(cursors, 'task-a', 4), false);
  assert.equal(acceptGraphEventSequence(cursors, 'task-a', 3), false);
  assert.equal(acceptGraphEventSequence(cursors, 'task-a', 9), true);
  assert.equal(acceptGraphEventSequence(cursors, 'task-b', 1), true);
  assert.deepEqual([...cursors.entries()], [['task-a', 9], ['task-b', 1]]);
});

test('graph sequence cursors reject malformed event identities', () => {
  const cursors = new Map<string, number>();

  assert.equal(acceptGraphEventSequence(cursors, '', 1), false);
  assert.equal(acceptGraphEventSequence(cursors, 'task-a', 0), false);
  assert.equal(acceptGraphEventSequence(cursors, 'task-a', 1.5), false);
  assert.equal(cursors.size, 0);
});

test('dashboard graph exposes up to sixteen nodes without mutating the source', () => {
  const source = Array.from({ length: 24 }, (_, index) => `node-${index + 1}`);
  const visible = visibleGraphNodes(source);

  assert.equal(MAX_DASHBOARD_GRAPH_NODES, 16);
  assert.equal(visible.length, 16);
  assert.equal(visible.at(-1), 'node-16');
  assert.equal(source.length, 24);
});

test('graph payload validation accepts a well-formed acyclic graph', () => {
  assert.deepEqual(parseAgentGraph(validGraph), validGraph);
});

test('graph payload validation rejects duplicate nodes, dangling edges, and cycles', () => {
  assert.equal(parseAgentGraph({ ...validGraph, nodes: [...validGraph.nodes, validGraph.nodes[1]] }), null);
  assert.equal(parseAgentGraph({ ...validGraph, edges: [{ from: 'missing', to: 'research', kind: 'dependency' }] }), null);
  assert.equal(parseAgentGraph({
    nodes: validGraph.nodes.map((node) => node.id === 'orchestrator' ? { ...node, dependsOn: ['research'] } : node),
    edges: [...validGraph.edges, { from: 'research', to: 'orchestrator', kind: 'dependency' }],
  }), null);
});

test('graph payload validation rejects invalid parent trees and non-integer revisions', () => {
  assert.equal(parseAgentGraph({
    ...validGraph,
    revision: 1.5,
  }), null);
  assert.equal(parseAgentGraph({
    ...validGraph,
    nodes: validGraph.nodes.map((node) => node.id === 'research' ? { ...node, parentId: 'missing' } : node),
  }), null);
  assert.equal(parseAgentGraph({
    ...validGraph,
    nodes: validGraph.nodes.map((node) => node.id === 'research'
      ? { ...node, parentId: 'orchestrator' }
      : { ...node, parentId: 'research' }),
  }), null);
});
