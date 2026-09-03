import assert from 'node:assert/strict';
import test from 'node:test';
import { graphVirtualWindow, shouldReduceGraphMotion } from './graphRuntime';

test('graph motion follows accessibility and low-power runtime signals', () => {
  assert.equal(shouldReduceGraphMotion({ prefersReducedMotion: true, hardwareConcurrency: 16 }), true);
  assert.equal(shouldReduceGraphMotion({ prefersReducedMotion: false, saveData: true }), true);
  assert.equal(shouldReduceGraphMotion({ prefersReducedMotion: false, hardwareConcurrency: 4 }), true);
  assert.equal(shouldReduceGraphMotion({ prefersReducedMotion: false, hardwareConcurrency: 12, deviceMemory: 4 }), true);
  assert.equal(shouldReduceGraphMotion({ prefersReducedMotion: false, hardwareConcurrency: 12, deviceMemory: 16 }), false);
});

test('event virtualization keeps a bounded window with stable spacers', () => {
  assert.deepEqual(graphVirtualWindow(500, 4_000, 240, 40, 3), {
    start: 97,
    end: 109,
    paddingTop: 3_880,
    paddingBottom: 15_640,
  });
  assert.deepEqual(graphVirtualWindow(3, -20, 0, 40, 5), {
    start: 0,
    end: 3,
    paddingTop: 0,
    paddingBottom: 0,
  });
});
