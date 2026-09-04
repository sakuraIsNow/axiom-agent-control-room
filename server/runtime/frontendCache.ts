const IMMUTABLE_ASSET_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'no-cache';

export const frontendCacheControl = (servedPath: string) => {
  const normalized = servedPath.replaceAll('\\', '/');
  return normalized.includes('/assets/') ? IMMUTABLE_ASSET_CACHE : REVALIDATE_CACHE;
};
