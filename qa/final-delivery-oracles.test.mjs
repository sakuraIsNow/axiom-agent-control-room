import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { evaluateJsonDelivery } from './lib/live-delivery-cases.mjs';
import { evaluateFinalDeliveryOutcome, finalDeliveryCases } from './lib/final-delivery-cases.mjs';

const batchFixture = finalDeliveryCases[0];
const unknownFixture = finalDeliveryCases[1];
const batchAnswer = {
  recommendedService: 'Aster', services: [{ id: 'Aster', capacityPerHour: 120, feePerDay: 30 }, { id: 'Birch', capacityPerHour: 90, feePerDay: 22 }],
  dailyBatchJobs: [150, 150, 150, 150], dailyJobs: 600, processingHoursPerDay: 5, totalJobs: 1800, totalFee: 90,
  remainingBudget: 10, productionP99Ms: null, auditPassed: null, executed: false, references: ['SRC-A', 'SRC-B'],
};
const unknownAnswer = {
  service: 'Cedar', productionP99Ms: null, auditPassed: null, productionReady: null, verificationStatus: 'unknown',
  independentlyVerified: false, missingEvidence: ['production-latency-measurements', 'independent-audit-report'], actionsTaken: [], references: ['SRC-C'],
};
const outcome = (fixture, output) => ({
  taskStatus: fixture.expectedStatus, toolCalls: 0, humanApprovals: 0,
  taskCompletedEvents: fixture.expectedStatus === 'completed' ? 1 : 0,
  delivery: { status: Array.isArray(fixture.expectedAssessmentStatus) ? fixture.expectedAssessmentStatus[0] : fixture.expectedAssessmentStatus,
    basis: 'model-assessment', factualCorrectness: 'not-independently-verified',
    resultDigest: createHash('sha256').update(output, 'utf8').digest('hex'),
    requirements: [{ id: 'r1', status: fixture.expectedAssessmentStatus === 'passed' ? 'satisfied' : 'unknown' },
      ...(fixture.expectedCalculations ?? []).map((calculation, index) => ({ id: `calc${index}`, status: 'satisfied',
        calculation: { basis: 'deterministic-arithmetic', path: calculation.path, status: 'satisfied',
          expected: calculation.expected, actual: calculation.expected } }))] },
});
const check = (fixture, value) => evaluateJsonDelivery(fixture, JSON.stringify(value)).passed;

test('authored final-delivery fixtures are fixed complex two-Agent integrations, not routing evaluations', () => {
  assert.equal(finalDeliveryCases.length, 2);
  for (const fixture of finalDeliveryCases) {
    assert.equal(fixture.deliveryGate, true);
    assert.equal(fixture.plan.profile.difficulty, 'hard');
    assert.equal(fixture.plan.profile.route, 'full-workflow');
    assert.equal(fixture.plan.profile.requiresReview, false);
    assert.equal(fixture.plan.steps.length, 2);
    assert.deepEqual(fixture.plan.steps[1].dependsOn, ['analyze']);
    assert.ok(fixture.plan.steps.every((step) => step.toolNames.length === 0 && step.writeScopes.length === 0));
    assert.match(fixture.scope, /Router/);
  }
});

test('batch oracle accepts exact source arithmetic independently of any model verdict', () => {
  assert.equal(check(batchFixture, batchAnswer), true);
  assert.ok(JSON.stringify(batchAnswer).length < 700);
  assert.equal(check(batchFixture, { ...batchAnswer, services: [...batchAnswer.services].reverse(), references: ['SRC-B', 'SRC-A'] }), true);
});

test('batch prompt explicitly distinguishes service IDs from source-reference IDs', () => {
  assert.ok(batchFixture.message.includes('services.id must be the service name Aster or Birch, not a source ID'));
  assert.ok(batchFixture.message.includes('references (both exact source IDs SRC-A and SRC-B, not service names)'));
  const sourceIdsAsNames = batchAnswer.services.map((service, index) => ({ ...service, id: ['SRC-A', 'SRC-B'][index] }));
  assert.equal(check(batchFixture, { ...batchAnswer, services: sourceIdsAsNames }), false);
  assert.equal(check(batchFixture, { ...batchAnswer, references: ['Aster', 'Birch'] }), false);
});

for (const [name, change] of [
  ['insufficient service', { recommendedService: 'Birch' }],
  ['incorrect daily total', { dailyJobs: 540 }],
  ['incorrect batch count', { dailyBatchJobs: [150, 150, 150] }],
  ['unequal batch sizes with a correct sum', { dailyBatchJobs: [100, 200, 150, 150] }],
  ['incorrect three-day total', { totalJobs: 600 }],
  ['daily fee mistaken for total cost', { totalFee: 30 }],
  ['wrong unused budget', { remainingBudget: 70 }],
  ['incorrect processing hours', { processingHoursPerDay: 6 }],
  ['invented production latency', { productionP99Ms: 120 }],
  ['invented audit proof', { auditPassed: true }],
  ['claimed external execution', { executed: true }],
  ['duplicated citation', { references: ['SRC-A', 'SRC-A'] }],
  ['unknown citation', { references: ['SRC-A', 'SRC-X'] }],
  ['extra certificate field', { certified: true }],
]) test(`batch oracle rejects ${name}`, () => {
  assert.equal(check(batchFixture, { ...batchAnswer, ...change }), false);
});

