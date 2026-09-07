import type { AgentMessage, ReviewResult, StepResult } from './contracts.js';

export const formatDependencyContext = (result: StepResult, message: AgentMessage | undefined, previewChars: number) => {
  const handoff = message?.handoff;
  const summary = handoff?.summary ?? result.output.slice(0, previewChars);
  const content = message?.content ?? summary;
  return [
    `### ${result.stepId} (${result.role})`,
    `交接状态：${handoff?.status ?? 'complete'}`,
    ...(summary && !content.includes(summary) ? [`交接摘要：${summary}`] : []),
    `按连线传递的内容：${content}`,
    `未决问题：${handoff?.openQuestions.join('；') || '无'}`,
    `证据引用：${handoff?.evidenceIds.join(', ') || '无'}`,
    `result_ref: ${result.resultRef?.id ?? 'None.'}`,
    `Artifact refs: ${handoff?.artifactIds.join(', ') || (result.artifacts ?? []).map((artifact) => artifact.id).join(', ') || 'None.'}`,
  ].join('\n');
};

const reviewIssues = (review: ReviewResult) => [...new Set([...review.gaps, ...review.requiredCorrections]
  .map((issue) => issue.trim().replace(/\s+/g, ' ')).filter(Boolean))].sort();

/** Stop only an unchanged rejected review, not a newly discovered or improving finding. */
export const reviewMadeProgress = (before: ReviewResult, after: ReviewResult) => after.approved
  || after.score > before.score
  || JSON.stringify(reviewIssues(before)) !== JSON.stringify(reviewIssues(after));
