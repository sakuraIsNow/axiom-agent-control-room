import type { RuntimeEvent, WorkflowTask } from './contracts.js';
import { hasCurrentHumanAcceptance, summarizeCompletionEvidence } from './completionEvidence.js';

type Phase = 'routing' | 'scheduling' | 'planning' | 'execution' | 'review' | 'correction' | 'delivery';
type Usage = {
  calls: number; failures: number; retries: number; durationMs: number;
  measuredCalls: number; unknownUsageCalls: number; measuredTokens: number;
  unknownUsageAttempts: number;
  promptCharacters: number; promptSamples: number;
};
const emptyUsage = (): Usage => ({ calls: 0, failures: 0, retries: 0, durationMs: 0,
  measuredCalls: 0, unknownUsageCalls: 0, unknownUsageAttempts: 0, measuredTokens: 0, promptCharacters: 0, promptSamples: 0 });
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const phaseFor = (stage: string): Phase => stage.startsWith('router') ? 'routing'
  : stage.startsWith('scheduler') ? 'scheduling' : stage === 'planner' ? 'planning'
    : stage.includes('review-correction-') ? 'correction' : stage === 'reviewer' ? 'review'
      : stage.startsWith('synthesizer') || stage === 'direct-response' || stage.startsWith('single-agent:') ? 'delivery' : 'execution';
const visibleStage = (stage: unknown) => typeof stage === 'string'
  && (stage === 'direct-response' || stage.startsWith('single-agent:') || stage.startsWith('synthesizer'));
const finalizeUsage = (usage: Usage) => ({ ...usage,
  totalTokens: usage.calls > 0 && usage.unknownUsageCalls === 0 ? usage.measuredTokens : null,
  usageStatus: usage.calls === 0 ? 'not-observed' : usage.unknownUsageCalls === 0 ? 'measured' : usage.measuredCalls ? 'partial' : 'unknown',
});

