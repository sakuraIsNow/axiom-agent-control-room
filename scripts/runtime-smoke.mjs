import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = (process.env.QA_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const authorization = process.env.QA_API_KEY ? { Authorization: `Bearer ${process.env.QA_API_KEY}` } : {};
const headers = {
  ...authorization,
  'Content-Type': 'application/json',
  'x-axiom-tenant-id': 'runtime-smoke',
  'x-axiom-user-id': 'runtime-smoke',
};
const signal = AbortSignal.timeout(360_000);
let cleanupTaskId = '';

try {
const createdResponse = await fetch(`${baseUrl}/api/tasks`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    sessionId: `smoke-${Date.now()}`,
    title: 'Production workflow smoke test',
    input: '请给出一个生产级 Agent 服务上线前的三项关键验收条件。每项包含可验证标准和失败时的处置，结论保持简洁。',
    mode: 'analyze',
  }),
  signal,
});
const created = await createdResponse.json();
if (!createdResponse.ok || !created.task?.id) {
  throw new Error(created.error ?? `Task creation failed with ${createdResponse.status}.`);
}

const taskId = created.task.id;
cleanupTaskId = taskId;
const events = [];
let terminal;
let lastSequence = 0;
let gateApprovals = 0;
const isVisibleStage = (stage) => stage === 'direct-response' || stage === 'synthesizer' || stage.startsWith('single-agent:');
const streamedLengths = new Map();
const streamedLengthSamples = new Map();
const approveGate = async (event) => {
  const controls = {
    'plan.approval_requested': { path: 'approve-plan', body: {} },
    'review.approval_requested': { path: 'approve-review', body: {} },
    'tool.approval_requested': { path: 'approve-tool', body: { approvalId: event.payload?.approval?.id } },
  }[event.type];
  if (!controls || (event.type === 'tool.approval_requested' && !controls.body.approvalId)) return;
  const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/${controls.path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(controls.body),
    signal,
  });
  if (!response.ok) throw new Error(`Approval control failed with ${response.status}.`);
  gateApprovals += 1;
};

let reconnects = 0;
while (!terminal) {
  const eventResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/events?after=${lastSequence}`, {
    headers: { ...authorization, Accept: 'text/event-stream', 'x-axiom-tenant-id': 'runtime-smoke' },
    signal,
  });
  if (!eventResponse.ok || !eventResponse.body) throw new Error(`Event stream reconnect failed with ${eventResponse.status}.`);
  const reconnectReader = eventResponse.body.getReader();
  const reconnectDecoder = new TextDecoder();
  let reconnectBuffer = '';
  while (!terminal) {
    const { done, value } = await reconnectReader.read();
    if (done) break;
    reconnectBuffer += reconnectDecoder.decode(value, { stream: true });
    let boundary = reconnectBuffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = reconnectBuffer.slice(0, boundary);
      reconnectBuffer = reconnectBuffer.slice(boundary + 2);
      boundary = reconnectBuffer.indexOf('\n\n');
      const raw = block.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!raw) continue;
      const event = JSON.parse(raw);
      if (Number(event.sequence) <= lastSequence) continue;
      lastSequence = Number(event.sequence);
      events.push(event);
      if (event.type === 'model.delta' && event.payload?.reset) {
        const stage = typeof event.payload?.stage === 'string' ? event.payload.stage : 'unknown';
        if (isVisibleStage(stage)) {
          streamedLengths.set(stage, 0);
          streamedLengthSamples.set(stage, []);
        }
      } else if (event.type === 'model.delta') {
        const stage = typeof event.payload?.stage === 'string' ? event.payload.stage : 'unknown';
        const delta = typeof event.payload?.content === 'string' ? event.payload.content : '';
        if (isVisibleStage(stage) && delta) {
          const nextLength = (streamedLengths.get(stage) ?? 0) + delta.length;
          streamedLengths.set(stage, nextLength);
          const samples = streamedLengthSamples.get(stage) ?? [];
          if (samples.at(-1) !== nextLength) samples.push(nextLength);
          streamedLengthSamples.set(stage, samples.slice(-32));
        }
      }
      if (['plan.approval_requested', 'review.approval_requested', 'tool.approval_requested'].includes(event.type)) await approveGate(event);
      if (['task.completed', 'task.failed', 'task.cancelled'].includes(event.type)) terminal = event;
    }
  }
  if (!terminal) {
    reconnects += 1;
    if (reconnects > 8) throw new Error('Event stream closed repeatedly without a terminal event.');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

if (!terminal) throw new Error('Event stream closed without a terminal event.');
const sequences = events.map((event) => event.sequence);
if (sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1])) {
  throw new Error('Runtime event sequence is not strictly increasing.');
}

const taskResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
  headers: { ...authorization, 'x-axiom-tenant-id': 'runtime-smoke' },
  signal,
});
const taskBody = await taskResponse.json();
if (!taskResponse.ok) throw new Error(taskBody.error ?? 'Task lookup failed.');

let artifactCharacters = 0;
if (terminal.type === 'task.completed') {
  const artifactResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/artifacts/result`, {
    headers: { ...authorization, 'x-axiom-tenant-id': 'runtime-smoke' },
    signal,
  });
  const artifactBody = await artifactResponse.json();
  if (!artifactResponse.ok || !artifactBody.artifact?.content) {
    throw new Error(artifactBody.error ?? 'Result artifact was not available.');
  }
  artifactCharacters = artifactBody.artifact.content.length;
}

