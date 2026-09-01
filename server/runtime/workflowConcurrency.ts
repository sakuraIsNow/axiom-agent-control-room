import type { WorkflowStep } from './contracts.js';

const normalizeScope = (value: string) => value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();

const scopeOverlaps = (left: string, right: string) => {
  if (left === '*' || right === '*' || left === 'workspace:*' || right === 'workspace:*') return true;
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

/**
 * Select a deterministic, non-conflicting execution batch. Steps that only
 * read may run together; declared overlapping write scopes are held for the
 * next scheduler pass. An undeclared builder is conservatively workspace-wide.
 */
export const selectNonConflictingSteps = (steps: readonly WorkflowStep[], limit: number) => {
  const selected: WorkflowStep[] = [];
  const occupied: string[] = [];
  for (const step of steps) {
    if (selected.length >= Math.max(1, limit)) break;
    const scopes = (step.writeScopes?.length ? step.writeScopes : step.role === 'builder' ? ['workspace:*'] : [])
      .map(normalizeScope)
      .filter(Boolean);
    if (scopes.some((scope) => occupied.some((existing) => scopeOverlaps(scope, existing)))) continue;
    selected.push(step);
    occupied.push(...scopes);
  }
  return selected;
};

