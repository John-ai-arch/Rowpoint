// Bluetooth support messaging — composes a professional, translated explainer
// from the structured detection in sensors.js. Browser-only module (imports
// i18n); never loaded by the Node unit tests.
import { bluetoothSupportInfo, bluetoothAvailability } from './sensors.js';
import { t } from '../i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export { bluetoothSupportInfo, bluetoothAvailability };

/**
 * A polished, honest "Bluetooth isn't available here" card explaining the
 * exact limitation of the current browser and offering the simulator as a
 * fully-featured fallback. Returns HTML (already escaped/translated).
 * @param {object} [opts] { simulatorHref?: string, showSimulator?: boolean }
 */
export function bluetoothHelpHtml({ showSimulator = true } = {}) {
  const info = bluetoothSupportInfo();
  const lines = [t('ble.unsupportedBody')];
  if (info.browser === 'ios') lines.push(t('ble.unsupportedApple'));
  else if (info.browser === 'apple') lines.push(t('ble.unsupportedApple'), t('ble.unsupportedChrome'));
  else if (info.browser === 'firefox') lines.push(t('ble.unsupportedFirefox'));
  else lines.push(t('ble.unsupportedChrome'));
  if (!info.secure) lines.push(t('ble.unsupportedHttps'));

  return `<div class="notice warn" role="alert">
    <strong>${esc(t('ble.unsupportedTitle'))}</strong>
    ${lines.map(l => `<p style="margin:8px 0 0">${esc(l)}</p>`).join('')}
    ${showSimulator ? `<p class="muted small" style="margin-top:10px">${esc(t('ble.trySimulator'))} ↓</p>` : ''}
  </div>`;
}
