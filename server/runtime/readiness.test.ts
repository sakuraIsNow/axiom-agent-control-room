import assert from 'node:assert/strict';
import test from 'node:test';
import { clearReadinessCache, getRuntimeReadiness } from './readiness.js';

const trackedKeys = [
  'DATABASE_URL',
  'AXIOM_API_KEY',
  'AXIOM_TRUST_PROXY_AUTH',
  'AXIOM_PRINCIPAL_SECRET',
  'DEEPSEEK_API_KEY',
  'DMX_API_KEY',
  'VIDEO_API_BASE',
  'VIDEO_MODEL',
  'TDAI_MEMORY_ENDPOINT',
  'DEEPSEEK_HARNESS_URL',
  'DEEPSEEK_HARNESS_COMMAND',
  'DEEPSEEK_HARNESS_COMMAND_JSON',
  'DEEPSEEK_HARNESS_ACTIVE',
  'DEEPSEEK_HARNESS_CWD',
  'AXIOM_TOOL_EXECUTOR',
  'AXIOM_OBJECT_STORAGE_ENDPOINT',
  'AXIOM_OBJECT_STORAGE_BUCKET',
  'AXIOM_OBJECT_STORAGE_PATH',
  'AXIOM_OBJECT_STORAGE_REGION',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'PROMETHEUS_ENABLED',
  'AXIOM_SCHEDULER_QUEUE_URL',
  'AXIOM_WEBHOOK_SECRET',
  'AXIOM_READINESS_CACHE_TTL_MS',
];

