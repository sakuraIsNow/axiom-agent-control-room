import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactFileName, artifactKindForFile, artifactKindForLanguage, inferRawArtifactKind, secureArtifactDocument } from './chatArtifacts.js';

test('chat artifacts recognize fenced and uploaded Markdown, SVG, and HTML', () => {
  assert.equal(artifactKindForLanguage('svg'), 'svg');
  assert.equal(artifactKindForLanguage('markdown'), 'markdown');
  assert.equal(artifactKindForFile('diagram.svg', 'image/svg+xml'), 'svg');
  assert.equal(artifactKindForFile('report.md', 'text/markdown'), 'markdown');
  assert.equal(artifactKindForFile('demo.html', 'text/html'), 'html');
  assert.equal(inferRawArtifactKind('<svg viewBox="0 0 10 10"></svg>'), 'svg');
  assert.equal(inferRawArtifactKind('<!doctype html><html><body>ok</body></html>'), 'html');
  assert.equal(artifactFileName('Agent diagram.svg', 'svg'), 'Agent-diagram.svg');
});

test('sandboxed artifact documents deny network access and same-origin privileges', () => {
  const html = secureArtifactDocument('<html><head></head><body><script>document.body.textContent="ok"</script></body></html>', 'html');
  const svg = secureArtifactDocument('<svg><circle r="4" /></svg>', 'svg');
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script-src 'unsafe-inline'/);
  assert.match(svg, /script-src 'none'/);
  assert.match(svg, /object-src 'none'/);
  assert.doesNotMatch(html, /allow-same-origin/);
});
