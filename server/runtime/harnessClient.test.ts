import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexHarnessAdapter, DeepSeekHarnessAdapter } from './harnessClient.js';

const sidecarScript = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentInfo: { name: 'deepseek-harness-acp', version: '0.1.0' },
      agentCapabilities: { promptCapabilities: { image: false } }
    }});
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'acp-session-1' }});
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'sidecar answer' } }
    }});
    setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' }}), 10);
  } else if (message.method === 'session/cancel') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: message.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cancelled' } }
    }});
  }
});
`;

const approvalSidecarScript = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let promptId;
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'deepseek-harness-acp' }, agentCapabilities: {} }});
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'approval-session' }});
  else if (message.method === 'session/prompt') {
    promptId = message.id;
    send({ jsonrpc: '2.0', id: 55, method: 'session/request_permission', params: { sessionId: message.params.sessionId, toolCall: { toolCallId: 'approval-1' } }});
  } else if (message.id === 55 && message.result) {
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' }});
  }
});
`;

const codexSidecarScript = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2', serverInfo: { name: 'codex-app-server' } } });
  else if (message.method === 'thread/start') send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'codex-thread-1' } } });
  else if (message.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'codex-turn-1' } } });
    send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId: 'codex-turn-1', delta: 'codex answer' } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: message.params.threadId, turnId: 'codex-turn-1' } });
  } else if (message.method === 'thread/resume') send({ jsonrpc: '2.0', id: message.id, result: {} });
  else if (message.method === 'turn/interrupt') send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`;

test('ACP stdio adapter requires explicit activation after a compatible handshake', async () => {
  const adapter = new DeepSeekHarnessAdapter({
    command: [process.execPath, '-e', sidecarScript],
    active: false,
  });
  try {
    const capabilities = await adapter.handshake();
    assert.equal(capabilities.configured, true);
    assert.equal(capabilities.compatible, true);
    assert.equal(capabilities.active, false);
    assert.match(capabilities.reason, /DEEPSEEK_HARNESS_ACTIVE/);
    await assert.rejects(
      adapter.startThread({ taskId: 'task-1', sessionId: 'session-1' }),
      /execution is explicitly enabled|DEEPSEEK_HARNESS_ACTIVE/,
    );
  } finally {
    adapter.close();
  }
});

test('ACP handshake contains an invalid sidecar command without taking down the caller', async () => {
  const adapter = new DeepSeekHarnessAdapter({
    command: ['axiom-command-that-does-not-exist'],
    active: true,
    timeoutMs: 500,
  });
  try {
    const capabilities = await adapter.handshake();
    assert.equal(capabilities.configured, true);
    assert.equal(capabilities.compatible, false);
    assert.equal(capabilities.active, false);
  } finally {
    adapter.close();
  }
});

test('ACP stdio adapter maps session events and accepts cancellation', async () => {
  const adapter = new DeepSeekHarnessAdapter({
    command: [process.execPath, '-e', sidecarScript],
    active: true,
  });
  try {
    const thread = await adapter.startThread({ taskId: 'task-1', sessionId: 'session-1' });
    const events: string[] = [];
    const subscription = (async () => {
      for await (const event of adapter.subscribe(thread.threadId)) {
        events.push(event.kind);
        if (event.kind === 'turn.completed') break;
      }
    })();
    const turn = await adapter.startTurn({
      taskId: 'task-1',
      threadId: thread.threadId,
      runId: 'run-1',
      input: 'hello',
    });
    assert.equal(turn.turnId, 'run-1');
    await subscription;
    assert.deepEqual(events, ['turn.started', 'message.delta', 'turn.completed']);
    const interrupted = await adapter.interrupt(thread.threadId, turn.turnId);
    assert.equal(interrupted.accepted, true);
    assert.equal(interrupted.delegated, true);
  } finally {
    adapter.close();
  }
});

test('ACP stdio adapter exposes permission requests and returns a one-shot decision', async () => {
  const adapter = new DeepSeekHarnessAdapter({
    command: [process.execPath, '-e', approvalSidecarScript],
    active: true,
  });
  try {
    const thread = await adapter.startThread({ taskId: 'task-approval', sessionId: 'session-approval' });
    const events: string[] = [];
    const subscription = (async () => {
      for await (const event of adapter.subscribe(thread.threadId)) {
        events.push(event.kind);
        if (event.kind === 'approval.requested') break;
      }
    })();
    const turnPromise = adapter.startTurn({ taskId: 'task-approval', threadId: thread.threadId, runId: 'run-approval', input: 'run tool' });
    await subscription;
    const decision = await adapter.approve('approval-1', 'approved', '已确认');
    assert.deepEqual(decision, { accepted: true, delegated: true, command: 'approve' });
    await turnPromise;
    assert.deepEqual(events, ['turn.started', 'approval.requested']);
  } finally {
    adapter.close();
  }
});

test('Codex app-server v2 transport maps thread and turn lifecycle events', async () => {
  const adapter = new CodexHarnessAdapter({ command: [process.execPath, '-e', codexSidecarScript], active: true });
  try {
    const capabilities = await adapter.handshake();
    assert.equal(capabilities.compatible, true);
    assert.equal(capabilities.active, true);
    const thread = await adapter.startThread({ taskId: 'task-codex', sessionId: 'session-codex' });
    const events: string[] = [];
    const subscription = (async () => {
      for await (const event of adapter.subscribe(thread.threadId)) {
        events.push(event.kind);
        if (event.kind === 'turn.completed') break;
      }
    })();
    const turn = await adapter.startTurn({ taskId: 'task-codex', threadId: thread.threadId, runId: 'run-codex', input: 'hello' });
    assert.equal(turn.turnId, 'codex-turn-1');
    await subscription;
    assert.deepEqual(events, ['turn.started', 'message.delta', 'turn.completed']);
  } finally {
    adapter.close();
  }
});

test('Harness resume reopens a queue after the sidecar process is restarted', async () => {
  const adapter = new CodexHarnessAdapter({ command: [process.execPath, '-e', codexSidecarScript], active: true });
  try {
    const thread = await adapter.startThread({ taskId: 'task-reconnect', sessionId: 'session-reconnect' });
    adapter.close();

    const resumed = await adapter.resume(thread.threadId, undefined, 41);
    assert.equal(resumed.accepted, true);
    const events: string[] = [];
    for await (const event of adapter.subscribe(thread.threadId)) {
      events.push(event.kind);
      if (event.kind === 'thread.resumed') break;
    }
    assert.deepEqual(events, ['thread.resumed']);
    // The restarted adapter must continue after the durable bridge cursor,
    // otherwise the first post-restart event would be mistaken for a replay.
    const cursorProbe = new CodexHarnessAdapter({ command: [process.execPath, '-e', codexSidecarScript], active: true });
    try {
      const probeThread = await cursorProbe.startThread({ taskId: 'task-cursor', sessionId: 'session-cursor' });
      await cursorProbe.resume(probeThread.threadId, undefined, 17);
      const probeEvents = [];
      for await (const event of cursorProbe.subscribe(probeThread.threadId)) {
        probeEvents.push(event.sequence);
        if (event.kind === 'thread.resumed') break;
      }
      assert.deepEqual(probeEvents, [18]);
    } finally {
      cursorProbe.close();
    }
  } finally {
    adapter.close();
  }
});
