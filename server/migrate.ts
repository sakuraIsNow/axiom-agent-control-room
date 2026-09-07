import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { createTaskStore } from './runtime/taskStore.js';
import { createTemplateStore } from './runtime/templateStore.js';
import { createPluginStore } from './runtime/pluginStore.js';
import { createToolExecutionStore } from './runtime/toolExecutionStore.js';
import { createProviderBindingStore } from './runtime/providerBindings.js';

dotenv.config({ path: resolve(process.cwd(), '.env.local'), quiet: true });
dotenv.config({ quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for database migrations.');
}

const store = createTaskStore();
await store.initialize();
const templates = createTemplateStore();
await templates.initialize();
await templates.close();
const plugins = createPluginStore();
await plugins.initialize();
await plugins.close();
const toolExecutions = createToolExecutionStore();
await toolExecutions.initialize();
await toolExecutions.close();
const providerBindings = createProviderBindingStore();
await providerBindings.initialize();
await providerBindings.close();
await store.close();
process.stdout.write('Axiom database migrations are up to date.\n');
