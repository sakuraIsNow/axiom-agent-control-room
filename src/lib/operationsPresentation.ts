import type { OperationsAlert } from '../types';
import { translateUiText, type UiLanguage } from './uiLanguage';

export function operationsAlertDetail(alert: Pick<OperationsAlert, 'id' | 'source' | 'detail'>, language: UiLanguage): string {
  if (language !== 'en' || alert.source !== 'readiness' || !['readiness-blocked', 'readiness-degraded'].includes(alert.id)) return alert.detail;
  // The readiness producer joins its platform check labels with this delimiter.
  return alert.detail.split('；').map((label) => translateUiText(label, language)).join('; ');
}
