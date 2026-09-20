import type { StepResult } from './contracts.js';

/** Only receipts for the task-owned creation tool can add a generated download. */
export const appendGeneratedArtifactLinks = (output: string, taskId: string, results: Pick<StepResult, 'stepId' | 'toolCalls' | 'artifacts'>[]) => {
  let delivered = output;
  for (const result of results) {
    for (const call of result.toolCalls ?? []) {
      if (call.name !== 'artifact.create' || !call.id) continue;
      const id = `tool:${taskId}:${result.stepId}:${call.id}:artifact`;
      const artifact = result.artifacts?.find((candidate) => candidate.id === id);
      if (!artifact) continue;
      const url = `/api/tasks/${encodeURIComponent(taskId)}/artifacts/files/${encodeURIComponent(id)}`;
      if (delivered.includes(`](${url})`)) continue;
      const name = artifact.name.replace(/[\[\]\\<>\r\n]/g, ' ').trim() || 'Artifact';
      delivered = `${delivered}\n\n[${name}](${url})`;
    }
  }
  return delivered;
};
