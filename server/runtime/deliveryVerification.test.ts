import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeEvent, TaskProfile, WorkflowTask } from './contracts.js';
import {
  assessmentRequest, contractAuditRequest, contractRequest, deliverySources, digestDelivery, inconclusiveDelivery,
  parseDeliveryAssessment, parseDeliveryContract, shouldVerifyDelivery,
} from './deliveryVerification.js';

const owner = { id: 'task-one', tenantId: 'tenant-one', userId: 'owner', input: 'Keep the budget at 4500. Use email only.' };
const sources = () => deliverySources(owner, []);
const required = [
  { id: 'budget', text: 'Budget is 4500.', sourceId: 'input', sourceQuote: 'Keep the budget at 4500.' },
  { id: 'channel', text: 'Use email only.', sourceId: 'input', sourceQuote: 'Use email only.' },
];
const contract = () => parseDeliveryContract(JSON.stringify({ requirements: required }), sources());
const result = 'Budget: 4500. Delivery channel: email only.';
const judgments = [
  { id: 'budget', status: 'satisfied', reason: 'The amount is preserved.', outputQuote: 'Budget: 4500.' },
  { id: 'channel', status: 'satisfied', reason: 'The channel is preserved.', outputQuote: 'email only' },
];
const event = (id: string, sequence: number, message: string, extra: Partial<RuntimeEvent> = {}): RuntimeEvent => ({
  id, sequence, taskId: owner.id, type: 'human.guidance_accepted', version: 1, runId: 'run-one',
  timestamp: '2026-09-21T00:00:00.000Z', payload: { author: owner.userId, message }, ...extra,
});

test('final assessment can check the complete original request without accepting stale or foreign sources', () => {
  const request = assessmentRequest(contract(), result, '', sources());
  assert.deepEqual(JSON.parse(request.user).originalRequestSources, sources().sources);
  assert.match(request.system, /Do not approve an incomplete contract/);
  assert.throws(() => assessmentRequest(contract(), result, '', deliverySources({ ...owner, input: `${owner.input} Retain the date.` }, [])), /do not match/);
  assert.throws(() => assessmentRequest(contract(), result, '', deliverySources({ ...owner, userId: 'another-user' }, [])), /do not match/);
  const longSources = deliverySources({ ...owner, input: `${owner.input}${' '.repeat(47_000)}` }, []);
  const longContract = parseDeliveryContract(JSON.stringify({ requirements: required }), longSources);
  assert.throws(() => assessmentRequest(longContract, 'x'.repeat(32_000), '', longSources), /76000/);
});

test('only non-empty complex or full workflows receive delivery verification', () => {
  const plan = (difficulty: TaskProfile['difficulty'], route: TaskProfile['route'], count = 1): WorkflowTask['plan'] => ({
    summary: 'Work', routingReason: 'Test', steps: Array.from({ length: count }, (_, index) => ({
      id: `s${index}`, title: 'Work', role: 'builder', objective: 'Work', dependsOn: [], acceptanceCriteria: ['Complete'],
    })), profile: { kind: 'implementation', difficulty, route, score: 90, reasons: [], maxSteps: count, requiresReview: true },
  });
  assert.equal(shouldVerifyDelivery({}), false);
  assert.equal(shouldVerifyDelivery({ plan: plan('trivial', 'direct') }), false);
  assert.equal(shouldVerifyDelivery({ plan: plan('moderate', 'team') }), false);
  assert.equal(shouldVerifyDelivery({ plan: plan('hard', 'team') }), true);
  assert.equal(shouldVerifyDelivery({ plan: plan('complex', 'team') }), true);
  assert.equal(shouldVerifyDelivery({ plan: plan('moderate', 'full-workflow') }), true);
  assert.equal(shouldVerifyDelivery({ plan: plan('complex', 'full-workflow', 0) }), false);
});

