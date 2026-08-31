const hasHanCharacters = (value: string) => /[\u3400-\u9fff]/u.test(value);

/** Keep provider and protocol errors useful without exposing raw English UI copy. */
export function userFacingError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message.trim() : typeof error === 'string' ? error.trim() : '';
  if (!message) return fallback;
  if (hasHanCharacters(message)) return message;
  const httpStatus = message.match(/\b(?:HTTP\s*)?(\d{3})\b/iu)?.[1];
  return httpStatus ? `${fallback}（HTTP ${httpStatus}）` : fallback;
}
