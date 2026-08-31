import { randomBytes } from 'node:crypto';

export type TraceContext = {
  traceId: string;
  spanId: string;
  traceparent: string;
};

const traceparentPattern = /^00-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i;

/**
 * Continue a valid W3C traceparent or start a new trace at the API boundary.
 * Invalid/malformed client values are ignored so they cannot poison logs.
 */
export const resolveTraceContext = (headers: Headers): TraceContext => {
  const incoming = headers.get('traceparent')?.trim() ?? '';
  const match = traceparentPattern.exec(incoming);
  const traceId = match?.[1]?.toLowerCase() ?? randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const flags = match?.[3]?.toLowerCase() ?? '01';
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-${flags}` };
};

