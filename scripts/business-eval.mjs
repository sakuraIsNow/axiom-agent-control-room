import { readFile } from 'node:fs/promises';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:8787';
const cases = JSON.parse(await readFile(new URL('./business-cases.json', import.meta.url), 'utf8'));
const results = [];

for (const item of cases) {
  const response = await fetch(`${baseUrl}/api/runtime/triage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: item.input, mode: item.mode }),
  });
  const payload = await response.json();
  results.push({
    id: item.id,
    expectedRoute: item.expectedRoute,
    actualRoute: payload.profile?.route ?? 'error',
    expectedDifficulty: item.expectedDifficulty,
    actualDifficulty: payload.profile?.difficulty ?? 'unknown',
    passed: response.ok && payload.profile?.route === item.expectedRoute && payload.profile?.difficulty === item.expectedDifficulty,
  });
}

const passed = results.filter((item) => item.passed).length;
const report = {
  suite: 'axiom-business-cases-v1',
  passed,
  total: results.length,
  accuracy: passed / results.length,
  results,
};
console.log(JSON.stringify(report, null, 2));
if (passed !== results.length) process.exitCode = 1;
