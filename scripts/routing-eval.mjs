const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:8787';

const cases = [
  { name: 'conversation', input: '你好，介绍一下你自己', mode: 'analyze', routes: ['direct'] },
  { name: 'focused-build', input: '修复这个函数的空指针问题，并给出测试', mode: 'build', routes: ['single-agent', 'team'] },
  { name: 'moderate-decision', input: 'Compare PostgreSQL and SQLite, then analyze risks and trade-offs for multi-worker deployment.', mode: 'decide', routes: ['single-agent', 'team', 'full-workflow'] },
  { name: 'production-architecture', input: 'Design a production architecture for a multi-agent platform with security, database migration, observability, recovery, and end-to-end acceptance.', mode: 'build', routes: ['full-workflow'] },
];

const results = [];
for (const item of cases) {
  const response = await fetch(`${baseUrl}/api/chat/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: item.input, mode: item.mode, attachments: [], conversationContext: [], currentGraph: { nodes: [], edges: [] } }),
    signal: AbortSignal.timeout(70_000),
  });
  const payload = await response.json().catch(() => null);
  const decision = payload?.decision;
  const active = decision?.scheduler?.activeAgentIds ?? [];
  const stepAgents = [...new Set((decision?.scheduler?.steps ?? []).map((step) => step.agentId))];
  const workflow = decision?.execution === 'workflow';
  const routeShapeValid = decision?.workflowRoute === 'direct'
    ? (decision?.scheduler?.steps?.length ?? 0) === 0
    : active.length === stepAgents.length && active.every((id) => stepAgents.includes(id));
  const passed = response.ok
    && decision?.source === 'router-agent'
    && item.routes.includes(decision.workflowRoute)
    && active.length > 0
    && routeShapeValid
    && (workflow === (decision.workflowRoute !== 'direct'));
  results.push({
    name: item.name,
    expectedRoutes: item.routes,
    actual: decision?.workflowRoute ?? 'error',
    source: decision?.source ?? 'none',
    intent: decision?.intent ?? 'none',
    activeAgentIds: active,
    stepCount: decision?.scheduler?.steps?.length ?? 0,
    passed,
  });
}

const passed = results.filter((item) => item.passed).length;
console.log(JSON.stringify({ passed, total: results.length, accuracy: passed / results.length, controlPlane: 'router-agent + scheduler-agent', results }, null, 2));
if (passed !== results.length) process.exit(1);
