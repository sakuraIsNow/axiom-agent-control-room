import { createHmac } from 'node:crypto';

const secret = process.env.AXIOM_PRINCIPAL_SECRET;
if (!secret) throw new Error('Set AXIOM_PRINCIPAL_SECRET first.');
const claims = {
  tenantId: process.env.AXIOM_TENANT_ID ?? 'local',
  userId: process.env.AXIOM_USER_ID ?? 'local-user',
  role: process.env.AXIOM_ROLE ?? 'admin',
  expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
};
const principal = Buffer.from(JSON.stringify(claims)).toString('base64url');
const signature = createHmac('sha256', secret).update(principal).digest('base64url');
console.log(JSON.stringify({ claims, headers: { 'x-axiom-principal': principal, 'x-axiom-principal-signature': signature } }, null, 2));
