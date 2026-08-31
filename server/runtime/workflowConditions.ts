import type { StepResult, WorkflowStepCondition } from './contracts.js';

/**
 * Evaluate the small, deliberately non-Turing-complete condition language used
 * by visual Agent flows. Never pass user expressions to eval or a JS parser.
 */
export const evaluateWorkflowCondition = (expression: string, sourceResult: StepResult): boolean => {
  const value = expression.trim();
  const output = sourceResult.output.trim();
  if (value === 'not_empty') return output.length > 0;
  if (value === 'empty') return output.length === 0;
  if (value === 'true') return true;
  if (value === 'false') return false;

  const contains = value.match(/^contains\(\s*["']([\s\S]*?)["']\s*\)$/i);
  if (contains) return output.toLocaleLowerCase().includes(contains[1]!.toLocaleLowerCase());
  const equals = value.match(/^equals\(\s*["']([\s\S]*?)["']\s*\)$/i);
  if (equals) return output === equals[1];

  const confidence = value.match(/^confidence\s*(>=|<=|==|=|>|<)\s*(0(?:\.\d+)?|1(?:\.0+)?)$/i);
  if (confidence) {
    const threshold = Number(confidence[2]);
    const actual = sourceResult.confidence;
    switch (confidence[1]) {
      case '>': return actual > threshold;
      case '>=': return actual >= threshold;
      case '<': return actual < threshold;
      case '<=': return actual <= threshold;
      case '=':
      case '==': return actual === threshold;
      default: return false;
    }
  }
  return false;
};

export const evaluateWorkflowConditions = (
  conditions: WorkflowStepCondition[] | undefined,
  resultsByStepId: ReadonlyMap<string, StepResult>,
) => {
  if (!conditions?.length) return { ready: true, selected: true, missing: [] as string[] };
  const missing = conditions
    .map((condition) => condition.sourceStepId)
    .filter((stepId) => !resultsByStepId.has(stepId));
  if (missing.length) return { ready: false, selected: false, missing: [...new Set(missing)] };
  const selected = conditions.every((condition) => {
    const source = resultsByStepId.get(condition.sourceStepId);
    if (!source) return false;
    const matches = evaluateWorkflowCondition(condition.expression, source);
    return condition.branch === 'true' ? matches : !matches;
  });
  return { ready: true, selected, missing: [] as string[] };
};
