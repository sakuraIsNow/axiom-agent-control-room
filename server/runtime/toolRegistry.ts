import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Pool } from 'pg';
import { z } from 'zod';
import type {
  ArtifactRef,
  ToolApproval,
  ToolCall,
  ToolParameterSchema,
  ToolRisk,
  WorkflowTask,
  AgentStore,
} from './contracts.js';
import type { ArtifactStore } from './artifactStore.js';
import type { ArtifactCatalog } from './artifactCatalog.js';
import { DockerSandboxExecutor, type SandboxResult } from './toolExecutor.js';

const invocationSchema = z.object({
  name: z.string().min(1).max(80),
  args: z.record(z.string(), z.unknown()).default({}),
});

const toolArgs = {
  query: z.string().min(1).max(500),
  path: z.string().min(1).max(500).default('.'),
  script: z.string().min(1).max(80).default('test'),
  args: z.array(z.string().max(300)).max(12).default([]),
  count: z.number().int().min(1).max(100).default(20),
  content: z.string().max(128_000),
  find: z.string().min(1).max(64_000),
  replace: z.string().max(64_000),
  expectedMatches: z.number().int().min(1).max(32).default(1),
};

export type ToolContext = {
  task: WorkflowTask;
  stepId: string;
  callId: string;
  auditId: string;
};

export type RegisteredTool = {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters: ToolParameterSchema;
  schema: z.ZodType<Record<string, unknown>>;
  timeoutMs: number;
  executionBoundary?: 'sandbox' | 'host-bounded';
  command?: string;
  buildArgs?: (input: Record<string, unknown>) => string[];
  handler?: (input: Record<string, unknown>, context: ToolContext) => Promise<SandboxResult>;
};

export type ToolAuditRecord = {
  auditId: string;
  taskId: string;
  stepId: string;
  callId: string;
  signature: string;
  name: string;
  risk: ToolRisk;
  status: 'requested' | 'approved' | 'completed' | 'failed' | 'rejected';
  exitCode?: number;
  durationMs?: number;
  outputBytes?: number;
  artifactId?: string;
  error?: string;
  createdAt: string;
};

export type ToolExecution = {
  call: ToolCall;
  output: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  auditId: string;
  risk: ToolRisk;
  signature: string;
  artifact?: ArtifactRef;
  artifactError?: string;
};

export class ToolApprovalRequiredError extends Error {
  constructor(readonly approval: ToolApproval) {
    super(`Human approval is required before running ${approval.name}.`);
    this.name = 'ToolApprovalRequiredError';
  }
}

const bounded = (value: unknown, max = 4_000) => String(value ?? '').slice(0, max);
const safeCount = (value: unknown, fallback = 20) => Math.min(100, Math.max(1, Number(value ?? fallback) || fallback));
const safeArgs = (value: unknown, maxItems = 12) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').slice(0, maxItems).map((item) => item.slice(0, 300))
  : [];

const jsonText = (value: unknown, max = 48_000) => {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length > max ? `${serialized.slice(0, max)}\n[truncated]` : serialized;
};

const csvRows = (source: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((item) => item.trim())) rows.push(row);
  }
  return rows;
};

const allowedReadOnlyQuery = (query: string) => {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.includes(';')) return false;
  return /^(select|with|explain|show)\b/i.test(normalized);
};

export const allowedHttpHost = (hostname: string) => {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  const metadataHosts = new Set([
    '169.254.169.254',
    '100.100.100.200',
    'metadata.google.internal',
    'metadata.google',
    'instance-data.ec2.internal',
    'metadata.azure.com',
  ]);
  if (metadataHosts.has(normalized)) return false;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split('.').map(Number);
    const [first = 0, second = 0] = octets;
    if (first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127)) return false;
  }
  if (ipVersion === 6) {
    const compact = normalized.replace(/^\[|\]$/g, '');
    // Loopback, link-local, unique-local, unspecified and IPv4-mapped private ranges.
    if (compact === '::' || compact === '::1' || /^(fc|fd|fe[89ab])/.test(compact) || /^::ffff:(0:)?(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(compact)) return false;
  }
  const entries = (process.env.AXIOM_HTTP_ALLOWLIST ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return entries.some((entry) => normalized === entry || (entry.startsWith('*.') && normalized.endsWith(entry.slice(1))));
};

const schema = (properties: ToolParameterSchema['properties'], required: string[] = []): ToolParameterSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
};

