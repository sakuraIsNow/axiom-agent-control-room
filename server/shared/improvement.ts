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
