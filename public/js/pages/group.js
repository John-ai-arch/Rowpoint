// Group hub — dashboard, automatic leaderboards, activity feed with likes &
// comments, challenges, collaborative goals, live chat, member management
// with roles, and analytics. Everything shown respects each member's own
// privacy settings (enforced server-side).
import { api, state, toast, esc, fmtSplit, fmtDistance, fmtDuration, fmtDate, fmtDateTime } from '../api.js';
import { subscribe, unsubscribe, onRealtime } from '../ws.js';

const LB_GROUPS = [
  ['Erg scores', [
    ['best_2k', '2K'], ['best_5k', '5K'], ['best_6k', '6K'],
    ['best_30min', '30 min test'], ['best_60min', '60 min test'], ['most_improved_2k', 'Most improved 2K'],
  ]],
  ['Volume', [
    ['weekly_meters', 'This week'], ['monthly_meters', 'This month'], ['annual_meters', 'This year'],
    ['total_meters', 'Total meters'], ['total_time', 'Total time'], ['total_workouts', 'Total workouts'],
    ['avg_weekly_volume', 'Avg weekly volume'], ['single_day_volume', 'Biggest single day'],
  ]],
  ['Consistency & training', [
    ['current_streak', 'Current streak'], ['longest_streak', 'Longest streak'],
    ['most_consistent', 'Most consistent'], ['zone2_time', 'Zone 2 time'], ['interval_workouts', 'Interval workouts'],
  ]],
];

const BADGE_ICON = {
  first_workout: '🚣', workouts_100: '💯', workouts_500: '🏭', meters_100k: '📏',
  meters_1m: '🌊', meters_5m: '🌏', first_2k: '⏱', pb_2k: '🏆', streak_7: '🔥',
  streak_30: '🗓', streak_365: '🎖', weekly_champion: '🥇', monthly_champion: '👑',
  challenge_winner: '⚔️',
};