const result = {
  taskId,
  status: taskBody.task.status,
  terminalEvent: terminal.type,
  eventCount: events.length,
  sequence: { first: sequences[0], last: sequences.at(-1) },
  eventTypes: [...new Set(events.map((event) => event.type))],
  tokens: events.filter((event) => event.type === 'model.completed').reduce((total, event) => ({
    prompt: total.prompt + Number(event.payload?.promptTokens ?? 0),
    completion: total.completion + Number(event.payload?.completionTokens ?? 0),
    total: total.total + Number(event.payload?.totalTokens ?? 0),
  }), { prompt: 0, completion: 0, total: 0 }),
  streaming: {
    deltaEvents: events.filter((event) => event.type === 'model.delta').length,
    visibleStages: Object.fromEntries([...streamedLengthSamples.entries()].map(([stage, samples]) => [stage, {
      samples,
      finalCharacters: samples.at(-1) ?? 0,
    }])),
    terminalSequence: terminal.sequence,
    lastDeltaBeforeTerminal: events.filter((event) => event.type === 'model.delta' && event.sequence < terminal.sequence).at(-1)?.sequence ?? 0,
    gateApprovals,
  },
  artifactCharacters,
  review: taskBody.task.review
    ? { approved: taskBody.task.review.approved, score: taskBody.task.review.score }
    : null,
};

const qualityReport = {
  generatedAt: new Date().toISOString(),
  suite: 'axiom-runtime-smoke-v1',
  caseId: 'production-workflow-smoke',
  status: taskBody.task.status,
  terminalEvent: terminal.type,
  durationMs: Math.max(0, new Date(taskBody.task.updatedAt).getTime() - new Date(taskBody.task.createdAt).getTime()),
  totalTokens: result.tokens?.total ?? 0,
  evidenceCount: taskBody.task.stepResults.reduce((total, step) => total + (Array.isArray(step.evidence) ? step.evidence.length : 0), 0),
  manualTakeover: Boolean(taskBody.task.review && !taskBody.task.review.approved),
  reviewScore: taskBody.task.review?.score ?? null,
  streaming: result.streaming,
};
await mkdir(resolve(process.cwd(), 'qa'), { recursive: true });
await writeFile(resolve(process.cwd(), 'qa', 'runtime-results.json'), `${JSON.stringify(qualityReport, null, 2)}\n`);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (terminal.type !== 'task.completed' || result.streaming.deltaEvents === 0 || result.streaming.lastDeltaBeforeTerminal === 0) process.exitCode = 1;
} finally {
  if (cleanupTaskId) {
    const cleanupSignal = AbortSignal.timeout(30_000);
    let statusResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(cleanupTaskId)}`, {
      headers,
      signal: cleanupSignal,
    }).catch(() => null);
    let statusBody = await statusResponse?.json().catch(() => null);
    if (statusResponse?.ok && !['completed', 'failed', 'cancelled'].includes(statusBody?.task?.status)) {
      await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(cleanupTaskId)}/cancel`, {
        method: 'POST',
        headers,
        signal: cleanupSignal,
      }).catch(() => undefined);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        statusResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(cleanupTaskId)}`, {
          headers,
          signal: cleanupSignal,
        }).catch(() => null);
        statusBody = await statusResponse?.json().catch(() => null);
        if (!statusResponse?.ok || ['completed', 'failed', 'cancelled'].includes(statusBody?.task?.status)) break;
      }
    }
    const deleted = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(cleanupTaskId)}`, {
      method: 'DELETE',
      headers,
      signal: cleanupSignal,
    });
    if (!deleted.ok && deleted.status !== 404) throw new Error(`Runtime smoke cleanup failed with ${deleted.status}.`);
  }
}
