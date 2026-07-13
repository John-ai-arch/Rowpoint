// §2.2 — Teams list: coached teams (with code management) + joined teams.
import { api, state, toast, esc } from '../api.js';
import { icon } from '../icons.js';

export async function renderTeams(el) {
  if (!state.user.emailVerified) {
    el.innerHTML = `<h1>Teams</h1><div class="notice warn">Verify your email to create or join teams.</div>`;
    return;
  }
  el.innerHTML = `<h1>Teams</h1><p class="muted">Loading…</p>`;
  const { coached, joined } = await api('/teams');

  el.innerHTML = `<div class="page-head"><h1>Teams</h1></div>
    ${coached.length ? `
    <div class="section-head"><span class="icon-chip">${icon('flag')}</span><div class="titles"><h2>Teams you coach</h2></div></div>
    ${coached.map(t => `
      <div class="card tight">
        <div class="row between">
          <div class="row" style="gap:11px"><span class="li-icon accent">${icon('users', { size: 20 })}</span>
            <div><strong>${esc(t.name)}</strong><div class="muted small">${t.memberCount} rower${t.memberCount === 1 ? '' : 's'}</div></div></div>
          <a class="btn sm" href="#/team/${t.id}">Open</a>
        </div>
        <div class="row mt">
          <span class="badge blue" style="font-size:1rem;letter-spacing:2px">${esc(t.code)}</span>
          <button class="ghost sm" data-copy="${esc(t.code)}">${icon('link', { size: 15 })} Copy code</button>
          <button class="ghost sm" data-regen="${t.id}">${icon('refresh', { size: 15 })} Regenerate</button>
        </div>
        <p class="muted small">Share this code with rowers to let them join. Regenerate it if it leaks — old codes stop working instantly.</p>
      </div>`).join('')}` : ''}

    ${joined.length ? `
    <div class="section-head"><span class="icon-chip">${icon('users')}</span><div class="titles"><h2>Teams you row for</h2></div></div>
    ${joined.map(t => `
      <div class="card tight list-item">
        <span class="li-icon">${icon('flag', { size: 20 })}</span>
        <div class="li-body"><strong>${esc(t.name)}</strong><div class="muted small">Coach: ${esc(t.coachName)}</div></div>
        <a class="btn sm secondary" href="#/team/${t.id}">Open</a>
        <button class="ghost sm" data-leave="${t.id}">Leave</button>
      </div>`).join('')}` : ''}

    <div class="section-head"><span class="icon-chip">${icon('plus')}</span><div class="titles"><h2>Join a team</h2></div></div>
    <div class="card">
      <div class="row">
        <input id="joinCode" placeholder="Team code (e.g. KX7M2PQ)" style="flex:1;text-transform:uppercase">
        <button id="joinBtn">Join</button>
      </div>
      <p class="muted small">You can row for several teams at once — each coach only sees what your privacy settings allow.</p>
    </div>`;

  el.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast('Code copied.'); });
  el.querySelectorAll('[data-regen]').forEach(b => b.onclick = async () => {
    const { code } = await api(`/teams/${b.dataset.regen}/regenerate-code`, { method: 'POST' });
    toast(`New code: ${code}`, 'success'); renderTeams(el);
  });
  el.querySelectorAll('[data-leave]').forEach(b => b.onclick = async () => {
    try { await api(`/teams/${b.dataset.leave}/leave`, { method: 'POST' }); toast('Left team.'); renderTeams(el); }
    catch (e) { toast(e.message, 'error'); }
  });
  el.querySelector('#joinBtn')?.addEventListener('click', async () => {
    try {
      const { team } = await api('/teams/join', { method: 'POST', body: { code: el.querySelector('#joinCode').value } });
      toast(`Joined ${team.name}!`, 'success'); renderTeams(el);
    } catch (e) { toast(e.message, 'error'); }
  });
}
