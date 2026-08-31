import type { RuntimeEvent } from './contracts.js';

type Usage = Record<string, number>;

type RuntimeMetricSnapshot = {
  uptimeSeconds: number;
  requests: { total: number; errors: number; durationMsTotal: number };
  tasks: { created: number; completed: number; failed: number; cancelled: number };
  images: { requested: number; failed: number };
  tokens: { prompt: number; completion: number; total: number; estimatedCostUsd: number };
  routes: Record<string, number>;
  review: { started: number; approved: number; rejected: number; humanTakeover: number };
  tools: { started: number; completed: number; failed: number };
  latency: { p50Ms: number; p95Ms: number; samples: number };
};

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

export class RuntimeMetrics {
  private readonly startedAt = Date.now();
  private readonly counters = {
    requests: 0,
    requestErrors: 0,
    requestDurationMs: 0,
    tasksCreated: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksCancelled: 0,
    imagesRequested: 0,
    imagesFailed: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    routeDirect: 0,
    routeSingleAgent: 0,
    routeTeam: 0,
    routeFullWorkflow: 0,
    reviewStarted: 0,
    reviewApproved: 0,
    reviewRejected: 0,
    reviewHumanTakeover: 0,
    toolsStarted: 0,
    toolsCompleted: 0,
    toolsFailed: 0,
  };
  private readonly phaseDurations = new Map<string, number[]>();

  recordRequest(status: number, durationMs: number) {
    this.counters.requests += 1;
    this.counters.requestDurationMs += Math.max(0, durationMs);
    if (status >= 500) this.counters.requestErrors += 1;
  }

  recordTask(status: 'created' | 'completed' | 'failed' | 'cancelled') {
    const key = `tasks${status[0]!.toUpperCase()}${status.slice(1)}` as keyof typeof this.counters;
    const current = this.counters[key];
    if (typeof current === 'number') this.counters[key] = current + 1;
  }

  recordImage(status: 'requested' | 'failed') {
    const key = `images${status[0]!.toUpperCase()}${status.slice(1)}` as keyof typeof this.counters;
    const current = this.counters[key];
    if (typeof current === 'number') this.counters[key] = current + 1;
  }

  recordUsage(usage?: Usage) {
    if (!usage) return;
    const prompt = number(usage.prompt_tokens ?? usage.input_tokens);
    const completion = number(usage.completion_tokens ?? usage.output_tokens);
    const total = number(usage.total_tokens) || prompt + completion;
    this.counters.promptTokens += prompt;
    this.counters.completionTokens += completion;
    this.counters.totalTokens += total;
    const inputRate = Number(process.env.AGENT_INPUT_COST_PER_1K_USD ?? 0);
    const outputRate = Number(process.env.AGENT_OUTPUT_COST_PER_1K_USD ?? 0);
    this.counters.estimatedCostUsd += (prompt / 1_000) * inputRate + (completion / 1_000) * outputRate;
  }

  recordEvent(event: RuntimeEvent) {
    if (event.type === 'task.planning') {
      const route = String(event.payload.profile && typeof event.payload.profile === 'object' ? (event.payload.profile as { route?: string }).route : event.payload.route);
      const key = `route${route === 'single-agent' ? 'SingleAgent' : route === 'full-workflow' ? 'FullWorkflow' : route ? route[0]!.toUpperCase() + route.slice(1) : ''}` as keyof typeof this.counters;
      if (key in this.counters && typeof this.counters[key] === 'number') this.counters[key] += 1;
    }
    if (event.type === 'review.started') this.counters.reviewStarted += 1;
    if (event.type === 'review.completed' && event.payload.approved === true) this.counters.reviewApproved += 1;
    if (event.type === 'review.rejected') this.counters.reviewRejected += 1;
    if (event.type === 'review.approval_requested') this.counters.reviewHumanTakeover += 1;
    if (event.type === 'tool.started') this.counters.toolsStarted += 1;
    if (event.type === 'tool.completed') this.counters.toolsCompleted += 1;
    if (event.type === 'tool.failed') this.counters.toolsFailed += 1;
    if (event.type === 'model.completed') {
      const stage = typeof event.payload.stage === 'string' ? event.payload.stage : 'unknown';
      const duration = Number(event.payload.durationMs ?? 0);
      if (Number.isFinite(duration) && duration >= 0) {
        const samples = this.phaseDurations.get(stage) ?? [];
        samples.push(duration);
        this.phaseDurations.set(stage, samples.slice(-2_000));
      }
    }
  }

  private latencyPercentile(percentile: number) {
    const samples = [...this.phaseDurations.values()].flat().sort((left, right) => left - right);
    if (!samples.length) return 0;
    const rank = Math.max(0, Math.min(samples.length - 1, Math.ceil(samples.length * percentile) - 1));
    return Math.round(samples[rank]!);
  }

