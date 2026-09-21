import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGateAttempts, gateExitCode, summarizeGateResults } from '../qa/gate-report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const systemEnvironment = new Set([
  'PATH', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'USER', 'LOGNAME', 'SHELL', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]);

export function offlineEnvironment(input = process.env) {
  // Provider credentials, proxy URLs, NODE_OPTIONS and database configuration
  // are deliberately not inherited from a developer machine or CI secrets.
  const env = Object.fromEntries(Object.entries(input).filter(([key]) => systemEnvironment.has(key.toUpperCase())));
  return { ...env, CI: 'true', NO_COLOR: '1', npm_config_audit: 'false', npm_config_fund: 'false' };
}

export function allowedSourcePath(file) {
  const normalized = file.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (isAbsolute(file) || parts.some((part) => !part || part === '..' || part.startsWith('.') || /^(?:node_modules|dist|server-dist|frontend-backup|release|logs)$/i.test(part))) return false;
  if (['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json'].includes(normalized)) return true;
  if (['src', 'server'].includes(parts[0])) return /\.(?:ts|tsx|js|mjs|cjs|css|json|sql|woff2?|ttf|svg|png|jpe?g|webp|txt)$/.test(normalized);
  if (['scripts', 'qa'].includes(parts[0])) return /\.(?:ts|tsx|js|mjs|cjs)$/.test(normalized) || (parts[1] === 'fixtures' && /\.(?:json|md|txt|svg|html)$/.test(normalized));
  return parts[0] === 'public' && /\.(?:html|svg|png|jpe?g|webp|woff2?|ttf|ico|glb|gltf)$/.test(normalized);
}

