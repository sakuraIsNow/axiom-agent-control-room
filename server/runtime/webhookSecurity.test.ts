import assert from 'node:assert/strict';
import test from 'node:test';
import { signWebhookPayload, verifyWebhookRequest } from './webhookSecurity.js';

const secret = 'test-webhook-secret';
const nowMs = Date.UTC(2026, 7, 29, 2, 30, 0);
const timestamp = String(Math.floor(nowMs / 1_000));
const rawBody = JSON.stringify({ sessionId: 'session-1', input: '执行巡检', mode: 'analyze' });
const identity = { tenantId: 'tenant-a', userId: 'operator-a' };
const idempotencyKey = 'delivery-20260829-001';

const signedHeaders = (body = rawBody, timestampValue = timestamp) => {
  const headers = new Headers({
    'x-axiom-webhook-timestamp': timestampValue,
    'idempotency-key': idempotencyKey,
  });
  headers.set('x-axiom-webhook-signature', signWebhookPayload({
    timestamp: timestampValue,
    idempotencyKey,
    tenantId: identity.tenantId,
    userId: identity.userId,
    rawBody: body,
  }, secret));
  return headers;
};

test('accepts a current webhook with an authentic body and delivery identity', () => {
  assert.deepEqual(verifyWebhookRequest(signedHeaders(), rawBody, secret, identity, nowMs), {
    ok: true,
    idempotencyKey,
    timestampSeconds: Number(timestamp),
  });
});

test('rejects payload, tenant, and delivery-key tampering', () => {
  assert.equal(verifyWebhookRequest(signedHeaders(), `${rawBody} `, secret, identity, nowMs).ok, false);
  assert.equal(verifyWebhookRequest(signedHeaders(), rawBody, secret, { ...identity, tenantId: 'tenant-b' }, nowMs).ok, false);
  const changedDelivery = signedHeaders();
  changedDelivery.set('idempotency-key', 'delivery-20260829-002');
  assert.equal(verifyWebhookRequest(changedDelivery, rawBody, secret, identity, nowMs).ok, false);
});

test('rejects stale, future, malformed, and unsigned webhook requests', () => {
  const staleTimestamp = String(Number(timestamp) - 301);
  const futureTimestamp = String(Number(timestamp) + 301);
  const stale = verifyWebhookRequest(signedHeaders(rawBody, staleTimestamp), rawBody, secret, identity, nowMs);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /replay window/);
  assert.equal(verifyWebhookRequest(signedHeaders(rawBody, futureTimestamp), rawBody, secret, identity, nowMs).ok, false);
  assert.equal(verifyWebhookRequest(new Headers({ 'idempotency-key': idempotencyKey }), rawBody, secret, identity, nowMs).ok, false);
  const malformed = verifyWebhookRequest(new Headers({
    'x-axiom-webhook-timestamp': timestamp,
    'x-axiom-webhook-signature': 'v1=invalid',
    'idempotency-key': 'short',
  }), rawBody, secret, identity, nowMs);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.status, 400);
});
