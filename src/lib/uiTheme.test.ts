import assert from 'node:assert/strict';
import test from 'node:test';
import { getUiTheme } from './uiTheme';

const channels = (hex: string) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));

test('deep gray theme keeps the interface and 3D scene dark with a visible signal color', () => {
  const theme = getUiTheme('ivory');
  assert.equal(theme.label, '深灰绿');
  assert.ok(Math.max(...channels(theme.scene.background)) < 64);
  assert.ok(Math.max(...channels(theme.scene.fog)) < 64);
  assert.notEqual(theme.scene.signal, theme.scene.background);
  assert.deepEqual(theme.swatches, ['#15191d', '#68747c', '#95e4ba']);
});