export async function copySourceFiles(sourceRoot, destinationRoot, files) {
  let copied = 0;
  for (const file of [...new Set(files)].sort()) {
    if (!allowedSourcePath(file)) continue;
    const source = resolve(sourceRoot, file);
    const destination = resolve(destinationRoot, file);
    if (!source.startsWith(`${resolve(sourceRoot)}${sep}`) || !destination.startsWith(`${resolve(destinationRoot)}${sep}`)) throw new Error('Source copy escaped its workspace.');
    let stat;
    try { stat = await lstat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Non-regular source file is not allowed: ${file}`);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    copied += 1;
  }
  return copied;
}

export async function removeScratch(scratch) {
  const resolved = resolve(scratch);
  if (dirname(resolved) !== resolve(tmpdir()) || !basename(resolved).startsWith('axiom-ci-gate-')) throw new Error('Refusing to remove an unexpected CI workspace.');
  // Remove the dependency junction itself before recursive cleanup, never its target.
  try { await unlink(join(resolved, 'node_modules')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

export async function discoverTests(workspace) {
  const paths = [];
  for (const directory of ['server/runtime', 'src/lib']) {
    for (const entry of await readdir(join(workspace, directory), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.test.ts')) paths.push(`${directory}/${entry.name}`);
    }
  }
  if (!paths.length) throw new Error('No unit tests found.');
  return paths.sort();
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((done) => {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('close', done); killer.once('error', done);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export function runStage(stage, workspace, env, outputDirectory, signal) {
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    const output = createWriteStream(join(outputDirectory, `${stage.id}.log`));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const command = stage.npm ? npm : process.execPath;
    const args = stage.npm ? ['run', stage.npm] : stage.args;
    const child = spawn(command, args, {
      cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      shell: stage.npm && process.platform === 'win32', detached: process.platform !== 'win32',
    });
    let timedOut = false;
    let errorMessage;
    const timer = setTimeout(() => { timedOut = true; void stopProcess(child); }, stage.timeoutMs ?? 600_000);
    const abort = () => { void stopProcess(child); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, consoleStream] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on('data', (chunk) => { output.write(chunk); consoleStream.write(chunk); });
    }
    child.once('error', (error) => { errorMessage = error.message; });
    child.once('close', (code, childSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const result = classifyGateAttempts([{
        attempt: 1, name: stage.name, script: stage.npm ?? `${basename(process.execPath)} ${args.join(' ')}`,
        status: code === 0 && !timedOut && !signal?.aborted && !errorMessage ? 'passed' : 'failed',
        code: code ?? 1, signal: childSignal, durationMs: Date.now() - startedAt,
        timedOut, ...(errorMessage ? { error: errorMessage } : {}),
      }]);
      output.end(() => resolveResult({ ...result, log: `${stage.id}.log` }));
    });
  });
}

async function collectEvidence(workspace, outputDirectory) {
  for (const directory of ['qa']) {
    for (const entry of await readdir(join(workspace, directory), { withFileTypes: true })) {
      if (!entry.isFile() || !/^(?:business-delivery|execution-quality|mcp-business|routing-repair-http|routing-resilience|improvements|chat-preview-stability).*\.(?:json|png)$/.test(entry.name)) continue;
      await copyFile(join(workspace, directory, entry.name), join(outputDirectory, entry.name));
    }
  }
}

export async function main() {
  const env = offlineEnvironment();
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, env, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  if (git.error || git.status !== 0) throw new Error(`Git source inventory failed: ${git.error?.message ?? git.stderr}`);
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const outputDirectory = join(root, 'qa', 'ci-quality', runId);
  await mkdir(outputDirectory, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'axiom-ci-gate-'));
  const results = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let sourceFiles = 0;
  let cleanupError;
  try {
    sourceFiles = await copySourceFiles(root, scratch, git.stdout.split('\0').filter(Boolean));
    await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(join(scratch, '.data'), { recursive: true });
    const tests = await discoverTests(scratch);
    const stages = [
      { id: 'gate-contract', name: 'Gate isolation and result contracts', args: ['--test', 'qa/gate-report.test.mjs', 'scripts/ci-quality-gate.test.mjs'] },
      { id: 'check', name: 'TypeScript check', npm: 'check' },
      { id: 'test', name: 'All deterministic unit and integration tests', args: ['--import', 'tsx', '--test', '--test-concurrency=4', ...tests] },
      { id: 'build', name: 'Production build', npm: 'build' },
      { id: 'routing-resilience', name: 'Routing resilience fixtures', args: ['--import', 'tsx', 'qa/routing-resilience-eval.mjs'] },
      { id: 'routing-http', name: 'Routing HTTP and SSE contracts', args: ['qa/routing-repair-http-smoke.mjs'] },
      { id: 'execution-quality', name: 'Execution quality and correction bounds', args: ['--import', 'tsx', 'qa/execution-quality-eval.mjs'] },
      { id: 'mcp-business', name: 'Fake MCP business acceptance', args: ['qa/mcp-business-eval.mjs'] },
      { id: 'business-delivery', name: 'Business delivery acceptance', args: ['--import', 'tsx', 'qa/business-delivery-eval.mjs'] },
      { id: 'business-oracles', name: 'Live business evaluation oracle and isolation contracts', args: ['--test', 'qa/business-live-oracles.test.mjs', 'qa/business-live-isolation.test.mjs', 'qa/final-delivery-oracles.test.mjs', 'qa/search-smoke-diagnostics.test.mjs', 'qa/jev-routing-oracles.test.mjs'] },
      { id: 'improvements-ui', name: 'Mocked RSI browser workflows', args: ['qa/improvements-smoke.mjs'], timeoutMs: 180_000 },
      { id: 'preview-ui', name: 'Mocked conversation and preview stability', args: ['qa/chat-preview-stability-smoke.mjs'], timeoutMs: 180_000 },
    ];
    for (const stage of stages) {
      if (controller.signal.aborted) break;
      console.log(`\n[offline CI] ${stage.name}`);
      results.push(await runStage(stage, scratch, env, outputDirectory, controller.signal));
    }
    await collectEvidence(scratch, outputDirectory);
  } catch (error) {
    results.push(classifyGateAttempts([{ attempt: 1, name: 'Offline gate setup/evidence', script: 'ci-quality-gate', status: 'failed', code: 1, durationMs: 0, error: error.message }]));
  } finally {
    try { await removeScratch(scratch); } catch (error) { cleanupError = error.message; }
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
  if (cleanupError || controller.signal.aborted) results.push(classifyGateAttempts([{ attempt: 1, name: 'Offline gate cleanup/interruption', script: 'ci-quality-gate', status: 'failed', code: 1, durationMs: 0, error: cleanupError ?? 'Interrupted' }]));
  const summary = {
    generatedAt: new Date().toISOString(), runId,
    scope: 'Deterministic runtime and mocked browser acceptance; not a live-model, PostgreSQL or production-capacity certification.',
    isolation: { temporarySourceCopy: true, copiedSourceFiles: sourceFiles, environmentFilesCopied: false, credentialsInherited: false, productionDatabaseUsed: false, dependencies: 'existing node_modules link', scratchRemoved: !cleanupError },
    ...summarizeGateResults(results),
  };
  await writeFile(join(outputDirectory, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'qa', 'ci-quality-gate-results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = gateExitCode(summary);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
