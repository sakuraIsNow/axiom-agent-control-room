import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentCatalog, appendMissingAgentDirectory, workerAgents } from './agentCatalog.js';

test('agent catalog reports registered roles separately from schedulable workers', () => {
  assert.equal(agentCatalog.length, 6);
  assert.deepEqual(workerAgents.map((agent) => agent.id), ['researcher', 'analyst', 'builder']);
  assert.deepEqual(agentCatalog.map((agent) => agent.id), ['planner', 'researcher', 'analyst', 'builder', 'reviewer', 'synthesizer']);
});

test('live directory supplement stays unchanged when the answer already covers every entry', () => {
  const answer = '规划器、研究员、分析员、工程师、审查员、汇总员。';
  assert.equal(appendMissingAgentDirectory(answer, agentCatalog), answer);
});

test('live directory supplement fills omitted built-in and published custom Agents', () => {
  const answer = '实时目录显示研究员、分析员和工程师。';
  const result = appendMissingAgentDirectory(answer, [
    ...agentCatalog,
    { id: 'release-planner', roleId: 'release-planner', name: '发布协调员' },
    { id: 'archived-review', roleId: 'archived-review', name: '归档审查员', status: 'archived' },
    { id: 'draft-review', roleId: 'draft-review', name: '草稿审查员', status: 'draft' },
  ]);
  assert.match(result, /规划器/);
  assert.match(result, /审查员/);
  assert.match(result, /汇总员/);
  assert.match(result, /发布协调员/);
  assert.doesNotMatch(result, /归档审查员|草稿审查员/);
  assert.match(result, /实时目录补充/);
});

test('live directory supplement can answer an empty model response without a static fallback', () => {
  const result = appendMissingAgentDirectory('', [{ id: 'custom-review', roleId: 'custom-review', name: '合规审查员' }]);
  assert.equal(result, '实时目录补充：合规审查员。');
});