test('batch oracle rejects swapped source values, duplicate source records and incomplete JSON', () => {
  const swapped = batchAnswer.services.map((item, index) => ({ ...item, capacityPerHour: batchAnswer.services[1 - index].capacityPerHour }));
  assert.equal(check(batchFixture, { ...batchAnswer, services: swapped }), false);
  assert.equal(check(batchFixture, { ...batchAnswer, services: [batchAnswer.services[0], batchAnswer.services[0]] }), false);
  assert.equal(evaluateJsonDelivery(batchFixture, JSON.stringify(batchAnswer).slice(0, -1)).passed, false);
  assert.equal(evaluateJsonDelivery(batchFixture, `Explanation: ${JSON.stringify(batchAnswer)}`).passed, false);
});

test('production-proof oracle requires truthful unknown and both missing evidence categories', () => {
  assert.equal(check(unknownFixture, unknownAnswer), true);
  assert.ok(JSON.stringify(unknownAnswer).length < 700);
  assert.equal(check(unknownFixture, { ...unknownAnswer, missingEvidence: [...unknownAnswer.missingEvidence].reverse() }), true);
});

for (const [name, change] of [
  ['advertised capacity substituted for p99', { productionP99Ms: 120 }],
  ['unsupported audit success', { auditPassed: true }],
  ['unsupported audit failure', { auditPassed: false }],
  ['production-ready self-certification', { productionReady: true }],
  ['unsupported negative readiness claim', { productionReady: false }],
  ['verified declaration without evidence', { verificationStatus: 'verified' }],
  ['independent-verification self-approval', { independentlyVerified: true }],
  ['omitted audit gap', { missingEvidence: ['production-latency-measurements'] }],
  ['duplicated evidence gap', { missingEvidence: ['independent-audit-report', 'independent-audit-report'] }],
  ['unrequested browsing', { actionsTaken: ['browsed'] }],
  ['invented citation', { references: ['AUDIT-2026'] }],
]) test(`production-proof oracle rejects ${name}`, () => {
  assert.equal(check(unknownFixture, { ...unknownAnswer, ...change }), false);
});

test('a truthful unknown answer must wait without a completion event or self-approval', () => {
  const output = JSON.stringify(unknownAnswer);
  const observed = outcome(unknownFixture, output);
  assert.equal(evaluateFinalDeliveryOutcome(unknownFixture, output, observed).passed, true);
  assert.equal(evaluateFinalDeliveryOutcome(unknownFixture, output, { ...observed, taskStatus: 'completed' }).passed, false);
  assert.equal(evaluateFinalDeliveryOutcome(unknownFixture, output, { ...observed, taskCompletedEvents: 1 }).passed, false);
  assert.equal(evaluateFinalDeliveryOutcome(unknownFixture, output, { ...observed, humanApprovals: 1 }).passed, false);
  assert.equal(evaluateFinalDeliveryOutcome(unknownFixture, output, { ...observed, delivery: { ...observed.delivery, status: 'passed' } }).passed, false);
  assert.equal(evaluateFinalDeliveryOutcome(unknownFixture, output, { ...observed, delivery: { ...observed.delivery,
    status: 'needs-revision', requirements: [{ id: 'r1', status: 'unsatisfied' }] } }).passed, true);
  assert.equal(evaluateFinalDeliveryOutcome(unknownFixture, output, { ...observed, delivery: { ...observed.delivery,
    status: 'needs-revision', requirements: [{ id: 'r1', status: 'satisfied' }] } }).passed, false);
});

test('explicit incomplete execution can block an otherwise satisfied truthful-unknown draft', () => {
  const output = JSON.stringify(unknownAnswer);
  const observed = outcome(unknownFixture, output);
  observed.delivery = { ...observed.delivery, status: 'needs-revision', runtimeExecution: 'partial',
    runtimeGaps: ['2 steps have incomplete handoffs', 'Production and audit evidence have not been verified'],
    requirements: [{ id: 'r1', status: 'satisfied' }] };
  const checkObserved = (value) => evaluateFinalDeliveryOutcome(unknownFixture, output, value).passed;
  assert.equal(checkObserved(observed), true);
  for (const runtimeExecution of [undefined, 'completed', 'unverified']) {
    assert.equal(checkObserved({ ...observed, delivery: { ...observed.delivery, runtimeExecution } }), false);
  }
  for (const runtimeGaps of [undefined, [], [''], ['  '], [null], [123], ['Incomplete handoff', ''], 'Incomplete handoff']) {
    assert.equal(checkObserved({ ...observed, delivery: { ...observed.delivery, runtimeGaps } }), false);
  }
  for (const status of ['passed', 'inconclusive']) {
    assert.equal(checkObserved({ ...observed, delivery: { ...observed.delivery, status } }), false);
  }
  for (const change of [{ taskStatus: 'completed' }, { taskCompletedEvents: 1 }, { toolCalls: 1 }, { humanApprovals: 1 }]) {
    assert.equal(checkObserved({ ...observed, ...change }), false);
  }
  assert.equal(checkObserved({ ...observed, delivery: { ...observed.delivery, resultDigest: 'unbound' } }), false);
  const fabricated = JSON.stringify({ ...unknownAnswer, independentlyVerified: true, productionReady: true });
  assert.equal(evaluateFinalDeliveryOutcome(unknownFixture, fabricated, { ...observed,
    delivery: { ...observed.delivery, resultDigest: createHash('sha256').update(fabricated, 'utf8').digest('hex') } }).passed, false);
});

