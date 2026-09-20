import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:8787';
const cases = [
  { name: 'conversation', input: '你好，介绍一下你自己', mode: 'analyze', routes: ['direct'], noSearch: true },
  { name: 'focused-build', input: '修复这个函数的空指针问题，并给出测试', mode: 'build', routes: ['single-agent', 'team'] },
  { name: 'moderate-decision', input: 'Compare PostgreSQL and SQLite, then analyze risks and trade-offs for multi-worker deployment.', mode: 'decide', routes: ['single-agent', 'team', 'full-workflow'] },
  { name: 'production-architecture', input: 'Design a production architecture for a multi-agent platform with security, database migration, observability, recovery, and end-to-end acceptance.', mode: 'build', routes: ['team', 'full-workflow'] },
  { name: 'simple-weather', input: '今天北京天气怎么样？', mode: 'analyze', routes: ['direct'], search: true },
  { name: 'compound-official-comparison', input: '请基于最新官方资料，比较 PostgreSQL 与 SQLite 在多 worker 部署中的并发、迁移和故障恢复风险，给出选型方案并验证结论。', mode: 'decide', routes: ['team', 'full-workflow'], search: true },
  { name: 'follow-up-no-search', input: '不要重新搜索，仅把上一轮结论整理成三个要点，不要新增事实。', mode: 'analyze', routes: ['direct', 'single-agent', 'team'], noSearch: true, followUp: true },
];
const results = [];
let priorDecision;
const requestedRepeats = Number(process.env.QA_ROUTING_REPEATS ?? 1);
if (!Number.isInteger(requestedRepeats) || requestedRepeats < 1 || requestedRepeats > 10) throw new Error('QA_ROUTING_REPEATS must be an integer from 1 to 10.');
for (let round = 1; round <= requestedRepeats; round += 1) for (const item of cases) {
  const startedAt = Date.now();
  try {
    const currentGraph = item.followUp && priorDecision ? {
      nodes: priorDecision.scheduler.steps.map((step) => ({ id: step.id, role: step.agentId, title: step.title, status: 'completed', dependsOn: step.dependsOn })), edges: [],
    } : { nodes: [], edges: [] };
    const response = await fetch(`${baseUrl}/api/chat/route`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: item.input, mode: item.mode, attachments: [],
        conversationContext: item.followUp ? [{ role: 'user', content: cases[5].input }, { role: 'assistant', content: '此前已比较两种数据库；结论限定于已提供资料，部分恢复步骤尚未独立验证。' }] : [], currentGraph }),
      signal: AbortSignal.timeout(70_000),
    });
    const payload = await response.json().catch(() => null);
    const decision = payload?.decision;
    const active = decision?.scheduler?.activeAgentIds ?? [];
    const steps = decision?.scheduler?.steps ?? [];
    const stepAgents = [...new Set(steps.map((step) => step.agentId))];
    const workflow = decision?.execution === 'workflow';
    const ids = new Set(steps.map((step) => step.id));
    const routeShapeValid = decision?.workflowRoute === 'direct' ? steps.length === 0
      : ids.size === steps.length && active.length === stepAgents.length && active.every((id) => stepAgents.includes(id))
        && steps.every((step) => step.dependsOn.every((id) => ids.has(id) && id !== step.id));
    const searchActive = active.some((id) => ['search-agent', 'academic-search-agent', 'github-research-agent'].includes(id));
    const calls = payload?.diagnostics?.calls;
    const routingSummary = payload?.diagnostics?.summary;
    const measured = payload?.diagnostics?.scope === 'server-route-request' && Array.isArray(calls) && calls.length > 0
      && typeof routingSummary?.firstPassValid === 'boolean' && Array.isArray(payload?.diagnostics?.events)
      && calls.length <= 3 && calls.filter((call) => call.purpose === 'repair').length <= 1;
    const passed = response.ok && decision?.source === 'router-agent' && item.routes.includes(decision.workflowRoute)
      && active.length > 0 && routeShapeValid && workflow === (decision.workflowRoute !== 'direct')
      && (!item.search || searchActive && decision.requiresSearch) && (!item.noSearch || !searchActive && !decision.requiresSearch) && measured;
    results.push({ name: item.name, round, expectedRoutes: item.routes, actual: decision?.workflowRoute ?? 'error', source: decision?.source ?? 'none',
      intent: decision?.intent ?? 'none', activeAgentIds: active, selectedSkillIds: decision?.skillIds, steps,
      diagnostics: payload?.diagnostics ?? null, durationMs: Date.now() - startedAt, passed });
    if (item.name === 'compound-official-comparison') priorDecision = decision;
  } catch (error) { results.push({ name: item.name, round, passed: false, source: 'unavailable', durationMs: Date.now() - startedAt,
    error: error instanceof Error ? error.name : 'Routing request failed' }); }
}
const passed = results.filter((item) => item.passed).length;
const generatedAt = new Date().toISOString();
const percentile = (values, proportion) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * proportion) - 1] : null;
const summaries = results.map((result) => result.diagnostics?.summary).filter(Boolean);
const tokenSum = (field) => summaries.length === results.length && summaries.every((summary) => typeof summary[field] === 'number') ? summaries.reduce((total, summary) => total + summary[field], 0) : null;
const report = { generatedAt, methodology: 'One HTTP attempt per live case per round; rounds are independent observations, never retries that replace failures. At most one server-side semantic correction is reported separately. Model quality and end-to-end completion are separate evaluations.',
  rounds: requestedRepeats,
  passed, total: results.length, firstAttemptPassRate: passed / results.length,
  firstPassPlanValidRate: summaries.filter((summary) => summary.firstPassValid).length / results.length,
  correctionRate: summaries.filter((summary) => summary.repaired).length / results.length,
  correctionRecovered: summaries.filter((summary) => summary.repaired && !summary.fallback).length,
  latencyMs: { p50: percentile(results.map((result) => result.durationMs), 0.5), p95: percentile(results.map((result) => result.durationMs), 0.95) },
  totalTokens: tokenSum('totalTokens'), repairTokens: tokenSum('repairTokens'),
  repairDurationMs: summaries.reduce((total, summary) => total + summary.repairDurationMs, 0),
  fallbackRate: results.filter((item) => item.source === 'deterministic-fallback').length / results.length,
  unavailableRate: results.filter((item) => item.source === 'unavailable').length / results.length,
  controlPlane: 'router-agent + scheduler-agent', results };
await mkdir(resolve(root, 'qa'), { recursive: true });
await writeFile(resolve(root, 'qa/routing-eval-results.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(root, `qa/routing-eval-${generatedAt.replace(/[:.]/g, '-')}-results.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (passed !== results.length) process.exitCode = 1;
