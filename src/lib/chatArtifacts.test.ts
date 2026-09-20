import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactFileName, artifactKindForFile, artifactKindForLanguage, hasClosedArtifactFence, inferRawArtifactKind, rawArtifactKindAtStart, secureArtifactDocument } from './chatArtifacts.js';

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

test('streamed preview waits for the matching parsed code fence, not a code fragment or a different marker', () => {
  const ready = (block: string) => {
    const source = `Intro\n\n${block}\n\nMore text`;
    return hasClosedArtifactFence(source, { start: { offset: 7 }, end: { offset: 7 + block.length } });
  };
  for (const block of ['```html\n<p>ok</p>\n```', '~~~~svg\r\n<svg/>\r\n~~~~~  ', '   ```html\n<p>ok</p>\n   ```', '```html\n> <p>ok</p>\n> ```']) assert.equal(ready(block), true, block);
  for (const block of ['```html\n', '```html\n<p>ok', '````html\n<p>ok</p>\n```', '```html\n<p>ok</p>\n~~~', '```html\n<p>ok</p>\n``` more', '```html\n<p>ok</p>\n    ```', '```html\n<p>```</p>']) assert.equal(ready(block), false, block);
  assert.equal(hasClosedArtifactFence('```html\n<p/>\n```'), false, 'Unknown source positions should not execute a partial streaming block');
  const nested = '- outer\n  - inner\n\n    ```html\n    <p>ok</p>\n    ```';
  assert.equal(hasClosedArtifactFence(nested, { start: { offset: nested.indexOf('```') }, end: { offset: nested.length } }, '<p>ok</p>'), true);
  const indentedFake = '```html\n<p>ok</p>\n    ```';
  assert.equal(hasClosedArtifactFence(indentedFake, { start: { offset: 0 }, end: { offset: indentedFake.length } }, '<p>ok</p>\n    ```'), false);
});

test('raw document streams are recognized without requiring a finished document', () => {
  assert.equal(rawArtifactKindAtStart('<!DOCTYPE html>\r\n<html><body>'), 'html');
  assert.equal(rawArtifactKindAtStart('  <svg viewBox="0 0 20 20"><circle'), 'svg');
  assert.equal(rawArtifactKindAtStart('Create an <svg>'), null);
  assert.equal(rawArtifactKindAtStart('```html\n<html>'), null);
  assert.equal(rawArtifactKindAtStart('<htmlish>'), null);
});
