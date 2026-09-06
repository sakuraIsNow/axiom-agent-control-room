import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = ['--import', 'tsx', '--test', 'server/runtime/mcpBusinessEval.test.ts'];
const child = spawn(process.execPath, args, { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text); });
child.stderr.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stderr.write(text); });
const code = await new Promise((resolveCode, reject) => {
  child.once('error', reject);
  child.once('close', (exitCode, signal) => resolveCode(exitCode ?? (signal ? 1 : 0)));
});
const passed = (output.match(/^ok \d+ - /gmu) ?? []).length;
const failed = (output.match(/^not ok \d+ - /gmu) ?? []).length;
const p0Passed = (output.match(/^ok \d+ - P0-/gmu) ?? []).length;
const p1Passed = (output.match(/^ok \d+ - P1-/gmu) ?? []).length;
const p0Failed = (output.match(/^not ok \d+ - P0-/gmu) ?? []).length;
const p1Failed = (output.match(/^not ok \d+ - P1-/gmu) ?? []).length;
const report = {
  generatedAt: new Date().toISOString(),
  status: code === 0 ? 'passed' : 'failed',
  cases: passed + failed,
  p0: { cases: p0Passed + p0Failed, passed: p0Passed, failed: p0Failed },
  p1: { cases: p1Passed + p1Failed, passed: p1Passed, failed: p1Failed },
  passed,
  failed: code === 0 ? 0 : Math.max(1, failed),
  command: `${process.execPath} ${args.join(' ')}`,
};
await writeFile(resolve(root, 'qa', 'mcp-business-eval-results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
if (code !== 0) process.exitCode = code;
