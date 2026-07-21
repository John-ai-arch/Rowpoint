// Community hub — merges the former Teams and Social tabs into one place with
// a segmented control. The two existing full pages are embedded (their own
// page-heads suppressed) so no capability is lost; deep links to #/teams,
// #/social, #/team/:id, #/group/:id, #/live/:id all still work directly.
import { esc } from '../api.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { renderTeams } from './teams.js';
import { renderSocial } from './social.js';

export async function renderCommunity(el) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  let active = qs.get('tab') === 'social' ? 'social' : 'teams';

  el.innerHTML = `
    <div class="page-head"><h1>${esc(t('nav.community'))}</h1></div>
    <div class="seg" role="tablist" aria-label="${esc(t('nav.community'))}" style="width:100%;margin-bottom:4px">
      <button type="button" role="tab" data-ctab="teams">${icon('flag', { size: 16 })} ${esc(t('community.teams'))}</button>
      <button type="button" role="tab" data-ctab="social">${icon('users', { size: 16 })} ${esc(t('community.friends'))}</button>
    </div>
    <div id="cbody"></div>`;

  const body = el.querySelector('#cbody');
  let childCleanup = null;

  async function show(tab) {
    active = tab;
    if (typeof childCleanup === 'function') { try { childCleanup(); } catch { /* teardown */ } childCleanup = null; }
    el.querySelectorAll('[data-ctab]').forEach(b => {
      const on = b.dataset.ctab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // keep the address bar in sync so a refresh / share reopens the same tab
    const base = '#/community';
    const next = tab === 'social' ? `${base}?tab=social` : base;
    if (location.hash !== next) history.replaceState(null, '', next);
    body.innerHTML = '';
    const render = tab === 'social' ? renderSocial : renderTeams;
    childCleanup = await render(body, { embedded: true }) || null;
  }

  el.querySelectorAll('[data-ctab]').forEach(b => { b.onclick = () => show(b.dataset.ctab); });
  await show(active);

  return () => { if (typeof childCleanup === 'function') { try { childCleanup(); } catch { /* teardown */ } } };
}
