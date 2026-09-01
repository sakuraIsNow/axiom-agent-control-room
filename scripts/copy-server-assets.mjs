import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve(process.cwd(), 'server', 'assets');
const target = resolve(process.cwd(), 'server-dist', 'assets');
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });
