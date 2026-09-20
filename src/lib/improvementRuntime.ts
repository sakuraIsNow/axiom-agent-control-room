import type { ImprovementEvaluation, ImprovementEvaluationSuite, ImprovementProposal, ImprovementSource, ImprovementTrialDraft } from '../../server/shared/improvement';
import type { UiLanguage } from './uiLanguage';

export type { ImprovementEvaluation, ImprovementEvaluationSuite, ImprovementProposal, ImprovementSource, ImprovementTrialDraft };

export class ImprovementApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ImprovementApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/improvements${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new ImprovementApiError(response.status, body?.error ?? `HTTP ${response.status}`);
  return body;
}

export async function listImprovementSources(signal?: AbortSignal) {
  const result = await request<{ tasks: ImprovementSource[] }>('/sources', { signal });
  if (!Array.isArray(result.tasks)) throw new ImprovementApiError(502, 'Invalid improvement sources response.');
  return result.tasks;
}

export async function listImprovements(signal?: AbortSignal) {
  const result = await request<{ proposals: ImprovementProposal[] }>('', { signal });
  if (!Array.isArray(result.proposals)) throw new ImprovementApiError(502, 'Invalid improvement history response.');
  return result.proposals;
}

const proposalFrom = (result: { proposal: ImprovementProposal }) => {
  if (!result.proposal || typeof result.proposal.id !== 'string') throw new ImprovementApiError(502, 'Invalid improvement proposal response.');
  return result.proposal;
};

export async function getImprovement(id: string, signal?: AbortSignal) {
  return proposalFrom(await request<{ proposal: ImprovementProposal }>(`/${encodeURIComponent(id)}`, { signal }));
}

export async function createImprovement(input: {
  taskId: string;
  note?: string;
  parentId?: string;
  language: UiLanguage;
  idempotencyKey: string;
}, signal?: AbortSignal) {
  return proposalFrom(await request<{ proposal: ImprovementProposal }>('', { method: 'POST', body: JSON.stringify(input), signal }));
}

export async function updateImprovement(id: string, revision: number, status: 'accepted' | 'dismissed', signal?: AbortSignal) {
  return proposalFrom(await request<{ proposal: ImprovementProposal }>(`/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ revision, status }), signal,
  }));
}

export async function prepareImprovementTrial(id: string, revision: number, signal?: AbortSignal) {
  const result = await request<ImprovementTrialDraft>(`/${encodeURIComponent(id)}/prepare`, {
    method: 'POST', body: JSON.stringify({ revision }), signal,
  });
  if (typeof result.input !== 'string' || !['analyze', 'build', 'decide'].includes(result.mode) || !Array.isArray(result.warnings)) {
    throw new ImprovementApiError(502, 'Invalid improvement trial response.');
  }
  return result;
}

export async function getImprovementEvaluationSuite(signal?: AbortSignal) {
  const result = await request<{ suite: ImprovementEvaluationSuite }>('/evaluation-suite', { signal });
  if (!result.suite || typeof result.suite.id !== 'string') throw new ImprovementApiError(502, 'Invalid evaluation suite response.');
  return result.suite;
}

export async function listImprovementEvaluations(id: string, signal?: AbortSignal) {
  const result = await request<{ evaluations: ImprovementEvaluation[] }>(`/${encodeURIComponent(id)}/evaluations`, { signal });
  if (!Array.isArray(result.evaluations)) throw new ImprovementApiError(502, 'Invalid evaluation history response.');
  return result.evaluations;
}

const evaluationFrom = (result: { evaluation: ImprovementEvaluation }) => {
  if (!result.evaluation || typeof result.evaluation.id !== 'string') throw new ImprovementApiError(502, 'Invalid evaluation response.');
  return result.evaluation;
};

export async function startImprovementEvaluation(id: string, revision: number, idempotencyKey: string, signal?: AbortSignal) {
  return evaluationFrom(await request<{ evaluation: ImprovementEvaluation }>(`/${encodeURIComponent(id)}/evaluations`, {
    method: 'POST', body: JSON.stringify({ revision, idempotencyKey }), signal,
  }));
}

export async function cancelImprovementEvaluation(id: string, evaluationId: string, revision: number, signal?: AbortSignal) {
  return evaluationFrom(await request<{ evaluation: ImprovementEvaluation }>(`/${encodeURIComponent(id)}/evaluations/${encodeURIComponent(evaluationId)}/cancel`, {
    method: 'POST', body: JSON.stringify({ revision }), signal,
  }));
}
