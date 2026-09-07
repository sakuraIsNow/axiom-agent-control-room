export type ReadinessState = 'ready' | 'degraded' | 'blocked';

export type ReadinessCheck = {
  id: string;
  label: string;
  state: ReadinessState;
  detail: string;
  required: boolean;
};

export type RuntimeReadiness = {
  state: ReadinessState;
  deployment: 'local-single-node' | 'production-candidate';
  checkedAt: string;
  checks: ReadinessCheck[];
  blockers: string[];
  warnings: string[];
};

export type ReadinessDependencies = {
  memory?: { health(signal?: AbortSignal): Promise<{ configured: boolean; reachable: boolean; detail: string }> };
  model?: { health(signal?: AbortSignal): Promise<{ configured: boolean; reachable: boolean; detail: string }> };
  sandbox?: { probe(): Promise<{ configured: boolean; available: boolean; detail: string }> };
  objectStore?: { health(signal?: AbortSignal): Promise<{ configured: boolean; reachable: boolean; detail: string }> };
  harness?: { handshake(signal?: AbortSignal): Promise<{ configured: boolean; compatible: boolean; active: boolean; reason: string }> };
};

const configured = (value: string | undefined) => Boolean(value?.trim());

const computeRuntimeReadiness = async (dependencies: ReadinessDependencies = {}): Promise<RuntimeReadiness> => {
  const memoryConfigured = configured(process.env.TDAI_MEMORY_ENDPOINT);
  const modelConfigured = configured(process.env.DEEPSEEK_API_KEY);
  const sandboxConfigured = process.env.AXIOM_TOOL_EXECUTOR === 'docker';
  const objectStorageConfigured = configured(process.env.AXIOM_OBJECT_STORAGE_ENDPOINT) || configured(process.env.AXIOM_OBJECT_STORAGE_PATH);
  const harnessConfigured = configured(process.env.DEEPSEEK_HARNESS_URL)
    || configured(process.env.DEEPSEEK_HARNESS_COMMAND)
    || configured(process.env.DEEPSEEK_HARNESS_COMMAND_JSON);
  const probeSignal = AbortSignal.timeout(3_000);
  const [memoryProbe, modelProbe, sandboxProbe, objectStoreProbe, harnessProbe] = await Promise.all([
    memoryConfigured && dependencies.memory
      ? dependencies.memory.health(probeSignal).catch(() => ({ configured: true, reachable: false, detail: 'MemoryCore health probe failed.' }))
      : Promise.resolve(undefined),
    modelConfigured && dependencies.model
      ? dependencies.model.health(probeSignal).catch(() => ({ configured: true, reachable: false, detail: 'Model provider health probe failed.' }))
      : Promise.resolve(undefined),
    sandboxConfigured && dependencies.sandbox
      ? dependencies.sandbox.probe().catch(() => ({ configured: true, available: false, detail: 'Docker sandbox probe failed.' }))
      : Promise.resolve(undefined),
    objectStorageConfigured && dependencies.objectStore
      ? dependencies.objectStore.health(probeSignal).catch(() => ({ configured: true, reachable: false, detail: 'Artifact 存储健康探测失败。' }))
      : Promise.resolve(undefined),
    harnessConfigured && dependencies.harness
      ? dependencies.harness.handshake(probeSignal).catch(() => ({ configured: true, compatible: false, active: false, reason: 'Harness capability handshake failed.' }))
      : Promise.resolve(undefined),
  ]);
  const durableScheduler = configured(process.env.DATABASE_URL) || configured(process.env.AXIOM_SCHEDULER_QUEUE_URL);
  const checks: ReadinessCheck[] = [
    {
      id: 'provider-bindings',
      label: '任务模型配置保护',
      state: configured(process.env.AXIOM_PROVIDER_SECRET) ? 'ready' : 'blocked',
      detail: configured(process.env.AXIOM_PROVIDER_SECRET) ? '任务模型配置可加密保存并在重启后恢复。' : '请配置并备份 AXIOM_PROVIDER_SECRET；任务入队需要加密保存模型配置，所有 Worker 必须使用同一密钥。',
      required: true,
    },
    {
      id: 'persistence',
      label: '持久化存储',
      state: configured(process.env.DATABASE_URL) ? 'ready' : 'degraded',
      detail: configured(process.env.DATABASE_URL)
        ? '已配置 PostgreSQL 租约存储。'
        : '当前使用 SQLite，仅适合本地单进程运行。',
      required: true,
    },
    {
      id: 'auth',
      label: 'API 身份认证',
      state: configured(process.env.AXIOM_API_KEY) || process.env.AXIOM_TRUST_PROXY_AUTH === 'true' ? 'ready' : 'degraded',
      detail: configured(process.env.AXIOM_API_KEY)
        ? '已强制启用 Bearer 身份认证。'
        : '尚未配置网关密钥，只能在可信私有网络中使用。',
      required: true,
    },
    {
      id: 'rbac',
      label: '租户身份签名',
      state: configured(process.env.AXIOM_PRINCIPAL_SECRET) ? 'ready' : 'degraded',
      detail: configured(process.env.AXIOM_PRINCIPAL_SECRET)
        ? '租户、用户和角色声明已在网关边界使用 HMAC 签名。'
        : '尚未配置身份签名密钥，租户请求头只能在私有代理后被信任。',
      required: true,
    },
    {
      id: 'model-provider',
      label: '文本模型服务',
      state: !modelConfigured
        ? 'blocked'
        : modelProbe && !modelProbe.reachable
          ? 'blocked'
          : 'ready',
      detail: !modelConfigured
        ? '缺少 DEEPSEEK_API_KEY。'
        : modelProbe?.detail ?? `已配置 ${process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'}，尚未探测模型服务连通性。`,
      required: true,
    },
    {
      id: 'image-provider',
      label: '图像模型服务',
      state: configured(process.env.DMX_API_KEY) ? 'ready' : 'degraded',
      detail: configured(process.env.DMX_API_KEY)
        ? `已配置 ${process.env.DMX_MODEL ?? 'gpt-image-2-03'}。`
        : '配置 DMX_API_KEY 后才能使用图像生成。',
      required: false,
    },
    {
      id: 'video-provider',
      label: '视频模型服务',
      state: configured(process.env.VIDEO_API_BASE) && configured(process.env.VIDEO_MODEL) ? 'ready' : 'degraded',
      detail: configured(process.env.VIDEO_API_BASE) && configured(process.env.VIDEO_MODEL)
        ? `已配置本地视频模型 ${process.env.VIDEO_MODEL}。`
        : '填写本地视频服务 URL 和模型名称后，视频制作 Agent 才能使用。',
      required: false,
    },
    {
      id: 'memory',
      label: '长期记忆',
      state: !memoryConfigured
        ? 'degraded'
        : memoryProbe && !memoryProbe.reachable
          ? 'degraded'
          : 'ready',
      detail: !memoryConfigured
        ? '记忆适配器未启用，不同运行之间不会保留工作流记忆。'
        : memoryProbe?.detail ?? '已配置 TencentDB MemoryCore 适配器，尚未探测连通性。',
      required: false,
    },
    {
      id: 'harness',
      label: 'Harness 边车服务',
      state: !harnessConfigured
        ? 'ready'
        : harnessProbe && harnessProbe.compatible && harnessProbe.active
          ? 'ready'
          : 'degraded',
      detail: harnessConfigured
        ? harnessProbe?.reason ?? '已配置 Harness，但尚未完成真实能力握手。'
        : '当前使用内置调度器，边车服务为可选项。',
      required: false,
    },
    {
      id: 'tool-executor',
      label: '沙箱工具执行器',
      state: !sandboxConfigured
        ? 'blocked'
        : sandboxProbe && !sandboxProbe.available
          ? 'blocked'
          : 'ready',
      detail: !sandboxConfigured
        ? '尚未配置隔离工具执行器，生产执行处于阻断状态。'
        : sandboxProbe?.detail ?? `已选择 Docker 沙箱配置（${process.env.AXIOM_TOOL_SANDBOX_IMAGE ?? 'ubuntu:22.04'}），尚未探测镜像可用性。`,
      required: true,
    },
    {
      id: 'object-storage',
      label: 'Artifact 对象存储',
      state: objectStoreProbe && !objectStoreProbe.reachable
        ? 'degraded'
        : configured(process.env.AXIOM_OBJECT_STORAGE_ENDPOINT) ? 'ready' : configured(process.env.AXIOM_OBJECT_STORAGE_PATH) ? 'degraded' : 'degraded',
      detail: objectStoreProbe?.detail
        ?? (configured(process.env.AXIOM_OBJECT_STORAGE_ENDPOINT)
          ? 'Artifact 可以从任务数据库外置存储。'
          : configured(process.env.AXIOM_OBJECT_STORAGE_PATH)
            ? '已启用本地文件系统存储；多实例部署应使用对象存储。'
            : 'Artifact 当前保存在数据库中；扩容前需要配置对象存储。'),
      required: false,
    },
    {
      id: 'observability',
      label: '指标与链路追踪',
      state: configured(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) || process.env.PROMETHEUS_ENABLED === 'true' ? 'ready' : 'degraded',
      detail: configured(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
        ? '已配置 OpenTelemetry 导出器。'
        : process.env.PROMETHEUS_ENABLED === 'true'
          ? '已启用 Prometheus 指标。'
          : '尚未配置指标或链路追踪导出器。',
      required: false,
    },
    {
      id: 'triggers',
      label: 'Webhook 与调度持久性',
      state: durableScheduler ? 'ready' : 'degraded',
      detail: configured(process.env.DATABASE_URL)
        ? `PostgreSQL 调度器已持久化并使用租约安全的到期任务领取机制${configured(process.env.AXIOM_WEBHOOK_SECRET) ? '；已启用签名 Webhook 触发器。' : '；Webhook 触发器为可选项且当前未启用。'}`
        : 'Webhook 契约和本地调度器可用；多实例调度需要配置 PostgreSQL 或外部队列。',
      required: false,
    },
  ];

  const blockers = checks.filter((check) => check.state === 'blocked').map((check) => check.label);
  const warnings = checks.filter((check) => check.state === 'degraded').map((check) => check.label);
  const state: ReadinessState = blockers.length ? 'blocked' : warnings.length ? 'degraded' : 'ready';

  return {
    state,
    deployment: state === 'ready' ? 'production-candidate' : 'local-single-node',
    checkedAt: new Date().toISOString(),
    checks,
    blockers,
    warnings,
  };
};

type ReadinessCache = {
  key: string;
  value?: RuntimeReadiness;
  expiresAt: number;
  inFlight?: Promise<RuntimeReadiness>;
};

const dependencyIds = new WeakMap<object, number>();
let nextDependencyId = 1;
let readinessCache: ReadinessCache | undefined;

const dependencyId = (dependency: object | undefined) => {
  if (!dependency) return 'none';
  const existing = dependencyIds.get(dependency);
  if (existing) return String(existing);
  const id = nextDependencyId++;
  dependencyIds.set(dependency, id);
  return String(id);
};

const readinessCacheKey = (dependencies: ReadinessDependencies) => [
  process.env.DATABASE_URL ?? '',
  process.env.AXIOM_API_KEY ?? '',
  process.env.AXIOM_TRUST_PROXY_AUTH ?? '',
  process.env.AXIOM_PRINCIPAL_SECRET ?? '',
  process.env.AXIOM_PROVIDER_SECRET ?? '',
  process.env.DEEPSEEK_API_KEY ?? '',
  process.env.DEEPSEEK_MODEL ?? '',
  process.env.DMX_API_KEY ?? '',
  process.env.VIDEO_API_BASE ?? '',
  process.env.VIDEO_MODEL ?? '',
  process.env.TDAI_MEMORY_ENDPOINT ?? '',
  process.env.DEEPSEEK_HARNESS_URL ?? '',
  process.env.DEEPSEEK_HARNESS_COMMAND ?? '',
  process.env.DEEPSEEK_HARNESS_COMMAND_JSON ?? '',
  process.env.DEEPSEEK_HARNESS_ACTIVE ?? '',
  process.env.DEEPSEEK_HARNESS_CWD ?? '',
  process.env.AXIOM_TOOL_EXECUTOR ?? '',
  process.env.AXIOM_OBJECT_STORAGE_ENDPOINT ?? '',
  process.env.AXIOM_OBJECT_STORAGE_PATH ?? '',
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
  process.env.PROMETHEUS_ENABLED ?? '',
  process.env.AXIOM_SCHEDULER_QUEUE_URL ?? '',
  process.env.AXIOM_WEBHOOK_SECRET ?? '',
  dependencyId(dependencies.memory),
  dependencyId(dependencies.model),
  dependencyId(dependencies.sandbox),
  dependencyId(dependencies.objectStore),
  dependencyId(dependencies.harness),
].join('|');

const readinessTtlMs = () => {
  const configuredTtl = Number(process.env.AXIOM_READINESS_CACHE_TTL_MS ?? 5_000);
  return Number.isFinite(configuredTtl) ? Math.min(60_000, Math.max(0, configuredTtl)) : 5_000;
};

/**
 * Readiness is a point-in-time health snapshot, not a live stream. Cache it
 * briefly and share an in-flight probe so concurrent dashboard requests do not
 * fan out to the model provider, MemoryCore, and Docker for the same snapshot.
 */
export const getRuntimeReadiness = async (dependencies: ReadinessDependencies = {}): Promise<RuntimeReadiness> => {
  const key = readinessCacheKey(dependencies);
  const now = Date.now();
  if (readinessCache?.key === key) {
    if (readinessCache.value && readinessCache.expiresAt > now) return readinessCache.value;
    if (readinessCache.inFlight) return readinessCache.inFlight;
  }

  let inFlight: Promise<RuntimeReadiness>;
  inFlight = computeRuntimeReadiness(dependencies)
    .then((value) => {
      if (readinessCache?.key === key && readinessCache.inFlight === inFlight) {
        readinessCache = { key, value, expiresAt: Date.now() + readinessTtlMs() };
      }
      return value;
    })
    .catch((error) => {
      if (readinessCache?.key === key && readinessCache.inFlight === inFlight) readinessCache = undefined;
      throw error;
    });
  readinessCache = { key, expiresAt: 0, inFlight };
  return inFlight;
};

/** Test and operational hook for forcing the next request to refresh. */
export const clearReadinessCache = () => {
  readinessCache = undefined;
};
