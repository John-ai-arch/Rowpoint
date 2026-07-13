// Admin dashboard UI. Every request is re-authorized server-side against the
// user's role (RBAC) on every call; this page is just a window onto that API.
import { api, state, toast, esc, fmtDateTime, fmtDuration } from '../api.js';
import { confirmDialog, promptDialog } from '../components/dialog.js';

export async function renderAdmin(el) {
  if (!state.user?.isAdmin) {
    el.innerHTML = '<div class="notice warn">Admin access requires the Admin role.</div>';
    return;
  }
  const TABS = ['Overview', 'Analytics', 'AI', 'Users', 'Research', 'System', 'Platform', 'Security', 'Moderation', 'Broadcast', 'Audit'];
  el.innerHTML = `<div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <h1 style="margin:0">Admin</h1>
      ${state.user?.researchAdmin ? '<a class="btn secondary sm" href="#/research">🔬 Research platform</a>' : ''}
    </div>
    <div class="seg mb mt" id="tabs" style="flex-wrap:wrap">
      ${TABS.map((t, i) => `<button data-tab="${t.toLowerCase()}" class="${i === 0 ? 'on' : ''}">${t}</button>`).join('')}
    </div>
    <div id="tabBody"></div>`;

  const body = el.querySelector('#tabBody');
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    show(b.dataset.tab);
  });

  async function show(tab) {
    body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (tab === 'overview') return await showOverview();
      if (tab === 'analytics') return await showAnalytics();
      if (tab === 'ai') return await showAi();
      if (tab === 'users') return await showUsers();
      if (tab === 'research') return await showResearch();
      if (tab === 'system') return await showSystem();
      if (tab === 'platform') return await showPlatform();
      if (tab === 'security') return await showSecurity();
      if (tab === 'moderation') return await showModeration();
      if (tab === 'broadcast') return showBroadcast();
      if (tab === 'audit') return await showAudit();
    } catch (e) { body.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; }
  }

  const tile = (n, l) => `<div class="stat-tile"><div class="n">${n ?? '–'}</div><div class="l">${l}</div></div>`;
  const dl = (path, name) => async () => {
    const r = await api(path, { raw: true });
    if (!r.ok) { toast(`Export failed (${r.status})`, 'error'); return; }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ================= OVERVIEW ================= */

  async function showOverview() {
    const { stats: s } = await api('/admin/stats');
    body.innerHTML = `
      <h3>Users</h3>
      <div class="grid cols3">
        ${tile(s.totalUsers, 'total users')}${tile(s.coaches, 'coaches')}${tile(s.rowers, 'rowers')}
        ${tile(s.dailyActiveUsers, 'daily active')}${tile(s.weeklyActiveUsers, 'weekly active')}${tile(s.monthlyActiveUsers, 'monthly active')}
        ${tile(s.newLastDay, 'new today')}${tile(s.newLastWeek, 'new this week')}${tile(s.newLastMonth, 'new this month')}
        ${tile(s.retention30d7dPct !== null ? s.retention30d7dPct + '%' : '–', '30d cohort active last 7d')}
        ${tile(s.verified, 'verified')}${tile(s.suspended, 'suspended')}
        ${tile(s.admins, 'admins')}${tile(s.totalTeams, 'teams')}${tile(s.totalGroups, 'groups')}
      </div>
      <h3>Workouts</h3>
      <div class="grid cols3">
        ${tile(s.totalWorkouts, 'total workouts')}${tile(s.workoutsLast7d, 'workouts / 7d')}${tile(s.workoutsWithHr, 'with heart rate')}
        ${tile((s.totalMetersRowed / 1000).toFixed(1) + ' km', 'total meters rowed')}
        ${tile(s.totalHoursTrained, 'total hours trained')}
        ${tile(s.avgWorkoutDurationMin ? s.avgWorkoutDurationMin + ' min' : '–', 'avg duration')}
        ${tile(s.avgWorkoutDistanceM + ' m', 'avg distance')}
        ${tile(s.avgPaceSPer500m ? fmtPace(s.avgPaceSPer500m) : '–', 'avg pace /500m')}
        ${tile(s.activeLast7d, 'rowed in last 7d')}
      </div>
      <div class="grid cols2">
        <div class="card tight"><h3>Popular workout types</h3>
          <table><thead><tr><th>Type</th><th>#</th></tr></thead><tbody>
          ${s.popularWorkoutTypes.map(r => `<tr><td>${esc(r.type)}</td><td>${r.n}</td></tr>`).join('') || '<tr><td colspan=2 class="muted">none</td></tr>'}
          </tbody></table></div>
        <div class="card tight"><h3>Machines</h3>
          <table><thead><tr><th>Machine</th><th>#</th></tr></thead><tbody>
          ${s.machineTypes.map(r => `<tr><td>${esc(r.machine)}</td><td>${r.n}</td></tr>`).join('') || '<tr><td colspan=2 class="muted">none</td></tr>'}
          </tbody></table></div>
      </div>
      <div class="grid cols2">
        ${s.workoutsPerDay.length ? `<div class="card tight"><h3>Workouts per day (30d)</h3>
          <table><thead><tr><th>Date</th><th>#</th><th>Meters</th></tr></thead><tbody>
          ${s.workoutsPerDay.slice(-14).map(d => `<tr><td>${d.d}</td><td>${d.n}</td><td>${Math.round(d.meters || 0)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${s.signupsPerDay.length ? `<div class="card tight"><h3>Signups (30d)</h3>
          <table><thead><tr><th>Date</th><th>Signups</th></tr></thead><tbody>
          ${s.signupsPerDay.slice(-14).map(d => `<tr><td>${d.d}</td><td>${d.n}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div>`;
  }

  /* ================= AI ANALYTICS ================= */

  async function showAi() {
    const { stats: s } = await api('/admin/stats/ai');
    body.innerHTML = `
      <div class="grid cols3">
        ${tile(s.totalGenerated, 'recommendations generated')}
        ${tile(s.generatedLast7d, 'generated / 7d')}
        ${tile(s.generatedLast30d, 'generated / 30d')}
        ${tile(s.adherence.followed, 'followed by athletes')}
        ${tile(s.adherence.followRatePct !== null ? s.adherence.followRatePct + '%' : '–', 'adherence rate')}
        ${tile(s.successMetrics.wellPacedRatePct !== null ? s.successMetrics.wellPacedRatePct + '%' : '–', 'followed & well-paced')}
      </div>
      <div class="card tight">
        <h3>Engine</h3>
        <p class="small">${s.llmConfigured
    ? `LLM coach active — model <code>${esc(s.model)}</code>, analysis-engine fallback on error.`
    : 'No ANTHROPIC_API_KEY configured — the analysis-engine fallback is generating recommendations from each athlete\'s training data.'}</p>
        <table><thead><tr><th>Source</th><th>#</th></tr></thead><tbody>
        ${s.bySource.map(r => `<tr><td><code>${esc(r.source)}</code></td><td>${r.n}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="grid cols2">
        <div class="card tight"><h3>Recommendation categories</h3>
          <table><thead><tr><th>Category</th><th>#</th></tr></thead><tbody>
          ${s.byCategory.map(r => `<tr><td>${esc((r.category || '').replaceAll('_', ' '))}</td><td>${r.n}</td></tr>`).join('') || '<tr><td colspan=2 class="muted">none yet</td></tr>'}
          </tbody></table></div>
        <div class="card tight"><h3>Confidence & status</h3>
          <table><thead><tr><th>Confidence</th><th>#</th></tr></thead><tbody>
          ${s.byConfidence.map(r => `<tr><td>${esc(r.confidence)}</td><td>${r.n}</td></tr>`).join('')}
          </tbody></table>
          <table class="mt"><thead><tr><th>Status</th><th>#</th></tr></thead><tbody>
          ${s.byStatus.map(r => `<tr><td>${esc(r.status)}</td><td>${r.n}</td></tr>`).join('')}
          </tbody></table></div>
      </div>`;
  }

  /* ================= USERS ================= */

  async function showUsers() {
    body.innerHTML = `<div class="card"><h3>Find an account</h3>
      <div class="row"><input id="uq" type="email" placeholder="exact email" style="flex:1"><button id="uSearch">Search</button>
      <button class="secondary" id="uRecent">Recent accounts</button></div>
      <div id="uResult"></div></div>`;

    body.querySelector('#uRecent').onclick = async () => {
      const { users } = await api('/admin/users/recent');
      body.querySelector('#uResult').innerHTML = `<table class="mt"><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Joined</th><th></th></tr></thead><tbody>
        ${users.map(u => `<tr><td class="small">${esc(u.email)}</td><td>${esc(u.displayName)}</td>
          <td>${u.role === 'admin' ? '<span class="badge blue">admin</span>' : 'user'}</td>
          <td class="small">${fmtDateTime(u.createdAt)}</td>
          <td><button class="ghost sm" data-open="${esc(u.email)}">Open</button></td></tr>`).join('')}
      </tbody></table>`;
      body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
        body.querySelector('#uq').value = b.dataset.open;
        body.querySelector('#uSearch').click();
      });
    };

    body.querySelector('#uSearch').onclick = async () => {
      const out = body.querySelector('#uResult');
      const res = await api(`/admin/users/search?email=${encodeURIComponent(body.querySelector('#uq').value.trim())}`);
      if (!res.found) { out.innerHTML = '<p class="muted small mt">No account with that email.</p>'; return; }
      const u = res.user;
      out.innerHTML = `<div class="card tight mt">
        <strong>${esc(u.displayName)}</strong> &lt;${esc(u.email)}&gt;
        ${u.role === 'admin' ? '<span class="badge blue">admin</span>' : ''}
        ${u.suspended ? '<span class="badge red">suspended</span>' : '<span class="badge green">active</span>'}
        <p class="muted small">${esc(u.accountType)} · ${u.emailVerified ? 'verified' : 'unverified'} · ${u.workoutCount} workouts ·
          research ${u.researchOptIn ? 'opt-in' : 'opt-out'} (demographics ${u.researchShareDemographics ? 'shared' : 'withheld'}) · joined ${fmtDateTime(u.createdAt)}<br>
          Teams: ${u.teams.length ? u.teams.map(t => `${esc(t.name)} (${t.role})`).join(', ') : 'none'}</p>
        <div class="row" style="flex-wrap:wrap;gap:6px">
          ${u.suspended
    ? '<button class="sm secondary" id="reinstate">Reinstate</button>'
    : '<button class="sm danger" id="suspend">Suspend</button>'}
          <button class="sm secondary" id="uWorkouts">Workout history</button>
          <button class="sm secondary" id="uFeedback">Feedback / reports</button>
          <button class="sm secondary" id="uReset">Reset password</button>
          <button class="sm secondary" id="uRole">${u.role === 'admin' ? 'Revoke admin role' : 'Grant admin role'}</button>
          ${u.researchOptIn ? '<button class="sm secondary" id="uResearch">Stop research contribution</button>' : ''}
          <button class="sm danger" id="delUser">Delete account</button>
        </div>
        <div id="uDetail"></div></div>`;
      const refresh = () => body.querySelector('#uSearch').click();
      out.querySelector('#suspend')?.addEventListener('click', async () => {
        const reason = await promptDialog('Suspension reason:', { title: 'Suspend account', confirmText: 'Suspend' });
        if (reason === null) return;
        await api(`/admin/users/${u.id}/suspend`, { method: 'POST', body: { suspend: true, reason: reason || 'Suspended by admin' } });
        toast('Suspended.'); refresh();
      });
      out.querySelector('#reinstate')?.addEventListener('click', async () => {
        await api(`/admin/users/${u.id}/suspend`, { method: 'POST', body: { suspend: false } });
        toast('Reinstated.'); refresh();
      });
      out.querySelector('#uRole').onclick = async () => {
        const role = u.role === 'admin' ? 'user' : 'admin';
        if (!(await confirmDialog(`Set ${u.email} role to "${role}"?`, { title: 'Change role' }))) return;
        try { await api(`/admin/users/${u.id}/role`, { method: 'POST', body: { role } }); toast(`Role set to ${role}.`, 'success'); refresh(); }
        catch (e) { toast(e.message, 'error'); }
      };
      out.querySelector('#uReset').onclick = async () => {
        if (!(await confirmDialog(`Reset ${u.email}'s password? A one-time temporary password will be shown once.`, { title: 'Reset password', confirmText: 'Reset' }))) return;
        const r = await api(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
        out.querySelector('#uDetail').innerHTML = `<div class="notice mt">Temporary password (share securely, shown once): <code>${esc(r.temporaryPassword)}</code></div>`;
      };
      // Revoke-only by design: research consent can only be GIVEN by the
      // athlete in their own Settings, so no admin-side "grant" control exists.
      out.querySelector('#uResearch')?.addEventListener('click', async () => {
        await api(`/admin/users/${u.id}/research`, { method: 'POST', body: { optIn: false } });
        toast('Research contribution stopped for this account.'); refresh();
      });
      out.querySelector('#uWorkouts').onclick = async () => {
        const { workouts } = await api(`/admin/users/${u.id}/workouts`);
        out.querySelector('#uDetail').innerHTML = workouts.length ? `<table class="mt"><thead><tr><th>When</th><th>Type</th><th>Dist</th><th>Time</th><th>Avg HR</th><th>Pacing</th></tr></thead><tbody>
          ${workouts.slice(0, 25).map(w => `<tr><td class="small">${fmtDateTime(w.started_at)}</td><td>${esc(w.planType)}</td>
            <td>${Math.round(w.total_distance_m || 0)}m</td><td>${fmtDuration(w.total_time_s || 0)}</td>
            <td>${w.avg_heart_rate ? Math.round(w.avg_heart_rate) : '–'}</td><td class="small">${esc((w.pacing || '').replaceAll('_', ' '))}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted small mt">No workouts.</p>';
      };
      out.querySelector('#uFeedback').onclick = async () => {
        const { filed, against } = await api(`/admin/users/${u.id}/feedback`);
        const rows = (list, label) => list.length
          ? list.map(r => `<div class="list-item"><div style="flex:1"><strong>${esc(r.reason)}</strong> <span class="badge gray">${esc(r.status)}</span><div class="muted small">${esc(r.details || '')}</div></div></div>`).join('')
          : `<p class="muted small">No reports ${label}.</p>`;
        out.querySelector('#uDetail').innerHTML = `<div class="mt"><h3>Filed by this user</h3>${rows(filed, 'filed')}<h3>Against this user</h3>${rows(against, 'against them')}</div>`;
      };
      out.querySelector('#delUser')?.addEventListener('click', async () => {
        if (!(await confirmDialog(`Permanently delete ${u.email} and all their data (incl. research contributions)? This cannot be undone.`, { title: 'Delete account', confirmText: 'Delete forever', danger: true }))) return;
        await api(`/admin/users/${u.id}`, { method: 'DELETE', body: { reason: 'manual deletion request' } });
        toast('Account deleted.'); out.innerHTML = '';
      });
    };
  }

  /* ================= RESEARCH ================= */

  async function showResearch() {
    const [{ studies }, { report }] = await Promise.all([
      api('/admin/research/studies'), api('/admin/research/completeness'),
    ]);
    body.innerHTML = `
      <div class="grid cols3">
        ${tile(report.consentingParticipants, 'consenting participants')}
        ${tile(report.totalWorkoutRows, 'research workouts')}
        ${tile(report.hrDatasets, 'HR datasets')}
        ${tile(report.totalWellnessRows, 'wellness rows')}
        ${tile(report.distinctContributors, 'distinct contributors')}
        ${tile(report.totalWorkoutRows - report.missing.demographics, 'rows with demographics')}
      </div>
      <div class="card tight"><h3>Missing-data report</h3>
        <table><thead><tr><th>Signal</th><th>Rows missing it</th><th>Coverage</th></tr></thead><tbody>
        ${Object.entries(report.missing).map(([k, v]) => `<tr><td>${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</td><td>${v}</td>
          <td>${report.totalWorkoutRows ? Math.round(((report.totalWorkoutRows - v) / report.totalWorkoutRows) * 100) : 0}%</td></tr>`).join('')}
        </tbody></table></div>
      <div class="card"><h3>Studies</h3>
        ${studies.map(s => `<div class="list-item"><div style="flex:1"><strong>${esc(s.name)}</strong> <code>${esc(s.tag)}</code></div>
          <span class="badge ${s.active ? 'green' : 'gray'}">${s.active ? 'active' : 'closed'}</span>
          <button class="ghost sm" data-tgl="${esc(s.tag)}" data-on="${s.active ? 0 : 1}">${s.active ? 'Close' : 'Reopen'}</button></div>`).join('')}
        <div class="row mt"><input id="sTag" placeholder="tag (e.g. pacing-study-2)" style="flex:1"><input id="sName" placeholder="Study name" style="flex:2"><button class="sm" id="sAdd">Add</button></div>
      </div>
      <div class="card"><h3>Contributed workout data</h3>
        <div class="row" style="flex-wrap:wrap;gap:6px">
          <select id="rStudy"><option value="">All studies</option>${studies.map(s => `<option>${esc(s.tag)}</option>`).join('')}</select>
          <input id="rFrom" type="date"><input id="rTo" type="date">
          <button class="sm" id="rQuery">Query</button>
          <button class="sm secondary" id="rCsv">CSV</button>
          <button class="sm secondary" id="rJson">JSON</button>
          <button class="sm secondary" id="rSql">SQL</button>
        </div>
        <div id="rOut"></div>
      </div>
      <div class="card"><h3>Contributed wellness data</h3><button class="sm" id="wQuery">Load latest</button><div id="wOut"></div></div>`;

    body.querySelectorAll('[data-tgl]').forEach(b => b.onclick = async () => {
      await api(`/admin/research/studies/${b.dataset.tgl}`, { method: 'PATCH', body: { active: b.dataset.on === '1' } });
      showResearch();
    });
    body.querySelector('#sAdd').onclick = async () => {
      await api('/admin/research/studies', { method: 'POST', body: { tag: body.querySelector('#sTag').value, name: body.querySelector('#sName').value } });
      toast('Study added — new contributions are tagged with it.'); showResearch();
    };
    const q = () => {
      const p = new URLSearchParams();
      if (body.querySelector('#rStudy').value) p.set('studyTag', body.querySelector('#rStudy').value);
      if (body.querySelector('#rFrom').value) p.set('from', body.querySelector('#rFrom').value);
      if (body.querySelector('#rTo').value) p.set('to', body.querySelector('#rTo').value);
      return p;
    };
    body.querySelector('#rQuery').onclick = async () => {
      const { rows } = await api(`/admin/research/workouts?${q()}`);
      body.querySelector('#rOut').innerHTML = rows.length ? `<p class="muted small">${rows.length} rows (pseudonymous research IDs — not joinable to accounts)</p>
        <table><thead><tr><th>research_id</th><th>study</th><th>type</th><th>dist</th><th>time</th><th>avg split</th><th>avg HR</th><th>HR series</th></tr></thead><tbody>
        ${rows.slice(0, 40).map(r => `<tr><td class="small">${esc(r.research_id.slice(0, 10))}…</td><td>${esc(r.study_tag)}</td><td>${esc(r.workout_type || '')}</td>
          <td>${Math.round(r.total_distance_m || 0)}m</td><td>${Math.round(r.total_time_s || 0)}s</td><td>${r.avg_split_s ? r.avg_split_s.toFixed(1) : ''}</td>
          <td>${r.avg_heart_rate ? Math.round(r.avg_heart_rate) : '–'}</td><td>${r.hr_series_json ? '✓' : '–'}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted small mt">No contributed rows match.</p>';
    };
    body.querySelector('#rCsv').onclick = () => { const p = q(); p.set('format', 'csv'); dl(`/admin/research/workouts?${p}`, 'research-workouts.csv')(); };
    body.querySelector('#rJson').onclick = () => dl(`/admin/export/research.json?${q()}`, 'research-export.json')();
    body.querySelector('#rSql').onclick = () => dl('/admin/export/research.sql', 'research-export.sql')();
    body.querySelector('#wQuery').onclick = async () => {
      const { rows } = await api('/admin/research/wellness');
      body.querySelector('#wOut').innerHTML = rows.length ? `<table><thead><tr><th>research_id</th><th>study</th><th>date</th><th>sleep</th><th>sore</th><th>stress</th></tr></thead><tbody>
        ${rows.slice(0, 40).map(r => `<tr><td class="small">${esc(r.research_id.slice(0, 10))}…</td><td>${esc(r.study_tag)}</td><td>${esc(r.date)}</td>
        <td>${r.sleep_hours ?? ''}</td><td>${r.soreness_level ?? ''}</td><td>${r.stress_level ?? ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small mt">No rows.</p>';
    };
  }

  /* ================= SYSTEM ================= */

  /* ================= ANALYTICS (aggregate product metrics) ================= */

  async function showAnalytics() {
    const { analytics: a } = await api('/admin/analytics');
    const pct = (v) => (v === null || v === undefined ? '–' : `${v}%`);
    const bar = (label, v) => `<div style="display:flex;align-items:center;margin:6px 0"><span class="small" style="width:9.5rem">${esc(label)}</span>
      <div class="pbar" style="flex:1;margin:0 8px"><span style="width:${Math.max(0, Math.min(100, v || 0))}%"></span></div>
      <strong class="small">${pct(v)}</strong></div>`;
    const maxSignup = Math.max(1, ...a.growth.signupsByDay.map(d => d.n));
    body.innerHTML = `
      <p class="muted small">Aggregate product analytics — no personally identifying data. Separate from the research dataset.</p>
      <div class="grid cols3">
        ${tile(a.users.dau, 'daily active (DAU)')}
        ${tile(a.users.wau, 'weekly active (WAU)')}
        ${tile(a.users.mau, 'monthly active (MAU)')}
        ${tile(a.users.total, 'total accounts')}
        ${tile(pct(a.users.stickiness), 'stickiness (DAU/MAU)')}
        ${tile(pct(a.growth.retention7of30Pct), '7d retention (of 8–30d cohort)')}
      </div>
      <div class="grid cols2">
        <div class="card tight"><h3>Engagement</h3>
          <div class="grid cols2">
            ${tile(a.engagement.totalWorkouts, 'workouts logged')}
            ${tile(a.engagement.workouts7d, 'workouts / 7d')}
            ${tile(a.engagement.avgWorkoutsPerActiveUser, 'avg workouts / active user')}
            ${tile(fmtDuration(a.engagement.avgWorkoutDurationS), 'avg workout duration')}
          </div></div>
        <div class="card tight"><h3>Signup → verification funnel (30d)</h3>
          <div class="grid cols2">
            ${tile(a.funnel.signups30d, 'signups / 30d')}
            ${tile(a.funnel.verifies30d, 'verified / 30d')}
            ${tile(pct(a.funnel.verificationRatePct), 'verification rate')}
            ${tile(a.ai.usersUsingAi, 'users using AI coach')}
          </div></div>
      </div>
      <div class="grid cols2">
        <div class="card tight"><h3>Feature adoption (% of accounts)</h3>
          ${bar('Logged a workout', a.featureAdoption.loggedWorkout)}
          ${bar('Joined a team', a.featureAdoption.joinedTeam)}
          ${bar('Joined a group', a.featureAdoption.joinedGroup)}
          ${bar('Logged wellness', a.featureAdoption.loggedWellness)}
          ${bar('Used AI coach', a.featureAdoption.usedAiCoach)}
          ${bar('Made a connection', a.featureAdoption.madeConnection)}
          ${bar('Earned an achievement', a.featureAdoption.earnedAchievement)}</div>
        <div class="card tight"><h3>Workout mix</h3>
          <table><thead><tr><th>Machine</th><th>#</th></tr></thead><tbody>
          ${a.workoutMix.machine.map(m => `<tr><td>${esc(m.type)}</td><td>${m.n}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No workouts yet</td></tr>'}
          </tbody></table>
          <p class="small muted mt">Coach-assigned: <strong>${a.workoutMix.assigned}</strong> · self-directed: <strong>${a.workoutMix.selfDirected}</strong></p>
          <p class="small">AI adherence: <strong>${pct(a.ai.adherencePct)}</strong> (${a.ai.followed}/${a.ai.suggestions} recommendations followed)</p></div>
      </div>
      <div class="grid cols2">
        <div class="card tight"><h3>New signups / day (30d)</h3>
          ${a.growth.signupsByDay.length ? `<div style="display:flex;align-items:flex-end;gap:2px;height:68px">${a.growth.signupsByDay.map(d =>
    `<div title="${esc(d.day)}: ${d.n}" style="flex:1;background:var(--accent);height:${Math.round((d.n / maxSignup) * 60) + 4}px;border-radius:2px 2px 0 0"></div>`).join('')}</div>`
    : '<p class="muted small">No signups in the last 30 days.</p>'}</div>
        <div class="card tight"><h3>Reliability (30d)</h3>
          <div class="grid cols3">
            ${['bleErrors30d', 'syncFailures30d', 'clientCrashes30d', 'apiErrors30d', 'backupFailures30d'].map(k => {
      const n = a.reliability[k] || 0;
      const label = k.replace('30d', '').replace(/([A-Z])/g, ' $1').toLowerCase();
      return `<div class="stat-tile tight"><div class="n" style="color:${n ? 'var(--warn)' : 'var(--good)'}">${n}</div><div class="l">${esc(label)}</div></div>`;
    }).join('')}
          </div>
          <p class="small muted mt">${a.reliability.workouts30d} workouts synced in the same window.</p></div>
      </div>`;
  }

  /* ================= PLATFORM (RPOS) ================= */

  async function showPlatform() {
    const [{ snapshot, validation, regressions }, queue, { organizations }] = await Promise.all([
      api('/platform/status'), api('/platform/jobs'), api('/platform/orgs'),
    ]);
    const lat = snapshot.api.latencyByGroup || {};
    body.innerHTML = `
      <div class="grid cols3">
        ${tile(validation.ok ? '<span style="color:var(--good)">●</span> valid' : `<span style="color:var(--bad)">●</span> ${validation.issues.length} issues`, 'plugin validation')}
        ${tile(validation.componentCount, 'registered components')}
        ${tile(regressions.length ? `<span style="color:var(--bad)">${regressions.length}</span>` : '0', 'performance regressions')}
        ${tile(queue.stats.byStatus.pending || 0, 'jobs pending')}
        ${tile(queue.stats.byStatus.running || 0, 'jobs running')}
        ${tile(queue.stats.byStatus.failed || 0, 'jobs failed')}
      </div>
      ${validation.issues.length ? `<div class="notice warn">${validation.issues.map(esc).join('<br>')}</div>` : ''}
      <div class="grid cols2">
        <div class="card tight"><h3>API latency by area (last 200 req each)</h3>
          <table><thead><tr><th>Area</th><th>p50</th><th>p95</th><th>max</th></tr></thead><tbody>
          ${Object.entries(lat).sort((a, z) => z[1].p95 - a[1].p95).map(([g, s]) =>
    `<tr><td><code>/api/${esc(g)}</code></td><td>${s.p50}ms</td><td>${s.p95}ms</td><td>${s.max}ms</td></tr>`).join('') || '<tr><td colspan=4 class="muted">no samples yet</td></tr>'}
          </tbody></table></div>
        <div class="card tight"><h3>Job execution</h3>
          <table><thead><tr><th>Kind</th><th>Status</th><th>#</th><th>avg</th></tr></thead><tbody>
          ${queue.execution.map(r => `<tr><td><code>${esc(r.kind)}</code></td><td>${esc(r.status)}</td><td>${r.count}</td><td>${r.avg_ms ?? '–'}ms</td></tr>`).join('') || '<tr><td colspan=4 class="muted">none yet</td></tr>'}
          </tbody></table></div>
      </div>
      ${queue.failed.length ? `<div class="card tight"><h3>Failed jobs</h3>
        ${queue.failed.slice(0, 10).map(j => `<div class="row" style="gap:8px;align-items:center;padding:3px 0">
          <code style="flex:1">${esc(j.kind)}</code><span class="muted small" style="flex:2">${esc(j.error || '')}</span>
          <button class="sm secondary" data-retry="${esc(j.id)}">Retry</button></div>`).join('')}</div>` : ''}
      <div class="card tight"><h3>Computation audit trail (latest)</h3>
        <div id="auditRows"></div></div>
      <div class="card tight"><h3>Organizations</h3>
        <p class="muted small">Enterprise groundwork: create an organization and attach coached teams. Full org management ships later; the data model and roles are in place.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <input id="orgName" placeholder="Organization name" style="width:220px">
          <button class="sm" id="orgCreate">Create</button>
        </div>
        <div id="orgList" class="mt">
          ${organizations.map(o => `<div class="row" style="gap:8px;align-items:center;padding:3px 0">
            <strong style="flex:1">${esc(o.name)}</strong>
            <span class="muted small">${o.team_count} teams · ${o.member_count} members</span>
            <input data-team-for="${esc(o.id)}" placeholder="Team ID to attach" style="width:200px">
            <button class="sm secondary" data-attach="${esc(o.id)}">Attach team</button>
          </div>`).join('') || '<p class="muted small">No organizations yet.</p>'}
        </div></div>`;

    body.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => {
      try { await api(`/platform/jobs/${b.dataset.retry}/retry`, { method: 'POST' }); toast('Job re-queued'); showPlatform(); }
      catch (e) { toast(e.message, 'error'); }
    });
    body.querySelector('#orgCreate').onclick = async () => {
      const name = body.querySelector('#orgName').value.trim();
      if (name.length < 2) return;
      try { await api('/platform/orgs', { method: 'POST', body: { name } }); toast('Organization created'); showPlatform(); }
      catch (e) { toast(e.message, 'error'); }
    };
    body.querySelectorAll('[data-attach]').forEach(b => b.onclick = async () => {
      const teamId = body.querySelector(`[data-team-for="${b.dataset.attach}"]`).value.trim();
      if (!teamId) return;
      try { await api(`/platform/orgs/${b.dataset.attach}/teams`, { method: 'POST', body: { teamId } }); toast('Team attached'); showPlatform(); }
      catch (e) { toast(e.message, 'error'); }
    });
    try {
      const { computations } = await api('/platform/audit?limit=15');
      body.querySelector('#auditRows').innerHTML = computations.length
        ? `<table><thead><tr><th>Kind</th><th>Status</th><th>ms</th><th>Outputs</th><th>When</th></tr></thead><tbody>
           ${computations.map(c => `<tr><td><code>${esc(c.kind)}</code></td><td>${esc(c.status)}</td><td>${c.durationMs ?? '–'}</td>
             <td class="small">${esc(c.outputsRef || '—')}</td><td class="small">${esc(fmtDateTime(c.createdAt))}</td></tr>`).join('')}
           </tbody></table>`
        : '<p class="muted small">No computations recorded yet.</p>';
    } catch { /* audit view is best-effort */ }
  }

  async function showSystem() {
    const [{ system: sys }, { last7d, recent }, { stats: dbs }, backupData] = await Promise.all([
      api('/admin/system'), api('/admin/health'), api('/admin/db-stats'), api('/admin/backups'),
    ]);
    const b = sys.backend, d = sys.database;
    const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;
    body.innerHTML = `
      <div class="grid cols3">
        ${tile(`<span style="color:var(--good)">●</span> ok`, 'backend')}
        ${tile(`<span style="color:${d.status === 'ok' ? 'var(--good)' : 'var(--bad)'}">●</span> ${d.status}`, 'database')}
        ${tile(`<span style="color:var(--good)">●</span> ok`, 'authentication')}
        ${tile(fmtDuration(b.uptimeSeconds), 'uptime')}
        ${tile(`${b.memory.rssMb} MB`, 'memory (rss)')}
        ${tile(mb(d.totalStorageBytes), 'storage used')}
        ${tile(b.totalRequests, 'API requests (since start)')}
        ${tile(b.errors4xx, '4xx responses')}
        ${tile(b.errors5xx, '5xx responses')}
      </div>
      <div class="grid cols2">
        <div class="card tight"><h3>API usage by area (since start)</h3>
          <table><thead><tr><th>Area</th><th>Requests</th></tr></thead><tbody>
          ${Object.entries(b.byGroup).sort((a, z) => z[1] - a[1]).map(([g, n]) => `<tr><td><code>/api/${esc(g)}</code></td><td>${n}</td></tr>`).join('')}
          </tbody></table></div>
        <div class="card tight"><h3>Database</h3>
          <p class="small muted">${esc(d.file)} · ${mb(d.sizeBytes)} + WAL ${mb(d.walSizeBytes)} · journal ${esc(String(dbs.journalMode))} · quick_check: ${esc(String(d.quickCheck))}</p>
          ${d.persistence ? `<p class="small ${d.persistence.dataDirConfigured ? '' : 'muted'}">
            Storage: <code>${esc(d.persistence.dataDir)}</code> ·
            db created ${fmtDateTime(d.persistence.dbCreatedAt)} · boot #${d.persistence.bootCount} ·
            instance <code>${esc((d.persistence.instanceId || '').slice(0, 8))}</code>
            ${!d.persistence.dataDirConfigured ? '<br><span class="badge red">ROWPOINT_DATA_DIR not set — accounts will be LOST on redeploy (see DEPLOY.md)</span>' : ''}
            ${!d.persistence.tokenSecretFromEnv ? '<br><span class="badge amber">token secret on disk only — set ROWPOINT_TOKEN_SECRET to survive disk migrations</span>' : ''}
          </p>` : ''}
          <table><thead><tr><th>Table</th><th>Rows</th></tr></thead><tbody>
          ${d.tableCounts.map(t => `<tr><td><code>${esc(t.table)}</code></td><td>${t.rows}</td></tr>`).join('')}
          </tbody></table>
          <button class="sm secondary mt" id="backupBtn">Download DB backup</button></div>
      </div>
      <div class="grid cols2">
        <div class="card tight"><h3>Subsystems</h3>
          <p class="small">Email delivery: <code>${esc(sys.auth.emailDelivery)}</code><br>
          Google OAuth: ${sys.auth.googleOauth ? 'configured' : 'not configured'}<br>
          Apple OAuth: ${sys.auth.appleOauth ? 'configured' : 'not configured'}<br>
          AI coach: ${sys.ai.llmConfigured ? `LLM <code>${esc(sys.ai.model)}</code>` : 'analysis-engine fallback (no API key)'}<br>
          Node ${esc(b.nodeVersion)}</p></div>
        <div class="card tight"><h3>Background tasks</h3>
          <p class="small">Client sync failures / 7d: <strong>${sys.backgroundTasks.failedSyncs7d}</strong><br>
          Server API errors / 7d: <strong>${sys.backgroundTasks.apiErrors7d}</strong></p>
          <div class="grid cols3">
          ${['ble_error', 'sync_failure', 'client_error', 'api_error', 'crash'].map(k => {
    const n = last7d.find(r => r.kind === k)?.n || 0;
    return `<div class="stat-tile tight"><div class="n" style="color:${n ? 'var(--warn)' : 'var(--good)'}">${n}</div><div class="l">${k.replaceAll('_', ' ')}/7d</div></div>`;
  }).join('')}</div></div>
      </div>
      <div class="card"><h3>Encrypted backups</h3>
        <p class="small muted">Automated ${backupData.policy.enabled ? `every ${backupData.policy.intervalHours}h` : '<span class="badge amber">disabled</span>'} ·
          retention ${backupData.policy.retention} · AES-256-GCM ·
          key ${backupData.policy.keyFromEnv ? 'from env' : '<span class="badge amber">on disk only — set ROWPOINT_BACKUP_KEY</span>'} ·
          last ${backupData.policy.lastBackupAt ? fmtDateTime(backupData.policy.lastBackupAt) : 'never'}</p>
        <div class="row mb"><button class="sm" id="mkBackup">Back up now</button>
          <span class="muted small">Restore is an operator CLI action: <code>npm run backup:restore &lt;file&gt;</code></span></div>
        <div id="backupList">${backupsTable(backupData.backups)}</div></div>
      <div class="card"><h3>Recent error log</h3>
      ${recent.length ? `<table><thead><tr><th>When</th><th>Kind</th><th>Detail</th></tr></thead><tbody>
        ${recent.map(e => `<tr><td class="small">${fmtDateTime(e.created_at)}</td><td><span class="badge ${e.kind === 'ble_error' ? 'amber' : 'red'}">${esc(e.kind)}</span></td><td class="small">${esc(e.detail || '')}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">Nothing logged. Quiet is good.</p>'}</div>`;
    body.querySelector('#backupBtn').onclick = dl('/admin/backup.db', 'rowpoint-backup.db');
    body.querySelector('#mkBackup').onclick = async (ev) => {
      ev.target.disabled = true; ev.target.textContent = 'Backing up…';
      try {
        await api('/admin/backups', { method: 'POST' });
        const fresh = await api('/admin/backups');
        body.querySelector('#backupList').innerHTML = backupsTable(fresh.backups);
        toast('Encrypted backup created.', 'success');
      } catch (e) { toast(e.message, 'error'); }
      ev.target.disabled = false; ev.target.textContent = 'Back up now';
    };
    body.querySelectorAll('[data-verify]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api(`/admin/backups/${encodeURIComponent(b.dataset.verify)}/verify`, { method: 'POST' });
        toast(r.verify.ok ? 'Integrity verified ✓' : 'Integrity check FAILED', r.verify.ok ? 'success' : 'error');
      } catch (e) { toast(e.message, 'error'); }
      b.disabled = false;
    });
  }

  function backupsTable(backups) {
    if (!backups.length) return '<p class="muted small">No backups yet.</p>';
    const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
    return `<table><thead><tr><th>Created</th><th>Reason</th><th>Size</th><th>Users</th><th>Schema</th><th></th></tr></thead><tbody>
      ${backups.map(b => `<tr><td class="small">${fmtDateTime(b.createdAt)}</td><td class="small">${esc(b.reason || '')}</td>
        <td class="small">${kb(b.plaintextBytes)}</td><td>${b.users}</td><td>v${b.schemaVersion}</td>
        <td><button class="ghost sm" data-verify="${esc(b.file)}">Verify</button></td></tr>`).join('')}
    </tbody></table>`;
  }

  /* ================= SECURITY ================= */

  async function showSecurity() {
    const { events, summary } = await api('/admin/security/auth-events');
    const { entries } = await api('/admin/audit');
    body.innerHTML = `
      <div class="grid cols3">
        ${tile(summary.failedLogins24h, 'failed logins / 24h')}
        ${tile(summary.failedLogins7d, 'failed logins / 7d')}
        ${tile(summary.logins7d, 'successful logins / 7d')}
      </div>
      ${summary.repeatOffenders.length ? `<div class="card tight"><h3>Repeated failed logins (7d)</h3>
        <table><thead><tr><th>Email</th><th>Failures</th></tr></thead><tbody>
        ${summary.repeatOffenders.map(r => `<tr><td class="small">${esc(r.email || 'unknown')}</td><td>${r.n}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
      <div class="card"><h3>Authentication events</h3>
        <div class="row mb">
          <select id="aeKind"><option value="">All kinds</option>
          ${['login_success', 'login_fail', 'oauth_login', 'signup', 'verify', 'verify_fail', 'password_reset', 'role_change'].map(k => `<option>${k}</option>`).join('')}
          </select><button class="sm" id="aeQuery">Filter</button></div>
        <div id="aeOut">${authEventsTable(events)}</div></div>
      <div class="card"><h3>Admin action history</h3>
        <table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th></tr></thead><tbody>
        ${entries.slice(0, 60).map(a => `<tr><td class="small">${fmtDateTime(a.created_at)}</td><td class="small">${esc(a.admin_email || a.admin_user_id)}</td><td><code>${esc(a.action)}</code></td><td class="small">${esc(a.target || '')}</td></tr>`).join('')}
        </tbody></table></div>`;
    body.querySelector('#aeQuery').onclick = async () => {
      const kind = body.querySelector('#aeKind').value;
      const r = await api(`/admin/security/auth-events${kind ? `?kind=${kind}` : ''}`);
      body.querySelector('#aeOut').innerHTML = authEventsTable(r.events);
    };
  }

  function authEventsTable(events) {
    if (!events.length) return '<p class="muted small">No events.</p>';
    return `<table><thead><tr><th>When</th><th>Kind</th><th>Email</th><th>Detail</th></tr></thead><tbody>
      ${events.slice(0, 80).map(e => `<tr><td class="small">${fmtDateTime(e.created_at)}</td>
        <td><span class="badge ${e.kind.includes('fail') ? 'red' : 'gray'}">${esc(e.kind)}</span></td>
        <td class="small">${esc(e.email || '')}</td><td class="small">${esc(e.detail || '')}</td></tr>`).join('')}
    </tbody></table>`;
  }

  /* ================= MODERATION / BROADCAST / AUDIT ================= */

  async function showModeration() {
    const { reports } = await api('/admin/reports');
    body.innerHTML = `<div class="card"><h3>Open reports</h3>
      ${reports.length ? reports.map(r => `<div class="card tight">
        <strong>${esc(r.reason)}</strong> — reported by ${esc(r.reporter_name || 'deleted user')} against <strong>${esc(r.target_name || 'deleted user')}</strong> (${esc(r.target_email || '')})
        ${r.details ? `<p class="muted small">${esc(r.details)}</p>` : ''}
        <div class="row mt">
          <button class="sm danger" data-susp="${r.id}">Suspend target</button>
          <button class="sm secondary" data-note="${r.id}">Action w/ note</button>
          <button class="sm ghost" data-dis="${r.id}">Dismiss</button>
        </div></div>`).join('') : '<p class="muted">No open reports. 🎉</p>'}</div>`;
    const act = (id, action, note) => api(`/admin/reports/${id}/action`, { method: 'POST', body: { action, note } }).then(() => { toast('Done.'); showModeration(); });
    body.querySelectorAll('[data-susp]').forEach(b => b.onclick = async () => {
      const note = await promptDialog('Note for the audit log:', { title: 'Suspend target', confirmText: 'Suspend' });
      if (note !== null) act(b.dataset.susp, 'suspend_target', note);
    });
    body.querySelectorAll('[data-note]').forEach(b => b.onclick = async () => {
      const note = await promptDialog('Action note:', { title: 'Resolve with note', confirmText: 'Resolve' });
      if (note !== null) act(b.dataset.note, 'note', note);
    });
    body.querySelectorAll('[data-dis]').forEach(b => b.onclick = () => act(b.dataset.dis, 'dismiss', ''));
  }

  function showBroadcast() {
    body.innerHTML = `<div class="card"><h3>Broadcast an announcement</h3>
      <label class="field"><span>Audience</span>
        <select id="bAud">
          <option value="all">All users</option>
          <option value="coach">All coaches</option>
          <option value="rower">All rowers</option>
          <option value="research">Research opt-in users</option>
        </select></label>
      <label class="field"><span>Title</span><input id="bTitle" placeholder="Scheduled maintenance Sunday"></label>
      <label class="field"><span>Body</span><textarea id="bBody" rows="3"></textarea></label>
      <button id="bSend">Send</button>
      <p class="muted small">Delivered as in-app notifications, respecting each user's "announcements" preference.</p></div>`;
    body.querySelector('#bSend').onclick = async () => {
      const aud = body.querySelector('#bAud').value;
      const audience = aud === 'coach' ? { accountType: 'coach' } : aud === 'rower' ? { accountType: 'rower' } : aud === 'research' ? { researchOptIn: true } : {};
      const res = await api('/admin/broadcast', { method: 'POST', body: { title: body.querySelector('#bTitle').value, body: body.querySelector('#bBody').value, audience } });
      toast(`Sent to ${res.recipients} user${res.recipients === 1 ? '' : 's'}.`, 'success');
    };
  }

  async function showAudit() {
    const { entries } = await api('/admin/audit');
    body.innerHTML = `<div class="card"><h3>Admin audit log</h3>
      <p class="muted small">Every admin action is recorded — admin accounts have unusually broad access, so the log is non-optional.</p>
      <table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th></tr></thead><tbody>
      ${entries.map(a => `<tr><td class="small">${fmtDateTime(a.created_at)}</td><td class="small">${esc(a.admin_email || '')}</td><td><code>${esc(a.action)}</code></td><td class="small">${esc(a.target || '')}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function fmtPace(s) {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
  }

  show('overview');
}