test('readiness identifies production blockers and a fully configured candidate', async () => {
  const previous = new Map(trackedKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of trackedKeys) delete process.env[key];
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const local = await getRuntimeReadiness();
    assert.equal(local.state, 'blocked');
    assert.ok(local.blockers.includes('沙箱工具执行器'));

    process.env.DATABASE_URL = 'postgres://localhost/axiom';
    process.env.AXIOM_API_KEY = 'gateway-key';
    process.env.AXIOM_PRINCIPAL_SECRET = 'principal-secret';
    process.env.DMX_API_KEY = 'image-key';
    process.env.VIDEO_API_BASE = 'http://video:9000';
    process.env.VIDEO_MODEL = 'local-video-model';
    process.env.TDAI_MEMORY_ENDPOINT = 'http://memory:8420';
    process.env.AXIOM_TOOL_EXECUTOR = 'docker';
    process.env.AXIOM_OBJECT_STORAGE_ENDPOINT = 's3://axiom-artifacts';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    process.env.AXIOM_SCHEDULER_QUEUE_URL = 'redis://localhost:6379';
    process.env.AXIOM_WEBHOOK_SECRET = 'webhook-secret';
    const candidate = await getRuntimeReadiness();
    assert.equal(candidate.state, 'ready');
    assert.equal(candidate.blockers.length, 0);
    assert.equal(candidate.deployment, 'production-candidate');
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('readiness uses real model, memory, and sandbox probes when dependencies are provided', async () => {
  const previous = new Map(trackedKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.DEEPSEEK_API_KEY = 'configured-but-invalid';
    process.env.TDAI_MEMORY_ENDPOINT = 'http://memory.invalid';
    process.env.AXIOM_TOOL_EXECUTOR = 'docker';
    const result = await getRuntimeReadiness({
      model: { health: async () => ({ configured: true, reachable: false, detail: 'HTTP 401 from model provider.' }) },
      memory: { health: async () => ({ configured: true, reachable: false, detail: 'MemoryCore is offline.' }) },
      sandbox: { probe: async () => ({ configured: true, available: false, detail: 'Sandbox image is missing.' }) },
    });
    assert.equal(result.state, 'blocked');
    assert.equal(result.checks.find((check) => check.id === 'model-provider')?.state, 'blocked');
    assert.equal(result.checks.find((check) => check.id === 'memory')?.state, 'degraded');
    assert.equal(result.checks.find((check) => check.id === 'tool-executor')?.state, 'blocked');
    assert.match(result.checks.find((check) => check.id === 'model-provider')?.detail ?? '', /401/);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('readiness coalesces concurrent probes and serves a short-lived real snapshot', async () => {
  const previous = new Map(trackedKeys.map((key) => [key, process.env[key]]));
  clearReadinessCache();
  let modelCalls = 0;
  let memoryCalls = 0;
  let sandboxCalls = 0;
  try {
    process.env.DEEPSEEK_API_KEY = 'configured';
    process.env.TDAI_MEMORY_ENDPOINT = 'http://memory.test';
    process.env.AXIOM_TOOL_EXECUTOR = 'docker';
    process.env.AXIOM_READINESS_CACHE_TTL_MS = '1000';
    const dependencies = {
      model: { health: async () => { modelCalls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { configured: true, reachable: true, detail: 'model ok' }; } },
      memory: { health: async () => { memoryCalls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { configured: true, reachable: true, detail: 'memory ok' }; } },
      sandbox: { probe: async () => { sandboxCalls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { configured: true, available: true, detail: 'sandbox ok' }; } },
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => getRuntimeReadiness(dependencies)));
    assert.equal(new Set(results.map((result) => result.checkedAt)).size, 1);
    assert.equal(modelCalls, 1);
    assert.equal(memoryCalls, 1);
    assert.equal(sandboxCalls, 1);
    const cached = await getRuntimeReadiness(dependencies);
    assert.equal(cached.checkedAt, results[0]?.checkedAt);
    assert.equal(modelCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await getRuntimeReadiness(dependencies);
    assert.equal(modelCalls, 2);
  } finally {
    clearReadinessCache();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('readiness does not invoke disabled dependency probes', async () => {
  const previous = new Map(trackedKeys.map((key) => [key, process.env[key]]));
  clearReadinessCache();
  let calls = 0;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.TDAI_MEMORY_ENDPOINT;
    delete process.env.AXIOM_TOOL_EXECUTOR;
    process.env.AXIOM_READINESS_CACHE_TTL_MS = '0';
    const result = await getRuntimeReadiness({
      model: { health: async () => { calls += 1; return { configured: true, reachable: true, detail: 'unexpected' }; } },
      memory: { health: async () => { calls += 1; return { configured: true, reachable: true, detail: 'unexpected' }; } },
      sandbox: { probe: async () => { calls += 1; return { configured: true, available: true, detail: 'unexpected' }; } },
    });
    assert.equal(calls, 0);
    assert.equal(result.checks.find((check) => check.id === 'model-provider')?.state, 'blocked');
  } finally {
    clearReadinessCache();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('readiness reports an external Artifact outage without claiming ready', async () => {
  const previous = new Map(trackedKeys.map((key) => [key, process.env[key]]));
  clearReadinessCache();
  try {
    process.env.DEEPSEEK_API_KEY = 'configured';
    process.env.AXIOM_OBJECT_STORAGE_ENDPOINT = 'http://minio:9000/axiom-bucket';
    process.env.AXIOM_READINESS_CACHE_TTL_MS = '0';
    const result = await getRuntimeReadiness({
      objectStore: { health: async () => ({ configured: true, reachable: false, detail: 'S3 bucket is offline.' }) },
    });
    const check = result.checks.find((item) => item.id === 'object-storage');
    assert.equal(check?.state, 'degraded');
    assert.equal(check?.detail, 'S3 bucket is offline.');
    assert.ok(result.warnings.includes('Artifact 对象存储'));
  } finally {
    clearReadinessCache();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('readiness uses the Harness capability handshake instead of configuration presence', async () => {
  const previous = new Map(trackedKeys.map((key) => [key, process.env[key]]));
  clearReadinessCache();
  try {
    process.env.DEEPSEEK_API_KEY = 'configured';
    process.env.DEEPSEEK_HARNESS_COMMAND = 'node fake-acp';
    process.env.DEEPSEEK_HARNESS_ACTIVE = 'true';
    const result = await getRuntimeReadiness({
      harness: { handshake: async () => ({ configured: true, compatible: false, active: false, reason: 'ACP protocol mismatch.' }) },
    });
    const check = result.checks.find((item) => item.id === 'harness');
    assert.equal(check?.state, 'degraded');
    assert.equal(check?.detail, 'ACP protocol mismatch.');
  } finally {
    clearReadinessCache();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
