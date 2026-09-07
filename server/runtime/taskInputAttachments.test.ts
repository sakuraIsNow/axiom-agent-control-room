import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactStore } from './artifactStore.js';
import { loadTaskInputAttachments, persistTaskInputAttachments } from './taskInputAttachments.js';

test('mixed exact-turn image and document bytes remain available after reopening storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-conversation-input-'));
  try {
    const owner = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'conversation-1' };
    const store = new FileArtifactStore(directory);
    const image = Buffer.from('fixture-image-bytes');
    const document = Buffer.from('A documented requirement: retain source IDs.');
    const snapshots = await persistTaskInputAttachments({ messageId: 'current-user-turn', attachments: [
      { id: 'image-1', kind: 'image', name: 'diagram.png', url: `data:image/png;base64,${image.toString('base64')}` },
      { id: 'document-1', kind: 'file', name: 'requirements.txt', dataUrl: `data:text/plain;base64,${document.toString('base64')}` },
    ] }, owner, store);
    const loaded = await loadTaskInputAttachments(JSON.parse(JSON.stringify(snapshots)), owner, new FileArtifactStore(directory));
    assert.deepEqual(loaded.map((item) => Buffer.from(item.content)), [image, document]);
    assert.deepEqual(loaded.map((item) => item.sourceMessageId), ['current-user-turn', 'current-user-turn']);
    await assert.rejects(loadTaskInputAttachments(snapshots, { ...owner, userId: 'other-user' }, store), /task owner/);
    await assert.rejects(loadTaskInputAttachments(snapshots, { ...owner, tenantId: 'other-tenant' }, store), /task owner/);
    await store.putBinary(snapshots[0]!.artifactId, Buffer.from('changed'), owner.tenantId);
    await assert.rejects(loadTaskInputAttachments(snapshots, owner, store), /digest check/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('attachment loading never infers a latest session file or fetches a remote URL', async () => {
  assert.deepEqual(await loadTaskInputAttachments(undefined, { tenantId: 'tenant', userId: 'user' }, undefined), []);
  const directory = await mkdtemp(join(tmpdir(), 'axiom-conversation-source-'));
  try {
    const owner = { tenantId: 'tenant', userId: 'user', sessionId: 'session' };
    const store = new FileArtifactStore(directory);
    await assert.rejects(persistTaskInputAttachments({ messageId: 'u1', attachments: [{ id: 'file', url: 'https://example.com/file.pdf' }] }, owner, store), /inline bytes/);
    await assert.rejects(persistTaskInputAttachments({ messageId: 'u1', attachments: [{ id: 'missing', name: 'lost.pdf' }] }, owner, store), /empty/);
    const snapshots = await persistTaskInputAttachments({ messageId: 'u1', attachments: [{ id: 'restored', name: 'report.pdf', kind: 'file', text: 'Previously extracted report content.' }] }, owner, store);
    assert.equal(snapshots[0]?.mimeType, 'text/plain');
    assert.equal(snapshots[0]?.name, 'report.pdf.extracted.txt');
    assert.equal(Buffer.from((await loadTaskInputAttachments(snapshots, owner, store))[0]!.content).toString('utf8'), 'Previously extracted report content.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
