import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { WorkflowOrchestrator } from '../server/runtime/orchestrator.ts';
import { SqliteTaskStore } from '../server/runtime/sqliteTaskStore.ts';
import { EventHub } from '../server/runtime/eventHub.ts';
import { createTaskApi } from '../server/runtime/taskApi.ts';
import { summarizeExecutionQuality } from '../server/runtime/executionQuality.ts';
import { formatDependencyContext } from '../server/runtime/executionEfficiency.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  { claim: 'PostgreSQL supports concurrent server connections.', url: 'https://www.postgresql.org/docs/current/mvcc.html' },
  { claim: 'SQLite permits one writer at a time.', url: 'https://www.sqlite.org/lockingv3.html' },
];
const required = ['## Concurrency', '## Migration', '## Recovery', '## Recommendation', '## Verification'];
const claimLinks = sources.map((source) => `[${source.claim}](${source.url})`).join('\n\n');
const fullAnswer = [
  `## Concurrency\n${claimLinks}`,
  '## Migration\nTest the migration on a restored backup before deployment.',
  '## Recovery\nExercise worker termination and verify durable recovery records.',
  '## Recommendation\nPrefer PostgreSQL for concurrent server workers; use SQLite for bounded local storage.',
  '## Verification\nThese are fixed reference claims; no live recovery test was performed.',
].join('\n\n');
const logger = pino({ level: 'silent' });
const memory = {
  async recall() { return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }; },
  async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
};

// These are authored fixtures, not claims that a model can independently judge arbitrary factual truth.
const evaluateAgainstOracle = (task, headings) => {
  const renderedHeadings = new Set();
  const citations = [];
  const plainText = (node) => typeof node?.value === 'string' ? node.value : (node?.children ?? []).map(plainText).join('');
  renderToStaticMarkup(React.createElement(ReactMarkdown, { skipHtml: true, components: {
    h2: ({ node }) => { renderedHeadings.add(plainText(node)); return null; },
    a: ({ node, href }) => { const claim = plainText(node); citations.push({ claim, source: href,
      correct: sources.some((source) => source.claim === claim && source.url === href) }); return null; },
  } }, task.result ?? ''));
  const coverage = headings.map((heading) => ({ requirement: heading, present: renderedHeadings.has(heading.slice(3)) }));
  const sourceEvidence = task.stepResults.flatMap((step) => (step.evidenceDetails ?? []).filter((item) => item.kind === 'external-source')
    .map((item) => ({ claim: item.claim, source: item.source, correct: sources.some((source) => source.claim === item.claim && source.url === item.source) })));
  const completed = task.status === 'completed' && task.stepResults.every((step) => step.status === 'completed' && (!step.handoff || step.handoff.status === 'complete'));
  return { requirementCoverage: coverage.filter((item) => item.present).length / headings.length,
    citationCorrectness: citations.length ? citations.filter((item) => item.correct).length / citations.length : null,
    citations, sourceEvidence, coverage, accepted: completed && coverage.every((item) => item.present)
      && sources.every((source) => citations.some((item) => item.claim === source.claim && item.source === source.url))
      && citations.every((item) => item.correct) && sourceEvidence.length > 0 && sourceEvidence.every((item) => item.correct) };
};

