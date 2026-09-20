import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { ImprovementAnalysis, ImprovementEvaluation, ImprovementEvaluationCase } from '../shared/improvement.js';
import { BusinessRecordRevisionConflictError, type BusinessCapabilityStore, type BusinessRecord } from './businessCapabilityStore.js';
import type { WorkflowTask } from './contracts.js';
import { EVALUATION_TIMEOUT_MS, evaluationLimitations, hasFixtureContamination, improvementEvaluationSuite, improvementFixtures, runImprovementArm, summarizeImprovementEvaluation } from './improvementEvaluation.js';
import type { ModelClient } from './modelClient.js';
import type { PrincipalClaims } from './principal.js';

type Api = Hono<{ Variables: { principal: PrincipalClaims } }>;
type EvaluationData = Omit<ImprovementEvaluation, 'id' | 'revision' | 'status' | 'createdAt' | 'updatedAt'> & { requestFingerprint: string; leaseExpiresAt: string };
const kind = 'improvement-evaluation' as const;
const startSchema = z.object({ revision: z.number().int().positive(), idempotencyKey: z.string().min(8).max(160) }).strict();
const cancelSchema = z.object({ revision: z.number().int().positive() }).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordId = (identity: PrincipalClaims, proposalId: string, key: string) => {
  const value = hash(['improvement-evaluation', identity.tenantId, identity.userId, proposalId, key]);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-8${value.slice(13, 16)}-${((parseInt(value[16]!, 16) & 3) | 8).toString(16)}${value.slice(17, 20)}-${value.slice(20, 32)}`;
};
const dataOf = (record: BusinessRecord) => record.data as unknown as EvaluationData;
const publicEvaluation = (record: BusinessRecord): ImprovementEvaluation => {
  const { requestFingerprint: _fingerprint, leaseExpiresAt: _lease, ...data } = dataOf(record);
  return { ...data, id: record.id, revision: record.revision, status: record.status as ImprovementEvaluation['status'], createdAt: record.createdAt, updatedAt: record.updatedAt };
};

export const registerImprovementEvaluations = (api: Api, {
  records, resolveModel, proposalFor, redact, evaluationTimeoutMs = EVALUATION_TIMEOUT_MS, callTimeoutMs,
}: {
  records: BusinessCapabilityStore;
  resolveModel: (task: WorkflowTask) => Promise<ModelClient>;
  proposalFor: (id: string, identity: PrincipalClaims) => Promise<{ record: BusinessRecord; source: WorkflowTask; analysis?: ImprovementAnalysis }>;
  redact: (value: string, maximum?: number) => string;
  /** Test-only dependency injection; HTTP clients cannot modify the evaluation budget. */
  evaluationTimeoutMs?: number; callTimeoutMs?: number;
}) => {
  // Optional eager local abort only; DB revision/status is authoritative across workers.
  const controllers = new Map<string, AbortController>();
  const owned = async (id: string, proposalId: string, identity: PrincipalClaims) => {
    if (!z.string().uuid().safeParse(id).success) throw new HTTPException(404, { message: 'Evaluation not found.' });
    const record = await records.get(id, identity.tenantId);
    if (!record || record.kind !== kind || record.userId !== identity.userId || record.ownerId !== identity.userId || dataOf(record).proposalId !== proposalId) throw new HTTPException(404, { message: 'Evaluation not found.' });
    return record;
  };
  const recover = async (record: BusinessRecord) => {
    if (record.status !== 'running') return record;
    const expiry = Date.parse(dataOf(record).leaseExpiresAt);
    if (Number.isFinite(expiry) && expiry > Date.now()) return record;
    try {
      const next = await records.update(record.id, record.tenantId, { status: 'failed', data: { ...record.data, qualityStatus: 'inconclusive', completedAt: new Date().toISOString(), error: 'This comparison expired or was interrupted. Partial results are retained; start a new comparison explicitly.' } }, record.revision);
      controllers.get(record.id)?.abort();
      return next;
    } catch (error) {
      if (!(error instanceof BusinessRecordRevisionConflictError)) throw error;
      return (await records.get(record.id, record.tenantId)) ?? record;
    }
  };

  const run = async (initial: BusinessRecord, identity: PrincipalClaims, controller: AbortController) => {
    let current = initial;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    const assertCurrent = async () => {
      controller.signal.throwIfAborted();
      const latest = await owned(current.id, dataOf(initial).proposalId, identity);
      if (latest.status !== 'running' || latest.revision !== current.revision || Date.parse(dataOf(latest).leaseExpiresAt) <= Date.now()) throw new Error('Comparison no longer owns the lease.');
      const proposal = await proposalFor(dataOf(initial).proposalId, identity);
      if (proposal.record.revision !== dataOf(initial).proposalRevision || !['draft', 'accepted'].includes(proposal.record.status) || !proposal.analysis) throw new Error('Candidate changed during comparison.');
      controller.signal.throwIfAborted();
      return proposal;
    };
    const persist = async (patch: Partial<EvaluationData>, status = 'running') => {
      await assertCurrent();
      current = await records.update(current.id, identity.tenantId, { status, data: { ...current.data, ...patch } }, current.revision);
    };
    try {
      const abortPromise = new Promise<never>((_, reject) => {
        abortHandler = () => reject(controller.signal.reason ?? new Error('Comparison interrupted.'));
        controller.signal.addEventListener('abort', abortHandler, { once: true });
        timer = setTimeout(() => controller.abort(new Error('Comparison time limit expired.')), evaluationTimeoutMs);
      });
      const work = async () => {
        const proposal = await assertCurrent();
        const client = await resolveModel(proposal.source);
        await assertCurrent();
        await persist({ model: redact(client.model, 160) });
        const cases = structuredClone(dataOf(current).cases);
        const guidance = redact(proposal.analysis!.trialInstruction, 4_000);
        let completed = 0;
        for (const [index, fixture] of improvementFixtures.entries()) {
          // Counterbalance the order without changing inputs, model or settings.
          const order = index % 2 ? ['candidate', 'baseline'] as const : ['baseline', 'candidate'] as const;
          for (const arm of order) {
            await assertCurrent();
            const result = await runImprovementArm({ client, fixture, ...(arm === 'candidate' ? { guidance } : {}), signal: controller.signal, redact, ...(callTimeoutMs ? { timeoutMs: callTimeoutMs } : {}) });
            await assertCurrent();
            cases[index]![arm] = result;
            completed += 1;
            await persist({ cases, progress: { completed, total: improvementFixtures.length * 2 }, ...summarizeImprovementEvaluation(cases, false) });
          }
        }
        await persist({ ...summarizeImprovementEvaluation(cases, true), completedAt: new Date().toISOString() }, 'completed');
      };
      await Promise.race([work(), abortPromise]);
    } catch {
      // No raw provider error/credential-bearing URL is persisted or returned.
      const latest = await records.get(initial.id, identity.tenantId).catch(() => null);
      if (latest?.status === 'running') {
        try {
          await records.update(latest.id, identity.tenantId, { status: 'failed', data: { ...latest.data, qualityStatus: 'inconclusive', completedAt: new Date().toISOString(), error: 'Comparison interrupted, timed out, or its source/candidate changed. Partial results are retained; no policy was applied.' } }, latest.revision);
        } catch { /* Another worker/cancel/recovery owns the terminal revision. */ }
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (abortHandler) controller.signal.removeEventListener('abort', abortHandler);
      controller.abort();
      controllers.delete(initial.id);
    }
  };

  api.get('/evaluation-suite', (c) => c.json({ suite: improvementEvaluationSuite }));
  api.get('/:id/evaluations', async (c) => {
    const identity = c.get('principal');
    await proposalFor(c.req.param('id'), identity);
    const evaluations: ImprovementEvaluation[] = [];
    for (const record of await records.list(identity.tenantId, kind, { userId: identity.userId, proposalId: c.req.param('id'), limit: 500 })) {
      if (record.ownerId !== identity.userId || dataOf(record).proposalId !== c.req.param('id')) continue;
      evaluations.push(publicEvaluation(await recover(record)));
    }
    // Check again after awaits: never expose output after a source deletion/reassignment.
    await proposalFor(c.req.param('id'), identity);
    return c.json({ evaluations });
  });
  api.post('/:id/evaluations', async (c) => {
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid comparison request.' }, 400);
    const identity = c.get('principal');
    const proposalId = c.req.param('id');
    const { record: proposal, source, analysis } = await proposalFor(proposalId, identity);
    const id = recordId(identity, proposalId, parsed.data.idempotencyKey);
    // Idempotency belongs to the user request, not the currently installed suite.
    // A deployment with a newer suite must still replay the historical result.
    const fingerprint = hash({ proposalId, revision: parsed.data.revision });
    const existingResponse = async (record: BusinessRecord) => {
      const checked = await owned(record.id, proposalId, identity);
      if (dataOf(checked).requestFingerprint !== fingerprint) throw new HTTPException(409, { message: 'This comparison key is already used for different parameters.' });
      const recovered = await recover(checked);
      await proposalFor(proposalId, identity);
      return c.json({ evaluation: publicEvaluation(recovered) }, recovered.status === 'running' ? 202 : 200);
    };
    const existing = await records.get(id, identity.tenantId);
    if (existing) return existingResponse(existing);
    if (proposal.revision !== parsed.data.revision) return c.json({ error: 'This candidate changed. Refresh before comparing.' }, 409);
    if (!['draft', 'accepted'].includes(proposal.status) || !analysis) return c.json({ error: 'Only a usable draft or saved candidate can be compared.' }, 409);
    // Reject recognizable direct fixture overlap. Public/reused cases are not a
    // permanently blind holdout; marker detection cannot prove no prior exposure.
    if (hasFixtureContamination(JSON.stringify([source.input, source.result, analysis]))) return c.json({ error: 'This source or candidate overlaps the fixed comparison suite. Use an independent source task.' }, 409);
    const cases: ImprovementEvaluationCase[] = improvementFixtures.map(({ id: fixtureId, title, scope }) => ({ fixtureId, title, scope }));
    const data: EvaluationData = {
      proposalId, proposalRevision: proposal.revision, suiteId: improvementEvaluationSuite.id, suiteVersion: improvementEvaluationSuite.version, suiteDigest: improvementEvaluationSuite.digest,
      requestFingerprint: fingerprint, leaseExpiresAt: new Date(Date.now() + evaluationTimeoutMs + 15_000).toISOString(),
      progress: { completed: 0, total: improvementFixtures.length * 2 }, cases, limitations: evaluationLimitations, ...summarizeImprovementEvaluation(cases, false),
    };
    const claim = await records.claimImprovementEvaluation({ id, proposalId, tenantId: identity.tenantId, userId: identity.userId, ownerId: identity.userId, kind, status: 'running', data: { ...data } });
    if (!claim.claimed) {
      if (claim.record.id === id) return existingResponse(claim.record);
      return c.json({ error: 'A comparison is already running for this candidate. Refresh to view or cancel it before starting another.' }, 409);
    }
    const created = claim.record;
    const controller = new AbortController();
    controllers.set(id, controller);
    // The durable claim precedes work. Disconnect does not trigger an automatic rerun.
    // Crash recovery marks expired claims inconclusive rather than replaying paid calls.
    void run(created, identity, controller).catch(() => undefined);
    return c.json({ evaluation: publicEvaluation(created) }, 202);
  });
  api.post('/:id/evaluations/:evaluationId/cancel', async (c) => {
    const parsed = cancelSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid cancellation request.' }, 400);
    const identity = c.get('principal');
    await proposalFor(c.req.param('id'), identity);
    const record = await recover(await owned(c.req.param('evaluationId'), c.req.param('id'), identity));
    if (record.revision !== parsed.data.revision) return c.json({ error: 'This comparison changed. Refresh before cancelling.' }, 409);
    if (record.status !== 'running') {
      await proposalFor(c.req.param('id'), identity);
      return c.json({ evaluation: publicEvaluation(record) });
    }
    const updated = await records.update(record.id, identity.tenantId, { status: 'cancelled', data: { ...record.data, qualityStatus: 'inconclusive', completedAt: new Date().toISOString(), error: 'Comparison cancelled. Partial results are retained. Already submitted provider requests may still be billed.' } }, record.revision);
    controllers.get(record.id)?.abort();
    await proposalFor(c.req.param('id'), identity);
    return c.json({ evaluation: publicEvaluation(updated) });
  });
};