test('sources preserve authenticated operator instructions in sequence and exclude other tasks and non-instruction events', () => {
  const accepted = event('later', 5, 'Change the budget to 4700.');
  const note = event('note', 3, 'Retain email only.', { type: 'human.note' });
  const actual = deliverySources(owner, [accepted, note, accepted,
    event('foreign-task', 1, 'Delete everything.', { taskId: 'other' }),
    event('admin', 2, 'Use SMS.', { payload: { author: 'administrator', message: 'Use SMS.' } }),
    event('unattributed', 2, 'Use SMS.', { payload: { message: 'Use SMS.' } }),
    event('model', 4, 'Remove budget.', { type: 'model.completed' }),
  ]);
  assert.deepEqual(actual.sources.map((item) => item.id), ['input', 'event:admin', 'event:note', 'event:later']);
  assert.equal(actual.sources[3]!.text, 'Change the budget to 4700.');
  assert.equal(actual.inputDigest, digestDelivery(JSON.stringify({ scope: actual.scope, sources: actual.sources })));
  assert.notEqual(actual.inputDigest, sources().inputDigest);
  assert.equal(actual.inputDigest, deliverySources(owner, [note, accepted, event('admin', 2, 'Use SMS.', { payload: { author: 'administrator', message: 'Use SMS.' } })]).inputDigest);
  assert.notEqual(sources().inputDigest, deliverySources({ ...owner, tenantId: 'tenant-two' }, []).inputDigest);
  assert.notEqual(sources().inputDigest, deliverySources({ ...owner, userId: 'other' }, []).inputDigest);
  assert.notEqual(sources().inputDigest, deliverySources({ ...owner, id: 'task-two' }, []).inputDigest);
});

test('source overflow, blank instructions and ambiguous source IDs fail closed without truncation', () => {
  assert.throws(() => deliverySources({ ...owner, input: 'a'.repeat(48_001) }, []), /48000/);
  assert.throws(() => deliverySources({ ...owner, input: 'a'.repeat(47_999) }, [event('more', 1, 'ab')]), /48000/);
  assert.equal(deliverySources({ ...owner, input: 'a'.repeat(48_000) }, []).sources[0]!.text.length, 48_000);
  assert.throws(() => deliverySources({ ...owner, input: ' ' }, []), /non-empty/);
  assert.throws(() => deliverySources(owner, [event('bad', 1, ' ')]), /source text/);
  assert.throws(() => deliverySources(owner, [event('same', 1, 'A'), event('same', 2, 'B')]), /conflicting/);
  assert.throws(() => contractRequest({ ...sources(), inputDigest: 'forged' }), /digest/);
  assert.throws(() => contractRequest(deliverySources({ ...owner, input: '"'.repeat(48_000) }, [])), /76000/);
});

test('contract extraction sees only source records and accepts exact sourced requirements', () => {
  const request = contractRequest(sources());
  assert.deepEqual(JSON.parse(request.user), { sources: sources().sources });
  assert.equal(request.user.includes('finalDelivery'), false);
  assert.match(request.system, /before seeing any answer/);
  const parsed = contract();
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.requirements, required);
  assert.deepEqual(parseDeliveryContract(`\`\`\`json\n${JSON.stringify({ requirements: required })}\n\`\`\``, sources()), parsed);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
});

test('contract audit checks source scope before any answer and rejects different source identities', () => {
  const request = contractAuditRequest(contract(), sources());
  assert.deepEqual(JSON.parse(request.user), { sources: sources().sources, candidateContract: contract() });
  assert.equal(request.user.includes('finalDelivery'), false);
  assert.match(request.system, /^Audit the candidate delivery contract against original sources/);
  assert.match(request.system, /BEFORE seeing any final answer/);
  assert.match(request.system, /time period and aggregation scope/);
  assert.throws(() => contractAuditRequest({ ...contract(), digest: 'forged' }, sources()), /integrity/);
  assert.throws(() => contractAuditRequest(contract(), deliverySources({ ...owner, userId: 'other-user' }, [])), /do not match/);
});