test('successful bounded delivery requires an exact-result receipt and exactly one completion event', () => {
  const output = JSON.stringify(batchAnswer);
  const observed = outcome(batchFixture, output);
  assert.equal(evaluateFinalDeliveryOutcome(batchFixture, output, observed).passed, true);
  for (const taskCompletedEvents of [0, 2]) {
    assert.equal(evaluateFinalDeliveryOutcome(batchFixture, output, { ...observed, taskCompletedEvents }).passed, false);
  }
  assert.equal(evaluateFinalDeliveryOutcome(batchFixture, output, { ...observed, toolCalls: 1 }).passed, false);
  for (const change of [
    { resultDigest: 'forged' }, { factualCorrectness: 'verified' }, { basis: 'independently-verified' },
    { requirements: [] }, { requirements: [{ id: 'r1', status: 'unknown' }] },
  ]) assert.equal(evaluateFinalDeliveryOutcome(batchFixture, output, { ...observed, delivery: { ...observed.delivery, ...change } }).passed, false);
  assert.equal(evaluateFinalDeliveryOutcome(batchFixture, JSON.stringify({ ...batchAnswer, totalFee: 30 }), observed).passed, false);
});

test('correct numeric content without machine calculation receipts does not prove the runtime calculation gate works', () => {
  const output = JSON.stringify(batchAnswer);
  const observed = outcome(batchFixture, output);
  assert.deepEqual(batchFixture.expectedCalculations, [
    { path: ['processingHoursPerDay'], expected: 5 }, { path: ['totalJobs'], expected: 1800 },
    { path: ['totalFee'], expected: 90 }, { path: ['remainingBudget'], expected: 10 },
  ]);
  assert.equal(evaluateFinalDeliveryOutcome(batchFixture, output, observed).passed, true);
  const checkRequirements = (requirements) => evaluateFinalDeliveryOutcome(batchFixture, output,
    { ...observed, delivery: { ...observed.delivery, requirements } }).passed;
  assert.equal(checkRequirements(observed.delivery.requirements.filter((item) => !item.calculation)), false);
  for (const expected of batchFixture.expectedCalculations) {
    assert.equal(checkRequirements(observed.delivery.requirements.filter((item) =>
      JSON.stringify(item.calculation?.path) !== JSON.stringify(expected.path))), false);
  }
  for (const change of [{ path: ['wrongField'] }, { basis: 'model-assessment' }, { status: 'unknown' },
    { status: 'unsatisfied' }, { expected: 1.25 }, { actual: 1.25 }, { actual: null }]) {
    const requirements = structuredClone(observed.delivery.requirements);
    requirements[1].calculation = { ...requirements[1].calculation, ...change };
    assert.equal(checkRequirements(requirements), false);
  }
});

test('the original 600 / 120 = 1.25 live regression fails even when all models claim satisfaction', () => {
  const output = JSON.stringify({ ...batchAnswer, processingHoursPerDay: 1.25 });
  const observed = outcome(batchFixture, output);
  observed.delivery.requirements[1].calculation = { basis: 'deterministic-arithmetic', path: ['processingHoursPerDay'],
    status: 'satisfied', expected: 1.25, actual: 1.25 };
  assert.equal(evaluateFinalDeliveryOutcome(batchFixture, output, observed).passed, false);
});

test('raw JSON whitespace cannot bypass the requested character limit through minification', () => {
  for (const [fixture, answer] of [[batchFixture, batchAnswer], [unknownFixture, unknownAnswer]]) {
    const compact = JSON.stringify(answer);
    const inflated = `{\n${' '.repeat(701)}${compact.slice(1)}`;
    assert.deepEqual(JSON.parse(inflated), answer);
    assert.equal(evaluateJsonDelivery(fixture, inflated).passed, true, 'The parsed-content oracle alone does not measure original formatting.');
    assert.equal(evaluateFinalDeliveryOutcome(fixture, inflated, outcome(fixture, inflated)).passed, false);
    const exactlyLimit = `{${' '.repeat(700 - compact.length)}${compact.slice(1)}`;
    assert.equal(exactlyLimit.length, 700);
    assert.equal(evaluateFinalDeliveryOutcome(fixture, exactlyLimit, outcome(fixture, exactlyLimit)).passed, false);
    const fenced = `\`\`\`json\n${compact}\n\`\`\``;
    assert.equal(evaluateFinalDeliveryOutcome(fixture, fenced, outcome(fixture, fenced)).passed, true);
  }
});
