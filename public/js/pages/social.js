// §4 — Social: exact-email search, connection requests, groups.
import { api, state, toast, esc } from '../api.js';
import { icon } from '../icons.js';
import { confirmDialog, promptDialog } from '../components/dialog.js';

export async function renderSocial(el, opts = {}) {
  const { embedded = false } = opts;
  // Embedded in the Community hub, the seg control supplies the heading.
  const head = embedded ? '' : `<div class="page-head"><h1>Social</h1></div>`;
  if (!state.user.emailVerified) {
    el.innerHTML = `${head}<div class="notice warn">Verify your email to connect with other rowers.</div>`;
    return;
  }
  el.innerHTML = `${head}<p class="muted">Loading…</p>`;
  const [{ connections, incoming, outgoing }, { groups }] = await Promise.all([
    api('/social/connections'), api('/groups/mine'),
  ]);

  el.innerHTML = `${head}
    <div class="card">
      <div class="card-head"><span class="icon-chip sm">${icon('search', { size: 18 })}</span><h3>Find someone by email</h3></div>
      <div class="row"><input id="q" type="email" placeholder="their exact email address" style="flex:1"><button id="searchBtn">${icon('search', { size: 16 })} Search</button></div>
      <p class="muted small">Exact email match only — there's no name browsing, and lookups are rate-limited, so nobody can trawl the member list.</p>
      <div id="searchResult"></div>
    </div>

    ${incoming.length ? `<div class="card"><div class="card-head"><span class="icon-chip sm">${icon('bell', { size: 18 })}</span><h3>Requests for you</h3></div>
      ${incoming.map(p => `<div class="list-item"><div class="avatar">${esc(p.displayName[0])}</div>
        <div class="li-body"><strong>${esc(p.displayName)}</strong></div>
        <button class="sm" data-acc="${p.connectionId}">Accept</button>
        <button class="ghost sm" data-dec="${p.connectionId}">Decline</button></div>`).join('')}</div>` : ''}

    <div class="card"><div class="card-head"><span class="icon-chip sm">${icon('users', { size: 18 })}</span><h3>Connections (${connections.length})</h3></div>
      ${connections.length ? connections.map(p => `<div class="list-item"><div class="avatar">${esc(p.displayName[0])}</div>
        <div class="li-body"><strong>${esc(p.displayName)}</strong></div>
        <button class="ghost sm" data-rm="${p.id}">Remove</button>
        <button class="ghost sm" data-rep="${p.id}">Report</button>
        <button class="ghost sm" data-blk="${p.id}">Block</button></div>`).join('')
    : '<p class="muted small">No connections yet.</p>'}
      ${outgoing.length ? `<p class="muted small">${outgoing.length} request${outgoing.length > 1 ? 's' : ''} pending: ${outgoing.map(o => esc(o.displayName)).join(', ')}</p>` : ''}
    </div>

    <div class="card">
      <div class="card-head"><span class="icon-chip sm">${icon('users', { size: 18 })}</span><h3>Groups</h3><button class="sm card-head-action" id="newGroup">${icon('plus', { size: 15 })} New group</button></div>
      ${groups.length ? groups.map(g => `<a class="list-item" style="color:inherit" href="#/group/${g.id}">
        <div class="avatar">${g.photoUrl ? `<img src="${esc(g.photoUrl)}" style="width:100%;height:100%;border-radius:inherit;object-fit:cover">` : icon('users', { size: 22 })}</div>
        <div style="flex:1"><strong>${esc(g.name)}</strong>
          ${g.role !== 'member' ? `<span class="badge blue">${esc(g.role)}</span>` : ''}
        <div class="muted small">${g.memberCount} member${g.memberCount === 1 ? '' : 's'} · ${esc(g.privacy)}${g.muted ? ' · muted' : ''}</div></div></a>`).join('')
    : '<p class="muted small">Groups bring leaderboards, challenges, team goals, chat, and achievements to friends, clubs, and schools training together.</p>'}
      <div id="newGroupForm"></div>
      <div class="row mt"><input id="joinCode" placeholder="Have an invite code? e.g. G7K2M4XQ" style="flex:1"><button class="sm secondary" id="joinByCode">Join</button></div>
    </div>

    <div class="card">
      <div class="card-head"><span class="icon-chip sm">${icon('globe', { size: 18 })}</span><h3>Discover groups</h3></div>
      <p class="muted small">Search by team name, school, university, club, city, region, or country.</p>
      <div class="row" style="flex-wrap:wrap;gap:6px">
        <input id="dq" placeholder="Name / school / club…" style="flex:2;min-width:140px">
        <input id="dCity" placeholder="City" style="width:110px">
        <input id="dCountry" placeholder="Country" style="width:110px">
        <button class="sm" id="discoverBtn">Search</button>
      </div>
      <div id="discoverOut"></div>
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
    toast('Connected!', 'success'); renderSocial(el, opts);
  });
  el.querySelectorAll('[data-dec]').forEach(b => b.onclick = async () => {
    await api(`/social/connections/${b.dataset.dec}/respond`, { method: 'POST', body: { accept: false } });
    renderSocial(el, opts);
  });
  el.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    await api(`/social/connections/${b.dataset.rm}`, { method: 'DELETE' });
    toast('Connection removed.'); renderSocial(el, opts);
  });
  el.querySelectorAll('[data-blk]').forEach(b => b.onclick = async () => {
    if (!(await confirmDialog('Block this user? They won\'t be able to find or contact you.', { title: 'Block user', confirmText: 'Block', danger: true }))) return;
    await api('/social/block', { method: 'POST', body: { userId: b.dataset.blk } });
    toast('Blocked.'); renderSocial(el, opts);
  });
  el.querySelectorAll('[data-rep]').forEach(b => b.onclick = async () => {
    const reason = await promptDialog('What\'s wrong? (e.g. harassment, spam)', { title: 'Report user', confirmText: 'Send report', multiline: true });
    if (!reason) return;
    await api('/social/report', { method: 'POST', body: { userId: b.dataset.rep, reason } });
    toast('Report sent to the moderation team.', 'success');
  });

  el.querySelector('#newGroup').onclick = () => {
    const form = el.querySelector('#newGroupForm');
    if (form.innerHTML) { form.innerHTML = ''; return; }
    form.innerHTML = `<div class="notice mt">
      <label class="field"><span>Group name</span><input id="gName" placeholder="Riverside Rowing Club"></label>
      <label class="field"><span>Description (optional)</span><input id="gDesc" placeholder="What is this group about?"></label>
      <div class="grid cols2">
        <label class="field"><span>Privacy</span>
          <select id="gPrivacy"><option value="private">Private — invite code / join requests</option><option value="public">Public — anyone can find & join</option></select></label>
        <label class="field"><span>School / university (optional)</span><input id="gSchool"></label>
        <label class="field"><span>Club (optional)</span><input id="gClub"></label>
        <label class="field"><span>City (optional)</span><input id="gCity"></label>
        <label class="field"><span>State/Province (optional)</span><input id="gRegion"></label>
        <label class="field"><span>Country (optional)</span><input id="gCountry"></label>
      </div>
      <button class="sm" id="gCreate">Create group</button>
    </div>`;
    form.querySelector('#gCreate').onclick = async () => {
      const v = (id) => form.querySelector(`#${id}`).value.trim();
      try {
        const { groupId } = await api('/groups', {
          method: 'POST',
          body: {
            name: v('gName'), description: v('gDesc'), privacy: v('gPrivacy'),
            school: v('gSchool'), club: v('gClub'), city: v('gCity'), region: v('gRegion'), country: v('gCountry'),
          },
        });
        toast('Group created — share the invite code from the group dashboard.', 'success');
        location.hash = `#/group/${groupId}`;
      } catch (e) { toast(e.message, 'error'); }
    };
  };

  el.querySelector('#joinByCode').onclick = async () => {
    const code = el.querySelector('#joinCode').value.trim();
    if (!code) return;
    try {
      const r = await api('/groups/join-by-code', { method: 'POST', body: { code } });
      toast(`Welcome to ${r.name}!`, 'success');
      location.hash = `#/group/${r.groupId}`;
    } catch (e) { toast(e.message, 'error', 6000); }
  };

  el.querySelector('#discoverBtn').onclick = async () => {
    const out = el.querySelector('#discoverOut');
    const p = new URLSearchParams();
    if (el.querySelector('#dq').value.trim()) p.set('q', el.querySelector('#dq').value.trim());
    if (el.querySelector('#dCity').value.trim()) p.set('city', el.querySelector('#dCity').value.trim());
    if (el.querySelector('#dCountry').value.trim()) p.set('country', el.querySelector('#dCountry').value.trim());
    try {
      const { groups: found } = await api(`/groups/discover?${p}`);
      out.innerHTML = found.length ? found.map(g => `
        <div class="list-item"><div class="avatar">${icon('users', { size: 22 })}</div>
          <div style="flex:1"><strong>${esc(g.name)}</strong> <span class="badge ${g.privacy === 'public' ? 'green' : 'gray'}">${esc(g.privacy)}</span>
            <div class="muted small">${g.memberCount} member${g.memberCount === 1 ? '' : 's'}
              ${[g.school, g.club, g.city, g.region, g.country].filter(Boolean).length ? ' · ' + [g.school, g.club, g.city, g.region, g.country].filter(Boolean).map(esc).join(', ') : ''}
              ${g.description ? `<br>${esc(g.description)}` : ''}</div></div>
          ${g.isMember ? '<a class="btn ghost sm" href="#/group/' + g.id + '">Open</a>'
      : g.pendingRequest ? '<span class="badge amber">request pending</span>'
        : g.privacy === 'public' ? `<button class="sm" data-join="${g.id}">Join</button>`
          : `<button class="sm secondary" data-reqjoin="${g.id}">Request to join</button>`}
        </div>`).join('') : '<p class="muted small mt">No groups match — create one!</p>';
      out.querySelectorAll('[data-join]').forEach(b => b.onclick = async () => {
        await api(`/groups/${b.dataset.join}/join`, { method: 'POST' });
        toast('Joined!', 'success'); location.hash = `#/group/${b.dataset.join}`;
      });
      out.querySelectorAll('[data-reqjoin]').forEach(b => b.onclick = async () => {
        const message = await promptDialog('Add a note for the group admins (optional):', { title: 'Request to join', confirmText: 'Send request' });
        if (message === null) return;
        await api(`/groups/${b.dataset.reqjoin}/join-request`, { method: 'POST', body: { message } });
        toast('Request sent — an admin will review it.', 'success');
        b.outerHTML = '<span class="badge amber">request pending</span>';
      });
    } catch (e) { out.innerHTML = `<p class="muted small mt">${esc(e.message)}</p>`; }
  };
}
