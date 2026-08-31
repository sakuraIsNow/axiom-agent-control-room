export type ChatArtifactKind = 'markdown' | 'svg' | 'html';

const languageAliases: Record<string, ChatArtifactKind> = {
  md: 'markdown',
  markdown: 'markdown',
  svg: 'svg',
  html: 'html',
  htm: 'html',
};

export const artifactKindForLanguage = (language?: string | null) => language
  ? languageAliases[language.trim().toLowerCase()] ?? null
  : null;

export const artifactKindForFile = (name: string, mimeType = ''): ChatArtifactKind | null => {
  const normalizedName = name.toLowerCase();
  const normalizedMime = mimeType.toLowerCase();
  if (/\.(?:md|markdown)$/i.test(normalizedName) || normalizedMime === 'text/markdown') return 'markdown';
  if (/\.svg$/i.test(normalizedName) || normalizedMime === 'image/svg+xml') return 'svg';
  if (/\.(?:html|htm)$/i.test(normalizedName) || normalizedMime === 'text/html') return 'html';
  return null;
};

export const inferRawArtifactKind = (content: string): ChatArtifactKind | null => {
  const normalized = content.trim();
  if (/^<svg\b[\s\S]*<\/svg>\s*$/i.test(normalized)) return 'svg';
  if (/^(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*<\/html>\s*$/i.test(normalized)) return 'html';
  return null;
};

export const artifactFileName = (name: string, kind: ChatArtifactKind) => {
  const extension = kind === 'markdown' ? 'md' : kind;
  const base = name.replace(/\.(?:md|markdown|svg|html|htm)$/i, '').replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'axiom-artifact';
  return `${base}.${extension}`;
};

const csp = (kind: 'svg' | 'html') => kind === 'html'
  ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  : "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

export const secureArtifactDocument = (content: string, kind: 'svg' | 'html') => {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp(kind))}">`;
  if (kind === 'html') {
    if (/<head(?:\s[^>]*)?>/i.test(content)) return content.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policy}`);
    if (/<html(?:\s[^>]*)?>/i.test(content)) return content.replace(/<html(?:\s[^>]*)?>/i, (html) => `${html}<head>${policy}</head>`);
    return `<!doctype html><html><head>${policy}</head><body>${content}</body></html>`;
  }
  return `<!doctype html><html><head>${policy}<style>html,body{width:100%;height:100%;margin:0;overflow:auto;background:transparent}body{display:grid;place-items:center;padding:18px;box-sizing:border-box}svg{display:block;max-width:100%;max-height:100%;height:auto}</style></head><body>${content}</body></html>`;
};

export const artifactMimeType = (kind: ChatArtifactKind) => kind === 'markdown'
  ? 'text/markdown;charset=utf-8'
  : kind === 'svg'
    ? 'image/svg+xml;charset=utf-8'
    : 'text/html;charset=utf-8';