export async function renderGroup(el, groupId) {
  el.innerHTML = '<p class="muted">Loading…</p>';
  let dash;
  try { dash = await api(`/groups/${groupId}`); }
  catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }

  const isMod = ['owner', 'admin', 'moderator'].includes(dash.myRole);
  const isAdmin = ['owner', 'admin'].includes(dash.myRole);
  let tab = 'dashboard';
  const unsubs = [];
  const chatChannel = `group:${groupId}`;
  let chatMessages = [];

  function shell() {
    const g = dash.group;
    el.innerHTML = `
      <a href="#/social" class="small">← Social</a>
      <div class="row between" style="align-items:flex-start">
        <div class="row">
          <div class="avatar" style="width:52px;height:52px;font-size:1.4rem">${g.photoUrl ? `<img src="${esc(g.photoUrl)}" style="width:100%;height:100%;border-radius:inherit;object-fit:cover">` : '👥'}</div>
          <div>
            <h1 style="margin:0">${esc(g.name)}</h1>
            <p class="muted small" style="margin:2px 0">
              ${g.memberCount} member${g.memberCount === 1 ? '' : 's'} · ${esc(g.privacy)} · created ${fmtDate(g.createdAt)}
              ${g.owner ? ` · owner ${esc(g.owner.display_name || g.owner.displayName)}` : ''}<br>
              ${[g.school, g.club, g.city, g.region, g.country].filter(Boolean).map(esc).join(' · ')}
            </p>
            ${g.description ? `<p class="small" style="margin:2px 0">${esc(g.description)}</p>` : ''}
          </div>
        </div>
        <div class="row">
          <button class="ghost sm" id="muteBtn">${dash.muted ? 'Unmute' : 'Mute'}</button>
          <button class="ghost sm" id="leaveBtn">Leave</button>
        </div>
      </div>
      <div class="seg mb mt" id="gtabs" style="flex-wrap:wrap">
        ${['Dashboard', 'Leaderboards', 'Feed', 'Challenges', 'Goals', 'Chat', 'Members', 'Analytics', 'Club'].map(t =>
    `<button data-tab="${t.toLowerCase()}" class="${t.toLowerCase() === tab ? 'on' : ''}">${t}</button>`).join('')}
      </div>
      <div id="gbody"></div>`;
    el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
      el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      tab = b.dataset.tab;
      show();
    });
    el.querySelector('#muteBtn').onclick = async () => {
      await api(`/groups/${groupId}/mute`, { method: 'POST', body: { muted: !dash.muted } });
      dash.muted = !dash.muted;
      el.querySelector('#muteBtn').textContent = dash.muted ? 'Unmute' : 'Mute';
      toast(dash.muted ? 'Group muted — no more activity notifications.' : 'Notifications back on.');
    };
    el.querySelector('#leaveBtn').onclick = async () => {
      if (!confirm('Leave this group?')) return;
      try { await api(`/groups/${groupId}/leave`, { method: 'POST' }); location.hash = '#/social'; }
      catch (e) { toast(e.message, 'error', 7000); }
    };
  }

  const body = () => el.querySelector('#gbody');

  async function show() {
    body().innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (tab === 'dashboard') return showDashboard();
      if (tab === 'leaderboards') return await showLeaderboards();
      if (tab === 'feed') return await showFeed();
      if (tab === 'challenges') return await showChallenges();
      if (tab === 'goals') return await showGoals();
      if (tab === 'chat') return await showChat();
      if (tab === 'members') return await showMembers();
      if (tab === 'analytics') return await showAnalytics();
      if (tab === 'club') return await showClub();
    } catch (e) { body().innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; }
  }

  /* ================= CLUB (club dashboard + crew compatibility) ================= */

  async function showClub() {
    const [{ club }, { crew }] = await Promise.all([
      api(`/groups/${groupId}/club`),
      api(`/groups/${groupId}/crew-compatibility`).catch(() => ({ crew: null })),
    ]);
    const rec = (r, label) => `<div class="stat-tile tight"><div class="n" style="font-size:1.3rem">${r ? fmtDuration(r.timeS) : '–'}</div><div class="l">${label}${r ? ` · ${esc(r.name)}` : ''}</div></div>`;
    body().innerHTML = `
      <div class="grid cols3">
        <div class="stat-tile"><div class="n">${fmtDistance(club.totalMeters)}</div><div class="l">total club metres</div></div>
        <div class="stat-tile"><div class="n">${club.participationRatePct}%</div><div class="l">active this week</div></div>
        <div class="stat-tile"><div class="n">${club.memberCount}</div><div class="l">members</div></div>
      </div>
      <div class="card"><h3>Club records</h3>
        <div class="grid cols3">${rec(club.records.best2k, '2k')}${rec(club.records.best5k, '5k')}${rec(club.records.best6k, '6k')}</div>
        <p class="muted small mt">Only members who share their 2k history are eligible.</p></div>
      <div class="card"><h3>Most active (30 days)</h3>
        ${club.mostActive.length ? `<table><thead><tr><th>Athlete</th><th>Metres</th><th>Sessions</th></tr></thead><tbody>
        ${club.mostActive.map((m, i) => `<tr><td>${i < 3 ? ['🥇', '🥈', '🥉'][i] + ' ' : ''}${esc(m.name)}</td><td>${fmtDistance(m.meters)}</td><td>${m.workouts}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted small">No shared activity yet.</p>'}</div>
      ${crew ? `<div class="card"><h3>Crew compatibility</h3>
        <p class="muted small">${esc(crew.note)}</p>
        ${crew.suggestedPairs.length ? `<table><thead><tr><th>Suggested pairing</th><th>Match</th></tr></thead><tbody>
        ${crew.suggestedPairs.map(p => `<tr><td>${esc(p.a)} &amp; ${esc(p.b)}${p.sameBoatClass ? ' <span class="badge">same boat class</span>' : ''}</td>
          <td><div class="pbar" style="display:inline-block;width:80px;vertical-align:middle"><span style="width:${Math.max(0, p.score)}%"></span></div> ${p.score}%</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted small">Need more members sharing workouts to suggest pairings.</p>'}
        <details class="mt"><summary class="small muted">Member training profiles</summary>
        <table class="mt"><thead><tr><th>Athlete</th><th>Avg rate</th><th>Weekly</th><th>Consistency</th></tr></thead><tbody>
        ${crew.members.map(m => `<tr><td>${esc(m.name)}</td><td>${m.avgStrokeRate || '–'} spm</td><td>${fmtDistance(m.weeklyMeters)}</td><td>${m.consistencyPct}%</td></tr>`).join('')}
        </tbody></table></details></div>` : ''}`;
  }

  const tile = (n, l) => `<div class="stat-tile"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const badgeChips = (badges) => badges.map(b =>
    `<span class="badge blue" title="${esc(fmtDate(b.achieved_at))}">${BADGE_ICON[b.badge] || '🏅'} ${esc(b.label)}</span>`).join(' ');

  /* ================= DASHBOARD ================= */

  function showDashboard() {
    const s = dash.stats;
    body().innerHTML = `
      <div class="grid cols3">
        ${tile(fmtDistance(s.totalMeters), 'total meters rowed')}
        ${tile(s.totalWorkouts, 'workouts completed')}
        ${tile(s.totalHours, 'hours trained')}
        ${tile(fmtDistance(s.week.meters), 'meters this week')}
        ${tile(s.week.workouts, 'workouts this week')}
        ${tile(s.week.activeMembers, 'active this week')}
      </div>
      <div class="card tight">
        <div class="row between"><h3>Invite friends</h3>
          <div class="row"><code style="font-size:1.05rem">${esc(dash.group.inviteCode)}</code>
          <button class="ghost sm" id="copyCode">Copy</button>
          ${isAdmin ? '<button class="ghost sm" id="newCode">New code</button>' : ''}</div></div>
        <p class="muted small">Anyone with this code can join instantly from Social → Groups → Join by code.</p>
      </div>
      ${dash.myBadges.length ? `<div class="card tight"><h3>Your achievements</h3><p>${badgeChips(dash.myBadges)}</p></div>` : ''}
      <div class="card">
        <div class="row between"><h3>Recent activity</h3><button class="ghost sm" data-goto="feed">Full feed →</button></div>
        ${dash.feed.length ? dash.feed.map(feedItemHtml).join('') : '<p class="muted small">Quiet so far — finished workouts, PBs, and milestones show up here automatically.</p>'}
      </div>`;
    body().querySelector('#copyCode').onclick = () => {
      navigator.clipboard?.writeText(dash.group.inviteCode);
      toast('Invite code copied.', 'success');
    };
    body().querySelector('#newCode')?.addEventListener('click', async () => {
      const r = await api(`/groups/${groupId}/regenerate-code`, { method: 'POST' });
      dash.group.inviteCode = r.inviteCode; showDashboard();
    });
    body().querySelector('[data-goto]').onclick = () => {
      el.querySelector('[data-tab="feed"]').click();
    };
    wireFeedButtons(body());
  }

  /* ================= LEADERBOARDS ================= */

  let lbKind = 'weekly_meters', lbRange = 'all';

  async function showLeaderboards() {
    const [{ entries }, weeksRes] = await Promise.all([
      api(`/groups/${groupId}/leaderboard/${lbKind}?range=${lbRange}`),
      lbKind === 'weekly_meters' ? api(`/groups/${groupId}/weeks`) : Promise.resolve(null),
    ]);
    body().innerHTML = `
      <div class="row mb" style="flex-wrap:wrap;gap:6px">
        <select id="lbKind">${LB_GROUPS.map(([label, kinds]) =>
    `<optgroup label="${label}">${kinds.map(([k, l]) => `<option value="${k}" ${k === lbKind ? 'selected' : ''}>${l}</option>`).join('')}</optgroup>`).join('')}
        </select>
        ${lbKind === 'best_2k' ? `<select id="lbRange">
          <option value="all" ${lbRange === 'all' ? 'selected' : ''}>All time</option>
          <option value="season" ${lbRange === 'season' ? 'selected' : ''}>Current season</option>
          <option value="12mo" ${lbRange === '12mo' ? 'selected' : ''}>Last 12 months</option>
        </select>` : ''}
      </div>
      <div class="card tight">${lbTable(lbKind, entries)}</div>
      ${lbKind === 'weekly_meters' ? '<p class="muted small">Resets every Monday (UTC). Past weeks are preserved below.</p>' : ''}
      ${weeksRes?.weeks?.length ? `<div class="card tight"><h3>Past weeks</h3>
        ${weeksRes.weeks.slice(0, 6).map(w => `<p class="small"><strong>${esc(w.weekKey)}</strong> —
          ${w.standings.slice(0, 3).map(s => `${s.rank}. ${esc(s.displayName)} (${fmtDistance(s.meters)})`).join(' · ')}
          ${w.standings[0] ? ' 🥇' : ''}</p>`).join('')}</div>` : ''}`;
    body().querySelector('#lbKind').onchange = (e) => { lbKind = e.target.value; showLeaderboards(); };
    body().querySelector('#lbRange')?.addEventListener('change', (e) => { lbRange = e.target.value; showLeaderboards(); });
  }

  function lbTable(kind, entries) {
    if (!entries.length) return '<p class="muted small">No qualifying results yet — this board fills in automatically as members train (and share their workouts).</p>';
    const me = (e) => e.userId === state.user.id ? ' style="background:var(--bg2)"' : '';
    const medal = (r) => r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : r;
    const head = (cols) => `<thead><tr><th></th><th>Athlete</th>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
    const row = (e, cells) => `<tr${me(e)}><td>${medal(e.rank)}</td><td>${esc(e.displayName)}</td>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
    let cols, cells;
    switch (kind) {
      case 'best_2k': case 'best_5k': case 'best_6k':
        cols = ['Time', 'Avg split', 'Date']; cells = e => [e.timeText, e.avgSplitText, fmtDate(e.achievedAt)]; break;
      case 'best_30min': case 'best_60min':
        cols = ['Distance', 'Avg split', 'Date']; cells = e => [fmtDistance(e.meters), fmtSplit(e.avgSplitS), fmtDate(e.achievedAt)]; break;
      case 'most_improved_2k':
        cols = ['Improved by', 'First 2K', 'Best 2K']; cells = e => [`${e.improvedS}s`, e.firstText, e.bestText]; break;
      case 'total_time':
        cols = ['Hours', 'Workouts']; cells = e => [e.hours, e.workouts]; break;
      case 'total_workouts': case 'interval_workouts':
        cols = ['Workouts']; cells = e => [e.workouts]; break;
      case 'longest_streak': case 'current_streak':
        cols = ['Days', 'Longest ever']; cells = e => [`${e.days} 🔥`, e.longest]; break;
      case 'most_consistent':
        cols = ['Consistency', 'Active weeks']; cells = e => [`${e.consistencyPct}%`, `${e.activeWeeks}/${e.totalWeeks}`]; break;
      case 'zone2_time':
        cols = ['Zone 2 hours', 'Workouts w/ HR']; cells = e => [e.hours, e.workoutsWithHr]; break;
      case 'avg_weekly_volume':
        cols = ['Meters / week', 'Lifetime']; cells = e => [fmtDistance(e.weeklyMeters), fmtDistance(e.totalMeters)]; break;
      case 'single_day_volume':
        cols = ['Meters in one day', 'Date']; cells = e => [fmtDistance(e.meters), esc(e.achievedDate)]; break;
      default:
        cols = ['Meters', 'Workouts']; cells = e => [fmtDistance(e.meters), e.workouts];
    }
    return `<table>${head(cols)}<tbody>${entries.map(e => row(e, cells(e))).join('')}</tbody></table>`;
  }

  /* ================= FEED ================= */

  function feedItemHtml(f) {
    const p = f.payload || {};
    const who = esc(p.displayName || 'Someone');
    const when = `<span class="muted small">${fmtDateTime(f.createdAt)}</span>`;
    let icon = '🚣', text;
    switch (f.type) {
      case 'pb': icon = '🏆'; text = `<strong>${who}</strong> set a new verified 2k PB: <strong>${fmtDuration(p.timeS)}</strong>`; break;
      case 'joined': icon = '👋'; text = `<strong>${who}</strong> joined the group`; break;
      case 'milestone': icon = '🌊'; text = `<strong>${who}</strong> reached <strong>${fmtDistance(p.milestoneMeters)}</strong> lifetime meters`; break;
      case 'weekly_champion': icon = '🥇'; text = `<strong>${who}</strong> won week ${esc(p.weekKey)} with ${fmtDistance(p.meters)}`; break;
      case 'challenge_started': icon = '⚔️'; text = `Challenge started: <strong>${esc(p.name)}</strong> — ends ${fmtDate(p.endsAt)}`; break;
      case 'challenge_finished': icon = '🏁'; text = `Challenge <strong>${esc(p.name)}</strong> finished — <strong>${esc(p.winner)}</strong> wins!`; break;
      case 'goal_started': icon = '🎯'; text = `New team goal: <strong>${esc(p.name)}</strong>`; break;
      case 'goal_completed': icon = '🎉'; text = `Team goal completed: <strong>${esc(p.name)}</strong>`; break;
      case 'announcement': icon = '📣'; text = `<strong>${who}</strong>: ${esc(p.body || '')}`; break;
      default: text = `<strong>${who}</strong> completed ${fmtDistance(p.distanceM)}, avg split ${esc(p.avgSplitText || fmtSplit(p.avgSplit))}${p.newPb ? ' <span class="badge green">PB</span>' : ''}`;
    }
    return `<div class="list-item" data-fid="${f.id}" style="align-items:flex-start">
      <div class="avatar">${icon}</div>
      <div style="flex:1">${text}<div>${when}</div>
        <div class="row mt" style="gap:6px">
          <button class="ghost sm" data-like="${f.id}">${f.likedByMe ? '❤️' : '🤍'} ${f.likes || ''}</button>
          <button class="ghost sm" data-cmt="${f.id}">💬 ${f.comments || ''}</button>
        </div>
        <div class="cmts" id="cmts-${f.id}"></div>
      </div></div>`;
  }

  function wireFeedButtons(root) {
    root.querySelectorAll('[data-like]').forEach(b => b.onclick = async () => {
      const r = await api(`/groups/${groupId}/feed/${b.dataset.like}/like`, { method: 'POST' });
      b.innerHTML = `${r.liked ? '❤️' : '🤍'} ${r.likes || ''}`;
    });
    root.querySelectorAll('[data-cmt]').forEach(b => b.onclick = async () => {
      const box = root.querySelector(`#cmts-${b.dataset.cmt}`);
      if (box.dataset.open) { box.innerHTML = ''; delete box.dataset.open; return; }
      box.dataset.open = '1';
      const { comments } = await api(`/groups/${groupId}/feed/${b.dataset.cmt}/comments`);
      box.innerHTML = `${comments.map(c => `<p class="small" style="margin:4px 0"><strong>${esc(c.displayName)}</strong> ${esc(c.body)} <span class="muted">${fmtDateTime(c.createdAt)}</span></p>`).join('')}
        <div class="row"><input placeholder="Add a comment…" style="flex:1"><button class="sm">Post</button></div>`;
      box.querySelector('button').onclick = async () => {
        const input = box.querySelector('input');
        if (!input.value.trim()) return;
        await api(`/groups/${groupId}/feed/${b.dataset.cmt}/comments`, { method: 'POST', body: { body: input.value } });
        delete box.dataset.open;
        b.click();
      };
    });
  }

  async function showFeed() {
    const { feed } = await api(`/groups/${groupId}/feed`);
    body().innerHTML = `<div class="card">
      ${feed.length ? feed.map(feedItemHtml).join('') : '<p class="muted small">No activity yet.</p>'}
    </div>`;
    wireFeedButtons(body());
  }

  /* ================= CHALLENGES ================= */

  async function showChallenges() {
    const { challenges } = await api(`/groups/${groupId}/challenges`);
    const metricLabel = { meters: 'Most meters', workouts: 'Most workouts', avg_split: 'Fastest average split', streak: 'Longest streak', team_meters: 'Team meter goal', custom: 'Custom' };
    body().innerHTML = `
      ${isMod ? `<div class="card tight"><h3>New challenge</h3>
        <div class="row" style="flex-wrap:wrap;gap:6px">
          <input id="chName" placeholder="Name (e.g. Spring Sprint Week)" style="flex:2;min-width:160px">
          <select id="chMetric">${Object.entries(metricLabel).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <input id="chTarget" type="number" placeholder="Team target (m)" style="width:130px;display:none">
          <input id="chEnd" type="date">
          <button class="sm" id="chCreate">Create</button>
        </div></div>` : ''}
      ${challenges.length ? challenges.map(c => {
    const live = c.status === 'active';
    const left = Math.max(0, Math.round((c.endsAt - Date.now() / 1000) / 86400));
    return `<div class="card tight">
      <div class="row between"><h3>${esc(c.name)} ${live ? `<span class="badge blue">live · ${left}d left</span>` : '<span class="badge gray">finished</span>'}</h3>
        <span class="muted small">${esc(metricLabel[c.metric] || c.metric)}</span></div>
      ${c.description ? `<p class="muted small">${esc(c.description)}</p>` : ''}
      <p class="muted small">${fmtDate(c.startsAt)} → ${fmtDate(c.endsAt)}</p>
      ${c.metric === 'team_meters' && c.target ? `<div style="background:var(--bg2);border-radius:8px;height:16px;overflow:hidden">
        <div style="width:${Math.min(100, Math.round(((c.teamTotal || 0) / c.target) * 100))}%;background:var(--accent,#38bdf8);height:100%"></div></div>
        <p class="small muted">${fmtDistance(c.teamTotal || 0)} of ${fmtDistance(c.target)} (${Math.min(100, Math.round(((c.teamTotal || 0) / c.target) * 100))}%)</p>` : ''}
      ${c.status === 'finished' && c.winners?.length ? `<p><strong>Winners:</strong> ${c.winners.map(w => `${w.rank === 1 ? '🥇' : w.rank === 2 ? '🥈' : '🥉'} ${esc(w.displayName)}`).join(' · ')}</p>` : ''}
      ${live && c.standings?.length ? `<table><thead><tr><th></th><th>Athlete</th><th>${c.metric === 'avg_split' ? 'Avg split' : c.metric === 'streak' ? 'Days' : c.metric === 'workouts' ? 'Workouts' : 'Meters'}</th></tr></thead><tbody>
        ${c.standings.slice(0, 10).map(s => `<tr${s.userId === state.user.id ? ' style="background:var(--bg2)"' : ''}><td>${s.rank}</td><td>${esc(s.displayName)}</td>
          <td>${c.metric === 'avg_split' ? esc(s.avgSplitText) : c.metric === 'streak' ? s.days : c.metric === 'workouts' ? s.workouts : fmtDistance(s.meters)}</td></tr>`).join('')}
      </tbody></table>` : ''}
    </div>`;
  }).join('') : '<div class="card center"><p class="muted">No challenges yet.' + (isMod ? ' Create the first one above!' : '') + '</p></div>'}`;

    const metricSel = body().querySelector('#chMetric');
    metricSel?.addEventListener('change', () => {
      body().querySelector('#chTarget').style.display = metricSel.value === 'team_meters' ? '' : 'none';
    });
    body().querySelector('#chCreate')?.addEventListener('click', async () => {
      const endDate = body().querySelector('#chEnd').value;
      try {
        await api(`/groups/${groupId}/challenges`, {
          method: 'POST',
          body: {
            name: body().querySelector('#chName').value,
            metric: metricSel.value,
            target: Number(body().querySelector('#chTarget').value) || undefined,
            endsAt: endDate ? Math.floor(new Date(`${endDate}T23:59:59Z`).getTime() / 1000) : undefined,
          },
        });
        toast('Challenge created — the group has been notified.', 'success');
        showChallenges();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  /* ================= GOALS ================= */

  async function showGoals() {
    const { goals } = await api(`/groups/${groupId}/goals`);
    const unitOf = { meters: 'm', workouts: 'workouts', hours: 'h' };
    body().innerHTML = `
      ${isMod ? `<div class="card tight"><h3>New team goal</h3>
        <div class="row" style="flex-wrap:wrap;gap:6px">
          <input id="goName" placeholder='Name (e.g. "Row the Atlantic — 5,556 km")' style="flex:2;min-width:180px">
          <select id="goMetric"><option value="meters">meters</option><option value="workouts">workouts</option><option value="hours">hours</option></select>
          <input id="goTarget" type="number" placeholder="Target" style="width:120px">
          <button class="sm" id="goCreate">Create</button>
        </div>
        <p class="muted small">Everyone's training counts toward the goal together.</p></div>` : ''}
      ${goals.length ? goals.map(g => `
        <div class="card tight">
          <div class="row between"><h3>${esc(g.name)} ${g.completedAt ? '<span class="badge green">completed 🎉</span>' : ''}</h3>
            ${isAdmin && !g.completedAt ? `<button class="ghost sm" data-delgoal="${g.id}">Delete</button>` : ''}</div>
          <div style="background:var(--bg2);border-radius:8px;height:18px;overflow:hidden">
            <div style="width:${g.progressPct}%;background:${g.completedAt ? 'var(--good,#4ade80)' : 'var(--accent,#38bdf8)'};height:100%"></div>
          </div>
          <p class="small muted">${g.metric === 'meters' ? fmtDistance(g.current) : g.current} of ${g.metric === 'meters' ? fmtDistance(g.target) : g.target} ${unitOf[g.metric]} · ${g.progressPct}%</p>
        </div>`).join('') : '<div class="card center"><p class="muted">No team goals yet.</p></div>'}`;
    body().querySelector('#goCreate')?.addEventListener('click', async () => {
      try {
        await api(`/groups/${groupId}/goals`, {
          method: 'POST',
          body: { name: body().querySelector('#goName').value, metric: body().querySelector('#goMetric').value, target: Number(body().querySelector('#goTarget').value) },
        });
        toast('Goal created.', 'success'); showGoals();
      } catch (e) { toast(e.message, 'error'); }
    });
    body().querySelectorAll('[data-delgoal]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this goal?')) return;
      await api(`/groups/${groupId}/goals/${b.dataset.delgoal}`, { method: 'DELETE' });
      showGoals();
    });
  }

  /* ================= CHAT ================= */

  async function showChat() {
    const res = await api(`/groups/${groupId}/messages`);
    chatMessages = res.messages;
    body().innerHTML = `
      ${res.pinned.length ? `<div class="card tight"><h3>📌 Pinned</h3>
        ${res.pinned.map(m => `<p class="small"><strong>${esc(m.displayName)}:</strong> ${esc(m.body || '')}</p>`).join('')}</div>` : ''}
      <div class="card" style="display:flex;flex-direction:column;max-height:60vh">
        <div id="chatList" style="overflow-y:auto;flex:1">${chatMessages.map(msgHtml).join('') || '<p class="muted small">Say hi — messages are visible to all group members.</p>'}</div>
        <div class="row mt" style="gap:6px">
          <input id="chatInput" placeholder="Message the group…" style="flex:1" maxlength="2000">
          <label class="btn ghost sm" style="cursor:pointer" title="Share an image">🖼<input type="file" id="chatImg" accept="image/*" style="display:none"></label>
          <button class="ghost sm" id="chatShare" title="Share a workout">🚣</button>
          ${isMod ? '<button class="ghost sm" id="chatAnnounce" title="Post as announcement">📣</button>' : ''}
          <button class="sm" id="chatSend">Send</button>
        </div>
      </div>`;
    scrollChat();
    wireChatItems();

    const send = async (payload) => {
      try {
        await api(`/groups/${groupId}/messages`, { method: 'POST', body: payload });
        body().querySelector('#chatInput').value = '';
      } catch (e) { toast(e.message, 'error', 6000); }
    };
    body().querySelector('#chatSend').onclick = () => {
      const v = body().querySelector('#chatInput').value.trim();
      if (v) send({ kind: 'text', body: v });
    };
    body().querySelector('#chatInput').onkeydown = (e) => { if (e.key === 'Enter') body().querySelector('#chatSend').click(); };
    body().querySelector('#chatAnnounce')?.addEventListener('click', () => {
      const v = body().querySelector('#chatInput').value.trim();
      if (!v) { toast('Type the announcement first, then press 📣.'); return; }
      send({ kind: 'announcement', body: v });
    });
    body().querySelector('#chatImg').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const dataUrl = await shrinkImage(file);
      if (!dataUrl) { toast('Could not read that image.', 'error'); return; }
      send({ kind: 'image', imageData: dataUrl, body: body().querySelector('#chatInput').value.trim() });
      e.target.value = '';
    };
    body().querySelector('#chatShare').onclick = async () => {
      const { workouts } = await api('/workouts/?limit=5');
      if (!workouts.length) { toast('No workouts to share yet.'); return; }
      const pick = prompt(`Share which workout?\n${workouts.map((w, i) =>
        `${i + 1}. ${Math.round(w.total_distance_m)}m in ${fmtDuration(w.total_time_s)} (${fmtDate(w.started_at)})`).join('\n')}`);
      const idx = Number(pick) - 1;
      if (idx >= 0 && idx < workouts.length) send({ kind: 'workout', workoutId: workouts[idx].id, body: body().querySelector('#chatInput').value.trim() });
    };
  }

  function msgHtml(m) {
    const mine = m.userId === state.user.id;
    if (m.deleted) return `<p class="muted small" data-mid="${m.id}" style="font-style:italic">message deleted</p>`;
    return `<div class="list-item" data-mid="${m.id}" style="align-items:flex-start;${m.kind === 'announcement' ? 'background:var(--bg2);border-radius:8px' : ''}">
      <div class="avatar">${m.kind === 'announcement' ? '📣' : esc(m.displayName[0])}</div>
      <div style="flex:1">
        <strong>${esc(m.displayName)}</strong> <span class="muted small">${fmtDateTime(m.createdAt)}</span>
        ${m.pinned ? '<span class="badge amber">pinned</span>' : ''}
        ${m.kind === 'announcement' ? '<span class="badge blue">announcement</span>' : ''}
        ${m.body ? `<div>${esc(m.body)}</div>` : ''}
        ${m.imageData ? `<img src="${esc(m.imageData)}" style="max-width:260px;max-height:200px;border-radius:8px;margin-top:4px">` : ''}
        ${m.workout ? `<div class="notice small mt">🚣 Shared workout: ${fmtDistance(m.workout.distanceM)} in ${fmtDuration(m.workout.timeS)} @ ${esc(m.workout.avgSplitText)}/500m</div>` : ''}
        <div class="row" style="gap:4px;margin-top:4px">
          ${(m.reactions || []).map(r => `<button class="ghost sm" data-react="${m.id}" data-emoji="${esc(r.emoji)}" ${r.mine ? 'style="border-color:var(--accent,#38bdf8)"' : ''}>${esc(r.emoji)} ${r.count}</button>`).join('')}
          <button class="ghost sm" data-addreact="${m.id}">＋😊</button>
          ${isMod ? `<button class="ghost sm" data-pin="${m.id}">${m.pinned ? 'Unpin' : 'Pin'}</button>` : ''}
          ${mine || isMod ? `<button class="ghost sm" data-delmsg="${m.id}">Delete</button>` : ''}
        </div>
      </div></div>`;
  }

  function wireChatItems() {
    const root = body();
    root.querySelectorAll('[data-react]').forEach(b => b.onclick = () =>
      api(`/groups/${groupId}/messages/${b.dataset.react}/react`, { method: 'POST', body: { emoji: b.dataset.emoji } }).then(refreshChat));
    root.querySelectorAll('[data-addreact]').forEach(b => b.onclick = () => {
      const emoji = prompt('React with an emoji (e.g. 💪 🔥 👏):');
      if (emoji) api(`/groups/${groupId}/messages/${b.dataset.addreact}/react`, { method: 'POST', body: { emoji: emoji.trim().slice(0, 8) } }).then(refreshChat);
    });
    root.querySelectorAll('[data-pin]').forEach(b => b.onclick = () =>
      api(`/groups/${groupId}/messages/${b.dataset.pin}/pin`, { method: 'POST' }).then(showChat));
    root.querySelectorAll('[data-delmsg]').forEach(b => b.onclick = () => {
      if (confirm('Delete this message?')) api(`/groups/${groupId}/messages/${b.dataset.delmsg}`, { method: 'DELETE' }).then(refreshChat);
    });
  }

  async function refreshChat() {
    if (tab !== 'chat') return;
    const res = await api(`/groups/${groupId}/messages`);
    chatMessages = res.messages;
    const list = body().querySelector('#chatList');
    if (list) { list.innerHTML = chatMessages.map(msgHtml).join(''); wireChatItems(); scrollChat(); }
  }
  const scrollChat = () => { const l = body().querySelector('#chatList'); if (l) l.scrollTop = l.scrollHeight; };

  function shrinkImage(file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 800 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        let quality = 0.8, out;
        do { out = canvas.toDataURL('image/jpeg', quality); quality -= 0.15; } while (out.length > 150 * 1024 && quality > 0.2);
        resolve(out.length <= 200 * 1024 ? out : null);
      };
      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(file);
    });
  }

  /* ================= MEMBERS ================= */

  async function showMembers() {
    const [{ members, hiddenList }, requests] = await Promise.all([
      api(`/groups/${groupId}/members`),
      isMod ? api(`/groups/${groupId}/join-requests`) : Promise.resolve({ requests: [] }),
    ]);
    body().innerHTML = `
      ${requests.requests.length ? `<div class="card tight"><h3>Join requests</h3>
        ${requests.requests.map(r => `<div class="list-item"><div style="flex:1"><strong>${esc(r.displayName)}</strong>
          ${r.message ? `<div class="muted small">"${esc(r.message)}"</div>` : ''}</div>
          <button class="sm" data-appr="${r.id}">Approve</button><button class="ghost sm" data-deny="${r.id}">Deny</button></div>`).join('')}
      </div>` : ''}
      ${hiddenList ? '<p class="muted small">This group keeps its member list private — only group staff are shown.</p>' : ''}
      ${members.map(m => `
        <div class="card tight">
          <div class="row between" style="align-items:flex-start">
            <div class="row"><div class="avatar">${esc(m.displayName[0])}</div>
              <div><strong>${esc(m.displayName)}</strong>
                ${m.role !== 'member' ? `<span class="badge blue">${esc(m.role)}</span>` : ''}
                ${m.id === state.user.id ? '<span class="badge gray">you</span>' : ''}
                <div class="muted small">2k: ${m.best2kSeconds ? `${fmtDuration(m.best2kSeconds)}${m.best2kVerified ? ' ✓' : ''}` : 'not shared'} · joined ${fmtDate(m.joinedAt)}</div>
                ${m.badges.length ? `<div style="margin-top:4px">${badgeChips(m.badges.slice(0, 6))}${m.badges.length > 6 ? ` <span class="muted small">+${m.badges.length - 6} more</span>` : ''}</div>` : ''}
              </div></div>
            <div class="row" style="gap:4px">
              ${isAdmin && m.id !== state.user.id && m.role !== 'owner' ? `
                <select data-role="${m.id}">
                  ${['member', 'moderator', 'admin'].map(r => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}
                  ${dash.myRole === 'owner' ? '<option value="owner">owner (transfer)</option>' : ''}
                </select>` : ''}
              ${isMod && m.id !== state.user.id && !['owner', 'admin'].includes(m.role) ? `<button class="ghost sm" data-kick="${m.id}">Remove</button>` : ''}
              ${m.id !== state.user.id ? `<button class="ghost sm" data-rep="${m.id}">Report</button>` : ''}
            </div>
          </div>
        </div>`).join('')}`;
    body().querySelectorAll('[data-appr]').forEach(b => b.onclick = () =>
      api(`/groups/${groupId}/join-requests/${b.dataset.appr}`, { method: 'POST', body: { approve: true } }).then(() => { toast('Approved.', 'success'); showMembers(); }));
    body().querySelectorAll('[data-deny]').forEach(b => b.onclick = () =>
      api(`/groups/${groupId}/join-requests/${b.dataset.deny}`, { method: 'POST', body: { approve: false } }).then(() => showMembers()));
    body().querySelectorAll('[data-role]').forEach(sel => sel.onchange = async () => {
      const role = sel.value;
      if (role === 'owner' && !confirm('Transfer group ownership to this member? You become an admin.')) { showMembers(); return; }
      try { await api(`/groups/${groupId}/members/${sel.dataset.role}/role`, { method: 'POST', body: { role } }); toast('Role updated.', 'success'); }
      catch (e) { toast(e.message, 'error'); }
      if (role === 'owner') { dash = await api(`/groups/${groupId}`); shell(); tab = 'members'; }
      showMembers();
    });
    body().querySelectorAll('[data-kick]').forEach(b => b.onclick = async () => {
      if (!confirm('Remove this member from the group?')) return;
      try { await api(`/groups/${groupId}/members/${b.dataset.kick}`, { method: 'DELETE' }); showMembers(); }
      catch (e) { toast(e.message, 'error'); }
    });
    body().querySelectorAll('[data-rep]').forEach(b => b.onclick = async () => {
      const reason = prompt('What\'s wrong? (e.g. harassment, spam)');
      if (!reason) return;
      await api('/social/report', { method: 'POST', body: { userId: b.dataset.rep, groupId, reason } });
      toast('Report sent to the moderation team.', 'success');
    });
  }

  /* ================= ANALYTICS ================= */

  async function showAnalytics() {
    const { analytics: a } = await api(`/groups/${groupId}/analytics`);
    // 12-week activity heatmap: columns = weeks, rows = weekdays.
    const byDate = new Map(a.heatmap.map(h => [h.d, h]));
    const cells = [];
    const today = new Date();
    for (let i = 83; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      cells.push({ key, ...byDate.get(key) });
    }
    const maxW = Math.max(1, ...cells.map(c => c.workouts || 0));
    const heat = (c) => {
      const v = (c.workouts || 0) / maxW;
      const bg = v === 0 ? 'var(--bg2)' : `rgba(56,189,248,${0.25 + v * 0.75})`;
      return `<div title="${c.key}: ${c.workouts || 0} workouts, ${Math.round(c.meters || 0)}m" style="width:12px;height:12px;border-radius:3px;background:${bg}"></div>`;
    };
    body().innerHTML = `
      <div class="grid cols3">
        ${tile(a.memberCount, 'members')}
        ${tile(a.activeMembers7d, 'active last 7d')}
        ${tile(a.activeMembers30d, 'active last 30d')}
        ${tile(fmtDistance(a.totalMeters), 'total meters')}
        ${tile(fmtDistance(a.weeklyMeters), 'meters this week')}
        ${tile(fmtDistance(a.monthlyMeters), 'meters this month')}
        ${tile(a.totalWorkouts, 'total workouts')}
        ${tile(a.totalHours, 'hours trained')}
        ${tile(a.avgWorkoutsPerMember, 'workouts / member')}
      </div>
      <div class="card tight"><h3>Activity heatmap — last 12 weeks</h3>
        <div style="display:grid;grid-template-rows:repeat(7,12px);grid-auto-flow:column;gap:3px;overflow-x:auto;padding:4px 0">
          ${cells.map(heat).join('')}
        </div>
        <p class="muted small">Each square is a day; darker = more member workouts.</p></div>
      <div class="card tight"><h3>Growth — last 8 weeks</h3>
        <table><thead><tr><th>Week</th><th>New members</th><th>Meters</th></tr></thead><tbody>
        ${a.growth.map(g => `<tr><td>${esc(g.weekKey)}</td><td>${g.newMembers}</td><td>${fmtDistance(g.meters)}</td></tr>`).join('')}
        </tbody></table></div>
      <p class="muted small">Averages this week: ${fmtDistance(a.avgWeeklyVolumePerActiveMember)} per active member.</p>`;
  }

  /* ================= live updates ================= */

  subscribe(chatChannel);
  unsubs.push(onRealtime((msg) => {
    if (msg.channel !== chatChannel) return;
    if (msg.type === 'group_message' && tab === 'chat') {
      const list = body().querySelector('#chatList');
      if (list && !list.querySelector(`[data-mid="${msg.message.id}"]`)) {
        list.insertAdjacentHTML('beforeend', msgHtml(msg.message));
        wireChatItems();
        scrollChat();
      }
    }
    if ((msg.type === 'group_reaction' || msg.type === 'group_message_deleted') && tab === 'chat') refreshChat();
  }));

  shell();
  show();
  return () => { unsubs.forEach(u => u()); unsubscribe(chatChannel); };
}
