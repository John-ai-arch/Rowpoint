// Integrations & devices (vision #12). Honestly lists the wearable/health
// platforms the architecture is ready to accept — none are wired yet, so each
// is marked "Planned". The clean WearableSource seam (integrations/wearables.js)
// means adding one is an adapter, not a rewrite.
import { esc } from '../api.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { WEARABLE_PROVIDERS, listWearableSources } from '../integrations/wearables.js';

export async function renderIntegrations(el) {
  const live = new Set(listWearableSources().map(s => s.id)); // future: registered adapters
  el.innerHTML = `
    <header class="mb"><div class="page-head"><p class="eyebrow">${icon('link', { size: 14 })} Integrations</p><h1>${esc(t('integrations.title'))}</h1></div>
      <p class="muted">${esc(t('integrations.subtitle'))}</p></header>
    <div class="notice mb">${esc(t('integrations.note'))}</div>
    <div class="card">
      ${WEARABLE_PROVIDERS.map(p => {
    const connected = live.has(p.id);
    return `<div class="list-item">
      <div class="li-icon">${icon(p.icon, { size: 21 })}</div>
      <div class="li-body">
        <strong>${esc(p.name)}</strong>
        <div class="muted small">${p.capabilities.map(esc).join(' · ')}</div>
      </div>
      <span class="badge ${connected ? 'good' : ''}">${connected ? esc(t('integrations.connected')) : esc(t('integrations.planned'))}</span>
    </div>`;
  }).join('')}
    </div>
    <p class="muted small">${esc(t('integrations.bleNote'))}</p>`;
}
