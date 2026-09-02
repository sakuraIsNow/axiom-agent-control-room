import { createHash } from 'node:crypto';
import type { ReviewResult, RuntimeEvent, StepResult, WorkflowPlan, WorkflowTask } from './contracts.js';

export type CheckpointSnapshot = {
  plan: WorkflowPlan | null;
  stepResults: StepResult[];
  review: ReviewResult | null;
  result: string | null;
};

export type TaskCheckpoint = {
  checkpointId: string;
  eventId: string;
  sequence: number;
  createdAt: string;
  stage: string;
  revision: number;
  planVersion: number;
  graphRevision: number;
  completedSteps: number;
  failedSteps: number;
  totalSteps: number;
  restorable: boolean;
  snapshot?: CheckpointSnapshot;
};

export type CheckpointStepDiff = {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
};

export type CheckpointDiff = {
  baseCheckpointId: string;
  targetTaskId: string;
  baseRevision: number;
  targetRevision: number;
  planChanged: boolean;
  steps: CheckpointStepDiff;
};

export type CheckpointMergeStrategy = 'manual' | 'prefer-branch' | 'prefer-current';

const finiteInteger = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isInteger(value) && value >= 0
  ? value
  : fallback;

const snapshotFromPayload = (value: unknown): CheckpointSnapshot | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.stepResults)) return undefined;
  const plan = candidate.plan === null || (candidate.plan && typeof candidate.plan === 'object')
    ? candidate.plan as WorkflowPlan | null
    : null;
  return {
    plan,
    stepResults: candidate.stepResults as StepResult[],
    review: candidate.review && typeof candidate.review === 'object' ? candidate.review as ReviewResult : null,
    result: typeof candidate.result === 'string' ? candidate.result : null,
  };
};

export const checkpointsFromEvents = (events: RuntimeEvent[]): TaskCheckpoint[] => events
  .filter((event) => event.type === 'checkpoint.saved')
  .map((event) => {
    const snapshot = snapshotFromPayload(event.payload.snapshot);
    return {
      checkpointId: typeof event.payload.checkpointId === 'string' && event.payload.checkpointId
        ? event.payload.checkpointId
        : `legacy-${event.sequence}`,
      eventId: event.id,
      sequence: event.sequence,
      createdAt: event.timestamp,
      stage: typeof event.payload.stage === 'string' ? event.payload.stage : 'runtime',
      revision: finiteInteger(event.payload.revision),
      planVersion: finiteInteger(event.payload.planVersion),
      graphRevision: finiteInteger(event.payload.graphRevision),
      completedSteps: finiteInteger(event.payload.completedSteps),
      failedSteps: finiteInteger(event.payload.failedSteps),
      totalSteps: finiteInteger(event.payload.totalSteps),
      restorable: Boolean(snapshot),
      ...(snapshot ? { snapshot } : {}),
    };
  });

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

const stepMap = (results: StepResult[]) => new Map(results.map((result) => [result.stepId, result]));

export const diffCheckpointToTask = (checkpoint: TaskCheckpoint, task: WorkflowTask): CheckpointDiff => {
  const base = stepMap(checkpoint.snapshot?.stepResults ?? []);
  const target = stepMap(task.stepResults);
  const ids = [...new Set([...base.keys(), ...target.keys()])].sort();
  const steps: CheckpointStepDiff = { added: [], removed: [], changed: [], unchanged: [] };
  for (const id of ids) {
    const before = base.get(id);
    const after = target.get(id);
    if (!before && after) steps.added.push(id);
    else if (before && !after) steps.removed.push(id);
    else if (fingerprint(before) !== fingerprint(after)) steps.changed.push(id);
    else steps.unchanged.push(id);
  }
  return {
    baseCheckpointId: checkpoint.checkpointId,
    targetTaskId: task.id,
    baseRevision: checkpoint.revision,
    targetRevision: task.revision,
    planChanged: fingerprint(checkpoint.snapshot?.plan) !== fingerprint(task.plan ?? null),
    steps,
  };
};

export const mergeCheckpointBranch = (
  checkpoint: TaskCheckpoint,
  current: WorkflowTask,
  branch: WorkflowTask,
  strategy: CheckpointMergeStrategy,
) => {
  if (!checkpoint.snapshot) throw new Error('Checkpoint snapshot is not restorable.');
  const base = stepMap(checkpoint.snapshot.stepResults);
  const left = stepMap(current.stepResults);
  const right = stepMap(branch.stepResults);
  const conflicts: string[] = [];
  const merged = new Map<string, StepResult>();
  const ids = [...new Set([...base.keys(), ...left.keys(), ...right.keys()])].sort();

  for (const id of ids) {
    const baseResult = base.get(id);
    const currentResult = left.get(id);
    const branchResult = right.get(id);
    const baseHash = fingerprint(baseResult);
    const currentHash = fingerprint(currentResult);
    const branchHash = fingerprint(branchResult);
    const currentChanged = currentHash !== baseHash;
    const branchChanged = branchHash !== baseHash;
    const conflict = currentChanged && branchChanged && currentHash !== branchHash;
    if (conflict) conflicts.push(id);
    const selected = conflict
      ? strategy === 'prefer-branch' ? branchResult : currentResult
      : branchChanged ? branchResult : currentResult;
    if (selected) merged.set(id, selected);
  }

  const basePlanHash = fingerprint(checkpoint.snapshot.plan);
  const currentPlanHash = fingerprint(current.plan ?? null);
  const branchPlanHash = fingerprint(branch.plan ?? null);
  const planConflict = currentPlanHash !== basePlanHash && branchPlanHash !== basePlanHash && currentPlanHash !== branchPlanHash;
  if (planConflict) conflicts.push('$plan');
  const plan = planConflict
    ? strategy === 'prefer-branch' ? branch.plan : current.plan
    : branchPlanHash !== basePlanHash ? branch.plan : current.plan;

  return {
    conflicts,
    plan: plan ?? checkpoint.snapshot.plan,
    stepResults: [...merged.values()],
    canMerge: conflicts.length === 0 || strategy !== 'manual',
  };
};
