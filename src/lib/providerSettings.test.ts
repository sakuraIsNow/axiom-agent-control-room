import test from 'node:test';
import assert from 'node:assert/strict';
import { invalidateEditedCredentials, sameProviderFields } from './providerSettings';
import type { ProviderSettings } from '../types';

const settings = (): ProviderSettings => {
  const provider = { useCustom: true, credentialId: 'saved', apiUrl: 'https://original.example/v1', apiKey: '', model: 'original', location: 'internet' as const };
  return { text: { ...provider }, vision: { ...provider }, image: { ...provider }, video: { ...provider } };
};
test('editing a saved provider cannot keep the old credential or forward its secret to a new endpoint', () => {
  for (const kind of ['text', 'vision', 'image', 'video'] as const) {
    const previous = settings();
    for (const patch of [{ apiUrl: 'https://new.example/v1' }, { model: 'new-model' }, { apiKey: 'new-key' }, { location: 'local' as const }]) {
      const next = invalidateEditedCredentials(previous, { ...previous, [kind]: { ...previous[kind], ...patch } });
      assert.equal(next[kind].credentialId, undefined);
    }
  }
  const previous = settings();
  previous.text.apiKey = 'temporary-key';
  const next = invalidateEditedCredentials(previous, { ...previous, text: { ...previous.text, apiUrl: 'https://other.example' } });
  assert.equal(next.text.apiKey, '');
});
test('toggling custom mode keeps a saved credential, but late saves cannot overwrite edited fields', () => {
  const previous = settings();
  const next = invalidateEditedCredentials(previous, { ...previous, text: { ...previous.text, useCustom: false } });
  assert.equal(next.text.credentialId, 'saved');
  assert.equal(sameProviderFields(previous.text, { ...previous.text, model: 'edited-while-saving' }), false);
});
