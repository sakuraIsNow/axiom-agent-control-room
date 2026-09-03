import type { ModelRoutingStats, RuntimeEvent, TaskKind } from './contracts.js';

export type ModelRoutingCandidate = {
  model: string;
  inputCostPer1kUsd?: number;
  outputCostPer1kUsd?: number;
  kinds?: TaskKind[];
  roles?: string[];
};

export type ModelRoutingContext = {
  kind?: TaskKind;
  role?: string;
};

type ModelStats = {
  attempts: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  totalTokens: number;
  latencySamples: number[];
  reviewerAttempts: number;
  reviewerFirstPasses: number;
  retries: number;
  humanTakeovers: number;
  feedbackCount: number;
  feedbackScoreTotal: number;
  lastUsedAt?: string;
};

export type ModelRoutingSnapshot = {
  candidates: Array<ModelRoutingCandidate & {
    attempts: number;
    successes: number;
    failures: number;
    successRate: number;
    averageLatencyMs: number;
    totalTokens: number;
    reviewerAttempts: number;
    reviewerFirstPassRate: number;
    retries: number;
    humanTakeovers: number;
    feedbackCount: number;
    averageFeedbackScore: number | null;
    score: number;
    explanation: string;
    lastUsedAt?: string;
  }>;
};

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

export const parseModelCostCatalog = (raw: string | undefined) => {
  if (!raw?.trim()) return new Map<string, Pick<ModelRoutingCandidate, 'inputCostPer1kUsd' | 'outputCostPer1kUsd' | 'kinds' | 'roles'>>();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const catalog = new Map<string, Pick<ModelRoutingCandidate, 'inputCostPer1kUsd' | 'outputCostPer1kUsd' | 'kinds' | 'roles'>>();
    for (const [model, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      const input = finite(entry.inputCostPer1kUsd);
      const output = finite(entry.outputCostPer1kUsd);
      const kinds = Array.isArray(entry.kinds)
        ? entry.kinds.filter((kind): kind is TaskKind => typeof kind === 'string' && ['conversation', 'question', 'research', 'implementation', 'decision', 'creative', 'operations'].includes(kind))
        : [];
      const roles = Array.isArray(entry.roles)
        ? entry.roles.filter((role): role is string => typeof role === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(role)).slice(0, 16)
        : [];
      catalog.set(model.trim(), {
        ...(input > 0 ? { inputCostPer1kUsd: input } : {}),
        ...(output > 0 ? { outputCostPer1kUsd: output } : {}),
        ...(kinds.length ? { kinds } : {}),
        ...(roles.length ? { roles } : {}),
      });
    }
    return catalog;
  } catch {
    return new Map<string, Pick<ModelRoutingCandidate, 'inputCostPer1kUsd' | 'outputCostPer1kUsd' | 'kinds' | 'roles'>>();
  }
};

const normalizedCandidates = (
  models: Iterable<string | ModelRoutingCandidate>,
  costs: Map<string, Pick<ModelRoutingCandidate, 'inputCostPer1kUsd' | 'outputCostPer1kUsd' | 'kinds' | 'roles'>>,
) => {
  const seen = new Set<string>();
  const result: ModelRoutingCandidate[] = [];
  for (const item of models) {
    const model = typeof item === 'string' ? item.trim() : item.model.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const value = typeof item === 'string' ? costs.get(model) : item;
    result.push({
      model,
      ...(value?.inputCostPer1kUsd ? { inputCostPer1kUsd: value.inputCostPer1kUsd } : {}),
      ...(value?.outputCostPer1kUsd ? { outputCostPer1kUsd: value.outputCostPer1kUsd } : {}),
      ...(value?.kinds?.length ? { kinds: value.kinds } : {}),
      ...(value?.roles?.length ? { roles: value.roles } : {}),
    });
  }
  return result;
};

/**
 * Scores only an explicit, server-side candidate catalog. The model is never
 * accepted from free-form planner output, and a user-selected task model is
 * handled by the caller before this policy is consulted.
 */
export class ModelRoutingPolicy {
  private readonly stats = new Map<string, ModelStats>();
  private readonly costs: Map<string, Pick<ModelRoutingCandidate, 'inputCostPer1kUsd' | 'outputCostPer1kUsd' | 'kinds' | 'roles'>>;

  constructor(costs = new Map<string, Pick<ModelRoutingCandidate, 'inputCostPer1kUsd' | 'outputCostPer1kUsd' | 'kinds' | 'roles'>>()) {
    this.costs = costs;
  }

