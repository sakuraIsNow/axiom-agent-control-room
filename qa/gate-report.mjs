export function classifyGateAttempts(attempts) {
  if (!attempts.length) throw new Error('A gate result must retain at least one attempt.');
  const last = attempts.at(-1);
  const firstPassPassed = attempts[0].status === 'passed';
  const flaky = last.status === 'passed' && attempts.some((attempt) => attempt.status !== 'passed');
  return {
    ...last,
    status: flaky ? 'unstable' : last.status,
    firstPassPassed,
    retried: attempts.length > 1,
    flaky,
    durationMs: attempts.reduce((total, attempt) => total + (attempt.durationMs ?? 0), 0),
    attempts,
  };
}

export function summarizeGateResults(results) {
  const count = (status) => results.filter((result) => result.status === status).length;
  const failed = count('failed');
  const unstable = count('unstable');
  const passed = count('passed');
  const skipped = count('skipped');
  const executed = results.length - skipped;
  const firstPassPassed = results.filter((result) => result.firstPassPassed === true).length;
  return {
    status: failed > 0 || executed === 0 ? 'failed' : unstable > 0 ? 'unstable' : 'passed',
    passed,
    failed,
    unstable,
    skipped,
    firstPassPassed,
    firstPassRate: executed > 0 ? firstPassPassed / executed : null,
    retried: results.filter((result) => result.retried === true).length,
    flaky: results.filter((result) => result.flaky === true).length,
    results,
  };
}

export const gateExitCode = (summary) => summary.status === 'passed' ? 0 : 1;
