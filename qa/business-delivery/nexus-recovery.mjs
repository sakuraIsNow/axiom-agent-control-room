import assert from 'node:assert/strict';
import { compileAgentWorkflow } from '../../server/runtime/workflowCompiler.ts';
import { FixtureModel, delivered, evidence, headers, plan, principal, response, step, taskModel } from './helpers.mjs';

const node = (id, role = 'analyst') => ({ id, type: 'agent', name: id, position: { x: 200, y: 100 },
  agentRef: { source: 'builtin', id: role }, objective: `DELIVERY_STEP:${id}`, acceptanceCriteria: ['Preserve this authored business requirement.'] });
const flow = (source, target, extra = {}) => ({ id: `${source}-${target}`, source, target, kind: 'flow', ...extra });
function canvasPlan(nodes, edges) {
  const compiled = compileAgentWorkflow({ schemaVersion: 1, nodes: [
    { id: 'input', type: 'input', name: 'Input', position: { x: 0, y: 0 } }, ...nodes,
    { id: 'output', type: 'output', name: 'Output', position: { x: 700, y: 0 } },
  ], edges, scopedAgents: [] }, [], []);
  assert.deepEqual(compiled.issues, []);
  return compiled.plan;
}

const branchCase = (approved) => ({ id: `nexus-conditional-${approved ? 'approve' : 'reject'}`, domain: 'nexus-execution', expected: 'accepted-delivery', async run(f) {
  const branchPlan = canvasPlan([node('decision'), node('release', 'builder'), node('revise', 'researcher')], [
    flow('input', 'decision'), flow('decision', 'release', { kind: 'condition', condition: { expression: 'contains("approved")', branch: 'true' } }),
    flow('decision', 'revise', { kind: 'condition', condition: { expression: 'contains("approved")', branch: 'false' } }), flow('release', 'output'), flow('revise', 'output'),
  ]);
  const expected = approved ? 'Deliver the approved release checklist.' : 'Deliver a revision request; do not release.';
  const model = taskModel({ decision: approved ? 'approved' : 'changes-required', release: 'Approved release checklist ready.', revise: 'Missing approval: prepare revision request.' }, expected);
  const task = await f.create('Use the decision Agent to choose exactly one release branch.', branchPlan);
  const result = await delivered(f, task, model, expected);
  const selected = approved ? 'release' : 'revise'; const skipped = approved ? 'revise' : 'release';
  assert.equal(result.stepResults.find((item) => item.stepId === skipped).skipped, true);
  assert.notEqual(result.stepResults.find((item) => item.stepId === selected).skipped, true);
  assert.equal(model.calls.filter((call) => call.user.includes(`Assigned objective:\nDELIVERY_STEP:${skipped}\n`)).length, 0);
  const events = await f.store.getEvents(task.id);
  assert.ok(events.some((event) => event.type === 'branch.skipped' && event.payload.stepId === skipped));
  await f.reopen(); assert.equal((await f.store.getTask(task.id)).result, expected);
  return evidence(f, { selected, skipped, persistedResult: expected, compiledSteps: branchPlan.steps.length });
} });

