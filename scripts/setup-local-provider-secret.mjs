import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const path = resolve(process.cwd(), '.env.local');
const content = await readFile(path, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const existing = parse(content);
if (existing.AXIOM_PROVIDER_SECRET?.trim()) {
  console.log('An existing provider secret was preserved. No configuration changed.');
} else if (process.env.AXIOM_PROVIDER_SECRET?.trim()) {
  console.log('A provider secret is supplied by the environment. Preserve it in your deployment secret manager.');
} else {
  const key = randomBytes(32).toString('hex');
  const line = `AXIOM_PROVIDER_SECRET=${key}`;
  const next = /^\s*AXIOM_PROVIDER_SECRET\s*=/m.test(content)
    ? content.replace(/^\s*AXIOM_PROVIDER_SECRET\s*=.*$/m, line)
    : `${content}${content.endsWith('\n') || !content ? '' : '\n'}\n# Preserve this key across restarts and workers. Do not commit it.\n${line}\n`;
  await writeFile(path, next, { encoding: 'utf8', mode: 0o600 });
  console.log('Created a stable provider secret in .env.local. Back up this file securely; no key was printed.');
}
