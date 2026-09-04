import assert from 'node:assert/strict';
import test from 'node:test';
import { frontendCacheControl } from './frontendCache.js';

test('frontend cache policy keeps entrypoints fresh and hashed assets immutable', () => {
  assert.equal(frontendCacheControl('dist/index.html'), 'no-cache');
  assert.equal(frontendCacheControl('dist/favicon.svg'), 'no-cache');
  assert.equal(frontendCacheControl('dist/assets/index-AbC123.js'), 'public, max-age=31536000, immutable');
  assert.equal(frontendCacheControl('dist\\assets\\index-AbC123.css'), 'public, max-age=31536000, immutable');
});