class FixtureModel {
  model = 'local-quality-fixture';
  requests = [];
  reviewCalls = 0;
  sourceCalls = 0;
  synthesisCalls = 0;
  constructor(scenario) { this.scenario = scenario; }
  async complete(request) {
    this.requests.push({ system: request.system, user: request.user });
    const reviewing = request.system.includes('independent reviewer');
    const synthesizing = request.system.includes('You are the synthesizer');
    const sourceStep = request.system.includes('You are a researcher sub-agent');
    let content;
    if (sourceStep && ++this.sourceCalls === 1 && this.scenario === 'transient-failure') throw new Error('Injected model transport failure.');
    if (reviewing) {
      this.reviewCalls += 1;
      const approved = this.scenario === 'improving-review' && this.reviewCalls >= 3;
      const score = approved ? 95 : this.scenario === 'improving-review' ? 40 + this.reviewCalls * 10 : 45;
      content = JSON.stringify({ approved, score, summary: 'Fixture review', gaps: approved ? [] : ['Provide independent verification'], requiredCorrections: [] });
    } else if (synthesizing) {
      this.synthesisCalls += 1;
      content = this.scenario === 'missing-requirement' ? fullAnswer.replace(/## Recovery[\s\S]*?(?=## Recommendation)/, '')
        : this.scenario === 'delivery-missing-citations' ? fullAnswer.replace(claimLinks, sources.map((source) => source.claim).join('\n'))
          : this.scenario === 'delivery-wrong-citation' ? fullAnswer.replace(sources[0].url, sources[1].url)
        : this.scenario === 'changed-requirement' ? `${fullAnswer}\n\n## New constraint\nThe latest user constraint supersedes the old one.` : fullAnswer;
    } else {
      const citations = sources.map((source, index) => ({ kind: 'external-source', source: this.scenario === 'wrong-citation' && index === 0 ? 'https://example.invalid/fabricated' : source.url,
        claim: this.scenario === 'unsupported-claim' && index === 1 ? 'SQLite has unlimited simultaneous writers.' : source.claim,
        verification: 'verified', confidence: 0.99 }));
      content = JSON.stringify({ output: sourceStep ? sources.map((source) => `${source.claim} ${source.url}`).join('\n') : 'Bounded fixture comparison.',
        evidence: sourceStep ? citations : [], confidence: 0.9, toolCalls: [],
        handoff: { summary: sourceStep ? 'The fixed source set has two documented concurrency constraints.' : 'Comparison completed.',
          status: this.scenario === 'partial-handoff' && !sourceStep ? 'partial' : 'complete',
          artifactIds: [], evidenceIds: [], openQuestions: this.scenario === 'partial-handoff' ? ['Recovery remains unverified.'] : [], completionCriteria: [] } });
    }
    await request.onDelta?.({ reasoning: 'Fixture reasoning.' });
    await request.onDelta?.({ content: content.slice(0, Math.ceil(content.length / 2)) });
    await request.onDelta?.({ content: content.slice(Math.ceil(content.length / 2)) });
    return { content, attempts: 1, durationMs: 2, finishReason: this.scenario === 'truncated-delivery' && synthesizing ? 'length' : 'stop',
      ...(this.scenario === 'unknown-usage' ? {} : { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) };
  }
}

const scenarios = [
  ['complete', true], ['missing-requirement', false], ['wrong-citation', false], ['unsupported-claim', false],
  ['unknown-usage', true], ['transient-failure', true], ['partial-handoff', false], ['truncated-delivery', false],
  ['delivery-missing-citations', false], ['delivery-wrong-citation', false],
  ['no-progress', false], ['improving-review', true], ['human-acceptance', true], ['changed-requirement', true],
];
const envKeys = ['AGENT_REVIEW_CORRECTION_ROUNDS', 'AGENT_REQUIRE_REVIEW_APPROVAL', 'AGENT_SYNTHESIS_CONTINUATION_ROUNDS', 'AXIOM_MAX_AUTO_REPLANS'];
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.AGENT_REVIEW_CORRECTION_ROUNDS = '3';
process.env.AGENT_REQUIRE_REVIEW_APPROVAL = 'true';
process.env.AGENT_SYNTHESIS_CONTINUATION_ROUNDS = '1';
process.env.AXIOM_MAX_AUTO_REPLANS = '0';
const results = [];
try {
  for (const [scenario, expectedAccepted] of scenarios) {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    const startedAt = performance.now();
    try {
      const needsReview = ['no-progress', 'improving-review', 'human-acceptance'].includes(scenario);
      const original = await store.createTask({ tenantId: 'quality-fixture', userId: 'quality-fixture', sessionId: `quality-${scenario}`,
        title: scenario, input: `Compare the fixed PostgreSQL and SQLite fixture sources across concurrency, migration, recovery, recommendation, and verification.${scenario === 'changed-requirement' ? ' Latest user constraint: include New constraint.' : ''}`, mode: 'analyze',
        plan: { summary: 'Source evidence then bounded analysis.', routingReason: 'Fixed local quality evaluation, no external requests.', approvalStatus: 'approved',
          routingSource: 'router-agent', profile: { kind: 'research', difficulty: 'moderate', route: 'team', score: 4, reasons: ['fixture'], maxSteps: 2, requiresReview: needsReview },
          steps: [
            { id: 'sources', title: 'Sources', role: 'researcher', objective: 'Read the fixed source set.', dependsOn: [], acceptanceCriteria: ['Source claims have exact citations.'], toolNames: [], writeScopes: [], failureStrategy: 'retry' },
            { id: 'analysis', title: 'Analysis', role: 'analyst', objective: 'Compare all requested dimensions.', dependsOn: ['sources'], acceptanceCriteria: ['All five dimensions covered.'], toolNames: [], writeScopes: [], failureStrategy: 'retry' },
          ] } });
      const model = new FixtureModel(scenario);
      const hub = new EventHub();
      const orchestrator = new WorkflowOrchestrator(store, hub, model, memory, logger);
      let task = await orchestrator.run(original, AbortSignal.timeout(30_000));
      if (scenario === 'human-acceptance') {
        assert.equal(task.status, 'waiting_for_human');
        const api = createTaskApi({ store, hub, coordinator: { nudge() {}, abort() {} } });
        const response = await api.request(`/tasks/${task.id}/approve-review`, { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': task.tenantId, 'x-axiom-user-id': task.userId }, body: JSON.stringify({ expectedRevision: task.revision }) });
        assert.equal(response.status, 202);
        task = await new WorkflowOrchestrator(store, hub, model, memory, logger).run(await store.getTask(task.id), AbortSignal.timeout(30_000));
        assert.equal(model.reviewCalls, 2, 'human-approved recovery must not repeat review');
      }
      const events = await store.getEvents(task.id);
      const quality = summarizeExecutionQuality(task, events);
      const rubric = evaluateAgainstOracle(task, scenario === 'changed-requirement' ? [...required, '## New constraint'] : required);
      assert.equal(rubric.accepted, expectedAccepted, `fixture oracle must accept complete work and reject injected defects: ${JSON.stringify({ status: task.status, rubric, result: task.result?.slice(0, 160), steps: task.stepResults.map((step) => ({ id: step.stepId, role: step.role, status: step.status })) })}`);
      if (scenario === 'unknown-usage') assert.equal(quality.usage.totalTokens, null);
      if (scenario === 'transient-failure') { assert.equal(quality.usage.failures, 1); assert.equal(quality.quality.firstAttemptExecutionSuccess, false); }
      if (scenario === 'no-progress' || scenario === 'human-acceptance') { assert.equal(quality.quality.reviewNoProgressStops, 1); assert.equal(model.reviewCalls, 2); }
      if (scenario === 'improving-review') { assert.equal(model.reviewCalls, 3); assert.equal(quality.quality.correctionRounds, 2); }
      if (scenario === 'human-acceptance') assert.equal(quality.quality.acceptance, 'accepted');
      assert.equal(quality.quality.factualCorrectness, 'not-independently-evaluated');
      assert.ok(quality.usage.promptSamples > 0);
      assert.ok(quality.usage.calls >= 2);
      results.push({ id: scenario, passed: true, expectedAccepted, rubric, quality, durationMs: performance.now() - startedAt });
    } catch (error) { results.push({ id: scenario, passed: false, error: String(error), durationMs: performance.now() - startedAt }); }
    finally { await store.close(); }
  }
} finally { for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }

const handoffText = 'Source findings must survive unchanged. '.repeat(200);
const sampleResult = { stepId: 'source', role: 'researcher', output: handoffText };
const message = { content: handoffText, handoff: { summary: handoffText, status: 'complete', openQuestions: [], evidenceIds: ['source-1'], artifactIds: [] } };
const compactPrompt = formatDependencyContext(sampleResult, message, 4_000);
const legacyPrompt = compactPrompt.replace('按连线传递的内容：', `交接摘要：${handoffText}\n按连线传递的内容：`);
assert.ok(compactPrompt.includes(handoffText));
assert.ok(compactPrompt.length / legacyPrompt.length < 0.55, 'the fixed duplicate-handoff benchmark must remove the second copy');
const report = { suite: 'execution-quality-v1', generatedAt: new Date().toISOString(), environment: 'local-fake-model-real-sqlite-orchestrator',
  methodology: 'Authored requirement anchors and exact claim/source oracle; fixture defects must be rejected. Not an online model-quality score.',
  latencyThresholdMs: 30_000,
  summary: { cases: results.length, passed: results.filter((row) => row.passed).length, failed: results.filter((row) => !row.passed).length,
    evaluatedDeliveries: results.filter((row) => row.rubric).length,
    fixtureAcceptanceRate: results.filter((row) => row.rubric?.accepted).length / results.length,
    firstAttemptExecutionSuccessRate: results.filter((row) => row.quality?.quality.firstAttemptExecutionSuccess === true).length / results.length,
    firstAttemptDeliverySuccessRate: results.filter((row) => row.quality?.quality.firstAttemptExecutionSuccess === true && row.rubric?.accepted).length / results.length,
    humanTakeoverRate: results.filter((row) => row.quality?.quality.humanTakeover === true).length / results.length,
    qualityOracleAgreementRate: results.filter((row) => row.passed).length / results.length },
  efficiency: { benchmark: 'same-handoff-before-after', beforeCharacters: legacyPrompt.length, afterCharacters: compactPrompt.length,
    reduction: 1 - compactPrompt.length / legacyPrompt.length, fullSourcePreserved: true, realProviderTokenReduction: null }, results };
await mkdir(resolve(root, 'qa'), { recursive: true });
await writeFile(resolve(root, 'qa/execution-quality-results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, results: results.map(({ id, passed, error, durationMs }) => ({ id, passed, error, durationMs })) }, null, 2));
if (report.summary.failed || results.some((row) => row.durationMs > report.latencyThresholdMs)) process.exitCode = 1;