  snapshot(): RuntimeMetricSnapshot {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000),
      requests: {
        total: this.counters.requests,
        errors: this.counters.requestErrors,
        durationMsTotal: this.counters.requestDurationMs,
      },
      tasks: {
        created: this.counters.tasksCreated,
        completed: this.counters.tasksCompleted,
        failed: this.counters.tasksFailed,
        cancelled: this.counters.tasksCancelled,
      },
      images: {
        requested: this.counters.imagesRequested,
        failed: this.counters.imagesFailed,
      },
      tokens: {
        prompt: this.counters.promptTokens,
        completion: this.counters.completionTokens,
        total: this.counters.totalTokens,
        estimatedCostUsd: Number(this.counters.estimatedCostUsd.toFixed(6)),
      },
      routes: {
        direct: this.counters.routeDirect,
        'single-agent': this.counters.routeSingleAgent,
        team: this.counters.routeTeam,
        'full-workflow': this.counters.routeFullWorkflow,
      },
      review: {
        started: this.counters.reviewStarted,
        approved: this.counters.reviewApproved,
        rejected: this.counters.reviewRejected,
        humanTakeover: this.counters.reviewHumanTakeover,
      },
      tools: {
        started: this.counters.toolsStarted,
        completed: this.counters.toolsCompleted,
        failed: this.counters.toolsFailed,
      },
      latency: {
        p50Ms: this.latencyPercentile(0.5),
        p95Ms: this.latencyPercentile(0.95),
        samples: [...this.phaseDurations.values()].reduce((total, values) => total + values.length, 0),
      },
    };
  }

  prometheus(): string {
    const snapshot = this.snapshot();
    const lines = [
      '# HELP axiom_uptime_seconds Process uptime in seconds.',
      '# TYPE axiom_uptime_seconds gauge',
      `axiom_uptime_seconds ${snapshot.uptimeSeconds}`,
      '# TYPE axiom_http_requests_total counter',
      `axiom_http_requests_total ${snapshot.requests.total}`,
      '# TYPE axiom_http_request_errors_total counter',
      `axiom_http_request_errors_total ${snapshot.requests.errors}`,
      '# TYPE axiom_http_request_duration_ms_total counter',
      `axiom_http_request_duration_ms_total ${snapshot.requests.durationMsTotal}`,
      '# TYPE axiom_tasks_total counter',
      `axiom_tasks_total{status="created"} ${snapshot.tasks.created}`,
      `axiom_tasks_total{status="completed"} ${snapshot.tasks.completed}`,
      `axiom_tasks_total{status="failed"} ${snapshot.tasks.failed}`,
      `axiom_tasks_total{status="cancelled"} ${snapshot.tasks.cancelled}`,
      '# TYPE axiom_images_total counter',
      `axiom_images_total{status="requested"} ${snapshot.images.requested}`,
      `axiom_images_total{status="failed"} ${snapshot.images.failed}`,
      '# TYPE axiom_tokens_total counter',
      `axiom_tokens_total{kind="prompt"} ${snapshot.tokens.prompt}`,
      `axiom_tokens_total{kind="completion"} ${snapshot.tokens.completion}`,
      `axiom_tokens_total{kind="total"} ${snapshot.tokens.total}`,
      '# TYPE axiom_estimated_model_cost_usd_total counter',
      `axiom_estimated_model_cost_usd_total ${snapshot.tokens.estimatedCostUsd}`,
      '# TYPE axiom_route_tasks_total counter',
      ...Object.entries(snapshot.routes).map(([route, value]) => `axiom_route_tasks_total{route="${route}"} ${value}`),
      '# TYPE axiom_reviewer_events_total counter',
      `axiom_reviewer_events_total{kind="started"} ${snapshot.review.started}`,
      `axiom_reviewer_events_total{kind="approved"} ${snapshot.review.approved}`,
      `axiom_reviewer_events_total{kind="rejected"} ${snapshot.review.rejected}`,
      `axiom_reviewer_events_total{kind="human_takeover"} ${snapshot.review.humanTakeover}`,
      '# TYPE axiom_tool_events_total counter',
      `axiom_tool_events_total{kind="started"} ${snapshot.tools.started}`,
      `axiom_tool_events_total{kind="completed"} ${snapshot.tools.completed}`,
      `axiom_tool_events_total{kind="failed"} ${snapshot.tools.failed}`,
      '# TYPE axiom_model_phase_latency_ms gauge',
      `axiom_model_phase_latency_ms{quantile="0.5"} ${snapshot.latency.p50Ms}`,
      `axiom_model_phase_latency_ms{quantile="0.95"} ${snapshot.latency.p95Ms}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}
