export const isDevelopmentLoopbackOrigin = (origin: string, nodeEnv = process.env.NODE_ENV) => {
  if (nodeEnv === 'production') return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
};

export const isOriginAllowed = (
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  nodeEnv = process.env.NODE_ENV,
) => {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  return isDevelopmentLoopbackOrigin(origin, nodeEnv);
};
