import { spawn } from 'node:child_process';
import { createServer } from 'vite';

// The isolated component fixture imports source modules, not the running app.
// Own an ephemeral server so this check works in both local and release gates.
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Frontend QA server did not bind a TCP port.');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['qa/frontend-stability-smoke.mjs'], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, QA_URL: `http://127.0.0.1:${address.port}` },
    });
    child.once('error', reject);
    child.once('exit', (status) => resolve(status ?? 1));
  });
  process.exitCode = code;
} finally {
  await server.close();
}