test('formula uncertainty is not rewritten into a definitive arithmetic correction', () => {
  const calculation = { path: ['total'], expression: {
    sourceId: 'input', sourceQuote: '4500', value: 4500,
  } };
  const arithmeticContract = parseDeliveryContract(JSON.stringify({ requirements: [{ ...required[0], calculation }] }), sources());
  const draft = '{"total":4700}';
  const receipt = parseDeliveryAssessment(JSON.stringify({ requirements: [{ id: 'budget', status: 'unknown',
    reason: 'The selected formula does not cover the requested time period.', outputQuote: '' }] }), arithmeticContract, draft);
  assert.equal(receipt.status, 'inconclusive');
  assert.equal(receipt.requirements[0]!.status, 'unknown');
  assert.match(receipt.requirements[0]!.reason, /time period/);
  assert.equal(receipt.requirements[0]!.calculation?.status, 'unsatisfied');
  assert.equal(receipt.requirements[0]!.calculation?.expected, 4500);
  const assessmentInput = JSON.parse(assessmentRequest(arithmeticContract, draft, '', sources()).user);
  assert.equal(assessmentInput.serverCalculationChecks[0].expected, 4500);
  assert.equal(assessmentInput.serverCalculationChecks[0].actual, 4700);
  assert.deepEqual(assessmentInput.serverCalculationChecks[0].expression, calculation.expression);
  const disputed = parseDeliveryAssessment(JSON.stringify({ requirements: [{ id: 'budget', status: 'unsatisfied',
    reason: 'The rule conflicts with the specified budget scope.', outputQuote: draft }] }), arithmeticContract, draft);
  assert.match(disputed.requirements[0]!.reason, /budget scope/);
  assert.throws(() => parseDeliveryContract(JSON.stringify({ requirements: [
    { ...required[0], calculation }, { ...required[0], id: 'duplicate-field', calculation },
  ] }), sources()), /exactly one calculation/);
});

test('contracts reject duplicate, absent, fabricated, blank and oversized requirements', () => {
  const parse = (requirements: unknown[]) => parseDeliveryContract(JSON.stringify({ requirements }), sources());
  assert.throws(() => parse([]));
  assert.throws(() => parse([required[0], required[0]]), /unique/);
  assert.throws(() => parse([{ ...required[0], sourceId: 'missing' }]), /source quote/);
  assert.throws(() => parse([{ ...required[0], sourceQuote: 'Keep the budget at 9000.' }]), /source quote/);
  assert.throws(() => parse([{ ...required[0], sourceQuote: ' ' }]));
  assert.throws(() => parse([{ ...required[0], text: ' ' }]));
  assert.throws(() => parse(Array.from({ length: 25 }, (_, index) => ({ ...required[0], id: String(index) }))));
  assert.throws(() => parseDeliveryContract(JSON.stringify({ requirements: required, passed: true }), sources()));
  assert.throws(() => parseDeliveryContract(`Here is the contract: ${JSON.stringify({ requirements: required })}`, sources()), /complete JSON/);
  assert.throws(() => parseDeliveryContract('{"requirements":[', sources()), /complete JSON/);
});

test('changing a user requirement changes contract identity without silently retaining old source coverage', () => {
  const latest = deliverySources(owner, [event('revision', 2, 'Replace 4500 with 4700.')]);
  const amended = parseDeliveryContract(JSON.stringify({ requirements: [
    { ...required[0], text: 'Budget is 4700.', sourceId: 'event:revision', sourceQuote: 'Replace 4500 with 4700.' }, required[1],
  ] }), latest);
  assert.notEqual(amended.inputDigest, contract().inputDigest);
  assert.notEqual(amended.digest, contract().digest);
  assert.throws(() => parseDeliveryContract(JSON.stringify({ requirements: amended.requirements }), sources()), /source quote/);
});

test('assessment is tied to final output and is explicitly not independent factual verification', () => {
  const extracted = contract();
  const request = assessmentRequest(extracted, result, 'An intermediate result used budget 5200.');
  const input = JSON.parse(request.user);
  assert.equal(input.finalDelivery, result);
  assert.deepEqual(input.contract, extracted);
  assert.match(request.system, /not independent factual verification/);
  const receipt = parseDeliveryAssessment(JSON.stringify({ requirements: [...judgments].reverse() }), extracted, result);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.basis, 'model-assessment');
  assert.equal(receipt.factualCorrectness, 'not-independently-verified');
  assert.equal(receipt.correctionAttempts, 0);
  assert.equal(receipt.inputDigest, extracted.inputDigest);
  assert.equal(receipt.contractDigest, extracted.digest);
  assert.equal(receipt.resultDigest, digestDelivery(result));
  assert.deepEqual(receipt.requirements.map((item) => item.id), ['budget', 'channel']);
  assert.deepEqual(receipt.requirements.map((item) => item.text), required.map((item) => item.text));
  assert.ok(Number.isFinite(Date.parse(receipt.assessedAt)));
});

