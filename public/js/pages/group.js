// §4 — Group detail: members' shared workouts/2k times (per individual
// privacy settings), activity feed, mute/leave/add.
import { api, state, toast, esc, fmtSplit, fmtDistance, fmtDuration, fmtDate, fmtDateTime } from '../api.js';

export async function renderGroup(el, groupId) {
  el.innerHTML = `<p class="muted">Loading…</p>`;
  let data;
  try { data = await api(`/social/groups/${groupId}`); }
  catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
  const { group, members, feed } = data;

  el.innerHTML = `
    <a href="#/social" class="small">← Social</a>
    <div class="row between"><h1>${esc(group.name)}</h1>
      <div class="row">
        <button class="ghost sm" id="addBtn">+ Add friend</button>
        <button class="ghost sm" id="muteBtn">Mute</button>
        <button class="ghost sm" id="leaveBtn">Leave</button>
      </div></div>

    <div class="card"><h3>Activity</h3>
      ${feed.length ? feed.map(f => {
    const p = f.payload || {};
    const who = esc(p.displayName || 'Someone');
    if (f.type === 'pb') return `<div class="list-item"><div class="avatar">🏆</div><div><strong>${who}</strong> set a new verified 2k PB: <strong>${fmtDuration(p.timeS)}</strong><div class="muted small">${fmtDateTime(f.createdAt)}</div></div></div>`;
    return `<div class="list-item"><div class="avatar">🚣</div><div><strong>${who}</strong> completed ${fmtDistance(p.distanceM)}, avg split ${esc(p.avgSplitText || fmtSplit(p.avgSplit))}<div class="muted small">${fmtDateTime(f.createdAt)}</div></div></div>`;
  }).join('') : '<p class="muted small">Quiet so far — finished workouts show up here automatically (for members who share them).</p>'}
    </div>

    <h3>Members</h3>
    ${members.map(m => `
      <div class="card tight">
        <div class="row between">
          <div class="row"><div class="avatar">${esc(m.displayName[0])}</div>
            <div><strong>${esc(m.displayName)}</strong> ${m.id === state.user.id ? '<span class="badge gray">you</span>' : ''}
              <div class="muted small">2k: ${m.best2kSeconds ? `${fmtDuration(m.best2kSeconds)}${m.best2kVerified ? ' ✓' : ''}` : 'not shared'}</div></div></div>
          ${m.id !== state.user.id ? `<button class="ghost sm" data-rep="${m.id}">Report</button>` : ''}
        </div>
        ${m.recent2ks?.length ? `<p class="muted small">Recent 2k attempts: ${m.recent2ks.map(k => `${fmtDuration(k.total_time_s)} (${fmtDate(k.started_at)})`).join(' · ')}</p>` : ''}
        ${m.recentWorkouts?.length ? `<p class="muted small">Recent: ${m.recentWorkouts.map(w => `${fmtDistance(w.total_distance_m)} @ ${fmtSplit(w.avg_split_s)}`).join(' · ')}</p>`
    : m.recentWorkouts === null ? '<p class="muted small">Keeps workouts private.</p>' : ''}
      </div>`).join('')}`;

  el.querySelector('#addBtn').onclick = async () => {
    const { connections } = await api('/social/connections');
    const eligible = connections.filter(c => !members.some(m => m.id === c.id));
    if (!eligible.length) { toast('All your connections are already here (or you have none yet).'); return; }
    const pick = prompt(`Type the number to add:\n${eligible.map((c, i) => `${i + 1}. ${c.displayName}`).join('\n')}`);
    const idx = Number(pick) - 1;
    if (!(idx >= 0 && idx < eligible.length)) return;
    await api(`/social/groups/${groupId}/members`, { method: 'POST', body: { userId: eligible[idx].id } });
    toast('Added.', 'success'); renderGroup(el, groupId);
  };
  el.querySelector('#muteBtn').onclick = async () => {
    await api(`/social/groups/${groupId}/mute`, { method: 'POST', body: { muted: true } });
    toast('Group muted — no more activity notifications.');
  };
  el.querySelector('#leaveBtn').onclick = async () => {
    if (!confirm('Leave this group?')) return;
    await api(`/social/groups/${groupId}/leave`, { method: 'POST' });
    location.hash = '#/social';
  };
  el.querySelectorAll('[data-rep]').forEach(b => b.onclick = async () => {
    const reason = prompt('What\'s wrong? (e.g. harassment, spam)');
    if (!reason) return;
    await api('/social/report', { method: 'POST', body: { userId: b.dataset.rep, groupId, reason } });
    toast('Report sent to the moderation team.', 'success');
  });
}
