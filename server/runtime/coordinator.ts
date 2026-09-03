import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { TaskStore } from './contracts.js';
import { WorkflowOrchestrator } from './orchestrator.js';

export class TaskCoordinator {
  private readonly workerId = `${process.env.HOSTNAME ?? 'local'}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly active = new Map<string, AbortController>();
  private readonly maxConcurrentTasks = Math.min(8, Math.max(1, Number(process.env.AGENT_TASK_CONCURRENCY ?? 2)));
  private readonly leaseMs = Math.max(30_000, Number(process.env.AGENT_TASK_LEASE_MS ?? 90_000));
  private readonly taskTimeoutMs = Math.max(60_000, Number(process.env.AGENT_TASK_TIMEOUT_MS ?? 900_000));
  private pollTimer?: NodeJS.Timeout;
  private polling = false;
  private started = false;

  constructor(
    private readonly store: TaskStore,
    private readonly orchestrator: WorkflowOrchestrator,
    private readonly logger: Logger,
  ) {}

  start() {
    if (this.started) return;
    this.started = true;
    this.pollTimer = setInterval(() => void this.poll(), 1_000);
    this.pollTimer.unref();
    void this.poll();
  }

  async stop() {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const controller of this.active.values()) controller.abort(new DOMException('Runtime shutting down', 'AbortError'));
    await Promise.allSettled([...this.active.keys()].map(async (taskId) => {
      while (this.active.has(taskId)) await new Promise((resolve) => setTimeout(resolve, 25));
    }));
  }

  nudge() {
    if (this.started) void this.poll();
  }

  abort(taskId: string) {
    this.active.get(taskId)?.abort(new DOMException('Task cancelled', 'AbortError'));
  }

  pauseStep(taskId: string, stepId: string) {
    return this.active.has(taskId) && this.orchestrator.pauseStep(taskId, stepId);
  }

  private async poll() {
    if (!this.started || this.polling || this.active.size >= this.maxConcurrentTasks) return;
    this.polling = true;
    try {
      while (this.active.size < this.maxConcurrentTasks) {
        const task = await this.store.claimNextTask(this.workerId, this.leaseMs);
        if (!task || this.active.has(task.id)) break;
        const controller = new AbortController();
        this.active.set(task.id, controller);
        void this.runClaimed(task.id, controller);
      }
    } catch (error) {
      this.logger.error({ error, workerId: this.workerId }, 'task coordinator polling failed');
    } finally {
      this.polling = false;
    }
  }

  private async runClaimed(taskId: string, controller: AbortController) {
    const claimedTask = await this.store.getTask(taskId);
    const effectiveTimeoutMs = Math.max(30_000, Math.min(this.taskTimeoutMs, claimedTask?.policy.maxDurationMs ?? this.taskTimeoutMs));
    const taskTimeout = setTimeout(() => {
      controller.abort(new DOMException(`Task exceeded ${effectiveTimeoutMs} ms.`, 'TimeoutError'));
    }, effectiveTimeoutMs);
    taskTimeout.unref();
    const heartbeat = setInterval(() => {
      void this.store.renewLease(taskId, this.workerId, this.leaseMs).then((renewed) => {
        if (!renewed) controller.abort(new DOMException('Task lease was lost', 'AbortError'));
      });
    }, Math.floor(this.leaseMs / 3));
    heartbeat.unref();

    try {
      const task = await this.store.getTask(taskId);
      if (!task) return;
      await this.orchestrator.run(task, controller.signal);
    } finally {
      clearTimeout(taskTimeout);
      clearInterval(heartbeat);
      await this.store.releaseLease(taskId, this.workerId).catch(() => undefined);
      this.active.delete(taskId);
      this.nudge();
    }
  }
}