  restore(records: ModelRoutingStats[]) {
    for (const record of records) {
      const model = record.model.trim();
      if (!model) continue;
      const attempts = Math.max(0, Math.floor(finite(record.attempts)));
      const successes = Math.min(attempts, Math.max(0, Math.floor(finite(record.successes))));
      const failures = Math.min(attempts, Math.max(0, Math.floor(finite(record.failures))));
      this.stats.set(model, {
        attempts,
        successes,
        failures,
        totalLatencyMs: Math.max(0, finite(record.totalLatencyMs)),
        totalTokens: Math.max(0, finite(record.totalTokens)),
        latencySamples: [],
        reviewerAttempts: Math.max(0, Math.floor(finite(record.reviewerAttempts))),
        reviewerFirstPasses: Math.max(0, Math.floor(finite(record.reviewerFirstPasses))),
        retries: Math.max(0, Math.floor(finite(record.retries))),
        humanTakeovers: Math.max(0, Math.floor(finite(record.humanTakeovers))),
        feedbackCount: 0,
        feedbackScoreTotal: 0,
        ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
      });
    }
  }

  select(models: Iterable<string | ModelRoutingCandidate>, _context: ModelRoutingContext = {}) {
    const candidates = normalizedCandidates(models, this.costs);
    if (!candidates.length) return undefined;
    const scored = candidates.map((candidate, index) => {
      const stats = this.stats.get(candidate.model);
      const attempts = stats?.attempts ?? 0;
      const successes = stats?.successes ?? 0;
      const successRate = (successes + 1) / (attempts + 2);
      const averageLatencyMs = attempts ? (stats?.totalLatencyMs ?? 0) / attempts : 2_000;
      const cost = (candidate.inputCostPer1kUsd ?? 0) + (candidate.outputCostPer1kUsd ?? 0);
      const kindAffinity = _context.kind && candidate.kinds?.length
        ? (candidate.kinds.includes(_context.kind) ? 18 : -18)
        : 0;
      const roleAffinity = _context.role && candidate.roles?.length
        ? (candidate.roles.includes(_context.role) ? 12 : -12)
        : 0;
      const reviewRate = ((stats?.reviewerFirstPasses ?? 0) + 1) / ((stats?.reviewerAttempts ?? 0) + 2);
      const retryRate = (stats?.retries ?? 0) / Math.max(1, attempts);
      const takeoverRate = (stats?.humanTakeovers ?? 0) / Math.max(1, attempts);
      const feedbackQuality = stats?.feedbackCount ? stats.feedbackScoreTotal / stats.feedbackCount / 5 : 0.6;
      // Cold candidates remain viable, while repeated failures and slow or
      // expensive providers naturally lose to a healthier alternative.
      const score = successRate * 70 + reviewRate * 18 + feedbackQuality * 18 + kindAffinity + roleAffinity
        - retryRate * 16 - takeoverRate * 24 - averageLatencyMs / 120 - Math.min(20, cost * 100);
      return { candidate, score, index };
    });
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    return scored[0]!.candidate.model;
  }

  record(input: {
    model: string;
    success: boolean;
    durationMs?: number;
    totalTokens?: number;
    timestamp?: string;
  }) {
    const model = input.model.trim();
    if (!model) return;
    const current = this.stats.get(model) ?? {
      attempts: 0,
      successes: 0,
      failures: 0,
      totalLatencyMs: 0,
      totalTokens: 0,
      latencySamples: [],
      reviewerAttempts: 0,
      reviewerFirstPasses: 0,
      retries: 0,
      humanTakeovers: 0,
      feedbackCount: 0,
      feedbackScoreTotal: 0,
    } satisfies ModelStats;
    current.attempts += 1;
    if (input.success) current.successes += 1;
    else current.failures += 1;
    current.totalLatencyMs += Math.max(0, finite(input.durationMs));
    current.totalTokens += Math.max(0, finite(input.totalTokens));
    if (input.durationMs !== undefined && Number.isFinite(input.durationMs)) {
      current.latencySamples.push(Math.max(0, input.durationMs));
      current.latencySamples = current.latencySamples.slice(-2_000);
    }
    current.lastUsedAt = input.timestamp ?? new Date().toISOString();
    this.stats.set(model, current);
  }

  recordQualityOutcome(input: { model: string; approved: boolean; firstPass?: boolean }) {
    const model = input.model.trim();
    if (!model) return;
    const current = this.ensure(model);
    current.reviewerAttempts += 1;
    if (input.approved && input.firstPass !== false) current.reviewerFirstPasses += 1;
  }

  recordFeedback(input: { model: string; score: number; routingIssue?: boolean; humanTakeover?: boolean }) {
    const model = input.model.trim();
    if (!model || !Number.isFinite(input.score)) return;
    const current = this.ensure(model);
    current.feedbackCount += 1;
    current.feedbackScoreTotal += Math.min(5, Math.max(1, input.score));
    if (input.routingIssue || input.humanTakeover) current.humanTakeovers += 1;
  }

