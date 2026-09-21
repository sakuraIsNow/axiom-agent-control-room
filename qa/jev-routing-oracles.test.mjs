import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateJevRoutingCase, jevRoutingCases, jevRoutingMeasurement, summarizeJevRoutingResults } from './lib/jev-routing-cases.mjs';

const item = (id) => jevRoutingCases.find((value) => value.id === id);
const answer = (intent, agents, requiresExternalFacts = false, extra = {}) => ({ intent, candidateAgentIds: agents, candidateSkillIds: [], requiresExternalFacts, ...extra });

test('synthetic Chinese routing cases cover intent, mixed attachments, history and hostile selections', () => {
  assert.equal(jevRoutingCases.length, 26);
  assert.equal(new Set(jevRoutingCases.map((value) => value.id)).size, jevRoutingCases.length);
  for (const value of jevRoutingCases) {
    assert.ok(value.input.message.trim());
    assert.ok(value.input.availableAgents.length);
    assert.equal(value.expected.allowAbstain, true);
    assert.deepEqual(value.input.availableSkills, []);
  }
  assert.equal(item('mixed-attachments').input.attachments.length, 2);
  assert.ok(item('context-no-retrieval').input.conversationContext.length);
});

test('selected routing must match both intent and capability, not merely choose some available agent', () => {
  assert.equal(evaluateJevRoutingCase(item('weather-current'), answer('web-search', ['search-agent'], true)).outcome, 'accepted-correct');
  assert.equal(evaluateJevRoutingCase(item('weather-current'), answer('conversation', ['direct-responder'])).outcome, 'accepted-wrong');
  assert.equal(evaluateJevRoutingCase(item('mixed-attachments'), answer('task', ['vision-agent', 'document-agent'])).outcome, 'accepted-correct');
  assert.ok(evaluateJevRoutingCase(item('mixed-attachments'), answer('task', ['vision-agent'])).violations.includes('missing-required-agent'));
});

test('history constraints, negation and capability injection have independent rejection checks', () => {
  assert.ok(evaluateJevRoutingCase(item('context-no-retrieval'), answer('task', ['analyst', 'search-agent'], true)).violations.includes('prohibited-agent'));
  assert.ok(evaluateJevRoutingCase(item('cancel-image'), answer('conversation', ['direct-responder', 'drawing-agent'])).violations.includes('prohibited-agent'));
  assert.ok(evaluateJevRoutingCase(item('injection-unavailable-agent'), answer('conversation', ['super-admin-agent'])).violations.includes('unavailable-agent'));
  assert.ok(evaluateJevRoutingCase(item('chat-greeting'), answer('conversation', ['direct-responder'], false, { candidateSkillIds: ['hidden-skill'] })).violations.includes('unavailable-skill'));
  assert.ok(evaluateJevRoutingCase(item('unavailable-image-capability'), answer('conversation', ['direct-responder'])).violations.includes('selection-when-abstention-required'));
});

test('export scope and format cannot be replaced with generic report intent', () => {
  const selected = answer('report-export', ['report-agent'], false, { reportExport: { scope: 'conversation', format: 'docx' } });
  assert.equal(evaluateJevRoutingCase(item('export-word'), selected).outcome, 'accepted-correct');
  assert.ok(evaluateJevRoutingCase(item('export-pdf'), selected).violations.includes('report-export-mismatch'));
});

test('abstention is separate from accuracy and all-abstain results have no measured precision', () => {
  const outcomes = jevRoutingCases.map((value) => evaluateJevRoutingCase(value, null));
  assert.ok(outcomes.every((value) => value.outcome === 'abstained'));
  assert.deepEqual(summarizeJevRoutingResults(outcomes), { total: 26, selected: 0, acceptedCorrect: 0, acceptedWrong: 0, abstained: 26, errors: 0, selectedPrecision: null, coverage: 0, correctSelectionRate: 0 });
  assert.deepEqual(summarizeJevRoutingResults([{ outcome: 'accepted-correct' }, { outcome: 'accepted-wrong' }, { outcome: 'abstained' }, { outcome: 'error' }]),
    { total: 4, selected: 2, acceptedCorrect: 1, acceptedWrong: 1, abstained: 1, errors: 1, selectedPrecision: 0.5, coverage: 0.5, correctSelectionRate: 0.25 });
});

test('malformed or duplicate selections cannot be accepted and null is the only abstention payload', () => {
  assert.equal(evaluateJevRoutingCase(item('chat-greeting'), undefined).outcome, 'accepted-wrong');
  assert.equal(evaluateJevRoutingCase(item('chat-greeting'), answer('conversation', ['direct-responder', 'direct-responder'])).outcome, 'accepted-wrong');
  assert.equal(evaluateJevRoutingCase(item('chat-greeting'), { intent: 'conversation' }).outcome, 'accepted-wrong');
});

test('pre-request abstention never labels configured model or zero tokens as measured provider usage', () => {
  const result = { decision: null, model: 'configured-model', totalTokens: 0, promptCharacters: 0, reason: 'unsupported' };
  assert.deepEqual(jevRoutingMeasurement(result, 0), { attempted: false, requests: 0, actualModel: null, totalTokens: null, promptCharacters: 0 });
  assert.deepEqual(jevRoutingMeasurement({ ...result, model: 'reported-model', totalTokens: 25, promptCharacters: 120 }, 1),
    { attempted: true, requests: 1, actualModel: 'reported-model', totalTokens: 25, promptCharacters: 120 });
  assert.equal(jevRoutingMeasurement({ ...result, totalTokens: null }, 1).totalTokens, null);
});