/** Rebuilt from owner-scoped durable events; no model scoring or transient process counters. */
export const summarizeExecutionQuality = (task: WorkflowTask, input: readonly RuntimeEvent[], now = Date.now()) => {
  const events = [...new Map(input.filter((event) => event.taskId === task.id).map((event) => [event.sequence, event])).values()]
    .sort((a, b) => a.sequence - b.sequence);
  const createdAt = timestamp(task.createdAt);
  const terminal = events.filter((event) => ['task.completed', 'task.failed', 'task.cancelled'].includes(event.type)).at(-1);
  const endedAt = ['completed', 'failed', 'cancelled'].includes(task.status)
    ? terminal ? timestamp(terminal.timestamp) : timestamp(task.updatedAt) : now;
  const elapsed = createdAt !== null && endedAt !== null ? Math.max(0, endedAt - createdAt) : null;
  const sinceStart = (event: RuntimeEvent | undefined) => event && createdAt !== null && timestamp(event.timestamp) !== null
    ? Math.max(0, timestamp(event.timestamp)! - createdAt) : null;
  const phases = new Map<Phase, Usage>();
  const agents = new Map<string, Usage>();
  const total = emptyUsage();
  const observedSpans = new Set<string>();
  for (const event of events) {
    if (event.type !== 'model.completed' && event.type !== 'model.failed') continue;
    const p = event.payload;
    if (typeof p.spanId === 'string') {
      if (observedSpans.has(p.spanId)) continue;
      observedSpans.add(p.spanId);
    }
    const stage = typeof p.stage === 'string' ? p.stage : 'unknown';
    const phase = phaseFor(stage);
    const entry = phases.get(phase) ?? emptyUsage();
    const agentId = event.agentId ?? (stage.startsWith('agent:') ? stage.split(':')[1] : stage);
    const agent = agents.get(agentId!) ?? emptyUsage();
    const tokens = p.usageStatus === 'unknown' ? null : number(p.totalTokens);
    const attempts = Math.max(1, Math.floor(number(p.attempts) ?? 1));
    for (const usage of [total, entry, agent]) {
      usage.calls += 1;
      usage.failures += Number(event.type === 'model.failed');
      usage.retries += attempts - 1;
      usage.durationMs += number(p.durationMs) ?? 0;
      if (tokens !== null) { usage.measuredCalls += 1; usage.measuredTokens += tokens; }
      // Providers report usage for the final successful attempt, not failed earlier streams.
      if (tokens === null || attempts > 1) usage.unknownUsageCalls += 1;
      usage.unknownUsageAttempts += tokens === null ? attempts : attempts - 1;
      if (number(p.promptCharacters) !== null) { usage.promptCharacters += number(p.promptCharacters)!; usage.promptSamples += 1; }
    }
    phases.set(phase, entry);
    agents.set(agentId!, agent);
  }
  const humanAccepted = hasCurrentHumanAcceptance(task, events);
  const evidence = summarizeCompletionEvidence(task.plan, task.stepResults, task.review,
    task.plan?.profile?.requiresReview ?? false, { taskId: task.id, humanAccepted });
  const approvalEvents = events.filter((event) => ['plan.approval_requested', 'review.approval_requested', 'tool.approval_requested', 'tool.outcome_unknown'].includes(event.type));
  const manualEvents = events.filter((event) => ['node.completed_manually', 'node.skip_requested', 'node.rerun_requested', 'node.retry_requested',
    'node.replace_requested', 'human.note', 'human.guidance_accepted'].includes(event.type));
  const humanTakeover = approvalEvents.length > 0 || manualEvents.length > 0 || task.stepResults.some((step) => step.manual);
  const routeEvent = events.filter((event) => event.type === 'routing.decided').at(-1);
  const routeSource = typeof routeEvent?.payload.source === 'string' ? routeEvent.payload.source
    : task.plan?.routingSource ?? null;
  const correctionRounds = events.filter((event) => event.type === 'loop.iteration' && event.payload.phase === 'review-correction').length;
  const retryEvents = events.filter((event) => event.type === 'agent.retrying').length;
  const specialistServiceFailures = events.filter((event) => event.type === 'agent.failed' && event.payload.callKind === 'specialist-service').length;
  const firstAttempt = total.calls === 0 ? null : task.status === 'completed' && evidence.execution === 'completed'
    && total.failures === 0 && total.retries === 0 && retryEvents === 0 && specialistServiceFailures === 0 && correctionRounds === 0 && !humanTakeover;
  return {
    schemaVersion: 1,
    taskId: task.id,
    scope: 'persisted-task-events',
    status: task.status,
    timing: {
      elapsedMs: elapsed,
      firstActivityMs: sinceStart(events.find((event) => event.type === 'agent.started'
        || event.type === 'model.delta' && Boolean(event.payload.content || event.payload.reasoning))),
      firstAnswerMs: sinceStart(events.find((event) => event.type === 'model.delta' && !event.payload.reset
        && visibleStage(event.payload.stage) && typeof event.payload.content === 'string' && event.payload.content.length > 0)),
      modelCallDurationMs: total.durationMs,
      durationBasis: 'sum-of-calls-not-wall-time',
      elapsedBasis: 'task-lifetime-including-recovery-and-human-wait',
    },
    usage: finalizeUsage(total),
    phases: Object.fromEntries([...phases].map(([key, value]) => [key, finalizeUsage(value)])),
    agents: Object.fromEntries([...agents].map(([key, value]) => [key, finalizeUsage(value)])),
    routing: { source: routeSource, degraded: routeSource === null ? null : routeSource === 'deterministic-fallback' },
    quality: {
      execution: evidence.execution,
      acceptance: evidence.acceptance,
      evidenceStatus: evidence.evidenceStatus,
      supportedEvidenceItems: evidence.supportedEvidenceItems,
      evidenceItems: evidence.evidenceItems,
      factualCorrectness: 'not-independently-evaluated',
      requirementCoverage: null,
      firstAttemptExecutionSuccess: firstAttempt,
      humanTakeover,
      manualActionCount: manualEvents.length,
      humanDecisionCount: events.filter((event) => ['plan.approved', 'plan.rejected', 'review.approved', 'review.rejected', 'tool.approved', 'tool.rejected', 'tool.outcome_resolved'].includes(event.type)).length,
      correctionRounds,
      reviewNoProgressStops: events.filter((event) => event.type === 'loop.iteration' && event.payload.phase === 'review-stopped' && event.payload.reason === 'no-progress').length,
      agentRetries: retryEvents,
      specialistServiceFailures,
    },
  };
};
