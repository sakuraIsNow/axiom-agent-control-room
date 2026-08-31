import test from 'node:test';
import assert from 'node:assert/strict';
import { isDevelopmentLoopbackOrigin, isOriginAllowed } from './originPolicy.js';

test('allows development loopback origins on dynamic ports', () => {
  assert.equal(isDevelopmentLoopbackOrigin('http://localhost:4302', 'development'), true);
  assert.equal(isDevelopmentLoopbackOrigin('http://127.0.0.1:5173', 'development'), true);
  assert.equal(isDevelopmentLoopbackOrigin('http://[::1]:4300', 'development'), true);
  assert.equal(isDevelopmentLoopbackOrigin('https://evil.example.com', 'development'), false);
});

test('keeps production origins explicit and rejects untrusted origins', () => {
  const allowed = new Set(['https://console.example.com']);
  assert.equal(isOriginAllowed(undefined, allowed, 'production'), true);
  assert.equal(isOriginAllowed('https://console.example.com', allowed, 'production'), true);
  assert.equal(isOriginAllowed('http://127.0.0.1:4302', allowed, 'production'), false);
  assert.equal(isOriginAllowed('https://evil.example.com', allowed, 'production'), false);
  assert.equal(isOriginAllowed('https://evil.example.com', new Set(), 'production'), false);
});
