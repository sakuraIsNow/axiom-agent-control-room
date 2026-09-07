import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'vite';

// The isolated component fixture imports source modules, not the running app.
// Own an ephemeral server so this check works in both local and release gates.
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
try {
  if (!server.httpServer) throw new Error('Frontend QA requires an HTTP server.');
  // Vite 6 treats port 0 as its default port. Bind through the HTTP server
  // so Windows/Docker port reservations cannot capture the QA listener.
  const listening = once(server.httpServer, 'listening');
  server.httpServer.listen(0, '127.0.0.1');
  await listening;
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Frontend QA server did not bind a TCP port.');
  for (const script of ['qa/frontend-stability-smoke.mjs', 'qa/tool-recovery-smoke.mjs', 'qa/task-actions-smoke.mjs']) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        stdio: 'inherit', windowsHide: true,
        env: { ...process.env, QA_URL: `http://127.0.0.1:${address.port}` },
      });
      child.once('error', reject);
      child.once('exit', (status) => resolve(status ?? 1));
    });
    if (code !== 0) process.exitCode = code;
  }
} finally {
  await server.close();
}