function abortWait(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

export const nexusRecoveryCases = [
  branchCase(true), branchCase(false),
  { id: 'nexus-bounded-loop-delivers-final-round', domain: 'nexus-execution', expected: 'accepted-delivery', async run(f) {
    const loopPlan = canvasPlan([node('describe'), node('draw', 'builder')], [flow('input', 'describe'), flow('describe', 'draw'), flow('draw', 'output'),
      { id: 'bounded-loop', source: 'draw', target: 'describe', kind: 'loop', maxIterations: 3 }]);
    const counts = { describe: 0, draw: 0 };
    const model = new FixtureModel((request) => {
      if (request.system.includes('You are the synthesizer')) { assert.ok(request.user.includes('Drawing revision 3')); return 'Delivered drawing revision 3; completed exactly 3 rounds.'; }
      if (request.user.includes('Assigned objective:\nDELIVERY_STEP:describe\n')) return response(`Description revision ${++counts.describe}`);
      assert.ok(request.user.includes('Assigned objective:\nDELIVERY_STEP:draw\n'));
      counts.draw += 1; assert.ok(request.user.includes(`Description revision ${counts.draw}`));
      return response(`Drawing revision ${counts.draw}`);
    });
    const task = await f.create('Refine a drawing description and drawing in a bounded three-round Loop.', loopPlan);
    const result = await delivered(f, task, model, 'Delivered drawing revision 3; completed exactly 3 rounds.');
    assert.deepEqual(counts, { describe: 3, draw: 3 }); assert.equal(result.stepResults.length, 6);
    const iterations = (await f.store.getEvents(task.id)).filter((event) => event.type === 'loop.iteration' && event.payload.scope === 'workflow-loop');
    assert.deepEqual(iterations.map((event) => event.payload.iteration), [1, 2, 3]);
    return evidence(f, { counts, completedSteps: result.stepResults.length, iterations: [1, 2, 3] });
  } },
  { id: 'nexus-parallel-join-preserves-both-inputs', domain: 'nexus-execution', expected: 'accepted-delivery', async run(f) {
    const joinedPlan = canvasPlan([node('cost'), node('risk', 'researcher'), node('join', 'builder')], [flow('input', 'cost'), flow('input', 'risk'), flow('cost', 'join'), flow('risk', 'join'), flow('join', 'output')]);
    const model = new FixtureModel((request) => {
      if (request.system.includes('You are the synthesizer')) return 'Recommendation includes cost 4700 and risk: recovery drill required.';
      const id = /Assigned objective:\nDELIVERY_STEP:([^\n]+)/.exec(request.user)?.[1];
      if (id === 'cost') return response('Cost total: 4700.');
      if (id === 'risk') return response('Risk: recovery drill required.');
      assert.equal(id, 'join'); assert.ok(request.user.includes('Cost total: 4700.') && request.user.includes('recovery drill required'));
      return response('Both cost and risk inputs consumed.');
    });
    const task = await f.create('Compare independent cost and risk analyses before delivering one recommendation.', joinedPlan);
    const result = await delivered(f, task, model, 'Recommendation includes cost 4700 and risk: recovery drill required.');
    assert.deepEqual(result.stepResults.map((item) => item.stepId).sort(), ['cost', 'join', 'risk']);
    assert.equal(model.calls.length, 7, 'Three Agents, requirements extraction, contract audit, synthesis and final verification.');
    assert.equal(model.calls.filter((call) => call.system.includes('sub-agent')).length, 3);
    assert.equal(model.calls.filter((call) => call.system.startsWith("Extract the current user's delivery requirements")).length, 1);
    assert.equal(model.calls.filter((call) => call.system.startsWith('Audit the candidate delivery contract against original sources')).length, 1);
    assert.equal(model.calls.filter((call) => call.system.startsWith('Assess the final delivery against every requirement')).length, 1);
    return evidence(f, { dependencyInputCount: 2, eachAgentCalls: 1, output: result.result, parallelTimingEvaluated: false });
  } },
  { id: 'conversation-latest-change-survives-retry', domain: 'conversation-recovery', expected: 'accepted-after-injected-retry', async run(f) {
    let first = true;
    const model = new FixtureModel((request) => {
      if (request.system.includes('You are the synthesizer')) return 'Final scope: SVG only, 14-day retention, no HTML export.';
      assert.ok(request.user.includes('USER:\nLatest change: SVG only, retention 14 days, no HTML.'));
      if (first) { first = false; throw new Error('Injected transient provider failure before any side effects.'); }
      return response('Latest scope replaces old HTML and 30-day retention. Deliver SVG and 14-day retention.');
    });
    const task = await f.create('USER:\nBuild HTML and SVG with 30-day retention.\n\nASSISTANT:\nRecorded.\n\nUSER:\nLatest change: SVG only, retention 14 days, no HTML.');
    const result = await delivered(f, task, model, 'Final scope: SVG only, 14-day retention, no HTML export.');
    assert.equal(model.calls.filter((call) => !call.completed).length, 1);
    assert.equal(result.stepResults.length, 2);
    assert.equal(new Set(result.stepResults.map((item) => item.stepId)).size, 2);
    return evidence(f, { currentRequirements: ['SVG only', '14-day retention', 'no HTML'], executedStepCount: 2, firstAttemptDeliverySucceeded: false, recoveredDeliverySucceeded: true });
  } },
  { id: 'conversation-guidance-consumed-once', domain: 'conversation-recovery', expected: 'accepted-delivery', async run(f) {
    const task = await f.create('Prepare a launch plan.');
    const result = await f.api().request(`/tasks/${task.id}/guidance`, { method: 'POST', headers,
      body: JSON.stringify({ message: 'GUIDANCE_REQUIREMENT: add a rollback drill before launch.', behavior: 'continue', expectedRevision: task.revision }) });
    assert.equal(result.status, 202, await result.clone().text());
    const model = new FixtureModel((request) => {
      if (request.system.includes('You are the synthesizer')) return 'Launch plan includes a rollback drill before launch.';
      return response(request.user.includes('GUIDANCE_REQUIREMENT') ? 'Rollback drill included before launch.' : 'Preserve upstream rollback drill in launch plan.');
    });
    await delivered(f, await f.store.getTask(task.id), model, 'Launch plan includes a rollback drill before launch.');
    assert.equal(model.calls.filter((call) => call.user.includes('GUIDANCE_REQUIREMENT')).length, 1);
    const applied = (await f.store.getEvents(task.id)).filter((event) => event.type === 'human.guidance_applied');
    assert.equal(applied.length, 1);
    await f.reopen(); assert.equal((await f.store.getEvents(task.id)).filter((event) => event.type === 'human.guidance_applied').length, 1);
    return evidence(f, { guidanceApplications: 1, survivesRestart: true, finalRequirementPreserved: true });
  } },
  { id: 'conversation-cancel-stops-downstream', domain: 'conversation-recovery', expected: 'cancelled-without-delivery', async run(f) {
    const controller = new AbortController(); let started;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    const model = f.register(new FixtureModel(async (request) => { started(); await abortWait(request.signal); return response('Must never be delivered.'); }));
    const task = await f.create(); const pending = f.run(task, model, controller.signal);
    await Promise.race([firstStarted, pending.then(() => { throw new Error('Execution ended before cancellation point.'); })]);
    const api = f.api({ coordinator: { nudge() {}, abort() { controller.abort(new DOMException('User cancellation', 'AbortError')); } } });
    const cancellation = await api.request(`/tasks/${task.id}/cancel`, { method: 'POST', headers });
    assert.equal(cancellation.status, 202);
    const cancelled = await pending;
    assert.equal(cancelled.status, 'cancelled'); assert.ok(!cancelled.result); assert.equal(model.calls.length, 1);
    await f.reopen(); assert.equal((await f.store.getTask(task.id)).status, 'cancelled');
    assert.equal((await f.store.getEvents(task.id)).filter((event) => event.type === 'task.completed').length, 0);
    return evidence(f, { finalStatus: 'cancelled', downstreamCalls: 0, completedEvents: 0 });
  } },
  { id: 'conversation-checkpoint-restart-no-repeat', domain: 'conversation-recovery', expected: 'accepted-after-restart', async run(f) {
    const controller = new AbortController(); let blocked;
    const secondStarted = new Promise((resolve) => { blocked = resolve; });
    const firstModel = f.register(new FixtureModel(async (request) => {
      if (request.user.includes('Assigned objective:\nDELIVERY_STEP:analyze\n')) return response('Durable source result: approved budget 4700.');
      blocked(); await abortWait(request.signal); return response('Unreachable interrupted draft.');
    }));
    const task = await f.create('Prepare a budget report and recover without repeating finished analysis.', plan([step('analyze'), step('deliver', 'builder', ['analyze'])]));
    const firstRun = f.run(task, firstModel, controller.signal);
    await Promise.race([secondStarted, firstRun.then(() => { throw new Error('Execution ended before restart point.'); })]);
    await f.store.updateTask(task.id, { status: 'paused' });
    controller.abort(new DOMException('Simulated service interruption', 'AbortError'));
    const paused = await firstRun; assert.equal(paused.status, 'paused');
    assert.deepEqual(paused.stepResults.map((item) => item.stepId), ['analyze']);
    await f.reopen(); const restored = await f.store.getTask(task.id);
    assert.equal(restored.stepResults[0].output, 'Durable source result: approved budget 4700.');
    const queued = await f.store.updateTask(task.id, { status: 'queued', error: null });
    const resumedModel = new FixtureModel((request) => {
      assert.ok(!request.user.includes('Assigned objective:\nDELIVERY_STEP:analyze\n'), 'completed analysis must not run again');
      assert.ok(request.user.includes('4700'));
      return request.system.includes('You are the synthesizer') ? 'Recovered report: approved budget 4700.' : response('Final report retains approved budget 4700.');
    });
    const completed = await delivered(f, queued, resumedModel, 'Recovered report: approved budget 4700.');
    assert.equal(completed.stepResults.length, 2); assert.equal(resumedModel.calls.length, 2);
    const events = await f.store.getEvents(task.id);
    assert.equal(events.filter((event) => event.type === 'agent.completed' && event.payload.stepId === 'analyze').length, 1);
    return evidence(f, { durableCompletedStepsBeforeRestart: 1, analysisRepeatsAfterRestart: 0, finalResult: completed.result,
      scope: 'Actual SQLite connection close/reopen and new orchestrator; not an OS kill or multi-worker failover test.' });
  } },
];
