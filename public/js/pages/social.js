// §4 — Social: exact-email search, connection requests, groups.
import { api, state, toast, esc } from '../api.js';

export async function renderSocial(el) {
  if (!state.user.emailVerified) {
    el.innerHTML = `<h1>Social</h1><div class="notice warn">Verify your email to connect with other rowers.</div>`;
    return;
  }
  el.innerHTML = `<h1>Social</h1><p class="muted">Loading…</p>`;
  const [{ connections, incoming, outgoing }, { groups }] = await Promise.all([
    api('/social/connections'), api('/social/groups'),
  ]);

  el.innerHTML = `<h1>Social</h1>
    <div class="card">
      <h3>Find someone by email</h3>
      <div class="row"><input id="q" type="email" placeholder="their exact email address" style="flex:1"><button id="searchBtn">Search</button></div>
      <p class="muted small">Exact email match only — there's no name browsing, and lookups are rate-limited, so nobody can trawl the member list.</p>
      <div id="searchResult"></div>
    </div>

    ${incoming.length ? `<div class="card"><h3>Requests for you</h3>
      ${incoming.map(p => `<div class="list-item"><div class="avatar">${esc(p.displayName[0])}</div>
        <div style="flex:1"><strong>${esc(p.displayName)}</strong></div>
        <button class="sm" data-acc="${p.connectionId}">Accept</button>
        <button class="ghost sm" data-dec="${p.connectionId}">Decline</button></div>`).join('')}</div>` : ''}

    <div class="card"><h3>Connections (${connections.length})</h3>
      ${connections.length ? connections.map(p => `<div class="list-item"><div class="avatar">${esc(p.displayName[0])}</div>
        <div style="flex:1"><strong>${esc(p.displayName)}</strong></div>
        <button class="ghost sm" data-rm="${p.id}">Remove</button>
        <button class="ghost sm" data-rep="${p.id}">Report</button>
        <button class="ghost sm" data-blk="${p.id}">Block</button></div>`).join('')
    : '<p class="muted small">No connections yet.</p>'}
      ${outgoing.length ? `<p class="muted small">${outgoing.length} request${outgoing.length > 1 ? 's' : ''} pending: ${outgoing.map(o => esc(o.displayName)).join(', ')}</p>` : ''}
    </div>

    <div class="card">
      <div class="row between"><h3>Groups</h3><button class="sm" id="newGroup">+ New group</button></div>
      ${groups.length ? groups.map(g => `<a class="list-item" style="color:inherit" href="#/group/${g.id}">
        <div class="avatar">👥</div><div style="flex:1"><strong>${esc(g.name)}</strong>
        <div class="muted small">${g.memberCount} member${g.memberCount === 1 ? '' : 's'}${g.muted ? ' · muted' : ''}</div></div></a>`).join('')
    : '<p class="muted small">Groups are for friends training together — independent of any coach\'s team.</p>'}
    </div>`;

  el.querySelector('#searchBtn').onclick = async () => {
    const box = el.querySelector('#searchResult');
    try {
      const res = await api(`/social/search?email=${encodeURIComponent(el.querySelector('#q').value.trim())}`);
      if (!res.found) { box.innerHTML = '<p class="muted small mt">No RowPoint user with that exact email.</p>'; return; }
      const c = res.connection;
      box.innerHTML = `<div class="list-item mt"><div class="avatar">${esc(res.user.displayName[0])}</div>
        <div style="flex:1"><strong>${esc(res.user.displayName)}</strong> <span class="badge gray">${esc(res.user.accountType)}</span></div>
        ${!c ? `<button class="sm" id="reqBtn">Connect</button>`
    : c.status === 'accepted' ? '<span class="badge green">connected</span>'
      : c.requestedByMe ? '<span class="badge amber">request sent</span>' : '<span class="badge blue">they requested you</span>'}
      </div>`;
      box.querySelector('#reqBtn')?.addEventListener('click', async () => {
        await api('/social/connections/request', { method: 'POST', body: { userId: res.user.id } });
        toast('Request sent.', 'success');
        box.querySelector('#reqBtn').outerHTML = '<span class="badge amber">request sent</span>';
      });
    } catch (e) { box.innerHTML = `<p class="muted small mt">${esc(e.message)}</p>`; }
  };

  el.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => {
    await api(`/social/connections/${b.dataset.acc}/respond`, { method: 'POST', body: { accept: true } });
    toast('Connected!', 'success'); renderSocial(el);
  });
  el.querySelectorAll('[data-dec]').forEach(b => b.onclick = async () => {
    await api(`/social/connections/${b.dataset.dec}/respond`, { method: 'POST', body: { accept: false } });
    renderSocial(el);
  });
  el.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    await api(`/social/connections/${b.dataset.rm}`, { method: 'DELETE' });
    toast('Connection removed.'); renderSocial(el);
  });
  el.querySelectorAll('[data-blk]').forEach(b => b.onclick = async () => {
    if (!confirm('Block this user? They won\'t be able to find or contact you.')) return;
    await api('/social/block', { method: 'POST', body: { userId: b.dataset.blk } });
    toast('Blocked.'); renderSocial(el);
  });
  el.querySelectorAll('[data-rep]').forEach(b => b.onclick = async () => {
    const reason = prompt('What\'s wrong? (e.g. harassment, spam)');
    if (!reason) return;
    await api('/social/report', { method: 'POST', body: { userId: b.dataset.rep, reason } });
    toast('Report sent to the moderation team.', 'success');
  });

  el.querySelector('#newGroup').onclick = async () => {
    const name = prompt('Group name:');
    if (!name) return;
    try {
      const { groupId } = await api('/social/groups', { method: 'POST', body: { name, memberIds: [] } });
      toast('Group created — add connected friends from the group page.', 'success');
      location.hash = `#/group/${groupId}`;
    } catch (e) { toast(e.message, 'error'); }
  };
}
