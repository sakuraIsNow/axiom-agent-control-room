import { createHmac, timingSafeEqual } from 'node:crypto';

export type PrincipalClaims = {
  tenantId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  expiresAt?: number;
};

const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const decode = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const signature = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export const signPrincipal = (claims: PrincipalClaims, secret = process.env.AXIOM_PRINCIPAL_SECRET ?? '') => {
  if (!secret) throw new Error('AXIOM_PRINCIPAL_SECRET is required to sign a principal.');
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${signature(payload, secret)}`;
};

export const verifyPrincipal = (headers: Headers, secret = process.env.AXIOM_PRINCIPAL_SECRET ?? ''): PrincipalClaims | null => {
  if (!secret) return null;
  const token = headers.get('x-axiom-principal')?.trim() ?? '';
  const supplied = headers.get('x-axiom-principal-signature')?.trim() ?? '';
  if (!token || !supplied) return null;
  const expected = signature(token, secret);
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) return null;
  try {
    const claims = JSON.parse(decode(token)) as PrincipalClaims;
    if (!claims.tenantId || !claims.userId || !['owner', 'admin', 'member', 'viewer'].includes(claims.role)) return null;
    if (claims.expiresAt && claims.expiresAt < Math.floor(Date.now() / 1_000)) return null;
    return {
      tenantId: claims.tenantId.slice(0, 120),
      userId: claims.userId.slice(0, 120),
      role: claims.role,
      ...(claims.expiresAt ? { expiresAt: claims.expiresAt } : {}),
    };
  } catch {
    return null;
  }
};