const signatureFor = (taskId: string, stepId: string, name: string, args: Record<string, unknown>) => createHash('sha256')
  .update(JSON.stringify(canonicalize({ taskId, stepId, name, args })))
  .digest('hex')
  .slice(0, 32);

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly workspaceRoot = resolve(process.env.AXIOM_AGENT_WORKSPACE_ROOT?.trim() || process.cwd());
  private readonly usage = new Map<string, { calls: number; windowStartedAt: number }>();
  private readonly auditLog: ToolAuditRecord[] = [];

  constructor(
    private readonly executor = new DockerSandboxExecutor(),
    private readonly artifactStore: ArtifactStore | null = null,
    private readonly agentStore: AgentStore | null = null,
    private readonly artifactCatalog: ArtifactCatalog | null = null,
  ) {
    this.register({
      name: 'agent.propose',
      description: '创建自定义 Agent 定义草稿并交由人工审核；不会自动发布或启用该角色。',
      risk: 'low',
      executionBoundary: 'host-bounded',
      parameters: schema({
        roleId: { type: 'string', maxLength: 64 }, name: { type: 'string', maxLength: 120 }, description: { type: 'string', maxLength: 2_000 },
        systemPromptTemplate: { type: 'string', maxLength: 8_000 }, whenToUseHint: { type: 'string', maxLength: 500 },
        toolAllowlist: { type: 'array', items: { type: 'string' } },
      }, ['roleId', 'name', 'systemPromptTemplate', 'whenToUseHint']),
      schema: z.object({
        roleId: z.string().min(1).max(64), name: z.string().min(1).max(120), description: z.string().max(2_000).default(''),
        systemPromptTemplate: z.string().min(1).max(8_000), whenToUseHint: z.string().min(1).max(500),
        toolAllowlist: z.array(z.string().min(1).max(80)).max(16).default([]),
      }).strict(),
      timeoutMs: 10_000,
      handler: async (input, context) => {
        if (!this.agentStore) throw new Error('Agent proposal storage is unavailable.');
        const agent = await this.agentStore.createAgent({
          tenantId: context.task.tenantId,
          roleId: String(input.roleId),
          name: String(input.name),
          description: String(input.description ?? ''),
          createdBy: context.task.userId,
          visibility: 'private',
          kind: 'worker',
          definition: { systemPromptTemplate: String(input.systemPromptTemplate), whenToUseHint: String(input.whenToUseHint), toolAllowlist: safeArgs(input.toolAllowlist, 16), memoryRecall: false },
        });
        return { stdout: JSON.stringify({ id: agent.id, roleId: agent.roleId, status: agent.status }), stderr: '', exitCode: 0, durationMs: 0, auditId: context.auditId };
      },
    });
    this.register({
      name: 'workspace.search',
      description: '使用 ripgrep 搜索已挂载的任务工作区；只读且与网络隔离。',
      risk: 'low',
      executionBoundary: 'sandbox',
      parameters: schema({ query: { type: 'string', maxLength: 500 }, path: { type: 'string', maxLength: 500 } }, ['query']),
      schema: z.object({ query: toolArgs.query, path: toolArgs.path }).strict(),
      timeoutMs: 15_000,
      command: 'rg',
      buildArgs: (input) => ['-n', '--max-count', '200', bounded(input.query, 500), this.workspaceArg(input.path || '.')],
    });
    this.register({
      name: 'workspace.read',
      description: '从已挂载的任务工作区读取 UTF-8 文本文件。',
      risk: 'low',
      executionBoundary: 'sandbox',
      parameters: schema({ path: { type: 'string', maxLength: 500 } }, ['path']),
      schema: z.object({ path: z.string().min(1).max(500) }).strict(),
      timeoutMs: 10_000,
      command: 'cat',
      buildArgs: (input) => [this.workspaceArg(input.path)],
    });
    this.register({
      name: 'document.read',
      description: '从已挂载的工作区读取大小受限的文本文档，支持 Markdown、JSON、YAML、XML 和纯文本。',
      risk: 'low',
      executionBoundary: 'host-bounded',
      parameters: schema({ path: { type: 'string', maxLength: 500 } }, ['path']),
      schema: z.object({ path: z.string().min(1).max(500) }).strict(),
      timeoutMs: 10_000,
      handler: async (input, context) => {
        const path = String(input.path);
        if (!/\.(md|mdx|txt|json|yaml|yml|xml|html?)$/i.test(path)) throw new Error('Document tool only accepts text document extensions.');
        const content = (await readFile(this.workspacePath(path), 'utf8')).slice(0, 48_000);
        return { stdout: content, stderr: '', exitCode: 0, durationMs: 0, auditId: context.auditId };
      },
    });
    this.register({
      name: 'table.read',
      description: '读取大小受限的 CSV 或 JSON 表格并返回规范化数据行，不修改工作区。',
      risk: 'low',
      executionBoundary: 'host-bounded',
      parameters: schema({ path: { type: 'string', maxLength: 500 }, count: { type: 'number', minimum: 1, maximum: 100 } }, ['path']),
      schema: z.object({ path: z.string().min(1).max(500), count: toolArgs.count }).strict(),
      timeoutMs: 10_000,
      handler: async (input, context) => {
        const path = String(input.path);
        const count = safeCount(input.count, 20);
        const source = await readFile(this.workspacePath(path), 'utf8');
        let rows: unknown[];
        if (/\.json$/i.test(path)) {
          const parsed = JSON.parse(source) as unknown;
          rows = Array.isArray(parsed) ? parsed : [parsed];
        } else if (/\.csv$/i.test(path)) {
          const parsed = csvRows(source);
          const [header = [], ...body] = parsed;
          rows = body.slice(0, count).map((values) => Object.fromEntries(header.map((key, index) => [key.trim() || `column_${index + 1}`, values[index] ?? ''])));
        } else {
          throw new Error('Table tool only accepts .csv or .json files.');
        }
        return { stdout: jsonText(rows.slice(0, count)), stderr: '', exitCode: 0, durationMs: 0, auditId: context.auditId };
      },
    });
    this.register({
      name: 'http.fetch',
      description: '仅使用 GET/HEAD 获取 JSON 或文本 API 响应；目标主机必须位于 AXIOM_HTTP_ALLOWLIST。',
      risk: 'medium',
      executionBoundary: 'host-bounded',
      parameters: schema({ url: { type: 'string', maxLength: 2_000 }, method: { type: 'string', maxLength: 4 } }, ['url']),
      schema: z.object({ url: z.string().url().max(2_000), method: z.enum(['GET', 'HEAD']).default('GET') }).strict(),
      timeoutMs: 20_000,
      handler: async (input, context) => {
        const target = new URL(String(input.url));
        if (!['http:', 'https:'].includes(target.protocol) || !allowedHttpHost(target.hostname)) throw new Error('HTTP host is not allowlisted.');
        const response = await fetch(target, { method: String(input.method), redirect: 'error', signal: AbortSignal.timeout(18_000) });
        const body = String(input.method) === 'HEAD' ? '' : (await response.text()).slice(0, 48_000);
        return { stdout: JSON.stringify({ status: response.status, contentType: response.headers.get('content-type'), body }), stderr: '', exitCode: response.ok ? 0 : response.status, durationMs: 0, auditId: context.auditId };
      },
    });
    this.register({
      name: 'browser.open',
      description: '通过只读浏览器适配器打开白名单中的公开 URL，并返回页面文本。',
      risk: 'medium',
      executionBoundary: 'host-bounded',
      parameters: schema({ url: { type: 'string', maxLength: 2_000 } }, ['url']),
      schema: z.object({ url: z.string().url().max(2_000) }).strict(),
      timeoutMs: 20_000,
      handler: async (input, context) => {
        const target = new URL(String(input.url));
        if (!['http:', 'https:'].includes(target.protocol) || !allowedHttpHost(target.hostname)) throw new Error('Browser host is not allowlisted.');
        const response = await fetch(target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(18_000), headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' } });
        const source = (await response.text()).slice(0, 48_000);
        const text = source.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return { stdout: JSON.stringify({ status: response.status, title: source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '', text }), stderr: '', exitCode: response.ok ? 0 : response.status, durationMs: 0, auditId: context.auditId };
      },
    });
    this.register({
      name: 'database.query',
      description: '通过 AXIOM_READONLY_DATABASE_URL 或 DATABASE_URL 执行一条受限的只读 SQL 查询。',
      risk: 'medium',
      executionBoundary: 'host-bounded',
      parameters: schema({ query: { type: 'string', maxLength: 8_000 }, count: { type: 'number', minimum: 1, maximum: 100 } }, ['query']),
      schema: z.object({ query: z.string().min(1).max(8_000), count: toolArgs.count }).strict(),
      timeoutMs: 20_000,
      handler: async (input, context) => {
        const query = String(input.query).trim();
        if (!allowedReadOnlyQuery(query)) throw new Error('Database tool only accepts one SELECT/WITH/EXPLAIN/SHOW statement.');
        const connectionString = process.env.AXIOM_READONLY_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
        if (!connectionString) throw new Error('Read-only database connection is not configured.');
        const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 8_000 });
        const client = await pool.connect();
        try {
          await client.query('BEGIN READ ONLY');
          await client.query('SET LOCAL statement_timeout = 15000');
          const result = await client.query(query);
          await client.query('ROLLBACK');
          const rows = result.rows.slice(0, safeCount(input.count, 20));
          return { stdout: jsonText({ rowCount: result.rowCount ?? rows.length, rows }), stderr: '', exitCode: 0, durationMs: 0, auditId: context.auditId };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
          await pool.end();
        }
      },
    });
    this.register({
      name: 'workspace.git-status',
      description: '检查仓库状态，不修改文件。',
      risk: 'low',
      executionBoundary: 'sandbox',
      parameters: schema({}),
      schema: z.object({}).strict(),
      timeoutMs: 15_000,
      command: 'git',
      buildArgs: () => ['status', '--short'],
    });
    this.register({
      name: 'workspace.git-diff',
      description: '读取当前 Git 差异，不修改文件。',
      risk: 'low',
      executionBoundary: 'sandbox',
      parameters: schema({ path: { type: 'string', maxLength: 500 } }),
      schema: z.object({ path: z.string().max(500).optional().default('') }).strict(),
      timeoutMs: 20_000,
      command: 'git',
      buildArgs: (input) => ['diff', '--no-ext-diff', '--no-color', '--', ...(String(input.path ?? '').trim() ? [this.workspaceArg(input.path)] : [])],
    });
    this.register({
      name: 'workspace.git-branch',
      description: '读取当前 Git 分支和本地分支列表。',
      risk: 'low',
      executionBoundary: 'sandbox',
      parameters: schema({}),
      schema: z.object({}).strict(),
      timeoutMs: 15_000,
      command: 'git',
      buildArgs: () => ['branch', '--no-color', '-vv'],
    });
    this.register({
      name: 'workspace.git-commits',
      description: '读取近期本地 Git 提交，不修改仓库。',
      risk: 'low',
      executionBoundary: 'sandbox',
      parameters: schema({ count: { type: 'number', minimum: 1, maximum: 100 } }),
      schema: z.object({ count: toolArgs.count }).strict(),
      timeoutMs: 15_000,
      command: 'git',
      buildArgs: (input) => ['log', `-${safeCount(input.count)}`, '--oneline', '--decorate', '--no-color'],
    });
    this.register({
      name: 'workspace.test',
      description: '在已挂载的工作区运行白名单中的 npm 脚本。',
      risk: 'medium',
      executionBoundary: 'sandbox',
      parameters: schema({ script: { type: 'string', maxLength: 80 }, args: { type: 'array', items: { type: 'string' } } }),
      schema: z.object({ script: toolArgs.script, args: toolArgs.args }).strict(),
      timeoutMs: 120_000,
      command: 'npm',
      buildArgs: (input) => ['run', this.allowedScript(input.script || 'test'), ...safeArgs(input.args)],
    });
    this.register({
      name: 'workspace.write',
      description: '获得明确人工批准后写入 UTF-8 文件。',
      risk: 'high',
      executionBoundary: 'host-bounded',
      parameters: schema({ path: { type: 'string', maxLength: 500 }, content: { type: 'string', maxLength: 128_000 } }, ['path', 'content']),
      schema: z.object({ path: z.string().min(1).max(500), content: toolArgs.content }).strict(),
      timeoutMs: 15_000,
      handler: async (input, context) => {
        const target = this.workspacePath(input.path);
        const content = String(input.content ?? '');
        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.${context.callId}.tmp`;
        await writeFile(temporary, content, 'utf8');
        await rename(temporary, target);
        return { stdout: `Wrote ${relative(this.workspaceRoot, target)} (${Buffer.byteLength(content, 'utf8')} bytes).`, stderr: '', exitCode: 0, durationMs: 0, auditId: context.auditId };
      },
    });
    this.register({
      name: 'workspace.patch',
      description: '获得明确人工批准后，精确替换 UTF-8 文件中的文本片段。',
      risk: 'high',
      executionBoundary: 'host-bounded',
      parameters: schema({ path: { type: 'string', maxLength: 500 }, find: { type: 'string', maxLength: 64_000 }, replace: { type: 'string', maxLength: 64_000 }, expectedMatches: { type: 'number', minimum: 1, maximum: 32 } }, ['path', 'find', 'replace']),
      schema: z.object({ path: z.string().min(1).max(500), find: toolArgs.find, replace: toolArgs.replace, expectedMatches: toolArgs.expectedMatches }).strict(),
      timeoutMs: 15_000,
      handler: async (input, context) => {
        const target = this.workspacePath(input.path);
        const source = await readFile(target, 'utf8');
        const find = String(input.find ?? '');
        const replacement = String(input.replace ?? '');
        const expected = Number(input.expectedMatches ?? 1);
        const matches = source.split(find).length - 1;
        if (matches !== expected) throw new Error(`Patch expected ${expected} match(es), found ${matches}.`);
        const updated = source.split(find).join(replacement);
        const temporary = `${target}.${context.callId}.tmp`;
        await writeFile(temporary, updated, 'utf8');
        await rename(temporary, target);
        return { stdout: `Patched ${relative(this.workspaceRoot, target)} (${matches} match(es)).`, stderr: '', exitCode: 0, durationMs: 0, auditId: context.auditId };
      },
    });
  }

  register(tool: RegisteredTool) {
    if (this.tools.has(tool.name)) throw new Error(`Tool is already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  upsert(tool: RegisteredTool) {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string) {
    return this.tools.delete(name);
  }

  unregisterPrefix(prefix: string) {
    let removed = 0;
    for (const name of this.tools.keys()) {
      if (!name.startsWith(prefix)) continue;
      this.tools.delete(name);
      removed += 1;
    }
    return removed;
  }

  catalog() {
    return [...this.tools.values()].map(({ name, description, risk, parameters, timeoutMs, executionBoundary = 'sandbox' }) => ({ name, description, risk, parameters, timeoutMs, executionBoundary, approvalRequired: risk === 'high' || risk === 'critical' }));
  }

  audits(taskId?: string) {
    return this.auditLog.filter((audit) => !taskId || audit.taskId === taskId).map((audit) => ({ ...audit }));
  }

  enabled() {
    return process.env.AXIOM_TOOL_EXECUTOR === 'docker';
  }

  private allowedScript(value: unknown) {
    const candidate = bounded(value || 'test', 80).trim();
    const allowed = new Set((process.env.AXIOM_TOOL_ALLOWED_NPM_SCRIPTS ?? 'test,check,build,qa:routing,qa:business,qa:runtime').split(',').map((item) => item.trim()).filter(Boolean));
    if (!allowed.has(candidate)) throw new Error(`Npm script is not allowlisted: ${candidate}`);
    return candidate;
  }

  private workspacePath(value: unknown) {
    const candidate = String(value ?? '').trim();
    if (!candidate || candidate.includes('\0') || isAbsolute(candidate)) throw new Error('Workspace paths must be relative and bounded.');
    const target = resolve(this.workspaceRoot, candidate);
    const escaped = relative(this.workspaceRoot, target);
    if (escaped.startsWith('..') || isAbsolute(escaped)) throw new Error('Workspace path escapes the configured root.');
    return target;
  }

  private workspaceArg(value: unknown) {
    const candidate = String(value ?? '').trim() || '.';
    this.workspacePath(candidate);
    return candidate.replaceAll('\\', '/');
  }

  private record(audit: ToolAuditRecord) {
    this.auditLog.push(audit);
    if (this.auditLog.length > 2_000) this.auditLog.splice(0, this.auditLog.length - 2_000);
  }

  private checkQuota(taskId: string) {
    const now = Date.now();
    const maxCalls = Math.max(1, Number(process.env.AXIOM_TOOL_MAX_CALLS_PER_TASK ?? 8));
    const current = this.usage.get(taskId);
    const usage = !current || now - current.windowStartedAt > 60 * 60 * 1_000 ? { calls: 0, windowStartedAt: now } : current;
    if (usage.calls >= maxCalls) throw new Error(`Tool quota exceeded for task: ${maxCalls} calls per hour.`);
    usage.calls += 1;
    this.usage.set(taskId, usage);
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    const boundedTimeout = Math.min(120_000, Math.max(1_000, timeoutMs));
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`Tool timed out after ${boundedTimeout}ms.`)), boundedTimeout);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      );
    });
  }

  async execute(task: WorkflowTask, stepId: string, invocation: unknown): Promise<ToolExecution> {
    const input = invocationSchema.parse(invocation);
    const tool = this.tools.get(input.name);
    if (!tool) throw new Error(`Unknown tool: ${input.name}`);
    if (process.env.AXIOM_TOOL_EXECUTOR !== 'docker') throw new Error('Tool execution is disabled until the Docker sandbox is enabled.');
    const parsedArgs = tool.schema.parse(input.args);
    const callId = randomUUID();
    const auditId = randomUUID();
    const signature = signatureFor(task.id, stepId, input.name, parsedArgs);
    const existingApproval = task.toolApprovals?.find((approval) => approval.signature === signature);
    if ((tool.risk === 'high' || tool.risk === 'critical') && existingApproval?.status !== 'approved') {
      const approval: ToolApproval = existingApproval ?? {
        id: randomUUID(),
        signature,
        stepId,
        name: input.name,
        args: parsedArgs,
        risk: tool.risk,
        status: 'pending',
        requestedAt: new Date().toISOString(),
      };
      this.record({ auditId, taskId: task.id, stepId, callId, signature, name: input.name, risk: tool.risk, status: existingApproval?.status === 'rejected' ? 'rejected' : 'requested', createdAt: new Date().toISOString() });
      if (existingApproval?.status === 'rejected') throw new Error(`Tool approval was rejected: ${input.name}.`);
      throw new ToolApprovalRequiredError(approval);
    }
    this.checkQuota(task.id);
    const startedAt = Date.now();
    const context = { task, stepId, callId, auditId };
    const commandArgs = tool.handler ? undefined : tool.buildArgs!(parsedArgs);
    let result: SandboxResult;
    try {
      if (tool.handler) {
        result = await this.withTimeout(tool.handler(parsedArgs, context), tool.timeoutMs);
      } else {
        result = await this.executor.execute({
          workspaceRoot: this.workspaceRoot,
          command: tool.command!,
          args: commandArgs,
          timeoutMs: Math.min(tool.timeoutMs, Math.max(1_000, Number(process.env.AXIOM_TOOL_TIMEOUT_MS ?? tool.timeoutMs))),
        });
      }
    } catch (error) {
      result = { stdout: '', stderr: error instanceof Error ? error.message : 'Tool execution failed.', exitCode: 1, durationMs: Date.now() - startedAt, auditId };
    }
    const output = result.stdout.slice(0, 48_000);
    const stderr = result.stderr.slice(0, 12_000);
    let artifact: ArtifactRef | undefined;
    let artifactError: string | undefined;
    if (this.artifactStore) {
      const id = `tool:${task.id}:${stepId}:${callId}`;
      const content = [
        `# ${input.name}`,
        '',
        `Risk: ${tool.risk}`,
        `Signature: ${signature}`,
        `Exit code: ${result.exitCode}`,
        `Audit ID: ${result.auditId}`,
        '',
        '## Standard output',
        '```text',
        output,
        '```',
        '',
        '## Standard error',
        '```text',
        stderr,
        '```',
      ].join('\n');
      try {
        const stored = await this.artifactStore.put(id, content, task.tenantId);
        artifact = {
          id,
          kind: 'tool-output',
          name: `${input.name} output`,
          key: stored.key,
          bytes: stored.bytes,
          mimeType: 'text/markdown',
          sourceStepId: stepId,
          sourceToolCallId: callId,
          lineage: { taskId: task.id, stepId, toolCallId: callId },
          createdAt: new Date().toISOString(),
        };
      } catch (error) {
        // The tool may already have produced an external side effect. Preserve
        // its result so a storage outage cannot cause an unsafe re-execution.
        artifactError = (error instanceof Error ? error.message : 'Artifact storage failed.').slice(0, 1_000);
      }
      if (artifact && this.artifactCatalog) {
        try {
          await this.artifactCatalog.register({
            id: artifact.id,
            tenantId: task.tenantId,
            taskId: task.id,
            source: 'tool',
            storageKey: artifact.key,
            bytes: artifact.bytes,
            mimeType: artifact.mimeType,
            referenceKey: `${stepId}:${callId}`,
          });
        } catch (error) {
          // Preserve the tool result and object reference even if the catalog
          // database is temporarily unavailable; the cleanup queue can repair it.
          artifactError = (error instanceof Error ? error.message : 'Artifact catalog unavailable.').slice(0, 1_000);
        }
      }
    }
    this.record({
      auditId: result.auditId,
      taskId: task.id,
      stepId,
      callId,
      signature,
      name: input.name,
      risk: tool.risk,
      status: result.exitCode === 0 ? 'completed' : 'failed',
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputBytes: Buffer.byteLength(output + stderr, 'utf8'),
      ...(artifact ? { artifactId: artifact.id } : {}),
      ...(result.exitCode === 0 ? {} : { error: stderr.slice(0, 1_000) }),
      ...(artifactError ? { error: `Artifact storage failed: ${artifactError}` } : {}),
      createdAt: new Date().toISOString(),
    });
    return { call: { id: callId, name: input.name, args: parsedArgs }, output, stderr, exitCode: result.exitCode, durationMs: result.durationMs, auditId: result.auditId, risk: tool.risk, signature, artifact, artifactError };
  }
}
