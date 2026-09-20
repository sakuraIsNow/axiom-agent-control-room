/** Controlled RSI candidates are private suggestions, never deployed runtime policy. */
export type ImprovementAnalysis = {
  summary: string;
  observations: Array<{ finding: string; evidence: string }>;
  changes: Array<{ target: 'prompt' | 'routing' | 'workflow' | 'verification'; suggestion: string; reason: string }>;
  trialInstruction: string;
  /** Suggested cases only: their presence does not mean any evaluation has run. */
  validationCases: Array<{ input: string; expectedBehavior: string }>;
  risks: string[];
};

export type ImprovementProposal = {
  id: string;
  revision: number;
  status: 'generating' | 'draft' | 'accepted' | 'dismissed' | 'failed';
  sourceTaskId: string;
  sourceTitle: string;
  mode: 'analyze' | 'build' | 'decide';
  createdAt: string;
  updatedAt: string;
  parentId?: string;
  generation: number;
  analysis?: ImprovementAnalysis;
  baseline: {
    status: string;
    model?: string;
    agentCount: number;
    tokens: number | null;
    durationMs: number | null;
    reviewScore: number | null;
  };
  model?: string;
  usageTokens?: number | null;
  error?: string;
  /** No implicit approval, benchmark result, or automatic policy promotion. */
  qualityStatus: 'unverified';
};

export type ImprovementSource = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  mode: 'analyze' | 'build' | 'decide';
};

export type ImprovementTrialDraft = {
  input: string;
  mode: 'analyze' | 'build' | 'decide';
  sourceTaskId: string;
  proposalId: string;
  warnings: string[];
};

/** Scores describe only the frozen, tool-free contract suite, never global policy quality. */
export type ImprovementQualityStatus = 'unverified' | 'improved' | 'no-clear-change' | 'regressed' | 'inconclusive';
export type ImprovementEvaluationCheck = {
  id: string;
  category: 'requirements' | 'facts' | 'references';
  passed: boolean;
  detail: string;
};
export type ImprovementEvaluationArm = {
  status: 'completed' | 'failed';
  output: string;
  checks: ImprovementEvaluationCheck[];
  latencyMs: number;
  tokens: number | null;
  attempts: number | null;
  error?: string;
};
export type ImprovementEvaluationCase = {
  fixtureId: string;
  title: string;
  scope: string;
  baseline?: ImprovementEvaluationArm;
  candidate?: ImprovementEvaluationArm;
};
export type ImprovementEvaluationSummary = {
  baselinePassed: number;
  candidatePassed: number;
  totalChecks: number;
  baselineTokens: number | null;
  candidateTokens: number | null;
  baselineLatencyMs: number | null;
  candidateLatencyMs: number | null;
  monetaryCost: null;
  humanInterventions: null;
  improvedChecks: number;
  regressedChecks: number;
};
export type ImprovementEvaluation = {
  id: string;
  revision: number;
  proposalId: string;
  proposalRevision: number;
  suiteId: string;
  suiteVersion: string;
  suiteDigest: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  qualityStatus: ImprovementQualityStatus;
  model?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  progress: { completed: number; total: number };
  cases: ImprovementEvaluationCase[];
  summary: ImprovementEvaluationSummary;
  limitations: string[];
  error?: string;
};
export type ImprovementEvaluationSuite = {
  id: string;
  version: string;
  digest: string;
  cases: Array<{ id: string; title: string; scope: string }>;
  modelCalls: number;
  maxOutputTokensPerCall: number;
  timeoutMs: number;
  limitations: string[];
};
