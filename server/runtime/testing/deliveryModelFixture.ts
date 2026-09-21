import assert from 'node:assert/strict';
import type { ModelCompletionRequest } from '../modelClient.js';

// Legacy execution fixtures assess only delivery existence. Semantic defects are
// exercised by the dedicated delivery-gate integration cases, not hidden here.
export const deliveryModelFixture = (request: ModelCompletionRequest) => {
  const extracting = request.system.startsWith("Extract the current user's delivery requirements");
  const assessing = request.system.startsWith('Assess the final delivery against every requirement');
  const auditing = request.system.startsWith('Audit the candidate delivery contract against original sources');
  if (!extracting && !assessing && !auditing) return undefined;
  assert.equal(request.toolChoice, 'none');
  assert.equal(request.tools?.length ?? 0, 0);
  const payload = JSON.parse(request.user);
  let content: string;
  if (auditing) {
    assert.ok(payload.sources.length);
    assert.ok(payload.candidateContract.requirements.length);
    assert.equal(Object.hasOwn(payload, 'finalDelivery'), false);
    content = JSON.stringify({ requirements: payload.candidateContract.requirements });
  } else if (extracting) {
    const source = payload.sources[0] as { id: string; text: string };
    assert.ok(source.text.trim());
    content = JSON.stringify({ requirements: [{ id: 'fixture-delivery', text: 'Return a non-empty fixture delivery.', sourceId: source.id, sourceQuote: source.text.slice(0, 200) }] });
  } else {
    assert.ok(payload.finalDelivery.trim());
    content = JSON.stringify({ requirements: payload.contract.requirements.map((requirement: { id: string }) => ({
      id: requirement.id, status: 'satisfied', reason: 'The authored execution fixture returned its non-empty candidate.', outputQuote: payload.finalDelivery.slice(0, 200),
    })) });
  }
  return { content, attempts: 1, durationMs: 1, finishReason: 'stop' };
};