  private ensure(model: string) {
    const current = this.stats.get(model) ?? {
      attempts: 0, successes: 0, failures: 0, totalLatencyMs: 0, totalTokens: 0, latencySamples: [],
      reviewerAttempts: 0, reviewerFirstPasses: 0, retries: 0, humanTakeovers: 0, feedbackCount: 0, feedbackScoreTotal: 0,
    } satisfies ModelStats;
    this.stats.set(model, current);
    return current;
  }

  recordEvent(event: RuntimeEvent) {
    if (event.type === 'model.completed' && typeof event.payload.model === 'string') {
      this.record({
        model: event.payload.model,
        success: true,
        durationMs: finite(event.payload.durationMs),
        totalTokens: finite(event.payload.totalTokens),
        timestamp: event.timestamp,
      });
    }
    if (event.type === 'agent.failed' && typeof event.payload.model === 'string') {
      this.record({ model: event.payload.model, success: false, timestamp: event.timestamp });
    }
    if (event.type === 'review.completed' && typeof event.payload.model === 'string') {
      this.recordQualityOutcome({ model: event.payload.model, approved: event.payload.approved === true, firstPass: Number(event.payload.attempt ?? 1) === 1 });
    }
    if (event.type === 'agent.retrying') {
      const model = typeof event.payload.model === 'string' ? event.payload.model : typeof event.payload.failedModel === 'string' ? event.payload.failedModel : '';
      if (model) this.ensure(model).retries += 1;
    }
    if (event.type === 'node.replace_requested' && typeof event.payload.previousModel === 'string') this.ensure(event.payload.previousModel).humanTakeovers += 1;
  }

  snapshot(models: Iterable<string | ModelRoutingCandidate>) : ModelRoutingSnapshot {
    return {
      candidates: normalizedCandidates(models, this.costs).map((candidate) => {
        const stats = this.stats.get(candidate.model);
        const attempts = stats?.attempts ?? 0;
        const successes = stats?.successes ?? 0;
        const successRate = stats ? successes / Math.max(1, attempts) : 0;
        const averageLatencyMs = Math.round(attempts ? (stats?.totalLatencyMs ?? 0) / attempts : 0);
        const reviewerAttempts = stats?.reviewerAttempts ?? 0;
        const reviewerFirstPassRate = reviewerAttempts ? (stats?.reviewerFirstPasses ?? 0) / reviewerAttempts : 0;
        const averageFeedbackScore = stats?.feedbackCount ? stats.feedbackScoreTotal / stats.feedbackCount : null;
        const selectedScore = successRate * 70 + ((reviewerAttempts ? reviewerFirstPassRate : 0.5) * 18)
          + ((averageFeedbackScore === null ? 0.6 : averageFeedbackScore / 5) * 18)
          - ((stats?.retries ?? 0) / Math.max(1, attempts)) * 16
          - ((stats?.humanTakeovers ?? 0) / Math.max(1, attempts)) * 24
          - averageLatencyMs / 120
          - Math.min(20, ((candidate.inputCostPer1kUsd ?? 0) + (candidate.outputCostPer1kUsd ?? 0)) * 100);
        return {
          ...candidate,
          attempts,
          successes,
          failures: stats?.failures ?? 0,
          successRate: Number(successRate.toFixed(4)),
          averageLatencyMs,
          totalTokens: Math.round(stats?.totalTokens ?? 0),
          reviewerAttempts,
          reviewerFirstPassRate: Number(reviewerFirstPassRate.toFixed(4)),
          retries: stats?.retries ?? 0,
          humanTakeovers: stats?.humanTakeovers ?? 0,
          feedbackCount: stats?.feedbackCount ?? 0,
          averageFeedbackScore: averageFeedbackScore === null ? null : Number(averageFeedbackScore.toFixed(2)),
          score: Number(selectedScore.toFixed(2)),
          explanation: attempts
            ? `成功率 ${Math.round(successRate * 100)}%，首次审查通过率 ${reviewerAttempts ? `${Math.round(reviewerFirstPassRate * 100)}%` : '暂无样本'}，平均 ${averageLatencyMs} ms，重试 ${stats?.retries ?? 0} 次，人工接管 ${stats?.humanTakeovers ?? 0} 次。`
            : '暂无执行样本，按能力画像、成本和冷启动先验参与选择。',
          ...(stats?.lastUsedAt ? { lastUsedAt: stats.lastUsedAt } : {}),
        };
      }),
    };
  }
}
