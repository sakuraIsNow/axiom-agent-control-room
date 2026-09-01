import type { WorkflowStep } from './contracts.js';

export type WorkflowDagIssue = {
  code: 'duplicate-step' | 'unknown-dependency' | 'self-dependency' | 'cycle';
  stepId?: string;
  dependency?: string;
};

export type WorkflowDagAnalysis = {
  valid: boolean;
  issues: WorkflowDagIssue[];
  waves: string[][];
};

/**
 * Validate a runtime plan before it is persisted or executed. Visual
 * workflows already have their own compiler, but model-produced plans and
 * resumed tasks must use the same deterministic DAG rules.
 */
export const analyzeWorkflowDag = (steps: readonly Pick<WorkflowStep, 'id' | 'dependsOn'>[]): WorkflowDagAnalysis => {
  const issues: WorkflowDagIssue[] = [];
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) issues.push({ code: 'duplicate-step', stepId: step.id });
    ids.add(step.id);
  }

  const indegree = new Map<string, number>([...ids].map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>([...ids].map((id) => [id, []]));
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        issues.push({ code: 'unknown-dependency', stepId: step.id, dependency });
        continue;
      }
      if (dependency === step.id) {
        issues.push({ code: 'self-dependency', stepId: step.id, dependency });
        continue;
      }
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      outgoing.get(dependency)?.push(step.id);
    }
  }

  const waves: string[][] = [];
  let ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  let visited = 0;
  while (ready.length > 0) {
    const wave = [...ready];
    waves.push(wave);
    ready = [];
    for (const id of wave) {
      visited += 1;
      for (const next of outgoing.get(id) ?? []) {
        const degree = (indegree.get(next) ?? 1) - 1;
        indegree.set(next, degree);
        if (degree === 0) ready.push(next);
      }
    }
    ready.sort();
  }
  if (visited !== ids.size) issues.push({ code: 'cycle' });
  return { valid: issues.length === 0, issues, waves: issues.length === 0 ? waves : [] };
};

export const workflowDagIssueText = (issue: WorkflowDagIssue) => {
  if (issue.code === 'duplicate-step') return `工作流包含重复步骤 ID“${issue.stepId ?? ''}”。`;
  if (issue.code === 'unknown-dependency') return `步骤“${issue.stepId ?? ''}”依赖不存在的步骤“${issue.dependency ?? ''}”。`;
  if (issue.code === 'self-dependency') return `步骤“${issue.stepId ?? ''}”不能依赖自身。`;
  return '工作流步骤包含循环依赖，无法计算执行顺序。';
};