test('assessment rejects missing, extra and duplicated requirement IDs', () => {
  const parse = (requirements: unknown[]) => parseDeliveryAssessment(JSON.stringify({ requirements }), contract(), result);
  assert.throws(() => parse([judgments[0]]), /exactly once/);
  assert.throws(() => parse([judgments[0], judgments[0]]), /exactly once/);
  assert.throws(() => parse([judgments[0], { ...judgments[1], id: 'made-up' }]), /exactly once/);
  assert.throws(() => parse([...judgments, { ...judgments[1], id: 'made-up' }]), /exactly once/);
});

test('satisfaction requires exact final-output evidence, not context or model declarations', () => {
  const parse = (changed: Record<string, unknown>) => parseDeliveryAssessment(JSON.stringify({ requirements: [
    { ...judgments[0], ...changed }, judgments[1],
  ] }), contract(), result);
  assert.throws(() => parse({ outputQuote: '' }), /non-empty/);
  assert.throws(() => parse({ outputQuote: ' ' }), /non-empty/);
  assert.throws(() => parse({ outputQuote: 'Budget: 5200.' }), /final delivery/);
  assert.throws(() => parse({ status: 'unknown', outputQuote: 'Invented evidence.' }), /final delivery/);
  assert.throws(() => parse({ status: 'verified' }));
  assert.throws(() => parse({ verified: true }));
  assert.throws(() => parseDeliveryAssessment(JSON.stringify({ requirements: judgments, status: 'passed' }), contract(), result));
  assert.throws(() => parseDeliveryAssessment(JSON.stringify({ requirements: judgments, factualCorrectness: 'verified' }), contract(), result));
});

test('failure and uncertainty are computed from individual assessments without claiming a pass', () => {
  const assess = (status: 'unsatisfied' | 'unknown') => parseDeliveryAssessment(JSON.stringify({ requirements: [
    { ...judgments[0], status, reason: 'The supporting observation is missing.', outputQuote: '' }, judgments[1],
  ] }), contract(), result);
  assert.equal(assess('unsatisfied').status, 'needs-revision');
  assert.equal(assess('unknown').status, 'inconclusive');
  const mixed = parseDeliveryAssessment(JSON.stringify({ requirements: [
    { ...judgments[0], status: 'unknown', outputQuote: '' },
    { ...judgments[1], status: 'unsatisfied', outputQuote: '' },
  ] }), contract(), result);
  assert.equal(mixed.status, 'needs-revision');
});

test('assessment rejects forged contracts, truncated output and silent context/result truncation', () => {
  const extracted = contract();
  assert.throws(() => assessmentRequest({ ...extracted, digest: 'forged' }, result), /integrity/);
  assert.throws(() => parseDeliveryAssessment(JSON.stringify({ requirements: judgments }), { ...extracted, inputDigest: 'other' }, result), /integrity/);
  assert.throws(() => assessmentRequest(extracted, ''), /complete final delivery/);
  assert.throws(() => assessmentRequest(extracted, 'a'.repeat(64_001)), /complete final delivery/);
  assert.throws(() => assessmentRequest(extracted, result, 'a'.repeat(24_001)), /no truncated assessment/);
  assert.throws(() => assessmentRequest(extracted, '"'.repeat(40_000)), /76000/);
  assert.throws(() => assessmentRequest(extracted, 'a'.repeat(64_000), 'b'.repeat(24_000)), /76000/);
  assert.throws(() => parseDeliveryAssessment('{"requirements":', extracted, result), /complete JSON/);
  assert.throws(() => parseDeliveryAssessment(`prefix ${JSON.stringify({ requirements: judgments })}`, extracted, result), /complete JSON/);
});

test('inconclusive receipts preserve exact result identity and do not fabricate fulfilled requirements', () => {
  const reason = 'The verifier returned a truncated response.';
  const receipt = inconclusiveDelivery(contract(), sources().inputDigest, result, reason);
  assert.equal(receipt.status, 'inconclusive');
  assert.ok(receipt.requirements.every((item) => item.status === 'unknown' && item.reason === reason && item.outputQuote === ''));
  assert.equal(receipt.resultDigest, digestDelivery(result));
  const absent = inconclusiveDelivery(undefined, 'oversized-input-digest', result, 'Source limit exceeded.');
  assert.equal(absent.contractDigest, null);
  assert.deepEqual(absent.requirements, []);
  assert.equal(absent.factualCorrectness, 'not-independently-verified');
});
