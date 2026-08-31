import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type WebhookSignatureInput = {
  timestamp: string;
  idempotencyKey: string;
  tenantId: string;
  userId: string;
  rawBody: string;
};

export type WebhookVerificationResult =
  | { ok: true; idempotencyKey: string; timestampSeconds: number }
  | { ok: false; status: 400 | 401; error: string };

const deliveryKeyPattern = /^[A-Za-z0-9._:-]{8,160}$/;

const canonicalPayload = (input: WebhookSignatureInput) => [
  'v1',
  input.timestamp,
  input.idempotencyKey,
  input.tenantId,
  input.userId,
  input.rawBody,
].join('\n');

export const signWebhookPayload = (input: WebhookSignatureInput, secret: string) =>
  `v1=${createHmac('sha256', secret).update(canonicalPayload(input)).digest('hex')}`;

const configuredTolerance = () => {
  const parsed = Number(process.env.AXIOM_WEBHOOK_TOLERANCE_SECONDS ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS);
  return Number.isFinite(parsed) ? Math.min(3_600, Math.max(30, Math.floor(parsed))) : DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
};

export const verifyWebhookRequest = (
  headers: Headers,
  rawBody: string,
  secret: string,
  identity: { tenantId: string; userId: string },
  nowMs = Date.now(),
): WebhookVerificationResult => {
  const timestamp = headers.get('x-axiom-webhook-timestamp')?.trim() ?? '';
  const suppliedSignature = headers.get('x-axiom-webhook-signature')?.trim() ?? '';
  const idempotencyKey = headers.get('idempotency-key')?.trim() ?? '';

  if (!deliveryKeyPattern.test(idempotencyKey)) {
    return { ok: false, status: 400, error: 'Webhook Idempotency-Key must be 8-160 URL-safe characters.' };
  }
  if (!/^\d{10}$/.test(timestamp)) {
    return { ok: false, status: 401, error: 'Webhook timestamp is missing or invalid.' };
  }
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (Math.abs(nowSeconds - timestampSeconds) > configuredTolerance()) {
    return { ok: false, status: 401, error: 'Webhook timestamp is outside the allowed replay window.' };
  }
  const signatureMatch = /^v1=([0-9a-f]{64})$/i.exec(suppliedSignature);
  if (!signatureMatch) {
    return { ok: false, status: 401, error: 'Webhook signature is missing or invalid.' };
  }
  const expected = signWebhookPayload({ timestamp, idempotencyKey, tenantId: identity.tenantId, userId: identity.userId, rawBody }, secret).slice(3);
  const suppliedBytes = Buffer.from(signatureMatch[1]!, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    return { ok: false, status: 401, error: 'Webhook signature verification failed.' };
  }
  return { ok: true, idempotencyKey, timestampSeconds };
};
