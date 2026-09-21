import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventHub } from './eventHub.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { createTaskApi } from './taskApi.js';
import type { ChatRouteDecision, RoutingExecutionOptions } from './chatRouter.js';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';
import type { WorkflowTask } from './contracts.js';

const router: ChatRouteDecision['router'] = {
  intent: 'task', taskKind: 'research', difficulty: 'moderate', requiresExternalFacts: false,
  requiredCapabilities: ['analysis'], candidateAgentIds: ['analyst'], candidateSkillIds: [], confidence: 0.96,
  rationale: 'Analyze the supplied daily plan with the authorized Analyst.',
};
const scheduler = {
  route: 'single-agent', activeAgentIds: ['analyst'], skippedAgentIds: [], appendAgentIds: ['analyst'],
  selectedSkillIds: [], executionWaves: [['daily-analysis']],
  steps: [{ id: 'daily-analysis', title: 'Daily analysis', agentId: 'analyst', objective: 'Analyze the supplied plan.', dependsOn: [], skillIds: [] }],
  requiresReview: false, synthesisAgentId: 'synthesizer', reason: 'One Analyst is sufficient.',
};
const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'decision-schedule-tenant', 'x-axiom-user-id': 'decision-schedule-owner' };

for (const source of ['schedule-factory', 'provider-binding'] as const) {
  for (const location of ['local', 'internet'] as const) test(`scheduled HTTP execution uses ${source} ${location} privacy and decision routing policy`, async () => {
    const envBefore = { DATABASE_URL: process.env.DATABASE_URL, AXIOM_SCHEDULER_ENABLED: process.env.AXIOM_SCHEDULER_ENABLED };
    delete process.env.DATABASE_URL;
    process.env.AXIOM_SCHEDULER_ENABLED = 'true';
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    const requests: ModelCompletionRequest[] = [];
    let decisionCalls = 0;
    let factoryCalls = 0;
    let nudges = 0;
    const model: ModelClient = { model: `schedule-${location}-text`, location, async complete(request) {
      request.signal.throwIfAborted();
      requests.push(request);
      assert.equal(request.toolChoice, 'none');
      assert.equal(request.tools?.length ?? 0, 0);
      const isRouter = request.system.includes('You are the Router Agent');
      return { content: JSON.stringify(isRouter ? router : scheduler), finishReason: 'stop', attempts: 1, durationMs: 1, usage: { total_tokens: 19 } };
    } };
    const decisionRouting: RoutingExecutionOptions = { decisionRouterMode: 'hybrid', decisionRouter: { async evaluate(input, signal) {
      signal.throwIfAborted();
      decisionCalls += 1;
      assert.equal(input.message, 'Analyze the supplied daily plan and identify tradeoffs.');
      assert.equal(input.availableAgents?.some((agent) => agent.id === 'analyst' && agent.available !== false), true);
      assert.equal(input.availableAgents?.some((agent) => agent.available === false), false);
      return { decision: router, model: 'test-jev-schedule', totalTokens: 7, promptCharacters: 96 };
    } } };
    const api = createTaskApi({ store, hub: new EventHub(), artifactStore: null, decisionRouting,
      coordinator: { nudge() { nudges += 1; }, abort() {} } as never,
      ...(source === 'provider-binding' ? {
        bindProviders: async () => ({ providerBindingId: 'test-schedule-binding', model: model.model }),
        boundModelFactory: async (owner: { tenantId: string; userId: string; providerBindingId?: string }) => {
          assert.equal(owner.tenantId, 'decision-schedule-tenant');
          assert.equal(owner.userId, 'decision-schedule-owner');
          assert.equal(owner.providerBindingId, 'test-schedule-binding');
          factoryCalls += 1;
          return model;
        },
      } : { scheduleModelFactory: async (_credentialId: string | undefined, tenantId: string, userId: string) => {
        assert.equal(tenantId, 'decision-schedule-tenant');
        assert.equal(userId, 'decision-schedule-owner');
        factoryCalls += 1;
        return model;
      } }),
    });
    const request = (path: string, init: RequestInit) => api.request(new Request(`http://routing-schedule.test${path}`, init));
    let scheduleId: string | undefined;
    try {
      const created = await request('/schedules', { method: 'POST', headers, body: JSON.stringify({
        sessionId: 'decision-schedule-session', title: 'Daily supplied plan',
        input: 'Analyze the supplied daily plan and identify tradeoffs.', mode: 'analyze', enabled: false,
        cadence: { kind: 'daily', timeOfDay: '23:59', timezone: 'Asia/Shanghai' },
      }) });
      assert.equal(created.status, 201);
      scheduleId = (await created.json() as { schedule: { id: string } }).schedule.id;
      assert.equal(decisionCalls, 0, 'Creating a schedule must not evaluate or execute the task.');
      const response = await request(`/schedules/${scheduleId}/run`, { method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'decision-routing-schedule-first' }) });
      const body = await response.json() as { task: WorkflowTask; error?: string };
      assert.equal(response.status, 202, body.error);
      assert.equal(factoryCalls, 1);
      assert.equal(nudges, 1);
      assert.equal(decisionCalls, location === 'local' ? 0 : 1);
      assert.deepEqual(requests.map((value) => value.system.includes('You are the Router Agent') ? 'router' : 'scheduler'), location === 'local' ? ['router', 'scheduler'] : ['scheduler']);
      assert.equal(body.task.plan?.routerModel, location === 'local' ? model.model : 'test-jev-schedule');
      assert.deepEqual(body.task.plan?.steps.map((step) => step.role), ['analyst']);
      assert.equal(body.task.plan?.decisionRouting?.outcome, location === 'local' ? undefined : 'selected');
      const createdEvent = (await store.getEvents(body.task.id)).find((event) => event.type === 'task.created');
      assert.equal(createdEvent?.payload.source, 'schedule');
      assert.equal(createdEvent?.payload.routerModel, location === 'local' ? model.model : 'test-jev-schedule');
      assert.deepEqual(createdEvent?.payload.decisionRouting, body.task.plan?.decisionRouting);
    } finally {
      if (scheduleId) await request(`/schedules/${scheduleId}`, { method: 'DELETE', headers });
      await store.close();
      for (const [key, value] of Object.entries(envBefore)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}
